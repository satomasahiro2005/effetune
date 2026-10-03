// End-to-end test of two-way pipeline sync over remote-v1 ("sync1"): the fork's
// Electron app is the host; two browser pages (Playwright Chromium) run
// remote.html as clients; a raw WebSocket plays EffectDeck (legacy client) and
// another one only observes. Spawns its own host on port 47341 with its own
// user-data dir under .poc-logs/ (the installed app on 47300 is not touched) and
// kills only the process trees it started.
//   node tools/remote-test-sync.mjs
// Exits non-zero on any FAIL. Every CHECK line also goes to .poc-logs/sync-<time>.log.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { connect, waitForTarget } from './remote-test-cdp.mjs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, '.poc-logs');
const hostDir = path.join(logDir, 'sync-host');
const clientDir = path.join(logDir, 'sync-client');
const PORT = 47341;
const HOST_CDP = 9351;
const HOST_INSPECT = 9353;
const CLIENT_CDP = 9352;
const TOKEN = 'synctoken';
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `sync-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
fs.writeFileSync(logFile, '');

const results = [];
function out(line) {
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}
function check(name, ok, detail = '') {
  results.push({ name, ok });
  out(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' :: ' + String(detail).slice(0, 600) : ''}`);
}
function skip(name, why) {
  out(`CHECK SKIP: ${name} :: ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A hung renderer must fail the run with a message instead of hanging it.
function timed(session, ms = 60000) {
  const evaluate = session.evaluate.bind(session);
  session.evaluate = (expression) => withTimeout(evaluate(expression), ms, `cdp evaluate ${String(expression).slice(0, 60)}`);
  return session;
}
const withTimeout = (promise, ms, label) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout`)), ms))]);

// Resolves with the elapsed ms once fn() is truthy, or null on timeout.
async function waitFor(fn, ms = 3000, step = 25) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return Date.now() - t0; } catch (_) { /* retry */ }
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

const SEED_PRESET = { name: 'Sync Seed', plugins: [
  { nm: 'Volume', en: true, vl: -6 }, { nm: '5Band PEQ', en: true }, { nm: 'Volume', en: true, vl: -3 }] };

const canon = (value) => JSON.stringify(value, (_k, v) =>
  (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
const shape = (s) => canon({ masterBypass: !!s.masterBypass, pipeline: s.pipeline, ids: s.ids, slot: s.slot });

// ---- processes -----------------------------------------------------------

const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const electronExe = process.platform === 'win32' ? path.join(electronDist, 'electron.exe')
  : process.platform === 'darwin' ? path.join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : path.join(electronDist, 'electron');
const started = [];
const browsers = [];

function killTree(child) {
  if (!child || child.exited) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid); } catch (_) { child.kill('SIGKILL'); } }
}
// The app may relaunch itself (its watchdog does so when a renderer hangs), which
// leaves a process we have no handle on: find ours by the user-data dir on its command line.
function killByUserDataDir(dir) {
  if (process.platform !== 'win32') {
    spawnSync('pkill', ['-9', '-f', '--', `--user-data-dir=${dir}`], { stdio: 'ignore' });
    return;
  }
  const needle = path.normalize(dir).replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*${needle}*' } | ` +
    'ForEach-Object { taskkill /PID $_.ProcessId /F | Out-Null }'], { stdio: 'ignore' });
}
function cleanup() {
  for (const child of started) killTree(child);
  killByUserDataDir(hostDir);
  killByUserDataDir(clientDir);
  for (const browser of browsers) browser.close().catch(() => {});
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function launchElectron(label, userData, { cdp, inspect, env = {}, args = [] }) {
  fs.mkdirSync(userData, { recursive: true });
  const log = fs.openSync(path.join(logDir, `sync-app-${label}.log`), 'w');
  const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...env };
  if (!env.EFFETUNE_REMOTE) { delete childEnv.EFFETUNE_REMOTE; delete childEnv.EFFETUNE_REMOTE_TOKEN; }
  const argv = ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${cdp}`, ...args];
  if (inspect) argv.push(`--inspect=${inspect}`);
  const child = spawn(electronExe, argv, { cwd: root, env: childEnv, stdio: ['ignore', log, log],
    detached: process.platform !== 'win32' }); // own process group so killTree reaches the helpers
  child.exited = false;
  child.on('exit', (code) => { child.exited = true; out(`[${label}] electron exited (${code})`); });
  started.push(child);
  out(`[${label}] launched electron pid ${child.pid}`);
  return child;
}

async function openBrowser() {
  const { chromium } = require('playwright');
  const candidates = [undefined];
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const cacheRoots = [process.env.PLAYWRIGHT_BROWSERS_PATH, base, path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const dir of cacheRoots) {
    try {
      for (const entry of fs.readdirSync(dir).sort().reverse()) {
        const shell = path.join(dir, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
        const full = path.join(dir, entry, 'chrome-win64', 'chrome.exe');
        for (const exe of [shell, full]) if (fs.existsSync(exe)) candidates.push(exe);
      }
    } catch (_) { /* no cache here */ }
  }
  let lastError = null;
  for (const executablePath of candidates) {
    try {
      const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      browsers.push(browser);
      return browser;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

// ---- raw websocket clients -------------------------------------------------

function rawClient(label, { hello = null, token = TOKEN, origin, pausable = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?t=${token}`, origin ? { origin } : {});
    const inbox = [];
    const client = { ws, inbox, closed: null, closeCode: null, status: null };
    client.waitFor = (match, ms = 5000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const poll = () => {
        const found = inbox.find(match);
        if (found) res(found);
        else if (Date.now() - t0 > ms) rej(new Error(`${label}: timeout waiting for message`));
        else setTimeout(poll, 20);
      };
      poll();
    });
    client.send = (m) => ws.send(JSON.stringify(m));
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('close', (code) => { client.closeCode = code; });
    ws.on('unexpected-response', (_req, res) => { client.status = res.statusCode; res.resume(); resolve(client); });
    ws.on('error', () => {});
    ws.on('open', () => {
      if (hello) client.send(hello);
      resolve(client);
    });
    if (pausable) client.pause = () => ws._socket.pause();
    if (pausable) client.resume = () => ws._socket.resume();
  });
}

// ---- main ------------------------------------------------------------------

const consoleErrorsAll = [];
let host = null;
let panel = null;
let hostChild = null;
let clientChild = null;

async function main() {
  killByUserDataDir(hostDir);
  killByUserDataDir(clientDir);
  await sleep(1000);
  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.rmSync(clientDir, { recursive: true, force: true });
  hostChild = launchElectron('host', hostDir, {
    cdp: HOST_CDP,
    inspect: HOST_INSPECT,
    env: { EFFETUNE_REMOTE: '1', EFFETUNE_REMOTE_TOKEN: TOKEN, EFFETUNE_REMOTE_PORT: String(PORT) },
    args: ['--remote']
  });
  const target = await waitForTarget(HOST_CDP, (t) => t.type === 'page' && /effetune\.html/.test(t.url), 90000);
  host = timed(await connect(target.webSocketDebuggerUrl));
  const ready = await waitFor(() => host.evaluate('!!window.remoteControlController && !!window.pipelineManager && !!window.remoteControlController.active'), 60000, 500);
  if (ready === null) throw new Error('host renderer bridge did not start');

  const hostSnap = () => host.evaluate('JSON.parse(JSON.stringify(window.remoteControlController.takeSnapshot()))');
  // The host's own UI: seed, then record toasts to see what a client edit shows there.
  await host.evaluate(`(() => {
    window.__toasts = [];
    const ui = window.uiManager;
    for (const name of ['showTransientMessage', 'setError']) {
      const original = ui[name];
      ui[name] = function (...args) { window.__toasts.push(String(args[0])); return original.apply(this, args); };
    }
    return window.pipelineManager.presetManager.loadPreset(${JSON.stringify(SEED_PRESET)});
  })()`);
  await waitFor(async () => (await hostSnap()).pipeline.length === 3, 5000);
  out(`host ready: ${JSON.stringify((await hostSnap()).ids)}`);

  const browser = await openBrowser();
  const lan = lanAddress();

  // ---- 1. static files and the upgrade --------------------------------------
  {
    const index = await fetch(`http://127.0.0.1:${PORT}/`);
    check('1 GET / is 200 and carries the connect-src header',
      index.status === 200 && index.headers.get('content-security-policy') === `connect-src 'self' ws://127.0.0.1:${PORT}`,
      `${index.status} ${index.headers.get('content-security-policy')}`);
    check('1 /effetune.html is not served', (await fetch(`http://127.0.0.1:${PORT}/effetune.html`)).status === 404);
    const evil = await rawClient('evil', { origin: 'http://evil.example' });
    await sleep(300);
    check('1 websocket with a foreign Origin is refused with 403', evil.status === 403, String(evil.status));
    const none = await rawClient('no-origin');
    await sleep(200);
    check('1 websocket without Origin is accepted', none.ws.readyState === 1);
    none.ws.close();
    const bad = await rawClient('bad-token', { token: 'wrongtoken' });
    await waitFor(() => bad.closeCode !== null, 3000);
    check('1 websocket with a wrong token is closed with 4401', bad.closeCode === 4401, String(bad.closeCode));
  }

  // ---- pages -----------------------------------------------------------------
  const consoleErrors = consoleErrorsAll;
  async function openClientPage(label, address, { engine = browser, token = TOKEN } = {}) {
    const context = await engine.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__audioContexts = 0;
      for (const name of ['AudioContext', 'webkitAudioContext']) {
        const Original = window[name];
        if (!Original) continue;
        window[name] = function (...args) { window.__audioContexts += 1; return new Original(...args); };
        window[name].prototype = Original.prototype;
      }
    });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`); });
    page.on('pageerror', (e) => consoleErrors.push(`${label}: pageerror ${String(e)}`));
    await page.goto(`http://${address}:${PORT}/?t=${token}`);
    await page.waitForFunction(() => window.remoteClient?.engine?.confirmed?.snapshot, null, { timeout: 60000 });
    await page.evaluate(() => {
      window.__acks = [];
      const session = window.remoteClient.session;
      const original = session.send.bind(session);
      session.send = (message) => original(message).then((ack) => { window.__acks.push({ message, ack }); return ack; });
    });
    return { label, page, context, address };
  }
  const snap = (p) => withTimeout(p.page.evaluate(() => JSON.parse(JSON.stringify(window.remoteClient.adapter.snapshot()))), 60000, `${p.label} snapshot`);
  const sameAsHost = async (p) => shape(await snap(p)) === shape(await hostSnap());
  const allEqual = async (...pages) => {
    const h = shape(await hostSnap());
    for (const p of pages) if (shape(await snap(p)) !== h) return false;
    return true;
  };
  const gesture = (p) => p.page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  const evalIn = (p, fn, arg) => withTimeout(p.page.evaluate(fn, arg), 60000, `${p.label} evaluate`);

  const P1 = await openClientPage('P1', '127.0.0.1');
  const P2 = await openClientPage('P2', lan || '127.0.0.1');

  // ---- 2. bootstrap -----------------------------------------------------------
  for (const p of [P1, P2]) {
    const info = await evalIn(p, () => ({
      search: location.search,
      token: localStorage.getItem('effetune.remote.token'),
      stub: window.workletNode === window.audioManager.workletNode && !(window.workletNode instanceof AudioWorkletNode),
      audioContexts: window.__audioContexts,
      status: document.getElementById('remoteStatus').textContent,
      secure: window.isSecureContext,
      url: location.href
    }));
    check(`2 ${p.label} bootstrap: token stored, stripped from the URL, stub worklet, no AudioContext, connected`,
      info.search === '' && info.token === TOKEN && info.stub && info.audioContexts === 0 && info.status === 'Connected',
      JSON.stringify(info));
    check(`2 ${p.label} shows the host's pipeline (short items and ids)`, await sameAsHost(p));
  }
  if (lan) {
    check('2 P2 runs on the LAN address in an insecure context', (await evalIn(P2, () => window.isSecureContext)) === false, lan);
  } else {
    skip('2 P2 insecure-context assertion', 'no private LAN IPv4 address found');
  }

  // ---- 3. host -> clients -------------------------------------------------------
  {
    await host.evaluate(`(() => { const p = window.audioManager.pipeline[0]; p.setParameters({ vl: -11 });
      window.pipelineManager.core.updateWorkletPlugin(p); window.uiManager.updateURL(); })()`);
    const t1 = await waitFor(async () => (await snap(P1)).pipeline[0].vl === -11, 1500);
    const t2 = await waitFor(async () => (await snap(P2)).pipeline[0].vl === -11, 1500);
    check('3 a host edit reaches both pages within 500 ms', t1 !== null && t2 !== null && t1 <= 500 && t2 <= 500, `${t1} ms, ${t2} ms`);
  }

  // ---- 4. client -> host and the other client, through the real DOM -------------
  {
    const historyBefore = await host.evaluate('window.pipelineManager.historyManager.history.length');
    const toastsBefore = await host.evaluate('window.__toasts.length');
    const presetName = await host.evaluate('window.pipelineManager.presetManager.currentPresetName');
    await P1.page.locator('.pipeline-item').first().locator('input[type=range]').first().evaluate((el) => {
      el.value = '-9';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const th = await waitFor(async () => (await hostSnap()).pipeline[0].vl === -9, 1500);
    const t2 = await waitFor(async () => (await snap(P2)).pipeline[0].vl === -9, 1500);
    check('4 a slider edit on P1 reaches the host and P2 within 500 ms', th !== null && t2 !== null && th <= 500 && t2 <= 500, `${th} ms, ${t2} ms`);
    await sleep(1500);
    const historyAfter = await host.evaluate('window.pipelineManager.historyManager.history.length');
    check('4 the host records a history entry for it', historyAfter > historyBefore, `${historyBefore} -> ${historyAfter}`);
    const toasts = await host.evaluate(`window.__toasts.slice(${toastsBefore})`);
    const nameAfter = await host.evaluate('window.pipelineManager.presetManager.currentPresetName');
    check('4 no "preset loaded" toast and the preset name stays', !toasts.some((t) => /presetLoaded/.test(t)) && nameAfter === presetName,
      JSON.stringify({ toasts, presetName, nameAfter }));
  }

  // ---- 5. client structural edit ---------------------------------------------------
  {
    await evalIn(P2, () => { window.__probe = window.audioManager.pipeline[0]; });
    await gesture(P2);
    await evalIn(P2, () => { window.uiManager.pluginListManager.addPluginToPipeline({ name: 'Mute' }); });
    const t = await waitFor(async () => (await hostSnap()).pipeline.length === 4, 2000);
    const h = await hostSnap();
    const p2 = await snap(P2);
    check('5 adding Mute on P2 gives the host 4 stages and the host keeps P2\'s id for it',
      t !== null && h.ids[3] === p2.ids[3] && /^c[0-9a-z]+\.\d+$/.test(h.ids[3]) && h.pipeline[3].nm === 'Mute', JSON.stringify(h.ids));
    check('5 P1 shows the new stage', await waitFor(async () => (await snap(P1)).ids.length === 4, 2000) !== null && await sameAsHost(P1));
    check('5 P2 keeps its plugin instances across the round trip',
      await evalIn(P2, () => window.audioManager.pipeline[0] === window.__probe));
  }

  // ---- 6. concurrent structural edits ------------------------------------------------
  {
    const before = await hostSnap();
    await Promise.all([gesture(P1), gesture(P2)]);
    await Promise.all([
      evalIn(P1, () => {
        const pm = window.pipelineManager;
        pm.selectedPlugins.clear();
        pm.selectedPlugins.add(window.audioManager.pipeline[1]);
        pm.deleteSelectedPlugins();
      }),
      evalIn(P2, () => {
        const list = window.audioManager.pipeline;
        const [moved] = list.splice(2, 1);
        list.unshift(moved);
        window.pipelineManager.core.updatePipelineUI();
        window.pipelineManager.core.updateWorkletPlugins();
      }),
      host.evaluate(`(() => { const plugin = window.pluginManager.createPlugin('Mute');
        window.audioManager.pipeline.splice(1, 0, plugin); const core = window.pipelineManager.core;
        core.updatePipelineUI(); core.updateWorkletPlugins(); window.pipelineManager.historyManager.saveState(); })()`)
    ]);
    const t = await waitFor(() => allEqual(P1, P2), 3000, 50);
    const after = await hostSnap();
    const deleted = before.ids[1];
    const survivors = before.ids.filter((id) => id !== deleted);
    check('6 concurrent delete, move and insert converge on host, P1 and P2 within 2 s', t !== null && t <= 2000, `${t} ms ${JSON.stringify(after.ids)}`);
    check('6 no stage is duplicated and every unaffected stage survives',
      new Set(after.ids).size === after.ids.length && survivors.every((id) => after.ids.includes(id)) && !after.ids.includes(deleted),
      JSON.stringify({ before: before.ids, after: after.ids }));
  }

  // ---- 7. concurrent parameters ---------------------------------------------------------
  {
    const volumeIndex = (await hostSnap()).pipeline.findIndex((s) => s.nm === 'Volume');
    await Promise.all([gesture(P1), gesture(P2)]);
    const setVl = (value) => `(() => { const p = window.audioManager.pipeline[${volumeIndex}]; p.setParameters({ vl: ${value} }); p.updateParameters(); })()`;
    await Promise.all([
      host.evaluate(`(() => { const p = window.audioManager.pipeline[${volumeIndex}]; p.setParameters({ vl: -1 });
        window.pipelineManager.core.updateWorkletPlugin(p); window.uiManager.updateURL(); })()`),
      evalIn(P1, new Function(`return ${setVl(-2)}`)),
      evalIn(P2, new Function(`return ${setVl(-3)}`))
    ]);
    const t = await waitFor(() => allEqual(P1, P2), 2000, 50);
    const finalVl = (await hostSnap()).pipeline[volumeIndex].vl;
    check('7 three concurrent writes of one key converge on one value within 1 s', t !== null && t <= 1000 && [-1, -2, -3].includes(finalVl), `${t} ms vl=${finalVl}`);

    // P1 drags g0 of the PEQ at 30 Hz for 2 s while the host changes f1 of the same stage.
    if ((await hostSnap()).pipeline.findIndex((s) => s.nm === '5Band PEQ') < 0) {
      await host.evaluate(`(() => { const plugin = window.pluginManager.createPlugin('5Band PEQ');
        window.audioManager.pipeline.push(plugin); const core = window.pipelineManager.core;
        core.updatePipelineUI(); core.updateWorkletPlugins(); window.pipelineManager.historyManager.saveState(); })()`);
      await waitFor(() => allEqual(P1, P2), 3000, 50);
    }
    const peq = (await hostSnap()).pipeline.findIndex((s) => s.nm === '5Band PEQ');
    const drag = evalIn(P1, async (index) => {
      const p = window.audioManager.pipeline[index];
      for (let i = 0; i < 60; i += 1) {
        document.dispatchEvent(new Event('input', { bubbles: true }));
        p.setParameters({ g0: Math.round((i / 60) * 100) / 10 });
        p.updateParameters();
        await new Promise((r) => setTimeout(r, 33));
      }
      return p.g0;
    }, peq);
    await sleep(700);
    await host.evaluate(`(() => { const p = window.audioManager.pipeline[${peq}]; p.setParameters({ f1: 444 });
      window.pipelineManager.core.updateWorkletPlugin(p); window.uiManager.updateURL(); })()`);
    const lastG0 = await drag;
    const t2 = await waitFor(async () => (await allEqual(P1, P2)) && (await hostSnap()).pipeline[peq].g0 === lastG0 && (await hostSnap()).pipeline[peq].f1 === 444, 3000, 50);
    const finalPeq = (await hostSnap()).pipeline[peq];
    check('7 a 30 Hz drag on P1 and a host edit of another key both survive everywhere', t2 !== null,
      JSON.stringify({ g0: finalPeq.g0, f1: finalPeq.f1, lastG0 }));
  }

  // ---- 8. set versus delete ------------------------------------------------------------
  {
    const state = await hostSnap();
    const target = state.ids[state.pipeline.findIndex((s) => s.nm === 'Volume')];
    await evalIn(P1, () => {
      window.__acks.length = 0;
      // P1's edit leaves 400 ms late, so the host sees P2's delete first.
      const ws = window.remoteClient.session.ws;
      window.__wsSend = ws.send.bind(ws);
      ws.send = (data) => setTimeout(() => window.__wsSend(data), 400);
    });
    await Promise.all([gesture(P1), gesture(P2)]);
    await Promise.all([
      evalIn(P1, (id) => {
        const index = window.remoteClient.adapter.snapshot().ids.indexOf(id);
        const p = window.audioManager.pipeline[index];
        p.setParameters({ vl: -17 });
        p.updateParameters();
      }, target),
      evalIn(P2, (id) => {
        const pm = window.pipelineManager;
        const index = window.remoteClient.adapter.snapshot().ids.indexOf(id);
        pm.selectedPlugins.clear();
        pm.selectedPlugins.add(window.audioManager.pipeline[index]);
        pm.deleteSelectedPlugins();
      }, target)
    ]);
    const t = await waitFor(async () => (await allEqual(P1, P2)) && !(await hostSnap()).ids.includes(target), 3000, 50);
    await waitFor(() => evalIn(P1, () => window.__acks.some((a) => a.message.op === 'edit')), 3000, 50);
    await evalIn(P1, () => { window.remoteClient.session.ws.send = window.__wsSend; });
    const acks = await evalIn(P1, () => window.__acks.filter((a) => a.message.op === 'edit').map((a) => ({ ok: a.ack.ok, skipped: a.ack.skipped || [] })));
    check('8 a set racing a delete of the same stage: everyone converges and the stage is gone', t !== null, JSON.stringify(acks));
    check('8 the late set is acknowledged with the op skipped', acks.length >= 1 && acks[0].ok === true && acks[0].skipped.includes(0), JSON.stringify(acks));
    await waitFor(() => allEqual(P1, P2), 3000, 50);
  }

  // ---- 9. a held control is not moved ------------------------------------------------------
  {
    const volumeIndex = (await hostSnap()).pipeline.findIndex((s) => s.nm === 'Volume');
    const slider = P1.page.locator('.pipeline-item').nth(volumeIndex).locator('input[type=range]').first();
    const valueBefore = await slider.evaluate((el) => el.value);
    const box = await slider.boundingBox();
    await P1.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await P1.page.mouse.down();
    // Pressing the track already moves the thumb to the pointer; that is P1's own edit.
    const valueDown = await slider.evaluate((el) => el.value);
    await host.evaluate(`(() => { const p = window.audioManager.pipeline[${volumeIndex}]; p.setParameters({ vl: -20 });
      window.pipelineManager.core.updateWorkletPlugin(p); window.uiManager.updateURL(); })()`);
    await waitFor(async () => (await snap(P2)).pipeline[volumeIndex].vl === -20, 1500);
    await sleep(300);
    const valueHeld = await slider.evaluate((el) => el.value);
    check('9 a host change does not move the slider P1 is holding', valueHeld === valueDown && valueHeld !== '-20',
      `${valueBefore} -> pressed ${valueDown} -> held ${valueHeld}`);
    await P1.page.mouse.up();
    await slider.evaluate((el) => {
      el.value = '-7';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const t = await waitFor(async () => (await hostSnap()).pipeline[volumeIndex].vl === -7 && (await snap(P2)).pipeline[volumeIndex].vl === -7, 2000);
    check('9 after the release P1\'s next edit wins on the host and P2', t !== null);
  }

  // ---- 10. no ping-pong ------------------------------------------------------------------------
  const W = await rawClient('W', { hello: { op: 'hello', v: 1, seq: 1, app: 'observer' } });
  await W.waitFor((m) => m.op === 'state');
  {
    await sleep(1000);
    const mark = W.inbox.length;
    await sleep(3000);
    const pushes = W.inbox.slice(mark).filter((m) => m.op === 'state').length;
    check('10 no state pushes while everything is quiet', pushes === 0, `${pushes} pushes in 3 s`);
  }

  // ---- 11. self-rewrite guard --------------------------------------------------------------------
  {
    await sleep(3000);
    const before = await hostSnap();
    const volumeIndex = before.pipeline.findIndex((s) => s.nm === 'Volume');
    await evalIn(P1, (index) => {
      const p = window.audioManager.pipeline[index];
      p.setParameters({ vl: 5 });
      p.updateParameters();
    }, volumeIndex);
    await sleep(1000);
    const after = await hostSnap();
    check('11 an ungestured plugin rewrite is not sent to the host', shape(before) === shape(after) && after.pipeline[volumeIndex].vl !== 5,
      `${before.pipeline[volumeIndex].vl} -> ${after.pipeline[volumeIndex].vl}`);
    check('11 and P1 goes back to the host value', await waitFor(() => sameAsHost(P1), 1500) !== null);
  }

  // ---- 12. host-local fast publish and A/B ---------------------------------------------------------
  const E = await rawClient('E', { hello: { op: 'hello', v: 1, seq: 1, app: 'EffectDeck', version: '2026.10', build: '99' } });
  const helloE = await E.waitFor((m) => m.op === 'state' && m.seq === 1);
  {
    const marks = { E: E.inbox.length };
    const t0 = Date.now();
    await host.evaluate('window.uiManager.togglePipeline(); true');
    const t1 = await waitFor(async () => (await snap(P1)).slot === 'B', 3000, 20);
    const t2 = await waitFor(async () => (await snap(P2)).slot === 'B', 3000, 20);
    check('12 an A/B switch on the host reaches both pages quickly (not via the 1 s poll)', t1 !== null && t2 !== null && Math.max(t1, t2) <= 300,
      `${t1} ms, ${t2} ms (since ${Date.now() - t0})`);
    check('12 and both pages show the other pipeline', await waitFor(() => allEqual(P1, P2), 2000) !== null);
    const pushE = E.inbox.slice(marks.E).find((m) => m.op === 'state' && m.slot === 'B');
    check('12 EffectDeck sees origin "local" for it', pushE?.origin === 'local', JSON.stringify(pushE?.origin));
    await gesture(P1);
    await P1.page.locator('#pipelineToggleButton').click();
    check('12 P1 switches the host back to A', await waitFor(async () => (await hostSnap()).slot === 'A', 3000) !== null);
    await waitFor(() => allEqual(P1, P2), 2000);
  }

  // ---- 13. history -------------------------------------------------------------------------------------
  {
    const volumeIndex = (await hostSnap()).pipeline.findIndex((s) => s.nm === 'Volume');
    await gesture(P1);
    await evalIn(P1, (index) => {
      const p = window.audioManager.pipeline[index];
      p.setParameters({ vl: -4 });
      p.updateParameters();
    }, volumeIndex);
    await waitFor(async () => (await hostSnap()).pipeline[volumeIndex].vl === -4, 2000);
    await sleep(1400);
    await gesture(P2);
    await P2.page.locator('#undoButton').click();
    const t = await waitFor(async () => (await hostSnap()).pipeline[volumeIndex].vl !== -4, 3000);
    check('13 Undo on P2 reverts the last edit on the host', t !== null, String((await hostSnap()).pipeline[volumeIndex].vl));
    check('13 and P1 follows', await waitFor(() => allEqual(P1, P2), 3000, 50) !== null);
  }

  // ---- 14. presets ---------------------------------------------------------------------------------------
  {
    await evalIn(P1, () => { window.__probeA = window.audioManager.pipeline[0]; });
    await gesture(P1);
    const saved = await evalIn(P1, () => window.pipelineManager.presetManager.savePreset('Sync A'));
    check('14 P1 saves a preset on the host', saved === true);
    const seen = await waitFor(async () => Object.keys(await evalIn(P2, () => window.pipelineManager.presetManager.getPresets())).includes('Sync A'), 3000, 100);
    check('14 P2 learns about it (presetsChanged) and lists it', seen !== null);
    const before = await hostSnap();
    const toastsBefore = await host.evaluate('window.__toasts.length');
    await gesture(P2);
    const loaded = await evalIn(P2, () => window.pipelineManager.presetManager.loadPreset('Sync A'));
    await waitFor(async () => (await hostSnap()).ids.every((id) => !before.ids.includes(id)), 3000);
    const after = await hostSnap();
    const toasts = await host.evaluate(`window.__toasts.slice(${toastsBefore})`);
    check('14 loading it from P2 shows the toast on the host and gives every stage a new id',
      loaded === true && toasts.some((x) => /presetLoaded/.test(x)) && after.ids.every((id) => !before.ids.includes(id)), JSON.stringify(toasts));
    await waitFor(() => allEqual(P1, P2), 3000, 50);
    check('14 P1 keeps its plugin instances while adopting the new ids',
      await evalIn(P1, () => window.audioManager.pipeline[0] === window.__probeA) && await allEqual(P1, P2));
    await gesture(P2);
    const deleted = await evalIn(P2, () => window.pipelineManager.presetManager.deletePresets(['Sync A']));
    const gone = await waitFor(async () => !Object.keys(await evalIn(P1, () => window.pipelineManager.presetManager.getPresets())).includes('Sync A'), 3000, 100);
    check('14 deleting it from P2 removes it for P1 as well', deleted === true && gone !== null);
  }

  // ---- 14b. IR library changes --------------------------------------------------------------------------
  {
    const S = await rawClient('S', { hello: { op: 'hello', v: 1, seq: 1, app: 'EffectDeck', version: '2026.10', build: '99', sync: 1 } });
    await S.waitFor((m) => m.op === 'state' && m.seq === 1);
    const frames = 4800;
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + frames * 2, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
    for (let f = 0; f < frames; f++) wav.writeInt16LE(Math.round(Math.exp(-f / 600) * 16000 * (f % 7 === 0 ? 1 : -0.3)) + (f === frames - 1 ? 1234 : 0), 44 + f * 2);
    const id = createHash('sha256').update(wav).digest('hex').slice(0, 24);
    const mark = { S: S.inbox.length, E: E.inbox.length };
    S.send({ op: 'putIR', seq: 30, id, name: 'SyncNotice.wav', ext: 'wav', index: 0, total: 1, bytes: wav.length, data: wav.toString('base64') });
    const ack = await S.waitFor((m) => m.op === 'ack' && m.seq === 30, 15000);
    check('14b putIR of a new IR succeeds', ack.ok === true, JSON.stringify(ack));
    const notice = await S.waitFor((m) => m.op === 'irsChanged' && S.inbox.indexOf(m) >= mark.S, 4000).catch(() => null);
    check('14b a sync client gets irsChanged (no seq) after the import', notice !== null && notice.seq === undefined);
    S.send({ op: 'listIRs', seq: 31 });
    const listed = await S.waitFor((m) => m.op === 'irs' && m.seq === 31);
    check('14b and listIRs then contains the new IR', listed.items.some((item) => item.id === id));
    await sleep(800);
    check('14b the legacy client never sees irsChanged', !E.inbox.slice(mark.E).some((m) => m.op === 'irsChanged'));
    S.ws.close();
  }

  // ---- 15. EffectDeck (legacy client) ---------------------------------------------------------------------
  {
    const features = helloE.features || [];
    check('15 hello reply: origin "remote", the same seq, features a superset of the old ones',
      helloE.origin === 'remote' && helloE.seq === 1 && ['origin', 'savePreset', 'irSync', 'telemetry', 'overlays'].every((f) => features.includes(f)),
      JSON.stringify({ origin: helloE.origin, seq: helloE.seq, features }));
    // chain without ids: a new host id sequence, clients follow and keep their instances
    await evalIn(P1, () => { window.__probeC = window.audioManager.pipeline[0]; });
    const before = await hostSnap();
    const items = before.pipeline.map((item) => ({ ...item }));
    items[0].vl = -13;
    E.send({ op: 'chain', seq: 20, pipeline: items });
    const ackChain = await E.waitFor((m) => m.op === 'ack' && m.seq === 20);
    await waitFor(async () => (await hostSnap()).ids.every((id) => !before.ids.includes(id)), 3000);
    const after = await hostSnap();
    check('15 a legacy chain succeeds, replaces every id and its ack carries rev',
      ackChain.ok === true && typeof ackChain.rev === 'number' && after.pipeline[0].vl === -13 && after.ids.every((id) => !before.ids.includes(id)),
      JSON.stringify(ackChain));
    await waitFor(() => allEqual(P1, P2), 3000, 50);
    check('15 the pages follow the chain and keep their plugin instances',
      await allEqual(P1, P2) && await evalIn(P1, () => window.audioManager.pipeline[0] === window.__probeC));
    E.send({ op: 'params', seq: 21, index: 0, params: { vl: -8 } });
    const ackParams = await E.waitFor((m) => m.op === 'ack' && m.seq === 21);
    check('15 params by index works and its ack carries rev', ackParams.ok === true && typeof ackParams.rev === 'number' &&
      (await hostSnap()).pipeline[0].vl === -8, JSON.stringify(ackParams));
    await waitFor(() => allEqual(P1, P2), 3000, 50);
    await sleep(500);
    const sawPresetsChanged = E.inbox.some((m) => m.op === 'presetsChanged');
    const pushes = E.inbox.filter((m) => m.op === 'state' && m.seq === undefined);
    check('15 EffectDeck never receives presetsChanged and every push is a state with origin local or remote',
      !sawPresetsChanged && pushes.length > 0 && pushes.every((m) => ['local', 'remote'].includes(m.origin)),
      `${pushes.length} pushes`);
    const stray = E.inbox.filter((m) => m.op === 'state' && m.seq !== undefined && m.seq !== 1 && ![20, 21].includes(m.seq));
    check('15 no push carries a seq that EffectDeck did not send', stray.length === 0, JSON.stringify(stray.map((m) => m.seq)));
    const client = spawnSync(process.execPath, ['tools/remote-test-client.mjs', `127.0.0.1:${PORT}/${TOKEN}`], { cwd: root, encoding: 'utf8', timeout: 240000 });
    fs.writeFileSync(path.join(logDir, 'sync-legacy-client.log'), (client.stdout || '') + (client.stderr || ''));
    const summary = (client.stdout || '').split('\n').filter((l) => /CHECK FAIL|SUMMARY|checks passed/.test(l)).slice(-5).join(' | ');
    check('15 tools/remote-test-client.mjs, unchanged, passes against this host', client.status === 0, `exit ${client.status} ${summary}`);
    await waitFor(() => allEqual(P1, P2), 5000, 100);
  }

  // ---- 17. renderer reload: a new epoch ------------------------------------------------------------------
  {
    out('  ... 17. renderer reload');
    const epochBefore = (await hostSnap()).epoch;
    await gesture(P1);
    await evalIn(P1, () => {
      const p = window.audioManager.pipeline[0];
      p.setParameters({ vl: -2 });
      p.updateParameters();
    });
    await host.send('Page.reload', {});
    await sleep(500);
    host.close();
    let up = null;
    for (let attempt = 0; attempt < 120 && up === null; attempt += 1) {
      await sleep(500);
      try {
        const target2 = await waitForTarget(HOST_CDP, (t) => t.type === 'page' && /effetune\.html/.test(t.url), 5000);
        const candidate = await withTimeout(connect(target2.webSocketDebuggerUrl), 4000, 'cdp connect');
        const epoch = await withTimeout(candidate.evaluate('window.remoteControlController && window.remoteControlController.active ? window.remoteControlController.epoch : null'), 4000, 'cdp evaluate').catch(() => null);
        if (epoch && epoch !== epochBefore) { host = timed(candidate); up = attempt; } else candidate.close();
      } catch (_) { /* reloading */ }
    }
    await host.evaluate(`(() => { window.__toasts = []; return window.pipelineManager.presetManager.loadPreset({ name: 'Sync Seed', plugins: [
      { nm: 'Volume', en: true, vl: -6 }, { nm: '5Band PEQ', en: true }, { nm: 'Volume', en: true, vl: -3 }] }); })()`);
    const epochAfter = (await hostSnap()).epoch;
    const adopted = await waitFor(async () => (await evalIn(P1, () => window.remoteClient.engine.confirmed?.epoch)) === epochAfter
      && (await evalIn(P2, () => window.remoteClient.engine.confirmed?.epoch)) === epochAfter, 20000, 200);
    const pending = await evalIn(P1, () => window.remoteClient.engine.pending.length);
    check('17 after the host window reloads both pages adopt the new epoch and drop pending edits',
      up !== null && epochAfter !== epochBefore && adopted !== null && pending === 0, `${epochBefore} -> ${epochAfter}`);
    check('17 and all three equal again', await waitFor(() => allEqual(P1, P2), 10000, 100) !== null);
  }

  // ---- panel (for 18 and the disconnect overlay) ----------------------------------------------------------------
  {
    out('  ... panel');
    const inspectTarget = await waitForTarget(HOST_INSPECT, () => true, 30000);
    const main = await connect(inspectTarget.webSocketDebuggerUrl);
    const hostModule = JSON.stringify(path.join(root, 'electron', 'remote-control-host.cjs'));
    await main.evaluate(`!!process.mainModule.require(${hostModule}).openRemoteControlPanel()`);
    main.close();
    const pageTarget = await waitForTarget(HOST_CDP, (t) => t.type === 'page' && /remote-control-panel\.html/.test(t.url), 30000);
    panel = await connect(pageTarget.webSocketDebuggerUrl);
    await waitFor(() => panel.evaluate(`(document.getElementById('status')?.textContent || '').length > 0`), 20000, 250);
  }

  // ---- overlay on a disconnect, then recovery -----------------------------------------------------------------------
  {
    out('  ... overlay on a disconnect');
    await panel.evaluate('remotePanel.setEnabled(false)');
    const overlayShown = await waitFor(() => evalIn(P1, () => !document.getElementById('remoteOverlay').hidden), 4000, 50);
    const text = await evalIn(P1, () => document.getElementById('remoteOverlayText').textContent);
    await panel.evaluate('remotePanel.setEnabled(true)');
    const back = await waitFor(async () => (await evalIn(P1, () => document.getElementById('remoteOverlay').hidden)) &&
      (await evalIn(P2, () => document.getElementById('remoteOverlay').hidden)), 20000, 100);
    check('17b a dropped connection shows a blocking "Reconnecting…" overlay, then recovers by itself',
      overlayShown !== null && /Reconnecting/.test(text) && back !== null, `${text} back=${back} ms`);
    check('17b and the editors equal the host again', await waitFor(() => allEqual(P1, P2), 10000, 100) !== null);
  }

  // ---- 19. Electron join window ---------------------------------------------------------------------------------------
  {
    out('  ... 19. Electron join');
    clientChild = launchElectron('client', clientDir, {
      cdp: CLIENT_CDP,
      args: [`--remote-join=http://127.0.0.1:${PORT}/?t=${TOKEN}`]
    });
    const winTarget = await waitForTarget(CLIENT_CDP, (t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`), 90000);
    const joined = await connect(winTarget.webSocketDebuggerUrl);
    const up = await waitFor(() => joined.evaluate('!!window.remoteClient?.engine?.confirmed?.snapshot'), 60000, 500);
    const joinedSnap = () => joined.evaluate('JSON.parse(JSON.stringify(window.remoteClient.adapter.snapshot()))');
    check('19 the Electron join window runs the client and shows the host\'s pipeline',
      up !== null && shape(await joinedSnap()) === shape(await hostSnap()));
    await joined.evaluate(`(() => { const el = document.querySelector('.pipeline-item input[type=range]');
      el.value = '-15'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const reached = await waitFor(async () => (await hostSnap()).pipeline[0].vl === -15, 3000);
    check('19 a DOM edit in the join window reaches the host', reached !== null);
    const status = await panel.evaluate('remotePanel.getStatus()');
    check('19 the host lists it as a desktop client', (status.devices || []).some((d) => d.build === 'desktop-client' && d.app === 'EffeTune'),
      JSON.stringify(status.devices));
    joined.close();
    killTree(clientChild);
    await sleep(1000);
  }

  // ---- 20. every plugin can be created, inserted and deleted on a client -------------------------------------------------
  {
    out('  ... 20. every plugin');
    const errorsBefore = consoleErrors.length;
    const outcome = await evalIn(P1, async () => {
      const failures = [];
      const am = window.audioManager;
      const pm = window.pluginManager;
      const core = window.pipelineManager.core;
      am.suppressMutations = true;
      const names = Object.keys(pm.pluginClasses);
      try {
        for (const name of names) {
          try {
            const plugin = pm.createPlugin(name);
            am.pipeline.push(plugin);
            window.pipelineManager.expandedPlugins.add(plugin);
            core.updatePipelineUI(true);
            await new Promise((r) => setTimeout(r, 10));
            plugin.syncUIControls?.();
            plugin.cleanup?.();
            am.pipeline.splice(am.pipeline.indexOf(plugin), 1);
            core.updatePipelineUI(true);
          } catch (error) {
            failures.push(`${name}: ${error?.message || error}`);
          }
        }
      } finally {
        am.suppressMutations = false;
      }
      return { count: names.length, failures, missing: ['Analog Meter', 'Rhythm Analyzer', 'Tonal Balance EQ'].filter((n) => !names.includes(n)) };
    });
    const allowlist = [/favicon/i];
    const newErrors = consoleErrors.slice(errorsBefore).filter((e) => !allowlist.some((re) => re.test(e)));
    check(`20 all ${outcome.count} plugins can be created, shown and deleted on a client`, outcome.failures.length === 0 && newErrors.length === 0,
      JSON.stringify({ failures: outcome.failures.slice(0, 5), errors: newErrors.slice(0, 5) }));
    check('20 the client offers the effects added in 2.12 (Analog Meter, Rhythm Analyzer, Tonal Balance EQ)',
      outcome.missing.length === 0, JSON.stringify(outcome.missing));
    await waitFor(() => sameAsHost(P1), 5000, 100);
  }

  // ---- 21. a recycled plugin instance does not keep the old buses (review finding) ---------------------------------------
  {
    out('  ... 21. recycled instances');
    const loadOnHost = (file, name) => host.evaluate(`window.pipelineManager.presetManager.loadPreset(${
      JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, 'presets', file), 'utf8')), name })})`);
    const editsOf = (p) => evalIn(p, () => window.__acks.filter((a) => a.message.op === 'edit').length);
    const divergencesBefore = await evalIn(P1, () => window.remoteClient.engine.divergences);
    const editsBefore = await editsOf(P1);
    const problems = [];
    // rear_reverb: channel 34 on Volume, Hi Pass Filter and Stereo Blend; dsd_noise: input bus on Hi Pass Filter;
    // karaoke: output bus on Stereo Blend; needle_drop has the same effects with no bus or channel at all.
    for (const file of ['4ch/rear_reverb.effetune_preset', 'lofi/needle_drop.effetune_preset', 'lofi/dsd_noise.effetune_preset',
      'lofi/needle_drop.effetune_preset', 'others/karaoke.effetune_preset', 'lofi/needle_drop.effetune_preset']) {
      await loadOnHost(file, 'recycle');
      const ok = await waitFor(async () => (await sameAsHost(P1)) && (await sameAsHost(P2)), 5000, 50);
      const h = await hostSnap();
      if (ok === null) problems.push(`${file}: clients did not converge`);
      if (file.includes('needle_drop') && h.pipeline.some((item) => 'ib' in item || 'ob' in item || 'ch' in item)) problems.push(`${file}: host has buses`);
      if (file.includes('needle_drop')) {
        const buses = await evalIn(P1, () => window.audioManager.pipeline.filter((x) => x.inputBus != null || x.outputBus != null || x.channel != null).length);
        if (buses !== 0) problems.push(`${file}: ${buses} client plugins kept a bus or channel`);
      }
    }
    check('21 loading presets with and without buses/channels converges on both clients, buses cleared on recycled instances',
      problems.length === 0, problems.join(' | '));
    const divergencesAfter = await evalIn(P1, () => window.remoteClient.engine.divergences);
    check('21 the reconcile safety net never had to fix anything up', divergencesAfter === divergencesBefore, `${divergencesBefore} -> ${divergencesAfter}`);
    // A structural edit now must not drag stale bus state back to the host.
    const beforeEdit = await hostSnap();
    await gesture(P1);
    await evalIn(P1, () => { window.uiManager.pluginListManager.addPluginToPipeline({ name: 'Mute' }); });
    const added = await waitFor(async () => (await hostSnap()).ids.length === beforeEdit.ids.length + 1, 3000);
    await waitFor(() => allEqual(P1, P2), 3000, 50);
    await sleep(200);
    const afterEdit = await hostSnap();
    const keptStages = afterEdit.ids.map((id, k) => [id, afterEdit.pipeline[k]]).filter(([id]) => beforeEdit.ids.includes(id));
    const unchanged = keptStages.length === beforeEdit.ids.length && keptStages.every(([id, item]) =>
      canon(item) === canon(beforeEdit.pipeline[beforeEdit.ids.indexOf(id)]));
    const editsSent = (await editsOf(P1)) - editsBefore;
    check('21 a structural edit after the recycling sends only the new stage (host stages unchanged, one edit message)',
      added !== null && unchanged && editsSent === 1, `edits +${editsSent}`);
    await host.evaluate(`window.pipelineManager.presetManager.loadPreset(${JSON.stringify(SEED_PRESET)})`);
    await waitFor(async () => (await hostSnap()).pipeline.length === 3 && await allEqual(P1, P2), 5000, 50);
  }

  // ---- 24. an edit made against the other pipeline is refused (review finding) --------------------------------------------
  {
    const state = await evalIn(P1, () => {
      const c = window.remoteClient.engine.confirmed;
      return { epoch: c.epoch, rev: c.rev, slot: c.snapshot.slot };
    });
    const ack = await evalIn(P1, (c) => window.remoteClient.session.send({
      op: 'edit', epoch: c.epoch, base: c.rev, slot: c.slot === 'A' ? 'B' : 'A',
      ops: [{ t: 'ins', id: 'cslot.1', after: null, at: 0, item: { nm: 'Mute', en: true } }] }), state);
    check('24 an edit whose slot is not the host\'s active slot is refused with slot-mismatch and nothing changes',
      ack.ok === false && ack.error === 'slot-mismatch' && (await hostSnap()).pipeline.length === 3, JSON.stringify(ack));
    const fine = await evalIn(P1, (c) => window.remoteClient.session.send({
      op: 'edit', epoch: c.epoch, base: c.rev, slot: c.slot, ops: [{ t: 'del', id: 'cslot.nope' }] }), state);
    check('24 an edit with the right slot is accepted', fine.ok === true, JSON.stringify(fine));
  }

  // ---- 23. every plugin added through the UI converges and stays quiet (reviewer's probe) -------------------------------
  {
    out('  ... 23. every plugin inserted by gesture');
    const errorsBefore = consoleErrors.length;
    const names = await evalIn(P1, () => Object.keys(window.pluginManager.pluginClasses));
    const editsOf = (p) => evalIn(p, () => window.__acks.filter((a) => a.message.op === 'edit').length);
    const bad = [];
    for (const name of names) {
      await host.evaluate("window.pipelineManager.presetManager.loadPreset({ name: 'probe', plugins: [] })");
      await waitFor(async () => (await snap(P1)).ids.length === 0 && (await hostSnap()).ids.length === 0, 3000, 25);
      await gesture(P1);
      await evalIn(P1, (n) => { window.uiManager.pluginListManager.addPluginToPipeline({ name: n }); }, name);
      const landed = await waitFor(async () => (await hostSnap()).pipeline.length === 1 && await sameAsHost(P1), 4000, 25);
      await sleep(150);
      const e0 = await editsOf(P1);
      for (let k = 0; k < 3; k += 1) { await gesture(P1); await sleep(120); }
      const e1 = await editsOf(P1);
      if (landed === null || e1 !== e0 || !(await sameAsHost(P1))) {
        const c = await snap(P1);
        const h = await hostSnap();
        const keys = c.pipeline[0] && h.pipeline[0]
          ? Object.keys({ ...c.pipeline[0], ...h.pipeline[0] }).filter((key) => canon(c.pipeline[0][key]) !== canon(h.pipeline[0][key])) : [];
        bad.push(`${name}: landed=${landed !== null} extraEdits=${e1 - e0} differing=${keys.join(',')}`);
      }
    }
    const probeErrors = consoleErrors.slice(errorsBefore).filter((e) => !/favicon/i.test(e));
    check(`23 each of the ${names.length} plugins inserted on a client by gesture converges with the host and causes no extra edit messages`,
      bad.length === 0, JSON.stringify(bad.slice(0, 6)));
    check('23 and the clients raised no console error or page error meanwhile (Cassette Artifacts included)', probeErrors.length === 0,
      JSON.stringify(probeErrors.slice(0, 4)));
    await host.evaluate(`window.pipelineManager.presetManager.loadPreset(${JSON.stringify(SEED_PRESET)})`);
    await waitFor(async () => (await hostSnap()).pipeline.length === 3 && await allEqual(P1, P2), 5000, 50);
  }

  // ---- 18. token rotation (last: it ends P1's pairing)---------------------------------------------------------------------
  {
    out('  ... 18. token rotation');
    const newStatus = await panel.evaluate('remotePanel.regenerateToken()');
    const terminal = await waitFor(() => evalIn(P1, () => document.getElementById('remoteOverlayText').textContent), 4000, 100);
    const message = await evalIn(P1, () => document.getElementById('remoteOverlayText').textContent);
    const fresh = await rawClient('N', { token: newStatus.token });
    await sleep(8000);
    const clients = (await panel.evaluate('remotePanel.getStatus()')).clients;
    check('18 after "New token" P1 shows the pairing message and does not reconnect',
      terminal !== null && /pairing code changed/i.test(message) && clients === 1, `${message} | clients=${clients}`);
    fresh.ws.close();
  }

  // ---- 16. backpressure (last: it floods the host with synthetic states) -------------------------------------------
  {
    out('  ... 16. backpressure');
    const freshToken = (await panel.evaluate('remotePanel.getStatus()')).token;
    const D = await rawClient('D', { hello: { op: 'hello', v: 1, seq: 1, app: 'slow' }, token: freshToken, pausable: true });
    const O = await rawClient('O', { hello: { op: 'hello', v: 1, seq: 1, app: 'reader' }, token: freshToken });
    await D.waitFor((m) => m.op === 'state');
    await O.waitFor((m) => m.op === 'state');
    D.pause();
    const markD = D.inbox.length;
    const markO = O.inbox.length;
    // 50 states of about 2 MB each, straight through the renderer's own channel to main.
    await host.evaluate(`(async () => {
      const api = window.electronAPI.remoteV1;
      const epoch = window.remoteControlController.epoch;
      for (let i = 0; i < 50; i += 1) {
        const pipeline = Array.from({ length: 256 }, (_, k) => ({ nm: 'Volume', en: true, vl: -((i + k) % 40), pad: 'x'.repeat(8000) }));
        await api.publishState({ masterBypass: false, slot: 'A', epoch, pipeline, ids: pipeline.map((_, k) => 'h.syn' + i + '_' + k) });
        await new Promise((r) => setTimeout(r, 110));
      }
    })()`);
    await sleep(600);
    D.resume();
    const settled = await waitFor(() => {
      const lastD = [...D.inbox].reverse().find((m) => m.op === 'state');
      const lastO = [...O.inbox].reverse().find((m) => m.op === 'state');
      return lastD && lastO && lastD.rev === lastO.rev && canon(lastD.ids) === canon(lastO.ids);
    }, 20000, 200);
    const gotD = D.inbox.slice(markD).filter((m) => m.op === 'state').length;
    const gotO = O.inbox.slice(markO).filter((m) => m.op === 'state').length;
    out(`  the reader got ${gotO} state pushes, the stalled client ${gotD}`);
    check('16 a client that stopped reading misses pushes yet ends on the same latest state as a client that kept up',
      settled !== null && gotO >= 20 && gotD < gotO / 2, `${gotD} vs ${gotO}`);
    D.ws.close();
    O.ws.close();
    // the real pipeline again
    await host.evaluate('window.remoteControlController.lastSentJson = null; window.remoteControlController.schedulePublish(); true');
    check('16 and the host publishes its real pipeline again', await waitFor(async () => (await hostSnap()).pipeline.length === 3, 5000, 100) !== null);
  }

  // ---- 22. WebKit (the owner's iPhone runs Safari) -----------------------------------------------------------------------
  {
    out('  ... 22. WebKit');
    let engine = null;
    try {
      const { webkit } = require('playwright');
      if (fs.existsSync(webkit.executablePath())) engine = webkit;
    } catch (_) { /* not installed */ }
    if (!engine) skip('22 WebKit repeat of checks 2-4', 'Playwright WebKit is not installed (npx playwright install webkit)');
    else {
      const wk = await engine.launch();
      browsers.push(wk);
      const freshToken = (await panel.evaluate('remotePanel.getStatus()')).token;
      const errorsBefore = consoleErrors.length;
      const W = await openClientPage('WK', '127.0.0.1', { engine: wk, token: freshToken });
      const info = await evalIn(W, () => ({
        search: location.search,
        token: localStorage.getItem('effetune.remote.token'),
        audioContexts: window.__audioContexts,
        status: document.getElementById('remoteStatus').textContent
      }));
      check('22 WebKit bootstrap: the WebSocket is not blocked by the CSP, token stored and stripped, connected',
        info.search === '' && info.token === freshToken && info.audioContexts === 0 && info.status === 'Connected', JSON.stringify(info));
      check('22 WebKit shows the host\'s pipeline', await sameAsHost(W));
      await host.evaluate(`(() => { const p = window.audioManager.pipeline[0]; p.setParameters({ vl: -13 });
        window.pipelineManager.core.updateWorkletPlugin(p); window.uiManager.updateURL(); })()`);
      const t1 = await waitFor(async () => (await snap(W)).pipeline[0].vl === -13, 1500);
      check('22 a host edit reaches the WebKit page within 500 ms', t1 !== null && t1 <= 500, `${t1} ms`);
      await W.page.locator('.pipeline-item').first().locator('input[type=range]').first().evaluate((el) => {
        el.value = '-8';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const th = await waitFor(async () => (await hostSnap()).pipeline[0].vl === -8, 1500);
      check('22 a slider edit in WebKit reaches the host within 500 ms', th !== null && th <= 500, `${th} ms`);
      await gesture(W);
      await evalIn(W, () => { window.uiManager.pluginListManager.addPluginToPipeline({ name: 'Mute' }); });
      const added = await waitFor(async () => (await hostSnap()).pipeline.length === 4 && await sameAsHost(W), 3000);
      check('22 adding a plugin in WebKit reaches the host with the client\'s id', added !== null);
      const wkErrors = consoleErrors.slice(errorsBefore).filter((e) => e.startsWith('WK') && !/favicon/i.test(e));
      check('22 WebKit raised no console error or page error', wkErrors.length === 0, JSON.stringify(wkErrors.slice(0, 4)));
      await W.context.close();
    }
  }
}

let failed = false;
process.on('unhandledRejection', (error) => {
  failed = true;
  out(`ERROR (unhandled rejection): ${error?.stack || error}`);
});
try {
  await main();
} catch (error) {
  failed = true;
  out(`ERROR: ${error?.stack || error}`);
} finally {
  cleanup();
  await sleep(500);
}
const passed = results.filter((r) => r.ok).length;
for (const line of consoleErrorsAll.slice(0, 20)) out(`  console error: ${line}`);
out(`\nSYNC SUMMARY: ${passed}/${results.length} checks passed${failed ? ' (run aborted by an error)' : ''}`);
process.exit(failed || passed !== results.length ? 1 : 0);
