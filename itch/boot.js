// ---------------------------------------------------------------------------
// The itch.io shell. tools/build-itch.mjs appends this file to the emulator
// half of frienddemo/assets/player.js (everything above its "specific to this
// site" divider), so Emulator, Audio, vm, $ and friends are all in scope here.
// What this replaces is the site half: one bundled ROM instead of a picker,
// a click-to-play overlay instead of a toolbar, and no guestbook.
// ---------------------------------------------------------------------------

const ROM_URL = 'game.gbc';
const MIN_ROM_BYTES = 0x8000;  // 32 KB: the smallest possible cartridge

// itch serves every HTML game from one shared origin, so localStorage is shared
// with every other game on itch too. Keep the keys unmistakably ours.
const STORAGE_PREFIX = 'marasabyss-itch';

// Battery saves are keyed by this slot rather than by build, so a player's
// progress survives you uploading a new build. Bump it if a new build changes
// the save layout and old saves would break it. Save states are a snapshot of
// the whole machine and only make sense for the exact build that made them, so
// those stay keyed by the ROM's hash.
const SAVE_SLOT = 'demo';

const statusEl = $('#status');
const overlayEl = $('#overlay');
const overlayTitleEl = $('#overlay-title');

let romBuffer = null;
let romHash = 'none';
let coreReady = false;

function storageKey(kind) {
  return STORAGE_PREFIX + ':' + kind + ':' +
      (kind === 'extram' ? SAVE_SLOT : romHash);
}

function readStoredBytes(kind) {
  try {
    const raw = localStorage.getItem(storageKey(kind));
    return raw ? new Uint8Array(JSON.parse(raw)) : new Uint8Array(0);
  } catch (e) {
    console.warn('could not read ' + kind, e);
    return new Uint8Array(0);
  }
}

function writeStoredBytes(kind, bytes) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(Array.from(bytes)));
  } catch (e) {
    console.warn('could not write ' + kind, e);
  }
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', !!isError);
}

// The core's key handlers skip events aimed at page controls. The only control
// here is the overlay, which is hidden whenever the game has the keys.
function isUiTarget(target) {
  return !!(target && target.closest && target.closest('button, a'));
}

async function romHashOf(buffer) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest).subarray(0, 4))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
  } catch (e) {
    return 'unhashed';  // Save states then just aren't tied to a build.
  }
}

async function fetchRom() {
  try {
    const response = await fetch(ROM_URL);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < MIN_ROM_BYTES) throw new Error('file is too small');
    romHash = await romHashOf(buffer);
    romBuffer = buffer;
  } catch (e) {
    setStatus('Could not load the game: ' + e.message, true);
  }
}

// Lets go of everything, so a key that was held when focus left doesn't stay
// pressed: the keyup for it went to the itch page, not to us.
function releaseAll() {
  if (!emulator) return;
  emulator.keyRewind(false);
  emulator.setFastForward(false);
  emulator.setJoypUp(false);
  emulator.setJoypDown(false);
  emulator.setJoypLeft(false);
  emulator.setJoypRight(false);
  emulator.setJoypA(false);
  emulator.setJoypB(false);
  emulator.setJoypStart(false);
  emulator.setJoypSelect(false);
}

async function play() {
  if (!romBuffer || !coreReady) return;
  // This click is the user gesture the browser wants before it plays audio.
  audioUnlocked = true;
  Audio.ctx.resume();
  window.focus();
  overlayEl.blur();

  if (!emulator) {
    const module = await binjgbPromise;
    try {
      Emulator.start(module, romBuffer, readStoredBytes('extram'));
    } catch (e) {
      Emulator.stop();
      setStatus('This build would not start: ' + e.message, true);
      return;
    }
    emulator.setBuiltinPalette(vm.palIdx);
  }
  vm.paused = false;
  document.body.classList.add('playing');
}

// Pause whenever the iframe loses focus (the player clicked or scrolled the
// itch page, or switched tabs), and wait for a click to come back.
function suspend() {
  if (!emulator || !document.body.classList.contains('playing')) return;
  releaseAll();
  vm.updateExtRam();  // don't wait for the 1 s timer if they're leaving
  vm.paused = true;
  overlayTitleEl.textContent = 'Paused — click to resume';
  document.body.classList.remove('playing');
}

(async function boot() {
  // The core only decides this once a game is running; the overlay needs it
  // sooner, to leave the keyboard help off phones.
  document.body.classList.toggle(
      'touch-gamepad', 'ontouchstart' in document.documentElement);

  overlayEl.addEventListener('click', play);
  window.addEventListener('blur', suspend);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
  });

  window.addEventListener('keydown', event => {
    if (event.code !== 'KeyM' || !document.body.classList.contains('playing')) return;
    vm.volume = vm.volume > 0 ? 0 : 0.5;
    event.preventDefault();
  });

  // Space, arrows and Backspace would otherwise scroll or navigate. The core
  // only swallows them once a game is running. Leave the overlay alone, so
  // Space and Enter still press it.
  window.addEventListener('keydown', event => {
    if (isUiTarget(event.target)) return;
    if (/^(Arrow|Space$|Backspace$)/.test(event.code)) event.preventDefault();
  });

  // Without this a missing or blocked binjgb.wasm leaves "Loading…" up forever.
  const core = binjgbPromise.then(() => { coreReady = true; }, e => {
    setStatus('Could not load the emulator: ' + (e && e.message || e), true);
  });
  await fetchRom();
  await core;
  if (coreReady && romBuffer) setStatus('');
})();
