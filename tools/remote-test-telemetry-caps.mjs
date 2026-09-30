// Unit check of the analyzer-mirror push logic in electron/remote-control-host.cjs
// (caps, latest-only, carry-over order, backpressure), with fake sockets. No Electron.
//   node tools/remote-test-telemetry-caps.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RemoteControlHost } = require('../electron/remote-control-host.cjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' :: ' + detail : ''}`);
}

const sent = [];
const controls = [];
const fakeWindow = {
  isDestroyed: () => false,
  getTitle: () => 'EffeTune',
  setTitle: () => {},
  webContents: { send: (channel, payload) => { sent.push({ channel, payload }); if (/telemetry-control/.test(channel)) controls.push(payload); } }
};
const host = new RemoteControlHost({
  app: { getVersion: () => 'test' },
  getMainWindow: () => fakeWindow,
  config: null,
  env: { EFFETUNE_REMOTE_TOKEN: 'captest' },
  argv: [],
  log: () => {}
});
host.rendererReady = true;

function fakeSocket() {
  return {
    authenticated: true,
    readyState: 1,
    bufferedAmount: 0,
    out: [],
    times: [],
    send(text) { this.out.push(JSON.parse(text)); this.times.push(Date.now()); },
    telemetry: null
  };
}
const clients = new Set();
host.wss = { clients };
host.connectString = '127.0.0.1:1/captest';

function frame(index, type, payloadBytes, sequence) {
  const bytes = new Uint8Array(16 + payloadBytes);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, 1000 + index, true);
  view.setUint32(8, sequence, true);
  view.setUint16(12, payloadBytes, true);
  return { key: `${1000 + index}:${type}`, index, nm: `Stage ${index}`, type, bytes };
}

const a = fakeSocket();
clients.add(a);
host.onTelemetry(a, { op: 'telemetry', on: true, fps: 1 }, 1);
check('subscribe acked', a.out.at(-1)?.op === 'ack' && a.out.at(-1).ok === true);
check('demand sent to the renderer: on at 1 fps', controls.at(-1)?.on === true && controls.at(-1).fps === 1, JSON.stringify(controls.at(-1)));
host.onTelemetry(a, { op: 'telemetry', on: true, fps: 'x' }, 2);
check('invalid fps rejected', a.out.at(-1)?.ok === false && a.out.at(-1).error === 'invalid fps');
host.onTelemetry(a, { op: 'telemetry', on: true, fps: 1000 }, 3);
check('fps clamped to 30', a.telemetry?.fps === 30 && controls.at(-1)?.fps === 30, String(a.telemetry?.fps));
// Flush by hand below: switch the rate-limited automatic push off.
const pump = host.pumpTelemetry;
host.pumpTelemetry = () => {};
a.out.length = 0;

// 1) latest only: two batches for the same key, one push with the newer one.
host.handleRendererTelemetry([frame(0, 1, 32, 1)]);
host.handleRendererTelemetry([frame(0, 1, 32, 2)]);
host.flushTelemetry(a);
{
  const push = a.out.at(-1);
  const seqs = push.frames.map((f) => Buffer.from(f.data, 'base64').readUInt32LE(8));
  check('latest only: one frame, the newer sequence', push.frames.length === 1 && seqs[0] === 2, JSON.stringify(seqs));
  check('data is exactly 16 + payloadBytes', Buffer.from(push.frames[0].data, 'base64').length === 48);
}
host.flushTelemetry(a);
check('nothing pending: no push (never an empty frames array)', a.out.length === 1, String(a.out.length));

// 2) frame-count cap: 100 stages -> 64, then the 36 left over.
a.out.length = 0;
host.handleRendererTelemetry(Array.from({ length: 100 }, (_, i) => frame(i, 1, 16, 10)));
host.flushTelemetry(a);
check('at most 64 frames per push, lowest indices first',
  a.out[0].frames.length === 64 && a.out[0].frames[0].index === 0 && a.out[0].frames[63].index === 63,
  `${a.out[0].frames.length}`);
// Before the next tick, new frames arrive for low indices too: the carried-over ones still go first.
host.handleRendererTelemetry(Array.from({ length: 100 }, (_, i) => frame(i, 1, 16, 11)));
host.flushTelemetry(a);
check('left-over entries go first on the next push (indices 64..99, then 0..27)',
  a.out[1].frames.length === 64 && a.out[1].frames[0].index === 64 && a.out[1].frames[35].index === 99 &&
  a.out[1].frames[36].index === 0,
  a.out[1].frames.slice(0, 3).map((f) => f.index).concat(a.out[1].frames.slice(35, 38).map((f) => f.index)).join(','));
{
  const seqs = new Set(a.out[1].frames.map((f) => Buffer.from(f.data, 'base64').readUInt32LE(8)));
  check('left-over entries were overwritten by the newer frames (latest only)', seqs.size === 1 && seqs.has(11), [...seqs].join(','));
}
host.flushTelemetry(a);
host.flushTelemetry(a);
a.out.length = 0;

// 3) raw-byte cap: 20 frames of 65535 payload bytes (~1.25 MiB) -> 15 fit in 1 MiB.
host.handleRendererTelemetry(Array.from({ length: 20 }, (_, i) => frame(i, 5, 65535, 20)));
host.flushTelemetry(a);
{
  const raw = a.out[0].frames.reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0);
  check('at most 1 MiB of raw bytes per push', raw <= 1 << 20 && a.out[0].frames.length === 15, `${a.out[0].frames.length} frames, ${raw} B`);
}
host.flushTelemetry(a);
check('the rest follows on the next push', a.out[1]?.frames.length === 5, String(a.out[1]?.frames.length));
a.out.length = 0;

// 4) backpressure: skip while bufferedAmount > 512 KiB, keep only the latest.
a.bufferedAmount = 600 * 1024;
host.handleRendererTelemetry([frame(0, 1, 16, 30)]);
host.flushTelemetry(a);
host.handleRendererTelemetry([frame(0, 1, 16, 31)]);
host.flushTelemetry(a);
check('backpressure: nothing sent while the buffer is above 512 KiB', a.out.length === 0);
a.bufferedAmount = 0;
host.flushTelemetry(a);
check('backpressure: once drained, only the newest frame is sent',
  a.out.length === 1 && a.out[0].frames.length === 1 && Buffer.from(a.out[0].frames[0].data, 'base64').readUInt32LE(8) === 31);

// 5) demand: highest fps across clients; off when the last one leaves.
const b = fakeSocket();
clients.add(b);
host.onTelemetry(a, { op: 'telemetry', on: true, fps: 10 }, 4);
host.onTelemetry(b, { op: 'telemetry', on: true, fps: 20 }, 1);
check('demand follows the highest fps (20)', controls.at(-1)?.fps === 20, JSON.stringify(controls.at(-1)));
const beforeCount = controls.length;
host.updateTelemetryDemand();
check('demand is not resent when unchanged', controls.length === beforeCount);
host.onTelemetry(b, { op: 'telemetry', on: false }, 2);
check('demand drops to 10 when the 20 fps client unsubscribes', controls.at(-1)?.fps === 10, JSON.stringify(controls.at(-1)));
host.handleRendererTelemetry([frame(0, 1, 16, 40)]);
check('an unsubscribed client collects nothing', b.telemetry === null);
host.onTelemetry(a, { op: 'telemetry', on: false }, 5);
check('demand off when nobody is subscribed', controls.at(-1)?.on === false, JSON.stringify(controls.at(-1)));
// renderer reload: the demand is sent again
host.onTelemetry(a, { op: 'telemetry', on: true, fps: 15 }, 6);
const n = controls.length;
host.setRendererReady();
await new Promise((r) => setImmediate(r));
check('renderer-ready resends the current demand', controls.length === n + 1 && controls.at(-1).on === true, JSON.stringify(controls.at(-1)));
host.clearTelemetry(a);
host.clearTelemetry(b);

// 6) rate: frames every ~5 ms for 3 s; the client asked for 30 and for 7 fps.
host.pumpTelemetry = pump;
for (const [fps, ws] of [[30, a], [7, b]]) {
  host.onTelemetry(ws, { op: 'telemetry', on: true, fps }, 10);
  ws.out.length = 0;
  ws.times.length = 0;
}
{
  const t0 = Date.now();
  let seq = 100;
  await new Promise((resolve) => {
    const feed = setInterval(() => {
      host.handleRendererTelemetry([frame(0, 1, 16, seq++)]);
      if (Date.now() - t0 >= 3000) { clearInterval(feed); resolve(); }
    }, 5);
  });
  // Steady state: pushes per second between the first and the last one.
  const steady = (ws) => (ws.times.length - 1) / ((ws.times.at(-1) - ws.times[0]) / 1000);
  const rateA = steady(a);
  const rateB = steady(b);
  check('rate: 30 fps client gets 28..30.4 pushes/s (steady state)', rateA >= 28 && rateA <= 30.4, rateA.toFixed(2));
  check('rate: 7 fps client gets 6.5..7.15 pushes/s (steady state)', rateB >= 6.5 && rateB <= 7.15, rateB.toFixed(2));
}
host.clearTelemetry(a);
host.clearTelemetry(b);

const failed = results.filter((r) => !r.ok);
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} cap checks passed`);
process.exit(failed.length ? 1 : 0);
