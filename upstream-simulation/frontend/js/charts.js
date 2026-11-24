// Hand-written SVG charts (no libraries). Each function draws into a
// container element using its current width.
import { px, esc } from './ui.js';
import { settings } from './store.js';

let gid = 0;

/** Smooth path through points without overshoot (monotone cubic). */
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  if (!settings.get('chartSmooth')) return 'M' + pts.map(p => p.join(',')).join('L');
  const n = pts.length, dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dx[i] ? dy[i] / dx[i] : 0;
  }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

function emptyMsg(el, h, msg) {
  el.innerHTML = `<div class="empty" style="height:${h}px;display:grid;place-items:center">${msg}</div>`;
}

/**
 * Area/line chart.
 * values: number[]; opts: { height, color, xLabels:[{at:0..1,text}], grid, dot,
 * overlays:[{values,color,dash}], labels:string[] (tooltip per point), empty }
 */
export function areaChart(el, values, opts = {}) {
  const W = Math.max(el.clientWidth, 200), H = opts.height || 240;
  if (!values.length) return emptyMsg(el, H, opts.empty || 'No trades yet');
  const color = opts.color || 'var(--accent)';
  const padT = 16, padB = opts.xLabels ? 34 : 8, padX = 2;
  const all = [...values, ...(opts.overlays || []).flatMap(o => o.values.filter(v => v != null))];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo; lo -= span * 0.12; hi += span * 0.12;
  const n = values.length;
  const xs = i => padX + (n === 1 ? (W - 2 * padX) / 2 : (i / (n - 1)) * (W - 2 * padX));
  const ys = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const pts = values.map((v, i) => [+xs(i).toFixed(1), +ys(v).toFixed(1)]);
  const line = smoothPath(pts);
  const id = 'g' + (++gid);
  const base = H - padB;
  let grid = '';
  for (let k = 1; k <= (opts.grid ?? 3); k++) {
    const y = padT + (k / ((opts.grid ?? 3) + 1)) * (H - padT - padB);
    grid += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
  }
  const overlays = (opts.overlays || []).map(o => {
    const p = o.values.map((v, i) => v == null ? null : [xs(i), ys(v)]).filter(Boolean);
    return `<path d="${smoothPath(p)}" fill="none" stroke="${o.color}" stroke-width="1.6" ${o.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
  }).join('');
  const labels = (opts.xLabels || []).map(l =>
    `<text x="${Math.min(Math.max(l.at * W, 24), W - 24)}" y="${H - 8}" fill="var(--text)" font-size="15" text-anchor="middle">${esc(l.text)}</text>`).join('');
  const last = pts[pts.length - 1];
  const dot = opts.dot ? `<circle cx="${last[0]}" cy="${last[1]}" r="7" fill="var(--accent)" stroke="#20414d" stroke-width="4"/>` : '';
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="${line}L${last[0]},${base}L${pts[0][0]},${base}Z" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2"/>
    ${overlays}${dot}${labels}
    <line class="hover-line" x1="0" x2="0" y1="${padT}" y2="${base}" stroke="var(--line-2)" visibility="hidden"/>
  </svg><div class="tooltip hidden"></div>`;
  attachHover(el, pts, i => opts.labels?.[i] ?? px(values[i]));
}

function attachHover(el, pts, text) {
  const tip = el.querySelector('.tooltip'), vline = el.querySelector('.hover-line'), svg = el.querySelector('svg');
  if (!tip || !svg) return;
  svg.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < Math.abs(pts[best][0] - x)) best = i;
    tip.classList.remove('hidden');
    tip.style.left = pts[best][0] + 'px';
    tip.style.top = pts[best][1] + 'px';
    tip.innerHTML = text(best);
    vline.setAttribute('x1', pts[best][0]); vline.setAttribute('x2', pts[best][0]);
    vline.setAttribute('visibility', 'visible');
  });
  svg.addEventListener('mouseleave', () => { tip.classList.add('hidden'); vline.setAttribute('visibility', 'hidden'); });
}

/** OHLC candlesticks. candles: [{open,high,low,close,volume,start_ms}] */
export function candleChart(el, candles, opts = {}) {
  const W = Math.max(el.clientWidth, 200), H = opts.height || 200;
  if (!candles.length) return emptyMsg(el, H, 'No candles yet');
  let lo = Math.min(...candles.map(c => c.low)), hi = Math.max(...candles.map(c => c.high));
  if (hi === lo) { hi += 0.5; lo -= 0.5; }
  const pad = 14, n = candles.length, slot = (W - 8) / n, bw = Math.max(3, Math.min(30, slot * 0.62));
  const ys = v => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
  const body = candles.map((c, i) => {
    const x = 4 + slot * i + slot / 2;
    const up = c.close >= c.open;
    const col = up ? 'var(--sell)' : '#3f7686';
    const y1 = ys(Math.max(c.open, c.close)), y2 = ys(Math.min(c.open, c.close));
    return `<g><title>${new Date(c.start_ms).toLocaleTimeString('en-GB')}  O ${px(c.open)} H ${px(c.high)} L ${px(c.low)} C ${px(c.close)}  V ${c.volume}</title>
      <line x1="${x}" x2="${x}" y1="${ys(c.high)}" y2="${ys(c.low)}" stroke="${col}" stroke-width="1.5"/>
      <rect x="${x - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(2, y2 - y1)}" fill="${col}" rx="1"/></g>`;
  }).join('');
  el.innerHTML = `<svg width="${W}" height="${H}">${body}</svg>`;
}

/** Simple vertical bars. values: number[]; colors: string[] | fn(i) */
export function barChart(el, values, opts = {}) {
  const W = Math.max(el.clientWidth, 200), H = opts.height || 180;
  if (!values.length) return emptyMsg(el, H, opts.empty || 'No data yet');
  const max = Math.max(...values, 1), n = values.length, gap = opts.gap ?? 10;
  const pad = opts.pad ?? 8, bw = Math.max(2, (W - 2 * pad - gap * (n - 1)) / n);
  const labH = opts.labels ? 30 : 0;
  const bars = values.map((v, i) => {
    const h = (v / max) * (H - labH - 12);
    const col = typeof opts.colors === 'function' ? opts.colors(i, v) : (opts.colors?.[i % opts.colors.length] || 'var(--accent)');
    const x = pad + i * (bw + gap);
    const lab = opts.labels ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="15" fill="var(--text)">${esc(opts.labels[i])}</text>` : '';
    return `<g><title>${esc(opts.titles?.[i] ?? v)}</title><rect x="${x}" y="${H - labH - h}" width="${bw}" height="${Math.max(1, h)}" fill="${col}" rx="2"/>${lab}</g>`;
  }).join('');
  el.innerHTML = `<svg width="${W}" height="${H}">${bars}</svg>`;
}

/** Market depth as bars around the spread (Live Order Book page). */
export function depthBars(el, bids, asks, opts = {}) {
  const W = Math.max(el.clientWidth, 200), H = opts.height || 190;
  const b = bids.slice(0, 16), a = asks.slice(0, 16);
  if (!b.length && !a.length) return emptyMsg(el, H, 'Order book is empty');
  // cumulative depth from the spread outwards
  let c = 0; const bc = b.map(l => (c += l.qty)); c = 0; const ac = a.map(l => (c += l.qty));
  const max = Math.max(...bc, ...ac, 1);
  const n = 16, mid = W / 2, slot = (W / 2 - 24) / n, bw = slot - 4;
  const ys = v => H - 16 - (v / max) * (H - 40);
  let out = '';
  bc.forEach((v, i) => {
    const x = mid - 6 - (i + 1) * slot;
    out += `<rect x="${x}" y="${ys(v)}" width="${bw}" height="${H - 16 - ys(v)}" fill="var(--buy)" opacity="${0.55 - i * 0.015}" rx="1"><title>${px(b[i].price)} cumulative ${v}</title></rect>`;
  });
  ac.forEach((v, i) => {
    const x = mid + 6 + i * slot;
    out += `<rect x="${x}" y="${ys(v)}" width="${bw}" height="${H - 16 - ys(v)}" fill="var(--sell)" opacity="${0.6 - i * 0.015}" rx="1"><title>${px(a[i].price)} cumulative ${v}</title></rect>`;
  });
  out += `<line x1="${mid}" x2="${mid}" y1="12" y2="${H - 16}" stroke="var(--dim)" stroke-dasharray="3 3"/>`;
  out += `<rect x="${mid - 40}" y="${H * 0.25}" width="80" height="${H * 0.45}" fill="none" stroke="var(--accent)" stroke-opacity="0.18" stroke-width="2" rx="3"/>`;
  el.innerHTML = `<svg width="${W}" height="${H}">${out}</svg>`;
}

/** Cumulative depth curve (Trading Terminal "Depth" view). */
export function depthCurve(el, bids, asks, opts = {}) {
  const W = Math.max(el.clientWidth, 200), H = opts.height || 260;
  if (!bids.length && !asks.length) return emptyMsg(el, H, 'Order book is empty');
  const pts = [];
  let c = 0;
  const bcum = bids.map(l => ({ price: l.price, cum: (c += l.qty) })).reverse();
  c = 0;
  const acum = asks.map(l => ({ price: l.price, cum: (c += l.qty) }));
  const all = [...bcum, ...acum];
  const lo = all[0].price, hi = all[all.length - 1].price === lo ? lo + 1 : all[all.length - 1].price;
  const max = Math.max(...all.map(p => p.cum), 1);
  const xs = p => 10 + ((p - lo) / (hi - lo)) * (W - 20);
  const ys = v => H - 20 - (v / max) * (H - 60);
  bcum.forEach(p => pts.push([xs(p.price), ys(p.cum), p]));
  acum.forEach(p => pts.push([xs(p.price), ys(p.cum), p]));
  const id = 'g' + (++gid);
  const line = smoothPath(pts.map(p => [p[0], p[1]]));
  const last = pts[pts.length - 1];
  el.innerHTML = `<svg width="${W}" height="${H}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <path d="${line}L${last[0]},${H}L${pts[0][0]},${H}Z" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>
    <line class="hover-line" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--line-2)" visibility="hidden"/>
  </svg><div class="tooltip hidden"></div>`;
  attachHover(el, pts, i => `₹${px(pts[i][2].price)} · cum ${pts[i][2].cum}`);
}

/** Exponential moving average helper. */
export function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map((v, i) => {
    prev = prev == null ? v : v * k + prev * (1 - k);
    return i + 1 >= Math.min(period, values.length) ? prev : null;
  });
}

/** Relative Strength Index helper (Wilder). */
export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= period; l /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
