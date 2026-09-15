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

import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';

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
// When was this build actually made? Cloudflare's asset server sends no
// Last-Modified header, so the page can't ask at load time the way it can on
// GitHub Pages — record it here instead. The file's last commit is the honest
// answer; a fresh checkout's mtime is just the clone time, so it's the fallback.
function builtAt(file) {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
                  encoding: 'utf8',
                  stdio: ['ignore', 'pipe', 'ignore'],
                }).trim();
    if (iso) return iso;
  } catch (e) {
    // Not a git checkout, or a shallow one that doesn't reach this file.
  }
  return statSync(file).mtime.toISOString();
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
        built: builtAt(file),
      };
    });

writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + '\n');
console.log(
    entries.length ?
        'roms.json: ' + entries.map(entry => entry.file).join(', ') :
        'roms.json: no ROMs in ' + ROM_DIR + '/ — the page will wait for a drop');
