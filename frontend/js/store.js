// Settings (saved in the browser) and a tiny event bus shared by all pages.

const DEFAULTS = {
  trader: 'ME',            // label attached to orders placed from this browser
  apiBase: '',             // '' = same server that serves this page
  theme: 'dark',
  compact: false,
  animMs: 150,
  flash: true,
  oneClick: false,
  defaultQty: 100,
  aggregation: 0.05,       // order book price grouping (rupees)
  chartSmooth: true,
  autoReconnect: true,
  connToasts: true,
  audio: false,
  vizSpeed: 1,
};

const KEY = 'tradecore.settings.v1';
let values = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  values = { ...DEFAULTS, ...saved };
} catch { /* storage unavailable: use defaults */ }

const listeners = new Map();

export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  },
  emit(evt, data) {
    (listeners.get(evt) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  },
};

export const settings = {
  get(k) { return values[k]; },
  all() { return { ...values }; },
  defaults() { return { ...DEFAULTS }; },
  set(patch) {
    values = { ...values, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* ignore */ }
    applySettings();
    bus.emit('settings', values);
  },
  reset() { this.set({ ...DEFAULTS }); },
};

export function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = values.theme;
  r.dataset.density = values.compact ? 'compact' : 'normal';
  r.dataset.flash = values.flash ? 'on' : 'off';
  r.style.setProperty('--anim', `${values.animMs}ms`);
}

// Small shared cache filled by the app shell (latest market summary etc.)
export const shared = {
  summary: null,
  connected: false,
  notifications: [],
  commandLog: [],      // last commands seen on the stream (newest first)
};
