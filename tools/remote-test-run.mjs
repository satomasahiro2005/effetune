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

const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const electronExe = process.platform === 'win32' ? path.join(electronDist, 'electron.exe')
  : process.platform === 'darwin' ? path.join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : path.join(electronDist, 'electron');

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
  const child = spawn(electronExe, args, { cwd: root, env, stdio: ['ignore', appLog, appLog], windowsHide: false,
    detached: process.platform !== 'win32' }); // own process group so killTree reaches the helpers
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
function tryClient(t, p = port, info = { app: 'remote-test', version: '9.9.9', build: 'b1xyz' }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/?t=${encodeURIComponent(t)}`);
    const inbox = [];
    ws.closed = new Promise((res) => ws.once('close', (code) => res(code)));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      if (m.op === 'state' && m.seq === 1) resolve({ ws, hello: m });
    });
    ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', v: 1, seq: 1, ...info })));
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

// State of the Effect Pipeline toolbar icon, read from the main window.
async function readIcon(session) {
  return session.evaluate(`(() => {
    const b = document.getElementById('remoteControlButton');
    const badge = document.getElementById('remoteControlBadge');
    const r = b.getBoundingClientRect();
    const sib = document.getElementById('shareButton').getBoundingClientRect();
    return { state: b.dataset.state, title: b.title, badge: badge.hidden ? '' : badge.textContent,
      visible: !b.hidden && r.width > 0, inHeader: !!b.closest('.pipeline-header'),
      height: Math.round(r.height), shareHeight: Math.round(sib.height) };
  })()`);
}
async function waitIcon(session, want, ms = 8000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await readIcon(session);
    if (last.state === want.state && last.badge === (want.badge ?? '')) return last;
    await sleep(200);
  }
  return last;
}
async function shotHeader(session, file) {
  const box = await session.evaluate(`(() => { const r = document.querySelector('.pipeline-header').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const shot = await session.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } });
  fs.writeFileSync(path.join(logDir, file), Buffer.from(shot.data, 'base64'));
  console.log(`saved .poc-logs/${file}`);
}
function windowTitle(child) {
  if (process.platform !== 'win32') return '';
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' });
  return (ps.stdout || '').trim();
}
// A dummy listener standing in for a stale instance that still holds the port.
function occupy(p) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => sock.destroy());
    srv.once('error', reject);
    srv.listen(p, '0.0.0.0', () => resolve(srv));
  });
}
const closeServer = (srv) => new Promise((resolve) => srv.close(() => resolve()));
async function waitLog(file, re, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (re.test(fs.readFileSync(file, 'utf8'))) return true; } catch (_) { /* not yet */ }
    await sleep(100);
  }
  return false;
}

let child = null;
let dummy = null;
{
  // Host-side push caps, without Electron.
  const r = spawnSync(process.execPath, ['tools/remote-test-telemetry-caps.mjs'], { cwd: root, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(logDir, 'telemetry-caps.log'), out);
  process.stdout.write(out.split('\n').filter((l) => /^(CHECK|SUMMARY)/.test(l)).join('\n') + '\n');
  check('telemetry push caps (see telemetry-caps.log)', r.status === 0);
}
try {
  // ---- phase 1: forced on (env), full protocol test, then the panel ----------
  child = launch('forced', { forced: true });
  if (!(await waitPort(port, true))) throw new Error('server never came up; see .poc-logs/app-forced.log');
  console.log('server is up; running the client');
  const clientLog = path.join(logDir, 'client-run.log');
  let clientExit = 1;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = spawnSync(process.execPath, ['tools/remote-test-client.mjs', `127.0.0.1:${port}/${token}`], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, REMOTE_TEST_CDP: String(cdpPort), REMOTE_TEST_INSPECT: String(inspectPort) },
      maxBuffer: 256 * 1024 * 1024
    });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(clientLog, out);
    process.stdout.write(out.split('\n').filter((l) => /^(CHECK|SUMMARY|FAILED|VERIFIED|ERROR|NOTE|MEASURE)/.test(l)).join('\n') + '\n');
    clientExit = r.status ?? 1;
    if (clientExit === 0 || !/renderer-unavailable|timeout|ECONNREFUSED|CDP target not found/.test(out)) break;
    console.log(`attempt ${attempt} failed early (renderer not ready?), retrying in 4s`);
    await sleep(4000);
  }
  check('protocol client (see client-run.log)', clientExit === 0);
  if (process.env.REMOTE_TEST_ONLY) throw new Error('stop'); // quick run: client only

  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' });
    const title = (ps.stdout || '').trim();
    check('window title carries the connect string', new RegExp(` Remote Control \\d+\\.\\d+\\.\\d+\\.\\d+:${port}/${token}`).test(title), title);
  }

  const { opened, panel } = await openPanel();
  check('Settings panel opens', opened === true);
  let status = await panel.evaluate('remotePanel.getStatus()');
  const urlRe = new RegExp(`^ws://(\\d+\\.\\d+\\.\\d+\\.\\d+):${port}/\\?t=${token}$`);
  check('panel status: running with pairing URL ws://<ip>:port/?t=token',
    status.running === true && urlRe.test(status.url), status.url);
  const dom = await panel.evaluate(`({ url: document.getElementById('url').textContent,
    qr: (document.getElementById('qr').getAttribute('src') || '').slice(0, 30),
    qrWidth: document.getElementById('qr').naturalWidth,
    hidden: document.getElementById('pairing').hidden,
    checked: document.getElementById('enabled').checked,
    status: document.getElementById('status').textContent })`);
  // One link and one QR for every client: the http URL the app serves (apps derive ws:// from it).
  const webRe = new RegExp(`^http://(\\d+\\.\\d+\\.\\d+\\.\\d+):${port}/\\?t=${token}$`);
  check('panel status: webUrl http://<ip>:port/?t=token next to the ws url', webRe.test(status.webUrl || ''), status.webUrl);
  check('panel status: a QR image for the link of every offered address',
    status.addresses.every((a) => /^data:image\/svg\+xml;base64,/.test(a.webQr || '') && webRe.test(a.webUrl)),
    status.addresses.map((a) => a.webUrl).join(', '));
  check('panel shows the switch on, the QR and the http link', dom.checked && !dom.hidden && dom.url === status.webUrl &&
    dom.qr.startsWith('data:image/svg+xml') && dom.qrWidth > 0, JSON.stringify(dom));
  const noModes = await panel.evaluate(`({ app: !!document.getElementById('mode-app'),
    browser: !!document.getElementById('mode-browser'),
    text: /\\bApp\\b/.test([...document.querySelectorAll('button')].map((b) => b.textContent).join(' ')),
    select: getComputedStyle(document.getElementById('url')).userSelect })`);
  check('no Browser/App control; the link text is selectable',
    !noModes.app && !noModes.browser && !noModes.text && /^(all|text)$/.test(noModes.select), JSON.stringify(noModes));
  await screenshot(panel, 'panel-on.png');
  // Copy link: Electron's clipboard in the main process, read back from the main process.
  const readClipboard = async () => {
    const target = await waitForTarget(inspectPort, () => true);
    const main = await connect(target.webSocketDebuggerUrl);
    const text = await main.evaluate(`process.mainModule.require('electron').clipboard.readText()`);
    main.close();
    return text;
  };
  {
    const target = await waitForTarget(inspectPort, () => true);
    const main = await connect(target.webSocketDebuggerUrl);
    await main.evaluate(`process.mainModule.require('electron').clipboard.writeText('sentinel')`);
    main.close();
  }
  await panel.evaluate(`document.getElementById('copy').click()`);
  await sleep(500);
  const copiedText = await readClipboard();
  const copyLabel = await panel.evaluate(`document.getElementById('copy').textContent`);
  check('Copy link puts the http URL on the clipboard and shows Copied',
    copiedText === status.webUrl && copyLabel === 'Copied', JSON.stringify({ copiedText, copyLabel }));
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const pageText = await page.text();
  check('GET / on the remote port serves remote.html with a connect-src for its own host',
    page.status === 200 && /EffeTune Remote/.test(pageText) &&
    page.headers.get('content-security-policy') === `connect-src 'self' ws://127.0.0.1:${port}`,
    `${page.status} ${page.headers.get('content-security-policy')}`);
  const refused = await fetch(`http://127.0.0.1:${port}/config.json`);
  check('files outside the precache list are not served', refused.status === 404, String(refused.status));

  // Toggle off: clients are closed and the port is released.
  const c1 = await tryClient(token);
  check('client connects before toggling off', !!c1.hello, JSON.stringify(c1.closeCode ?? ''));
  // Version visibility: hello reply names the host build; the panel lists each client's app/version.
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  check('hello reply lists the sync1 feature next to the old ones',
    ['origin', 'savePreset', 'irSync', 'telemetry', 'overlays', 'sync1'].every((f) => (c1.hello.features || []).includes(f)),
    JSON.stringify(c1.hello.features));
  check('hello reply carries appName, app (version) and a git-sha build',
    c1.hello.appName === 'EffeTune' && c1.hello.app === appVersion && /^[0-9a-f]{7,}$/.test(c1.hello.build || ''),
    JSON.stringify({ appName: c1.hello.appName, app: c1.hello.app, build: c1.hello.build }));
  check('hello reply carries the effect names and the dsp version of this tree',
    Array.isArray(c1.hello.effects) && c1.hello.effects.includes('Volume') &&
    c1.hello.dsp === JSON.parse(fs.readFileSync(path.join(root, 'dsp', 'bindings', 'js', 'package.json'), 'utf8')).version,
    JSON.stringify({ n: c1.hello.effects?.length, dsp: c1.hello.dsp }));
  const deviceTexts = () => panel.evaluate(`[...document.querySelectorAll('#devices li')].map(li => li.textContent)`);
  let devs = (await panel.evaluate('remotePanel.getStatus()')).devices || [];
  check('panel status lists the client app/version with control characters stripped',
    devs.length === 1 && devs[0].app === 'remote-test' && devs[0].version === '9.9.9' && devs[0].build === 'b1xyz',
    JSON.stringify(devs));
  let texts = await deviceTexts();
  check('panel DOM lists "remote-test 9.9.9 (b1xyz) · <address>"',
    texts.length === 1 && texts[0].startsWith('remote-test 9.9.9 (b1xyz) · '), JSON.stringify(texts));
  const cOld = await tryClient(token, port, {});
  const cLong = await tryClient(token, port, { app: 'A'.repeat(200), version: 7 });
  check('old client without app info still gets features, and is listed as an unknown app',
    Array.isArray(cOld.hello?.features) && cOld.hello.features.includes('telemetry'), JSON.stringify(cOld.hello?.features));
  devs = (await panel.evaluate('remotePanel.getStatus()')).devices || [];
  check('panel status: unknown app has null fields; 200-char app cut to 48; non-string version ignored',
    devs.length === 3 && devs.some((d) => d.app === null && d.version === null) &&
    devs.some((d) => d.app === 'A'.repeat(48) && d.version === null), JSON.stringify(devs.map((d) => d.app && d.app.length)));
  texts = await deviceTexts();
  check('panel DOM shows "Unknown app · <address>" for the old client', texts.some((x) => /^Unknown app · /.test(x)), JSON.stringify(texts));
  cOld.ws.close(); cLong.ws.close();
  const main1 = await mainWindowSession(cdpPort);
  let icon = await waitIcon(main1, { state: 'connected', badge: '1' });
  check('pipeline header icon: connected with badge 1, in the Effect Pipeline header, same height as its neighbours',
    icon.state === 'connected' && icon.badge === '1' && icon.visible && icon.inHeader && icon.height === icon.shareHeight &&
    /1 device connected \(port \d+\)/.test(icon.title), JSON.stringify(icon));
  await shotHeader(main1, 'header-connected.png');
  status = await panel.evaluate('remotePanel.setEnabled(false)');
  const c1Close = await Promise.race([c1.ws?.closed, sleep(5000).then(() => 'no-close')]);
  check('toggle off closes connected clients', c1Close === 1001, String(c1Close));
  check('toggle off releases the port', await waitPort(port, false, 5000));
  check('toggle off persisted (remoteControlEnabled false)', readConfig().remoteControlEnabled === false && status.running === false);
  icon = await waitIcon(main1, { state: 'off' });
  check('pipeline header icon: off after toggling off', icon.state === 'off' && icon.badge === '' && icon.title === 'Remote Control', JSON.stringify(icon));
  await shotHeader(main1, 'header-off.png');
  await sleep(300); // let the switch animation finish
  await screenshot(panel, 'panel-off.png');

  // Toggle on again.
  status = await panel.evaluate('remotePanel.setEnabled(true)');
  check('toggle on listens again', status.running === true && await waitPort(port, true, 5000));
  icon = await waitIcon(main1, { state: 'listening' });
  check('pipeline header icon: listening after toggling on', icon.state === 'listening' && icon.badge === '', JSON.stringify(icon));
  await shotHeader(main1, 'header-listening.png');
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
  check('panel URL uses the new token', status.url.endsWith(`/?t=${newToken}`), status.url);
  await sleep(300);
  await screenshot(panel, 'panel-new-token.png');
  panel.close();
  main1.close();
  await stop(child);

  // ---- phase 2: no env override; the saved setting starts the server ---------
  child = launch('persisted-on', { forced: false });
  check('restart without override: server starts from the saved setting', await waitPort(port, true));
  const p2 = await tryClient(newToken);
  check('restart without override: saved token accepted', !!p2.hello, JSON.stringify(p2.closeCode ?? p2.timeout ?? ''));
  p2.ws?.close();
  const main2 = await mainWindowSession(cdpPort);
  await waitIcon(main2, { state: 'listening' });
  await main2.evaluate(`document.getElementById('remoteControlButton').click()`);
  let clickOpened = false;
  try {
    await waitForTarget(cdpPort, (t) => t.type === 'page' && /remote-control-panel\.html/.test(t.url), 8000);
    clickOpened = true;
  } catch (_) { /* not opened */ }
  check('clicking the pipeline header icon opens the Remote Control window', clickOpened);
  main2.close();
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

  // ---- phase 4: the port is held by something else -> fall back to the next one
  const fallbackPort = port + 1;
  fs.writeFileSync(configPath, JSON.stringify({ ...readConfig(), remoteControlEnabled: true }, null, 2));
  dummy = await occupy(port);
  child = launch('port-busy', { forced: true });
  const busyLog = path.join(logDir, 'app-port-busy.log');
  check('busy port: fallback port comes up', await waitPort(fallbackPort, true, 90000));
  check('busy port: the dummy still owns the original port', await portOpen(port));
  const fb = await tryClient(token, fallbackPort);
  check('busy port: a client connects on the fallback port', !!fb.hello, JSON.stringify(fb.closeCode ?? fb.timeout ?? ''));
  fb.ws?.close();
  const busyText = fs.readFileSync(busyLog, 'utf8');
  check('busy port: retried the same port before falling back (log)',
    /port 47310 is in use \(attempt 4\/4\)/.test(busyText) && busyText.includes(`using ${fallbackPort} instead`));
  const busyTitle = windowTitle(child);
  check('busy port: window title advertises the bound port',
    process.platform !== 'win32' || new RegExp(` Remote Control \\d+\\.\\d+\\.\\d+\\.\\d+:${fallbackPort}/${token}`).test(busyTitle), busyTitle);
  const busyPanel = await openPanel();
  const busyStatus = await busyPanel.panel.evaluate('remotePanel.getStatus()');
  check('busy port: pairing URL, connect string and status use the bound port',
    busyStatus.port === fallbackPort && busyStatus.requestedPort === port &&
    busyStatus.url.includes(`:${fallbackPort}/?t=`) && busyStatus.connectString.includes(`:${fallbackPort}/`) &&
    busyStatus.addresses.every((a) => a.url.includes(`:${fallbackPort}/?t=`)),
    JSON.stringify({ port: busyStatus.port, url: busyStatus.url }));
  const busyDom = await busyPanel.panel.evaluate(`document.getElementById('status').textContent`);
  check('busy port: the Remote Control window shows the actual port', busyDom.includes(`port ${fallbackPort}`), busyDom);
  await screenshot(busyPanel.panel, 'panel-fallback.png');
  busyPanel.panel.close();
  const main4 = await mainWindowSession(cdpPort);
  icon = await waitIcon(main4, { state: 'listening' });
  check('busy port: header icon tooltip shows the bound port', icon.title.includes(`port ${fallbackPort}`), icon.title);
  main4.close();
  await closeServer(dummy);
  dummy = null;
  await stop(child);

  // ---- phase 5: the port is released while retrying -> the same port is used
  dummy = await occupy(port);
  child = launch('port-retry', { forced: true });
  const retryLog = path.join(logDir, 'app-port-retry.log');
  check('retry: first attempt hit the busy port', await waitLog(retryLog, /port 47310 is in use \(attempt 1\/4\)/));
  await closeServer(dummy);
  dummy = null;
  check('retry: the original port is taken once released', await waitPort(port, true, 15000));
  check('retry: no fallback was used', !(await portOpen(fallbackPort)));
  await stop(child);
} catch (error) {
  if (!(process.env.REMOTE_TEST_ONLY && error.message === 'stop')) {
    console.log('RUN ERROR:', error.stack || error.message);
    check('run completed', false, error.message);
  }
} finally {
  started.forEach(killTree);
  try { dummy?.close(); } catch (_) { /* ignore */ }
}
const failed = results.filter((r) => !r.ok);
console.log(`\nRUN SUMMARY: ${results.length - failed.length}/${results.length} launcher checks passed`);
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
