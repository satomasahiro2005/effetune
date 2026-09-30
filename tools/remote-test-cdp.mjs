// Tiny Chrome DevTools Protocol helper for the remote-control PoC tests.
// Talks to Electron started with --remote-debugging-port (renderer pages) or
// --inspect (main process).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export async function waitForTarget(port, match, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const target = (await listTargets(port)).find(match);
      if (target) return target;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('CDP target not found');
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    const session = {
      send(method, params = {}) {
        const n = ++id;
        ws.send(JSON.stringify({ id: n, method, params }));
        return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej }));
      },
      async evaluate(expression) {
        const result = await session.send('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true
        });
        if (result.exceptionDetails) {
          throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 400));
        }
        return result.result.value;
      },
      close() { ws.close(); }
    };
    ws.once('open', () => resolve(session));
    ws.once('error', reject);
  });
}

export async function mainWindowSession(port) {
  const target = await waitForTarget(port, (t) => t.type === 'page' && /effetune\.html/.test(t.url));
  return connect(target.webSocketDebuggerUrl);
}
