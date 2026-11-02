#!/usr/bin/env node
// Builds the itch.io upload: dist/itch/ (the files, flat) and
// dist/maras-abyss-itch.zip (the same files with index.html at the zip's root,
// which is what itch requires of an HTML game).
//
//   node tools/build-itch.mjs                      # bundles the .gbc in itch/
//   node tools/build-itch.mjs path/to/build.gbc    # bundles a specific one
//
// With no argument it takes the one .gb/.gbc file in itch/, or the site's
// newest ROM if there isn't one there.
//
// The shell (page, styles, boot code) lives in itch/. The emulator is not
// copied there by hand: player.js is assembled from the emulator half of
// frienddemo/assets/player.js plus itch/boot.js, so a fix to the core reaches
// both sites. See itch/README.md.

import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
        statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';

const SITE_DIR = 'frienddemo';
const SHELL_DIR = 'itch';
const OUT_DIR = 'dist/itch';
const ZIP = 'dist/maras-abyss-itch.zip';
const DEFAULT_ROM = SITE_DIR + '/roms/_newest_gbc-rog.gbc';

// Where player.js stops being emulator and starts being the site's own UI.
const DIVIDER = '// Everything below this line is specific to this site';

const shellRoms = readdirSync(SHELL_DIR).filter(f => /\.gbc?$/i.test(f));
if (!process.argv[2] && shellRoms.length > 1) {
  console.error('More than one ROM in ' + SHELL_DIR + '/: ' + shellRoms.join(', ') +
                '. Remove the extras or name one on the command line.');
  process.exit(1);
}
const rom = process.argv[2] ||
    (shellRoms.length ? join(SHELL_DIR, shellRoms[0]) : DEFAULT_ROM);
if (!existsSync(rom)) {
  console.error('No ROM at ' + rom);
  process.exit(1);
}

rmSync(OUT_DIR, {recursive: true, force: true});
rmSync(ZIP, {force: true});
mkdirSync(OUT_DIR, {recursive: true});

const player = readFileSync(SITE_DIR + '/assets/player.js', 'utf8');
const cut = player.indexOf(DIVIDER);
if (cut < 0) {
  console.error('Could not find the divider in player.js: "' + DIVIDER + '"');
  process.exit(1);
}
// Back up to the start of the "// ----" rule above the divider comment.
const core = player.slice(0, player.lastIndexOf('\n// ---', cut) + 1);
writeFileSync(join(OUT_DIR, 'player.js'),
              core + '\n' + readFileSync(join(SHELL_DIR, 'boot.js'), 'utf8'));

const copies = [
  [SHELL_DIR + '/index.html', 'index.html'],
  [SHELL_DIR + '/itch.css', 'itch.css'],
  [SITE_DIR + '/assets/controller.css', 'controller.css'],
  [SITE_DIR + '/assets/goodskull.gif', 'goodskull.gif'],
  [SITE_DIR + '/vendor/binjgb.js', 'binjgb.js'],
  [SITE_DIR + '/vendor/binjgb.wasm', 'binjgb.wasm'],
  [SITE_DIR + '/licenses/LICENSE.binjgb', 'licenses/LICENSE.binjgb'],
  [SITE_DIR + '/licenses/LICENSE.gb-studio', 'licenses/LICENSE.gb-studio'],
  [rom, 'game.gbc'],
];
mkdirSync(join(OUT_DIR, 'licenses'), {recursive: true});
for (const [from, to] of copies) copyFileSync(from, join(OUT_DIR, to));

// zip from inside the folder so index.html lands at the root, not in itch/.
execFileSync('zip', ['-r', '-q', '-X', '../' + basename(ZIP), '.'], {cwd: OUT_DIR});

console.log('ROM:  ' + rom);
console.log('Dir:  ' + OUT_DIR + '/');
console.log('Zip:  ' + ZIP + ' (' + Math.round(statSync(ZIP).size / 1024) + ' KB)');
