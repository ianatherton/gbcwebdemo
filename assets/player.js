/*
 * Copyright (C) 2020 Ben Smith
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the LICENSE file for details.
 *
 *
 * Some code from GB-Studio, see LICENSE.gbstudio
 */
"use strict";

// Adapted for this site: the ROM is chosen at runtime (?rom=, roms/roms.json,
// or a dropped file) and save data is keyed per ROM. See player-notes in README.md.

// User configurable.
const ENABLE_FAST_FORWARD = true;
const ENABLE_REWIND = true;
const ENABLE_PAUSE = true;
const ENABLE_SWITCH_PALETTES = true;
const OSGP_DEADZONE = 0.1;    // On screen gamepad deadzone range
// Shared bug guestbook. Empty means the guestbook stays local to each tester's
// browser. Point it at your deployed Worker (no trailing slash) and posts go to
// a board everyone sees — see guestbook/README.md.
const GUESTBOOK_ENDPOINT = 'https://marasabyss.com';
// 0: none (raw RGB), 1: SameBoy "emulate hardware", 2: Gambatte/Game Boy
// Online. Upstream defaults to 2, which imitates a real GBC's washed-out
// screen; 0 keeps the colors as the game authored them.
const CGB_COLOR_CURVE = 0;

// List of DMG palettes to switch between. By default it includes all 84
// built-in palettes. If you want to restrict this, change it to an array of
// the palettes you want to use and change DEFAULT_PALETTE_IDX to the index of the
// default palette in that list.
//
// Example: (only allow one palette with index 16):
//   const DEFAULT_PALETTE_IDX = 0;
//   const PALETTES = [16];
//
// Example: (allow three palettes, 16, 32, 64, with default 32):
//   const DEFAULT_PALETTE_IDX = 1;
//   const PALETTES = [16, 32, 64];
//
const DEFAULT_PALETTE_IDX = 79;
const PALETTES = [
  0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
  68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,
];

// It's probably OK to leave these alone. But you can tweak them to get better
// rewind performance.
const REWIND_FRAMES_PER_BASE_STATE = 45;  // How many delta frames until keyframe
const REWIND_BUFFER_CAPACITY = 4 * 1024 * 1024;  // Total rewind capacity
const REWIND_FACTOR = 1.5;    // How fast is rewind compared to normal speed
const REWIND_UPDATE_MS = 16;  // Rewind setInterval rate

// Probably OK to leave these alone too.
const AUDIO_FRAMES = 4096;      // Number of audio frames pushed per buffer
const AUDIO_LATENCY_SEC = 0.1;
const MAX_UPDATE_SEC = 5 / 60;  // Max. time to run emulator per step (== 5 frames)

// Constants
const RESULT_OK = 0;
const RESULT_ERROR = 1;
const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const CPU_TICKS_PER_SECOND = 4194304;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;

const $ = document.querySelector.bind(document);
let emulator = null;

// The build tag from our own <script src="assets/player.js?v=N">. Everything
// this file fetches carries it too, so a visitor can never end up running new
// code against an old wasm core. Bump it in index.html when you deploy; see
// the Caching section of README.md.
const BUILD_VERSION = document.currentScript ?
    new URL(document.currentScript.src).searchParams.get('v') || '' : '';

function versioned(url) {
  if (!BUILD_VERSION) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' +
      encodeURIComponent(BUILD_VERSION);
}

const controllerEl = $('#controller');
const dpadEl = $('#controller_dpad');
const selectEl = $('#controller_select');
const startEl = $('#controller_start');
const bEl = $('#controller_b');
const aEl = $('#controller_a');

// locateFile resolves binjgb.wasm; version it alongside the glue script.
const binjgbPromise = Binjgb({
  locateFile: (path, scriptDirectory) => versioned(scriptDirectory + path),
});

// Extract stuff from the vue.js implementation in demo.js.
class VM {
  constructor() {
    this.ticks = 0;
    this.extRamUpdated = false;
    this.paused_ = false;
    this.volume = 0.5;
    this.palIdx = DEFAULT_PALETTE_IDX;
    this.rewind = {
      minTicks: 0,
      maxTicks: 0,
    };
    setInterval(() => {
      if (this.extRamUpdated) {
        this.updateExtRam();
        this.extRamUpdated = false;
      }
    }, 1000);
  }

  get paused() { return this.paused_; }
  set paused(newPaused) {
    let oldPaused = this.paused_;
    this.paused_ = newPaused;
    if (!emulator) return;
    if (newPaused == oldPaused) return;
    if (newPaused) {
      emulator.pause();
      this.ticks = emulator.ticks;
      this.rewind.minTicks = emulator.rewind.oldestTicks;
      this.rewind.maxTicks = emulator.rewind.newestTicks;
    } else {
      emulator.resume();
    }
  }

  togglePause() {
    this.paused = !this.paused;
  }

  updateExtRam() {
    if (!emulator) return;
    writeStoredBytes('extram', emulator.getExtRam());
  }
};

const vm = new VM();



// Copied from demo.js
function makeWasmBuffer(module, ptr, size) {
  return new Uint8Array(module.HEAP8.buffer, ptr, size);
}

class Emulator {
  static start(module, romBuffer, extRamBuffer) {
    Emulator.stop();
    emulator = new Emulator(module, romBuffer, extRamBuffer);
    emulator.run();
  }

  static stop() {
    if (emulator) {
      emulator.destroy();
      emulator = null;
    }
  }

  constructor(module, romBuffer, extRamBuffer) {
    this.module = module;
    // Align size up to 32k.
    const size = (romBuffer.byteLength + 0x7fff) & ~0x7fff;
    this.romDataPtr = this.module._malloc(size);
    makeWasmBuffer(this.module, this.romDataPtr, size)
        .fill(0)
        .set(new Uint8Array(romBuffer));
    this.e = this.module._emulator_new_simple(
        this.romDataPtr, size, Audio.ctx.sampleRate, AUDIO_FRAMES,
        CGB_COLOR_CURVE);
    if (this.e == 0) {
      throw new Error('Invalid ROM.');
    }

    this.audio = new Audio(module, this.e);
    this.video = new Video(module, this.e, $('#mainCanvas'));
    this.rewind = new Rewind(module, this.e);
    this.rewindIntervalId = 0;

    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.fps = 60;
    this.fastForward = false;

    if (extRamBuffer && extRamBuffer.byteLength > 0) {
      this.loadExtRam(extRamBuffer);
    }

    this.bindKeys();
    this.bindTouch();

    this.touchEnabled = 'ontouchstart' in document.documentElement;
    this.updateOnscreenGamepad();
  }

  destroy() {
    this.unbindTouch();
    this.unbindKeys();
    this.cancelAnimationFrame();
    clearInterval(this.rewindIntervalId);
    this.rewind.destroy();
    this.audio.destroy();
    // emulator_new_simple takes ownership of the ROM buffer (it stores the
    // pointer, and emulator_delete frees it via file_data_delete), so freeing
    // romDataPtr here as well would be a double free. That corrupts the
    // allocator and the next large allocation traps; upstream simple.js never
    // notices because it only ever creates one emulator.
    this.module._emulator_delete(this.e);
    this.romDataPtr = 0;
  }

  withNewFileData(fileDataPtr, cb) {
    const buffer = makeWasmBuffer(
        this.module, this.module._get_file_data_ptr(fileDataPtr),
        this.module._get_file_data_size(fileDataPtr));
    const result = cb(fileDataPtr, buffer);
    this.module._file_data_delete(fileDataPtr);
    return result;
  }

  withNewExtRamFileData(cb) {
    return this.withNewFileData(this.module._ext_ram_file_data_new(this.e), cb);
  }

  withNewStateFileData(cb) {
    return this.withNewFileData(this.module._state_file_data_new(this.e), cb);
  }

  loadExtRam(extRamBuffer) {
    this.withNewExtRamFileData((fileDataPtr, buffer) => {
      if (buffer.byteLength === extRamBuffer.byteLength) {
        buffer.set(new Uint8Array(extRamBuffer));
        this.module._emulator_read_ext_ram(this.e, fileDataPtr);
      }
    });
  }

  getExtRam() {
    return this.withNewExtRamFileData((fileDataPtr, buffer) => {
      this.module._emulator_write_ext_ram(this.e, fileDataPtr);
      return new Uint8Array(buffer);
    });
  }

  // Returns a copy of the emulator state, detached from the wasm heap.
  captureState() {
    return this.withNewStateFileData((fileDataPtr, buffer) => {
      this.module._emulator_write_state(this.e, fileDataPtr);
      return new Uint8Array(buffer);
    });
  }

  restoreState(stateBuffer) {
    if (!stateBuffer || stateBuffer.byteLength === 0) return false;
    this.endRewind();
    let restored = false;
    this.withNewStateFileData((fileDataPtr, buffer) => {
      if (buffer.byteLength === stateBuffer.byteLength) {
        buffer.set(new Uint8Array(stateBuffer));
        restored =
            this.module._emulator_read_state(this.e, fileDataPtr) === RESULT_OK;
      }
    });
    if (restored) {
      // rewind_append requires ticks to keep increasing; a restored state jumps
      // them, and appending across that gap corrupts the buffer (the assert
      // that catches it is compiled out of the release wasm). Start over.
      this.rewind.destroy();
      this.rewind = new Rewind(this.module, this.e);
      this.lastRafSec = 0;
      this.leftoverTicks = 0;
      this.audio.startSec = 0;
    }
    return restored;
  }

  loadState() {
    return this.restoreState(readStoredBytes('savestate'));
  }

  saveState() {
    writeStoredBytes('savestate', this.captureState());
  }

  get isPaused() {
    return this.rafCancelToken === null;
  }

  pause() {
    if (!this.isPaused) {
      this.cancelAnimationFrame();
      this.audio.pause();
      this.beginRewind();
    }
  }

  resume() {
    if (this.isPaused) {
      this.endRewind();
      this.requestAnimationFrame();
      this.audio.resume();
    }
  }

  setBuiltinPalette(palIdx) {
    this.module._emulator_set_builtin_palette(this.e, PALETTES[palIdx]);
  }

  get isRewinding() {
    return ENABLE_REWIND && this.rewind.isRewinding;
  }

  beginRewind() {
    if (!ENABLE_REWIND) { return; }
    this.rewind.beginRewind();
  }

  rewindToTicks(ticks) {
    if (!ENABLE_REWIND) { return; }
    if (this.rewind.rewindToTicks(ticks)) {
      this.runUntil(ticks);
      this.video.renderTexture();
    }
  }

  endRewind() {
    if (!ENABLE_REWIND) { return; }
    this.rewind.endRewind();
    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.audio.startSec = 0;
  }

  set autoRewind(enabled) {
    if (!ENABLE_REWIND) { return; }
    if (enabled) {
      this.rewindIntervalId = setInterval(() => {
        const oldest = this.rewind.oldestTicks;
        const start = this.ticks;
        const delta =
            REWIND_FACTOR * REWIND_UPDATE_MS / 1000 * CPU_TICKS_PER_SECOND;
        const rewindTo = Math.max(oldest, start - delta);
        this.rewindToTicks(rewindTo);
        vm.ticks = emulator.ticks;
      }, REWIND_UPDATE_MS);
    } else {
      clearInterval(this.rewindIntervalId);
      this.rewindIntervalId = 0;
    }
  }

  requestAnimationFrame() {
    this.rafCancelToken = requestAnimationFrame(this.rafCallback.bind(this));
  }

  cancelAnimationFrame() {
    cancelAnimationFrame(this.rafCancelToken);
    this.rafCancelToken = null;
  }

  run() {
    this.requestAnimationFrame();
  }

  get ticks() {
    return this.module._emulator_get_ticks_f64(this.e);
  }

  runUntil(ticks) {
    while (true) {
      const event = this.module._emulator_run_until_f64(this.e, ticks);
      if (event & EVENT_NEW_FRAME) {
        this.rewind.pushBuffer();
        this.video.uploadTexture();
      }
      if ((event & EVENT_AUDIO_BUFFER_FULL) && !this.isRewinding) {
        this.audio.pushBuffer();
      }
      if (event & EVENT_UNTIL_TICKS) {
        break;
      }
    }
    if (this.module._emulator_was_ext_ram_updated(this.e)) {
      vm.extRamUpdated = true;
    }
  }

  rafCallback(startMs) {
    this.requestAnimationFrame();
    let deltaSec = 0;
    if (!this.isRewinding) {
      const startSec = startMs / 1000;
      deltaSec = Math.max(startSec - (this.lastRafSec || startSec), 0);

      const startTimeMs = performance.now();
      const deltaTicks =
          Math.min(deltaSec, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND;
      let runUntilTicks = this.ticks + deltaTicks - this.leftoverTicks;
      this.runUntil(runUntilTicks);
      const deltaTimeMs = performance.now() - startTimeMs;
      const deltaTimeSec = deltaTimeMs / 1000;

      if (this.fastForward) {
        // Estimate how much faster we can run in fast-forward, keeping the
        // same rAF update rate.
        const speedUp = (deltaTicks / CPU_TICKS_PER_SECOND) / deltaTimeSec;
        const extraFrames = Math.floor(speedUp - deltaTimeSec);
        const extraTicks = extraFrames * deltaTicks;
        runUntilTicks = this.ticks + extraTicks - this.leftoverTicks;
        this.runUntil(runUntilTicks);
      }

      this.leftoverTicks = (this.ticks - runUntilTicks) | 0;
      this.lastRafSec = startSec;
    }
    const lerp = (from, to, alpha) => (alpha * from) + (1 - alpha) * to;
    this.fps = lerp(this.fps, Math.min(1 / deltaSec, 10000), 0.3);
    this.video.renderTexture();
  }

  updateOnscreenGamepad() {
    $('#controller').style.display = this.touchEnabled ? 'block' : 'none';
    // Lets the page reserve room so the fixed gamepad doesn't cover content.
    document.body.classList.toggle('touch-gamepad', this.touchEnabled);
  }

  bindTouch() {
    this.touchFuncs = {
      'controller_b': this.setJoypB.bind(this),
      'controller_a': this.setJoypA.bind(this),
      'controller_start': this.setJoypStart.bind(this),
      'controller_select': this.setJoypSelect.bind(this),
    };

    this.boundButtonTouchStart = this.buttonTouchStart.bind(this);
    this.boundButtonTouchEnd = this.buttonTouchEnd.bind(this);
    selectEl.addEventListener('touchstart', this.boundButtonTouchStart);
    selectEl.addEventListener('touchend', this.boundButtonTouchEnd);
    startEl.addEventListener('touchstart', this.boundButtonTouchStart);
    startEl.addEventListener('touchend', this.boundButtonTouchEnd);
    bEl.addEventListener('touchstart', this.boundButtonTouchStart);
    bEl.addEventListener('touchend', this.boundButtonTouchEnd);
    aEl.addEventListener('touchstart', this.boundButtonTouchStart);
    aEl.addEventListener('touchend', this.boundButtonTouchEnd);

    this.boundDpadTouchStartMove = this.dpadTouchStartMove.bind(this);
    this.boundDpadTouchEnd = this.dpadTouchEnd.bind(this);
    dpadEl.addEventListener('touchstart', this.boundDpadTouchStartMove);
    dpadEl.addEventListener('touchmove', this.boundDpadTouchStartMove);
    dpadEl.addEventListener('touchend', this.boundDpadTouchEnd);

    this.boundTouchRestore = this.touchRestore.bind(this);
    window.addEventListener('touchstart', this.boundTouchRestore);
  }

  unbindTouch() {
    selectEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    selectEl.removeEventListener('touchend', this.boundButtonTouchEnd);
    startEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    startEl.removeEventListener('touchend', this.boundButtonTouchEnd);
    bEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    bEl.removeEventListener('touchend', this.boundButtonTouchEnd);
    aEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    aEl.removeEventListener('touchend', this.boundButtonTouchEnd);

    dpadEl.removeEventListener('touchstart', this.boundDpadTouchStartMove);
    dpadEl.removeEventListener('touchmove', this.boundDpadTouchStartMove);
    dpadEl.removeEventListener('touchend', this.boundDpadTouchEnd);

    window.removeEventListener('touchstart', this.boundTouchRestore);
  }

  buttonTouchStart(event) {
    if (event.currentTarget.id in this.touchFuncs) {
      this.touchFuncs[event.currentTarget.id](true);
      event.currentTarget.classList.add('btnPressed');
      event.preventDefault();
    }
  }

  buttonTouchEnd(event) {
    if (event.currentTarget.id in this.touchFuncs) {
      this.touchFuncs[event.currentTarget.id](false);
      event.currentTarget.classList.remove('btnPressed');
      event.preventDefault();
    }
  }

  dpadTouchStartMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (2 * (event.targetTouches[0].clientX - rect.left)) / rect.width - 1;
    const y = (2 * (event.targetTouches[0].clientY - rect.top)) / rect.height - 1;

    // Eight 45-degree sectors around the centre, so the corner pads press two
    // directions at once. Sector 0 points right and they run clockwise, since
    // y grows downwards.
    if (Math.hypot(x, y) < OSGP_DEADZONE) {
      this.setJoypLeft(false);
      this.setJoypRight(false);
      this.setJoypUp(false);
      this.setJoypDown(false);
    } else {
      const sector = (Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8;
      this.setJoypRight(sector === 7 || sector === 0 || sector === 1);
      this.setJoypDown(sector === 1 || sector === 2 || sector === 3);
      this.setJoypLeft(sector === 3 || sector === 4 || sector === 5);
      this.setJoypUp(sector === 5 || sector === 6 || sector === 7);
    }
    event.preventDefault();
  }

  dpadTouchEnd(event) {
    this.setJoypLeft(false);
    this.setJoypRight(false);
    this.setJoypUp(false);
    this.setJoypDown(false);
    event.preventDefault();
  }

  touchRestore() {
    this.touchEnabled = true;
    this.updateOnscreenGamepad();
  }

  bindKeys() {
    this.keyFuncs = {
      'ArrowDown': this.setJoypDown.bind(this),
      'ArrowLeft': this.setJoypLeft.bind(this),
      'ArrowRight': this.setJoypRight.bind(this),
      'ArrowUp': this.setJoypUp.bind(this),
      'KeyZ': this.setJoypB.bind(this),
      'KeyX': this.setJoypA.bind(this),
      'Enter': this.setJoypStart.bind(this),
      'ShiftRight': this.setJoypSelect.bind(this),
      'Backspace': this.keyRewind.bind(this),
      'Space': this.keyPause.bind(this),
      'BracketLeft': this.keyPrevPalette.bind(this),
      'BracketRight': this.keyNextPalette.bind(this),
      'ShiftLeft': this.setFastForward.bind(this),
      'F6': this.saveState.bind(this),
      'F9': this.loadState.bind(this),
    };
    this.boundKeyDown = this.keyDown.bind(this);
    this.boundKeyUp = this.keyUp.bind(this);

    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
  }

  unbindKeys() {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
  }

  keyDown(event) {
    if (isUiTarget(event.target)) return;
    if (event.code in this.keyFuncs) {
      if (this.touchEnabled) {
        this.touchEnabled = false;
        this.updateOnscreenGamepad();
      }
      this.keyFuncs[event.code](true);
      event.preventDefault();
    }
  }

  keyUp(event) {
    if (isUiTarget(event.target)) return;
    if (event.code in this.keyFuncs) {
      this.keyFuncs[event.code](false);
      event.preventDefault();
    }
  }

  keyRewind(isKeyDown) {
    if (!ENABLE_REWIND) { return; }
    if (this.isRewinding !== isKeyDown) {
      if (isKeyDown) {
        vm.paused = true;
        this.autoRewind = true;
      } else {
        this.autoRewind = false;
        vm.paused = false;
      }
    }
  }

  keyPause(isKeyDown) {
    if (!ENABLE_PAUSE) { return; }
    if (isKeyDown) vm.togglePause();
  }

  keyPrevPalette(isKeyDown) {
    if (!ENABLE_SWITCH_PALETTES) { return; }
    if (isKeyDown) {
      vm.palIdx = (vm.palIdx + PALETTES.length - 1) % PALETTES.length;
      emulator.setBuiltinPalette(vm.palIdx);
    }
  }

  keyNextPalette(isKeyDown) {
    if (!ENABLE_SWITCH_PALETTES) { return; }
    if (isKeyDown) {
      vm.palIdx = (vm.palIdx + 1) % PALETTES.length;
      emulator.setBuiltinPalette(vm.palIdx);
    }
  }

  setFastForward(isKeyDown) {
    if (!ENABLE_FAST_FORWARD) { return; }
    this.fastForward = isKeyDown;
  }

  setJoypDown(set) { this.module._set_joyp_down(this.e, set); }
  setJoypUp(set) { this.module._set_joyp_up(this.e, set); }
  setJoypLeft(set) { this.module._set_joyp_left(this.e, set); }
  setJoypRight(set) { this.module._set_joyp_right(this.e, set); }
  setJoypSelect(set) { this.module._set_joyp_select(this.e, set); }
  setJoypStart(set) { this.module._set_joyp_start(this.e, set); }
  setJoypB(set) { this.module._set_joyp_B(this.e, set); }
  setJoypA(set) { this.module._set_joyp_A(this.e, set); }
}

let audioUnlocked = false;

class Audio {
  constructor(module, e) {
    this.started = audioUnlocked;
    this.module = module;
    this.buffer = makeWasmBuffer(
        this.module, this.module._get_audio_buffer_ptr(e),
        this.module._get_audio_buffer_capacity(e));
    this.startSec = 0;
    this.resume();

    this.boundStartPlayback = this.startPlayback.bind(this);
    window.addEventListener('keydown', this.boundStartPlayback, true);
    window.addEventListener('click', this.boundStartPlayback, true);
    window.addEventListener('touchend', this.boundStartPlayback, true);
  }

  startPlayback() {
    window.removeEventListener('touchend', this.boundStartPlayback, true);
    window.removeEventListener('keydown', this.boundStartPlayback, true);
    window.removeEventListener('click', this.boundStartPlayback, true);
    audioUnlocked = true;
    this.started = true;
    this.resume();
  }

  get sampleRate() { return Audio.ctx.sampleRate; }

  pushBuffer() {
    if (!this.started) { return; }
    const nowSec = Audio.ctx.currentTime;
    const nowPlusLatency = nowSec + AUDIO_LATENCY_SEC;
    const volume = vm.volume;
    this.startSec = (this.startSec || nowPlusLatency);
    const bufferSec = AUDIO_FRAMES / this.sampleRate;
    if (this.startSec >= nowSec) {
      // The emulator is driven by the wall clock and playback by the audio
      // clock. They drift apart, and any frame where the emulator catches up
      // (a rAF may run MAX_UPDATE_SEC of emulation at once, and fast-forward
      // runs more) queues a burst of samples. Both push the queue deeper, and
      // nothing here used to pull it back, so the delay grew for as long as the
      // page stayed open — badly on a phone, where slow frames are routine.
      // Drop samples while the queue is too deep so it drains back towards
      // AUDIO_LATENCY_SEC. Two buffers of slack keeps normal play from
      // dropping anything.
      if (this.startSec - nowSec > AUDIO_LATENCY_SEC + 2 * bufferSec) { return; }
      const buffer = Audio.ctx.createBuffer(2, AUDIO_FRAMES, this.sampleRate);
      const channel0 = buffer.getChannelData(0);
      const channel1 = buffer.getChannelData(1);
      for (let i = 0; i < AUDIO_FRAMES; i++) {
        channel0[i] = this.buffer[2 * i] * volume / 255;
        channel1[i] = this.buffer[2 * i + 1] * volume / 255;
      }
      const bufferSource = Audio.ctx.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(Audio.ctx.destination);
      bufferSource.start(this.startSec);
      this.startSec += bufferSec;
    } else {
      console.log(
          'Resetting audio (' + this.startSec.toFixed(2) + ' < ' +
          nowSec.toFixed(2) + ')');
      this.startSec = nowPlusLatency;
    }
  }

  pause() {
    if (!this.started) { return; }
    Audio.ctx.suspend();
  }

  resume() {
    if (!this.started) { return; }
    Audio.ctx.resume();
  }

  destroy() {
    if (this.boundStartPlayback) {
      window.removeEventListener('keydown',  this.boundStartPlayback, true);
      window.removeEventListener('click',    this.boundStartPlayback, true);
      window.removeEventListener('touchend', this.boundStartPlayback, true);
      this.boundStartPlayback = null;
    }
    this.buffer = null;
    this.started = false;
  }
}

Audio.ctx = new AudioContext({latencyHint: 'interactive'});

class Video {
  constructor(module, e, el) {
    this.module = module;
    // iPhone Safari doesn't upscale using image-rendering: pixelated on webgl
    // canvases. See https://bugs.webkit.org/show_bug.cgi?id=193895.
    // For now, default to Canvas2D.
    if (window.navigator.userAgent.match(/iPhone|iPad/)) {
      this.renderer = new Canvas2DRenderer(el);
    } else {
      try {
        this.renderer = new WebGLRenderer(el);
      } catch (error) {
        console.log(`Error creating WebGLRenderer: ${error}`);
        this.renderer = new Canvas2DRenderer(el);
      }
    }
    this.buffer = makeWasmBuffer(
        this.module, this.module._get_frame_buffer_ptr(e),
        this.module._get_frame_buffer_size(e));
  }

  uploadTexture() {
    this.renderer.uploadTexture(this.buffer);
  }

  renderTexture() {
    this.renderer.renderTexture();
  }
}

class Canvas2DRenderer {
  constructor(el) {
    this.ctx = el.getContext('2d');
    this.imageData = this.ctx.createImageData(el.width, el.height);
  }

  renderTexture() {
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  uploadTexture(buffer) {
    this.imageData.data.set(buffer);
  }
}

class WebGLRenderer {
  constructor(el) {
    const gl = this.gl = el.getContext('webgl', {preserveDrawingBuffer: true});
    if (gl === null) {
      throw new Error('unable to create webgl context');
    }

    const w = SCREEN_WIDTH / 256;
    const h = SCREEN_HEIGHT / 256;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  0, h,
      +1, -1,  w, h,
      -1, +1,  0, 0,
      +1, +1,  w, 0,
    ]), gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    function compileShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`compileShader failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER,
       `attribute vec2 aPos;
        attribute vec2 aTexCoord;
        varying highp vec2 vTexCoord;
        void main(void) {
          gl_Position = vec4(aPos, 0.0, 1.0);
          vTexCoord = aTexCoord;
        }`);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER,
       `varying highp vec2 vTexCoord;
        uniform sampler2D uSampler;
        void main(void) {
          gl_FragColor = texture2D(uSampler, vTexCoord);
        }`);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const aPos = gl.getAttribLocation(program, 'aPos');
    const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
    const uSampler = gl.getUniformLocation(program, 'uSampler');

    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, gl.FALSE, 16, 0);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, gl.FALSE, 16, 8);
    gl.uniform1i(uSampler, 0);
  }

  renderTexture() {
    this.gl.clearColor(0.5, 0.5, 0.5, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  uploadTexture(buffer) {
    this.gl.texSubImage2D(
        this.gl.TEXTURE_2D, 0, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, this.gl.RGBA,
        this.gl.UNSIGNED_BYTE, buffer);
  }
}

class Rewind {
  constructor(module, e) {
    this.module = module;
    this.e = e;
    this.joypadBufferPtr = this.module._joypad_new();
    this.statePtr = 0;
    this.bufferPtr = this.module._rewind_new_simple(
        e, REWIND_FRAMES_PER_BASE_STATE, REWIND_BUFFER_CAPACITY);
    this.module._emulator_set_default_joypad_callback(e, this.joypadBufferPtr);
  }

  destroy() {
    this.module._rewind_delete(this.bufferPtr);
    this.module._joypad_delete(this.joypadBufferPtr);
  }

  get oldestTicks() {
    return this.module._rewind_get_oldest_ticks_f64(this.bufferPtr);
  }

  get newestTicks() {
    return this.module._rewind_get_newest_ticks_f64(this.bufferPtr);
  }

  pushBuffer() {
    if (!this.isRewinding) {
      this.module._rewind_append(this.bufferPtr, this.e);
    }
  }

  get isRewinding() {
    return this.statePtr !== 0;
  }

  beginRewind() {
    if (this.isRewinding) return;
    this.statePtr =
        this.module._rewind_begin(this.e, this.bufferPtr, this.joypadBufferPtr);
  }

  rewindToTicks(ticks) {
    if (!this.isRewinding) return;
    return this.module._rewind_to_ticks_wrapper(this.statePtr, ticks) ===
        RESULT_OK;
  }

  endRewind() {
    if (!this.isRewinding) return;
    this.module._emulator_set_default_joypad_callback(
        this.e, this.joypadBufferPtr);
    this.module._rewind_end(this.statePtr);
    this.statePtr = 0;
  }
}

// ---------------------------------------------------------------------------
// Everything below this line is specific to this site: ROM loading, the
// toolbar, drag & drop, and per-ROM save data. The emulator classes above are
// binjgb's.
// ---------------------------------------------------------------------------

const ROM_DIR = 'roms/';
const MANIFEST_URL = ROM_DIR + 'roms.json';
const ROM_EXTENSION = /\.(gbc?|bin)$/i;
const MIN_ROM_BYTES = 0x8000;  // 32 KB: the smallest possible cartridge
const MAX_ROM_BYTES = 8 * 1024 * 1024;
const STORAGE_PREFIX = 'gbcwebdemo';

const screenEl = $('#screen');
const statusEl = $('#status');
const romInfoEl = $('#rom-info');
const romSelectEl = $('#rom-select');
const fileInputEl = $('#rom-file');
const dropHintEl = $('#drop-hint');

let romKey = 'none';       // identifies save data for the loaded ROM
let currentRom = null;     // {buffer, key, label, modified}
let currentBuild = null;   // what the guestbook stamps onto a report
const romManifest = new Map();  // file -> manifest entry, for its build date

function storageKey(kind) {
  return STORAGE_PREFIX + ':' + kind + ':' + romKey;
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

// Don't steal keys while the user is tabbing around the toolbar.
function isUiTarget(target) {
  return !!(target &&
            target.closest &&
            target.closest('button, select, input, textarea, a'));
}

const NINTENDO_LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

// Rejects things that plainly aren't cartridges (a text file, a truncated
// build) before handing them to the emulator, which would happily boot noise.
function romProblem(byteLength, label) {
  if (byteLength < MIN_ROM_BYTES) {
    return label + ' is only ' + byteLength + ' bytes — too small to be a Game Boy ROM.';
  }
  if (byteLength > MAX_ROM_BYTES) {
    return label + ' is ' + Math.round(byteLength / 1024) + ' KB — too big to be a Game Boy ROM.';
  }
  return null;
}

// Cartridge header: title at 0x134, CGB flag at 0x143.
function romHeaderInfo(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 0x150) return null;
  let title = '';
  for (let i = 0x134; i < 0x143; i++) {
    if (bytes[i] === 0) break;
    if (bytes[i] >= 32 && bytes[i] < 127) title += String.fromCharCode(bytes[i]);
  }
  const cgb = bytes[0x143];
  const logoOk = NINTENDO_LOGO.every((b, i) => bytes[0x104 + i] === b);
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - bytes[i] - 1) & 0xff;
  return {
    title: title.trim(),
    mode: cgb === 0xc0 ? 'GBC only' : cgb === 0x80 ? 'GBC enhanced' : 'DMG',
    kb: Math.round(bytes.length / 1024),
    rev: bytes[0x14c],  // mask ROM version number
    headerOk: logoOk && checksum === bytes[0x14d],
  };
}

// A short content hash of the ROM, so "the build I was playing" is a fact in
// the bug report rather than something to reconstruct later. SHA-256 needs a
// secure context (https, or localhost); FNV-1a covers plain http.
async function romFingerprint(buffer) {
  if (window.crypto && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest).subarray(0, 4))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
    } catch (e) {
      // Fall through to the plain-JS hash below.
    }
  }
  const bytes = new Uint8Array(buffer);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function startRom(buffer, key, label, modified) {
  const module = await binjgbPromise;
  romKey = key;
  currentRom = {buffer, key, label, modified: modified || null};
  try {
    Emulator.start(module, buffer, readStoredBytes('extram'));
  } catch (e) {
    Emulator.stop();
    document.body.classList.remove('running');
    setStatus(label + ' is not a valid Game Boy ROM.', true);
    return;
  }
  emulator.setBuiltinPalette(vm.palIdx);
  vm.paused = false;
  document.body.classList.add('running');
  const info = romHeaderInfo(buffer);
  romInfoEl.textContent =
      info ? [info.title || label, info.mode, info.kb + ' KB'].join(' · ') : label;
  currentBuild = {
    file: label,
    title: info ? info.title : '',
    mode: info ? info.mode : '',
    kb: info ? info.kb : Math.round(buffer.byteLength / 1024),
    rev: info ? info.rev : null,
    id: await romFingerprint(buffer),
    modified: currentRom.modified,
  };
  renderBuildStamp();
  setStatus(
      (info && !info.headerOk ? 'Header looks wrong (bad logo or checksum) — running anyway. ' : '') +
      'Click the screen to enable sound, then press Enter to start.',
      !!(info && !info.headerOk));
}

// Only same-origin, relative paths — no fetching arbitrary URLs from ?rom=.
function isSafeRomPath(path) {
  return !!path && !path.startsWith('/') && !path.includes('//') &&
      !path.includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

async function loadRomFromUrl(path) {
  if (!isSafeRomPath(path)) {
    setStatus('Refusing to load "' + path + '": only relative paths inside this site are allowed.', true);
    return;
  }
  setStatus('Loading ' + path + '…');
  let response;
  try {
    response = await fetch(path, {cache: 'no-cache'});
  } catch (e) {
    setStatus('Could not fetch ' + path + ': ' + e.message, true);
    return;
  }
  if (!response.ok) {
    setStatus('Could not load ' + path + ' (HTTP ' + response.status + ').', true);
    return;
  }
  const buffer = await response.arrayBuffer();
  const problem = romProblem(buffer.byteLength, path);
  if (problem) {
    setStatus(problem, true);
    return;
  }
  // Last-Modified is the closest thing a static host has to a build date, but
  // Cloudflare's asset server doesn't send one — fall back to the date
  // tools/gen-roms.mjs recorded for this file at build time.
  const served = Date.parse(response.headers.get('Last-Modified') || '');
  const entry = romManifest.get(path);
  const recorded = Date.parse((entry && entry.built) || '');
  const modified = !Number.isNaN(served) ? served :
      !Number.isNaN(recorded)            ? recorded :
                                           null;
  await startRom(buffer, path, path.split('/').pop(), modified);
}

async function loadRomFromFile(file) {
  const problem = romProblem(file.size, file.name);
  if (problem) {
    setStatus(problem, true);
    return;
  }
  romSelectEl.value = '';
  await startRom(await file.arrayBuffer(), 'file:' + file.name, file.name,
                 file.lastModified || null);
}

// roms.json is optional now: it only supplies nicer names and a preferred
// order. Any ROM sitting in roms/ shows up whether or not it is listed.
async function loadManifest() {
  try {
    const response = await fetch(MANIFEST_URL, {cache: 'no-cache'});
    if (!response.ok) return [];
    const entries = await response.json();
    return Array.isArray(entries) ? entries.filter(e => e && e.file) : [];
  } catch (e) {
    return [];  // No manifest is fine; the file picker still works.
  }
}

// Static hosting has no "list this directory" call, so try the two listings
// that exist in practice: an HTML autoindex (python -m http.server, nginx),
// and — when the site is on GitHub Pages — the repo's contents API.
async function discoverRoms() {
  const fromIndex = await listRomsFromAutoindex();
  if (fromIndex.length) return fromIndex;
  return listRomsFromGitHub();
}

// Discovery is a convenience, so never let it hold up the ROM behind it.
const DISCOVERY_TIMEOUT_MS = 2500;

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  return fetch(url, Object.assign({signal: controller.signal}, options))
      .finally(() => clearTimeout(timer));
}

async function listRomsFromAutoindex() {
  try {
    const response = await fetchWithTimeout(ROM_DIR, {cache: 'no-cache'});
    if (!response.ok) return [];
    if (!(response.headers.get('content-type') || '').includes('html')) return [];
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return romPaths(Array.from(doc.querySelectorAll('a[href]'), link => {
      // Sort links (?C=N;O=D) and parent links fall out at the extension test.
      const href = link.getAttribute('href') || '';
      try {
        return decodeURIComponent(href).split('/').pop();
      } catch (e) {
        return href.split('/').pop();
      }
    }));
  } catch (e) {
    return [];
  }
}

// https://<user>.github.io/<repo>/ is served from github.com/<user>/<repo>;
// a user site (no repo path segment) comes from a repo named after the host.
function githubContentsUrl() {
  const host = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  if (!host) return null;
  const repo = location.pathname.split('/').filter(Boolean)[0] || host[0];
  return 'https://api.github.com/repos/' + host[1] + '/' + repo + '/contents/' +
      ROM_DIR.replace(/\/$/, '');
}

async function listRomsFromGitHub() {
  const url = githubContentsUrl();
  if (!url) return [];
  try {
    const response =
        await fetchWithTimeout(url, {headers: {Accept: 'application/vnd.github+json'}});
    if (!response.ok) return [];  // Private repo, renamed dir, or rate limited.
    const entries = await response.json();
    if (!Array.isArray(entries)) return [];
    return romPaths(entries.filter(e => e && e.type === 'file').map(e => e.name));
  } catch (e) {
    return [];
  }
}

function romPaths(names) {
  return names.filter(name => name && ROM_EXTENSION.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map(name => ROM_DIR + name);
}

function romDisplayName(path) {
  return path.split('/').pop().replace(ROM_EXTENSION, '');
}

// Manifest entries first (they were listed deliberately), then whatever else
// is in roms/. When discovery worked we also know which manifest entries are
// stale, so a renamed ROM can't leave the page auto-loading a 404.
function mergeRomLists(manifest, discovered) {
  const present = new Set(discovered);
  const entries = discovered.length ?
      manifest.filter(entry => present.has(entry.file)) : manifest.slice();
  const listed = new Set(entries.map(entry => entry.file));
  for (const file of discovered) {
    if (!listed.has(file)) entries.push({name: romDisplayName(file), file});
  }
  return entries;
}

function wireControls() {
  fileInputEl.addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) loadRomFromFile(file);
    event.target.value = '';  // allow re-picking the same file after a rebuild
  });

  romSelectEl.addEventListener('change', event => {
    const path = event.target.value;
    if (!path) return;
    const url = new URL(location.href);
    url.searchParams.set('rom', path);
    history.replaceState(null, '', url);
    loadRomFromUrl(path);
  });

  // Buttons give focus back to the page so the arrow keys keep working.
  const onClick = (selector, fn) => $(selector).addEventListener('click', event => {
    event.currentTarget.blur();
    fn(event);
  });

  onClick('#btn-pause', () => {
    if (!emulator) return;
    vm.togglePause();
    $('#btn-pause').textContent = vm.paused ? 'Resume' : 'Pause';
    setStatus(vm.paused ? 'Paused.' : 'Running.');
  });

  onClick('#btn-reset', () => {
    if (!currentRom) return;
    startRom(currentRom.buffer, currentRom.key, currentRom.label,
             currentRom.modified);
    $('#btn-pause').textContent = 'Pause';
  });

  onClick('#btn-save', () => {
    if (!emulator) return;
    emulator.saveState();
    setStatus('Saved state for ' + (currentRom ? currentRom.label : 'ROM') + '.');
  });

  onClick('#btn-load', () => {
    if (!emulator) return;
    setStatus(emulator.loadState() ? 'Loaded state.' :
                                     'No save state stored for this ROM yet.');
  });

  onClick('#btn-mute', event => {
    vm.volume = vm.volume > 0 ? 0 : 0.5;
    const muted = vm.volume === 0;
    event.currentTarget.textContent = muted ? 'Unmute' : 'Mute';
    event.currentTarget.setAttribute('aria-pressed', String(muted));
  });

  onClick('#btn-fullscreen', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (screenEl.requestFullscreen) {
      screenEl.requestFullscreen().catch(e => setStatus('Fullscreen failed: ' + e.message, true));
    }
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', event => {
    event.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) loadRomFromFile(file);
  });

  dropHintEl.addEventListener('click', () => fileInputEl.click());
}

// ---------------------------------------------------------------------------
// Bug guestbook: a tester's notes, stamped with the date and with the exact
// build they were playing.
//
// Every entry is written to this browser's localStorage first, so a report is
// never lost to a failed request. With GUESTBOOK_ENDPOINT set it is then posted
// to the Worker in guestbook/, and the page shows that shared board instead —
// screenshots stay local either way. With no endpoint the log is simply local,
// and Copy all / Download are how it gets handed over.
// ---------------------------------------------------------------------------

const GUESTBOOK_KEY = STORAGE_PREFIX + ':guestbook';
const GUESTBOOK_MAX = 50;

const GUESTBOOK_PAGE = 10;  // Entries per request; see guestbook/README.md.

let sharedEntries = [];    // the board so far, oldest request first
let sharedCursor = null;   // where the next page picks up, null when exhausted
let sharedDone = true;     // until a response says there is more
let sharedError = '';
let sharedQuota = null;    // {used, cap, left} as the Worker last reported it
let guestbookFilter = {kind: '', rom: ''};

const gbBuildEl = $('#gb-build');
const gbFormEl = $('#gb-form');
const gbWhoEl = $('#gb-who');
const gbKindEl = $('#gb-kind');
const gbTextEl = $('#gb-text');
const gbQuotaEl = $('#gb-quota');
const gbListEl = $('#gb-list');
const gbStatusEl = $('#gb-status');
const gbMoreEl = $('#gb-more');
const gbFiltersEl = $('#gb-filters');
const gbFilterKindEl = $('#gb-filter-kind');
const gbFilterRomEl = $('#gb-filter-rom');
const gbNoteEl = $('#gb-note');
const gbTrapEl = $('#gb-website');

function guestbookIsShared() {
  return !!GUESTBOOK_ENDPOINT;
}

function readGuestbook() {
  try {
    const raw = localStorage.getItem(GUESTBOOK_KEY);
    const entries = raw ? JSON.parse(raw) : [];
    return Array.isArray(entries) ? entries : [];
  } catch (e) {
    console.warn('could not read the guestbook', e);
    return [];
  }
}

function writeGuestbook(entries) {
  let list = entries.slice(0, GUESTBOOK_MAX);
  for (;;) {
    try {
      localStorage.setItem(GUESTBOOK_KEY, JSON.stringify(list));
      return list;
    } catch (e) {
      // Out of room — save states share this storage and are far bigger. Shed
      // the oldest screenshot first; only drop whole entries once none are left.
      let oldestShot = -1;
      for (let i = 0; i < list.length; i++) {
        if (list[i].shot) oldestShot = i;
      }
      if (oldestShot >= 0) {
        list = list.slice();
        list[oldestShot] = Object.assign({}, list[oldestShot], {shot: null});
      } else if (list.length > 1) {
        list = list.slice(0, -1);
      } else {
        setGuestbookStatus('No room left in this browser for the guestbook.',
                           true);
        return readGuestbook();
      }
    }
  }
}

// Only ever pulls one page. Reading the whole board on every load is what
// makes a busy guestbook expensive — one KV read per entry, per visitor.
async function fetchSharedEntries(append) {
  if (!guestbookIsShared()) return;
  const params = new URLSearchParams({limit: String(GUESTBOOK_PAGE)});
  if (guestbookFilter.kind) params.set('kind', guestbookFilter.kind);
  if (guestbookFilter.rom) params.set('rom', guestbookFilter.rom);
  if (append && sharedCursor) params.set('cursor', sharedCursor);
  try {
    const response = await fetch(
        GUESTBOOK_ENDPOINT + '/entries?' + params.toString(), {cache: 'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const body = await response.json();
    if (body.quota) sharedQuota = body.quota;
    const page = Array.isArray(body.entries) ? body.entries : [];
    sharedEntries = append ? sharedEntries.concat(page) : page;
    sharedCursor = body.cursor || null;
    sharedDone = !!body.done || !body.cursor;
    sharedError = '';
  } catch (e) {
    if (!append) sharedEntries = [];
    sharedCursor = null;
    sharedDone = true;
    sharedError = 'Could not reach the shared guestbook (' + e.message +
        '). Showing what this browser has.';
  }
}

// The screenshot rides along as base64 PNG — a Game Boy frame is 1-4 KB, so
// it costs one extra KV write and nothing worth worrying about in storage.
async function postEntry(entry) {
  const response = await fetch(GUESTBOOK_ENDPOINT + '/entries', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      id: entry.id,
      who: entry.who,
      kind: entry.kind,
      text: entry.text,
      rom: entry.rom,
      title: entry.title,
      build: entry.build,
      built: entry.built,
      rev: entry.rev,
      site: entry.site,
      ua: entry.ua,
      shot: entry.shot || undefined,
      website: gbTrapEl ? gbTrapEl.value : '',
    }),
  });
  if (!response.ok) {
    let message = 'HTTP ' + response.status;
    try {
      const body = await response.json();
      message = body.error || message;
      if (body.quota) sharedQuota = body.quota;
    } catch (e) {
      // Keep the status code as the message.
    }
    throw new Error(message);
  }
  try {
    const body = await response.json();
    if (body.quota) sharedQuota = body.quota;
    return body;
  } catch (e) {
    return {};
  }
}

function markSent(id) {
  writeGuestbook(readGuestbook().map(
      entry => entry.id === id ? Object.assign({}, entry, {sent: true}) : entry));
}

// Anything written while the Worker was unreachable is still in localStorage;
// push it on the next load, oldest first, and give up quietly if still offline.
async function flushPending() {
  if (!guestbookIsShared()) return;
  const pending = readGuestbook().filter(entry => !entry.sent).reverse();
  for (const entry of pending) {
    try {
      await postEntry(entry);
      markSent(entry.id);
    } catch (e) {
      return;
    }
  }
}

// What the page shows. On a shared board that's the server's entries, with each
// tester's own screenshots reattached locally by id, plus anything of theirs
// that hasn't been accepted yet.
function matchesFilter(entry) {
  if (guestbookFilter.kind && entry.kind !== guestbookFilter.kind) return false;
  if (guestbookFilter.rom && entry.rom !== guestbookFilter.rom) return false;
  return true;
}

// The board carries a screenshot either as a local data URL (this browser
// wrote it) or as a key to fetch it back from the Worker.
function shotSrc(entry) {
  if (entry.shot) return entry.shot;
  if (entry.shotKey && guestbookIsShared()) {
    return GUESTBOOK_ENDPOINT + '/shot?k=' + encodeURIComponent(entry.shotKey);
  }
  return null;
}

function guestbookBoard() {
  const local = readGuestbook();
  if (!guestbookIsShared()) return local.filter(matchesFilter);
  const shots = new Map(
      local.filter(entry => entry.shot).map(entry => [entry.id, entry.shot]));
  const shared = sharedEntries.map(
      entry => Object.assign({}, entry, {shot: shots.get(entry.id) || null}));
  const pending = local.filter(entry => !entry.sent && matchesFilter(entry))
      .map(entry => Object.assign({}, entry, {pending: true}));
  return pending.concat(shared);
}

function localTime(ms) {
  return new Date(ms).toLocaleString([], {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// One line naming the build, so a report is never just "the latest one".
function buildSummary(build) {
  if (!build) return 'No ROM loaded';
  const parts = [build.title || build.file, 'build ' + build.id];
  if (build.rev) parts.push('rev ' + build.rev);
  parts.push(build.modified ? 'built ' + localTime(build.modified) :
                              'build date unknown');
  if (BUILD_VERSION) parts.push('site v' + BUILD_VERSION);
  return parts.join(' · ');
}

function renderQuota() {
  if (!guestbookIsShared() || !sharedQuota) {
    gbQuotaEl.hidden = true;
    return;
  }
  gbQuotaEl.hidden = false;
  gbQuotaEl.textContent = sharedQuota.left > 0 ?
      sharedQuota.used + ' of ' + sharedQuota.cap +
          ' reports used today · resets 00:00 UTC' :
      'Full for today (' + sharedQuota.cap + ' reports) · resets 00:00 UTC — ' +
          'anything you write now is kept here and goes up after the reset';
  gbQuotaEl.classList.toggle('low', sharedQuota.left <= 20);
}

function renderBuildStamp() {
  gbBuildEl.textContent = buildSummary(currentBuild);
  gbFilterRomEl.disabled = !currentBuild;
}

// The canvas keeps its drawing buffer (preserveDrawingBuffer on the WebGL
// renderer), so this grabs whatever is on screen right now.
function captureScreenshot() {
  if (!emulator) return null;
  try {
    return $('#mainCanvas').toDataURL('image/png');
  } catch (e) {
    return null;
  }
}

function renderGuestbook() {
  const entries = guestbookBoard();
  renderQuota();
  gbMoreEl.hidden = !guestbookIsShared() || sharedDone;
  gbFiltersEl.hidden = !guestbookIsShared() && readGuestbook().length === 0;
  gbFilterRomEl.disabled = !currentBuild;
  gbListEl.textContent = '';
  for (const entry of entries) {
    const item = document.createElement('li');
    if (entry.pending) item.className = 'gb-pending';

    const meta = document.createElement('div');
    meta.className = 'gb-meta';
    meta.textContent = [
      localTime(entry.at),
      entry.kind,
      entry.who || 'anonymous',
      entry.rom + ' @ ' + entry.build,
    ].join(' · ') + (entry.pending ? ' · not posted yet' : '');
    item.appendChild(meta);

    const body = document.createElement('p');
    body.className = 'gb-body';
    body.textContent = entry.text;
    item.appendChild(body);

    const src = shotSrc(entry);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.loading = 'lazy';
      img.width = 160;
      img.height = 144;
      img.alt = 'Screen at the time of the report';
      // A screenshot can be missing where its report isn't — a trim in flight,
      // or a write that didn't fit the day's budget. Show the report anyway.
      img.addEventListener('error', () => img.remove());
      item.appendChild(img);
    }

    gbListEl.appendChild(item);
  }
}

async function addGuestbookEntry() {
  const text = gbTextEl.value.trim();
  if (!text) return;
  const now = Date.now();
  const entry = {
    id: now + '-' + Math.random().toString(36).slice(2, 8),
    at: now,
    who: gbWhoEl.value.trim(),
    kind: gbKindEl.value,
    text: text,
    rom: currentBuild ? currentBuild.file : 'no ROM',
    title: currentBuild ? currentBuild.title : '',
    build: currentBuild ? currentBuild.id : 'none',
    built: currentBuild ? currentBuild.modified : null,
    rev: currentBuild ? currentBuild.rev : null,
    site: BUILD_VERSION,
    ua: navigator.userAgent,
    shot: captureScreenshot(),
    sent: false,
  };
  // Always land it locally first, so a report is never lost to a failed post.
  writeGuestbook([entry].concat(readGuestbook()));
  renderGuestbook();
  gbTextEl.value = '';
  try {
    localStorage.setItem(STORAGE_PREFIX + ':reporter', entry.who);
  } catch (e) {
    // Remembering the name is a convenience; not worth reporting.
  }

  if (!guestbookIsShared()) {
    setGuestbookStatus('Logged at ' + localTime(now) + '.');
    return;
  }
  setGuestbookStatus('Posting…');
  try {
    const result = await postEntry(entry);
    markSent(entry.id);
    // The response carries the stored entry, so show that rather than spending
    // a list request re-reading the board. Board loads are the scarce call.
    if (result && result.entry && matchesFilter(result.entry)) {
      sharedEntries = [result.entry].concat(sharedEntries);
    }
    renderGuestbook();
    setGuestbookStatus(
        result && result.shotDropped ?
            'Posted at ' + localTime(now) +
                ' — the screenshot didn\'t fit today\'s budget, but it is kept ' +
                'here and comes along in Download.' :
            'Posted at ' + localTime(now) + '.');
  } catch (e) {
    renderGuestbook();
    setGuestbookStatus('Kept in this browser — could not post: ' + e.message +
                       '. It will go up next time the page loads.', true);
  }
}

function setGuestbookStatus(message, isError) {
  gbStatusEl.textContent = message || '';
  gbStatusEl.classList.toggle('error', !!isError);
}

function guestbookMarkdown() {
  const entries = guestbookBoard();
  const lines = [
    '# Bug guestbook — GBC Web Player',
    '',
    'Exported ' + new Date().toISOString() + ' — ' + entries.length +
        (entries.length === 1 ? ' entry' : ' entries'),
    '',
  ];
  entries.forEach((entry, i) => {
    lines.push('## ' + (i + 1) + '. ' + entry.kind + ' — ' + localTime(entry.at));
    lines.push('');
    lines.push('- When: ' + new Date(entry.at).toISOString());
    lines.push('- Who: ' + (entry.who || 'anonymous'));
    lines.push('- ROM: ' + entry.rom + (entry.title ? ' (' + entry.title + ')' : '') +
               (entry.rev ? ' rev ' + entry.rev : ''));
    lines.push('- Build: ' + entry.build +
               (entry.built ? ', built ' + new Date(entry.built).toISOString() :
                              ', build date unknown'));
    lines.push('- Site: v' + (entry.site || '?'));
    lines.push('- Browser: ' + entry.ua);
    const src = shotSrc(entry);
    if (src) {
      lines.push('- Screenshot: ' +
                 (entry.shotKey && guestbookIsShared() ? src :
                                                         'in the JSON download'));
    }
    lines.push('');
    lines.push(entry.text);
    lines.push('');
  });
  return lines.join('\n');
}

function downloadGuestbook() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([JSON.stringify(guestbookBoard(), null, 2)],
                        {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bug-guestbook-' + stamp + '.json';
  link.click();
  URL.revokeObjectURL(url);
}

function wireGuestbook() {
  try {
    gbWhoEl.value = localStorage.getItem(STORAGE_PREFIX + ':reporter') || '';
  } catch (e) {
    // No stored name; the field just starts empty.
  }

  gbFormEl.addEventListener('submit', event => {
    event.preventDefault();
    addGuestbookEntry();
  });

  // Ctrl/Cmd+Enter submits without reaching for the mouse.
  gbTextEl.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      addGuestbookEntry();
    }
  });

  $('#gb-copy').addEventListener('click', async () => {
    if (!guestbookBoard().length) {
      setGuestbookStatus('The guestbook is empty.');
      return;
    }
    try {
      await navigator.clipboard.writeText(guestbookMarkdown());
      setGuestbookStatus('Guestbook copied to the clipboard.');
    } catch (e) {
      setGuestbookStatus(
          'Could not copy: ' + e.message + ' — use Download instead.', true);
    }
  });

  $('#gb-download').addEventListener('click', () => {
    if (!guestbookBoard().length) {
      setGuestbookStatus('The guestbook is empty.');
      return;
    }
    downloadGuestbook();
  });

  $('#gb-clear').addEventListener('click', () => {
    const count = readGuestbook().length;
    if (!count) return;
    const warning = guestbookIsShared() ?
        'Clear this browser\'s copy of ' + count + ' entries, including their ' +
            'screenshots? Posts already on the shared board stay there.' :
        'Delete all ' + count + ' guestbook entries from this browser?';
    if (!confirm(warning)) return;
    writeGuestbook([]);
    renderGuestbook();
    setGuestbookStatus('This browser\'s copy was cleared.');
  });

  gbMoreEl.addEventListener('click', async event => {
    event.currentTarget.blur();
    gbMoreEl.disabled = true;
    setGuestbookStatus('Loading more…');
    await fetchSharedEntries(true);
    gbMoreEl.disabled = false;
    renderGuestbook();
    setGuestbookStatus(sharedError, !!sharedError);
  });

  const onFilterChange = async () => {
    guestbookFilter = {
      kind: gbFilterKindEl.value,
      rom: gbFilterRomEl.checked && currentBuild ? currentBuild.file : '',
    };
    sharedCursor = null;
    sharedDone = false;
    if (guestbookIsShared()) {
      setGuestbookStatus('Loading…');
      await fetchSharedEntries();
      setGuestbookStatus(sharedError, !!sharedError);
    }
    renderGuestbook();
  };
  gbFilterKindEl.addEventListener('change', onFilterChange);
  gbFilterRomEl.addEventListener('change', onFilterChange);
  gbMoreEl.textContent = 'Load ' + GUESTBOOK_PAGE + ' more';

  if (guestbookIsShared()) {
    gbNoteEl.textContent =
        'Posts go to a shared board everyone can read, and can\'t be edited or ' +
        'deleted once sent. Each is stamped with the date, the ROM\'s build id ' +
        'and build date, and the browser. Screenshots go up too — a Game Boy ' +
        'frame is only a few KB — up to 20 a day from one connection.';
  }

  renderBuildStamp();
  renderGuestbook();
  refreshGuestbook();
}

// On load: push anything that didn't make it up last time, then pull the board.
async function refreshGuestbook() {
  if (!guestbookIsShared()) return;
  setGuestbookStatus('Loading the guestbook…');
  await flushPending();
  await fetchSharedEntries();
  renderGuestbook();
  setGuestbookStatus(sharedError, !!sharedError);
}

(async function boot() {
  wireControls();
  wireGuestbook();

  const [manifest, discovered] =
      await Promise.all([loadManifest(), discoverRoms()]);
  const roms = mergeRomLists(manifest, discovered);
  for (const entry of roms) romManifest.set(entry.file, entry);
  for (const entry of roms) {
    const option = document.createElement('option');
    option.value = entry.file;
    option.textContent = entry.name || entry.file;
    romSelectEl.appendChild(option);
  }
  romSelectEl.hidden = roms.length === 0;

  const requested = new URLSearchParams(location.search).get('rom');
  const path = requested || (roms.length ? roms[0].file : null);
  if (path) {
    romSelectEl.value = roms.some(e => e.file === path) ? path : '';
    await loadRomFromUrl(path);
  } else {
    setStatus('No ROM yet — drop a .gb/.gbc file here, or add one to roms/.');
  }
})();



