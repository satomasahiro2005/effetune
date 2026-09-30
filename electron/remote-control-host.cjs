'use strict';

// PoC: LAN remote control ("remote-v1") for the EffectDeck iOS app.
//
// The WebSocket server lives in the main process (the renderer CSP forbids
// ws:). Every client operation is forwarded to the renderer over versioned
// IPC channels (same shape as openhome-v1) and answered from there, because the
// pipeline, the preset manager and the IR library only exist in the renderer.
//
// The server is switched on and off from Settings > Remote Control... (the
// choice and a persistent token are kept in config.json). EFFETUNE_REMOTE=1 or
// --remote forces it on at startup; EFFETUNE_REMOTE_TOKEN fixes the token and
// EFFETUNE_REMOTE_PORT the port (for tests).

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const CHANNELS = Object.freeze({
  rendererReady: 'remote-v1:renderer-ready',
  rendererUnavailable: 'remote-v1:renderer-unavailable',
  response: 'remote-v1:response',
  state: 'remote-v1:state',
  request: 'remote-v1:request',
  status: 'remote-v1:status'
});

const PANEL_CHANNELS = Object.freeze({
  getStatus: 'remote-panel-v1:get-status',
  setEnabled: 'remote-panel-v1:set-enabled',
  regenerateToken: 'remote-panel-v1:regenerate-token',
  status: 'remote-panel-v1:status'
});

const PORT = 47300;
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
const IR_ID_PATTERN = /^[a-f0-9]{24}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const FEATURES = Object.freeze(['origin', 'savePreset', 'irSync']);
const CLIENT_OPS = new Set([
  'hello', 'get', 'chain', 'params', 'bypass', 'listPresets', 'getPreset',
  'savePreset', 'listIRs', 'getIR', 'putIR'
]);
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

function pairingUrl(address, port, token) {
  return `effectdeck://remote?h=${address}:${port}&t=${encodeURIComponent(token)}`;
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
    this.getMainWindow = getMainWindow;
    this.config = config;
    this.log = log;
    this.forced = isRemoteForced(env, argv);
    const cfg = this.loadConfig();
    this.enabled = this.forced || cfg.remoteControlEnabled === true;
    this.port = Number(env.EFFETUNE_REMOTE_PORT) || PORT;
    this.tokenFromEnvironment = typeof env.EFFETUNE_REMOTE_TOKEN === 'string' &&
      env.EFFETUNE_REMOTE_TOKEN.length > 0;
    this.token = this.tokenFromEnvironment ? env.EFFETUNE_REMOTE_TOKEN : this.ensurePersistentToken(cfg);
    this.server = null;
    this.wss = null;
    this.pingTimer = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.listenError = null;
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

  async setEnabled(enabled) {
    enabled = enabled === true;
    this.saveConfigPatch({ remoteControlEnabled: enabled });
    this.enabled = enabled;
    if (enabled) await this.start();
    else await this.stop();
    return this.getStatus();
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
      token: this.token,
      tokenFromEnvironment: this.tokenFromEnvironment,
      connectString: this.connectString,
      addresses,
      url: addresses[0]?.url || null,
      error: this.listenError,
      clients: this.countClients()
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
      try { win.webContents.send(CHANNELS.status, { enabled: !!this.connectString }); } catch (_) { /* ignore */ }
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
    const lan = pickLanAddress();
    this.lan = lan;
    this.listenError = null;
    const server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('EffeTune remote-v1: WebSocket only\n');
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_WS_BYTES });
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
    return new Promise(resolve => {
      let bound = false;
      server.on('error', error => {
        this.log(`[remote] server error: ${error.code || ''} ${error.message}`);
        if (bound) return;
        this.listenError = error.code === 'EADDRINUSE'
          ? `port ${this.port} is already in use`
          : String(error.message || error);
        this.closeServer(server, wss);
        if (this.server === server) { this.server = null; this.wss = null; }
        clearInterval(this.pingTimer);
        this.startPromise = null;
        this.emitStatus();
        resolve(false);
      });
      server.listen(this.port, '0.0.0.0', () => {
        bound = true;
        if (this.disposed || this.server !== server) { resolve(false); return; }
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
        resolve(true);
      });
    });
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
    const server = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.pendingOrigin = null;
    const wasRunning = !!this.connectString;
    this.connectString = null;
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
    const base = String(title || 'EffeTune').replace(/ — Remote .*$/, '');
    return this.connectString ? `${base} — Remote ${this.connectString}` : base;
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
    return { apiVersion: 1, enabled: !!this.connectString };
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
      // seq only goes to the client that sent the command; for everyone else
      // the change is external.
      if (!origin.local && origin.ws === ws && origin.seq !== undefined) {
        ws.send(JSON.stringify({ ...base, seq: origin.seq }));
      } else {
        ws.send(plain);
      }
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
    ws.isAlive = true;
    ws.uploads = new Map();
    this.log(`[remote] client connected: ${req.socket.remoteAddress}`);
    this.emitStatus();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      ws.uploads.clear();
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
        this.send(ws, this.stateMessage({ origin: 'remote', features: FEATURES, ...seqField }));
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
    [CHANNELS.state, (host, snapshot) => (host ? host.handleRendererState(snapshot) : false)]
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
