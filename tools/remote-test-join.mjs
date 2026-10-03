// Cross-machine check of "Join another EffeTune": a host Electron app and a joiner Electron app run wherever
// you like (different OSes or machines); this script only drives both through their DevTools ports.
//   host:    EFFETUNE_REMOTE=1 EFFETUNE_REMOTE_TOKEN=<t> EFFETUNE_REMOTE_PORT=<p> electron . --user-data-dir=<d1> \
//              --remote --remote-debugging-port=<hostCdp>
//   joiner:  electron . --user-data-dir=<d2> --remote-debugging-port=<clientCdp> --remote-join=http://<hostLan>:<p>/?t=<t>
//   node tools/remote-test-join.mjs --host-cdp=9396 --client-cdp=9399 [--seed] [--label="WSL host / Mac joiner"]
// A CDP port on another machine can be forwarded first (ssh -L 9399:127.0.0.1:9399 user@mac).
// The host is seeded with Volume -6, 5Band PEQ, Volume -3 when --seed is given. Exits non-zero on any FAIL.

import { connect, waitForTarget } from './remote-test-cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const hostCdp = Number(args['host-cdp']);
const clientCdp = Number(args['client-cdp']);
const label = args.label || 'host / joiner';
if (!hostCdp || !clientCdp) {
  console.error('usage: node tools/remote-test-join.mjs --host-cdp=<port> --client-cdp=<port> [--seed] [--label=...]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${label}: ${name}${detail ? ' :: ' + String(detail).slice(0, 400) : ''}`);
}
async function waitFor(fn, ms = 4000, step = 25) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return Date.now() - t0; } catch (_) { /* retry */ }
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}
const shape = (s) => JSON.stringify({ bypass: !!s.masterBypass, pipeline: s.pipeline, ids: s.ids });

const SEED = { name: 'Join Seed', plugins: [
  { nm: 'Volume', en: true, vl: -6 }, { nm: '5Band PEQ', en: true }, { nm: 'Volume', en: true, vl: -3 }] };

const hostTarget = await waitForTarget(hostCdp, (t) => t.type === 'page' && /effetune\.html/.test(t.url), 60000);
const host = await connect(hostTarget.webSocketDebuggerUrl);
const hostSnap = () => host.evaluate('JSON.parse(JSON.stringify(window.remoteControlController.takeSnapshot()))');
await waitFor(() => host.evaluate('!!window.remoteControlController?.active'), 60000, 500);
if (args.seed) {
  await host.evaluate(`window.pipelineManager.presetManager.loadPreset(${JSON.stringify(SEED)})`);
  await waitFor(async () => (await hostSnap()).pipeline.length === 3, 5000);
}

const clientTarget = await waitForTarget(clientCdp, (t) => t.type === 'page' && /^https?:\/\/[^/]+\/\?t=|^https?:\/\/[^/]+\/(remote\.html)?$/.test(t.url), 90000);
console.log(`joiner page: ${clientTarget.url.replace(/t=[^&]+/, 't=***')}`);
const client = await connect(clientTarget.webSocketDebuggerUrl);
const up = await waitFor(() => client.evaluate('!!window.remoteClient?.engine?.confirmed?.snapshot'), 60000, 250);
const clientSnap = () => client.evaluate('JSON.parse(JSON.stringify(window.remoteClient.adapter.snapshot()))');
const status = await client.evaluate('document.getElementById("remoteStatus")?.textContent');
check('the joiner connects and shows "Connected"', up !== null && status === 'Connected', `status=${status}`);
check('the joiner shows the host\'s pipeline', shape(await clientSnap()) === shape(await hostSnap()),
  `${(await hostSnap()).pipeline.length} stages`);

// Joiner -> host: a slider edit in the joiner's DOM.
const volIndex = (await hostSnap()).pipeline.findIndex((s) => s.nm === 'Volume');
const gesture = () => client.evaluate(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
await gesture();
const t1 = Date.now();
await client.evaluate(`(() => { const el = document.querySelectorAll('.pipeline-item')[${volIndex}].querySelector('input[type=range]');
  el.value = '-15'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const toHost = await waitFor(async () => (await hostSnap()).pipeline[volIndex].vl === -15, 4000);
check('a slider edit in the joiner reaches the host', toHost !== null, `${toHost} ms (${Date.now() - t1} ms wall)`);

// Host -> joiner.
await host.evaluate(`(() => { const p = window.audioManager.pipeline[${volIndex}]; p.setParameters({ vl: -9 });
  window.pipelineManager.core.updateWorkletPlugin(p); window.uiManager.updateURL(); })()`);
const toClient = await waitFor(async () => (await clientSnap()).pipeline[volIndex].vl === -9, 4000);
check('an edit on the host reaches the joiner', toClient !== null, `${toClient} ms`);

// Structure: the joiner adds a stage, the host sees it with the joiner's id.
const before = await hostSnap();
await gesture();
await client.evaluate(`window.uiManager.pluginListManager.addPluginToPipeline({ name: 'Mute' })`);
const added = await waitFor(async () => (await hostSnap()).ids.length === before.ids.length + 1, 4000);
check('adding a stage in the joiner adds it on the host', added !== null, `${added} ms`);
const converged = await waitFor(async () => shape(await clientSnap()) === shape(await hostSnap()), 4000);
check('both sides hold the same pipeline afterwards', converged !== null);

const failed = results.filter((ok) => !ok).length;
console.log(`JOIN SUMMARY (${label}): ${results.length - failed}/${results.length} checks passed`);
host.close();
client.close();
process.exit(failed ? 1 : 0);
