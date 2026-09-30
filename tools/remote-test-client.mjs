// Test client for the PoC LAN remote control (remote-v1, with the v2 additions).
//   node tools/remote-test-client.mjs [host:port/token]
// Defaults to 127.0.0.1:47300 and EFFETUNE_REMOTE_TOKEN (or "poctoken").
// With REMOTE_TEST_CDP=<port> (the app's --remote-debugging-port) it also makes a
// change on the PC side and checks that IR Reverb really loads the uploaded IR.
// Prints every message and exits 0 only if every check passed.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mainWindowSession } from './remote-test-cdp.mjs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = process.argv[2] || `127.0.0.1:47300/${process.env.EFFETUNE_REMOTE_TOKEN || 'poctoken'}`;
const [hostPort, token] = arg.split('/');
const url = (t) => `ws://${hostPort}/?t=${encodeURIComponent(t)}`;
const cdpPort = Number(process.env.REMOTE_TEST_CDP) || 0;
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
      console.log(`${ts()} ${label}<= ${text.length > 400 ? text.slice(0, 400) + '...(' + text.length + ' bytes)' : text}`);
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

async function main() {
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
    Array.isArray(data.features) && ['origin', 'savePreset', 'irSync'].every((f) => data.features.includes(f)),
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
