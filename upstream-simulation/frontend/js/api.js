// HTTP + Server-Sent Events client for the C engine (see docs/API.md).
import { settings, bus, shared, session } from './store.js';

// Engine address: Settings override, else frontend/config.js, else this same site.
const base = () => (settings.get('apiBase') || window.TRADECORE_API_URL || '').replace(/\/$/, '');

// Round-trip times (ms) of recent API calls, measured in the browser.
export const roundTrips = [];

export async function api(path, { method = 'GET', body } = {}) {
  const t0 = performance.now();
  let res;
  try {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (session.token) headers.Authorization = `Bearer ${session.token}`;
    res = await fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Cannot reach the TradeCore engine. Is ./build/tradecore running?');
  }
  const data = await res.json().catch(() => ({ ok: false, message: 'invalid JSON from server' }));
  roundTrips.push({ t: Date.now(), ms: performance.now() - t0 });
  if (res.status === 401 && !path.startsWith('/api/auth/')) bus.emit('unauthorized');
  if (roundTrips.length > 2000) roundTrips.shift();
  return data;
}

export const get = path => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });

/** True if this browser placed the order / was a side of the trade. */
export const isMine = owner => !!owner && owner.toLowerCase() === (session.user?.username || '').toLowerCase();

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
  es.addEventListener('sim', e => bus.emit('sim', JSON.parse(e.data)));
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
