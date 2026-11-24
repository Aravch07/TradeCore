// Live Order Book: best prices, depth profile, both ladders, FIFO inspector.
import { get } from '../api.js';
import { settings } from '../store.js';
import { $, esc, inr, px, int, clock, ns, onResize, aggregate } from '../ui.js';
import { icon } from '../icons.js';
import { depthBars } from '../charts.js';
import { pageHead, wireSeg } from './common.js';

let agg = 0.05, depth = 10, book = null, selected = null, stopResize;

export default {
  html: () => `
  ${pageHead('TCX / INR Live Order Book', '',
    `<div class="seg" id="ob-agg"><button class="on" data-v="0.05">Agg: 0.05</button><button data-v="0.1">Agg: 0.10</button><button data-v="1">Agg: 1.00</button></div>
     <select class="select" id="ob-depth" title="Depth filter">
       <option value="5">Depth: 5 levels</option><option value="10" selected>Depth: 10 levels</option><option value="20">Depth: 20 levels</option></select>`,
    `EXCHANGE CORE // FIFO ENGINE <span class="tag buy" id="ob-lat">LATENCY: —</span>`)}

  <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,0.95fr)">
    <div class="card">
      <div class="stat-row"><span class="label">Best bid (have)</span><span class="tag buy" id="ob-bidn">—</span></div>
      <div class="stat-row" style="margin:10px 0 14px"><span class="value buy num" style="font-size:30px;font-weight:700" id="ob-bid">—</span><span class="num" id="ob-bidq">—</span></div>
      <div class="bar buy thick"><i id="ob-bidbar" style="width:0"></i></div>
    </div>
    <div class="card">
      <div class="stat-row"><span class="label">Best ask (want)</span><span class="tag sell" id="ob-askn">—</span></div>
      <div class="stat-row" style="margin:10px 0 14px"><span class="value sell num" style="font-size:30px;font-weight:700" id="ob-ask">—</span><span class="num" id="ob-askq">—</span></div>
      <div class="bar sell thick"><i id="ob-askbar" style="width:0"></i></div>
    </div>
    <div class="card" style="grid-row:span 2;display:flex;flex-direction:column">
      <h3 style="margin:6px 0 18px">FIFO Queue Inspector</h3>
      <div class="inspector">
        <div class="kv"><span>Selected Price Level</span><b class="buy num" id="fi-price">—</b></div>
        <div class="kv"><span>Queue Orders Count</span><b id="fi-count">—</b></div>
        <div class="kv"><span>Total Level Volume</span><b class="num" id="fi-vol">—</b></div>
        <div class="kv"><span>AVL Node / Head → Tail</span><b class="accent mono" id="fi-node">—</b></div>
      </div>
      <div style="flex:1;margin-top:20px;border:1px dashed var(--line-2);border-radius:6px;display:grid;place-items:center;text-align:center;padding:20px;color:var(--muted);font-size:14px" id="fi-hint">
        <div><div class="accent" style="margin-bottom:12px">${icon('pointer', 32)}</div>
        Click any price level in the order book to inspect individual orders in strict time priority sequence.</div>
      </div>
    </div>
    <div class="card span2">
      <div class="card-head"><div class="title-row"><span class="accent">${icon('activity', 20)}</span><h3>Market Depth &amp; Liquidity Profile</h3></div>
        <span style="font-size:13.5px">Spread: <b class="accent" id="ob-spread">—</b></span></div>
      <div class="chart-frame" style="padding:8px"><div class="chart" id="ob-depthchart"></div></div>
      <div class="stat-row" style="font-size:13.5px;margin-top:10px"><span id="ob-cumbid">Cumulative Bid Depth: —</span><span id="ob-cumask">Cumulative Ask Depth: —</span></div>
    </div>
  </div>

  <div class="grid g2 mt">
    ${ladder('bid', 'Bids (Buy Side - Highest First)', 'buy')}
    ${ladder('ask', 'Asks (Sell Side - Lowest First)', 'sell')}
  </div>

  <div class="card mt" id="fifo-card">
    <div class="card-head"><h3 id="fifo-title">Expanded FIFO Sequence Viewer</h3><span class="tag buy" id="fifo-count">Select a level</span></div>
    <table class="table boxed zebra">
      <thead><tr><th>FIFO Seq #</th><th>Order ID</th><th>Trader</th><th class="r">Remaining Quantity</th><th class="r">Original Size</th><th>Timestamp</th><th class="r">Execution Priority</th></tr></thead>
      <tbody id="fifo-rows"><tr><td colspan="7" class="empty">Click "N orders" on any level above to expand its doubly linked FIFO queue.</td></tr></tbody>
    </table>
  </div>`,

  mount(root) {
    agg = settings.get('aggregation') || 0.05;
    root.querySelectorAll('#ob-agg button').forEach(b => b.classList.toggle('on', +b.dataset.v === agg));
    wireSeg(root, '#ob-agg', v => { agg = +v; draw(); });
    $('#ob-depth').onchange = e => { depth = +e.target.value; draw(); };
    root.addEventListener('click', e => {
      const r = e.target.closest('[data-level]');
      if (!r) return;
      e.preventDefault();
      const [sd, p] = r.dataset.level.split(':');
      selected = { side: sd, price: +p };
      inspect();
    });
    stopResize = onResize($('#ob-depthchart'), () => book && depthBars($('#ob-depthchart'), book.bids, book.asks, { height: 180 }));
  },

  unmount() { stopResize?.(); },

  async refresh() {
    const [b, st] = await Promise.all([get('/api/book?depth=200'), get('/api/stats')]);
    book = b;
    if (st.ok) $('#ob-lat').textContent = `LATENCY: ${ns(st.latency_ns.p50)} p50`;
    draw();
    if (selected) inspect();
  },
};

function ladder(k, title, cls) {
  return `<div class="card" style="padding:0;overflow:hidden">
    <div class="card-head" style="padding:20px 24px 0"><div class="title-row"><span class="dot" style="background:var(--${cls})"></span><h3 style="font-size:18px">${title}</h3></div>
      <span class="tag ${cls} up" style="font-weight:500">FIFO Active</span></div>
    <table class="table boxed" style="margin-top:6px">
      <thead><tr><th>Price (₹)</th><th class="r">Size (TCX)</th><th class="r">Total (₹)</th><th class="r">Orders</th></tr></thead>
      <tbody id="ob-${k}s"></tbody></table></div>`;
}

function draw() {
  if (!book?.ok) return;
  const bids = aggregate(book.bids, agg, 'bid'), asks = aggregate(book.asks, agg, 'ask');
  const sum = a => a.reduce((x, l) => x + l.qty, 0);
  const bd = sum(book.bids), ad = sum(book.asks);
  $('#ob-bid').textContent = inr(book.best_bid);
  $('#ob-ask').textContent = inr(book.best_ask);
  $('#ob-bidq').textContent = book.bids[0] ? `${int(book.bids[0].qty)} TCX` : '—';
  $('#ob-askq').textContent = book.asks[0] ? `${int(book.asks[0].qty)} TCX` : '—';
  $('#ob-bidn').textContent = book.bids[0] ? `${book.bids[0].orders} order${book.bids[0].orders === 1 ? '' : 's'}` : 'empty';
  $('#ob-askn').textContent = book.asks[0] ? `${book.asks[0].orders} order${book.asks[0].orders === 1 ? '' : 's'}` : 'empty';
  $('#ob-bidbar').style.width = bd + ad ? `${bd / (bd + ad) * 100}%` : '0';
  $('#ob-askbar').style.width = bd + ad ? `${ad / (bd + ad) * 100}%` : '0';
  $('#ob-spread').textContent = book.spread != null ? `₹${px(book.spread)} (${(book.spread / book.best_ask * 100).toFixed(3)}%)` : '—';
  $('#ob-cumbid').textContent = `Cumulative Bid Depth: ${int(bd)} TCX`;
  $('#ob-cumask').textContent = `Cumulative Ask Depth: ${int(ad)} TCX`;
  depthBars($('#ob-depthchart'), book.bids, book.asks, { height: 180 });
  const row = (l, i, side) => {
    const best = i === 0;
    const target = l.members ? l.members[0] : l.price;
    const sel = selected && selected.side === side && Math.abs(selected.price - target) < 1e-9;
    return `<tr class="clickable" data-level="${side}:${target}" style="${best ? `box-shadow:inset 3px 0 0 var(--${side === 'bid' ? 'buy' : 'sell'})` : ''}${sel ? ';background:var(--card-2)' : ''}">
      <td class="${side === 'bid' ? 'buy' : 'sell'} num" style="font-weight:700">₹${px(l.price)} ${best ? `<span class="tag ${side === 'bid' ? 'buy' : 'sell'} up" style="margin-left:8px;font-size:10px">Best ${side}</span>` : ''}</td>
      <td class="r num">${int(l.qty)}</td><td class="r num">₹${px(l.price * l.qty)}</td>
      <td class="r"><a href="#">${l.orders} order${l.orders === 1 ? '' : 's'}</a></td></tr>`;
  };
  $('#ob-bids').innerHTML = bids.slice(0, depth).map((l, i) => row(l, i, 'bid')).join('') || '<tr><td colspan="4" class="empty">No bids</td></tr>';
  $('#ob-asks').innerHTML = asks.slice(0, depth).map((l, i) => row(l, i, 'ask')).join('') || '<tr><td colspan="4" class="empty">No asks</td></tr>';
}

async function inspect() {
  const r = await get(`/api/book/level?side=${selected.side === 'bid' ? 'buy' : 'sell'}&price=${selected.price.toFixed(2)}`);
  if (!r.ok) {
    $('#fifo-rows').innerHTML = `<tr><td colspan="7" class="empty">Level ₹${px(selected.price)} is now empty (it was removed from the AVL tree).</td></tr>`;
    $('#fifo-count').textContent = '0 Orders Queued';
    ['#fi-price', '#fi-count', '#fi-vol', '#fi-node'].forEach(s => { $(s).textContent = '—'; });
    return;
  }
  $('#fi-hint').innerHTML = `<div style="text-align:left;width:100%;font-size:13.5px;line-height:1.6">
    <div class="label" style="margin-bottom:8px">Why this order?</div>
    Orders at <b>₹${px(r.price)}</b> live in one doubly linked list hanging off AVL node <b class="accent">#${r.node_id}</b>.
    The head (order <b>#${r.head}</b>) trades first; new orders join the tail (<b>#${r.tail}</b>). Cancelling any order
    is O(1): the hash table points straight at its node, and its neighbours are re-linked.</div>`;
  $('#fi-price').textContent = inr(r.price);
  $('#fi-price').className = (r.side === 'buy' ? 'buy' : 'sell') + ' num';
  $('#fi-count').textContent = `${r.count} active`;
  $('#fi-vol').textContent = `${int(r.total_qty)} TCX`;
  $('#fi-node').textContent = `#${r.node_id} · ${r.head} → ${r.tail}`;
  $('#fifo-title').textContent = `Expanded FIFO Sequence Viewer: Price Level ₹${px(r.price)}`;
  $('#fifo-count').textContent = `${r.count} Orders Queued`;
  const ord = n => n === 1 ? 'Next in line' : `Queued (${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n % 100) ? 0 : n % 10]})`;
  $('#fifo-rows').innerHTML = r.orders.map((o, i) => `<tr>
    <td class="accent num">#${String(i + 1).padStart(2, '0')}</td>
    <td class="mono">ORD-${o.id} <span class="dim">seq ${o.seq}</span></td><td>${esc(o.trader)}</td>
    <td class="r num ${i === 0 ? 'buy' : ''}">${int(o.remaining)} TCX</td><td class="r num">${int(o.qty)} TCX</td>
    <td class="num">${clock(o.time_ms, true)}</td>
    <td class="r"><span class="tag ${i === 0 ? 'buy' : ''}">${ord(i + 1)}</span></td></tr>`).join('');
}
