# Bug guestbook backend

A ~150-line Cloudflare Worker that does the one thing GitHub Pages won't: accept
a write.

Entries live in Workers KV, one key per entry. That costs an extra read per page
load compared to keeping one big JSON blob, and buys the thing a flat file never
had: two people posting at the same instant can't overwrite each other.

`worker.js` is only the guestbook. The Worker it deploys into also serves the
whole site — `wrangler.toml` in the repo root points `[assets]` at that root, so
static files are handed out directly and only `/entries` reaches this code. Page
and guestbook therefore share an origin, and no CORS is involved.

## Setting it up (dashboard + git, no CLI)

1. **Add your domain to Cloudflare** if it isn't already: dashboard → *Add a
   domain*, then repoint the nameservers at your registrar. Wait for it to go
   *Active*.
2. **Make the KV namespace:** *Storage & Databases → KV → Create namespace*,
   name it `GUESTBOOK`. Copy the id it shows.
3. **Paste that id** into `wrangler.toml` in the repo root, replacing
   `PASTE_YOUR_KV_NAMESPACE_ID_HERE`, and push.
4. **Create the Worker from the repo:** *Compute (Workers) → Create → Import a
   repository*, pick this repo. Set **Build command** to
   `node tools/gen-roms.mjs` and leave the deploy command at
   `npx wrangler deploy`. The Worker's name must match `name` in
   `wrangler.toml` (`gbcwebdemo`) or the build fails.
5. **Set the moderation password:** the Worker's *Settings → Variables and
   Secrets → Add → Secret*, named `ADMIN_TOKEN`. Any long random string;
   `openssl rand -hex 32` makes a good one. Secrets survive later deploys.
6. **Attach the domain:** *Settings → Domains & Routes → Add → Custom domain*.
7. **Point the page at itself:** set `GUESTBOOK_ENDPOINT` in `assets/player.js`
   to `https://yourdomain.com` (no trailing slash), bump `?v=` in `index.html`,
   and push.

Every push now rebuilds and redeploys. Leave `GUESTBOOK_ENDPOINT` empty and the
guestbook simply stays local to each tester's browser.

### Or from the command line

```sh
npx wrangler login
npx wrangler kv namespace create GUESTBOOK   # paste the id into wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Run these from the repo root, where `wrangler.toml` lives. `npx` fetches
wrangler on demand; it needs Node 20 or newer.

## API

| | |
| --- | --- |
| `GET /entries` | newest 10; `{"entries": [...], "cursor": ..., "done": false}` |
| `POST /entries` | JSON body; returns `{"ok": true, "entry": {...}}` |
| `DELETE /entries?id=<id>` | needs `Authorization: Bearer <ADMIN_TOKEN>` |

`GET` takes `limit` (1–50, default 10), `cursor` (from the previous response,
to continue), `kind` and `rom` (to filter). `done` is `true` once there is
nothing left; `cursor` is `null` there too.

```sh
curl https://yourdomain.com/entries
curl "https://yourdomain.com/entries?kind=Audio&limit=20"
curl "https://yourdomain.com/entries?cursor=<cursor from last response>"

curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://yourdomain.com/entries?id=<entry id>"
```

### Why it pages

Reading the whole board on every page load is the expensive part of a guestbook
on KV — it costs one read per entry, per visitor, so the bill grows with the
product of board size and traffic. A 200-entry board at 201 reads a load runs
out of the free tier's 100,000 daily reads after about 500 visits.

Ten at a time makes that 11 reads a load, or roughly 9,000 visits a day, and it
stops mattering how big the board gets. **Load more** walks the cursor; the kind
and ROM filters are applied server-side so they search the whole board, not just
what is on screen.

Filtering does have to read entries to test them, so it walks KV a page at a
time and stops on a page boundary — the cursor stays aligned, nothing is
skipped — and never scans more than 5 pages per request. That cost lands only
when someone actually clicks a filter, not on every visit.

## What's guarded, and what isn't

Anyone who finds the URL can post — that's the deal with an anonymous guestbook,
and it's what the 90s ones did too. The limits that do exist:

- **10 posts per hour per IP**, counted in KV.
- **A honeypot field.** The form ships one that's hidden and empty; anything
  that fills it in gets a cheerful `200` and is dropped.
- **Plain text only.** Control characters are stripped, lengths are capped, and
  the page renders every field with `textContent`, so a post can't inject markup.
- **Entries are immutable.** Nothing a visitor can send edits or deletes someone
  else's post. Removing one needs the `ADMIN_TOKEN` secret, which lives in
  Cloudflare and never touches the page.
- **200 entries**, oldest trimmed past that.

Screenshots are deliberately *not* uploaded. They stay in the tester's browser
and ride along in **Download**. The shared board is text, which keeps the Worker
inside the free tier and the board readable.

If it does get spammed, `npx wrangler kv key list --binding GUESTBOOK` and
`npx wrangler kv key delete` will clear it out, or just delete the namespace and
make a new one.

## Note on what's public

The Worker serves the repo root as static assets, so `worker.js`,
`wrangler.toml` and this file are readable at `https://yourdomain.com/guestbook/`
— exactly as they already were on GitHub Pages. Nothing in them is a credential:
`ADMIN_TOKEN` is a Cloudflare secret, and a KV namespace id is useless without
account access.
