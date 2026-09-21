/**
 * Bug guestbook backend — the one piece GitHub Pages can't host.
 *
 * This is the 2020s version of a 90s `guestbook.cgi`: it takes plain text over
 * HTTP and appends it to a store everyone can read back. The store is Workers
 * KV, one key per entry rather than one big file, so two testers posting at the
 * same moment can't clobber each other's write.
 *
 *   GET    /entries          newest entries first, a page at a time
 *   POST   /entries          add one (JSON body, optional PNG screenshot)
 *   GET    /shot?k=...       one screenshot, immutable and edge-cached
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
const POSTS_PER_DAY = 20;   // Per IP.
// Every report carries a screenshot now, so each post costs 4 KV writes: the
// daily counter, the per-IP counter, the report, and the image. KV's free tier
// allows 1,000 writes a day, so 250 posts is the hard ceiling — this leaves
// headroom. Raising it past 250 means posts start failing late in the day
// (gracefully: see "Running out of writes" in README.md).
const DAILY_POST_CAP = 240;
const TRIM_EVERY = 25;      // Trimming costs a list request; don't do it hourly.
const BOARD_CACHE_SECONDS = 30;
const MAX_SHOT_BYTES = 64 * 1024;  // ~15x a typical frame; anything bigger
                                   // isn't a 160x144 screen.
const MAX_SHOT_WIDTH = 320;        // 2x the Game Boy screen, for safety.
const MAX_SHOT_HEIGHT = 288;
const SAFE_SUFFIX = /^\d{16}:[a-z0-9]{1,8}$/;
const FULL_MESSAGE =
    'the guestbook is full for today and can\'t take new posts until ' +
    'tomorrow — yours is safe in this browser and will go up then';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin') || '', env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: cors});
    }

    const url = new URL(request.url);
    if (url.pathname === '/shot' && request.method === 'GET') {
      return getShot(url, env, cors);
    }
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
//
// An entry and its screenshot share this suffix — 'e:<suffix>' and
// 's:<suffix>' — so trimming can drop both without reading anything, and the
// page can ask for a screenshot by suffix without a lookup.
function entrySuffix(at) {
  return String(1e15 - at).padStart(16, '0') + ':' +
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
  const cache = caches.default;
  const cacheKey = boardCacheKey(url);
  if (!url.searchParams.has('t')) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const response = await buildBoard(url, env, cors);
  await cache.put(cacheKey, response.clone());
  return response;
}

async function buildBoard(url, env, cors) {
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

  return json(
      {entries, cursor: cursor || null, done, quota: await readQuota(env)}, 200,
      Object.assign({'Cache-Control': 'max-age=' + BOARD_CACHE_SECONDS}, cors));
}

// A list request per page load would cap the whole site at KV's 1,000 daily
// lists. Holding the board at the edge for half a minute means a burst of
// visitors costs one list between them.
function boardCacheKey(url) {
  const key = new URL(url.toString());
  key.searchParams.delete('t');  // the poster's cache-buster, not a filter
  return new Request(key.toString());
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

  // A screenshot is optional and has its own daily budget — it costs a KV
  // write and some storage, where the text costs almost nothing.
  let shot = null;
  if (body.shot) {
    shot = decodeShot(body.shot);
    if (!shot) {
      return json({error: 'that screenshot is not a small PNG'}, 400, cors);
    }
  }

  // The whole site's budget for the day, ahead of the per-IP ones: nobody
  // should be told "you posted too much" when it is everyone together.
  const day = dayBucket();
  const quota = await readQuota(env);
  if (quota.used >= DAILY_POST_CAP) {
    return json(
        {
          error: 'the guestbook has taken its ' + DAILY_POST_CAP +
              ' reports for today — yours is safe in this browser and will ' +
              'go up after the daily reset (00:00 UTC)',
          full: true,
          quota,
        },
        503, cors);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const refused = await checkLimits(env, ip);
  if (refused) {
    return json(
        {error: refused.error, full: !!refused.full, quota}, refused.status, cors);
  }

  // The server clock decides the order; a tester's clock may be anything.
  const at = Date.now();
  const suffix = entrySuffix(at);
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
    shotKey: shot ? suffix : null,
  };

  // KV's daily write budget runs out before anything else here, so commit the
  // report first and the picture second: a bug report without a screenshot is
  // still a bug report, and a post that fails outright is nothing at all.
  try {
    await env.GUESTBOOK.put('e:' + suffix, JSON.stringify(entry));
  } catch (e) {
    return json({error: FULL_MESSAGE, full: true, quota}, 503, cors);
  }

  // Counted only once the report is safely stored, so a failed post doesn't
  // spend the day's allowance.
  const used = quota.used + 1;
  try {
    await env.GUESTBOOK.put('q:' + day, String(used), {expirationTtl: 172800});
  } catch (e) {
    // The cap is a safety rail, not an accounting system; losing one tick is
    // better than rejecting a report that is already written.
  }

  // If this fails the entry keeps a shotKey that resolves to nothing. The page
  // drops an image that won't load, so it shows as a report with no picture.
  let shotDropped = false;
  if (shot) {
    try {
      await env.GUESTBOOK.put('s:' + suffix, shot);
    } catch (e) {
      shotDropped = true;
    }
  }

  // Trimming costs a list request, and those are capped at 1,000 a day too.
  // Every 25th post keeps the board near 200 without spending the budget.
  if (used % TRIM_EVERY === 0) {
    try {
      await trimOldEntries(env);
    } catch (e) {
      // Trimming can wait; the entry is already saved.
    }
  }
  return json(
      {
        ok: true,
        entry,
        shotDropped,
        quota: {used, cap: DAILY_POST_CAP, left: Math.max(DAILY_POST_CAP - used, 0)},
      },
      201, cors);
}

// Only accepts what a Game Boy screen can actually produce: a real PNG, small,
// and no bigger than twice the handheld's 160x144.
function decodeShot(value) {
  if (typeof value !== 'string') return null;
  const base64 = value.replace(/^data:image\/png;base64,/, '');
  if (base64.length > MAX_SHOT_BYTES * 2) return null;
  let bytes;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (e) {
    return null;
  }
  if (bytes.length < 24 || bytes.length > MAX_SHOT_BYTES) return null;

  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;

  // IHDR is always the first chunk: length(4) type(4) width(4) height(4).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  if (width > MAX_SHOT_WIDTH || height > MAX_SHOT_HEIGHT) return null;
  return bytes;
}

// Screenshots never change once posted, so they can be cached hard. The Cache
// API check means a second viewer costs no KV read at all.
async function getShot(url, env, cors) {
  const key = url.searchParams.get('k') || '';
  if (!SAFE_SUFFIX.test(key)) return json({error: 'bad screenshot id'}, 400, cors);

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const bytes = await env.GUESTBOOK.get('s:' + key, {type: 'arrayBuffer'});
  if (!bytes) return json({error: 'no screenshot there'}, 404, cors);

  const response = new Response(bytes, {
    headers: Object.assign({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    }, cors),
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

async function trimOldEntries(env) {
  const list = await env.GUESTBOOK.list({prefix: 'e:'});
  const stale = list.keys.slice(MAX_ENTRIES);
  await Promise.all(stale.flatMap(key => [
    env.GUESTBOOK.delete(key.name),
    env.GUESTBOOK.delete('s:' + key.name.slice(2)),
  ]));
}

// Both budgets live in one key per IP — the hourly post count and the daily
// screenshot count — so checking them costs a single read and a single write
// rather than two of each. Writes are the scarce resource here, not reads.
// Returns an error message, or null when the post is allowed.
function dayBucket() {
  return Math.floor(Date.now() / 86400000);
}

async function readQuota(env) {
  let used = 0;
  try {
    used = Number(await env.GUESTBOOK.get('q:' + dayBucket())) || 0;
  } catch (e) {
    used = 0;
  }
  return {used, cap: DAILY_POST_CAP, left: Math.max(DAILY_POST_CAP - used, 0)};
}

async function checkLimits(env, ip) {
  const key = 'rl:' + ip;
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);

  let state = {};
  try {
    state = (await env.GUESTBOOK.get(key, {type: 'json'})) || {};
  } catch (e) {
    state = {};  // Unreadable counter shouldn't lock anyone out.
  }
  const hourly = state.hour === hour ? (state.hourly || 0) : 0;
  const posts = state.day === day ? (state.posts || 0) : 0;

  if (hourly >= POSTS_PER_HOUR) {
    return {error: 'too many posts from here in the last hour', status: 429};
  }
  if (posts >= POSTS_PER_DAY) {
    return {error: 'too many posts from here today', status: 429};
  }

  // This is the first write of the request, so it is also where an exhausted
  // daily budget shows up. Say so plainly instead of throwing a bare 500.
  try {
    await env.GUESTBOOK.put(
        key,
        JSON.stringify({hour, hourly: hourly + 1, day, posts: posts + 1}),
        {expirationTtl: 86400});
  } catch (e) {
    return {error: FULL_MESSAGE, status: 503, full: true};
  }
  return null;
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
      await env.GUESTBOOK.delete('s:' + key.name.slice(2));
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
