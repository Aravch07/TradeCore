// HTTP + Server-Sent Events client for the C engine (see docs/API.md).
import { settings, bus, shared } from './store.js';

const base = () => (settings.get('apiBase') || '').replace(/\/$/, '');

// Round-trip times (ms) of recent API calls, measured in the browser.
export const roundTrips = [];

export async function api(path, { method = 'GET', body } = {}) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('Cannot reach the TradeCore engine. Is ./build/tradecore running?');
  }
  const data = await res.json().catch(() => ({ ok: false, message: 'invalid JSON from server' }));
  roundTrips.push({ t: Date.now(), ms: performance.now() - t0 });
  if (roundTrips.length > 2000) roundTrips.shift();
  return data;
}

export const get = path => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });

// ------------------------------------------------------------- live stream
let es = null;
let retryTimer = null;

export function connectStream() {
  if (es) es.close();
  clearTimeout(retryTimer);
  es = new EventSource(base() + '/api/stream');

  es.addEventListener('hello', () => setConnected(true));
  es.addEventListener('command', e => {
    const cmd = JSON.parse(e.data);
    shared.commandLog.unshift(cmd);
    if (shared.commandLog.length > 300) shared.commandLog.pop();
    bus.emit('command', cmd);
  });
  es.addEventListener('trace', e => bus.emit('trace', JSON.parse(e.data)));
  es.addEventListener('reset', e => bus.emit('reset', JSON.parse(e.data)));
  es.onerror = () => {
    setConnected(false);
    if (!settings.get('autoReconnect')) {
      es.close();
    } else if (es.readyState === EventSource.CLOSED) {
      retryTimer = setTimeout(connectStream, 2000);
    } // otherwise the browser retries on its own
  };
}

function setConnected(v) {
  if (shared.connected === v) return;
  shared.connected = v;
  bus.emit('connection', v);
}
