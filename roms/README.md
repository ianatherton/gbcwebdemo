# ROMs

Put your built `.gb` / `.gbc` files in this directory, then list them in
`roms.json` so they show up in the player's dropdown:

```json
[
  { "name": "My Game (dev build)", "file": "roms/mygame.gbc" }
]
```

Paths are relative to the site root, and must stay inside the site (the player
refuses absolute URLs). The first entry loads automatically; `?rom=roms/other.gbc`
picks a different one, which makes for a handy link to hand a tester.

Nothing has to be listed here at all — testers can always drag a ROM onto the
page, which loads it locally in their browser without uploading anything.
