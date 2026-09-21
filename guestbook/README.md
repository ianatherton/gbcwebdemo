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

Posting is public — a tester needs no account and no password. **Reading is
not.** The board and its screenshots are bug reports, so every read wants
`Authorization: Bearer <ADMIN_TOKEN>` and returns `401` without it.

| | Auth | |
| --- | --- | --- |
| `POST /entries` | public | JSON body; returns `{"ok": true, "entry": {...}}` |
| `GET /entries` | token | newest 10; `{"entries": [...], "cursor", "done"}` |
| `GET /shot?k=<shotKey>` | token | that entry's screenshot, as `image/png` |
| `DELETE /entries?id=<id>` | token | removes it, and its screenshot |

`GET` takes `limit` (1–50, default 10), `cursor` (from the previous response,
to continue), `kind` and `rom` (to filter), and `t` (any value, to bypass the
30-second board cache). `done` is `true` once there is nothing left; `cursor`
is `null` there too. Every response carries
`quota: {used, cap, left}` for the day.

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

## The daily budget

KV's free tier has four separate daily allowances, and three of them matter
here:

| | Free/day | What spends it |
| --- | --- | --- |
| Writes | 1,000 | 4 per post: daily counter, per-IP counter, report, image |
| List requests | 1,000 | one per board load, one per 25 posts (trim) |
| Reads | 100,000 | 11 per board load |

**Writes set the report cap.** Four per post means 250 is the arithmetic
ceiling, so `DAILY_POST_CAP` is **240**, leaving headroom. The Worker enforces
it, and the page shows `n of 240 reports used today` so nobody has to guess.
Raise it past 250 and posts start failing late in a busy day — gracefully, but
failing.

**List requests used to set the traffic ceiling**, and they were the one number
no cap in the code could bound: one per board load, against 1,000 a day. Now
that reading needs the token, only the maintainer loads the board, so this
scales with how often *you* look rather than with how many people visit. On top
of that the board is held in the edge cache for 30 seconds, trimming runs every
25th post rather than every post, and a new post is spliced in from the `POST`
response rather than re-reading the board.

Per-IP limits stop one person spending the lot: 10 posts an hour and 20 a day.

When the budget does run out the Worker degrades in a deliberate order rather
than failing:

1. **The report is written before the screenshot**, so if only one write is left
   the bug report is what survives. The response comes back `shotDropped: true`
   and the page says the picture didn't fit.
2. **With nothing left**, the post is refused with `503` and
   `{"full": true}` rather than a bare `500`, and the page tells the tester the
   guestbook is full for today.
3. **Nothing is lost either way.** Every entry is written to the tester's
   `localStorage` before it is posted, and unsent ones are retried on the next
   page load — so a report written during a full day goes up the next day
   without anyone re-typing it.

A screenshot whose write failed leaves its entry pointing at an image that
isn't there. The page drops an image that won't load, so it just shows as a
report with no picture.

## What's guarded, and what isn't

Anyone who finds the URL can post — that's the deal with an anonymous guestbook,
and it's what the 90s ones did too. The limits that do exist:

- **10 posts per hour and 20 per day per IP**, both tracked in one counter key
  per IP so the pair costs a single KV write.
- **240 reports per day site-wide**, so the free tier can't be exhausted by
  volume alone.
- **A honeypot field.** The form ships one that's hidden and empty; anything
  that fills it in gets a cheerful `200` and is dropped.
- **Plain text only.** Control characters are stripped, lengths are capped, and
  the page renders every field with `textContent`, so a post can't inject markup.
- **Entries are immutable.** Nothing a visitor can send edits or deletes someone
  else's post. Removing one needs the `ADMIN_TOKEN` secret, which lives in
  Cloudflare and never touches the page.
- **200 entries**, oldest trimmed past that.

## Who can see what

A tester posts and sees **their own** reports, listed from their browser's
`localStorage` — so they can still check what they filed, and **Copy all** and
**Download** work as before. They cannot read the board, anyone else's reports,
or anyone else's screenshots: those routes return `401`.

On the page, **Maintainer view** takes the `ADMIN_TOKEN` and switches to the
whole board, with the filters and **Load more**. You type it once: the browser
remembers it in `localStorage` until you hit **Leave maintainer view**.

For one-click access, bookmark the site with the token in the URL fragment:

```
https://yourdomain.com/#maintainer=<ADMIN_TOKEN>
```

The page picks it up, stores it, and strips the fragment from the address bar
on arrival. A fragment is never sent to the server, so the token stays out of
request logs and out of anything downstream — it lives in your bookmark and
your browser, nowhere else.

There is deliberately no password in `assets/player.js`. Every visitor
downloads that file, so a secret written there is a published secret, whatever
it is wrapped in. The token has to come from the person, not the page.

The token is compared in constant time, so response timing can't be used to
guess it a character at a time. Make it a real secret —
`openssl rand -hex 32` — since it is the only thing between a URL and the
reports. With `ADMIN_TOKEN` unset, every read is refused and posting still
works, which is the safe way round.

Screenshots are fetched with the token and handed to the page as blob URLs,
because an `<img>` tag cannot send an `Authorization` header.

Keeping reads private has a second benefit: **list requests**, the one quota
that scales with traffic rather than with a cap, now scale with *your* visits
instead of everyone's. See the next section.

## Screenshots

A Game Boy frame is 160x144 with a small palette, so a PNG of one is about
1-4 KB — small enough to keep. The page attaches one to every report
automatically. `POST` takes a `shot` field (base64 PNG, with or without a
`data:` prefix) and stores it under its own key, so it never bloats the
`/entries` response; the entry just carries a `shotKey`, and
the page points an `<img>` at `/shot?k=...`.

Screenshots never change once posted, so they are served `immutable` with a
one-year max-age and held in the edge cache. Only the very first viewer costs a
KV read; everyone after that is served from cache.

What's accepted is narrow on purpose: a real PNG (magic bytes checked), at most
64 KB, and no larger than 320x288 — twice the handheld's screen. A JPEG, a
photo, or anything that isn't plausibly a Game Boy screen is refused. The budget
is the per-IP post limit itself — every report carries a screenshot, so the two
are the same budget.

Deleting an entry deletes its screenshot, and so does trimming past 200
entries — they share a key suffix, so neither needs a lookup.

If it does get spammed, `npx wrangler kv key list --binding GUESTBOOK` and
`npx wrangler kv key delete` will clear it out, or just delete the namespace and
make a new one.

## Note on what's public

The Worker serves the repo root as static assets, so `worker.js`,
`wrangler.toml` and this file are readable at `https://yourdomain.com/guestbook/`
— exactly as they already were on GitHub Pages. Nothing in them is a credential:
`ADMIN_TOKEN` is a Cloudflare secret, and a KV namespace id is useless without
account access.
