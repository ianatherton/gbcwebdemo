# GBC Web Player

A static Game Boy / Game Boy Color player for testing your own ROMs in the
browser. No build step, no dependencies, no server code — just files you can
drop on GitHub Pages.

The whole site is ~150 KB (88 KB of that is the emulator's WebAssembly),
so a 1 MB ROM is by far the biggest thing a visitor downloads.

## Adding your ROM

1. Copy your build into `roms/` (e.g. `roms/mygame.gbc`).
2. Add it to `roms/roms.json`:

   ```json
   [
     { "name": "My Game (dev build)", "file": "roms/mygame.gbc" }
   ]
   ```

The first entry loads automatically. With more than one entry, a dropdown
appears. To link a tester straight at a specific build:
`https://<you>.github.io/<repo>/?rom=roms/mygame.gbc`

Testers can also drag any `.gb`/`.gbc` file onto the page (or use **Open ROM…**)
without it ever being uploaded — the file is read locally in their browser.
That's the easy path for handing someone a build over Discord.

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

- **ROMs and `roms.json`** are fetched with `cache: 'no-cache'`, which
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
roms/                 your ROMs + roms.json manifest
```

`assets/player.js` is [binjgb](https://github.com/binji/binjgb)'s
`docs/simple.js` with these changes:

- the ROM is chosen at runtime (`?rom=`, `roms/roms.json`, file picker, or
  drag & drop) instead of being hardcoded;
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
