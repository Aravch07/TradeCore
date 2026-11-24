// DSA Visualizer: AVL price trees, the FIFO queue at a price, the hash table,
// animated by the engine's own ordered trace events.
//
// How it works: the page keeps a SNAPSHOT of each structure (fetched from
// /api/dsa/*). Trace events for each command arrive over the live stream and
// are queued; playback highlights the nodes/buckets each event touches on the
// snapshot taken BEFORE that command. When a command's events have all been
// played, a fresh snapshot is fetched so the new shape appears.
import { get, post, isMine } from '../api.js';
import { settings, bus } from '../store.js';
import { $, $$, esc, px, int, toast, onResize } from '../ui.js';
import { icon } from '../icons.js';
import { pageHead, wireSeg } from './common.js';

const S = {
  side: 'buy', depth: 4,
  trees: { buy: null, sell: null },
  hash: null, hashPage: 0,
  level: null, selLevel: null,      // {side, price}
  selOrder: null, selBucket: null,
  queue: [], playing: true, speed: 1, cur: null, log: [],
  pendingSnapshot: false, newNodes: new Set(), trace: null,
  animate: 'mine', owners: new Map(), lastSnap: 0, snapTimer: null, skipped: 0,
};
let playTimer = null, offs = [], stopResize;

const EXPLAIN = {
  ORDER_ACCEPTED: e => `Command #${e.cmd_seq}: order <b>#${e.order_id}</b> accepted — ${e.side} ${e.qty} @ ₹${px(e.price)}.`,
  ORDER_REJECTED: e => `Command #${e.cmd_seq} rejected: <b>${e.reason}</b>. No data structure changed.`,
  AVL_VISIT: e => `AVL search for ₹${px(e.price)} visits node ₹${px(e.node_price)} → ${e.price === e.node_price ? '<b>found</b>' : e.price < e.node_price ? 'go <b>left</b> (smaller)' : 'go <b>right</b> (larger)'}.`,
  AVL_INSERT: e => `₹${px(e.price)} was not in the ${e.side === 'buy' ? 'bid' : 'ask'} tree → new leaf node <b>#${e.node_id}</b> inserted. Heights are updated on the way back up.`,
  AVL_REMOVE: e => `Level ₹${px(e.price)} is empty → node <b>#${e.node_id}</b> removed from the AVL tree (O(log P)); its successor node is relinked in place.`,
  AVL_ROTATE_LEFT: e => `Balance factor reached −2 at node #${e.node_id} (₹${px(e.price)}) → <b>rotate left</b>: node #${e.new_root_id} becomes the subtree root.`,
  AVL_ROTATE_RIGHT: e => `Balance factor reached +2 at node #${e.node_id} (₹${px(e.price)}) → <b>rotate right</b>: node #${e.new_root_id} becomes the subtree root.`,
  BEST_CHANGED: e => e.empty ? `The ${e.side === 'buy' ? 'bid' : 'ask'} side is now empty.` : `Cached best ${e.side === 'buy' ? 'bid' : 'ask'} is now ₹${px(e.price)} (node #${e.node_id}) — reading it is O(1).`,
  FIFO_ENQUEUE: e => `Order #${e.order_id} appended at the <b>tail</b> of the ₹${px(e.price)} queue (now ${e.level_count} order${e.level_count === 1 ? '' : 's'}) — O(1).`,
  FIFO_DEQUEUE: e => `Head order #${e.order_id} fully filled → removed from the <b>head</b> of the ₹${px(e.price)} queue — O(1).`,
  FIFO_UNLINK: e => `Order #${e.order_id} unlinked from the ₹${px(e.price)} queue by joining its prev and next neighbours — O(1), no scan.`,
  LEVEL_QTY: e => `Level ₹${px(e.price)} aggregate quantity is now <b>${int(e.total_qty)}</b>.`,
  HASH_INSERT: e => `Order id #${e.order_id} hashed into bucket <b>${e.bucket}</b> (chain length ${e.chain_len}).`,
  HASH_ERASE: e => `Order id #${e.order_id} erased from bucket <b>${e.bucket}</b> after ${e.probes} probe${e.probes === 1 ? '' : 's'}.`,
  HASH_RESIZE: e => `Load factor passed 0.75 → table doubled from ${e.old_capacity} to <b>${e.new_capacity}</b> buckets; every entry rehashed (O(N), amortized O(1)).`,
  FILL: e => `<b>Fill</b>: taker #${e.order_id} × maker #${e.maker_id} — ${e.qty} @ ₹${px(e.price)} (maker's price). Maker keeps ${e.maker_remaining}, taker needs ${e.taker_remaining}.`,
  ORDER_RESTED: e => `Order #${e.order_id} rests ${e.qty} @ ₹${px(e.price)} in node #${e.node_id}.`,
  ORDER_FILLED: e => `Order #${e.order_id} is completely filled.`,
  ORDER_CANCELLED: e => `Order #${e.order_id} cancelled (${e.qty} unfilled).`,
  ORDER_REPLACED: e => `Order #${e.order_id} replaced → new order #${e.new_order_id} goes to the back of the queue (priority lost).`,
};

const CAT = t => t.startsWith('AVL') || t === 'BEST_CHANGED' ? ['AVL', 'accent'] : t.startsWith('FIFO') || t === 'LEVEL_QTY' ? ['FIFO', 'buy'] : t.startsWith('HASH') ? ['HASH', 'sell'] : t === 'FILL' ? ['FILL', 'sell'] : ['ORDER', ''];

export default {
  html: () => `
  ${pageHead('DSA Visualizer', 'Watch the AVL trees, FIFO queues and hash table change, one engine operation at a time.',
    `<div class="seg" id="dv-side"><button class="on" data-v="buy">Bid Tree</button><button data-v="sell">Ask Tree</button></div>
     <select class="select" id="dv-depth"><option value="3">Depth: 3</option><option value="4" selected>Depth: 4</option><option value="5">Depth: 5</option></select>`,
    `DATA STRUCTURES // LIVE ENGINE INTERNALS <span class="tag buy" id="dv-tracetag">TRACE: —</span>`)}

  <div class="grid g4">
    ${kpi('AVL height', 'dv-h', 'workflow', 'dv-hb', 'accent')}
    ${kpi('Price levels (P)', 'dv-p', 'layers', 'dv-pb', 'sell')}
    ${kpi('Hash load factor', 'dv-lf', 'hash', 'dv-lfb', 'buy')}
    ${kpi('Trace ring buffer', 'dv-ev', 'database', 'dv-evb', 'accent')}
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,1.65fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head">
        <div><div class="title-row"><h3>AVL Price-Level Tree</h3><span class="tag accent" id="dv-treetag">Bids · max cached</span></div>
          <div class="sub">Keyed by price. Each node is a price level holding a FIFO queue. Click a node to inspect it.</div></div>
      </div>
      <div class="viz-frame"><div id="dv-tree"></div></div>
      <div class="stat-row" style="margin-top:12px">
        <div class="legend"><span><i style="background:#20414d;border:2px solid var(--accent)"></i>Visited</span><span><i style="background:#4a2a26;border:2px solid var(--sell)"></i>Rotated</span>
          <span><i style="background:#1d3b2b;border:2px solid var(--buy)"></i>Inserted</span><span><i style="background:var(--card-3);border:2px solid var(--buy)"></i>Best price</span></div>
        <span class="dim" style="font-size:12.5px" id="dv-treenote"></span></div>
    </div>

    <div class="grid" style="align-content:start">
      <div class="card">
        <div class="card-head" style="margin-bottom:12px"><h3>Drive the Engine</h3><a href="#/lab/scenarios" style="font-size:13px">Step-by-step scenarios →</a></div>
        <div style="display:grid;grid-template-columns:auto minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:center">
          <div class="seg sm" id="dv-oside"><button class="on" data-v="buy">BUY</button><button data-v="sell">SELL</button></div>
          <div class="input" style="height:38px"><input id="dv-price" placeholder="Price ₹" style="font-size:15px"></div>
          <div class="input" style="height:38px"><input id="dv-qty" placeholder="Qty" style="font-size:15px"></div>
          <button class="btn primary" id="dv-send">Send</button>
        </div>
        <div class="dim" style="font-size:12.5px;margin-top:10px">Orders are placed as <b id="dv-trader"></b>. Tip: buy at or above the best ask to watch fills, dequeues and node removals.</div>
      </div>
      <div class="card">
        <div class="card-head" style="margin-bottom:12px"><h3>Trace Playback</h3><span class="tag" id="dv-queued">0 queued</span></div>
        <div class="stat-row" style="margin-bottom:12px;font-size:13.5px"><span>Animate</span>
          <div class="seg sm" id="dv-anim"><button class="on" data-v="mine">My orders</button><button data-v="all">All activity (incl. bots)</button></div></div>
        <div class="dim" style="font-size:12.5px;margin:-4px 0 12px" id="dv-skipped"></div>
        <div class="title-row" style="gap:8px">
          <button class="btn sm primary" id="dv-play">${icon('pause', 15)} Pause</button>
          <button class="btn sm ghost" id="dv-step">${icon('step-forward', 15)} Step</button>
          <button class="btn sm ghost" id="dv-live">${icon('radio', 15)} Skip to live</button>
          <div style="flex:1"></div>
          <div class="seg sm" id="dv-speed">${[0.5, 1, 2, 4].map(v => `<button data-v="${v}">${v}x</button>`).join('')}</div>
        </div>
        <div class="card flat" style="margin-top:14px;min-height:86px;font-size:15px;line-height:1.5" id="dv-now">
          <span class="dim">Waiting for engine activity… place an order or run a scenario.</span></div>
        <div class="label muted" style="margin:16px 0 4px">Event log</div>
        <div class="evlog" id="dv-log"></div>
      </div>
    </div>
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,1.65fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head"><div><div class="title-row"><h3>Doubly Linked FIFO Queue</h3><span class="tag buy" id="dv-fifotag">No level selected</span></div>
        <div class="sub">Head trades first; new orders join the tail. Click an order to find its hash entry.</div></div></div>
      <div class="viz-frame" style="padding:16px 14px 6px"><div class="fifo" id="dv-fifo"><span class="dim" style="padding:20px 0">Click a node in the tree to show its queue.</span></div></div>
      <div class="grid g3" style="margin-top:14px;gap:12px" id="dv-levelinfo"></div>
      <div class="card flat" style="margin-top:14px" id="dv-path"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="title-row"><h3>Hash Table</h3><span class="tag sell">Separate chaining</span></div>
        <div class="sub" id="dv-hashsub">Order id → node pointer</div></div>
        <div class="title-row" style="gap:6px"><button class="btn sm ghost" id="dv-hprev">${icon('arrow-left', 14)}</button><button class="btn sm ghost" id="dv-hnext">${icon('arrow-right', 14)}</button></div></div>
      <div class="buckets" id="dv-buckets"></div>
      <div class="legend" style="margin-top:10px"><span><i style="background:var(--card-3);border-radius:2px"></i>empty</span><span><i style="background:#2a5767;border-radius:2px"></i>1</span><span><i style="background:#4a9bb8;border-radius:2px"></i>2</span><span><i style="background:var(--accent);border-radius:2px"></i>3+ keys</span></div>
      <div class="card flat" style="margin-top:14px;padding:12px 14px">
        <div class="stat-row" style="font-size:13px;margin-bottom:8px"><span class="label">Bucket <span id="dv-bidx">—</span></span><span class="dim" id="dv-bnote"></span></div>
        <div class="chain" id="dv-chain"><span class="dim">Click a bucket or an order.</span></div>
      </div>
    </div>
  </div>`,

  async mount(root) {
    S.speed = settings.get('vizSpeed') || 1;
    $$('#dv-speed button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.speed));
    $('#dv-trader').textContent = settings.get('trader');
    wireSeg(root, '#dv-side', v => { S.side = v; drawTree(); drawKpis(); });
    wireSeg(root, '#dv-speed', v => { S.speed = +v; });
    wireSeg(root, '#dv-oside', () => {});
    $$('#dv-anim button').forEach(b => b.classList.toggle('on', b.dataset.v === S.animate));
    wireSeg(root, '#dv-anim', v => { S.animate = v; S.skipped = 0; drawSkipped(); });
    $('#dv-depth').onchange = async e => { S.depth = +e.target.value; await snapshot(); };
    $('#dv-play').onclick = () => { S.playing = !S.playing; drawPlay(); if (S.playing) pump(); else if (typeof playTimer === 'number') { clearTimeout(playTimer); playTimer = null; } };
    $('#dv-step').onclick = () => { S.playing = false; drawPlay(); clearTimeout(playTimer); playTimer = null; stepOnce(); };
    $('#dv-live').onclick = async () => { S.queue = []; S.cur = null; clearHl(); await snapshot(); drawQueue(); };
    $('#dv-send').onclick = send;
    $('#dv-tree').addEventListener('click', e => {
      const n = e.target.closest('[data-node]'); if (!n) return;
      S.selLevel = { side: S.side, price: +n.dataset.price }; S.selOrder = null;
      loadLevel(); drawTree();
    });
    $('#dv-fifo').addEventListener('click', e => {
      const n = e.target.closest('[data-order]'); if (!n) return;
      S.selOrder = +n.dataset.order; S.selBucket = +n.dataset.bucket;
      S.hashPage = Math.floor(S.selBucket / 1024);
      drawFifo(); drawHash();
    });
    $('#dv-buckets').addEventListener('click', e => {
      const c = e.target.closest('[data-b]'); if (!c) return;
      S.selBucket = +c.dataset.b; S.selOrder = null; drawHash(); drawFifo();
    });
    $('#dv-hprev').onclick = () => { if (S.hashPage > 0) { S.hashPage--; drawHash(); } };
    $('#dv-hnext').onclick = () => { if (S.hash && (S.hashPage + 1) * 1024 < S.hash.capacity) { S.hashPage++; drawHash(); } };
    offs = [
      bus.on('command', c => {
        S.owners.set(c.cmd_seq, c.order?.owner ?? c.replaced?.owner ?? '');
        if (S.owners.size > 600) S.owners.delete(S.owners.keys().next().value);
      }),
      bus.on('trace', m => {
        if (S.animate === 'mine' && !isMine(S.owners.get(m.cmd_seq))) { S.skipped++; drawSkipped(); return; }
        S.queue.push(...m.events);
        // a very busy market: drop old commands and jump to the latest
        if (S.queue.length > 1500) S.queue = S.queue.filter(e => e.cmd_seq === m.cmd_seq);
        drawQueue(); if (S.playing) pump();
      }),
      bus.on('reset', () => { S.queue = []; S.selLevel = null; S.level = null; S.selOrder = null; S.log = []; drawLog(); }),
    ];
    stopResize = onResize($('#dv-tree'), drawTree);
    drawPlay();
    drawSkipped();
    const ev = await get('/api/events?limit=1');
    S.trace = ev;
    drawTraceTag();
  },

  unmount() { offs.forEach(f => f()); stopResize?.(); if (typeof playTimer === 'number') clearTimeout(playTimer); clearTimeout(S.snapTimer); S.snapTimer = null; playTimer = null; S.queue = []; S.cur = null; },

  async refresh(reason) {
    // While events are queued, keep the "before" snapshot; refresh once drained.
    if (S.queue.length || S.cur) { S.pendingSnapshot = true; return; }
    // bots change the book constantly: redraw at most every 1.5 s
    const wait = 1500 - (Date.now() - S.lastSnap);
    if (reason !== 'mount' && wait > 0) {
      if (!S.snapTimer) S.snapTimer = setTimeout(() => { S.snapTimer = null; if (!S.queue.length && !S.cur) snapshot(); }, wait);
      return;
    }
    await snapshot();
  },
};

function kpi(label, id, ic, bar, cls) {
  return `<div class="card"><div class="stat-row" style="align-items:flex-start"><span class="label" style="font-size:12.5px">${label}</span><span class="${cls}">${icon(ic, 20)}</span></div>
    <div class="value num" style="font-size:24px;margin:8px 0 12px" id="${id}">—</div><div class="bar ${cls === 'accent' ? '' : cls}"><i id="${bar}" style="width:0"></i></div></div>`;
}

function drawSkipped() {
  const el = $('#dv-skipped');
  if (el) el.textContent = S.animate === 'mine'
    ? `Animating only your orders · ${S.skipped} bot command${S.skipped === 1 ? '' : 's'} applied without animation`
    : 'Animating every command, including the bots — slow the bots down in Demo Lab → Live Market to follow along.';
}

async function snapshot() {
  S.lastSnap = Date.now();
  const md = S.depth;
  const [tb, ta] = await Promise.all([get(`/api/dsa/tree?side=buy&max_depth=${md}`), get(`/api/dsa/tree?side=sell&max_depth=${md}`)]);
  S.trees.buy = tb; S.trees.sell = ta;
  const h0 = await get('/api/dsa/hash?from=0&count=1');
  S.hash = await get(`/api/dsa/hash?from=0&count=${Math.min(4096, h0.capacity || 1024)}`);
  if (!S.selLevel) {
    const b = await get('/api/book?depth=1');
    const p = S.side === 'buy' ? (b.best_bid ?? b.best_ask) : (b.best_ask ?? b.best_bid);
    if (p != null) S.selLevel = { side: p === b.best_bid ? 'buy' : 'sell', price: p };
  }
  if (S.selLevel) await loadLevel(); else drawFifo();
  drawTree(); drawHash(); drawKpis();
  setTimeout(() => { S.newNodes.clear(); $$('.viz-node.new').forEach(n => n.classList.remove('new')); }, 1600);
}

function drawKpis() {
  const t = S.trees[S.side];
  if (!t) return;
  const bound = t.size ? Math.floor(1.44 * Math.log2(t.size + 2)) : 0;
  $('#dv-h').innerHTML = `${t.height} <span class="dim" style="font-size:14px">≤ ${bound} bound</span>`;
  $('#dv-hb').style.width = bound ? `${Math.min(100, t.height / bound * 100)}%` : '0';
  const both = (S.trees.buy?.size || 0) + (S.trees.sell?.size || 0);
  $('#dv-p').innerHTML = `${int(t.size)} <span class="dim" style="font-size:14px">${S.side === 'buy' ? 'bid' : 'ask'} · ${int(both)} total</span>`;
  $('#dv-pb').style.width = both ? `${t.size / both * 100}%` : '0';
  if (S.hash) {
    $('#dv-lf').innerHTML = `${S.hash.load_factor.toFixed(3)} <span class="dim" style="font-size:14px">${int(S.hash.size)}/${int(S.hash.capacity)}</span>`;
    $('#dv-lfb').style.width = `${S.hash.load_factor / 0.75 * 100}%`;
  }
  get('/api/events?limit=1').then(ev => {
    S.trace = ev; drawTraceTag();
    const kept = ev.next - ev.oldest;
    $('#dv-ev').innerHTML = `${int(kept)} <span class="dim" style="font-size:14px">next #${int(ev.next)}</span>`;
    $('#dv-evb').style.width = `${Math.min(100, kept / 262144 * 100)}%`;
  });
}

function drawTraceTag() {
  const t = S.trace, el = $('#dv-tracetag');
  if (!el || !t) return;
  if (t.enabled && t.detailed) { el.textContent = 'TRACE: DETAILED'; el.className = 'tag buy'; return; }
  el.innerHTML = `TRACE: ${t.enabled ? 'MARKET ONLY' : 'OFF'} · <a href="#" id="dv-enable">enable</a>`;
  el.className = 'tag sell';
  $('#dv-enable').onclick = async e => { e.preventDefault(); const r = await post('/api/trace', { enabled: true, detailed: true, stream: true }); S.trace = { ...t, ...r }; drawTraceTag(); toast('Detailed tracing enabled', 'ok'); };
}

// --------------------------------------------------------------- AVL tree
function drawTree() {
  const el = $('#dv-tree'), t = S.trees[S.side];
  if (!el || !t) return;
  $('#dv-treetag').textContent = S.side === 'buy' ? 'Bids · max cached' : 'Asks · min cached';
  const W = Math.max(el.clientWidth, 300);
  if (!t.nodes.length) { el.innerHTML = `<div class="empty" style="height:240px;display:grid;place-items:center">The ${S.side === 'buy' ? 'bid' : 'ask'} tree is empty — submit a ${S.side} order.</div>`; $('#dv-treenote').textContent = ''; return; }
  const byId = new Map(t.nodes.map(n => [n.id, n]));
  const order = [];
  const walk = id => { const n = byId.get(id); if (!n) return; walk(n.left); order.push(n); walk(n.right); };
  walk(t.root);
  const maxD = Math.max(...t.nodes.map(n => n.depth));
  const H = Math.max(240, 80 + maxD * 78);
  const xs = new Map(order.map((n, i) => [n.id, 30 + (i + 0.5) * ((W - 60) / order.length)]));
  const y = d => 42 + d * 78;
  const r = Math.max(15, Math.min(24, (W - 60) / order.length * 0.42));
  let edges = '', nodes = '';
  for (const n of t.nodes) {
    for (const c of [n.left, n.right]) {
      if (c == null) continue;
      if (byId.has(c)) edges += `<line x1="${xs.get(n.id)}" y1="${y(n.depth)}" x2="${xs.get(c)}" y2="${y(n.depth + 1)}" stroke="var(--line-2)" stroke-width="1.5"/>`;
      else edges += `<line x1="${xs.get(n.id)}" y1="${y(n.depth)}" x2="${xs.get(n.id) + (c === n.left ? -14 : 14)}" y2="${y(n.depth) + 34}" stroke="var(--line-2)" stroke-dasharray="3 3"/><text x="${xs.get(n.id) + (c === n.left ? -16 : 16)}" y="${y(n.depth) + 48}" text-anchor="middle" fill="var(--dim)" font-size="12">…</text>`;
    }
  }
  for (const n of t.nodes) {
    const x = xs.get(n.id), yy = y(n.depth);
    const sel = S.selLevel && S.selLevel.side === S.side && Math.abs(S.selLevel.price - n.price) < 1e-9;
    const cls = ['viz-node', n.id === t.best ? 'best' : '', sel ? 'hl' : '', S.newNodes.has(`${S.side}:${n.id}`) ? 'new' : ''].join(' ');
    nodes += `<g class="${cls}" data-node="${n.id}" data-price="${n.price}" data-nid="${n.id}">
      <title>node #${n.id} · ₹${px(n.price)} · ${n.orders} orders · ${n.qty} TCX · height ${n.height} · balance ${n.balance}</title>
      <circle cx="${x}" cy="${yy}" r="${r}" fill="var(--card-3)" stroke="${n.id === t.best ? 'var(--buy)' : 'var(--line-2)'}" stroke-width="2"/>
      <text x="${x}" y="${yy + 4}" text-anchor="middle" font-size="${r > 19 ? 12 : 10}" fill="var(--text)" font-weight="600">${px(n.price)}</text>
      ${n.height > 1 ? `<text x="${x}" y="${yy - r - 5}" text-anchor="middle" font-size="10.5" fill="${Math.abs(n.balance) > 1 ? 'var(--sell)' : 'var(--dim)'}">bf ${n.balance > 0 ? '+' : ''}${n.balance} · h${n.height}</text>` : ''}
      <text x="${x}" y="${yy + r + 13}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${n.orders}× · ${n.qty}</text></g>`;
  }
  el.innerHTML = `<svg width="${W}" height="${H}">${edges}${nodes}</svg>`;
  $('#dv-treenote').textContent = `${t.size} nodes · height ${t.height} · root #${t.root}${t.truncated ? ` · showing depth ≤ ${S.depth}` : ''} · ${int(t.rotations)} rotations so far`;
  if (S.cur) applyHl(S.cur);
}

// ------------------------------------------------------------- FIFO queue
async function loadLevel() {
  const L = S.selLevel;
  if (!L) return;
  const r = await get(`/api/book/level?side=${L.side}&price=${L.price.toFixed(2)}&limit=60`);
  S.level = r.ok ? r : null;
  drawFifo();
}

function drawFifo() {
  const el = $('#dv-fifo');
  if (!el) return;
  const L = S.level;
  if (!S.selLevel) { drawPath(); return; }
  if (!L) {
    el.innerHTML = `<span class="dim" style="padding:20px 0">Level ₹${px(S.selLevel.price)} is empty — its node was removed from the tree.</span>`;
    $('#dv-fifotag').textContent = `₹${px(S.selLevel.price)} · empty`;
    $('#dv-levelinfo').innerHTML = '';
    drawPath();
    return;
  }
  $('#dv-fifotag').textContent = `${L.side === 'buy' ? 'Bid' : 'Ask'} ₹${px(L.price)} · node #${L.node_id}`;
  const nodes = L.orders.map((o, i) => `${i ? '<span class="link">⇄</span>' : ''}
    <div class="node ${S.selOrder === o.id ? 'sel' : ''}" data-order="${o.id}" data-bucket="${o.hash_bucket}" data-oid="${o.id}">
      <div class="stat-row"><span class="id">#${o.id}</span><span class="tag ${i === 0 ? 'buy' : ''}" style="font-size:10.5px">${i === 0 ? 'HEAD' : i === L.orders.length - 1 ? 'TAIL' : `#${i + 1}`}</span></div>
      <small>${int(o.remaining)} / ${int(o.qty)} TCX</small><small>seq ${o.seq} · ${esc(o.trader || '—')}</small>
      <small class="mono" style="font-size:10.5px">prev ${o.prev || '∅'} · next ${o.next || '∅'}</small></div>`).join('');
  el.innerHTML = `<span class="end">NULL ←</span>${nodes}<span class="end">→ NULL</span>${L.count > L.orders.length ? `<span class="end">(+${L.count - L.orders.length} more)</span>` : ''}`;
  $('#dv-levelinfo').innerHTML = [['Orders in queue', L.count], ['Level total', `${int(L.total_qty)} TCX`], ['Head → Tail', `#${L.head} → #${L.tail}`]]
    .map(([k, v]) => `<div class="card flat" style="padding:12px"><div class="label muted" style="font-size:10.5px">${k}</div><div style="font-size:17px;font-weight:700;margin-top:4px" class="num">${v}</div></div>`).join('');
  drawPath();
}

// How a cancel finds and removes the selected order, step by step.
function drawPath() {
  const el = $('#dv-path');
  if (!el) return;
  const L = S.level, o = L?.orders.find(x => x.id === S.selOrder);
  if (!o) {
    el.innerHTML = `<div class="label muted" style="margin-bottom:6px">Cancel path</div><span class="dim" style="font-size:14px">Click an order above to see how the engine would find and remove it without scanning anything.</span>`;
    return;
  }
  const pos = L.orders.indexOf(o), last = L.count === 1;
  const chain = S.hash?.buckets[o.hash_bucket]?.chain || [];
  const steps = [
    ['HASH', 'sell', `hash(#${o.id}) → bucket <b>${o.hash_bucket}</b>; walk its chain, found after <b>${Math.max(1, chain.indexOf(o.id) + 1)}</b> probe(s)`, 'expected O(1)'],
    ['FIFO', 'buy', `entry holds a pointer to the node: position <b>${pos + 1}</b> of ${L.count} at ₹${px(L.price)}; join prev #${o.prev || '∅'} ↔ next #${o.next || '∅'}`, 'O(1)'],
    ['AVL', 'accent', last ? `queue becomes empty → remove node <b>#${L.node_id}</b> from the ${L.side === 'buy' ? 'bid' : 'ask'} tree and rebalance` : `level still has ${L.count - 1} order(s) → AVL node #${L.node_id} stays; only its total changes`, last ? 'O(log P)' : 'O(1)'],
  ];
  el.innerHTML = `<div class="stat-row" style="margin-bottom:10px"><span class="label">Cancel path for order #${o.id}</span>
      <button class="btn sm danger-ghost" id="dv-cancel">${icon('circle-x', 14)} Cancel #${o.id}</button></div>
    ${steps.map(([c, cls, t, cost], i) => `<div style="display:grid;grid-template-columns:26px 62px 1fr auto;gap:10px;align-items:baseline;padding:7px 0;${i ? 'border-top:1px solid var(--line)' : ''};font-size:14px">
      <b class="dim">${i + 1}</b><span class="tag ${cls}">${c}</span><span class="muted">${t}</span><span class="tag">${cost}</span></div>`).join('')}`;
  $('#dv-cancel').onclick = async () => {
    const r = await post(`/api/orders/${o.id}/cancel`);
    toast(r.ok ? `Order #${o.id} cancelled — watch the trace playback` : `<b>Cancel failed:</b> ${esc(r.message)}`, r.ok ? 'ok' : 'err');
    if (r.ok) { S.selOrder = null; S.playing = true; drawPlay(); }
  };
}

// ------------------------------------------------------------- hash table
function drawHash() {
  const h = S.hash, el = $('#dv-buckets');
  if (!h || !el) return;
  const start = S.hashPage * 1024, end = Math.min(h.capacity, start + 1024);
  $('#dv-hashsub').textContent = `Order id → node pointer · buckets ${start}–${end - 1} of ${h.capacity} · max chain ${h.max_chain}`;
  const cells = [];
  for (let i = start; i < end; i++) {
    const b = h.buckets[i], n = b ? b.chain.length : 0;
    cells.push(`<i data-b="${i}" class="${n >= 3 ? 'c3' : n ? 'c' + n : ''} ${S.selBucket === i ? 'sel' : ''}" title="bucket ${i}: ${n} key${n === 1 ? '' : 's'}"></i>`);
  }
  el.innerHTML = cells.join('');
  const b = S.selBucket != null ? h.buckets[S.selBucket] : null;
  $('#dv-bidx').textContent = S.selBucket ?? '—';
  if (!b) { $('#dv-chain').innerHTML = '<span class="dim">Click a bucket or an order.</span>'; $('#dv-bnote').textContent = ''; return; }
  drawPath();
  $('#dv-chain').innerHTML = `<span class="dim">head →</span>${b.chain.map(k => `<span class="k ${S.selOrder === k ? 'sel' : ''}">#${k}</span><span class="dim">→</span>`).join('')}<span class="dim">NULL</span>`;
  $('#dv-bnote').textContent = S.selOrder != null ? `order #${S.selOrder}: ${b.chain.indexOf(S.selOrder) + 1} probe(s) to find` : `${b.chain.length} key(s)`;
}

// --------------------------------------------------------------- playback
function drawPlay() {
  $('#dv-play').innerHTML = S.playing ? `${icon('pause', 15)} Pause` : `${icon('play', 15)} Play`;
}

function drawQueue() { const el = $('#dv-queued'); if (el) el.textContent = `${S.queue.length} queued`; }

function delayFor(ev) {
  const base = ev.type === 'AVL_VISIT' || ev.type === 'LEVEL_QTY' ? 260 : ev.type.startsWith('ORDER') ? 420 : 650;
  return base / S.speed;
}

function pump() {
  if (playTimer || !S.playing) return;
  const loop = async () => {
    playTimer = 'busy';
    if (S.cur && (!S.queue.length || S.queue[0].cmd_seq !== S.cur.cmd_seq)) await finishBatch();
    if (!S.playing || !S.queue.length) { playTimer = null; return; }
    const ev = playOne();
    playTimer = setTimeout(loop, delayFor(ev));
  };
  loop();
}

async function stepOnce() {
  if (playTimer) return;
  if (S.cur && (!S.queue.length || S.queue[0].cmd_seq !== S.cur.cmd_seq)) await finishBatch();
  if (S.queue.length) playOne();
}

function playOne() {
  const ev = S.queue.shift();
  drawQueue();
  S.cur = ev;
  // auto-follow: show the tree side the event is about
  if ((ev.type.startsWith('AVL') || ev.type === 'BEST_CHANGED') && ev.side && ev.side !== S.side) {
    S.side = ev.side;
    $$('#dv-side button').forEach(b => b.classList.toggle('on', b.dataset.v === S.side));
    drawTree(); drawKpis();
  }
  if (ev.type === 'AVL_INSERT') S.newNodes.add(`${ev.side}:${ev.node_id}`);
  if ((ev.type === 'FIFO_ENQUEUE' || ev.type === 'FIFO_DEQUEUE' || ev.type === 'FIFO_UNLINK') &&
      (!S.selLevel || S.selLevel.side !== ev.side || Math.abs(S.selLevel.price - ev.price) > 1e-9)) {
    S.selLevel = { side: ev.side, price: ev.price };
    loadLevel();
  }
  if (ev.type === 'HASH_INSERT' || ev.type === 'HASH_ERASE') { S.selBucket = ev.bucket; S.hashPage = Math.floor(ev.bucket / 1024); drawHash(); }
  clearHl(); applyHl(ev);
  const [cat, cls] = CAT(ev.type);
  $('#dv-now').innerHTML = `<div class="title-row" style="margin-bottom:6px"><span class="tag ${cls}">${cat}</span><b style="font-size:13px;letter-spacing:.04em">${ev.type}</b><span class="dim" style="font-size:12.5px">event #${ev.seq} · cmd #${ev.cmd_seq}</span></div>${(EXPLAIN[ev.type] || (() => ev.type))(ev)}`;
  S.log.unshift(ev); if (S.log.length > 200) S.log.pop();
  drawLog();
  return ev;
}

async function finishBatch() {
  S.cur = null;
  await snapshot();
  S.pendingSnapshot = false;
}

function clearHl() {
  $$('.viz-node.visit,.viz-node.rot').forEach(n => n.classList.remove('visit', 'rot'));
  $$('.fifo .node.flash,.fifo .node.gone').forEach(n => n.classList.remove('flash', 'gone'));
  $$('.buckets i.flash').forEach(n => n.classList.remove('flash'));
}

function applyHl(ev) {
  const node = id => document.querySelector(`#dv-tree [data-nid="${id}"]`);
  if (ev.type === 'AVL_VISIT' || ev.type === 'AVL_REMOVE' || ev.type === 'BEST_CHANGED') node(ev.node_id)?.classList.add('visit');
  if (ev.type === 'AVL_ROTATE_LEFT' || ev.type === 'AVL_ROTATE_RIGHT') { node(ev.node_id)?.classList.add('rot'); node(ev.new_root_id)?.classList.add('rot'); }
  if (ev.type === 'FIFO_ENQUEUE') document.querySelector(`#dv-fifo [data-oid="${ev.order_id}"]`)?.classList.add('flash');
  if (ev.type === 'FIFO_DEQUEUE' || ev.type === 'FIFO_UNLINK') document.querySelector(`#dv-fifo [data-oid="${ev.order_id}"]`)?.classList.add('gone');
  if (ev.type === 'FILL') document.querySelector(`#dv-fifo [data-oid="${ev.maker_id}"]`)?.classList.add('flash');
  if (ev.type === 'HASH_INSERT' || ev.type === 'HASH_ERASE') document.querySelector(`#dv-buckets [data-b="${ev.bucket}"]`)?.classList.add('flash');
}

function drawLog() {
  const el = $('#dv-log');
  if (!el) return;
  el.innerHTML = S.log.slice(0, 80).map((e, i) => {
    const [cat, cls] = CAT(e.type);
    return `<div class="ev ${i === 0 && S.cur === e ? 'cur' : ''}"><span class="dim num">#${e.seq}</span><span class="t ${cls}">${e.type}</span>
      <span style="color:var(--muted)">${(EXPLAIN[e.type] || (() => cat))(e).replace(/<[^>]+>/g, '')}</span></div>`;
  }).join('') || '<div class="empty">No events played yet.</div>';
}

async function send() {
  const side = $('#dv-oside .on').dataset.v, price = $('#dv-price').value.trim(), qty = $('#dv-qty').value.trim();
  if (!price || !qty) return toast('Enter a price and quantity', 'err');
  if (!S.trace?.detailed || !S.trace?.enabled) await post('/api/trace', { enabled: true, detailed: true, stream: true });
  const r = await post('/api/orders', { side, price, qty, trader: settings.get('trader') });
  if (!r.ok) toast(`<b>Rejected:</b> ${esc(r.message)}`, 'err');
  else { S.playing = true; drawPlay(); }
}
