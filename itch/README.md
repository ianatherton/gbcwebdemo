# itch.io build

The shell for the itch.io version of the demo: a page that is nothing but the
game screen, meant to sit in itch's iframe.

| File         | What it is                                                       |
|--------------|------------------------------------------------------------------|
| `index.html` | The page: screen, click-to-play overlay, on-screen gamepad       |
| `itch.css`   | Fills the iframe at 10:9 and lays out the gamepad on phones      |
| `boot.js`    | Loads the bundled ROM, pauses on blur, per-game save storage     |

The emulator isn't copied here. `tools/build-itch.mjs` assembles the upload
from these files plus the shared pieces in `frienddemo/` — the emulator half
of `assets/player.js`, the binjgb core, the gamepad styles, the licenses — and
the ROM.

## Building

```sh
node tools/build-itch.mjs                       # bundles the .gbc in itch/
node tools/build-itch.mjs path/to/build.gbc     # or any other build
```

With no argument it bundles the single `.gb`/`.gbc` in `itch/` (it is renamed
`game.gbc` inside the zip), falling back to `frienddemo/roms/_newest_gbc-rog.gbc`.

This writes `dist/itch/` and `dist/maras-abyss-itch.zip`. Upload the zip, not
the `itch/` folder or the ROM on its own: the emulator (`player.js`,
`binjgb.js`, `binjgb.wasm`) only exists in the built zip, and a bare `.gbc`
upload is just a download, not something itch can play in the browser.
To check it before uploading, serve the folder: `python3 -m http.server -d dist/itch`.

## itch.io project settings

- **Kind of project:** HTML
- **Uploads:** the zip, with *This file will be played in the browser* ticked
- **Viewport dimensions:** 640 × 576 (4× the Game Boy screen; any multiple of
  160 × 144 keeps the pixels even)
- **Mobile friendly:** on, orientation *Default* — portrait docks the gamepad
  under the screen, landscape puts it either side
- **Fullscreen button:** on
- **Click to launch in fullscreen:** off; the page has its own click-to-play
- **Automatically start on page load:** on

## Behaviour worth knowing

- The game waits behind a *Click to play* overlay. That click is what gives the
  iframe keyboard focus and lets the browser start audio. When the iframe loses
  focus (the player clicks the itch page, switches tabs), the game pauses and
  the overlay comes back, with any held buttons released.
- Saves live in the player's browser `localStorage`. itch serves every HTML
  game from one origin, so keys are prefixed `marasabyss-itch:`.
- Battery saves are keyed by `SAVE_SLOT` in `boot.js`, not by build, so
  progress carries over when you upload a new build. Bump `SAVE_SLOT` if a
  build changes the save layout. Save states (F6/F9) are tied to the exact
  build that made them.
- No cache-busting `?v=` here: every itch upload is served from a new path.
- The bug guestbook isn't included; testers still have the main site for that.
