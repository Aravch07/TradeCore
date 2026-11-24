// Formatting and small UI helpers (toasts, modals, DOM shortcuts).
import { settings } from './store.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 101.5 -> "101.50" */
export const px = v => (v == null || Number.isNaN(v) ? '—' : nf2.format(v));
/** 101.5 -> "₹101.50" */
export const inr = v => (v == null || Number.isNaN(v) ? '—' : '₹' + nf2.format(v));
export const int = v => (v == null || Number.isNaN(v) ? '—' : nf0.format(v));
export const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');

/** Compact rupee amount: 248600 -> "₹248.6K" */
export function inrCompact(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(2);
}

export function clock(ms, withMs = false) {
  const d = new Date(ms);
  const s = d.toLocaleTimeString('en-GB', { hour12: false });
  return withMs ? `${s}.${String(d.getMilliseconds()).padStart(3, '0')}` : s;
}

export function ns(v) {
  if (v == null) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' ms';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' µs';
  return Math.round(v) + ' ns';
}

export function bytes(v) {
  if (v == null) return '—';
  if (v >= 1 << 30) return (v / (1 << 30)).toFixed(2) + ' GB';
  if (v >= 1 << 20) return (v / (1 << 20)).toFixed(2) + ' MB';
  if (v >= 1 << 10) return (v / (1 << 10)).toFixed(1) + ' KB';
  return v + ' B';
}

export const statusTag = s => `<span class="status ${s}">${s[0].toUpperCase() + s.slice(1)}</span>`;
export const sideTag = s => `<span class="tag sell up">${s}</span>`;

// ------------------------------------------------------------------ toasts
let toastBox;
export function toast(msg, kind = '') {
  if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; document.body.appendChild(toastBox); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = msg;
  toastBox.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ------------------------------------------------------------------- modal
export function modal({ title, body, okText = 'Confirm', cancelText = 'Cancel', danger = false, onOpen }) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h3>${title}</h3><div class="muted">${body}</div>
      <div class="actions">
        <button class="btn ghost" data-a="no">${cancelText}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${okText}</button>
      </div></div>`;
    const close = v => { back.remove(); resolve(v); };
    back.addEventListener('click', e => {
      if (e.target === back) close(null);
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'no') close(null);
      if (a === 'yes') close(back);
    });
    document.body.appendChild(back);
    onOpen?.(back);
    back.querySelector('input')?.focus();
  });
}

// ------------------------------------------------------------- audio cue
let actx;
export function beep(freq = 660) {
  if (!settings.get('audio')) return;
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = 'triangle';
    g.gain.setValueAtTime(0.06, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.12);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.13);
  } catch { /* audio not available */ }
}

/** Re-run `fn` whenever an element is resized (for charts). Returns disconnect fn. */
export function onResize(el, fn) {
  let w = 0;
  const ro = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - w) > 2) { w = el.clientWidth; fn(); }
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/** Group book levels into buckets of `step` rupees (bids round down, asks round up). */
export function aggregate(levels, step, side) {
  if (!step || step <= 0.05) return levels;
  const map = new Map();
  for (const l of levels) {
    const k = side === 'bid' ? Math.floor(l.price / step + 1e-9) * step : Math.ceil(l.price / step - 1e-9) * step;
    const key = k.toFixed(2);
    const cur = map.get(key) || { price: +key, qty: 0, orders: 0, node_id: l.node_id, members: [] };
    cur.qty += l.qty; cur.orders += l.orders; cur.members.push(l.price);
    map.set(key, cur);
  }
  return [...map.values()];
}
