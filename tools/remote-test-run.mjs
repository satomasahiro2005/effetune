// Launches the fork with remote control enabled in an isolated user-data dir,
// waits for the server, runs tools/remote-test-client.mjs, then kills only the
// Electron process tree it started. Logs go to .poc-logs/.
//   node tools/remote-test-run.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, '.poc-logs');
const userData = path.join(logDir, 'userdata');
const token = 'poctoken';
const port = 47300;
fs.mkdirSync(userData, { recursive: true });

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
const appLog = fs.openSync(path.join(logDir, 'app.log'), 'w');
const child = spawn(electronExe, ['.', '--remote', `--user-data-dir=${userData}`], {
  cwd: root,
  env: { ...process.env, EFFETUNE_REMOTE: '1', EFFETUNE_REMOTE_TOKEN: token, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', appLog, appLog],
  windowsHide: false
});
console.log(`launched electron pid ${child.pid}`);
let exited = false;
child.on('exit', (code) => { exited = true; console.log(`electron exited (${code})`); });

function killTree() {
  if (exited) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid); } catch (_) { child.kill('SIGKILL'); }
  }
}
process.on('SIGINT', () => { killTree(); process.exit(130); });

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

let exitCode = 1;
try {
  const deadline = Date.now() + 90000;
  for (;;) {
    if (await portOpen() || exited || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await portOpen())) throw new Error('server never came up; see .poc-logs/app.log');
  console.log('server is up; waiting for the renderer to finish starting');

  // Retry the client until the renderer is ready (first ops answer "renderer-unavailable" before that).
  const clientLog = path.join(logDir, 'client-run.log');
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = spawnSync(process.execPath, ['tools/remote-test-client.mjs', `127.0.0.1:${port}/${token}`], {
      cwd: root, encoding: 'utf8', env: process.env
    });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(clientLog, out);
    process.stdout.write(out);
    exitCode = r.status ?? 1;
    if (exitCode === 0 || !/renderer-unavailable|timeout|ECONNREFUSED/.test(out)) break;
    console.log(`attempt ${attempt} failed early (renderer not ready?), retrying in 4s`);
    await new Promise((r2) => setTimeout(r2, 4000));
  }
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' });
    const title = (ps.stdout || '').trim();
    console.log(`MAIN WINDOW TITLE: ${title}`);
    console.log(`CHECK ${/ Remote \d+\.\d+\.\d+\.\d+:47300\/poctoken/.test(title) ? 'PASS' : 'FAIL'}: window title carries the connect string`);
    if (!/ Remote \d+\.\d+\.\d+\.\d+:47300\/poctoken/.test(title)) exitCode = 1;
  }
} catch (error) {
  console.log('RUN ERROR:', error.message);
} finally {
  killTree();
}
process.exit(exitCode);
