# ROMs

Drop your built `.gb` / `.gbc` / `.bin` files in this directory. That's it — the
player lists whatever it finds here, under the file's own name, so a build does
not have to be named anything in particular.

Discovery works two ways, because static hosting has no "list this directory"
call:

- **Locally** (`python3 -m http.server`) the player reads the server's
  directory listing.
- **On GitHub Pages** it asks the GitHub contents API for this repo's `roms/`,
  which means the repo has to be public and the site has to be served from the
  branch the API returns (`main`, for the default *Deploy from a branch* setup).

The first ROM found loads automatically, and a dropdown appears when there is
more than one. `?rom=roms/other.gbc` picks a specific one, which makes a handy
link to hand a tester.

## roms.json (optional)

`roms.json` only exists to give ROMs nicer names and a preferred order. Listed
entries sort first; everything else in the directory follows alphabetically.

```json
[
  { "name": "My Game (dev build)", "file": "roms/mygame.gbc" }
]
```

Paths are relative to the site root and must stay inside the site (the player
refuses absolute URLs). An entry pointing at a file that is no longer here is
ignored, so a rename can't leave the page loading a 404.

Nothing has to be here at all — testers can always drag a ROM onto the page,
which loads it locally in their browser without uploading anything.
