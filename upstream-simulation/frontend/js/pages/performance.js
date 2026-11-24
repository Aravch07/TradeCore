// Performance Analytics: engine latency, throughput, DSA telemetry.
// Every number shown here is measured by the C engine or the browser.
import { get, roundTrips } from '../api.js';
import { shared, bus } from '../store.js';
import { $, esc, int, ns, bytes, clock, toast, onResize } from '../ui.js';
import { icon } from '../icons.js';
import { pageHead } from './common.js';

let samples = [];          // [{t, p50, p99, rtt}]
let last = null, stopResize, offCmd, timer;

export default {
  html: () => `
  ${pageHead('System Performance &amp; Core Diagnostics', 'Real-time latency profiling, memory footprint, and internal data structure telemetry.',
    `<div class="card flat" style="padding:12px 18px;display:flex;gap:10px;align-items:center"><span class="dot" id="pf-dot"></span><span style="font-size:15px;letter-spacing:.04em" id="pf-state">ENGINE STATE: —</span></div>
     <button class="btn primary lg" id="pf-flush">${icon('refresh-cw', 16)} Flush Telemetry</button>`)}
  <div class="grid g4">
    ${kpi('P99 execution latency', 'pf-p99', 'gauge', 'pf-p99b', 'accent')}
    ${kpi('Throughput / CPS', 'pf-cps', 'zap', 'pf-cpsb', 'sell')}
    ${kpi('AVL tree rotations', 'pf-rot', 'workflow', 'pf-rotb', 'buy')}
    ${kpi('Hash table probes', 'pf-probe', 'network', 'pf-probeb', 'accent')}
  </div>
  <div class="grid mt" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head" style="align-items:flex-start">
        <div><h3 style="font-size:18px">Latency Profile: Engine vs Round-Trip</h3>
          <div class="sub" style="font-size:15px">Isolates core matching-engine time from HTTP transport (log scale, µs).</div></div>
        <div class="legend" style="flex-direction:column;gap:6px"><span><i style="background:var(--accent);border-radius:2px"></i>Engine p99</span><span><i style="background:var(--sell);border-radius:2px"></i>API round-trip</span></div>
      </div>
      <div class="chart-frame" style="padding:10px"><div class="chart" id="pf-chart"></div></div>
    </div>
    <div class="card">
      <h3 style="font-size:18px">Data Structure Telemetry</h3>
      <div class="sub" style="font-size:15px;margin-bottom:22px">Live allocations and tree depth bounds.</div>
      <div id="pf-tele"></div>
      <div class="card flat" style="margin-top:22px;display:flex;gap:12px;align-items:flex-start;padding:14px">
        <span id="pf-checkico" class="buy">${icon('shield-check', 20)}</span><span style="font-size:15px" id="pf-check">Checking invariants…</span>
      </div>
    </div>
  </div>
  <div class="grid g2 mt">
    <div class="card">
      <div class="card-head"><h3 style="font-size:18px;font-weight:500">Operation Mix</h3><span style="font-size:16px">Single engine thread</span></div>
      <div id="pf-mix" style="display:flex;flex-direction:column;gap:10px"></div>
    </div>
    <div class="card">
      <div class="card-head"><h3 style="font-size:18px;font-weight:500">Execution Benchmark Log</h3><span class="sell" style="font-size:16px">Real-time Stream</span></div>
      <div id="pf-log" style="display:flex;flex-direction:column;gap:8px"></div>
      <div class="stat-row" style="border-top:1px solid var(--line);margin-top:18px;padding-top:16px">
        <span style="font-size:16px">Engine command seq: <b id="pf-seq">—</b></span>
        <a href="#" id="pf-dump" style="font-size:16px">Export Profiler Dump ${icon('download', 15)}</a></div>
    </div>
  </div>`,

  mount() {
    $('#pf-flush').onclick = () => { samples = []; roundTrips.length = 0; this.refresh(); toast('Telemetry samples cleared', 'ok'); };
    $('#pf-dump').onclick = e => {
      e.preventDefault();
      const blob = new Blob([JSON.stringify({ stats: last, samples, commands: shared.commandLog.slice(0, 100) }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tradecore-profile-${Date.now()}.json`; a.click();
    };
    stopResize = onResize($('#pf-chart'), drawChart);
    offCmd = bus.on('command', drawLog);
    timer = setInterval(() => this.refresh(), 3000);
  },

  unmount() { stopResize?.(); offCmd?.(); clearInterval(timer); },

  async refresh() {
    const [st, chk] = await Promise.all([get('/api/stats'), get('/api/check')]);
    if (!st.ok) return;
    last = st;
    const rt = roundTrips.slice(-30).map(r => r.ms);
    const rttMs = rt.length ? rt.sort((a, b) => a - b)[Math.floor(rt.length / 2)] : null;
    samples.push({ t: Date.now(), p50: st.latency_ns.p50, p99: st.latency_ns.p99, rtt: rttMs });
    if (samples.length > 12) samples.shift();
    const c = st.counters, L = st.latency_ns;

    $('#pf-dot').style.background = chk.ok ? 'var(--buy)' : 'var(--sell)';
    $('#pf-state').innerHTML = `ENGINE STATE: <b class="${chk.ok ? 'buy' : 'sell'}">${chk.ok ? 'OPTIMAL' : 'INVARIANT FAILURE'}</b>`;
    setKpi('pf-p99', `${ns(L.p99)} <span class="dim" style="font-size:14px">p50 ${ns(L.p50)}</span>`, 'pf-p99b', L.max ? L.p99 / L.max : 0);
    const cps = st.engine_throughput_cmds_per_s;
    setKpi('pf-cps', `${cps >= 1e6 ? (cps / 1e6).toFixed(2) + ' M' : (cps / 1e3).toFixed(1) + ' k'}<span style="font-size:13px">/s</span> <span class="dim" style="font-size:14px">engine-only</span>`, 'pf-cpsb', Math.min(1, cps / 1e7));
    const hb = st.book.bid_height, ha = st.book.ask_height;
    const bound = n => n ? Math.floor(1.44 * Math.log2(n + 2)) : 0;
    setKpi('pf-rot', `${int(c.avl_rotations)} <span class="${hb <= bound(st.book.bid_levels) && ha <= bound(st.book.ask_levels) ? 'buy' : 'sell'}" style="font-size:14px">Balanced (h ${hb}/${ha})</span>`, 'pf-rotb', c.avl_inserts ? Math.min(1, c.avl_rotations / c.avl_inserts) : 0);
    const ppl = c.hash_lookups ? c.hash_probes / c.hash_lookups : 0;
    setKpi('pf-probe', `${ppl.toFixed(2)} <span style="font-size:14px">avg</span> <span class="accent" style="font-size:14px">O(1) expected</span>`, 'pf-probeb', Math.min(1, ppl / 4));

    const levels = st.book.bid_levels + st.book.ask_levels;
    const tele = [
      ['Active AVL Nodes (price levels)', `${int(levels)} <span class="dim">· heights ${hb}/${ha}</span>`, levels ? Math.min(1, levels / Math.max(levels, 64)) : 0, 'accent'],
      ['Active Limit Orders (hash entries)', int(st.book.active_orders), Math.min(1, st.book.active_orders / Math.max(1000, st.book.active_orders * 1.3)), 'sell'],
      ['Book Memory / History Memory', `${bytes(st.memory_bytes.book)} / ${bytes(st.memory_bytes.history)}`, st.memory_bytes.history ? Math.min(1, st.memory_bytes.book / st.memory_bytes.history) : 0, 'buy'],
      ['Live Heap Blocks (allocs − frees)', `${int(c.allocs - c.frees)} <span class="dim">· ${st.memory_bytes.per_active_order.toFixed(0)} B/order</span>`, c.allocs ? (c.allocs - c.frees) / c.allocs : 0, 'sell'],
    ];
    $('#pf-tele').innerHTML = tele.map(([l, v, f, cls]) => `<div style="margin-bottom:16px">
      <div class="stat-row" style="font-size:13.5px;margin-bottom:6px"><span>${l}</span><span class="num">${v}</span></div>
      <div class="bar ${cls === 'accent' ? '' : cls}"><i style="width:${Math.max(2, f * 100)}%;${cls === 'sell' ? '' : ''}"></i></div></div>`).join('');
    $('#pf-check').innerHTML = chk.ok
      ? `All invariants hold: AVL balance, FIFO order, level totals, hash consistency, uncrossed book. <span class="dim">(${clock(Date.now())})</span>`
      : `<b class="sell">Invariant violated:</b> ${esc(chk.error)}`;
    $('#pf-checkico').className = chk.ok ? 'buy' : 'sell';

    const ops = [
      ['AVL node visits (search)', c.avl_visits, 'var(--accent)'],
      ['FIFO enqueue / dequeue / unlink', c.fifo_enqueues + c.fifo_dequeues + c.fifo_unlinks, 'var(--sell)'],
      ['Hash probes (lookup + erase)', c.hash_probes, 'var(--buy)'],
      ['Fills executed', c.fills, '#c9e6f0'],
    ];
    const total = ops.reduce((a, o) => a + o[1], 0) || 1;
    $('#pf-mix').innerHTML = ops.map(([l, v, col]) => `<div class="card flat" style="display:flex;align-items:center;gap:16px;padding:12px 16px">
      <span style="flex:1;font-size:14.5px">${l} <span class="dim">(${int(v)})</span></span>
      <div class="bar" style="width:90px"><i style="width:${v / total * 100}%;background:${col}"></i></div>
      <b style="width:44px;text-align:right;color:${col}">${Math.round(v / total * 100)}%</b></div>`).join('');
    $('#pf-seq').textContent = `#${int(c.commands)}`;
    drawChart();
    drawLog();
  },
};

function kpi(label, id, ic, bar, cls) {
  return `<div class="card"><div class="stat-row" style="align-items:flex-start"><span style="font-size:17px;letter-spacing:.05em;text-transform:uppercase">${label}</span><span class="accent">${icon(ic, 18)}</span></div>
    <div style="font-size:17px;margin:10px 0 14px" class="num ${cls}" id="${id}">—</div><div class="bar ${cls === 'accent' ? '' : cls}"><i id="${bar}" style="width:0"></i></div></div>`;
}

function setKpi(id, html, bar, frac) {
  $('#' + id).innerHTML = html;
  $('#' + bar).style.width = `${Math.max(3, frac * 100)}%`;
}

function drawChart() {
  const el = $('#pf-chart');
  if (!el) return;
  const W = Math.max(el.clientWidth, 200), H = 230;
  if (!samples.length) { el.innerHTML = '<div class="empty">Collecting samples…</div>'; return; }
  const us = samples.flatMap(s => [s.p99 / 1000, s.rtt != null ? s.rtt * 1000 : null]).filter(v => v != null && v > 0);
  const maxLog = Math.log10(Math.max(...us, 10)) + 0.3, minLog = Math.min(-1, Math.log10(Math.min(...us)) - 0.3);
  const h = v => v > 0 ? ((Math.log10(v) - minLog) / (maxLog - minLog)) * (H - 40) : 0;
  const n = 12, slot = (W - 20) / n, bw = (slot - 14) / 2;
  let out = '';
  samples.forEach((s, i) => {
    const x = 10 + i * slot + 4;
    const e = s.p99 / 1000, r = s.rtt != null ? s.rtt * 1000 : 0;
    out += `<rect x="${x}" y="${H - 30 - h(e)}" width="${bw}" height="${h(e)}" fill="var(--accent)" opacity="0.8" rx="2"><title>engine p99 ${ns(s.p99)}</title></rect>`;
    if (r) out += `<rect x="${x + bw + 4}" y="${H - 30 - h(r)}" width="${bw}" height="${h(r)}" fill="var(--sell)" opacity="0.65" rx="2"><title>round-trip ${s.rtt.toFixed(2)} ms</title></rect>`;
    out += `<text x="${x + bw + 2}" y="${H - 8}" text-anchor="middle" font-size="13" fill="var(--text)">${clock(s.t)}</text>`;
  });
  el.innerHTML = `<svg width="${W}" height="${H}">${out}</svg>`;
}

function drawLog() {
  const el = $('#pf-log');
  if (!el) return;
  const cmds = shared.commandLog.slice(0, 5);
  el.innerHTML = cmds.length ? cmds.map(c => {
    const what = c.ok
      ? `${c.command[0].toUpperCase() + c.command.slice(1)} #${c.order?.id ?? c.order_id ?? ''}${c.fills?.length ? ` · ${c.fills.length} fill${c.fills.length > 1 ? 's' : ''}` : ''} · ${c.events.to - c.events.from} trace events`
      : `Rejected ${c.command}: ${c.error}`;
    return `<div class="card flat" style="display:flex;align-items:center;gap:10px;padding:10px 14px">
      <span class="dot" style="background:${c.ok ? (c.fills?.length ? 'var(--buy)' : 'var(--accent)') : 'var(--sell)'}"></span>
      <span style="flex:1;font-size:14.5px">${esc(what)}</span><b class="num ${c.ok ? 'sell' : 'dim'}" style="font-size:14px">${ns(c.engine_ns)}</b></div>`;
  }).join('') : '<div class="empty">Commands appear here as they stream from the engine.</div>';
}
