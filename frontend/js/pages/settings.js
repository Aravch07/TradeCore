// Settings: every control here changes real behaviour of the dashboard.
import { get, post, roundTrips, connectStream } from '../api.js';
import { settings } from '../store.js';
import { $, $$, esc, toast, modal } from '../ui.js';
import { icon } from '../icons.js';

let draft = null, trace = null, timer;

const SECTIONS = [
  ['general', 'General & Display', 'sliders-horizontal'],
  ['trading', 'Trading Terminal', 'chart-candlestick'],
  ['charts', 'Charts & Visuals', 'trending-up'],
  ['stream', 'Live Stream & Alerts', 'bell'],
  ['engine', 'Engine & API', 'shield-check'],
];

export default {
  html: () => `
  <div class="page-head">
    <div><h1>Platform Settings</h1><p>Configure your workspace preferences, execution feeds, and data visualization engines.</p></div>
    <div class="head-actions"><button class="btn ghost" id="st-reset">Reset Defaults</button><button class="btn primary" id="st-save">Save Changes</button></div>
  </div>
  <div class="grid" style="grid-template-columns:240px minmax(0,1fr);align-items:start">
    <div class="grid" style="position:sticky;top:12px">
      <div class="card" style="padding:10px"><div class="settings-nav" id="st-nav">
        ${SECTIONS.map(([id, l, ic], i) => `<button data-s="${id}" class="${i ? '' : 'on'}">${icon(ic, 16)} ${l}</button>`).join('')}</div></div>
      <div class="card" style="padding:14px">
        <div class="title-row" style="gap:10px"><span class="metric-ico buy" style="width:32px;height:32px">${icon('zap', 16)}</span>
          <div><b style="font-size:14px">Latency Profile</b><div class="muted" style="font-size:12.5px" id="st-lat">Local engine • —</div></div></div>
        <div class="bar buy" style="margin-top:12px"><i id="st-latbar" style="width:80%"></i></div>
      </div>
    </div>
    <div class="grid" id="st-body"></div>
  </div>`,

  async mount() {
    draft = settings.all();
    render();
    $('#st-nav').onclick = e => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      $$('#st-nav button').forEach(x => x.classList.toggle('on', x === b));
      document.getElementById('sec-' + b.dataset.s)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    $('#st-save').onclick = save;
    $('#st-reset').onclick = () => { draft = settings.defaults(); render(); toast('Defaults restored — press Save Changes to apply'); };
    timer = setInterval(updateLatency, 2000);
    updateLatency();
    const ev = await get('/api/events?limit=1').catch(() => null);
    trace = ev ? { enabled: ev.enabled, detailed: ev.detailed } : null;
    renderEngine();
  },

  unmount() { clearInterval(timer); },
  refresh() { updateLatency(); },
};

function updateLatency() {
  const rt = roundTrips.slice(-20).map(r => r.ms).sort((a, b) => a - b);
  const med = rt.length ? rt[Math.floor(rt.length / 2)] : null;
  const el = $('#st-lat');
  if (!el) return;
  el.textContent = `Local engine • ${med == null ? '—' : med.toFixed(1) + 'ms'} round-trip`;
  $('#st-latbar').style.width = med == null ? '0' : `${Math.max(8, 100 - Math.min(92, med * 4))}%`;
}

const toggle = (key, on) => `<label class="toggle"><input type="checkbox" data-k="${key}" ${on ? 'checked' : ''}><span></span></label>`;
const row = (t, d, ctrl) => `<div class="set-row"><div><div class="t">${t}</div><div class="d">${d}</div></div>${ctrl}</div>`;

function render() {
  const d = draft;
  $('#st-body').innerHTML = `
  <div class="card" id="sec-general">
    <h3>Display &amp; Theme Preferences</h3><div class="sub" style="margin-bottom:18px">Customize the visual appearance of the TradeCore platform.</div>
    <div style="display:flex;gap:16px;margin-bottom:12px">
      <div class="theme-opt ${d.theme === 'dark' ? 'on' : ''}" data-theme-pick="dark">
        <div class="stat-row"><b class="${d.theme === 'dark' ? 'accent' : ''}">Dark Terminal</b>${d.theme === 'dark' ? `<span class="accent">${icon('circle-check', 18)}</span>` : '<span class="dim">○</span>'}</div>
        <div class="pv" style="background:#000"><i style="width:10px;height:10px;border-radius:50%;background:#5fc3e4"></i><i style="width:60px;background:#333"></i><i style="width:30px;background:#79d7a3"></i></div>
        <div class="muted" style="font-size:13px">High contrast dark theme optimized for multi-monitor trading setups.</div></div>
      <div class="theme-opt ${d.theme === 'light' ? 'on' : ''}" data-theme-pick="light">
        <div class="stat-row"><b class="${d.theme === 'light' ? 'accent' : ''}">Paper / Light Mode</b>${d.theme === 'light' ? `<span class="accent">${icon('circle-check', 18)}</span>` : '<span class="dim">○</span>'}</div>
        <div class="pv" style="background:#f3f1ec"><i style="width:10px;height:10px;border-radius:50%;background:#8a8a8a"></i><i style="width:60px;background:#cfcac0"></i><i style="width:30px;background:#1f8fb6"></i></div>
        <div class="muted" style="font-size:13px">Toggleable alternative presentation mode for projectors and printing.</div></div>
    </div>
    ${row('Compact Information Density', 'Reduce card padding and spacing for maximum data visibility.', toggle('compact', d.compact))}
    ${row('Animation Speed Defaults', 'Speed for order book depth updates and chart transitions.',
      `<select class="select" data-k="animMs">${[[150, 'Fast (150ms)'], [300, 'Normal (300ms)'], [0, 'Off']].map(([v, l]) => `<option value="${v}" ${d.animMs == v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
  </div>

  <div class="card" id="sec-trading">
    <h3>Trading Terminal Preferences</h3><div class="sub" style="margin-bottom:10px">Order entry defaults and confirmation settings.</div>
    ${row('Trader ID', 'Label attached to orders placed from this browser. "My Orders" and YOURS markers use it.',
      `<div class="input" style="height:38px;width:170px"><input data-k="trader" maxlength="15" value="${esc(d.trader)}" style="font-size:15px"></div>`)}
    ${row('One-Click Trading', 'Place orders instantly without a confirmation dialog.', toggle('oneClick', d.oneClick))}
    ${row('Default Order Type', 'Pre-selected order type in the order entry panel.',
      `<select class="select"><option selected>Limit Order</option><option disabled>Market (out of scope)</option><option disabled>Stop-Limit (out of scope)</option></select>`)}
    ${row('Default Quantity', 'Initial quantity in the order entry panel (whole shares).',
      `<div class="seg" data-seg="defaultQty">${[10, 50, 100, 500].map(v => `<button data-v="${v}" class="${d.defaultQty == v ? 'on' : ''}">${v}</button>`).join('')}</div>`)}
  </div>

  <div class="card" id="sec-charts">
    <h3>Chart &amp; Visualization Preferences</h3><div class="sub" style="margin-bottom:10px">Rendering style, order book grouping and visualizer playback.</div>
    ${row('Chart Line Rendering', 'Smooth curves use a monotone cubic spline (no overshoot); straight joins show raw fills.',
      `<select class="select" data-k="chartSmooth"><option value="true" ${d.chartSmooth ? 'selected' : ''}>SVG · Smooth (Recommended)</option><option value="false" ${!d.chartSmooth ? 'selected' : ''}>SVG · Straight segments</option></select>`)}
    ${row('Order Book Depth Aggregation', 'Default grouping precision for bid/ask levels.',
      `<select class="select" data-k="aggregation">${[0.05, 0.1, 1].map(v => `<option value="${v}" ${d.aggregation == v ? 'selected' : ''}>${v.toFixed(2)} INR</option>`).join('')}</select>`)}
    ${row('DSA Visualizer Playback Speed', 'Default speed for replaying trace events.',
      `<select class="select" data-k="vizSpeed">${[0.5, 1, 2, 4].map(v => `<option value="${v}" ${d.vizSpeed == v ? 'selected' : ''}>${v}x</option>`).join('')}</select>`)}
    ${row('Live Price Flash Animation', 'Highlight price ticks with green/red background flashes.', toggle('flash', d.flash))}
  </div>

  <div class="card" id="sec-stream">
    <h3>Live Stream Connection &amp; Notifications</h3><div class="sub" style="margin-bottom:10px">Server-Sent Events feed from the C engine, reconnection and alerts.</div>
    ${row('Stream Auto-Reconnection', 'Automatically re-establish a dropped event stream.', toggle('autoReconnect', d.autoReconnect))}
    ${row('Connection Status Notifications', 'Toast alerts when the live stream connects or drops.', toggle('connToasts', d.connToasts))}
    ${row('Trade Execution Audio Cues', 'Play a short tone on every fill.', toggle('audio', d.audio))}
  </div>

  <div class="card" id="sec-engine">
    <h3>Engine &amp; API</h3><div class="sub" style="margin-bottom:10px">Where the C engine runs and how much it traces. Trace switches apply immediately.</div>
    ${row('Engine URL', 'Leave empty when the engine serves this page (./build/tradecore --static frontend).',
      `<div class="input" style="height:38px;width:260px"><input data-k="apiBase" placeholder="same origin" value="${esc(d.apiBase)}" style="font-size:15px"></div>`)}
    <div id="st-engine"></div>
    ${row('Reset Engine Session', 'Clears the order book, orders and trades in the running engine.', '<button class="btn danger sm" id="st-wipe">Reset Session</button>')}
  </div>`;

  $('#st-body').onchange = e => {
    const k = e.target.dataset.k;
    if (!k || k.startsWith('trace')) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (['animMs', 'aggregation', 'vizSpeed'].includes(k)) v = +v;
    if (k === 'chartSmooth') v = v === 'true';
    draft[k] = v;
  };
  $('#st-body').oninput = e => { const k = e.target.dataset.k; if (k === 'trader' || k === 'apiBase') draft[k] = e.target.value.trim(); };
  $$('[data-theme-pick]').forEach(el => el.onclick = () => { draft.theme = el.dataset.themePick; render(); renderEngine(); });
  $$('[data-seg] button').forEach(b => b.onclick = () => {
    draft[b.parentElement.dataset.seg] = +b.dataset.v;
    $$('button', b.parentElement).forEach(x => x.classList.toggle('on', x === b));
  });
  $('#st-wipe').onclick = async () => {
    if (!await modal({ title: 'Reset engine session?', body: 'All orders and trades in the running engine are cleared.', okText: 'Reset', danger: true })) return;
    const r = await post('/api/reset');
    toast(r.ok ? 'Engine session reset' : 'Reset failed', r.ok ? 'ok' : 'err');
  };
}

function renderEngine() {
  const el = $('#st-engine');
  if (!el) return;
  if (!trace) { el.innerHTML = row('Engine Tracing', 'Engine not reachable.', '<span class="dim">—</span>'); return; }
  el.innerHTML = row('Engine Tracing', 'Record trace events at all. Turn off for benchmark mode.', `<label class="toggle"><input type="checkbox" data-k="trace-enabled" ${trace.enabled ? 'checked' : ''}><span></span></label>`)
    + row('Detailed DSA Events', 'Include AVL visits/rotations, FIFO and hash operations (needed by the DSA Visualizer).', `<label class="toggle"><input type="checkbox" data-k="trace-detailed" ${trace.detailed ? 'checked' : ''}><span></span></label>`);
  $$('[data-k^="trace-"]', el).forEach(i => i.onchange = async () => {
    const key = i.dataset.k.slice(6);
    const r = await post('/api/trace', { [key]: i.checked });
    if (r.ok) { trace = { enabled: r.enabled, detailed: r.detailed }; toast(`Engine tracing: ${r.enabled ? (r.detailed ? 'detailed' : 'market events only') : 'off (benchmark mode)'}`, 'ok'); }
  });
}

function save() {
  const baseChanged = draft.apiBase !== settings.get('apiBase');
  if (!draft.trader) draft.trader = 'ME';
  settings.set(draft);
  if (baseChanged) connectStream();
  toast('Settings saved', 'ok');
}
