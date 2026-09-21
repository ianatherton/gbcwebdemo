# GBC Web Player

A static Game Boy / Game Boy Color player for testing your own ROMs in the
browser. No build step, no dependencies, no server code — just files you can
drop on GitHub Pages.

The whole site is ~150 KB (88 KB of that is the emulator's WebAssembly),
so a 1 MB ROM is by far the biggest thing a visitor downloads.

## Adding your ROM

Copy your build into `roms/`. There is no second step — the player lists
whatever `.gb`/`.gbc`/`.bin` files it finds there, under their own filenames,
so a build doesn't have to be named anything in particular.

Static hosting has no "list this directory" call, so discovery uses the two
listings that do exist: the server's HTML autoindex when you run it locally
(`python3 -m http.server`), and the GitHub contents API when the site is on
GitHub Pages. The latter needs a public repo served from the branch the API
returns — `main`, with the default *Deploy from a branch* setup. If neither is
available, `roms/roms.json` and drag & drop still work.

The first ROM loads automatically. With more than one, a dropdown appears. To
link a tester straight at a specific build:
`https://<you>.github.io/<repo>/?rom=roms/mygame.gbc`

`roms/roms.json` is now optional, and only supplies nicer names and a preferred
order:

```json
[
  { "name": "My Game (dev build)", "file": "roms/mygame.gbc" }
]
```

Listed entries sort first, everything else follows alphabetically. An entry
pointing at a file that has since been renamed is dropped rather than left to
404.

Testers can also drag any `.gb`/`.gbc` file onto the page (or use **Open ROM…**)
without it ever being uploaded — the file is read locally in their browser.
That's the easy path for handing someone a build over Discord.

## Bug guestbook

Below the screen is a bug guestbook: a tester types what went wrong, and the
page files it with the things that are annoying to reconstruct afterwards —
when it happened, which ROM was loaded, a short content hash of that ROM, the
ROM's build date (its `Last-Modified`, or the file's mtime for a dropped
build), the cartridge header's revision byte, the site's `?v=` tag, the
browser, and optionally a PNG of the screen at that moment.

That hash is the point of it: "build `3f9a1c22`, built Sep 04 06:05" identifies
a build exactly, where "the latest one" does not.

Every entry is written to the tester's own `localStorage` first, so nothing is
lost to a failed request. What happens next depends on one setting.

### Local, out of the box

Leave `GUESTBOOK_ENDPOINT` empty in `assets/player.js` and the log stays in each
tester's browser (newest 50). **Copy all** puts it on the clipboard as Markdown,
**Download** saves it as JSON with the screenshots — that's how a report gets
back to you. If storage fills up (save states share it), the oldest screenshots
are dropped before any entry is.

### Shared, with the Worker

A 90s guestbook was a `guestbook.cgi` appending to a text file — it needed a
server, and GitHub Pages deliberately isn't one. `guestbook/` holds the smallest
thing that closes that gap: a Cloudflare Worker storing plain text in Workers
KV, one key per entry. Deploy it (see `guestbook/README.md`), put the URL in
`assets/player.js`:

```js
const GUESTBOOK_ENDPOINT = 'https://gbc-guestbook.<you>.workers.dev';
```

and testers can file reports with no account and no login — they type and hit
**Log it**. The site stays as static as it was; only the guestbook leaves it.

Posting is public; **reading is not**. A tester sees their own reports, listed
from their own browser. The board itself, and every screenshot on it, needs the
`ADMIN_TOKEN` — there's a **Maintainer view** button that takes it once and the
browser remembers it, or bookmark `https://yourdomain.com/#maintainer=<token>`
for one-click access (the fragment is stripped from the URL on arrival and is
never sent to the server). That keeps bug reports between the tester and
you, and it means the one quota that scales with traffic scales with your visits
instead of everyone's.

Screenshots go up too. A 160x144 frame with a Game Boy's palette is a 1-4 KB
PNG, so they are stored beside the entry and served `immutable` from the edge
cache — only the first viewer of each costs a read. Uploads are capped at 20 per
IP per day and must actually look like a Game Boy screen: a real PNG, under
64 KB, no larger than 320x288.

The board loads ten at a time, with **Load more** and server-side filters by
kind and by ROM — reading every entry on every visit is what makes a KV-backed
guestbook expensive, and it would have grown with the board.

Posts are immutable — nothing a visitor can send edits or deletes someone else's
entry, and **Clear all** only ever wipes that browser's own copy. Removing a
post needs the `ADMIN_TOKEN` secret, which lives in Cloudflare. Writes are rate
limited to 10/hour per IP, with a honeypot field for bots and a 200-entry cap.

If the Worker is unreachable the entry is kept locally, marked *not posted yet*,
and pushed on the next page load.

## Hosting on Cloudflare instead

GitHub Pages can't run the guestbook, so if you want the shared board on your
own domain, one Cloudflare Worker can serve both. `wrangler.toml` in this
directory points `[assets]` at the repo root: static files are handed straight
out, and only `/entries` reaches `guestbook/worker.js`. Same origin, one
deployment, no CORS.

Connect the repo in the Cloudflare dashboard and every push rebuilds and
redeploys — `guestbook/README.md` has the click-by-click. Set the **build
command** to `node tools/gen-roms.mjs`, which regenerates `roms/roms.json` from
whatever is in `roms/`. That matters off GitHub Pages: neither of the player's
two discovery routes (a local server's directory listing, the GitHub contents
API on `github.io`) exists on a custom domain, so the manifest has to be real by
the time the files are uploaded. Run it by hand any time as well:

```sh
node tools/gen-roms.mjs
```

Nothing stops you keeping GitHub Pages running alongside as a mirror; the page
behaves the same on both.

## Publishing to GitHub Pages

Push to GitHub, then **Settings → Pages → Source: Deploy from a branch**, branch
`main`, folder `/ (root)`. The site is live at
`https://<you>.github.io/<repo>/` within a minute or so.

The repo must be public for Pages on a free account. Note that ROMs in the repo
are public too — anything in `roms/` is downloadable by anyone with the URL.

## Running it locally

`file://` won't work (the emulator loads a `.wasm` module over HTTP), so serve
the directory:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Caching

GitHub Pages serves everything with `max-age=600`, so a returning visitor can
hold a ten-minute-old copy of the site in their browser cache. Nothing on the
page can clear that — `caches.delete()` only touches the Cache Storage API,
which this site doesn't use, and there is no way to reach the browser's HTTP
cache from JavaScript. What the page can do is make its requests unable to
serve stale bytes:

- **ROMs, the `roms/` listing, and `roms.json`** are fetched with
  `cache: 'no-cache'`, which
  revalidates against the server every time. Push a new build, tell a tester to
  reload, and they get it — no waiting, no bookkeeping. Unlike `no-store` this
  still allows a `304 Not Modified`, so an unchanged ROM isn't re-downloaded.
- **Site assets** carry a `?v=` tag. Bump it in `index.html` when you deploy
  and browsers treat them as new URLs, so the CSS and JS update immediately
  instead of after ten minutes:

  ```sh
  sed -i 's/?v=1/?v=2/g' index.html
  ```

  `player.js` reads the tag off its own `<script>` URL and passes it to
  `binjgb.wasm`, so the core can never be a different build from the code
  loading it.

`index.html` itself is the one file that can still be up to ten minutes stale,
since it's what carries the version tags. Its markup rarely changes, and the
window is bounded — GitHub purges its CDN on every deploy, so the staleness is
only ever browser-side.

A service worker could close that last gap, but they are a far more common
*cause* of permanently stale sites than a cure, and one isn't worth it here.

## Controls

| Action | Key |
| --- | --- |
| D-pad | Arrow keys |
| A / B | X / Z |
| Start / Select | Enter / Right Shift |
| Fast forward | Left Shift (hold) |
| Rewind | Backspace (hold) |
| Pause | Space |
| Save / load state | F6 / F9 |
| DMG palette | `[` and `]` |

Touch devices get an on-screen gamepad, which lays out around the screen in
landscape. Battery saves and save states go to the browser's `localStorage`,
keyed per ROM, and are never uploaded.

## Color

binjgb can apply a CGB color curve, which imitates how washed-out a real Game
Boy Color screen looks. `simple.js` ships with the Gambatte curve; this player
uses no curve, so colors come through as the game authored them. To go back to
a hardware look, set `CGB_COLOR_CURVE` at the top of `assets/player.js` to `1`
(SameBoy) or `2` (Gambatte).

## Layout

```
index.html            the player page
assets/player.js      binjgb's simple.js, adapted (see below)
assets/style.css      page styling
assets/controller.css on-screen gamepad styling (from GB Studio)
vendor/binjgb.js      emulator glue, unmodified
vendor/binjgb.wasm    emulator core, unmodified
roms/                 your ROMs (+ an optional roms.json for names)
guestbook/            optional Cloudflare Worker behind the shared guestbook
tools/gen-roms.mjs    rebuilds roms/roms.json from the directory
wrangler.toml         Cloudflare config, when hosting there instead of Pages
```

`assets/player.js` is [binjgb](https://github.com/binji/binjgb)'s
`docs/simple.js` with these changes:

- the ROM is chosen at runtime (`?rom=`, whatever is in `roms/`, file picker,
  or drag & drop) instead of being hardcoded;
- a bug guestbook below the screen stamps reports with the build they came from;
- save data and save states are keyed per ROM in `localStorage`;
- files that are obviously not cartridges are rejected, and a bad header
  (Nintendo logo / checksum) is reported instead of silently booting noise;
- keystrokes aimed at the toolbar don't leak into the emulator;
- pause is enabled;
- the CGB color curve defaults to none rather than Gambatte's;
- the on-screen d-pad has diagonal pads (eight sectors, not four);
- queued audio is capped, so playback can't drift seconds behind;
- two crash fixes, both of which only bite once you create a second emulator
  (upstream `simple.js` only ever creates one, so it never hits them):
  - `destroy()` freed the ROM buffer that `emulator_new_simple` had already
    taken ownership of. The double free corrupted the allocator, and the next
    large allocation trapped with `memory access out of bounds` — which meant
    loading a save state after a reset crashed the core.
  - restoring a save state jumps the tick count, but `rewind_append` requires
    ticks to keep increasing, so the rewind buffer is now rebuilt after a
    restore instead of appending across the gap.

To update the emulator, re-copy `binjgb.js` and `binjgb.wasm` from
[binjgb's `docs/`](https://github.com/binji/binjgb/tree/main/docs) and re-apply
those changes to a fresh `simple.js` if it has moved on.

## Licenses

- Emulator: [binjgb](https://github.com/binji/binjgb) by Ben Smith — MIT
  (`licenses/LICENSE.binjgb`)
- On-screen gamepad: [GB Studio](https://github.com/chrismaltby/gb-studio) by
  Chris Maltby — MIT (`licenses/LICENSE.gb-studio`)

Both licenses are permissive; keep the license files in place when you deploy.
