#!/usr/bin/env node
// Regenerates roms/roms.json from whatever is actually sitting in roms/.
//
// The player can usually find ROMs on its own (a local server's directory
// listing, or the GitHub contents API on github.io), but neither of those
// exists on a custom domain served by Cloudflare. Running this as the build
// command settles it before the files are ever uploaded: no API, no rate limit,
// no public-repo requirement.
//
//   node tools/gen-roms.mjs
//
// Safe to run by hand and commit the result, too.

import {readdirSync, readFileSync, writeFileSync} from 'node:fs';

const ROM_DIR = 'roms';
const MANIFEST = ROM_DIR + '/roms.json';
const ROM_EXTENSION = /\.(gbc?|bin)$/i;

// Keep any names that were set by hand, for files that are still there.
let existing = [];
try {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (Array.isArray(parsed)) existing = parsed;
} catch (e) {
  // No manifest yet, or it's unreadable — rebuild it from scratch.
}
const chosenNames = new Map(
    existing.filter(entry => entry && entry.file && entry.name)
        .map(entry => [entry.file, entry.name]));

const entries = readdirSync(ROM_DIR)
    .filter(name => ROM_EXTENSION.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const file = ROM_DIR + '/' + name;
      return {
        name: chosenNames.get(file) || name.replace(ROM_EXTENSION, ''),
        file,
      };
    });

writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + '\n');
console.log(
    entries.length ?
        'roms.json: ' + entries.map(entry => entry.file).join(', ') :
        'roms.json: no ROMs in ' + ROM_DIR + '/ — the page will wait for a drop');
