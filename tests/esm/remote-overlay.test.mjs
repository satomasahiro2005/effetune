import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { encodeSpectrumFrame, spectrumLevels, RemoteOverlay, FRAME_BYTES } from '../../js/remote/remote-overlay.js';

const FFT_SIZE = 4096;

async function loadAnalyze() {
  const sandbox = { Float32Array, Map, Math, window: {} };
  vm.runInNewContext(await fs.readFile(new URL('../../plugins/frequency-axis.js', import.meta.url), 'utf8'), sandbox);
  vm.runInNewContext(await fs.readFile(new URL('../../plugins/spectrum-overlay.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.SpectrumOverlay.analyze;
}

function tone(frequency, gain = 0.5, sampleRate = 48000) {
  return Float32Array.from({ length: FFT_SIZE }, (_, i) =>
    gain * Math.sin(2 * Math.PI * frequency * i / sampleRate) + 1e-3 * Math.sin(i * 0.37));
}

test('frame layout is Spectrum Analyzer v1 with 2049 bins and peaks = current', () => {
  const buffer = tone(1000);
  const bytes = encodeSpectrumFrame(buffer, 123, 48000, 77, 5);
  assert.equal(bytes.length, 16420);
  assert.equal(FRAME_BYTES, 16420);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(0, true), 4);
  assert.equal(view.getUint16(2, true), 1);
  assert.equal(view.getUint32(4, true), 77);
  assert.equal(view.getUint32(8, true), 5);
  assert.equal(view.getUint16(12, true), 16404);
  assert.equal(view.getUint16(14, true), 0);
  assert.equal(view.getFloat32(16, true), 48000);
  assert.equal(view.getUint32(20, true), 2049);
  assert.equal(view.getUint16(24, true), 12);
  assert.equal(view.getUint16(26, true), 0);
  const current = new Float32Array(bytes.buffer, 28, 2049);
  const peaks = new Float32Array(bytes.buffer, 28 + 8196, 2049);
  assert.deepEqual([...peaks], [...current]);
  let peak = 1;
  for (let b = 2; b < 2049; b++) if (current[b] > current[peak]) peak = b;
  assert.ok(Math.abs(peak - Math.round(1000 * FFT_SIZE / 48000)) <= 1);
  // A 0.5 sine with a Hann window: about -6 dBFS at the peak (bin-centre scalloping < 1.5 dB).
  assert.ok(current[peak] < -5.9 && current[peak] > -7.6, String(current[peak]));
});

test('levels are the unsmoothed power of upstream analyze()', async () => {
  const analyze = await loadAnalyze();
  const buffer = tone(1234.5);
  // Broadband noise (deterministic) so most bins sit well above the comparison floor.
  let seed = 12345;
  for (let i = 0; i < FFT_SIZE; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    buffer[i] += 0.01 * Math.cos(i * 1.1) + 1e-3 * (seed / 2 ** 32 - 0.5);
  }
  for (const position of [0, 2048, 777]) {
    const smoothed = analyze(buffer, position, 48000);
    const levels = spectrumLevels(buffer, position);
    // Re-apply upstream's 1/12-octave average to our bins 0..2047. Far below the peak,
    // upstream's running sum loses precision to cancellation, so compare above -100 dB.
    const ratio = 2 ** (1 / 24);
    let compared = 0;
    for (let i = 1; i < 2048; i++) {
      if (!(smoothed[i] > -100)) continue;
      compared += 1;
      const first = Math.ceil(i / ratio);
      const end = Math.min(2048, Math.floor(i * ratio) + 1);
      let sum = 0;
      for (let b = first; b < end; b++) sum += 10 ** (levels[b] / 10);
      const db = 10 * Math.log10(sum / (end - first));
      assert.ok(Math.abs(db - smoothed[i]) < 1e-3, `pos ${position} bin ${i}: ${db} vs ${smoothed[i]}`);
    }
    assert.ok(compared > 1500, String(compared));
  }
  // Nyquist is real only, with the AC correction.
  const nyq = Float32Array.from({ length: FFT_SIZE }, (_, i) => (i & 1 ? -0.25 : 0.25));
  const levels = spectrumLevels(nyq, 0);
  assert.ok(levels[2048] > levels[1024] + 60);
  assert.ok(Math.abs(levels[2048] - 20 * Math.log10(0.25 * 0.5 * 4)) < 0.01, String(levels[2048]));
});

function fakeWorld() {
  const posts = [];
  const listeners = new Set();
  const node = {
    port: {
      postMessage(message) { posts.push(message); },
      addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
      removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); }
    }
  };
  class FiveBandPEQPlugin { constructor(id) { this.id = id; this.name = '5Band PEQ'; } }
  class FiveBandFIRPEQPlugin { constructor(id) { this.id = id; this.name = '5Band FIR PEQ'; } }
  class VolumePlugin { constructor(id) { this.id = id; this.name = 'Volume'; } }
  const win = {
    workletNode: node,
    audioManager: { pipeline: [new VolumePlugin(1), new FiveBandPEQPlugin(2), new FiveBandFIRPEQPlugin(3)] }
  };
  const emit = data => { for (const fn of listeners) fn({ data }); };
  return { win, node, posts, listeners, emit, FiveBandPEQPlugin, VolumePlugin };
}

function message(id, withInput = true) {
  const m = {
    type: 'remoteSpectrumOverlay', spectrumPluginId: id, outputBuffer: tone(500), bufferPosition: 0,
    sampleRate: 48000, mode: 'compare', quality: 'normal'
  };
  if (withInput) m.inputBuffer = tone(700);
  return m;
}

test('RemoteOverlay follows the PEQ stages by id and emits latest before/after per stage', () => {
  const w = fakeWorld();
  const overlay = new RemoteOverlay(w.win);
  assert.deepEqual(overlay.collect(), []);
  overlay.setEnabled(true);
  assert.deepEqual(overlay.collect(), []);
  assert.deepEqual(w.posts.at(-1), { type: 'setRemoteSpectrumTaps', pluginIds: [2, 3] });
  assert.equal(w.listeners.size, 1);

  w.emit(message(2));
  w.emit(message(2)); // latest only
  w.emit(message(3, false));
  w.emit(message(1)); // not a target
  w.emit({ type: 'spectrumOverlay', spectrumPluginId: 2, outputBuffer: tone(1) }); // the UI's own
  let frames = overlay.collect();
  assert.deepEqual(frames.map(f => [f.key, f.index, f.nm, f.type, f.role]), [
    ['ov:2:after', 1, '5Band PEQ', 4, 'after'],
    ['ov:2:before', 1, '5Band PEQ', 4, 'before'],
    ['ov:3:after', 2, '5Band FIR PEQ', 4, 'after']
  ]);
  assert.ok(frames.every(f => f.bytes.length === 16420));
  assert.equal(new DataView(frames[0].bytes.buffer).getUint32(8, true), 1);
  assert.deepEqual(overlay.collect(), [], 'nothing new, nothing sent');
  const postsBefore = w.posts.length;
  overlay.collect();
  assert.equal(w.posts.length, postsBefore, 'unchanged set is not reposted within a second');

  // Reorder: a stage in front moves the indices; the set is reposted when it changes.
  w.win.audioManager.pipeline.unshift(new w.VolumePlugin(9), new w.FiveBandPEQPlugin(8));
  w.emit(message(2));
  frames = overlay.collect();
  assert.deepEqual(w.posts.at(-1), { type: 'setRemoteSpectrumTaps', pluginIds: [2, 3, 8] });
  assert.deepEqual(frames.map(f => [f.index, f.role]), [[3, 'after'], [3, 'before']]);
  assert.equal(new DataView(frames[0].bytes.buffer).getUint32(8, true), 2, 'sequence per (plugin, role)');

  // A removed stage's pending frame is not sent.
  w.emit(message(3));
  w.win.audioManager.pipeline = w.win.audioManager.pipeline.filter(p => p.id !== 3);
  assert.deepEqual(overlay.collect(), []);

  // A new worklet node: rebind and repost.
  const oldListeners = w.listeners.size;
  const posts2 = [];
  const listeners2 = new Set();
  w.win.workletNode = { port: {
    postMessage(m) { posts2.push(m); },
    addEventListener(_, fn) { listeners2.add(fn); },
    removeEventListener(_, fn) { listeners2.delete(fn); }
  } };
  overlay.collect();
  assert.equal(w.listeners.size, oldListeners - 1);
  assert.equal(listeners2.size, 1);
  assert.deepEqual(posts2.at(-1), { type: 'setRemoteSpectrumTaps', pluginIds: [2, 8] });

  // Off: the taps are cleared on the bound node and the listener is removed.
  overlay.setEnabled(false);
  assert.deepEqual(posts2.at(-1), { type: 'setRemoteSpectrumTaps', pluginIds: [] });
  assert.equal(listeners2.size, 0);
  assert.deepEqual(overlay.collect(), []);
});
