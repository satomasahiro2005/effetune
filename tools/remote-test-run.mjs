// End-to-end test of the PoC remote control. Launches the fork in an isolated
// user-data dir on its own port (47310, so a normal instance on 47300 is left
// alone), runs tools/remote-test-client.mjs, then drives the Settings panel
// (toggle, token regeneration, QR) and checks that the settings persist across
// restarts. Kills only the Electron process trees it started. Logs go to .poc-logs/.
//   node tools/remote-test-run.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connect, mainWindowSession, waitForTarget } from './remote-test-cdp.mjs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, '.poc-logs');
const userData = path.join(logDir, 'userdata');
const configPath = path.join(userData, 'config.json');
const token = 'poctoken';
const port = 47310;
const cdpPort = 9339;
const inspectPort = 9340;
fs.mkdirSync(userData, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed one short-format and one long-format preset so getPreset is exercised.
fs.writeFileSync(path.join(userData, 'effetune_presets.json'), JSON.stringify({
  'Seed Short': { plugins: [{ nm: 'Volume', en: true, vl: -20 }] },
  'Seed Long': {
    name: 'Seed Long',
    pipeline: [{ name: 'Volume', enabled: true, parameters: { vl: -25 } }]
  }
}));

const electronExe = path.join(root, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const started = [];
function launch(label, { forced }) {
  const appLog = fs.openSync(path.join(logDir, `app-${label}.log`), 'w');
  const env = { ...process.env, EFFETUNE_REMOTE_PORT: String(port), ELECTRON_ENABLE_LOGGING: '1' };
  delete env.EFFETUNE_REMOTE;
  delete env.EFFETUNE_REMOTE_TOKEN;
  const args = ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`];
  if (forced) {
    env.EFFETUNE_REMOTE = '1';
    env.EFFETUNE_REMOTE_TOKEN = token;
    args.push('--remote');
  }
  const child = spawn(electronExe, args, { cwd: root, env, stdio: ['ignore', appLog, appLog], windowsHide: false });
  child.exited = false;
  child.on('exit', (code) => { child.exited = true; console.log(`[${label}] electron exited (${code})`); });
  started.push(child);
  console.log(`[${label}] launched electron pid ${child.pid}`);
  return child;
}

function killTree(child) {
  if (!child || child.exited) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid); } catch (_) { child.kill('SIGKILL'); }
  }
}
async function stop(child) {
  killTree(child);
  for (let i = 0; i < 40 && !child.exited; i++) await sleep(250);
  // Let the ports drain before the next launch.
  for (let i = 0; i < 40 && (await portOpen(port) || await portOpen(cdpPort)); i++) await sleep(250);
}
process.on('SIGINT', () => { started.forEach(killTree); process.exit(130); });

function portOpen(p) {
  return new Promise((resolve) => {
    const s = net.connect(p, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
async function waitPort(p, open, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen(p) === open) return true;
    await sleep(300);
  }
  return false;
}

// Opens a client and resolves { ws, hello } or { closeCode } if the server closes it.
function tryClient(t) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?t=${encodeURIComponent(t)}`);
    const inbox = [];
    ws.closed = new Promise((res) => ws.once('close', (code) => res(code)));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      if (m.op === 'state' && m.seq === 1) resolve({ ws, hello: m });
    });
    ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', v: 1, seq: 1 })));
    ws.on('close', (code) => resolve({ closeCode: code }));
    ws.on('error', () => {});
    setTimeout(() => resolve({ timeout: true }), 25000);
  });
}

const readConfig = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } };

async function openPanel() {
  // Same call as Settings > Remote Control..., made in the main process via --inspect.
  const target = await waitForTarget(inspectPort, () => true);
  const main = await connect(target.webSocketDebuggerUrl);
  const hostModule = JSON.stringify(path.join(root, 'electron', 'remote-control-host.cjs'));
  const opened = await main.evaluate(
    `!!process.mainModule.require(${hostModule}).openRemoteControlPanel()`);
  main.close();
  const page = await waitForTarget(cdpPort, (t) => t.type === 'page' && /remote-control-panel\.html/.test(t.url));
  const panel = await connect(page.webSocketDebuggerUrl);
  // wait for the first status render
  for (let i = 0; i < 40; i++) {
    if (await panel.evaluate(`(document.getElementById('status')?.textContent || '').length > 0`)) break;
    await sleep(250);
  }
  return { opened, panel };
}

async function screenshot(panel, file) {
  const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(logDir, file), Buffer.from(shot.data, 'base64'));
  console.log(`saved .poc-logs/${file}`);
}

let child = null;
try {
  // ---- phase 1: forced on (env), full protocol test, then the panel ----------
  child = launch('forced', { forced: true });
  if (!(await waitPort(port, true))) throw new Error('server never came up; see .poc-logs/app-forced.log');
  console.log('server is up; running the client');
  const clientLog = path.join(logDir, 'client-run.log');
  let clientExit = 1;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = spawnSync(process.execPath, ['tools/remote-test-client.mjs', `127.0.0.1:${port}/${token}`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, REMOTE_TEST_CDP: String(cdpPort) }, maxBuffer: 256 * 1024 * 1024
    });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(clientLog, out);
    process.stdout.write(out.split('\n').filter((l) => /^(CHECK|SUMMARY|FAILED|VERIFIED|ERROR|NOTE)/.test(l)).join('\n') + '\n');
    clientExit = r.status ?? 1;
    if (clientExit === 0 || !/renderer-unavailable|timeout|ECONNREFUSED|CDP target not found/.test(out)) break;
    console.log(`attempt ${attempt} failed early (renderer not ready?), retrying in 4s`);
    await sleep(4000);
  }
  check('protocol client (see client-run.log)', clientExit === 0);

  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' });
    const title = (ps.stdout || '').trim();
    check('window title carries the connect string', new RegExp(` Remote \\d+\\.\\d+\\.\\d+\\.\\d+:${port}/${token}`).test(title), title);
  }

  const { opened, panel } = await openPanel();
  check('Settings panel opens', opened === true);
  let status = await panel.evaluate('remotePanel.getStatus()');
  const urlRe = new RegExp(`^effectdeck://remote\\?h=(\\d+\\.\\d+\\.\\d+\\.\\d+):${port}&t=${token}$`);
  check('panel status: running with pairing URL effectdeck://remote?h=<ip>:port&t=token',
    status.running === true && urlRe.test(status.url), status.url);
  check('panel status: QR image for every offered address',
    status.addresses.length >= 1 && status.addresses.every((a) => /^data:image\/svg\+xml;base64,/.test(a.qr || '')),
    status.addresses.map((a) => `${a.address} (${a.name})`).join(', '));
  const dom = await panel.evaluate(`({ url: document.getElementById('url').textContent,
    qr: (document.getElementById('qr').getAttribute('src') || '').slice(0, 30),
    qrWidth: document.getElementById('qr').naturalWidth,
    hidden: document.getElementById('pairing').hidden,
    checked: document.getElementById('enabled').checked,
    status: document.getElementById('status').textContent })`);
  check('panel shows the switch on, the QR and the same text', dom.checked && !dom.hidden && dom.url === status.url &&
    dom.qr.startsWith('data:image/svg+xml') && dom.qrWidth > 0, JSON.stringify(dom));
  await screenshot(panel, 'panel-on.png');

  // Toggle off: clients are closed and the port is released.
  const c1 = await tryClient(token);
  check('client connects before toggling off', !!c1.hello, JSON.stringify(c1.closeCode ?? ''));
  status = await panel.evaluate('remotePanel.setEnabled(false)');
  const c1Close = await Promise.race([c1.ws?.closed, sleep(5000).then(() => 'no-close')]);
  check('toggle off closes connected clients', c1Close === 1001, String(c1Close));
  check('toggle off releases the port', await waitPort(port, false, 5000));
  check('toggle off persisted (remoteControlEnabled false)', readConfig().remoteControlEnabled === false && status.running === false);
  await sleep(300); // let the switch animation finish
  await screenshot(panel, 'panel-off.png');

  // Toggle on again.
  status = await panel.evaluate('remotePanel.setEnabled(true)');
  check('toggle on listens again', status.running === true && await waitPort(port, true, 5000));
  // Off and on sent back to back: the later "on" must win.
  const rapid = await panel.evaluate('Promise.all([remotePanel.setEnabled(false), remotePanel.setEnabled(true)]).then(r => r[1])');
  check('rapid off+on ends running', rapid.running === true && rapid.enabled === true &&
    await waitPort(port, true, 5000) && readConfig().remoteControlEnabled === true, JSON.stringify({ running: rapid.running, enabled: rapid.enabled }));
  const c2 = await tryClient(token);
  check('client connects after toggling on', !!c2.hello);

  // Regenerate the token.
  status = await panel.evaluate('remotePanel.regenerateToken()');
  const newToken = status.token;
  const c2Close = await Promise.race([c2.ws?.closed, sleep(5000).then(() => 'no-close')]);
  check('new token: connected clients are closed with 4401', newToken !== token && c2Close === 4401, `${newToken} ${c2Close}`);
  const oldTry = await tryClient(token);
  check('new token: old token rejected (4401)', oldTry.closeCode === 4401, JSON.stringify(oldTry.closeCode));
  const newTry = await tryClient(newToken);
  check('new token: accepted', !!newTry.hello);
  newTry.ws?.close();
  const cfg = readConfig();
  check('new token and enabled state persisted in config.json',
    cfg.remoteControlToken === newToken && cfg.remoteControlEnabled === true, JSON.stringify({
      remoteControlEnabled: cfg.remoteControlEnabled, remoteControlToken: cfg.remoteControlToken }));
  check('panel URL uses the new token', status.url.endsWith(`&t=${newToken}`), status.url);
  await sleep(300);
  await screenshot(panel, 'panel-new-token.png');
  panel.close();
  await stop(child);

  // ---- phase 2: no env override; the saved setting starts the server ---------
  child = launch('persisted-on', { forced: false });
  check('restart without override: server starts from the saved setting', await waitPort(port, true));
  const p2 = await tryClient(newToken);
  check('restart without override: saved token accepted', !!p2.hello, JSON.stringify(p2.closeCode ?? p2.timeout ?? ''));
  p2.ws?.close();
  await stop(child);

  // ---- phase 3: saved as off -> no server ------------------------------------
  fs.writeFileSync(configPath, JSON.stringify({ ...readConfig(), remoteControlEnabled: false }, null, 2));
  child = launch('persisted-off', { forced: false });
  const session = await mainWindowSession(cdpPort);
  for (let i = 0; i < 60; i++) {
    if (await session.evaluate('!!window.remoteControlController').catch(() => false)) break;
    await sleep(500);
  }
  const bridge = await session.evaluate('!!window.remoteControlController && window.remoteControlController.active === false');
  session.close();
  check('saved as off: renderer bridge idle', bridge === true);
  check('saved as off: port stays closed', !(await portOpen(port)));
  await stop(child);
} catch (error) {
  console.log('RUN ERROR:', error.stack || error.message);
  check('run completed', false, error.message);
} finally {
  started.forEach(killTree);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nRUN SUMMARY: ${results.length - failed.length}/${results.length} launcher checks passed`);
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
