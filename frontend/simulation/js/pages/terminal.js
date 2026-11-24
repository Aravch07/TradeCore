// Trading Terminal: chart, live book, executions, order entry, my orders.
import { get, post, roundTrips, isMine } from '../api.js';
import { settings, shared, bus } from '../store.js';
import { $, $$, esc, inr, px, int, clock, toast, modal, onResize, aggregate, statusTag } from '../ui.js';
import { icon } from '../icons.js';
import { candleChart, depthCurve, areaChart } from '../charts.js';
import { wireSeg } from './common.js';

let side = 'buy', view = 'depth', agg = 0.05, stopResize, offCmd;
let book = null, candles = [], myOrders = [];

export default {
  html: () => `
  <div class="grid g4">
    ${tile('Session high', 'tm-high', 'trending-up', 'sell')}
    ${tile('Session low', 'tm-low', 'trending-down', 'sell')}
    ${tile('Session volume', 'tm-vol', 'chart-no-axes-column', 'accent')}
    ${tile('Last fill', 'tm-last', 'clock', '')}
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,1.55fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head">
        <div class="title-row"><h3>TCX/INR Depth &amp; Price Action</h3><span class="tag accent" id="tm-viewtag">Cumulative Depth</span></div>
        <div class="seg sm" id="tm-view"><button class="on" data-v="depth">Depth</button><button data-v="candles">Candles</button><button data-v="spread">Spread</button></div>
      </div>
      <div class="chart-frame dots" style="height:270px">
        <div class="chart" id="tm-chart"></div>
        <div class="chart-overlay" id="tm-stream">Live Stream: —</div>
      </div>
    </div>
    <div class="card" style="grid-row:span 2">
      <div class="card-head" style="margin-bottom:22px"><h3>Live Order Book</h3>
        <div class="seg sm" id="tm-agg"><button class="on" data-v="0.05">0.05</button><button data-v="0.1">0.10</button><button data-v="1">1.00</button></div>
      </div>
      <div class="ob-row" style="cursor:default;font-size:11.5px;letter-spacing:.06em;padding:0 0 8px"><span>PRICE (₹)</span><span class="right">SIZE</span><span class="right">TOTAL</span></div>
      <div id="tm-asks"></div>
      <div class="ob-mid"><span id="tm-spread">Spread: —</span><b id="tm-midpx">—</b></div>
      <div id="tm-bids"></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:18px">Recent Executions</h3>
      <table class="table tight"><thead><tr><th>Time</th><th class="r">Price (₹)</th><th class="r">Qty</th><th class="r">Total (₹)</th></tr></thead>
      <tbody id="tm-execs"></tbody></table>
    </div>
  </div>

  <div class="grid g2 mt">
    <div class="card" style="padding:24px">
      <div class="card-head"><h3>Order Placement</h3><span style="font-size:13px">Trading as <b class="accent" id="tm-trader"></b></span></div>
      <div class="portfolio" id="tm-pf" title="Paper portfolio: starts with ₹1,00,000. It is tracked by the dashboard from your fills, not enforced by the engine."></div>
      <div class="side-toggle" id="tm-side">
        <button class="buy-btn on" data-v="buy">BUY</button><button class="sell-btn" data-v="sell">SELL</button>
      </div>
      <div class="type-row" style="margin:18px 0">TYPE:
        <button class="on">Limit</button>
        <button disabled title="Market orders are outside the proposal's scope">Market</button>
        <button disabled title="Stop-limit orders are outside the proposal's scope">Stop-Limit</button>
      </div>
      <div class="grid g2" style="gap:16px">
        <label class="field"><span>Price (INR)</span><div class="input"><input id="tm-price" inputmode="decimal" autocomplete="off"><span class="unit">₹</span></div></label>
        <label class="field"><span>Quantity (TCX)</span><div class="input"><input id="tm-qty" inputmode="numeric" autocomplete="off"><span class="unit">TCX</span></div></label>
      </div>
      <div class="stat-row" style="margin:16px 0 6px;font-size:13.5px">
        <span class="muted">Fill price from book:
          <a href="#" id="tm-usebid">Bid <span class="num" id="tm-bidhint">—</span></a> ·
          <a href="#" id="tm-useask">Ask <span class="num" id="tm-askhint">—</span></a></span>
        <span>Order value <b class="num" id="tm-total">₹0.00</b></span>
      </div>
      <div class="dim" style="font-size:12.5px;margin-bottom:14px">Tick size ₹0.05 · good-till-cancelled limit order · price-time priority</div>
      <button class="btn lg block primary" id="tm-submit">Place Buy Order</button>
    </div>
    <div class="card" style="padding:24px">
      <div class="card-head"><h3>Active User Orders</h3><span class="tag" id="tm-activecount">0 Active</span></div>
      <table class="table tight">
        <thead><tr><th>ID / Type</th><th>Pair</th><th class="r">Price</th><th class="r">Qty</th><th style="padding-left:14px">Status</th><th class="r">Action</th></tr></thead>
        <tbody id="tm-orders"></tbody>
      </table>
    </div>
  </div>`,

  mount(root) {
    $('#tm-trader').textContent = settings.get('trader');
    agg = settings.get('aggregation') || 0.05;
    $$('#tm-agg button').forEach(b => b.classList.toggle('on', +b.dataset.v === agg));
    $('#tm-qty').value = settings.get('defaultQty');
    wireSeg(root, '#tm-view', v => {
      view = v;
      $('#tm-viewtag').textContent = { depth: 'Cumulative Depth', candles: '1M Candles', spread: 'Spread History' }[v];
      drawChart();
    });
    wireSeg(root, '#tm-agg', v => { agg = +v; drawBook(); });
    $$('#tm-side button').forEach(b => b.onclick = () => {
      side = b.dataset.v;
      $$('#tm-side button').forEach(x => x.classList.toggle('on', x === b));
      $('#tm-submit').textContent = side === 'buy' ? 'Place Buy Order' : 'Place Sell Order';
    });
    ['#tm-price', '#tm-qty'].forEach(s => $(s).addEventListener('input', updateTotal));
    $('#tm-usebid').onclick = e => { e.preventDefault(); if (book?.best_bid) { $('#tm-price').value = px(book.best_bid).replace(/,/g, ''); updateTotal(); } };
    $('#tm-useask').onclick = e => { e.preventDefault(); if (book?.best_ask) { $('#tm-price').value = px(book.best_ask).replace(/,/g, ''); updateTotal(); } };
    $('#tm-submit').onclick = submit;
    $('#tm-orders').addEventListener('click', onOrderAction);
    ['#tm-asks', '#tm-bids'].forEach(s => $(s).addEventListener('click', e => {
      const r = e.target.closest('[data-price]');
      if (r) { $('#tm-price').value = r.dataset.price; updateTotal(); }
    }));
    stopResize = onResize($('#tm-chart'), drawChart);
    offCmd = bus.on('connection', updateStreamBadge);
  },

  unmount() { stopResize?.(); offCmd?.(); },

  async refresh() {
    const [s, b, t, o, mt] = await Promise.all([
      get('/api/summary'), get('/api/book?depth=60'), get('/api/trades?limit=6'),
      get(`/api/orders?owner=${encodeURIComponent(settings.get('trader'))}&limit=40`),
      get(`/api/trades?owner=${encodeURIComponent(settings.get('trader'))}&limit=5000`),
    ]);
    book = b;
    if (s.ok) {
      $('#tm-high').textContent = inr(s.high);
      $('#tm-low').textContent = inr(s.low);
      $('#tm-vol').textContent = `${int(s.volume)} TCX`;
    }
    const lt = t.trades?.[0];
    $('#tm-last').textContent = lt ? `${inr(lt.price)} / ${lt.qty}` : '—';
    $('#tm-execs').innerHTML = (t.trades || []).map(x => `<tr><td class="num">${clock(x.time_ms)}</td>
      <td class="r sell num">${px(x.price)}</td><td class="r num">${x.qty}</td><td class="r num">${px(x.price * x.qty)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No executions yet</td></tr>';
    if (!$('#tm-price').value && (b.best_ask || b.best_bid)) $('#tm-price').value = px(b.best_ask || b.best_bid).replace(/,/g, '');
    $('#tm-bidhint').textContent = b.best_bid ? px(b.best_bid) : '—';
    $('#tm-askhint').textContent = b.best_ask ? px(b.best_ask) : '—';
    myOrders = o.orders || [];
    drawPortfolio(mt.trades || [], s.last);
    drawOrders();
    drawBook();
    updateTotal();
    updateStreamBadge();
    if (view === 'candles') candles = (await get('/api/candles?interval_ms=60000&limit=40')).candles || [];
    drawChart();
  },
};

function tile(label, id, ic, cls) {
  return `<div class="card stat"><div class="stat-row"><div><div class="label">${label}</div>
    <div class="value num" id="${id}" style="margin-top:2px">—</div></div><span class="${cls}">${icon(ic, 28)}</span></div></div>`;
}

function updateStreamBadge() {
  const rt = roundTrips.slice(-20).map(r => r.ms);
  const avg = rt.length ? Math.round(rt.reduce((a, b) => a + b, 0) / rt.length) : 0;
  const el = $('#tm-stream');
  if (el) el.textContent = shared.connected ? `Live Stream: Connected (Latency ${avg}ms)` : 'Live Stream: Disconnected (polling)';
}

function drawBook() {
  if (!book?.ok) return;
  const mine = new Set(myOrders.filter(o => o.status === 'open' || o.status === 'partial').map(o => `${o.side}:${o.price.toFixed(2)}`));
  const asks = aggregate(book.asks, agg, 'ask').slice(0, 5);
  const bids = aggregate(book.bids, agg, 'bid').slice(0, 5);
  const max = Math.max(1, ...asks.map(l => l.qty), ...bids.map(l => l.qty));
  const row = (l, cls) => {
    const isMine = (l.members || [l.price]).some(p => mine.has(`${cls === 'bid' ? 'buy' : 'sell'}:${p.toFixed(2)}`));
    return `<div class="ob-row ${cls}${isMine ? ' mine' : ''}" data-price="${l.price.toFixed(2)}" title="Click to use this price">
      <div class="fill" style="width:${(l.qty / max) * 72}%"></div>
      <span class="p num">${px(l.price)}${isMine ? '<span class="yours">YOURS</span>' : ''}</span>
      <span class="right num">${int(l.qty)}</span><span class="right num">${px(l.price * l.qty)}</span></div>`;
  };
  $('#tm-asks').innerHTML = asks.slice().reverse().map(l => row(l, 'ask')).join('') || '<div class="empty">No asks</div>';
  $('#tm-bids').innerHTML = bids.map(l => row(l, 'bid')).join('') || '<div class="empty">No bids</div>';
  $('#tm-spread').textContent = book.spread != null ? `Spread: ₹${px(book.spread)} (${(book.spread / book.best_ask * 100).toFixed(2)}%)` : 'Spread: —';
  $('#tm-midpx').textContent = book.mid != null ? px(book.mid) : '—';
}

function drawChart() {
  const el = $('#tm-chart');
  if (!el || !book) return;
  if (view === 'depth') depthCurve(el, book.bids, book.asks, { height: 270 });
  else if (view === 'candles') candleChart(el, candles, { height: 260 });
  else {
    const pts = shared.commandLog.filter(c => c.spread != null).slice(0, 120).reverse();
    areaChart(el, pts.map(c => c.spread), { height: 270, labels: pts.map(c => `spread ₹${px(c.spread)} · cmd #${c.cmd_seq}`), empty: 'Spread history fills in as commands arrive' });
  }
}

function updateTotal() {
  const p = parseFloat($('#tm-price').value), q = parseInt($('#tm-qty').value, 10);
  $('#tm-total').textContent = Number.isFinite(p) && Number.isFinite(q) ? inr(p * q) : '₹0.00';
}

async function submit() {
  const price = $('#tm-price').value.trim(), qty = $('#tm-qty').value.trim();
  if (!settings.get('oneClick')) {
    const ok = await modal({
      title: `Confirm ${side.toUpperCase()} order`,
      body: `${side === 'buy' ? 'Buy' : 'Sell'} <b>${esc(qty)}</b> TCX at limit <b>₹${esc(price)}</b> as <b>${esc(settings.get('trader'))}</b>.`,
      okText: `Place ${side === 'buy' ? 'Buy' : 'Sell'} Order`,
    });
    if (!ok) return;
  }
  const btn = $('#tm-submit');
  btn.disabled = true;
  try {
    const r = await post('/api/orders', { side, price, qty });
    if (!r.ok) return toast(`<b>Rejected:</b> ${esc(r.message)}`, 'err');
    const f = r.fills.reduce((a, x) => a + x.qty, 0);
    toast(f ? `<b>Order #${r.order.id}: ${f} TCX filled</b>${r.order.remaining ? `, ${r.order.remaining} resting in the book` : ' — fully executed'}` : `<b>Order #${r.order.id} placed</b> — resting at ₹${px(r.order.price)} until a bot trades with it`, 'ok');
  } catch (e) { toast(esc(e.message), 'err'); }
  finally { btn.disabled = false; }
}

function drawOrders() {
  const active = myOrders.filter(o => o.status === 'open' || o.status === 'partial');
  const rest = myOrders.filter(o => !(o.status === 'open' || o.status === 'partial')).slice(0, Math.max(0, 6 - active.length));
  $('#tm-activecount').textContent = `${active.length} Active`;
  const rows = [...active, ...rest];
  $('#tm-orders').innerHTML = rows.length ? rows.map(o => {
    const live = o.status === 'open' || o.status === 'partial';
    return `<tr style="${live ? '' : 'opacity:.55'}">
      <td><b class="mono" style="font-size:15px">#${o.id}</b><div class="sell" style="font-size:12.5px">Limit ${o.side === 'buy' ? 'Buy' : 'Sell'}</div></td>
      <td class="accent">TCX/INR</td><td class="r num">₹${px(o.price)}</td>
      <td class="r num">${live ? o.remaining : o.filled} / ${o.qty}</td>
      <td style="padding-left:14px">${statusTag(o.status)}</td>
      <td class="r">${live ? `<button class="btn sm ghost" data-act="replace" data-id="${o.id}">Replace</button>
        <button class="btn sm danger-ghost" data-act="cancel" data-id="${o.id}">Cancel</button>` : '<span class="dim">–</span>'}</td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">No orders from <b>${esc(settings.get('trader'))}</b> yet</td></tr>`;
}

async function onOrderAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id, o = myOrders.find(x => String(x.id) === id);
  if (b.dataset.act === 'cancel') {
    const r = await post(`/api/orders/${id}/cancel`);
    toast(r.ok ? `Order #${id} cancelled` : `<b>Cancel failed:</b> ${esc(r.message)}`, r.ok ? 'ok' : 'err');
    return;
  }
  const res = await modal({
    title: `Replace order #${id}`,
    body: `Cancel-and-replace gives the order a <b>new id and loses time priority</b>.
      <div class="grid g2" style="gap:12px;margin-top:14px">
        <label class="field"><span>New price</span><div class="input"><input id="rp-price" value="${o.price.toFixed(2)}"></div></label>
        <label class="field"><span>New qty</span><div class="input"><input id="rp-qty" value="${o.remaining}"></div></label></div>`,
    okText: 'Replace',
  });
  if (!res) return;
  const r = await post(`/api/orders/${id}/replace`, { price: $('#rp-price', res).value, qty: $('#rp-qty', res).value });
  toast(r.ok ? `Order #${id} replaced by #${r.order.id}` : `<b>Replace rejected:</b> ${esc(r.message)} (original kept)`, r.ok ? 'ok' : 'err');
}

/* Paper portfolio from your own fills (average-cost method). */
const START_CASH = 100000;
function drawPortfolio(trades, last) {
  let pos = 0, cash = START_CASH, cost = 0;
  for (const t of trades.slice().reverse()) {            // oldest first
    const me = isMine(t.taker_owner) ? 'taker' : 'maker';
    const side = me === 'taker' ? t.taker_side : (t.taker_side === 'buy' ? 'sell' : 'buy');
    // a self-trade (you on both sides) nets to zero
    if (isMine(t.taker_owner) && isMine(t.maker_owner)) continue;
    const q = side === 'buy' ? t.qty : -t.qty;
    cash -= q * t.price;
    if (pos === 0 || Math.sign(pos) === Math.sign(q)) cost += q * t.price;          // adding to position
    else if (Math.abs(q) <= Math.abs(pos)) cost -= (cost / pos) * -q;              // reducing
    else cost = (pos + q) * t.price;                                               // flipped side
    pos += q;
  }
  const avg = pos ? cost / pos : null;
  const mark = last ?? avg ?? 0;
  const equity = cash + pos * mark, pnl = equity - START_CASH;
  $('#tm-pf').innerHTML = `
    <div><span class="label">Position</span><b class="num ${pos > 0 ? 'buy' : pos < 0 ? 'sell' : ''}">${pos > 0 ? '+' : ''}${int(pos)} TCX</b></div>
    <div><span class="label">Avg cost</span><b class="num">${avg != null ? inr(Math.abs(avg)) : '—'}</b></div>
    <div><span class="label">Cash</span><b class="num">${inr(cash)}</b></div>
    <div><span class="label">Paper P&amp;L</span><b class="num ${pnl >= 0 ? 'buy' : 'sell'}">${pnl >= 0 ? '+' : '−'}${inr(Math.abs(pnl))}</b></div>`;
}
