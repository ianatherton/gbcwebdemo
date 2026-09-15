/**
 * Bug guestbook backend — the one piece GitHub Pages can't host.
 *
 * This is the 2020s version of a 90s `guestbook.cgi`: it takes plain text over
 * HTTP and appends it to a store everyone can read back. The store is Workers
 * KV, one key per entry rather than one big file, so two testers posting at the
 * same moment can't clobber each other's write.
 *
 *   GET    /entries          newest entries first, a page at a time
 *   POST   /entries          add one (JSON body)
 *   DELETE /entries?id=...   moderation; needs the ADMIN_TOKEN secret
 *
 * Deploying and configuring it: see README.md next to this file.
 */

const MAX_ENTRIES = 200;    // Older entries are trimmed away past this.
const DEFAULT_LIMIT = 10;   // A page load only ever needs the newest few.
const MAX_LIMIT = 50;
const SCAN_PAGE = 100;      // Keys pulled per KV list call while filtering.
const MAX_SCANS = 5;        // Ceiling on the work one filtered request can do.
const MAX_TEXT = 2000;      // Matches the textarea's maxlength on the page.
const MAX_FIELD = 80;
const POSTS_PER_HOUR = 10;  // Per IP.

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin') || '', env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: cors});
    }

    const url = new URL(request.url);
    if (url.pathname !== '/entries') return json({error: 'not found'}, 404, cors);

    if (request.method === 'GET') return listEntries(url, env, cors);
    if (request.method === 'POST') return addEntry(request, env, cors);
    if (request.method === 'DELETE') return deleteEntry(url, request, env, cors);
    return json({error: 'method not allowed'}, 405, cors);
  },
};

// A browser only hands the response to the page when the origin matches, so
// this keeps another site from posting through a visitor's browser. It is not
// a wall against curl — the rate limit and the moderation token are.
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// KV lists keys in lexicographic order, so count the timestamp down. Newest
// sorts first and `limit` becomes the paging, with no sort needed on read.
function entryKey(at) {
  return 'e:' + String(1e15 - at).padStart(16, '0') + ':' +
      Math.random().toString(36).slice(2, 8);
}

// Reading the whole board on every page load is what makes a busy guestbook
// expensive: one KV read per entry, per visitor. So hand back a page at a time.
// `cursor` from the previous response continues where it left off.
//
//   /entries                     newest DEFAULT_LIMIT
//   /entries?limit=20&cursor=... the next 20
//   /entries?kind=Audio          only that kind
//   /entries?rom=mygame.gbc      only reports against that ROM
//
// Filtering has to read entries to test them, so it walks whole KV pages and
// stops on a page boundary — that keeps the cursor aligned, so nothing is
// skipped — and never scans more than MAX_SCANS pages in one request.
async function listEntries(url, env, cors) {
  const params = url.searchParams;
  const limit = clampLimit(params.get('limit'));
  const kind = clean(params.get('kind'), MAX_FIELD);
  const rom = clean(params.get('rom'), MAX_FIELD);
  const filtered = !!(kind || rom);

  let cursor = params.get('cursor') || undefined;
  const entries = [];
  let done = false;

  for (let scan = 0; scan < MAX_SCANS; scan++) {
    const page = await env.GUESTBOOK.list(
        {prefix: 'e:', limit: filtered ? SCAN_PAGE : limit, cursor});
    const loaded = await Promise.all(
        page.keys.map(key => env.GUESTBOOK.get(key.name, {type: 'json'})));
    for (const entry of loaded) {
      if (!entry) continue;
      if (kind && entry.kind !== kind) continue;
      if (rom && entry.rom !== rom) continue;
      entries.push(entry);
    }
    cursor = page.list_complete ? null : page.cursor;
    if (!cursor) {
      done = true;
      break;
    }
    if (entries.length >= limit) break;
  }

  return json({entries, cursor: cursor || null, done}, 200, cors);
}

function clampLimit(value) {
  const limit = parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

async function addEntry(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({error: 'expected a JSON body'}, 400, cors);
  }

  // Honeypot: the page leaves this field empty and hidden, bots fill it in.
  if (clean(body.website, MAX_FIELD)) return json({ok: true}, 200, cors);

  const text = clean(body.text, MAX_TEXT);
  if (!text) return json({error: 'the report is empty'}, 400, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env, ip)) {
    return json({error: 'too many posts from here in the last hour'}, 429, cors);
  }

  // The server clock decides the order; a tester's clock may be anything.
  const at = Date.now();
  const entry = {
    id: clean(body.id, MAX_FIELD) || crypto.randomUUID(),
    at,
    who: clean(body.who, 40) || 'anonymous',
    kind: clean(body.kind, 24) || 'Bug',
    text,
    rom: clean(body.rom, MAX_FIELD),
    title: clean(body.title, MAX_FIELD),
    build: clean(body.build, MAX_FIELD),
    built: Number.isFinite(body.built) ? body.built : null,
    rev: Number.isFinite(body.rev) ? body.rev : null,
    site: clean(body.site, 16),
    ua: clean(body.ua, 200),
  };

  await env.GUESTBOOK.put(entryKey(at), JSON.stringify(entry));
  await trimOldEntries(env);
  return json({ok: true, entry}, 201, cors);
}

async function trimOldEntries(env) {
  const list = await env.GUESTBOOK.list({prefix: 'e:'});
  await Promise.all(
      list.keys.slice(MAX_ENTRIES).map(key => env.GUESTBOOK.delete(key.name)));
}

async function isRateLimited(env, ip) {
  const key = 'rl:' + ip + ':' + Math.floor(Date.now() / 3600000);
  const count = Number(await env.GUESTBOOK.get(key)) || 0;
  if (count >= POSTS_PER_HOUR) return true;
  await env.GUESTBOOK.put(key, String(count + 1), {expirationTtl: 3600});
  return false;
}

async function deleteEntry(url, request, env, cors) {
  const token =
      (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({error: 'not authorized'}, 401, cors);
  }
  const id = url.searchParams.get('id');
  if (!id) return json({error: 'need ?id=<entry id>'}, 400, cors);

  const list = await env.GUESTBOOK.list({prefix: 'e:'});
  for (const key of list.keys) {
    const entry = await env.GUESTBOOK.get(key.name, {type: 'json'});
    if (entry && entry.id === id) {
      await env.GUESTBOOK.delete(key.name);
      return json({ok: true}, 200, cors);
    }
  }
  return json({error: 'no entry with that id'}, 404, cors);
}

// Plain text only: strip control characters (keeping tabs and newlines) and cap
// the length. The page renders every field with textContent, so nothing here is
// ever interpreted as HTML.
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, max);
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
        {'Content-Type': 'application/json; charset=utf-8'}, cors),
  });
}
