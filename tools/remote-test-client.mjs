// Test client for the PoC LAN remote control (remote-v1).
//   node tools/remote-test-client.mjs [host:port/token]
// Defaults to 127.0.0.1:47300 and EFFETUNE_REMOTE_TOKEN (or "poctoken").
// Prints every message and exits 0 only if every check passed.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = process.argv[2] || `127.0.0.1:47300/${process.env.EFFETUNE_REMOTE_TOKEN || 'poctoken'}`;
const [hostPort, token] = arg.split('/');
const url = (t) => `ws://${hostPort}/?t=${encodeURIComponent(t)}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' :: ' + detail : ''}`);
}
const ts = () => new Date().toISOString().slice(11, 23);

function open(t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(t));
    const inbox = [];
    const waiters = [];
    ws.inbox = inbox;
    ws.on('message', (data) => {
      const text = data.toString();
      console.log(`${ts()} <= ${text.length > 600 ? text.slice(0, 600) + '...(' + text.length + ' bytes)' : text}`);
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
async function call(ws, msg, expectOp = null) {
  const n = ++seq;
  const out = { ...msg, seq: n };
  console.log(`${ts()} => ${JSON.stringify(out).slice(0, 600)}`);
  ws.send(JSON.stringify(out));
  const ack = await ws.waitFor((m) => m.op === 'ack' && m.seq === n);
  let data = null;
  if (expectOp && ack.ok) data = await ws.waitFor((m) => m.op === expectOp && m.seq === n);
  return { ack, data };
}

const stage = (state, i) => state.pipeline[i];

async function main() {
  // 1. wrong token must be closed with 4401.
  {
    const bad = await open('definitely-wrong');
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
  const ws = await open(token);
  check('connected with token', ws.readyState === WebSocket.OPEN);

  let { ack, data } = await call(ws, { op: 'hello', app: 'EffectDeck', v: 1 }, 'state');
  check('hello acked', ack.ok === true);
  check('hello returned state (app 2.11.0)', data && data.op === 'state' && data.app === '2.11.0' &&
    Array.isArray(data.pipeline) && typeof data.rev === 'number' && typeof data.masterBypass === 'boolean');
  const initialRev = data.rev;

  ({ ack, data } = await call(ws, { op: 'hello', app: 'EffectDeck', v: 99 }));
  check('hello with unsupported version rejected', ack.ok === false, ack.error);

  // 3. replace the whole chain (quiet Volume first).
  const chain = [
    { nm: 'Volume', en: true, vl: -30 },
    { nm: '5Band PEQ', en: true },
    { nm: 'Level Meter', en: true }
  ];
  ({ ack } = await call(ws, { op: 'chain', pipeline: chain }));
  check('chain acked ok', ack.ok === true, JSON.stringify(ack));
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
  ({ ack } = await call(ws, { op: 'params', index: 0, params: { vl: -33 } }));
  check('params acked ok', ack.ok === true, JSON.stringify(ack));
  const pushed = await ws.waitFor((m) => m.op === 'state' && m.rev > revBefore && m.seq === undefined &&
    m.pipeline[0] && m.pipeline[0].vl === -33).catch(() => null);
  check('server pushed state with vl == -33 (throttled push)', !!pushed);
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

  // 7. presets.
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
