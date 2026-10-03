'use strict';

// PoC: LAN remote control ("remote-v1"). Client-neutral; see docs/remote-v1.md.
//
// The WebSocket server lives in the main process (the renderer CSP forbids
// ws:). Every client operation is forwarded to the renderer over versioned
// IPC channels (same shape as openhome-v1) and answered from there, because the
// pipeline, the preset manager and the IR library only exist in the renderer.
//
// The server is switched on and off from Settings > Remote Control... (the
// choice and a persistent token are kept in config.json). EFFETUNE_REMOTE=1 or
// --remote forces it on at startup; EFFETUNE_REMOTE_TOKEN fixes the token and
// EFFETUNE_REMOTE_PORT the first port to try (for tests). A busy port is retried
// a few times, then the next free port above it is used (47300 -> 47301..47309);
// the pairing URL, QR code, connect string and window title carry the bound port.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { createStaticHandler, isAllowedHost, isAllowedOrigin } = require('./remote-static-server.cjs');

const CHANNELS = Object.freeze({
  rendererReady: 'remote-v1:renderer-ready',
  rendererUnavailable: 'remote-v1:renderer-unavailable',
  response: 'remote-v1:response',
  state: 'remote-v1:state',
  openPanel: 'remote-v1:open-panel',
  request: 'remote-v1:request',
  status: 'remote-v1:status',
  getStatus: 'remote-v1:get-status',
  telemetry: 'remote-v1:telemetry',
  telemetryControl: 'remote-v1:telemetry-control'
});

const PANEL_CHANNELS = Object.freeze({
  getStatus: 'remote-panel-v1:get-status',
  setEnabled: 'remote-panel-v1:set-enabled',
  regenerateToken: 'remote-panel-v1:regenerate-token',
  status: 'remote-panel-v1:status'
});

const PORT = 47300;
const PORT_FALLBACK_COUNT = 9;      // 47301..47309 when 47300 stays busy
const PORT_RETRY_ATTEMPTS = 4;      // a previous instance may still be releasing the port
const PORT_RETRY_DELAY_MS = 750;
const LISTEN_RETRY_MS = 15000;     // ports busy at boot: keep trying while the switch is on
const MAX_WS_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const IR_REQUEST_TIMEOUT_MS = 120000;
const MAX_PENDING_REQUESTS = 32;
const STATE_MIN_INTERVAL_MS = 100; // <= 10 Hz
const ORIGIN_WINDOW_MS = 300;      // late snapshots still belong to the last command
const PING_INTERVAL_MS = 15000;
const RENDERER_WAIT_MS = 20000; // hold early requests until the renderer finishes startup
const SHUTDOWN_GRACE_MS = 300;  // do not let an unresponsive client delay quit
const MAX_CLIENTS = 16;
const CLOSE_UNAUTHORIZED = 4401;
const PROTOCOL_VERSION = 1;
const IR_CHUNK_BYTES = 512 * 1024;
const IR_MAX_BYTES = 64 * 1024 * 1024;
const IR_MAX_CHUNKS = Math.ceil(IR_MAX_BYTES / IR_CHUNK_BYTES);
const MAX_UPLOADS_PER_CLIENT = 2;
const SEND_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const STATE_HIGH_WATER_BYTES = 1024 * 1024; // a slower client than this misses pushes and gets the latest later
const STATE_DRAIN_BYTES = 64 * 1024;
const STATE_DIRTY_CHECK_MS = 250;
const IR_ID_PATTERN = /^[a-f0-9]{24}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const FEATURES = Object.freeze(['origin', 'savePreset', 'irSync', 'telemetry', 'overlays']);
const APP_NAME = 'EffeTune';
const CLIENT_INFO_MAX = 48;

// Client-supplied text shown in the Remote Control window: strip control characters, cap length.
function cleanClientText(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CLIENT_INFO_MAX) || null;
}

// Build id reported in the hello reply: injected sha, else git sha (unpackaged), else app.asar date.
function resolveBuild(app) {
  let appPath = '';
  try { appPath = app.getAppPath(); } catch (_) { return null; }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8'));
    const injected = cleanClientText(pkg?.effetuneBuild);
    if (injected) return injected;
  } catch (_) { /* ignore */ }
  if (!app.isPackaged) {
    try {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: appPath, timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      }).toString().trim();
      if (/^[0-9a-f]{4,40}$/.test(sha)) return sha;
    } catch (_) { /* ignore */ }
    return null;
  }
  try {
    return fs.statSync(appPath).mtime.toISOString().slice(0, 10);
  } catch (_) { return null; }
}
const CLIENT_OPS = new Set([
  'hello', 'get', 'chain', 'params', 'bypass', 'listPresets', 'getPreset',
  'savePreset', 'listIRs', 'getIR', 'putIR', 'telemetry'
]);
// Analyzer mirror (op "telemetry"): latest frame per stage and type, per client.
const TELEMETRY_DEFAULT_FPS = 15;
const TELEMETRY_MAX_FPS = 30;
const TELEMETRY_MAX_FRAMES = 64;
const TELEMETRY_MAX_RAW_BYTES = 1 << 20;
const TELEMETRY_HIGH_WATER = 512 * 1024;
const MUTATING_OPS = new Set(['chain', 'params', 'bypass']);

let activeHost = null;

function isRemoteForced(env = process.env, argv = process.argv) {
  return env.EFFETUNE_REMOTE === '1' || argv.includes('--remote');
}

// Kept for callers of the first PoC.
const isRemoteEnabled = isRemoteForced;

function isPrivateIPv4(address) {
  return address.startsWith('192.168.') || address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

const VIRTUAL_ADAPTER = /vethernet|wsl|vmware|virtualbox|hyper-v|docker|vbox|loopback|tailscale|zerotier|hamachi|vpn|wireguard|npcap|bluetooth/i;
// Adapter names are localized on Windows ("Ethernet 4"), so also match the MAC
// prefixes of VirtualBox, Hyper-V, VMware, Parallels and Docker adapters.
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|00:1c:42|02:42)/i;

function pickLanAddress(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      // 100.64.0.0/10 is carrier-grade NAT, used by Tailscale.
      const cgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr.address);
      let score = 0;
      if (addr.address.startsWith('192.168.')) score = 30;
      else if (addr.address.startsWith('10.')) score = 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)) score = 10;
      if (cgnat) score -= 40;
      const virtual = VIRTUAL_ADAPTER.test(name) || VIRTUAL_MAC.test(addr.mac || '');
      if (virtual) score -= 25;
      candidates.push({ name, address: addr.address, score, virtual: virtual || cgnat });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  // Offer every private, non-virtual address; fall back to the best guess.
  const preferred = candidates.filter(c => !c.virtual && isPrivateIPv4(c.address));
  const offered = preferred.length ? preferred : candidates.slice(0, 1);
  return {
    best: offered[0]?.address || candidates[0]?.address || '127.0.0.1',
    offered: offered.length ? offered : [{ name: 'loopback', address: '127.0.0.1', score: 0 }],
    candidates
  };
}

// The QR carries the API's own endpoint, not a link to any particular client app.
function pairingUrl(address, port, token) {
  return `ws://${address}:${port}/?t=${encodeURIComponent(token)}`;
}

function qrSvgDataUrl(text) {
  try {
    const qrcodeModule = require('qrcode-generator');
    const qrcode = qrcodeModule.default || qrcodeModule;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  } catch (error) {
    return null;
  }
}

function generateToken() {
  return crypto.randomBytes(8).toString('hex');
}

class RemoteControlHost {
  constructor({
    app,
    getMainWindow,
    config = null,
    env = process.env,
    argv = process.argv,
    log = console.log
  }) {
    this.app = app;
    this.build = resolveBuild(app);
    this.getMainWindow = getMainWindow;
    this.config = config;
    this.log = log;
    this.forced = isRemoteForced(env, argv);
    const cfg = this.loadConfig();
    this.enabled = this.forced || cfg.remoteControlEnabled === true;
    this.basePort = Number(env.EFFETUNE_REMOTE_PORT) || PORT;
    this.port = this.basePort; // the port actually bound once running
    this.tokenFromEnvironment = typeof env.EFFETUNE_REMOTE_TOKEN === 'string' &&
      env.EFFETUNE_REMOTE_TOKEN.length > 0;
    this.token = this.tokenFromEnvironment ? env.EFFETUNE_REMOTE_TOKEN : this.ensurePersistentToken(cfg);
    this.server = null;
    this.wss = null;
    this.pingTimer = null;
    this.dirtyTimer = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.listenError = null;
    this.listenRetryTimer = null;
    this.portsBusy = false;
    this.lan = null;
    this.rendererReady = false;
    this.readyWaiters = new Set();
    this.pending = new Map();
    this.requestSeq = 0;
    this.dispatchChain = Promise.resolve();
    this.lastSnapshotJson = null;
    this.snapshot = null;
    this.rev = 0;
    this.lastBroadcastAt = 0;
    this.broadcastTimer = null;
    this.pendingOrigin = null;
    this.activeCause = null;
    this.lastCause = null;
    this.connectString = null;
    this.attachedWindows = new WeakSet();
    this.panelWindow = null;
    this.disposed = false;
    this.toggleQueue = Promise.resolve();
    this.telemetryDemandJson = null; // last { on, fps } sent to the renderer
    activeHost = this;
  }

  // ---- settings ----------------------------------------------------------

  loadConfig() {
    try {
      const cfg = this.config?.loadConfig?.();
      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch (_) {
      return {};
    }
  }

  saveConfigPatch(patch) {
    if (!this.config?.saveConfig) return false;
    const next = { ...this.loadConfig(), ...patch };
    return this.config.saveConfig(next) === true;
  }

  ensurePersistentToken(cfg) {
    if (typeof cfg.remoteControlToken === 'string' && TOKEN_PATTERN.test(cfg.remoteControlToken)) {
      return cfg.remoteControlToken;
    }
    const token = generateToken();
    this.saveConfigPatch({ remoteControlToken: token });
    return token;
  }

  // Toggles run one after another: an "on" that arrived while an "off" was
  // still waiting for the listen to finish would otherwise be swallowed.
  setEnabled(enabled) {
    enabled = enabled === true;
    const run = this.toggleQueue.then(async () => {
      this.saveConfigPatch({ remoteControlEnabled: enabled });
      this.enabled = enabled;
      if (enabled) await this.start();
      else await this.stop();
      return this.getStatus();
    });
    this.toggleQueue = run.catch(() => {});
    return run;
  }

  async regenerateToken() {
    this.token = generateToken();
    this.tokenFromEnvironment = false;
    this.saveConfigPatch({ remoteControlToken: this.token });
    // Clients paired with the old token must pair again.
    if (this.wss) {
      for (const ws of this.wss.clients) {
        try { ws.close(CLOSE_UNAUTHORIZED, 'token-changed'); } catch (_) { /* ignore */ }
      }
    }
    if (this.connectString && this.lan) {
      this.connectString = `${this.lan.best}:${this.port}/${this.token}`;
      this.log(`[remote] CONNECT STRING: ${this.connectString}`);
    }
    this.emitStatus();
    return this.getStatus();
  }

  getStatus({ withQr = false } = {}) {
    const running = !!this.connectString;
    const lan = this.lan || pickLanAddress();
    const addresses = lan.offered.map(c => {
      const url = pairingUrl(c.address, this.port, this.token);
      return {
        address: c.address,
        name: c.name,
        url,
        ...(withQr ? { qr: qrSvgDataUrl(url) } : {})
      };
    });
    return {
      apiVersion: 1,
      enabled: this.enabled,
      running,
      forced: this.forced,
      port: this.port,
      requestedPort: this.basePort,
      token: this.token,
      tokenFromEnvironment: this.tokenFromEnvironment,
      connectString: this.connectString,
      addresses,
      url: addresses[0]?.url || null,
      error: this.listenError,
      clients: this.countClients(),
      devices: [...(this.wss?.clients || [])].filter(ws => ws.authenticated).map(ws => ({
        address: ws.remoteAddress || '',
        app: ws.clientInfo?.app ?? null,
        version: ws.clientInfo?.version ?? null,
        build: ws.clientInfo?.build ?? null
      }))
    };
  }

  // What the main-window toolbar icon needs: off / listening / N clients.
  getBriefStatus() {
    return {
      enabled: !!this.connectString,
      wanted: this.enabled,
      port: this.port,
      clients: this.countClients(),
      error: this.listenError
    };
  }

  countClients() {
    let count = 0;
    for (const ws of this.wss?.clients || []) if (ws.authenticated) count += 1;
    return count;
  }

  emitStatus() {
    this.refreshTitle();
    const win = this.getMainWindow();
    if (win?.webContents && !win.isDestroyed?.()) {
      try { win.webContents.send(CHANNELS.status, this.getBriefStatus()); } catch (_) { /* ignore */ }
    }
    const panel = this.panelWindow;
    if (panel && !panel.isDestroyed()) {
      try { panel.webContents.send(PANEL_CHANNELS.status, this.getStatus({ withQr: true })); } catch (_) { /* ignore */ }
    }
  }

  // ---- server lifecycle --------------------------------------------------

  start() {
    if (!this.enabled || this.disposed) return Promise.resolve(false);
    if (this.startPromise) return this.startPromise;
    const previousStop = this.stopPromise || Promise.resolve();
    this.startPromise = previousStop.then(() => this.listen());
    return this.startPromise;
  }

  listen() {
    if (!this.enabled || this.disposed) {
      this.startPromise = null;
      return false;
    }
    this.clearListenRetry();
    const lan = pickLanAddress();
    this.lan = lan;
    this.listenError = null;
    this.port = this.basePort;
    // Plain http on the same port serves the browser client (remote.html).
    const staticHandler = createStaticHandler({
      root: path.resolve(__dirname, '..'),
      log: (...args) => this.log(...args)
    });
    const server = http.createServer((req, res) => {
      try {
        staticHandler(req, res);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error\n');
      }
    });
    const wss = new WebSocketServer({
      server,
      maxPayload: MAX_WS_BYTES,
      // Browsers attach Origin: refuse pages that are not this server itself.
      // Non-browser clients (EffectDeck, scripts) send no Origin.
      verifyClient: (info, done) => {
        const { headers } = info.req;
        const ok = isAllowedHost(headers.host) && isAllowedOrigin(headers.origin, headers.host);
        if (ok) {
          done(true);
        } else {
          this.log(`[remote] refused upgrade from ${info.req.socket.remoteAddress} (host/origin)`);
          done(false, 403, 'Forbidden');
        }
      }
    });
    this.server = server;
    this.wss = wss;
    wss.on('connection', (ws, req) => this.onConnection(ws, req));
    wss.on('error', error => this.log('[remote] wss error:', error.message));
    this.pingTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) { /* ignore */ }
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.dirtyTimer = setInterval(() => this.flushDirtyClients(), STATE_DIRTY_CHECK_MS);
    this.dirtyTimer.unref?.();
    return this.bindWithFallback(server).then(port => {
      if (this.disposed || this.server !== server) return false;
      if (port === null) {
        if (this.portsBusy) this.scheduleListenRetry();
        this.closeServer(server, wss);
        if (this.server === server) { this.server = null; this.wss = null; }
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        clearInterval(this.dirtyTimer);
        this.dirtyTimer = null;
        this.startPromise = null;
        this.emitStatus();
        return false;
      }
      this.port = port;
      // Only advertise the connect string once the port is actually bound.
      this.connectString = `${lan.best}:${this.port}/${this.token}`;
      this.log(`[remote] listening on 0.0.0.0:${this.port}`);
      this.log(`[remote] CONNECT STRING: ${this.connectString}`);
      this.log(`[remote] PAIRING URL: ${pairingUrl(lan.best, this.port, this.token)}`);
      if (lan.candidates.length > 1) {
        this.log('[remote] other addresses: ' +
          lan.candidates.map(c => `${c.address} (${c.name})`).join(', '));
      }
      // Make the renderer publish a fresh snapshot for the new session.
      this.lastSnapshotJson = null;
      this.emitStatus();
      return true;
    });
  }

  // Binds `server`: the requested port first (retried while a previous
  // instance releases it), then the next ports up. Resolves the bound port, or
  // null with this.listenError set.
  async bindWithFallback(server) {
    const stillWanted = () => this.enabled && !this.disposed && this.server === server;
    const tryPort = port => new Promise(resolve => {
      const onError = error => { server.removeListener('listening', onListening); resolve(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(null); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
    const last = Math.min(this.basePort + PORT_FALLBACK_COUNT, 65535);
    this.portsBusy = false;
    for (let port = this.basePort; port <= last; port += 1) {
      for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt += 1) {
        if (!stillWanted()) return null;
        const error = await tryPort(port);
        if (!error) {
          if (port !== this.basePort) {
            this.log(`[remote] port ${this.basePort} is busy; using ${port} instead`);
          }
          return port;
        }
        if (error.code !== 'EADDRINUSE') {
          this.log(`[remote] server error: ${error.code || ''} ${error.message}`);
          this.listenError = String(error.message || error);
          return null;
        }
        this.log(`[remote] port ${port} is in use (attempt ${attempt}/${PORT_RETRY_ATTEMPTS})`);
        // A fallback port is not worth waiting for: a stale instance only
        // holds the requested port.
        if (port !== this.basePort) break;
        if (attempt < PORT_RETRY_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, PORT_RETRY_DELAY_MS));
        }
      }
    }
    this.listenError = `ports ${this.basePort}-${last} are all in use`;
    this.portsBusy = true;
    return null;
  }

  // Whatever held the ports (seen right after Windows boot) usually lets go
  // later, so a busy failure is retried instead of waiting for a manual toggle.
  scheduleListenRetry() {
    this.clearListenRetry();
    if (!this.enabled || this.disposed) return;
    this.listenRetryTimer = setTimeout(() => {
      this.listenRetryTimer = null;
      if (this.enabled && !this.disposed && !this.server && !this.startPromise) void this.start();
    }, LISTEN_RETRY_MS);
    this.listenRetryTimer.unref?.();
  }

  clearListenRetry() {
    clearTimeout(this.listenRetryTimer);
    this.listenRetryTimer = null;
  }

  closeServer(server, wss, { closeCode = 1001, reason = 'shutdown' } = {}) {
    return new Promise(resolve => {
      if (!wss) { resolve(); return; }
      const clients = [...wss.clients];
      for (const ws of clients) {
        try { ws.close(closeCode, reason); } catch (_) { /* ignore */ }
      }
      // wss.close() waits for every client's close handshake (up to 30 s in
      // ws); terminate stragglers so quit is not held up by a sleeping phone.
      const graceTimer = setTimeout(() => {
        for (const ws of clients) {
          try { ws.terminate(); } catch (_) { /* ignore */ }
        }
      }, SHUTDOWN_GRACE_MS);
      graceTimer.unref?.();
      wss.close(() => {
        clearTimeout(graceTimer);
        if (server?.listening) server.close(() => resolve());
        else resolve();
        server?.closeAllConnections?.();
      });
    });
  }

  async stop({ reason = 'remote-disabled' } = {}) {
    if (this.startPromise) {
      try { await this.startPromise; } catch (_) { /* ignore */ }
    }
    this.startPromise = null;
    this.clearListenRetry();
    const server = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    clearInterval(this.dirtyTimer);
    this.dirtyTimer = null;
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.pendingOrigin = null;
    if (wss) {
      for (const ws of wss.clients) this.clearTelemetry(ws);
    }
    this.sendTelemetryDemand({ on: false, fps: 0 });
    const wasRunning = !!this.connectString;
    this.connectString = null;
    // A failed listen is not an error once the switch is off.
    if (!this.enabled || reason === 'shutdown') this.listenError = null;
    if (wasRunning) this.log(`[remote] stopped (${reason})`);
    this.stopPromise = this.closeServer(server, wss, { closeCode: 1001, reason });
    await this.stopPromise;
    this.stopPromise = null;
    this.emitStatus();
  }

  // ---- window title ------------------------------------------------------

  attachWindow(win) {
    if (!win || this.attachedWindows.has(win)) return;
    this.attachedWindows.add(win);
    win.on('page-title-updated', (event, title) => {
      if (!this.connectString) return;
      event.preventDefault();
      try { win.setTitle(this.decorateTitle(title)); } catch (_) { /* ignore */ }
    });
    this.refreshTitle();
  }

  decorateTitle(title) {
    const base = String(title || 'EffeTune').replace(/ — Remote( Control)? .*$/, '');
    return this.connectString ? `${base} — Remote Control ${this.connectString}` : base;
  }

  refreshTitle() {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed?.()) return;
    try { win.setTitle(this.decorateTitle(win.getTitle())); } catch (_) { /* ignore */ }
  }

  // ---- settings panel ----------------------------------------------------

  openPanel() {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.show();
      this.panelWindow.focus();
      return this.panelWindow;
    }
    const { BrowserWindow } = require('electron');
    const parent = this.getMainWindow();
    const panel = new BrowserWindow({
      width: 460,
      height: 700,
      minWidth: 360,
      minHeight: 480,
      title: 'Remote Control',
      parent: parent && !parent.isDestroyed?.() ? parent : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'remote-control-panel-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    panel.setMenuBarVisibility(false);
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', event => event.preventDefault());
    panel.once('ready-to-show', () => panel.show());
    panel.on('closed', () => {
      if (this.panelWindow === panel) this.panelWindow = null;
    });
    this.panelWindow = panel;
    panel.loadFile(path.join(__dirname, 'remote-control-panel.html')).catch(error => {
      this.log('[remote] panel failed to load:', error?.message || error);
    });
    return panel;
  }

  isPanelSender(sender) {
    return !!this.panelWindow && !this.panelWindow.isDestroyed() && sender === this.panelWindow.webContents;
  }

  // ---- renderer bridge ---------------------------------------------------

  setRendererReady() {
    this.rendererReady = true;
    for (const waiter of [...this.readyWaiters]) waiter(true);
    // A reloaded renderer starts without a subscription; send the demand again
    // once it has had a chance to install its listener.
    this.telemetryDemandJson = null;
    setImmediate(() => this.updateTelemetryDemand());
    return { apiVersion: 1, ...this.getBriefStatus() };
  }

  waitForRenderer(ms = RENDERER_WAIT_MS) {
    if (this.rendererReady) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = ok => {
        clearTimeout(timer);
        this.readyWaiters.delete(waiter);
        resolve(ok);
      };
      const timer = setTimeout(() => waiter(false), ms);
      this.readyWaiters.add(waiter);
    });
  }

  setRendererUnavailable() {
    this.rendererReady = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'renderer-unavailable' });
      this.pending.delete(id);
    }
    return true;
  }

  handleRendererResponse(response) {
    const pending = this.pending.get(response?.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.resolve(response);
    return true;
  }

  handleRendererState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (!this.connectString) return false;
    this.ingestSnapshot(snapshot);
    return true;
  }

  async request(message, timeoutMs = REQUEST_TIMEOUT_MS) {
    // Clients that connect during startup or a window reload wait for the
    // renderer instead of failing immediately.
    if (!this.rendererReady && !(await this.waitForRenderer())) {
      return { ok: false, error: 'renderer-unavailable' };
    }
    const win = this.getMainWindow();
    if (!this.rendererReady || !win?.webContents || win.isDestroyed?.()) {
      return { ok: false, error: 'renderer-unavailable' };
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return { ok: false, error: 'busy' };
    }
    const requestId = `r${++this.requestSeq}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      try {
        win.webContents.send(CHANNELS.request, { requestId, message });
      } catch (_) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'renderer-unavailable' });
      }
    });
  }

  // Serialise operations so overlapping chain replacements cannot interleave.
  // `cause` ({ ws, seq }) attributes the pipeline changes of a mutating
  // command to the client that sent it.
  enqueue(message, { cause = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const run = this.dispatchChain.then(async () => {
      if (cause) this.activeCause = cause;
      try {
        const result = await this.request(message, timeoutMs);
        if (result.snapshot && this.connectString) {
          this.ingestSnapshot(result.snapshot, cause || undefined);
        }
        return result;
      } finally {
        if (cause) {
          this.activeCause = null;
          this.lastCause = { ...cause, at: Date.now() };
        }
      }
    });
    this.dispatchChain = run.catch(() => {});
    return run;
  }

  // ---- state -------------------------------------------------------------

  resolveCause(cause) {
    if (cause !== undefined) return cause;
    if (this.activeCause) return this.activeCause;
    if (this.lastCause && Date.now() - this.lastCause.at <= ORIGIN_WINDOW_MS) return this.lastCause;
    return null;
  }

  mergePendingOrigin(cause) {
    const next = cause ? { local: false, ws: cause.ws, seq: cause.seq } : { local: true };
    const current = this.pendingOrigin;
    if (!current) this.pendingOrigin = next;
    else if (current.local || next.local) this.pendingOrigin = { local: true };
    else if (current.ws !== next.ws) this.pendingOrigin = { local: false, ws: null, seq: undefined };
    else this.pendingOrigin = next; // same client: the latest command covers the earlier ones
  }

  ingestSnapshot(snapshot, cause) {
    const json = JSON.stringify({
      masterBypass: !!snapshot.masterBypass,
      pipeline: snapshot.pipeline || []
    });
    if (json === this.lastSnapshotJson) return false;
    this.lastSnapshotJson = json;
    this.snapshot = {
      masterBypass: !!snapshot.masterBypass,
      pipeline: Array.isArray(snapshot.pipeline) ? snapshot.pipeline : []
    };
    this.rev += 1;
    this.mergePendingOrigin(this.resolveCause(cause));
    this.scheduleBroadcast();
    return true;
  }

  stateMessage(extra = {}) {
    return {
      op: 'state',
      rev: this.rev,
      app: this.app.getVersion(),
      masterBypass: this.snapshot ? this.snapshot.masterBypass : false,
      pipeline: this.snapshot ? this.snapshot.pipeline : [],
      ...extra
    };
  }

  scheduleBroadcast() {
    if (this.broadcastTimer || !this.wss) return;
    const wait = Math.max(0, STATE_MIN_INTERVAL_MS - (Date.now() - this.lastBroadcastAt));
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.lastBroadcastAt = Date.now();
      this.broadcastState();
    }, wait);
  }

  broadcastState() {
    if (!this.wss) return;
    const origin = this.pendingOrigin || { local: true };
    this.pendingOrigin = null;
    const base = this.stateMessage({ origin: origin.local ? 'local' : 'remote' });
    const plain = JSON.stringify(base);
    for (const ws of this.wss.clients) {
      if (!ws.authenticated || ws.readyState !== 1) continue;
      // A client that cannot keep up skips this push and gets the latest state
      // once it has drained (flushDirtyClients); full states supersede each other.
      if (ws.bufferedAmount > STATE_HIGH_WATER_BYTES) {
        ws.stateDirty = true;
        continue;
      }
      // seq only goes to the client that sent the command; for everyone else
      // the change is external.
      if (!origin.local && origin.ws === ws && origin.seq !== undefined) {
        ws.send(JSON.stringify({ ...base, seq: origin.seq }));
      } else {
        ws.send(plain);
      }
      ws.stateDirty = false;
    }
  }

  flushDirtyClients() {
    if (!this.wss) return;
    let plain = null;
    for (const ws of this.wss.clients) {
      if (!ws.stateDirty || !ws.authenticated || ws.readyState !== 1) continue;
      if (ws.bufferedAmount > STATE_DRAIN_BYTES) continue;
      ws.stateDirty = false;
      plain = plain || JSON.stringify(this.stateMessage({ origin: 'remote' }));
      ws.send(plain);
    }
  }

  // ---- websocket ---------------------------------------------------------

  onConnection(ws, req) {
    let supplied = '';
    try {
      supplied = new URL(req.url || '/', 'http://localhost').searchParams.get('t') || '';
    } catch (_) { /* ignore */ }
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      this.log(`[remote] rejected connection from ${req.socket.remoteAddress} (bad token)`);
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    if (this.countClients() >= MAX_CLIENTS) {
      ws.close(1013, 'too many clients');
      return;
    }
    ws.authenticated = true;
    ws.remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    ws.isAlive = true;
    ws.uploads = new Map();
    ws.telemetry = null;
    this.log(`[remote] client connected: ${req.socket.remoteAddress}`);
    this.emitStatus();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      ws.uploads.clear();
      this.clearTelemetry(ws);
      this.updateTelemetryDemand();
      this.log(`[remote] client disconnected: ${req.socket.remoteAddress}`);
      this.emitStatus();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onMessage(ws, data.toString('utf8')).catch(error => {
        this.log('[remote] message error:', error?.message || error);
      });
    });
  }

  send(ws, message) {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  ack(ws, seq, ok, error) {
    if (seq === undefined) return;
    this.send(ws, ok
      ? { op: 'ack', seq, ok: true }
      : { op: 'ack', seq, ok: false, error: String(error || 'error') });
  }

  async onMessage(ws, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (_) {
      this.send(ws, { op: 'ack', ok: false, error: 'invalid-json' });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.send(ws, { op: 'ack', ok: false, error: 'invalid-message' });
      return;
    }
    const seq = Number.isSafeInteger(msg.seq) ? msg.seq : undefined;
    const op = msg.op;
    if (!CLIENT_OPS.has(op)) {
      this.ack(ws, seq, false, `unknown-op: ${String(op).slice(0, 32)}`);
      return;
    }
    if (op === 'hello' && msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
      this.ack(ws, seq, false, `unsupported-version: ${String(msg.v).slice(0, 16)}`);
      return;
    }
    if (op === 'hello') {
      ws.clientInfo = {
        app: cleanClientText(msg.app),
        version: cleanClientText(msg.version),
        build: cleanClientText(msg.build)
      };
      this.emitStatus();
    }
    if (op === 'telemetry') {
      this.onTelemetry(ws, msg, seq);
      return;
    }
    if (op === 'putIR') {
      await this.onPutIrChunk(ws, msg, seq);
      return;
    }
    if (op === 'getIR') {
      await this.onGetIr(ws, msg, seq);
      return;
    }

    const cause = MUTATING_OPS.has(op) ? { ws, seq } : null;
    const result = await this.enqueue(msg, { cause });
    if (!result.ok) {
      this.ack(ws, seq, false, result.error);
      return;
    }
    this.ack(ws, seq, true);
    const seqField = seq === undefined ? {} : { seq };
    switch (op) {
      case 'hello':
        this.send(ws, this.stateMessage({
          origin: 'remote',
          features: FEATURES,
          appName: APP_NAME,
          ...(this.build ? { build: this.build } : {}),
          ...seqField
        }));
        break;
      case 'get':
        this.send(ws, this.stateMessage({ origin: 'remote', ...seqField }));
        break;
      case 'listPresets':
        this.send(ws, { op: 'presets', names: result.names || [], ...seqField });
        break;
      case 'getPreset':
        this.send(ws, {
          op: 'preset', name: result.name, pipeline: result.pipeline || [], ...seqField
        });
        break;
      case 'listIRs':
        this.send(ws, { op: 'irs', items: result.items || [], ...seqField });
        break;
      default:
        break;
    }
  }

  // ---- analyzer mirror ---------------------------------------------------

  onTelemetry(ws, msg, seq) {
    if (typeof msg.on !== 'boolean') {
      this.ack(ws, seq, false, 'on must be boolean');
      return;
    }
    let fps = TELEMETRY_DEFAULT_FPS;
    if (msg.fps !== undefined) {
      if (typeof msg.fps !== 'number' || !Number.isFinite(msg.fps)) {
        this.ack(ws, seq, false, 'invalid fps');
        return;
      }
      fps = Math.min(TELEMETRY_MAX_FPS, Math.max(1, Math.round(msg.fps)));
    }
    if (msg.overlays !== undefined && typeof msg.overlays !== 'boolean') {
      this.ack(ws, seq, false, 'overlays must be boolean');
      return;
    }
    this.clearTelemetry(ws);
    if (msg.on) {
      ws.telemetry = {
        fps,
        overlays: msg.overlays === true, // PEQ spectrum overlay frames (role before/after)
        period: 1000 / fps,
        nextAt: 0,      // earliest time of the next push (schedule, not last send + period)
        timer: null,
        pending: new Map(),
        carry: new Set()
      };
    }
    this.ack(ws, seq, true);
    this.updateTelemetryDemand();
  }

  clearTelemetry(ws) {
    if (!ws.telemetry) return;
    clearTimeout(ws.telemetry.timer);
    ws.telemetry = null;
  }

  updateTelemetryDemand() {
    let maxFps = 0;
    let overlays = false;
    if (this.wss && this.connectString) {
      for (const ws of this.wss.clients) {
        if (ws.authenticated && ws.telemetry && ws.readyState === 1) {
          maxFps = Math.max(maxFps, ws.telemetry.fps);
          if (ws.telemetry.overlays) overlays = true;
        }
      }
    }
    this.sendTelemetryDemand({ on: maxFps > 0, fps: maxFps, overlays });
  }

  sendTelemetryDemand(demand) {
    const json = JSON.stringify(demand);
    if (json === this.telemetryDemandJson) return;
    const win = this.getMainWindow();
    if (!this.rendererReady || !win?.webContents || win.isDestroyed?.()) {
      // Sent again from setRendererReady().
      this.telemetryDemandJson = null;
      return;
    }
    try {
      win.webContents.send(CHANNELS.telemetryControl, demand);
      this.telemetryDemandJson = json;
      this.log(`[remote] analyzer mirror ${demand.on ? `on at ${demand.fps} fps${demand.overlays ? ' with PEQ overlays' : ''}` : 'off'}`);
    } catch (_) {
      this.telemetryDemandJson = null;
    }
  }

  // frames: [{ key, index, nm, type, bytes: Uint8Array }], latest per key.
  handleRendererTelemetry(frames) {
    if (!Array.isArray(frames) || !this.wss) return false;
    for (const ws of this.wss.clients) {
      const sub = ws.telemetry;
      if (!sub) continue;
      for (const f of frames) {
        if (!f || typeof f.key !== 'string' || !(f.bytes instanceof Uint8Array)) continue;
        if (!Number.isInteger(f.index) || typeof f.nm !== 'string') continue;
        if (f.role !== undefined && !(sub.overlays && (f.role === 'before' || f.role === 'after'))) continue;
        sub.pending.set(f.key, f); // newer overwrites older
      }
      this.pumpTelemetry(ws);
    }
    return true;
  }

  // Sends a push as soon as this client's rate allows. Pushes follow a fixed
  // schedule of 1/fps (a plain setInterval runs slow on Windows' 15.6 ms timer
  // grain: 15 fps came out at 13/s and 30 fps at 21/s), with a quarter period
  // of slack for renderer jitter; the schedule never runs ahead.
  pumpTelemetry(ws) {
    const sub = ws.telemetry;
    if (!sub || sub.timer || sub.pending.size === 0 || ws.readyState !== 1) return;
    const later = delay => {
      sub.timer = setTimeout(() => {
        sub.timer = null;
        if (ws.telemetry === sub) this.pumpTelemetry(ws);
      }, Math.max(1, delay));
    };
    const now = Date.now();
    const wait = sub.nextAt - sub.period / 4 - now;
    if (wait > 0) { later(wait); return; }
    if (ws.bufferedAmount > TELEMETRY_HIGH_WATER) { later(sub.period); return; }
    if (!this.flushTelemetry(ws)) return;
    sub.nextAt = Math.max(sub.nextAt + sub.period, now + sub.period);
    if (sub.pending.size > 0) this.pumpTelemetry(ws); // left over by the caps
  }

  // Sends one push (within the caps) of what is pending. Returns true if sent.
  flushTelemetry(ws) {
    const sub = ws.telemetry;
    if (!sub || sub.pending.size === 0) return false;
    if (ws.readyState !== 1 || ws.bufferedAmount > TELEMETRY_HIGH_WATER) return false;
    // Entries left over by the caps last time go first, then the rest, each in
    // stage order.
    const byIndex = (a, b) => a[1].index - b[1].index;
    const entries = [...sub.pending.entries()];
    const ordered = [
      ...entries.filter(([key]) => sub.carry.has(key)).sort(byIndex),
      ...entries.filter(([key]) => !sub.carry.has(key)).sort(byIndex)
    ];
    const taken = [];
    let raw = 0;
    for (const [key, f] of ordered) {
      if (taken.length >= TELEMETRY_MAX_FRAMES) break;
      if (raw + f.bytes.byteLength > TELEMETRY_MAX_RAW_BYTES) break;
      raw += f.bytes.byteLength;
      taken.push(f);
      sub.pending.delete(key);
    }
    sub.carry = new Set(sub.pending.keys());
    if (taken.length === 0) return false;
    this.send(ws, {
      op: 'telemetry',
      frames: taken.map(f => ({
        index: f.index,
        nm: f.nm,
        type: f.type,
        ...(f.role ? { role: f.role } : {}),
        data: Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength).toString('base64')
      }))
    });
    return true;
  }

  // ---- IR transfer -------------------------------------------------------

  async onGetIr(ws, msg, seq) {
    if (typeof msg.id !== 'string' || !IR_ID_PATTERN.test(msg.id)) {
      this.ack(ws, seq, false, 'invalid id');
      return;
    }
    const result = await this.enqueue({ op: 'getIR', id: msg.id }, { timeoutMs: IR_REQUEST_TIMEOUT_MS });
    if (!result.ok) {
      this.ack(ws, seq, false, result.error);
      return;
    }
    const data = result.data;
    if (!(data instanceof Uint8Array)) {
      this.ack(ws, seq, false, 'ir unreadable');
      return;
    }
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const total = Math.max(1, Math.ceil(buffer.length / IR_CHUNK_BYTES));
    const seqField = seq === undefined ? {} : { seq };
    for (let index = 0; index < total; index += 1) {
      if (ws.readyState !== 1) return;
      while (ws.bufferedAmount > SEND_HIGH_WATER_BYTES && ws.readyState === 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const part = buffer.subarray(index * IR_CHUNK_BYTES, (index + 1) * IR_CHUNK_BYTES);
      this.send(ws, {
        op: 'irChunk',
        id: msg.id,
        name: result.name,
        ext: result.ext,
        index,
        total,
        bytes: buffer.length,
        data: part.toString('base64'),
        ...seqField
      });
    }
    this.ack(ws, seq, true);
  }

  async onPutIrChunk(ws, msg, seq) {
    const fail = (error, id = msg.id) => {
      if (typeof id === 'string') ws.uploads.delete(id);
      this.ack(ws, seq, false, error);
    };
    const { id, index, total, bytes, data } = msg;
    if (typeof id !== 'string' || !IR_ID_PATTERN.test(id)) return fail('invalid id', null);
    if (!Number.isSafeInteger(total) || total < 1 || total > IR_MAX_CHUNKS) return fail('invalid total');
    if (!Number.isSafeInteger(index) || index < 0 || index >= total) return fail('invalid index');
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > IR_MAX_BYTES) return fail('invalid bytes');
    if (typeof data !== 'string' || data.length > Math.ceil(IR_CHUNK_BYTES / 3) * 4 + 4) {
      return fail('invalid data');
    }
    const part = Buffer.from(data, 'base64');
    if (part.length > IR_CHUNK_BYTES) return fail('chunk too large');

    if (index === 0) {
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 512) : '';
      const ext = typeof msg.ext === 'string' ? msg.ext.trim().replace(/^\./, '').toLowerCase() : '';
      if (!name) return fail('name must be a non-empty string');
      if (!/^[a-z0-9]{1,10}$/.test(ext)) return fail('invalid ext');
      if (!ws.uploads.has(id) && ws.uploads.size >= MAX_UPLOADS_PER_CLIENT) return fail('too many uploads');
      ws.uploads.set(id, { name, ext, total, bytes, parts: [], received: 0, next: 0 });
    }
    const upload = ws.uploads.get(id);
    if (!upload) return fail('upload not started (send index 0 first)');
    if (index !== upload.next || total !== upload.total || bytes !== upload.bytes) {
      return fail('chunk out of order');
    }
    if (upload.received + part.length > upload.bytes) return fail('size mismatch');
    upload.parts.push(part);
    upload.received += part.length;
    upload.next += 1;
    if (index < total - 1) {
      this.ack(ws, seq, true);
      return undefined;
    }
    ws.uploads.delete(id);
    if (upload.received !== upload.bytes) return fail('size mismatch');
    const joined = Buffer.concat(upload.parts, upload.received);
    const result = await this.enqueue({
      op: 'putIR',
      id,
      name: upload.name,
      ext: upload.ext,
      data: new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
    }, { timeoutMs: IR_REQUEST_TIMEOUT_MS });
    this.ack(ws, seq, result.ok === true, result.error);
    return undefined;
  }

  // ---- lifecycle ---------------------------------------------------------

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (activeHost === this) activeHost = null;
    this.setRendererUnavailable();
    for (const waiter of [...this.readyWaiters]) waiter(false);
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      try { this.panelWindow.destroy(); } catch (_) { /* ignore */ }
    }
    await this.stop({ reason: 'shutdown' });
  }
}

function openRemoteControlPanel() {
  return activeHost ? activeHost.openPanel() : null;
}

function registerRemoteControlIpc({ ipcMain, getHost, getMainWindow }) {
  const handlers = new Map([
    [CHANNELS.rendererReady, host => (host ? host.setRendererReady() : { enabled: false })],
    [CHANNELS.rendererUnavailable, host => (host ? host.setRendererUnavailable() : false)],
    [CHANNELS.response, (host, response) => (host ? host.handleRendererResponse(response) : false)],
    [CHANNELS.state, (host, snapshot) => (host ? host.handleRendererState(snapshot) : false)],
    [CHANNELS.openPanel, host => { host?.openPanel(); return !!host; }],
    [CHANNELS.getStatus, host => (host ? host.getBriefStatus() : { enabled: false })]
  ]);
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, (event, ...args) => {
      const window = getMainWindow();
      if (!window?.webContents || event.sender !== window.webContents) {
        throw new Error('invalid-sender');
      }
      return handler(getHost(), ...args);
    });
  }
  const panelHandlers = new Map([
    [PANEL_CHANNELS.getStatus, host => host.getStatus({ withQr: true })],
    [PANEL_CHANNELS.setEnabled, async (host, enabled) => {
      await host.setEnabled(enabled === true);
      return host.getStatus({ withQr: true });
    }],
    [PANEL_CHANNELS.regenerateToken, async host => {
      await host.regenerateToken();
      return host.getStatus({ withQr: true });
    }]
  ]);
  // Analyzer frames come by send (fire-and-forget, up to 30 Hz), not invoke.
  const onTelemetry = (event, frames) => {
    const window = getMainWindow();
    if (!window?.webContents || event.sender !== window.webContents) return;
    getHost()?.handleRendererTelemetry(frames);
  };
  ipcMain.on(CHANNELS.telemetry, onTelemetry);
  for (const [channel, handler] of panelHandlers) {
    ipcMain.handle(channel, (event, ...args) => {
      const host = getHost();
      if (!host || !host.isPanelSender(event.sender)) throw new Error('invalid-sender');
      return handler(host, ...args);
    });
  }
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    for (const channel of panelHandlers.keys()) ipcMain.removeHandler(channel);
    ipcMain.removeListener(CHANNELS.telemetry, onTelemetry);
  };
}

module.exports = {
  CHANNELS,
  PANEL_CHANNELS,
  PORT,
  IR_CHUNK_BYTES,
  RemoteControlHost,
  isRemoteEnabled,
  isRemoteForced,
  openRemoteControlPanel,
  pairingUrl,
  pickLanAddress,
  registerRemoteControlIpc
};
