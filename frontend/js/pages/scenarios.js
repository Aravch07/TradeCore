// Scenarios: load and replay deterministic order streams, step by step,
// through the real engine (each step is a normal API command).
import { get, post } from '../api.js';
import { $, $$, esc, int, ns, bytes, toast } from '../ui.js';
import { icon } from '../icons.js';

const sell = (label, price, qty, desc) => ({ label, kind: 'sell', tag: 'SELL LIMIT', desc, run: () => post('/api/orders', { side: 'sell', price, qty, trader: label }) });
const buy = (label, price, qty, desc) => ({ label, kind: 'buy', tag: 'BUY LIMIT', desc, run: () => post('/api/orders', { side: 'buy', price, qty, trader: label }) });

const SCENARIOS = [
  {
    id: 'worked', name: 'Worked Example TCX', badge: 'Proposal',
    blurb: 'Exact example from the proposal: S1–S4 resting sells, then B1 and B2 sweep them.',
    describe: `Recreates page 2 of the TradeCore proposal. Four sell limit orders (<b class="sell">S1 through S4</b>) build the ask side
      at ₹100, ₹100, ₹101 and ₹102. Two buy limit orders (<b class="buy">B1 and B2</b>) at ₹101 then cross the book, showing
      price-time priority, maker-price execution and partial fills.`,
    expect: [
      ['FIFO ties', 'S1 fills before S2: both ask ₹100.00 and S1 arrived first.'],
      ['Partial maker', 'B1 leaves S3 with 50 shares that keep their original priority.'],
      ['Resting remainder', 'B2 takes S3\'s 50 and rests 30 as the best bid; S4 at ₹102 is untouched.'],
    ],
    success: '250 SHARES IN 4 FILLS',
    steps: () => [
      sell('S1', 100, 80, 'Rest 80 TCX @ ₹100.00 into the ask queue (seq 1).'),
      sell('S2', 100, 70, 'Rest 70 TCX @ ₹100.00 behind S1 at the same price level (seq 2).'),
      sell('S3', 101, 100, 'Rest 100 TCX @ ₹101.00 — a new AVL node is inserted.'),
      sell('S4', 102, 40, 'Rest 40 TCX @ ₹102.00 — the insert triggers an AVL rotation.'),
      buy('B1', 101, 200, 'Buy 200 @ ₹101: fills S1 (80) and S2 (70) at ₹100, then 50 of S3 at ₹101.'),
      buy('B2', 101, 80, 'Buy 80 @ ₹101: takes S3\'s remaining 50; 30 rest as the best bid.'),
    ],
  },
  {
    id: 'deep', name: 'Deep Book AVL Stress', badge: 'Preset 02',
    blurb: 'Price levels inserted in sorted order — the worst case for a plain BST — force repeated AVL rotations.',
    describe: `Inserts 15 bid levels from ₹99.95 downwards and 15 ask levels from ₹100.05 upwards, <b>in sorted order</b>.
      An unbalanced binary search tree would degrade into a linked list of height 15; the AVL tree rotates to keep its height at 4.
      Open the <b>DSA Visualizer</b> in another tab to watch each rotation.`,
    expect: [
      ['Rotations', 'Every few inserts trigger a left or right rotation on each side.'],
      ['Bounded height', 'Each tree ends with 15 nodes and height 4 (perfectly balanced is ⌈log₂16⌉ = 4).'],
      ['No trades', 'Bids stay below asks, so nothing crosses: the book only grows.'],
    ],
    success: 'HEIGHT 4 FOR 15 NODES',
    steps: () => Array.from({ length: 15 }, (_, i) => i).flatMap(i => [
      { label: `D${2 * i + 1}`, kind: 'buy', tag: 'BUY LIMIT', desc: `Bid level ₹${(99.95 - i * 0.05).toFixed(2)} (10 TCX)`, run: () => post('/api/orders', { side: 'buy', price: (99.95 - i * 0.05).toFixed(2), qty: 10 + i, trader: 'deep' }) },
      { label: `D${2 * i + 2}`, kind: 'sell', tag: 'SELL LIMIT', desc: `Ask level ₹${(100.05 + i * 0.05).toFixed(2)} (10 TCX)`, run: () => post('/api/orders', { side: 'sell', price: (100.05 + i * 0.05).toFixed(2), qty: 10 + i, trader: 'deep' }) },
    ]),
  },
  {
    id: 'cancel', name: 'Cancellation & Replace Drill', badge: 'Preset 03',
    blurb: 'Queue five orders at one price, cancel the head, middle and tail, then replace one and watch it lose priority.',
    describe: `Five buy orders (Q1–Q5) join one FIFO queue at ₹99.50. Cancels then remove the <b>middle</b>, <b>head</b> and <b>tail</b>:
      each is an O(1) unlink because the hash table points straight at the node. Finally Q2 is replaced and moves to the back,
      and a sell order shows who is now first in line.`,
    expect: [
      ['O(1) unlink', 'Cancels never scan the queue: neighbours are re-linked directly.'],
      ['Priority loss', 'After replace, Q2 gets a new id and sequence at the tail.'],
      ['Head fills first', 'The final sell executes against Q4, the new head.'],
    ],
    success: 'Q4 FILLS FIRST',
    steps: () => {
      const ids = {};
      const q = n => ({ label: `Q${n}`, kind: 'buy', tag: 'BUY LIMIT', desc: `Join the ₹99.50 queue with ${n * 10} TCX`, run: async () => { const r = await post('/api/orders', { side: 'buy', price: 99.5, qty: n * 10, trader: `Q${n}` }); ids[n] = r.order?.id; return r; } });
      const c = (n, where) => ({ label: `X${n}`, kind: 'sell', tag: 'CANCEL', desc: `Cancel Q${n} (${where} of the queue)`, run: () => post(`/api/orders/${ids[n]}/cancel`) });
      return [q(1), q(2), q(3), q(4), q(5), c(3, 'middle'), c(1, 'head'), c(5, 'tail'),
        { label: 'R2', kind: 'sell', tag: 'REPLACE', desc: 'Replace Q2 with 25 TCX — new id, back of the queue', run: () => post(`/api/orders/${ids[2]}/replace`, { qty: 25 }) },
        sell('S9', 99.5, 30, 'Sell 30 @ ₹99.50: fills the head of the queue first')];
    },
  },
  {
    id: 'random', name: 'Random Order Flow', badge: 'Preset 04',
    blurb: 'Seeded stream of 5,000 submits, cancels and replaces, loaded in one batch for charts and benchmarks.',
    describe: `Runs the same seeded workload generator used by the C test suite and benchmark (65% submit, 20% cancel, 15% replace,
      2% invalid). The stream is executed inside the engine in one call, with simulated timestamps 250 ms apart so the charts fill in.`,
    expect: [
      ['Deterministic', 'The same seed always produces exactly the same fills.'],
      ['Rejections', 'Invalid prices and cancels of finished orders are rejected safely.'],
      ['Invariants', 'The book passes every invariant check afterwards.'],
    ],
    success: 'ZERO INVARIANT VIOLATIONS',
    batch: { name: 'random', seed: 42, count: 5000 },
    steps: () => [{ label: 'R', kind: 'buy', tag: 'BATCH', desc: 'Execute 5,000 seeded commands inside the engine', run: () => post('/api/scenario', { name: 'random', seed: 42, count: 5000, reset: false }) }],
  },
];

let sel = SCENARIOS[0], loaded = null, steps = [], pos = 0, running = false, speed = 1, timer = null, t0 = 0, elapsed = 0, clockTimer;

export default {
  html: () => `
  <div class="page-head">
    <div><div class="eyebrow"><span class="tag solid">SIMULATION CORE</span><span class="dim">/ Scenario Engine</span></div>
      <h1>Market Simulation &amp; Stress Testing</h1>
      <p>Configure, load, and execute deterministic order flow scenarios through the C matching engine.</p></div>
    <div class="card flat" style="display:flex;gap:12px;align-items:center;padding:12px 18px">
      <span class="dot" id="sc-dot"></span><div><div class="label muted" style="font-size:10.5px">Engine status</div><b class="buy" id="sc-status" style="font-size:14px">READY / IDLE</b></div></div>
  </div>

  <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.85fr)">
    <div class="card">
      <div class="card-head"><h3 style="font-size:17px">Scenario Selector</h3><span class="accent">${icon('sliders-horizontal', 18)}</span></div>
      <div class="sub" style="margin:-6px 0 16px">Select a pre-packaged scenario to load a preset order stream.</div>
      <div id="sc-list" style="display:flex;flex-direction:column;gap:12px"></div>
      <button class="btn primary lg block" style="margin-top:20px" id="sc-load">${icon('download', 17)} Load Selected Scenario</button>
    </div>
    <div class="card">
      <div class="card-head"><div class="title-row"><h3 style="font-size:17px">Execution Control Panel</h3><span class="tag buy up">TCX/INR Simulator</span></div>
        <label style="font-size:13px" class="title-row">SPEED: <select class="select" id="sc-speed" style="padding:4px 30px 4px 8px">
          <option value="0.5">0.5x</option><option value="1" selected>1.0x</option><option value="2">2.0x</option><option value="5">5.0x</option></select></label></div>
      <div class="card flat" style="background:var(--bg);border:1px solid var(--line)">
        <div class="grid g4" style="gap:12px">
          ${box('Simulation time', 'sc-time', 'accent')}${box('Active orders', 'sc-active', '')}${box('Processed commands', 'sc-done', 'buy')}${box('Fills', 'sc-fills', '')}
        </div>
        <div class="stat-row" style="font-size:12px;margin:16px 0 8px"><span id="sc-prog">Progress: 0%</span><span id="sc-dur">Steps: 0</span></div>
        <div class="bar"><i id="sc-bar" style="width:0"></i></div>
      </div>
      <div class="grid g3" style="margin-top:20px;gap:14px">
        <button class="btn success lg" id="sc-start">${icon('play', 17)} Start Replay</button>
        <button class="btn ghost lg" id="sc-pause">${icon('pause', 17)} Pause Replay</button>
        <button class="btn danger lg" id="sc-reset">${icon('rotate-ccw', 17)} Reset Simulation</button>
      </div>
      <div class="dim" style="font-size:12.5px;margin-top:12px">Tip: open the DSA Visualizer in a second browser tab to watch each command change the trees, queues and hash table.</div>
    </div>
  </div>

  <div class="grid g3 mt">
    <div class="card"><div class="title-row" style="margin-bottom:14px">${icon('info', 18)}<h3 style="font-size:17px">Description of Operations</h3></div>
      <div style="font-size:14px;color:var(--muted);line-height:1.55" id="sc-desc"></div>
      <div class="stat-row" style="border-top:1px solid var(--line);margin-top:16px;padding-top:12px;font-size:12px"><span class="label muted">Target asset:<br>TCX/INR</span><span class="buy label">Deterministic<br>feed</span></div></div>
    <div class="card"><div class="title-row" style="margin-bottom:14px"><span class="buy">${icon('circle-check', 18)}</span><h3 style="font-size:17px">Expected Behavior</h3></div>
      <ul class="check-list" id="sc-expect"></ul>
      <div class="stat-row" style="border-top:1px solid var(--line);margin-top:16px;padding-top:12px;font-size:12px"><span class="label muted">Success criteria</span><span class="accent label" id="sc-success"></span></div></div>
    <div class="card"><div class="title-row" style="margin-bottom:14px">${icon('chart-column', 18)}<h3 style="font-size:17px">Performance Metrics</h3></div>
      <div id="sc-metrics"></div>
      <div class="stat-row" style="border-top:1px solid var(--line);margin-top:16px;padding-top:12px;font-size:12px"><span class="label muted">Status</span><span class="label" id="sc-inv">—</span></div></div>
  </div>

  <div class="card mt">
    <div class="card-head"><div class="title-row">${icon('list-ordered', 18)}<h3 style="font-size:17px">Step-by-Step Event Sequence</h3></div><span class="label" id="sc-count"></span></div>
    <div id="sc-steps" style="display:flex;flex-direction:column;gap:12px"></div>
  </div>`,

  mount() {
    drawList(); drawInfo();
    $('#sc-list').onclick = e => { const c = e.target.closest('[data-id]'); if (!c || running) return; sel = SCENARIOS.find(s => s.id === c.dataset.id); drawList(); drawInfo(); };
    $('#sc-load').onclick = load;
    $('#sc-start').onclick = start;
    $('#sc-pause').onclick = pause;
    $('#sc-reset').onclick = resetSim;
    $('#sc-speed').value = String(speed);
    $('#sc-speed').onchange = e => { speed = +e.target.value; };
    clockTimer = setInterval(drawTime, 250);
    drawControls();
  },

  unmount() { clearInterval(clockTimer); /* a running replay keeps going in the background */ },

  async refresh() {
    const [s, st, chk] = await Promise.all([get('/api/summary'), get('/api/stats'), get('/api/check')]);
    $('#sc-active').textContent = int(s.active_orders);
    $('#sc-fills').textContent = int(s.total_trades);
    if (st.ok) {
      const c = st.counters;
      $('#sc-metrics').innerHTML = [
        ['Engine Latency (p50)', ns(st.latency_ns.p50), Math.min(1, st.latency_ns.p50 / 5000), 'buy'],
        ['Command Acceptance Rate', c.commands ? (c.accepted / c.commands * 100).toFixed(2) + '%' : '—', c.commands ? c.accepted / c.commands : 0, 'accent'],
        ['Book Memory Footprint', bytes(st.memory_bytes.book), Math.min(1, st.memory_bytes.book / 1e6), ''],
      ].map(([l, v, f, cls]) => `<div style="margin-bottom:16px"><div class="stat-row" style="font-size:13.5px;margin-bottom:6px"><span>${l}</span><b class="${cls}">${v}</b></div>
        <div class="bar ${cls === 'buy' ? 'buy' : ''}"><i style="width:${Math.max(3, f * 100)}%;${cls === '' ? 'background:var(--muted)' : ''}"></i></div></div>`).join('');
    }
    $('#sc-inv').innerHTML = chk.ok ? '<span class="accent">ALL INVARIANTS HOLD</span>' : `<span class="sell">${esc(chk.error)}</span>`;
  },
};

const box = (l, id, cls) => `<div class="card" style="padding:14px"><div class="label muted" style="font-size:10.5px">${l}</div><div class="num ${cls}" style="font-size:22px;font-weight:700;margin-top:6px" id="${id}">—</div></div>`;

function drawList() {
  $('#sc-list').innerHTML = SCENARIOS.map(s => `<div class="scn ${s === sel ? 'on' : ''}" data-id="${s.id}">
    <h4><span class="${s === sel ? 'accent' : ''}">${s.name}</span><span class="tag ${s === sel ? 'solid' : ''}">${s === loaded ? 'Loaded' : s.badge}</span></h4><p>${s.blurb}</p></div>`).join('');
}

function drawInfo() {
  $('#sc-desc').innerHTML = sel.describe;
  $('#sc-expect').innerHTML = sel.expect.map(([b, t]) => `<li>${icon('circle-check', 15)}<span><b>${b}:</b> ${t}</span></li>`).join('');
  $('#sc-success').textContent = sel.success;
  const st = loaded === sel ? steps : sel.steps();
  $('#sc-count').textContent = `${st.length} SCHEDULED EVENT${st.length === 1 ? '' : 'S'}`;
  const delay = 1.2;
  $('#sc-steps').innerHTML = st.map((s, i) => {
    const state = loaded === sel ? (i < pos ? 'done' : i === pos && running ? 'now' : '') : '';
    return `<div class="step ${s.kind === 'buy' ? 'buystep' : 'sellstep'} ${state}">
      <div class="n">${i + 1}</div>
      <div class="body"><div class="title-row" style="margin:0"><b>Order ${esc(s.label)}</b><span class="tag ${s.kind === 'buy' ? 'buy' : 'sell'} up">${s.tag}</span>${state === 'done' ? `<span class="tag">${icon('circle-check', 12)} done</span>` : ''}</div>
        <div>${s.desc}</div></div>
      <span class="tag" style="padding:6px 10px">T + ${fmtT(i * delay)}</span></div>`;
  }).join('');
  drawProgress();
}

function fmtT(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}s`; }

function drawProgress() {
  const n = loaded === sel ? steps.length : 0;
  const p = n ? Math.round(pos / n * 100) : 0;
  $('#sc-bar').style.width = p + '%';
  $('#sc-prog').textContent = `Progress: ${p}%`;
  $('#sc-dur').textContent = `Steps: ${pos} / ${n || sel.steps().length}`;
  $('#sc-done').textContent = int(pos);
}

function drawTime() {
  const ms = elapsed + (running ? Date.now() - t0 : 0);
  const el = $('#sc-time');
  if (el) el.textContent = new Date(ms).toISOString().substr(11, 8);
}

function drawControls() {
  $('#sc-start').disabled = running || !loaded || pos >= steps.length;
  $('#sc-pause').disabled = !running;
  $('#sc-load').disabled = running;
  const status = running ? 'RUNNING' : !loaded ? 'READY / IDLE' : pos >= steps.length ? 'COMPLETE' : pos ? 'PAUSED' : 'LOADED';
  $('#sc-status').textContent = status;
  $('#sc-status').className = running ? 'accent' : 'buy';
  $('#sc-dot').style.background = running ? 'var(--accent)' : 'var(--buy)';
}

async function load() {
  const ok = await post('/api/reset');
  if (!ok.ok) return toast('Could not reset the engine', 'err');
  loaded = sel; steps = sel.steps(); pos = 0; elapsed = 0;
  drawList(); drawInfo(); drawControls(); drawTime();
  toast(`Loaded <b>${sel.name}</b> — engine session reset. Press Start Replay.`, 'ok');
}

function start() {
  if (!loaded || running) return;
  if (loaded !== sel) { sel = loaded; drawList(); }
  running = true; t0 = Date.now();
  drawControls(); drawInfo();
  tick();
}

async function tick() {
  if (!running) return;
  if (pos >= steps.length) { finish(); return; }
  const r = await steps[pos].run();
  if (r && r.ok === false) toast(`Step ${pos + 1}: ${esc(r.message || r.error)}`, 'err');
  pos++;
  if ($('#sc-steps')) { drawInfo(); drawControls(); }
  if (pos >= steps.length) { finish(); return; }
  timer = setTimeout(tick, 1200 / speed);
}

function finish() {
  if (running) elapsed += Date.now() - t0;
  running = false;
  if ($('#sc-steps')) { drawInfo(); drawControls(); }
  toast(`<b>${loaded.name}</b> replay complete`, 'ok');
}

function pause() {
  if (!running) return;
  clearTimeout(timer);
  elapsed += Date.now() - t0;
  running = false;
  drawControls(); drawInfo();
}

async function resetSim() {
  clearTimeout(timer);
  running = false; pos = 0; elapsed = 0;
  await post('/api/reset');
  drawControls(); drawInfo(); drawTime();
  toast('Simulation reset — the order book is empty', 'ok');
}
