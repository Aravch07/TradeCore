// A small, dependency-free client for the shared C-powered exchange.
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(Number(value) || 0);
const number = value => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value || 0);
const percent = value => `${value >= 0 ? '+' : ''}${(value || 0).toFixed(2)}%`;
const time = value => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const active = order => ['open', 'partial'].includes(order.status);
const DEMOS = ['Arav', 'Priya', 'Rohan', 'Ananya'].map(name => ({ name, email: `${name.toLowerCase()}@tradecore.test`, initials: name.slice(0, 2).toUpperCase() }));
const state = { view: 'market', symbol: 'TCX', data: null, side: 'buy', execution: 'instant', qty: 5, price: '', range: 'session',
  busy: false, authMode: 'signin', authBusy: false, receipt: null, treeSide: 'buy', queue: 0, selectedOrder: null, event: null };
let controller;
let requestGeneration = 0;
let requestPending = false;
let toastTimer;
let lastOrder;

async function json(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({ message: 'The server returned an unreadable response. Please retry.' }));
  if (!response.ok) { const error = new Error(body.message || body.error || 'This request could not be completed.'); error.status = response.status; throw error; }
  return body;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function stockIcon(stock) {
  return `<span class="stock-icon" style="--stock-color:${stock.color}">${esc(stock.initials)}</span>`;
}
function spark(values, negative = false) {
  if (!values?.length) return '';
  const low = Math.min(...values), delta = Math.max(...values) - low || 1;
  const points = values.map((value, i) => `${i / Math.max(1, values.length - 1) * 80},${23 - (value - low) / delta * 20}`).join(' ');
  return `<svg class="spark" viewBox="0 0 80 27" aria-hidden="true"><polyline points="${points}" fill="none" stroke="var(--${negative ? 'red' : 'green'})" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
function updateAccount() {
  const user = state.data?.user;
  $('#account-control').innerHTML = user
    ? `<button class="account-button" data-portfolio><span class="avatar">${esc(user.name.slice(0, 2).toUpperCase())}</span><span class="account-name">${esc(user.name)}</span></button><button class="signout" data-signout>Sign out</button>`
    : '<button class="button primary small" data-login>Sign in</button>';
}
function renderShell() {
  const title = state.view === 'market' ? 'Your trading desk' : state.view === 'portfolio' ? 'Your portfolio, at a glance' : 'See the engine think';
  const description = state.view === 'market' ? 'Four demo stocks. Real order matching. A market shared with everyone.' :
    state.view === 'portfolio' ? 'Track your cash, shares, open orders, and every trade you make.' : 'Place real demo orders and explore the data structures behind each match.';
  $('#page-title').textContent = title; $('#page-description').textContent = description;
  $$('[data-nav]').forEach(link => { const selected = link.dataset.nav === state.view; link.classList.toggle('active', selected); if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  if (state.view === 'market') {
    $('#workspace').innerHTML = `<div class="trade-layout"><div class="market-column"><div class="watchlist" id="watchlist"></div><section class="card market-card" id="market-card"></section><section class="card order-book-card" id="order-book"></section>
      <div class="demo-bar"><p><b>Make the market move.</b>Demo traders submit orders through the same C engine you use.</p><button class="button" data-demo="flow">Run 10 orders</button><button class="button" data-demo="liquidity">Add buy / sell offers</button></div>
      <div class="split-section"><section class="card" id="recent-trades"></section><section class="card" id="market-activity"></section></div></div>
      <aside class="ticket-column"><section class="card ticket" id="ticket"></section><section class="starter-card" id="starter-card"></section><p class="tip-card"><b>Try this:</b> sign in as Arav, buy 5 TCX, then open another browser as Priya. Both see the same updated market.</p></aside></div>`;
    renderTicket();
    if (!state.data) {
      $('#market-card').innerHTML = '<div class="loading-panel"><span class="loader"></span><h2>Loading the shared market…</h2><p>Stocks, open offers and executed trade history will appear here.</p></div>';
      $('#order-book').innerHTML = '<p class="activity-empty">Connecting to the seeded order book…</p>';
    }
  } else $('#workspace').innerHTML = `<div id="${state.view}-content"></div>`;
  if (state.data) renderData();
}
function renderWatchlist() {
  $('#watchlist').innerHTML = state.data.markets.map(stock => `<button class="stock-card ${state.symbol === stock.symbol ? 'selected' : ''}" data-symbol="${stock.symbol}" aria-pressed="${state.symbol === stock.symbol}">
    <div class="stock-top">${stockIcon(stock)}<div><div class="stock-code">${stock.symbol}</div><small>${esc(stock.name)}</small></div></div><div class="price num">${money(stock.price)}</div><div class="stock-bottom"><span class="change num ${stock.change < 0 ? 'negative' : 'positive'}">${percent(stock.change)}</span>${spark(stock.spark, stock.change < 0)}</div></button>`).join('');
}
function renderChart() {
  const target = $('#price-chart');
  if (!target || !state.data) return;
  let candles = state.data.candles;
  if (state.range === 'recent') candles = candles.slice(-12);
  if (!candles.length) { target.innerHTML = '<p class="activity-empty">The first fill will start this chart. Buy from an existing sell offer to create a trade.</p>'; return; }
  const W = Math.max(280, target.clientWidth - 32), H = 222, right = W - 50, top = 15, bottom = 188;
  const values = candles.map(candle => candle.close);
  const low = Math.min(...values), high = Math.max(...values), pad = Math.max(.05, (high - low) * .2), min = low - pad, max = high + pad;
  const start = candles[0].start_ms, duration = candles.at(-1).start_ms - start || 1;
  const point = (value, i) => [14 + (candles[i].start_ms - start) / duration * (right - 14), bottom - (value - min) / (max - min) * (bottom - top)];
  const points = values.map(point);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const grid = [0, .5, 1].map(f => { const y = top + f * (bottom - top); return `<line class="chart-grid" x1="12" x2="${right}" y1="${y}" y2="${y}"/><text class="chart-text" x="${right + 7}" y="${y + 4}">${(max - f * (max - min)).toFixed(2)}</text>`; }).join('');
  target.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${state.symbol} prices from executed trades, ${values.length} candles"><defs><linearGradient id="price-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--green)" stop-opacity=".14"/><stop offset="1" stop-color="var(--green)" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${line} L${points.at(-1)[0]},${bottom} L${points[0][0]},${bottom} Z" fill="url(#price-fill)"/><path class="chart-line" d="${line}"/><circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="3.5" fill="var(--green)"/>
    <text class="chart-text" x="12" y="215">${time(start)}</text><text class="chart-text" text-anchor="middle" x="${right / 2}" y="215">${time(start + duration / 2)}</text><text class="chart-text" text-anchor="end" x="${right}" y="215">${time(start + duration)}</text></svg>`;
}
function renderMarket() {
  renderWatchlist();
  const stock = state.data.markets.find(market => market.symbol === state.symbol);
  $('#market-card').innerHTML = `<div class="market-card-header">${stockIcon(stock)}<div class="market-name"><h2>${esc(stock.name)}</h2><p>${stock.symbol} · ${esc(stock.sector)} · INR</p></div><div class="market-price"><b class="num">${money(stock.price)}</b><span class="num ${stock.change < 0 ? 'negative' : 'positive'}">${percent(stock.change)} <span class="muted">from opening reference</span></span></div></div>
    <div class="chart-tools"><span class="chart-label">EXECUTED TRADE PRICES</span><div class="chart-range"><button data-range="session" class="${state.range === 'session' ? 'active' : ''}">Session</button><button data-range="recent" class="${state.range === 'recent' ? 'active' : ''}">Recent</button></div></div><div class="price-chart" id="price-chart"></div><div class="market-metrics"><div><span>Best buyer</span><b class="num">${stock.best_bid == null ? 'No bids' : money(stock.best_bid)}</b></div><div><span>Best seller</span><b class="num">${stock.best_ask == null ? 'No asks' : money(stock.best_ask)}</b></div><div><span>Volume traded</span><b class="num">${number(stock.volume)} shares</b></div><div><span>Trades executed</span><b class="num">${number(stock.total_trades)}</b></div></div>`;
  renderChart();
  const book = state.data.book, max = Math.max(1, ...book.bids.map(level => level.qty), ...book.asks.map(level => level.qty));
  const levels = side => book[side === 'buy' ? 'bids' : 'asks'].slice(0, 8).map(level => `<button class="book-row ${side === 'sell' ? 'ask' : ''}" style="--depth:${level.qty / max * 100}%" data-level-side="${side}" data-price="${level.price}" aria-label="${side === 'sell' ? 'Buy from seller' : 'Sell to buyer'} at ${money(level.price)}, ${level.qty} shares"><span class="level-price num">${money(level.price)}</span><span class="num">${number(level.qty)}</span><span class="muted">${level.orders}</span></button>`).join('') || '<p class="activity-empty">No orders. Add demo offers below.</p>';
  $('#order-book').innerHTML = `<div class="section-title"><div><h3>Live order book</h3><p>Click a price to prepare a trade</p></div><span class="pill num">Spread ${book.spread == null ? '—' : money(book.spread)}</span></div><div class="book-grid"><div class="book-column"><div class="book-head"><b class="positive">BUYERS / BIDS</b><span>Shares</span><span>Orders</span></div>${levels('buy')}</div><div class="book-column"><div class="book-head"><b class="negative">SELLERS / ASKS</b><span>Shares</span><span>Orders</span></div>${levels('sell')}</div></div><p class="book-foot">${number(book.active_orders)} resting orders · Price priority, then first in / first out</p>`;
  $('#recent-trades').innerHTML = `<div class="section-title"><h3>Recent trades</h3><span class="pill">Actual C-engine fills</span></div><div class="scroll-table"><table><thead><tr><th>Time</th><th>Price</th><th class="right">Shares</th><th>Side</th></tr></thead><tbody>${state.data.trades.slice(0, 25).map(fill => `<tr><td class="muted num">${time(fill.time_ms)}</td><td class="num">${money(fill.price)}</td><td class="right num">${number(fill.qty)}</td><td><span class="trade-side ${fill.taker_side}">${fill.taker_side === 'buy' ? 'Buy' : 'Sell'}</span></td></tr>`).join('')}</tbody></table></div>`;
  $('#market-activity').innerHTML = `<div class="section-title"><h3>Across the exchange</h3><span class="pill">Shared live activity</span></div>${state.data.activity.length ? `<div class="activity-list">${state.data.activity.map(item => `<div class="activity-item"><span class="activity-dot"></span><div><p><b>${esc(item.trader)}</b> ${esc(item.text)} · <b>${item.symbol}</b></p><small>${time(item.time)}${item.fills ? ` · ${item.fills} fill${item.fills === 1 ? '' : 's'}` : ''}</small></div></div>`).join('')}</div>` : `<div class="activity-empty"><b>${number(state.data.totalTrades)} seeded trades</b> and <b>${number(state.data.openOrders)} open orders</b> are already here.<br>Your trades and those of other users appear here as they happen.</div>`}`;
  updateTicket();
  $('#starter-card').innerHTML = state.data.user ? `<h3>Your market, your next move.</h3><p>Place a limit order, trade the existing book, or watch the algorithms in the DSA lab. Your portfolio stays saved when you leave.</p><a class="button full" href="#/portfolio">View my portfolio →</a>` : '<h3>Start with a head start.</h3><p>₹1,00,000 demo cash. Four stock holdings. Choose a ready-made trader and make your first trade in seconds.</p><button class="button full" data-login>Choose a demo account →</button>';
}
function renderTicket() {
  if (!$('#ticket')) return;
  $('#ticket').innerHTML = `<h2>Place an order</h2><p class="ticket-sub">Your next move starts here.</p><div class="side-switch" aria-label="Order side"><button type="button" data-side="buy" class="${state.side === 'buy' ? 'active' : ''}" aria-pressed="${state.side === 'buy'}">Buy</button><button type="button" data-side="sell" class="sell ${state.side === 'sell' ? 'active' : ''}" aria-pressed="${state.side === 'sell'}">Sell</button></div>
    <form id="order-form"><div class="field"><label for="order-symbol">Stock</label><select id="order-symbol"><option value="TCX">TCX · TradeCore Exchange</option><option value="NOVA">NOVA · Nova Energy</option><option value="APEX">APEX · Apex Systems</option><option value="ORBT">ORBT · Orbit Mobility</option></select></div>
    <div class="execution-switch" aria-label="Execution type"><button type="button" data-execution="instant" class="${state.execution === 'instant' ? 'active' : ''}" aria-pressed="${state.execution === 'instant'}">Instant trade</button><button type="button" data-execution="limit" class="${state.execution === 'limit' ? 'active' : ''}" aria-pressed="${state.execution === 'limit'}">Limit order</button></div>
    <div class="field" id="limit-field" ${state.execution === 'instant' ? 'hidden' : ''}><label for="order-price">Limit price <span>₹0.05 tick</span></label><input id="order-price" type="number" min=".05" max="100000" step=".05" value="${state.price}" inputmode="decimal" ${state.execution === 'limit' ? 'required' : ''}></div>
    <div class="field"><label for="order-qty">Quantity <span>Whole shares</span></label><div class="quantity-input"><button type="button" data-qty-change="-1" aria-label="Decrease quantity">−</button><input id="order-qty" type="number" required min="1" max="10000" step="1" value="${state.qty}" inputmode="numeric"><button type="button" data-qty-change="1" aria-label="Increase quantity">+</button></div><div class="quantity-presets">${[5, 10, 25, 40].map(qty => `<button type="button" data-qty="${qty}" class="${state.qty === qty ? 'active' : ''}">${qty}</button>`).join('')}</div></div>
    <div class="ticket-balance"><span id="balance-label">Available demo cash</span><b class="num" id="ticket-balance">Sign in to trade</b></div><div class="estimate"><span>Estimated value</span><b class="num" id="order-estimate">—</b></div><button class="button primary full order-button" id="order-submit" type="submit">Sign in to trade</button><p class="ticket-note" id="execution-note">Matches existing offers. Demo funds only; no trading fees.</p></form><div id="order-receipt" aria-live="polite"></div>`;
  $('#order-symbol').value = state.symbol;
  updateTicket();
}
function updateTicket() {
  if (!$('#ticket') || !state.data) return;
  if (state.data.book.symbol !== state.symbol) { $('#order-submit').disabled = true; $('#order-submit').textContent = 'Loading this stock…'; $('#order-estimate').textContent = '—'; return; }
  if (state.execution === 'limit' && !state.price) { state.price = String((state.side === 'buy' ? state.data.book.best_ask : state.data.book.best_bid) || state.data.markets.find(stock => stock.symbol === state.symbol).price); $('#order-price').value = state.price; }
  const { portfolio: wallet, user, book } = state.data;
  $('#balance-label').textContent = state.side === 'buy' ? 'Available demo cash' : `${state.symbol} shares available`;
  $('#ticket-balance').textContent = !wallet ? 'Sign in to trade' : state.side === 'buy' ? money(wallet.availableCash) : `${number(wallet.positions.find(position => position.symbol === state.symbol).available)} shares`;
  let value = 0, remaining = Number(state.qty) || 0;
  if (state.execution === 'instant') {
    for (const level of book[state.side === 'buy' ? 'asks' : 'bids']) { const take = Math.min(remaining, level.qty); value += take * level.price; remaining -= take; if (!remaining) break; }
  } else { value = Number(state.price || 0) * state.qty; remaining = 0; }
  $('#order-estimate').textContent = remaining > 0 ? 'Insufficient depth' : money(value);
  $('#order-submit').textContent = state.busy ? 'Sending to the market…' : !user ? 'Sign in to trade' : `${state.side === 'buy' ? 'Buy' : 'Sell'} ${number(state.qty)} ${state.symbol}`;
  $('#order-submit').disabled = state.busy;
  $('#order-submit').style.background = state.side === 'sell' ? '#b84c46' : '';
  $('#order-submit').style.borderColor = state.side === 'sell' ? '#b84c46' : '';
  $('#execution-note').textContent = state.execution === 'instant' ? 'Trades against available offers. Final value uses the actual fill prices.' : 'Waits in the book until matched. Cash or shares are reserved while open.';
  if (state.receipt) $('#order-receipt').innerHTML = `<div class="receipt ${state.receipt.error ? 'error' : ''}">${esc(state.receipt.message)}</div>`;
  else $('#order-receipt').innerHTML = '';
}
function renderPortfolio() {
  const container = $('#portfolio-content'), wallet = state.data.portfolio;
  if (!wallet) { container.innerHTML = `<div class="card center-empty"><span class="avatar" style="margin:auto">↗</span><h2>A portfolio with possibilities.</h2><p>Sign in to get ₹1,00,000 demo cash and a starter holding in every company. Your trades, cash, and shares are saved across visits.</p><button class="button primary" data-login>Choose a demo trader</button></div>`; return; }
  container.innerHTML = `<div class="wallet-summary"><div class="card wallet-stat"><span>Total portfolio value</span><b class="num">${money(wallet.cash + wallet.invested)}</b><small>Cash + current share values</small></div><div class="card wallet-stat"><span>Cash available to trade</span><b class="num">${money(wallet.availableCash)}</b><small>${money(wallet.reservedCash)} reserved for open buys</small></div><div class="card wallet-stat"><span>Stock holdings</span><b class="num">${money(wallet.invested)}</b><small>Across four demo companies</small></div><div class="card wallet-stat"><span>Total profit / loss</span><b class="num ${wallet.pnl < 0 ? 'negative' : 'positive'}">${wallet.pnl >= 0 ? '+' : '−'}${money(Math.abs(wallet.pnl))}</b><small>Realized + unrealized at last fill price</small></div></div>
    <h2>Your holdings</h2><div class="holdings-grid">${wallet.positions.map(position => `<section class="card holding-card"><div class="holding-head">${stockIcon(position)}<div><b>${position.symbol}</b><small>${esc(position.name)}</small></div></div><div class="holding-value num">${money(position.value)}</div><small class="${position.pnl < 0 ? 'negative' : 'positive'}">${position.pnl >= 0 ? '+' : '−'}${money(Math.abs(position.pnl))} unrealized</small><div class="holding-details"><div><span>Total shares</span><b class="num">${number(position.qty)}</b></div><div><span>Available</span><b class="num">${number(position.available)}</b></div><div><span>Average cost</span><b class="num">${money(position.average)}</b></div><div><span>Reserved</span><b class="num">${number(position.reserved)}</b></div></div><div class="holding-actions"><button class="button primary small" data-trade-symbol="${position.symbol}" data-trade-side="buy">Buy more</button><button class="button small" data-trade-symbol="${position.symbol}" data-trade-side="sell">Sell shares</button></div></section>`).join('')}</div>
    <section class="card portfolio-section"><div class="section-title"><div><h3>Open orders</h3><p>Cancel an order to release its reserved cash or shares</p></div><span class="pill">${wallet.openOrders.length} open</span></div>${orderTable(wallet.openOrders, true)}</section>
    <section class="card portfolio-section"><div class="section-title"><h3>Your executed trades</h3><span class="pill">${wallet.trades.length} recent fills</span></div><div class="scroll-table"><table><thead><tr><th>Time</th><th>Stock</th><th>Side</th><th class="right">Shares</th><th class="right">Fill price</th><th>Counterparty</th></tr></thead><tbody>${wallet.trades.map(fill => `<tr><td class="muted num">${time(fill.time_ms)}</td><td><b>${fill.symbol}</b></td><td><span class="trade-side ${fill.side}">${fill.side}</span></td><td class="right num">${number(fill.qty)}</td><td class="right num">${money(fill.price)}</td><td>${esc(fill.side === 'buy' ? fill.seller : fill.buyer)}</td></tr>`).join('') || '<tr><td colspan="6" class="activity-empty">Your first fill will appear here. Choose a holding above to buy or sell.</td></tr>'}</tbody></table></div></section>
    <section class="card portfolio-section"><div class="section-title"><h3>Order history</h3><span class="pill">Latest 100 orders</span></div>${orderTable(wallet.orders, false)}</section>`;
}
function orderTable(orders, cancellable) {
  return `<div class="scroll-table"><table><thead><tr><th>Order</th><th>Stock</th><th>Side</th><th class="right">Price</th><th class="right">Remaining</th><th>Status</th>${cancellable ? '<th></th>' : ''}</tr></thead><tbody>${orders.map(order => `<tr><td class="num">#${order.id}</td><td><b>${order.symbol}</b></td><td><span class="trade-side ${order.side}">${order.side}</span></td><td class="right num">${money(order.price)}</td><td class="right num">${number(order.remaining)} / ${number(order.qty)}</td><td><span class="status ${order.status}">${order.status}</span></td>${cancellable ? `<td><button class="button small danger" data-cancel="${order.id}" data-cancel-symbol="${order.symbol}" ${state.busy ? 'disabled' : ''}>Cancel</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="${cancellable ? 7 : 6}" class="activity-empty">${cancellable ? 'No orders waiting. Place a limit order from the Market to see it here.' : 'No orders yet. Your starter stocks are ready to trade.'}</td></tr>`}</tbody></table></div>`;
}
const eventDescriptions = {
  AVL_VISIT: 'The engine visits a price-level node while searching the balanced tree.',
  AVL_INSERT: 'A new price level is inserted into the AVL tree. Orders at that price share one FIFO queue.',
  AVL_REMOVE: 'The price level is empty, so its node is removed and the tree is rebalanced.',
  AVL_ROTATE_LEFT: 'A left rotation restores AVL balance without changing price order.',
  AVL_ROTATE_RIGHT: 'A right rotation restores AVL balance without changing price order.',
  FIFO_ENQUEUE: 'The order joins the tail of this price level. Earlier orders keep execution priority.',
  FIFO_DEQUEUE: 'The head order is fully filled and removed in constant time.',
  FIFO_UNLINK: 'The order is removed by linking its neighbours together. No queue scan is needed.',
  HASH_INSERT: 'The order ID is added to the hash table, pointing directly to its queue node.',
  HASH_ERASE: 'The order is no longer active, so its hash-table entry is removed.',
  HASH_RESIZE: 'The hash table doubles its capacity and rehashes entries to control collisions.',
  FILL: 'Two compatible orders execute at the resting maker’s price. Cash and shares transfer between accounts.',
  BEST_CHANGED: 'The cached best bid or ask changes. Future matching can read it in constant time.',
  ORDER_ACCEPTED: 'The limit order passed validation and received its arrival sequence.',
  ORDER_RESTED: 'Unfilled shares stay in the book, ready to match a future opposite order.',
  ORDER_FILLED: 'All shares in this order have executed.',
  ORDER_CANCELLED: 'The remaining quantity is cancelled; reserved funds or shares are released.',
  LEVEL_QTY: 'The aggregate quantity stored on this price level is updated.',
};
function renderLab() {
  const lab = state.data.lab;
  if (!lab) { $('#lab-content').innerHTML = '<div class="loading-panel"><span class="loader"></span><p>Loading the C engine’s current structures…</p></div>'; return; }
  const stock = state.data.markets.find(market => market.symbol === state.symbol), stats = lab.stats;
  $('#lab-content').innerHTML = `<div class="lab-toolbar"><select id="lab-symbol" aria-label="Stock to inspect">${state.data.markets.map(market => `<option value="${market.symbol}" ${market.symbol === state.symbol ? 'selected' : ''}>${market.symbol} · ${market.name}</option>`).join('')}</select><button class="button" data-demo="avl">Grow the tree · 12 levels</button><button class="button primary" data-demo="flow">Match 10 demo orders</button><a class="button" href="#/market">Place my own order →</a></div>
    <div class="lab-explainer"><b>One order, three data structures.</b> The AVL tree finds a price level → its FIFO queue decides who trades first → the hash table locates orders for cancellation. These are the actual structures for <b>${stock.symbol}</b>, shared with the trading screen.</div>
    <div class="lab-metrics"><div class="card"><small>Active price levels</small><b class="num">${stats.book.bid_levels + stats.book.ask_levels}</b><span>AVL search O(log P)</span></div><div class="card"><small>AVL rotations</small><b class="num">${number(stats.counters.avl_rotations)}</b><span>Balance maintained after changes</span></div><div class="card"><small>Hash entries / capacity</small><b class="num">${lab.hash.size} / ${lab.hash.capacity}</b><span>${(lab.hash.load_factor * 100).toFixed(1)}% load · expected O(1) lookup</span></div><div class="card"><small>Invariant checks</small><b class="${lab.check.ok ? 'positive' : 'negative'}">${lab.check.ok ? 'All passing' : 'Check failed'}</b><span>AVL balance · FIFO · totals · hash</span></div></div>
    <div class="lab-grid"><div><section class="card"><div class="section-title"><div><h3>AVL price-level tree</h3><p>Each node is a price, not an individual order</p></div><div class="tree-side-switch"><button data-tree-side="buy" class="${state.treeSide === 'buy' ? 'active' : ''}">Bids</button><button data-tree-side="sell" class="${state.treeSide === 'sell' ? 'active' : ''}">Asks</button></div></div><div class="tree-scroll" id="tree-diagram"></div><p class="tree-caption">First four layers shown. Labels show price, height, and queue size. Scroll the diagram horizontally on small screens.</p></section>
    <section class="card queue-section"><div class="section-title"><div><h3>FIFO queue at one price</h3><p>Oldest at the head. New orders join the tail.</p></div><span class="pill">O(1) unlink</span></div><div class="queue-controls">${lab.queues.map((queue, i) => `<button data-queue="${i}" class="${state.queue === i ? 'active' : ''}">${queue.side === 'buy' ? 'Bid' : 'Ask'} ${money(queue.price)}</button>`).join('')}</div><div class="queue-items" id="queue-items"></div></section></div>
    <div><section class="card"><div class="section-title"><h3>Hash table · order ID → node</h3><span class="pill">Separate chaining</span></div><div class="hash-panel"><p id="hash-selection">Select a queue order to inspect its hash bucket.</p><div class="hash-grid">${lab.hash.buckets.map(bucket => `<div class="hash-cell ${bucket.chain.length ? 'occupied' : ''}" title="Bucket ${bucket.index}: ${bucket.chain.length ? bucket.chain.map(id => '#' + id).join(', ') : 'empty'}">${bucket.index}</div>`).join('')}</div><p>First 64 buckets of ${number(lab.hash.capacity)}. Longest chain: ${lab.hash.max_chain}. The table grows above 75% load.</p></div></section>
    <section class="card event-panel"><div class="section-title"><h3>Recent engine trace</h3><span class="pill">Click an event</span></div><div class="event-detail" id="event-description"></div><div class="event-list" id="event-list"></div></section></div></div>`;
  drawTree(); renderQueue(); renderEvents();
}
function drawTree() {
  const tree = state.data.lab[state.treeSide === 'buy' ? 'bids' : 'asks'];
  const nodes = tree.nodes.filter(node => node.depth <= 3), byId = new Map(nodes.map(node => [node.id, node]));
  if (!nodes.length) { $('#tree-diagram').innerHTML = '<p class="activity-empty">No levels on this side. Grow the tree or place a limit order.</p>'; return; }
  const positions = new Map();
  function visit(id, left, right, depth) { const node = byId.get(id); if (!node) return; const x = (left + right) / 2; positions.set(id, { x, y: 34 + depth * 73 }); visit(node.left, left, x, depth + 1); visit(node.right, x, right, depth + 1); }
  visit(tree.root, 0, 720, 0);
  const selected = state.data.lab.events.find(event => event.seq === state.event);
  const edges = nodes.flatMap(node => [node.left, node.right].filter(id => positions.has(id)).map(id => { const a = positions.get(node.id), b = positions.get(id); return `<line class="tree-line" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`; })).join('');
  $('#tree-diagram').innerHTML = `<svg class="tree-svg" viewBox="0 0 720 310" role="img" aria-label="${state.treeSide} AVL tree showing ${nodes.length} price levels">${edges}${nodes.map(node => { const p = positions.get(node.id); if (!p) return ''; return `<g><circle class="tree-node ${selected?.node_id === node.id ? 'highlight' : ''}" cx="${p.x}" cy="${p.y}" r="23"/><text class="tree-price" x="${p.x}" y="${p.y + 4}">${node.price.toFixed(2)}</text><text class="tree-detail" x="${p.x}" y="${p.y + 39}">h${node.height} · ${node.orders} order${node.orders === 1 ? '' : 's'}</text></g>`; }).join('')}</svg>`;
}
function renderQueue() {
  const queues = state.data.lab.queues;
  state.queue = Math.min(state.queue, Math.max(0, queues.length - 1));
  const queue = queues[state.queue];
  if (!queue?.orders.length) { $('#queue-items').innerHTML = '<p class="muted">No orders at this level.</p>'; return; }
  if (!queue.orders.some(order => order.id === state.selectedOrder)) state.selectedOrder = queue.orders[0].id;
  $('#queue-items').innerHTML = queue.orders.slice(0, 12).map((order, i) => `<button class="queue-order ${order.id === state.selectedOrder ? 'selected' : ''}" data-queue-order="${order.id}"><b>#${order.id}${i === 0 ? ' · HEAD' : ''}</b><small>${order.remaining} shares · seq ${order.seq}</small></button>${i < Math.min(queue.orders.length, 12) - 1 ? '<span class="muted" aria-hidden="true">⇄</span>' : ''}`).join('');
  const selected = queue.orders.find(order => order.id === state.selectedOrder);
  $('#hash-selection').innerHTML = selected ? `Order <b>#${selected.id}</b> hashes to bucket <b>${selected.hash_bucket}</b>. The table points directly to this queue node.` : 'Select an order.';
}
function renderEvents() {
  const events = state.data.lab.events;
  if (!events.some(event => event.seq === state.event)) state.event = events.at(-1)?.seq;
  const selected = events.find(event => event.seq === state.event);
  $('#event-description').textContent = selected ? `${selected.type.replaceAll('_', ' ')}: ${eventDescriptions[selected.type] || 'The matching engine updates its live state.'}${selected.order_id ? ` Order #${selected.order_id}.` : ''}` : 'Run a demo or place an order to generate trace events.';
  $('#event-list').innerHTML = events.slice(-18).reverse().map(event => `<button class="event-item ${event.seq === state.event ? 'selected' : ''}" data-event="${event.seq}"><b>${event.type.replaceAll('_', ' ')}</b><span>#${event.seq} · command ${event.cmd_seq}${event.order_id ? ` · order #${event.order_id}` : ''}${event.price ? ` · ${money(event.price)}` : ''}</span></button>`).join('');
}
function renderData() {
  updateAccount();
  if (state.view === 'market') renderMarket(); else if (state.view === 'portfolio') renderPortfolio(); else renderLab();
}
async function refresh(force = false) {
  if (requestPending && !force) return;
  if (force) controller?.abort();
  controller = new AbortController();
  const activeController = controller;
  const current = ++requestGeneration;
  requestPending = true;
  const timeout = setTimeout(() => activeController.abort(), 25000);
  try {
    const params = new URLSearchParams({ symbol: state.symbol, lab: state.view === 'lab' ? '1' : '0' });
    if (!force && state.data) params.set('since', state.data.version);
    const data = await json(`/api/market?${params}`, { signal: activeController.signal });
    if (current !== requestGeneration) return;
    if (!data.unchanged) { state.data = data; renderData(); }
    $('#connection').innerHTML = '<i></i>Live · shared market'; $('#connection').classList.add('live');
    $('#connection').title = `Last checked ${time(Date.now())}. Automatically checks for changes every 1.5 seconds.`;
    $('#connection-error').hidden = true;
  } catch (error) {
    if (error.name === 'AbortError' && current !== requestGeneration) return;
    $('#connection').innerHTML = '<i></i>Reconnecting'; $('#connection').classList.remove('live');
    $('#connection-error').innerHTML = `${esc(error.name === 'AbortError' ? 'The market is taking longer than usual to respond.' : error.message)} Your existing data stays visible.<button data-refresh>Retry now</button>`;
    $('#connection-error').hidden = false;
  } finally { clearTimeout(timeout); if (current === requestGeneration) requestPending = false; }
}
function changeStock(symbol) {
  if (!['TCX', 'NOVA', 'APEX', 'ORBT'].includes(symbol)) return;
  state.symbol = symbol; state.price = ''; state.receipt = null; state.queue = 0; state.event = null;
  if ($('#order-symbol')) $('#order-symbol').value = symbol;
  updateTicket();
  refresh(true);
}
function showLogin() {
  $('#auth-error').textContent = '';
  if (!$('#auth-dialog').open) $('#auth-dialog').showModal();
}
async function signIn(email, password, name) {
  if (state.authBusy) return;
  state.authBusy = true; $('#auth-error').textContent = '';
  $$('#auth-dialog button').forEach(button => { if (!button.hasAttribute('data-close-dialog')) button.disabled = true; });
  try {
    await json(`/api/auth/${name ? 'sign-up' : 'sign-in'}/email`, { method: 'POST', body: JSON.stringify({ email, password, ...(name ? { name } : {}) }) });
    $('#auth-dialog').close();
    await refresh(true);
    toast(`Welcome${state.data?.user ? ', ' + state.data.user.name : ''}. Your cash and starter shares are ready.`);
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { state.authBusy = false; $$('#auth-dialog button').forEach(button => { button.disabled = false; }); }
}
async function placeOrder(event) {
  event.preventDefault();
  if (!state.data?.user) { showLogin(); return; }
  if (state.busy) return;
  state.qty = Number($('#order-qty').value); state.price = $('#order-price').value;
  const payload = { symbol: state.symbol, side: state.side, qty: state.qty, price: state.price, execution: state.execution };
  const fingerprint = JSON.stringify(payload);
  if (lastOrder?.fingerprint !== fingerprint) lastOrder = { fingerprint, id: crypto.randomUUID() };
  state.busy = true; state.receipt = null; updateTicket();
  try {
    const result = await json('/api/orders', { method: 'POST', body: JSON.stringify({ ...payload, requestId: lastOrder.id }) });
    const filled = result.fills.reduce((sum, fill) => sum + fill.qty, 0);
    state.receipt = { message: filled ? `Order #${result.order.id}: ${filled} ${state.symbol} shares ${state.side === 'buy' ? 'bought' : 'sold'} in ${result.fills.length} fill${result.fills.length === 1 ? '' : 's'}.${result.order.remaining ? ` ${result.order.remaining} shares are waiting in the book.` : ' Your portfolio is updated.'}` : `Limit order #${result.order.id} is waiting at ${money(result.order.price)}. ${result.order.remaining} shares reserved.` };
    lastOrder = null; await refresh(true);
  } catch (error) { state.receipt = { error: true, message: error.message }; if (error.status === 401) showLogin(); }
  finally { state.busy = false; updateTicket(); }
}
async function runAction(path, body) {
  if (!state.data?.user) { showLogin(); return; }
  if (state.busy) return;
  state.busy = true; updateTicket();
  $$('[data-demo], [data-cancel]').forEach(button => { button.disabled = true; });
  try {
    const result = await json(path, { method: 'POST', body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }) });
    toast(result.message || (body.id ? `Order #${body.id} cancelled. Reserved funds / shares released.` : 'The market is updated.'));
    await refresh(true);
  } catch (error) { toast(error.message); }
  finally { state.busy = false; $$('[data-demo], [data-cancel]').forEach(button => { button.disabled = false; }); updateTicket(); }
}
function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  state.view = ['portfolio', 'orders', 'history', 'settings'].includes(raw) ? 'portfolio' : ['lab', 'dsa', 'performance', 'scenarios'].includes(raw) ? 'lab' : 'market';
  document.title = `${state.view === 'market' ? 'Market' : state.view === 'portfolio' ? 'Portfolio' : 'DSA lab'} · TradeCore`;
  renderShell(); refresh(true); window.scrollTo({ top: 0, behavior: 'instant' });
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button, a');
  if (!button || button.disabled) return;
  const d = button.dataset;
  if ('login' in d) showLogin();
  else if ('closeDialog' in d) $('#auth-dialog').close();
  else if ('demoEmail' in d) signIn(d.demoEmail, 'TradeCore123!');
  else if ('authMode' in d) { state.authMode = d.authMode; $('#name-field').hidden = state.authMode !== 'signup'; $('#auth-form [name=name]').required = state.authMode === 'signup'; $('#auth-submit').textContent = state.authMode === 'signup' ? 'Create account & get starter shares' : 'Sign in'; $('#auth-form [name=password]').autocomplete = state.authMode === 'signup' ? 'new-password' : 'current-password'; $$('[data-auth-mode]').forEach(item => item.classList.toggle('active', item.dataset.authMode === state.authMode)); }
  else if ('signout' in d) { try { await json('/api/auth/sign-out', { method: 'POST', body: '{}' }); state.receipt = null; await refresh(true); toast('Signed out. Your portfolio is saved.'); } catch (error) { toast(error.message); } }
  else if ('portfolio' in d) location.hash = '#/portfolio';
  else if ('refresh' in d) refresh(true);
  else if ('symbol' in d) changeStock(d.symbol);
  else if ('side' in d) { state.side = d.side; state.price = String(state.side === 'buy' ? state.data?.book.best_ask || '' : state.data?.book.best_bid || ''); renderTicket(); }
  else if ('execution' in d) { state.execution = d.execution; if (!state.price) state.price = String(state.side === 'buy' ? state.data?.book.best_ask || '' : state.data?.book.best_bid || ''); renderTicket(); }
  else if ('qty' in d || 'qtyChange' in d) { state.qty = 'qty' in d ? Number(d.qty) : Math.max(1, Math.min(10000, (Number($('#order-qty').value) || 0) + Number(d.qtyChange))); $('#order-qty').value = state.qty; updateTicket(); }
  else if ('range' in d) { state.range = d.range; renderMarket(); }
  else if ('levelSide' in d) { state.side = d.levelSide === 'sell' ? 'buy' : 'sell'; state.execution = 'limit'; state.price = d.price; renderTicket(); $('#ticket').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  else if ('tradeSymbol' in d) { state.symbol = d.tradeSymbol; state.side = d.tradeSide; state.price = ''; state.execution = 'instant'; location.hash = '#/market'; }
  else if ('demo' in d) runAction('/api/demo', { symbol: state.symbol, scenario: d.demo });
  else if ('cancel' in d) runAction('/api/orders/cancel', { symbol: d.cancelSymbol, id: Number(d.cancel) });
  else if ('treeSide' in d) { state.treeSide = d.treeSide; renderLab(); }
  else if ('queue' in d) { state.queue = Number(d.queue); state.selectedOrder = null; renderLab(); }
  else if ('queueOrder' in d) { state.selectedOrder = Number(d.queueOrder); renderQueue(); }
  else if ('event' in d) { state.event = Number(d.event); renderEvents(); drawTree(); }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'order-form') placeOrder(event);
  if (event.target.id === 'auth-form') { event.preventDefault(); const form = new FormData(event.target); signIn(String(form.get('email')).trim(), form.get('password'), state.authMode === 'signup' ? String(form.get('name')).trim() : undefined); }
});
document.addEventListener('change', event => { if (['order-symbol', 'lab-symbol'].includes(event.target.id)) changeStock(event.target.value); });
document.addEventListener('input', event => { if (event.target.id === 'order-qty') { state.qty = Number(event.target.value); updateTicket(); } if (event.target.id === 'order-price') { state.price = event.target.value; updateTicket(); } });
$('#theme-toggle').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('tradecore.theme', theme); } catch {} };
try { document.documentElement.dataset.theme = localStorage.getItem('tradecore.theme') || 'light'; } catch {}
$('#demo-accounts').innerHTML = DEMOS.map(demo => `<button class="demo-account" data-demo-email="${demo.email}"><span class="avatar">${demo.initials}</span><span><b>Trade as ${demo.name}</b><small>₹1 lakh + starter stocks</small></span></button>`).join('');
window.addEventListener('hashchange', route);
window.addEventListener('focus', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 120); });
setInterval(() => { if (!document.hidden && !state.authBusy) refresh(); }, 1500);
route();
