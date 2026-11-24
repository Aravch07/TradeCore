// Helpers shared by several pages.
import { get } from '../api.js';
import { clock, px } from '../ui.js';

export const RANGES = { '1H': 3600e3, '1D': 86400e3, '1W': 7 * 86400e3, '1M': 30 * 86400e3, '1Y': 365 * 86400e3, ALL: 0 };

/**
 * Price series from fills in a time range, downsampled to at most `maxPts`
 * points (last price per bucket). Returns { values, labels, xLabels, trades }.
 */
export async function priceSeries(rangeKey = '1H', maxPts = 160) {
  const span = RANGES[rangeKey] ?? 0;
  const since = span ? Date.now() - span : 0;
  const r = await get(`/api/trades?limit=5000&since_ms=${since}`);
  const trades = (r.trades || []).slice().reverse();          // oldest first
  if (!trades.length) return { values: [], labels: [], xLabels: [], trades };
  const t0 = trades[0].time_ms, t1 = trades[trades.length - 1].time_ms;
  let pts = trades;
  if (trades.length > maxPts) {
    const step = Math.max(1, (t1 - t0) / maxPts);
    const buckets = new Map();
    for (const t of trades) buckets.set(Math.floor((t.time_ms - t0) / step), t);
    pts = [...buckets.values()];
    if (pts.length > maxPts) pts = pts.filter((_, i) => i % Math.ceil(pts.length / maxPts) === 0);
  }
  const values = pts.map(t => t.price);
  const labels = pts.map(t => `₹${px(t.price)} · ${clock(t.time_ms)}`);
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map(at => {
    const t = pts[Math.round(at * (pts.length - 1))];
    return { at, text: clock(t.time_ms).slice(0, 5) };
  });
  return { values, labels, xLabels, trades };
}

export const pageHead = (title, sub, actions = '', eyebrow = '') => `
  <div class="page-head">
    <div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>
    <div class="head-actions">${actions}</div>
  </div>`;

/** Wire a segmented control: calls onPick(value) and toggles .on */
export function wireSeg(root, sel, onPick) {
  root.querySelectorAll(`${sel} button`).forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    root.querySelectorAll(`${sel} button`).forEach(x => x.classList.toggle('on', x === b));
    onPick(b.dataset.v);
  }));
}

/**
 * Turn a streamed command into a plain-English activity line.
 * Returns { who, text, side, mine } or null for uninteresting commands.
 */
export function describeCommand(cmd, isMine) {
  if (!cmd.ok) return null;
  const o = cmd.order;
  if (!o) return null;
  const who = o.trader || o.owner || 'someone';
  const mine = isMine(o.owner);
  const p = v => `₹${px(v)}`;
  if (cmd.command === 'cancel') return { who, mine, side: o.side, text: `cancelled a ${o.side} order (#${o.id}) at ${p(o.price)}` };
  const fills = cmd.fills || [];
  if (fills.length) {
    const q = fills.reduce((a, f) => a + f.qty, 0);
    const makers = [...new Set(fills.map(f => f.maker_trader))];
    const verb = o.side === 'buy' ? 'bought' : 'sold';
    const avg = fills.reduce((a, f) => a + f.price * f.qty, 0) / q;
    return { who, mine, side: o.side, text: `${verb} <b>${q} TCX</b> at ${fills.length > 1 ? `avg ${p(avg)}` : p(fills[0].price)} from ${makers.slice(0, 2).join(', ')}${makers.length > 2 ? ` +${makers.length - 2}` : ''}` };
  }
  if (cmd.command === 'replace') return { who, mine, side: o.side, text: `moved an order to ${p(o.price)} (${o.qty} TCX)` };
  return { who, mine, side: o.side, text: `posted a ${o.side} order: ${o.qty} TCX at ${p(o.price)}` };
}

export function feedItem(d, t, isNew = false) {
  const initials = d.who.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  return `<div class="it ${isNew ? 'new' : ''}"><span class="who-ico ${d.mine ? 'me' : ''}">${initials}</span>
    <span><b class="${d.mine ? 'accent' : ''}">${d.mine ? 'You' : d.who}</b> ${d.text}</span><small>${clock(t)}</small></div>`;
}
