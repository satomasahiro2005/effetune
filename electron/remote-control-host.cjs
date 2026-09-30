'use strict';

// PoC: LAN remote control ("remote-v1") for the EffectDeck iOS app.
//
// The WebSocket server lives in the main process (the renderer CSP forbids
// ws:). Every client operation is forwarded to the renderer over versioned IPC
// channels (same shape as openhome-v1) and answered from there, because the
// pipeline only exists in the renderer.
//
// Disabled unless EFFETUNE_REMOTE=1 or --remote.

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { WebSocketServer } = require('ws');

const CHANNELS = Object.freeze({
  rendererReady: 'remote-v1:renderer-ready',
  rendererUnavailable: 'remote-v1:renderer-unavailable',
  response: 'remote-v1:response',
  state: 'remote-v1:state',
  request: 'remote-v1:request'
});

const PORT = 47300;
const MAX_WS_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PENDING_REQUESTS = 32;
const STATE_MIN_INTERVAL_MS = 100; // <= 10 Hz
const PING_INTERVAL_MS = 15000;
const CLOSE_UNAUTHORIZED = 4401;
const PROTOCOL_VERSION = 1;
const CLIENT_OPS = new Set([
  'hello', 'get', 'chain', 'params', 'bypass', 'listPresets', 'getPreset'
]);

function isRemoteEnabled(env = process.env, argv = process.argv) {
  return env.EFFETUNE_REMOTE === '1' || argv.includes('--remote');
}

function pickLanAddress(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      let score = 0;
      if (addr.address.startsWith('192.168.')) score = 30;
      else if (addr.address.startsWith('10.')) score = 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)) score = 10;
      if (/vethernet|wsl|vmware|virtualbox|hyper-v|docker|vbox|loopback|tailscale|zerotier/i.test(name)) {
        score -= 25;
      }
      candidates.push({ name, address: addr.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0]?.address || '127.0.0.1', candidates };
}

class RemoteControlHost {
  constructor({ app, getMainWindow, env = process.env, argv = process.argv, log = console.log }) {
    this.app = app;
    this.getMainWindow = getMainWindow;
    this.log = log;
    this.enabled = isRemoteEnabled(env, argv);
    this.port = Number(env.EFFETUNE_REMOTE_PORT) || PORT;
    this.token = env.EFFETUNE_REMOTE_TOKEN || crypto.randomBytes(4).toString('hex');
    this.server = null;
    this.wss = null;
    this.pingTimer = null;
    this.rendererReady = false;
    this.pending = new Map();
    this.requestSeq = 0;
    this.dispatchChain = Promise.resolve();
    this.lastSnapshotJson = null;
    this.snapshot = null;
    this.rev = 0;
    this.lastBroadcastAt = 0;
    this.broadcastTimer = null;
    this.connectString = null;
    this.attachedWindows = new WeakSet();
    this.disposed = false;
  }

  getStatus() {
    return { enabled: this.enabled, apiVersion: 1, connectString: this.connectString };
  }

  start() {
    if (!this.enabled || this.server) return;
    const lan = pickLanAddress();
    this.connectString = `${lan.best}:${this.port}/${this.token}`;

    this.server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('EffeTune remote-v1: WebSocket only\n');
    });
    this.wss = new WebSocketServer({ server: this.server, maxPayload: MAX_WS_BYTES });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', error => this.log('[remote] wss error:', error.message));
    this.server.on('error', error => {
      this.log(`[remote] server error: ${error.code || ''} ${error.message}`);
    });
    this.server.listen(this.port, '0.0.0.0', () => {
      this.log(`[remote] listening on 0.0.0.0:${this.port}`);
      this.log(`[remote] CONNECT STRING: ${this.connectString}`);
      if (lan.candidates.length > 1) {
        this.log('[remote] other addresses: ' +
          lan.candidates.map(c => `${c.address} (${c.name})`).join(', '));
      }
      this.refreshTitle();
    });
    this.pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) { /* ignore */ }
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  // ---- window title ------------------------------------------------------

  attachWindow(win) {
    if (!this.enabled || !win || this.attachedWindows.has(win)) return;
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
    if (!win || win.isDestroyed?.() || !this.connectString) return;
    try { win.setTitle(this.decorateTitle(win.getTitle())); } catch (_) { /* ignore */ }
  }

  // ---- renderer bridge ---------------------------------------------------

  setRendererReady() {
    this.rendererReady = true;
    return this.getStatus();
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
    this.ingestSnapshot(snapshot);
    return true;
  }

  request(message) {
    const win = this.getMainWindow();
    if (!this.rendererReady || !win?.webContents || win.isDestroyed?.()) {
      return Promise.resolve({ ok: false, error: 'renderer-unavailable' });
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve({ ok: false, error: 'busy' });
    }
    const requestId = `r${++this.requestSeq}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'timeout' });
      }, REQUEST_TIMEOUT_MS);
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
  enqueue(message) {
    const run = this.dispatchChain.then(() => this.request(message));
    this.dispatchChain = run.catch(() => {});
    return run;
  }

  // ---- state -------------------------------------------------------------

  ingestSnapshot(snapshot) {
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
      this.broadcast(this.stateMessage());
    }, wait);
  }

  broadcast(message) {
    if (!this.wss) return;
    const text = JSON.stringify(message);
    for (const ws of this.wss.clients) {
      if (ws.authenticated && ws.readyState === 1) ws.send(text);
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
    ws.authenticated = true;
    ws.isAlive = true;
    this.log(`[remote] client connected: ${req.socket.remoteAddress}`);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('close', () => this.log(`[remote] client disconnected: ${req.socket.remoteAddress}`));
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

    const result = await this.enqueue(msg);
    if (result.snapshot) this.ingestSnapshot(result.snapshot);
    if (!result.ok) {
      this.ack(ws, seq, false, result.error);
      return;
    }
    this.ack(ws, seq, true);
    const seqField = seq === undefined ? {} : { seq };
    switch (op) {
      case 'hello':
      case 'get':
        this.send(ws, this.stateMessage(seqField));
        break;
      case 'listPresets':
        this.send(ws, { op: 'presets', names: result.names || [], ...seqField });
        break;
      case 'getPreset':
        this.send(ws, {
          op: 'preset', name: result.name, pipeline: result.pipeline || [], ...seqField
        });
        break;
      default:
        break;
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  dispose() {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.broadcastTimer);
    this.setRendererUnavailable();
    return new Promise(resolve => {
      if (!this.wss) { resolve(); return; }
      for (const ws of this.wss.clients) {
        try { ws.close(1001, 'shutdown'); } catch (_) { /* ignore */ }
      }
      this.wss.close(() => {
        if (this.server) this.server.close(() => resolve());
        else resolve();
        this.server?.closeAllConnections?.();
      });
    });
  }
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
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
  };
}

module.exports = {
  CHANNELS,
  PORT,
  RemoteControlHost,
  isRemoteEnabled,
  pickLanAddress,
  registerRemoteControlIpc
};
