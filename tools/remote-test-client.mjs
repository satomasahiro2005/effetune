// Test client for the PoC LAN remote control (remote-v1, with the v2 additions).
//   node tools/remote-test-client.mjs [host:port/token]
// Defaults to 127.0.0.1:47300 and EFFETUNE_REMOTE_TOKEN (or "poctoken").
// With REMOTE_TEST_CDP=<port> (the app's --remote-debugging-port) it also makes a
// change on the PC side and checks that IR Reverb really loads the uploaded IR.
// With REMOTE_TEST_INSPECT=<port> (the app's --inspect port) the analyzer mirror is
// also tested with the window hidden. REMOTE_TEST_ONLY=telemetry runs only that part.
// Prints every message (telemetry pushes are summarised) and exits 0 only if every
// check passed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connect, mainWindowSession, waitForTarget } from './remote-test-cdp.mjs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = process.argv[2] || `127.0.0.1:47300/${process.env.EFFETUNE_REMOTE_TOKEN || 'poctoken'}`;
const [hostPort, token] = arg.split('/');
const url = (t) => `ws://${hostPort}/?t=${encodeURIComponent(t)}`;
const cdpPort = Number(process.env.REMOTE_TEST_CDP) || 0;
const inspectPort = Number(process.env.REMOTE_TEST_INSPECT) || 0;
const onlyTelemetry = process.env.REMOTE_TEST_ONLY === 'telemetry';
const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.poc-logs');
const CHUNK = 512 * 1024;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' :: ' + detail : ''}`);
}
const ts = () => new Date().toISOString().slice(11, 23);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(t, label = 'A') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(t), { maxPayload: 16 * 1024 * 1024 });
    const inbox = [];
    const waiters = [];
    ws.inbox = inbox;
    ws.on('message', (data) => {
      const text = data.toString();
      if (!text.startsWith('{"op":"telemetry"')) console.log(`${ts()} ${label}<= ${text.length > 400 ? text.slice(0, 400) + '...(' + text.length + ' bytes)' : text}`);
      const msg = JSON.parse(text);
      inbox.push(msg);
      for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    });
    ws.waitFor = (match, ms = 8000) => {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((res, rej) => {
        const w = { match, resolve: (m) => { clearTimeout(timer); res(m); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for message')); }, ms);
        waiters.push(w);
      });
    };
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.closeInfo = new Promise((res) => ws.once('close', (code, reason) => res({ code, reason: reason.toString() })));
  });
}

let seq = 0;
// Sends a message, waits for its ack, and (if expectOp is given) for the data reply with the same seq.
async function call(ws, msg, expectOp = null, ms = 8000) {
  const n = ++seq;
  const out = { ...msg, seq: n };
  const text = JSON.stringify(out);
  console.log(`${ts()} => ${text.length > 400 ? text.slice(0, 400) + '...(' + text.length + ' bytes)' : text}`);
  ws.send(text);
  const ack = await ws.waitFor((m) => m.op === 'ack' && m.seq === n, ms);
  let data = null;
  if (expectOp && ack.ok) data = await ws.waitFor((m) => m.op === expectOp && m.seq === n, ms);
  return { ack, data, seq: n };
}

const stage = (state, i) => state.pipeline[i];

// ---- IR helpers ------------------------------------------------------------

// 16-bit PCM WAV with an impulse per channel plus one random sample so each run
// produces a new library id.
function makeWav({ channels, sampleRate = 48000, seconds }) {
  const frames = Math.round(sampleRate * seconds);
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let c = 0; c < channels; c++) {
    const frame = c * 7; // a slightly different impulse per channel
    buf.writeInt16LE(16000, 44 + (frame * channels + c) * 2);
    // short exponential tail so the analysis has something to measure
    for (let f = frame + 1; f < Math.min(frames, frame + 4800); f++) {
      const v = Math.round((Math.random() * 2 - 1) * 3000 * Math.exp(-(f - frame) / 900));
      buf.writeInt16LE(v, 44 + (f * channels + c) * 2);
    }
  }
  buf.writeInt16LE(crypto.randomInt(1, 30000), 44 + dataBytes - 2);
  return buf;
}

const irId = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);

async function putIR(ws, { id, name, ext, bytes }) {
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
  let last = null;
  for (let index = 0; index < total; index++) {
    const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
    last = await call(ws, {
      op: 'putIR', id, name, ext, index, total, bytes: bytes.length, data: part.toString('base64')
    }, null, 60000);
    if (!last.ack.ok) return { ...last, total, failedAt: index };
  }
  return { ...last, total };
}

async function getIR(ws, id) {
  const r = await call(ws, { op: 'getIR', id }, null, 60000);
  const chunks = ws.inbox.filter((m) => m.op === 'irChunk' && m.seq === r.seq).sort((a, b) => a.index - b.index);
  const data = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')));
  // The chunks must all arrive before the ack.
  const ackPos = ws.inbox.indexOf(r.ack);
  const lastChunkPos = Math.max(-1, ...chunks.map((c) => ws.inbox.indexOf(c)));
  return { ...r, chunks, data, chunksBeforeAck: lastChunkPos < ackPos };
}

async function cdpIrReverbStatus(session, id) {
  return session.evaluate(`(() => {
    const p = (window.audioManager?.pipeline || []).find(x => x.name === 'IR Reverb' && x.ir === ${JSON.stringify(id)});
    return p ? { status: p._statusState, missing: p._missingIr, label: p._irFileLabel, message: p._statusMessage } : null;
  })()`);
}

async function waitIrReady(session, id, ms = 20000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdpIrReverbStatus(session, id);
    if (last && last.status === 'ready' && last.missing === false) return { ok: true, last };
    if (last && last.status === 'error') return { ok: false, last };
    await sleep(300);
  }
  return { ok: false, last };
}

// ---- analyzer mirror ---------------------------------------------------------

const ANALYZERS = new Set(['Chroma Spiral', 'Level Meter', 'Note Spectrogram', 'Oscilloscope',
  'Pitch Meter', 'Spectrogram', 'Spectrum Analyzer', 'Stereo Meter']);

function decodeFrame(entry) {
  const bytes = Buffer.from(entry.data, 'base64');
  if (bytes.length < 16) return { ok: false, bytes };
  const header = {
    type: bytes.readUInt16LE(0), version: bytes.readUInt16LE(2), tapId: bytes.readUInt32LE(4),
    sequence: bytes.readUInt32LE(8), payloadBytes: bytes.readUInt16LE(12), flags: bytes.readUInt16LE(14)
  };
  return { ok: bytes.length === 16 + header.payloadBytes && header.type === entry.type, bytes, header };
}

// Collects the telemetry pushes that arrive on `ws` during the next `ms` milliseconds.
async function collectTelemetry(ws, ms) {
  const start = ws.inbox.length;
  const t0 = Date.now();
  await sleep(ms);
  const seconds = (Date.now() - t0) / 1000;
  const pushes = ws.inbox.slice(start).filter((m) => m.op === 'telemetry');
  const perStage = new Map();
  let malformed = 0;
  let maxFrames = 0;
  let maxRaw = 0;
  let maxJson = 0;
  let emptyPushes = 0;
  let duplicateKeys = 0;
  for (const push of pushes) {
    if (!Array.isArray(push.frames) || push.frames.length === 0) emptyPushes += 1;
    if (push.seq !== undefined) malformed += 1;
    maxFrames = Math.max(maxFrames, push.frames?.length || 0);
    maxJson = Math.max(maxJson, JSON.stringify(push).length);
    let raw = 0;
    const keys = new Set();
    for (const f of push.frames || []) {
      const d = decodeFrame(f);
      if (!d.ok) { malformed += 1; continue; }
      raw += d.bytes.length;
      const key = `${f.index}:${f.type}`;
      if (keys.has(key)) duplicateKeys += 1;
      keys.add(key);
      const s = perStage.get(key) || {
        index: f.index, nm: f.nm, type: f.type, version: d.header.version, frames: 0, raw: 0, b64: 0,
        payloadBytes: d.header.payloadBytes, sequences: new Set()
      };
      s.frames += 1;
      s.raw += d.bytes.length;
      s.b64 += f.data.length;
      s.sequences.add(d.header.sequence);
      perStage.set(key, s);
    }
    maxRaw = Math.max(maxRaw, raw);
  }
  return {
    seconds, pushes, rate: pushes.length / seconds, perStage, malformed, maxFrames, maxRaw, maxJson,
    emptyPushes, duplicateKeys
  };
}

const measurements = [];
function describeTelemetry(label, r) {
  const stages = [...r.perStage.values()].sort((a, b) => a.index - b.index).map((s) =>
    `#${s.index} ${s.nm} type ${s.type} v${s.version} payload ${s.payloadBytes} B: ` +
    `${(s.frames / r.seconds).toFixed(1)} frames/s, ${Math.round(s.raw / r.seconds)} raw B/s, ` +
    `${Math.round(s.b64 / r.seconds)} base64 B/s`);
  const line = `${label}: ${r.pushes.length} pushes in ${r.seconds.toFixed(2)} s (${r.rate.toFixed(1)}/s), ` +
    `max ${r.maxFrames} frames / ${r.maxRaw} raw B / ${r.maxJson} JSON B per push`;
  console.log('MEASURE ' + line);
  for (const s of stages) console.log('MEASURE   ' + s);
  measurements.push([line, ...stages.map((s) => '  ' + s)].join('\n'));
}

async function mainProcess() {
  if (!inspectPort) return null;
  const target = await waitForTarget(inspectPort, () => true);
  return connect(target.webSocketDebuggerUrl);
}

const stagesOf = (r) => [...r.perStage.values()];
const listStages = (r) => stagesOf(r).map((s) => `#${s.index} ${s.nm} type ${s.type}`).join(', ');

async function telemetryTests(ws, ws2, session) {
  // Signal: a quiet tone into the analyzers, then -60 dB so almost nothing reaches the speakers.
  // Compressor has its own (gain reduction) telemetry and must not be mirrored.
  const chain = [
    { nm: 'Oscillator', en: true, fr: 440, vl: -20 },
    { nm: 'Level Meter', en: true },
    { nm: 'Compressor', en: true },
    { nm: 'Spectrum Analyzer', en: true },
    { nm: 'Volume', en: true, vl: -60 }
  ];
  let { ack } = await call(ws, { op: 'chain', pipeline: chain });
  check('telemetry: chain Oscillator / Level Meter / Compressor / Spectrum Analyzer / Volume acked',
    ack.ok === true, JSON.stringify(ack));
  const { data } = await call(ws, { op: 'get' }, 'state');
  const names = data.pipeline.map((p) => p.nm);
  await sleep(1500); // let the new graph start

  ({ ack } = await call(ws, { op: 'telemetry', on: true, fps: 'fast' }));
  check('telemetry: non-numeric fps -> ok:false "invalid fps"', ack.ok === false && ack.error === 'invalid fps', ack.error);
  ({ ack } = await call(ws, { op: 'telemetry', fps: 15 }));
  check('telemetry: missing "on" -> ok:false', ack.ok === false, ack.error);
  const before = ws.inbox.filter((m) => m.op === 'telemetry').length;
  check('telemetry: nothing is pushed before subscribing', before === 0, String(before));

  ({ ack } = await call(ws, { op: 'telemetry', on: true, fps: 15 }));
  check('telemetry: subscribe at 15 fps acked', ack.ok === true, JSON.stringify(ack));
  await sleep(1000);
  let r = await collectTelemetry(ws, 5000);
  describeTelemetry('15 fps, window shown', r);
  const stageNames = stagesOf(r).map((s) => s.nm);
  check('telemetry: pushes arrive at about the requested rate (14..15.5/s at 15 fps)',
    r.rate >= 14 && r.rate <= 15.5, r.rate.toFixed(2));
  check('telemetry: frames only for Analyzer stages (Level Meter #1, Spectrum Analyzer #3; not Compressor)',
    r.perStage.size > 0 && stagesOf(r).every((s) => ANALYZERS.has(s.nm) && names[s.index] === s.nm) &&
    stageNames.includes('Level Meter') && stageNames.includes('Spectrum Analyzer'), listStages(r));
  check('telemetry: Level Meter frames are type 1 v1, Spectrum Analyzer type 4 v1',
    stagesOf(r).every((s) => (s.nm !== 'Level Meter' || (s.type === 1 && s.version === 1)) &&
      (s.nm !== 'Spectrum Analyzer' || (s.type === 4 && s.version === 1))), listStages(r));
  check('telemetry: every frame is 16 + payloadBytes with a matching header type; pushes carry no seq',
    r.malformed === 0, String(r.malformed));
  check('telemetry: no empty pushes; at most one frame per (stage, type) per push',
    r.emptyPushes === 0 && r.duplicateKeys === 0, `${r.emptyPushes} empty, ${r.duplicateKeys} duplicates`);
  check('telemetry: every push within the caps (64 frames, 1 MiB raw)',
    r.maxFrames <= 64 && r.maxRaw <= 1 << 20, `${r.maxFrames} frames, ${r.maxRaw} B`);
  check('telemetry: the unsubscribed client gets no pushes', !ws2.inbox.some((m) => m.op === 'telemetry'));
  {
    const level = stagesOf(r).find((s) => s.nm === 'Level Meter');
    check('telemetry: each push carries a new frame (distinct sequence numbers)',
      !!level && level.sequences.size >= level.frames * 0.9, level ? `${level.sequences.size}/${level.frames}` : 'none');
  }

  // A second client at a lower rate: each client keeps its own rate.
  ({ ack } = await call(ws2, { op: 'telemetry', on: true, fps: 5 }));
  check('telemetry: second client subscribes at 5 fps', ack.ok === true);
  await sleep(500);
  const [ra, rb] = await Promise.all([collectTelemetry(ws, 4000), collectTelemetry(ws2, 4000)]);
  describeTelemetry('client A at 15 fps while B is at 5 fps', ra);
  describeTelemetry('client B at 5 fps', rb);
  check('telemetry: two clients keep their own rates (A ~15/s, B ~5/s)',
    ra.rate >= 14 && ra.rate <= 15.5 && rb.rate >= 4 && rb.rate <= 5.5, `${ra.rate.toFixed(2)} / ${rb.rate.toFixed(2)}`);
  ({ ack } = await call(ws2, { op: 'telemetry', on: false }));
  check('telemetry: second client unsubscribes', ack.ok === true);

  // fps is clamped to 30.
  ({ ack } = await call(ws, { op: 'telemetry', on: true, fps: 100 }));
  check('telemetry: fps 100 acked (clamped)', ack.ok === true);
  await sleep(500);
  r = await collectTelemetry(ws, 4000);
  describeTelemetry('fps 100 (clamped to 30), window shown', r);
  check('telemetry: fps 100 is clamped to 30 (27..31/s)', r.rate >= 27 && r.rate <= 31, r.rate.toFixed(2));
  ({ ack } = await call(ws, { op: 'telemetry', on: true, fps: 15 }));

  // A chain edit moves the analyzers: the next pushes carry the new indices.
  const moved = [{ nm: 'Volume', en: true, vl: 0 }, ...chain];
  ({ ack } = await call(ws, { op: 'chain', pipeline: moved }));
  check('telemetry: chain with an extra stage in front acked', ack.ok === true);
  await sleep(1500);
  r = await collectTelemetry(ws, 2000);
  check('telemetry: after the edit the indices follow (Level Meter #2, Spectrum Analyzer #4)',
    stagesOf(r).some((s) => s.nm === 'Level Meter' && s.index === 2) &&
    stagesOf(r).some((s) => s.nm === 'Spectrum Analyzer' && s.index === 4) &&
    stagesOf(r).every((s) => moved[s.index]?.nm === s.nm), listStages(r));

  // Master bypass: the PC shows nothing and sends nothing.
  await call(ws, { op: 'bypass', on: true });
  await sleep(800);
  r = await collectTelemetry(ws, 2000);
  check('telemetry: no frames while master bypass is on', r.pushes.length === 0, `${r.pushes.length} pushes`);
  await call(ws, { op: 'bypass', on: false });
  await sleep(1000);
  r = await collectTelemetry(ws, 1500);
  check('telemetry: frames resume after bypass off', r.pushes.length > 0, `${r.pushes.length} pushes`);

  // Hidden window: both power gates are overridden while a client is subscribed.
  const main = await mainProcess();
  if (main && session) {
    const win = "process.mainModule.require('electron').BrowserWindow.getAllWindows()" +
      ".find(w => /effetune\\.html/.test(w.webContents.getURL()))";
    const gate = () => session.evaluate(`(() => { const c = window.audioManager.powerPolicyController;
      return { hidden: document.hidden, hostHidden: c.hostHidden, skip: c.settings.skipDisplayDspWhenHidden,
        bypassed: c.displayDspBypassed, uiEnabled: c.dspUiActivityAllowed,
        frames: window.dspTelemetryHub.getStats().frames }; })()`);
    for (const how of ['hide', 'minimize']) {
      const label = how === 'hide' ? 'hidden' : 'minimized';
      await main.evaluate(`(() => { ${win}.${how}(); return true; })()`);
      await sleep(1500);
      const g = await gate();
      r = await collectTelemetry(ws, 4000);
      describeTelemetry(`15 fps, window ${label}`, r);
      check(`telemetry: window ${label} (skip display DSP when hidden: ${g.skip}): pushes keep coming (>= 14/s, both analyzers)`,
        g.hostHidden === true && r.rate >= 14 && r.perStage.size >= 2, `${r.rate.toFixed(2)}/s, gate ${JSON.stringify(g)}`);
      if (how === 'hide') {
        // Baseline: unsubscribed, the hidden window stops producing analyzer frames.
        await call(ws, { op: 'telemetry', on: false });
        await sleep(1000);
        const a = await gate();
        await sleep(2000);
        const b = await gate();
        check('telemetry: hidden and unsubscribed, the PC stops producing analyzer frames again',
          b.frames - a.frames < 5 && b.uiEnabled === false, `${b.frames - a.frames} frames in 2 s, gate ${JSON.stringify(b)}`);
        await call(ws, { op: 'telemetry', on: true, fps: 15 });
        await sleep(1000);
        r = await collectTelemetry(ws, 2000);
        check('telemetry: subscribing while hidden brings the frames back', r.rate >= 12, r.rate.toFixed(2));
      }
      await main.evaluate(`(() => { const w = ${win}; w.restore(); w.show(); return true; })()`);
      await sleep(1500);
    }
    main.close();
  } else {
    console.log('NOTE: REMOTE_TEST_INSPECT not set; skipping the hidden-window checks');
  }

  // Unsubscribe: nothing more arrives, and the PC drops the demand.
  ({ ack } = await call(ws, { op: 'telemetry', on: false }));
  check('telemetry: unsubscribe acked', ack.ok === true);
  await sleep(300);
  r = await collectTelemetry(ws, 2000);
  check('telemetry: no pushes after on:false', r.pushes.length === 0, `${r.pushes.length} pushes`);
  if (session) {
    const demand = await session.evaluate(`({ demand: window.audioManager.remoteTelemetryDemand,
      policy: window.audioManager.powerPolicyController.remoteTelemetryDemand,
      listener: window.dspTelemetryHub.mirrorListener !== null })`);
    check('telemetry: the PC released the demand and the hub listener after on:false',
      demand.demand === false && demand.policy === false && demand.listener === false, JSON.stringify(demand));
  }

  // Closing a subscribed socket also releases the demand.
  const ws3 = await open(token, 'C');
  await call(ws3, { op: 'hello', v: 1 }, 'state');
  ({ ack } = await call(ws3, { op: 'telemetry', on: true }));
  check('telemetry: subscribe without fps acked', ack.ok === true);
  await sleep(500);
  r = await collectTelemetry(ws3, 3000);
  check('telemetry: default fps is 15 (14..15.5/s)', r.rate >= 14 && r.rate <= 15.5, r.rate.toFixed(2));
  if (session) {
    const on = await session.evaluate('window.audioManager.remoteTelemetryDemand');
    check('telemetry: demand is on while the third client is subscribed', on === true, String(on));
  }
  ws3.close();
  await sleep(800);
  if (session) {
    const demand = await session.evaluate('window.audioManager.remoteTelemetryDemand');
    check('telemetry: closing the subscribed socket releases the demand', demand === false, String(demand));
  }
  try {
    fs.writeFileSync(path.join(logDir, 'telemetry-measure.log'), measurements.join('\n') + '\n');
  } catch (_) { /* optional */ }
}

async function main() {
  if (onlyTelemetry) {
    const ws = await open(token, 'A');
    const hello = await call(ws, { op: 'hello', v: 1 }, 'state');
    check('hello state lists the telemetry feature', !!hello.data?.features?.includes('telemetry'),
      JSON.stringify(hello.data?.features));
    const ws2 = await open(token, 'B');
    await call(ws2, { op: 'hello', v: 1 }, 'state');
    const session = cdpPort ? await mainWindowSession(cdpPort) : null;
    await telemetryTests(ws, ws2, session);
    session?.close();
    ws2.close();
    ws.close();
    return;
  }
  // 1. wrong token must be closed with 4401.
  {
    const bad = await open('definitely-wrong', 'X');
    const info = await Promise.race([bad.closeInfo, new Promise((r) => setTimeout(() => r({ code: 'no-close' }), 5000))]);
    check('wrong token closed with 4401', info.code === 4401, JSON.stringify(info));
  }
  {
    const none = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${hostPort}/`);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve('error'));
      setTimeout(() => resolve('no-close'), 5000);
    });
    check('missing token closed with 4401', none === 4401, String(none));
  }

  // 2. good connection + hello.
  const ws = await open(token, 'A');
  check('connected with token', ws.readyState === WebSocket.OPEN);

  let { ack, data } = await call(ws, { op: 'hello', app: 'EffectDeck', v: 1 }, 'state');
  check('hello acked', ack.ok === true);
  check('hello returned state (app 2.11.0)', data && data.op === 'state' && data.app === '2.11.0' &&
    Array.isArray(data.pipeline) && typeof data.rev === 'number' && typeof data.masterBypass === 'boolean');
  check('hello state carries origin and features', data && data.origin === 'remote' &&
    Array.isArray(data.features) && ['origin', 'savePreset', 'irSync', 'telemetry'].every((f) => data.features.includes(f)),
    JSON.stringify({ origin: data?.origin, features: data?.features }));
  const initialRev = data.rev;

  ({ ack, data } = await call(ws, { op: 'hello', app: 'EffectDeck', v: 99 }));
  check('hello with unsupported version rejected', ack.ok === false, ack.error);

  // A second client, to see how other clients receive the pushes.
  const ws2 = await open(token, 'B');
  await call(ws2, { op: 'hello', v: 1 }, 'state');

  // 3. replace the whole chain (quiet Volume first).
  const chain = [
    { nm: 'Volume', en: true, vl: -30 },
    { nm: '5Band PEQ', en: true },
    { nm: 'Level Meter', en: true }
  ];
  let chainCall;
  ({ ack, seq: chainCall } = await call(ws, { op: 'chain', pipeline: chain }));
  check('chain acked ok', ack.ok === true, JSON.stringify(ack));
  {
    const isChain = (m) => m.op === 'state' && m.pipeline.length === 3 && m.pipeline[0].vl === -30;
    const own = await ws.waitFor((m) => isChain(m) && m.seq === chainCall).catch(() => null);
    check('chain: sender gets pushed state with origin "remote" and its seq', !!own && own.origin === 'remote',
      own ? JSON.stringify({ origin: own.origin, seq: own.seq, rev: own.rev }) : 'no push');
    const other = await ws2.waitFor((m) => isChain(m) && m.rev === own?.rev).catch(() => null);
    check('chain: other client gets the same push with origin "remote" and no seq',
      !!other && other.origin === 'remote' && other.seq === undefined,
      other ? JSON.stringify({ origin: other.origin, seq: other.seq, rev: other.rev }) : 'no push');
  }
  ({ data } = await call(ws, { op: 'get' }, 'state'));
  check('state has 3 stages in order Volume / 5Band PEQ / Level Meter',
    data.pipeline.length === 3 &&
    data.pipeline[0].nm === 'Volume' && data.pipeline[1].nm === '5Band PEQ' && data.pipeline[2].nm === 'Level Meter',
    data.pipeline.map((p) => p.nm).join(','));
  check('Volume vl == -30 after chain', stage(data, 0).vl === -30, String(stage(data, 0).vl));
  check('rev advanced after chain', data.rev > initialRev, `${initialRev} -> ${data.rev}`);
  check('5Band PEQ carries band data (g0..g4)', stage(data, 1).g0 === 0 && stage(data, 1).f4 === 10000,
    JSON.stringify(stage(data, 1)).slice(0, 120));

  // 4. params on stage 0 + a pushed state.
  const revBefore = data.rev;
  let paramsSeq;
  ({ ack, seq: paramsSeq } = await call(ws, { op: 'params', index: 0, params: { vl: -33 } }));
  check('params acked ok', ack.ok === true, JSON.stringify(ack));
  const pushed = await ws.waitFor((m) => m.op === 'state' && m.rev > revBefore && m.seq === paramsSeq &&
    m.pipeline[0] && m.pipeline[0].vl === -33).catch(() => null);
  check('server pushed state with vl == -33, origin "remote", seq of the params call', !!pushed && pushed.origin === 'remote',
    pushed ? `origin=${pushed.origin} seq=${pushed.seq}` : 'no push');
  ({ data } = await call(ws, { op: 'get' }, 'state'));
  check('Volume vl == -33 after params', stage(data, 0).vl === -33, String(stage(data, 0).vl));

  ({ ack } = await call(ws, { op: 'params', index: 9, params: { vl: 0 } }));
  check('params out of range -> ok:false', ack.ok === false, ack.error);

  // params on the PEQ: flat short keys (band 0 gain "g0"), other keys untouched.
  ({ ack } = await call(ws, { op: 'params', index: 1, params: { g0: 3 } }));
  check('params (5Band PEQ g0) acked ok', ack.ok === true, JSON.stringify(ack));
  ({ data } = await call(ws, { op: 'get' }, 'state'));
  check('PEQ band 0 gain applied, other bands untouched', stage(data, 1).g0 === 3 && stage(data, 1).g1 === 0,
    `g0=${stage(data, 1).g0} g1=${stage(data, 1).g1}`);

  // 5. unknown effect -> error, pipeline unchanged.
  const before = JSON.stringify((await call(ws, { op: 'get' }, 'state')).data.pipeline);
  ({ ack } = await call(ws, { op: 'chain', pipeline: [{ nm: 'Volume', en: true }, { nm: 'No Such Effect', en: true }] }));
  check('chain with unknown nm -> ok:false', ack.ok === false, ack.error);
  const after = JSON.stringify((await call(ws, { op: 'get' }, 'state')).data.pipeline);
  check('pipeline unchanged after rejected chain', before === after);

  // 6. master bypass, and that it survives a chain replace.
  ({ ack } = await call(ws, { op: 'bypass', on: true }));
  check('bypass on acked', ack.ok === true);
  ({ data } = await call(ws, { op: 'get' }, 'state'));
  check('masterBypass true', data.masterBypass === true);
  ({ ack } = await call(ws, { op: 'chain', pipeline: chain }));
  check('chain while bypassed acked', ack.ok === true, JSON.stringify(ack));
  ({ data } = await call(ws, { op: 'get' }, 'state'));
  check('masterBypass preserved across chain replace', data.masterBypass === true && data.pipeline.length === 3,
    `bypass=${data.masterBypass} stages=${data.pipeline.length}`);
  ({ ack } = await call(ws, { op: 'bypass', on: false }));
  ({ data } = await call(ws, { op: 'get' }, 'state'));
  check('masterBypass false again', data.masterBypass === false);

  // 7. a change made on the PC itself -> origin "local".
  let session = null;
  if (cdpPort) {
    session = await mainWindowSession(cdpPort);
    await sleep(600); // leave the 300 ms attribution window of the last command
    const revLocal = data.rev;
    await session.evaluate(`window.pipelineManager.presetManager.loadPreset({ name: 'Local test', plugins: [{ nm: 'Volume', en: true, vl: -31 }] })`);
    const isLocal = (m) => m.op === 'state' && m.rev > revLocal && m.pipeline.length === 1 && m.pipeline[0].vl === -31;
    const localA = await ws.waitFor(isLocal).catch(() => null);
    const localB = await ws2.waitFor(isLocal).catch(() => null);
    check('PC-side preset load pushes origin "local" without seq (both clients)',
      !!localA && !!localB && localA.origin === 'local' && localA.seq === undefined &&
      localB.origin === 'local' && localB.seq === undefined,
      JSON.stringify({ a: localA && { origin: localA.origin, seq: localA.seq }, b: localB && { origin: localB.origin, seq: localB.seq } }));
  } else {
    console.log('NOTE: REMOTE_TEST_CDP not set; skipping the PC-side (local origin) check');
  }

  // 8. presets.
  let names;
  ({ ack, data } = await call(ws, { op: 'listPresets' }, 'presets'));
  names = data && data.names;
  check('listPresets returned names array', ack.ok === true && Array.isArray(names), JSON.stringify(names));
  if (Array.isArray(names) && names.length > 0) {
    for (const name of names) {
      ({ ack, data } = await call(ws, { op: 'getPreset', name }, 'preset'));
      const okShape = ack.ok && data && data.name === name && Array.isArray(data.pipeline) &&
        data.pipeline.every((p) => typeof p.nm === 'string' && 'en' in p);
      check(`getPreset "${name}" returns short items`, !!okShape, JSON.stringify(data).slice(0, 200));
    }
  } else {
    console.log('NOTE: no presets exist; skipping getPreset');
  }
  ({ ack } = await call(ws, { op: 'getPreset', name: 'no such preset' }));
  check('getPreset unknown -> ok:false', ack.ok === false, ack.error);

  // 9. savePreset.
  const presetName = `Remote Saved ${crypto.randomInt(1000, 9999)}`;
  const presetPipeline = [{ nm: 'Volume', en: true, vl: -12 }, { nm: 'Level Meter', en: false }];
  ({ ack } = await call(ws, { op: 'savePreset', name: presetName, pipeline: presetPipeline }));
  check('savePreset acked ok', ack.ok === true, JSON.stringify(ack));
  ({ data } = await call(ws, { op: 'listPresets' }, 'presets'));
  check('listPresets contains the saved preset', data?.names?.includes(presetName), JSON.stringify(data?.names));
  ({ ack, data } = await call(ws, { op: 'getPreset', name: presetName }, 'preset'));
  check('getPreset returns the saved pipeline', ack.ok && JSON.stringify(data.pipeline) === JSON.stringify(presetPipeline),
    JSON.stringify(data?.pipeline));
  ({ ack } = await call(ws, { op: 'savePreset', name: presetName, pipeline: [{ nm: 'Volume', en: true, vl: -13 }] }));
  ({ data } = await call(ws, { op: 'getPreset', name: presetName }, 'preset'));
  check('savePreset overwrites an existing preset', ack.ok && data?.pipeline?.length === 1 && data.pipeline[0].vl === -13,
    JSON.stringify(data?.pipeline));
  ({ ack } = await call(ws, { op: 'savePreset', name: 'Bad', pipeline: [{ nm: 'No Such Effect', en: true }] }));
  check('savePreset with unknown nm -> ok:false', ack.ok === false, ack.error);
  ({ data } = await call(ws, { op: 'listPresets' }, 'presets'));
  check('rejected savePreset stored nothing', !data?.names?.includes('Bad'));
  ({ ack } = await call(ws, { op: 'savePreset', name: '  ', pipeline: [] }));
  check('savePreset with empty name -> ok:false', ack.ok === false, ack.error);

  // 10. IR library.
  const small = makeWav({ channels: 2, seconds: 0.1 });
  const large = makeWav({ channels: 2, seconds: 12 }); // ~2.3 MB -> 5 chunks
  const quad = makeWav({ channels: 4, seconds: 0.5 });  // 4-channel (true-stereo / BRIR-like layout)
  const irs = [
    { label: 'small stereo', id: irId(small), name: 'remote-test-small.wav', ext: 'wav', bytes: small },
    { label: 'large stereo', id: irId(large), name: 'remote-test-large', ext: 'wav', bytes: large },
    { label: '4-channel', id: irId(quad), name: 'remote-test-4ch.wav', ext: 'wav', bytes: quad }
  ];
  for (const ir of irs) {
    const r = await putIR(ws, ir);
    check(`putIR ${ir.label} (${ir.bytes.length} bytes, ${r.total} chunk${r.total > 1 ? 's' : ''}) acked ok`,
      r.ack.ok === true, JSON.stringify(r.ack));
  }
  ({ ack, data } = await call(ws, { op: 'listIRs' }, 'irs'));
  check('listIRs acked with items array', ack.ok === true && Array.isArray(data?.items), `${data?.items?.length} items`);
  for (const ir of irs) {
    const item = data?.items?.find((i) => i.id === ir.id);
    const expectedName = ir.name.endsWith('.wav') ? ir.name : `${ir.name}.wav`;
    check(`listIRs contains ${ir.label} with name/bytes/ext`,
      !!item && item.name === expectedName && item.bytes === ir.bytes.length && item.ext === 'wav',
      JSON.stringify(item));
  }
  const quadItem = data?.items?.find((i) => i.id === irs[2].id);
  check('4-channel IR is registered with channels == 4', quadItem?.channels === 4, JSON.stringify(quadItem));
  for (const ir of irs) {
    const r = await getIR(ws, ir.id);
    const expectTotal = Math.max(1, Math.ceil(ir.bytes.length / CHUNK));
    check(`getIR ${ir.label} returns identical bytes in ${expectTotal} chunk(s) before the ack`,
      r.ack.ok === true && r.chunks.length === expectTotal && r.chunks.every((c, i) => c.index === i && c.total === expectTotal) &&
      r.data.equals(ir.bytes) && r.chunksBeforeAck,
      `ok=${r.ack.ok} chunks=${r.chunks.length} bytes=${r.data.length} equal=${r.data.equals(ir.bytes)} beforeAck=${r.chunksBeforeAck}`);
  }
  {
    const again = await putIR(ws, irs[0]);
    ({ data } = await call(ws, { op: 'listIRs' }, 'irs'));
    check('re-uploading an IR already in the library succeeds without a duplicate entry',
      again.ack.ok === true && data.items.filter((i) => i.id === irs[0].id).length === 1, JSON.stringify(again.ack));
  }
  ({ ack } = await call(ws, { op: 'getIR', id: '0123456789abcdef01234567' }));
  check('getIR unknown id -> ok:false', ack.ok === false, ack.error);
  {
    const bogus = makeWav({ channels: 1, seconds: 0.05 });
    const r = await putIR(ws, { id: 'ffffffffffffffffffffffff', name: 'wrong.wav', ext: 'wav', bytes: bogus });
    check('putIR with wrong id -> ok:false (id mismatch)', r.ack.ok === false && /mismatch/.test(r.ack.error), r.ack.error);
    ({ data } = await call(ws, { op: 'listIRs' }, 'irs'));
    check('mismatched upload was not imported', !data.items.some((i) => i.id === irId(bogus)));
    ({ ack } = await call(ws, {
      op: 'putIR', id: irId(bogus), name: 'x.wav', ext: 'wav', index: 1, total: 2, bytes: bogus.length, data: ''
    }));
    check('putIR chunk without index 0 -> ok:false', ack.ok === false, ack.error);
  }

  // 11. a chain that uses IR Reverb with an uploaded IR.
  for (const [label, ir, extra] of [['stereo', irs[0], {}], ['4-channel', irs[2], {}]]) {
    const irChain = [{ nm: 'Volume', en: true, vl: -30 }, { nm: 'IR Reverb', en: true, ir: ir.id, ...extra }];
    ({ ack } = await call(ws, { op: 'chain', pipeline: irChain }));
    check(`chain with IR Reverb (${label} IR) acked ok`, ack.ok === true, JSON.stringify(ack));
    ({ data } = await call(ws, { op: 'get' }, 'state'));
    check(`state shows IR Reverb referencing the ${label} IR id`, stage(data, 1)?.nm === 'IR Reverb' && stage(data, 1)?.ir === ir.id,
      JSON.stringify(stage(data, 1)).slice(0, 200));
    if (session) {
      const r = await waitIrReady(session, ir.id);
      check(`IR Reverb loaded the ${label} IR (status ready, not missing)`, r.ok, JSON.stringify(r.last));
    }
  }

  // 12. analyzer mirror.
  await telemetryTests(ws, ws2, session);

  session?.close();
  ws2.close();
  ws.close();
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.log('ERROR:', error && error.stack || error);
  check('no exception', false, String(error));
}
const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join('; ')); exitCode = 1; }
console.log(exitCode === 0 ? 'VERIFIED: yes' : 'VERIFIED: no');
process.exit(exitCode);
