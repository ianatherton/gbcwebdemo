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

const controllerEl = $('#controller');
const dpadEl = $('#controller_dpad');
const selectEl = $('#controller_select');
const startEl = $('#controller_start');
const bEl = $('#controller_b');
const aEl = $('#controller_a');

const binjgbPromise = Binjgb();

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

    if (Math.abs(x) > OSGP_DEADZONE) {
      if (y > x && y < -x) {
        this.setJoypLeft(true);
        this.setJoypRight(false);
      } else if (y < x && y > -x) {
        this.setJoypLeft(false);
        this.setJoypRight(true);
      }
    } else {
      this.setJoypLeft(false);
      this.setJoypRight(false);
    }

    if (Math.abs(y) > OSGP_DEADZONE) {
      if (x > y && x < -y) {
        this.setJoypUp(true);
        this.setJoypDown(false);
      } else if (x < y && x > -y) {
        this.setJoypUp(false);
        this.setJoypDown(true);
      }
    } else {
      this.setJoypUp(false);
      this.setJoypDown(false);
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
    if (this.startSec >= nowSec) {
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
      const bufferSec = AUDIO_FRAMES / this.sampleRate;
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

Audio.ctx = new AudioContext;

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

const MANIFEST_URL = 'roms/roms.json';
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
let currentRom = null;     // {buffer, key, label}

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
  return !!(target && target.closest && target.closest('button, select, input, a'));
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
    headerOk: logoOk && checksum === bytes[0x14d],
  };
}

async function startRom(buffer, key, label) {
  const module = await binjgbPromise;
  romKey = key;
  currentRom = {buffer, key, label};
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
    response = await fetch(path);
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
  await startRom(buffer, path, path.split('/').pop());
}

async function loadRomFromFile(file) {
  const problem = romProblem(file.size, file.name);
  if (problem) {
    setStatus(problem, true);
    return;
  }
  romSelectEl.value = '';
  await startRom(await file.arrayBuffer(), 'file:' + file.name, file.name);
}

async function loadManifest() {
  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) return [];
    const entries = await response.json();
    return Array.isArray(entries) ? entries.filter(e => e && e.file) : [];
  } catch (e) {
    return [];  // No manifest is fine; the file picker still works.
  }
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
    startRom(currentRom.buffer, currentRom.key, currentRom.label);
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

(async function boot() {
  wireControls();

  const manifest = await loadManifest();
  for (const entry of manifest) {
    const option = document.createElement('option');
    option.value = entry.file;
    option.textContent = entry.name || entry.file;
    romSelectEl.appendChild(option);
  }
  romSelectEl.hidden = manifest.length === 0;

  const requested = new URLSearchParams(location.search).get('rom');
  const path = requested || (manifest.length ? manifest[0].file : null);
  if (path) {
    romSelectEl.value = manifest.some(e => e.file === path) ? path : '';
    await loadRomFromUrl(path);
  } else {
    setStatus('No ROM yet — drop a .gb/.gbc file here, or add one to roms/.');
  }
})();

