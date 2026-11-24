// Overview: market snapshot, price movement, pressure, depth, recent trades.
import { get, isMine } from '../api.js';
import { bus, shared, session } from '../store.js';
import { $, esc, inr, px, int, pct, inrCompact, clock, onResize, sideTag } from '../ui.js';
import { icon } from '../icons.js';
import { areaChart } from '../charts.js';
import { priceSeries, wireSeg, describeCommand, feedItem } from './common.js';

let range = '1H', filter = 'all', stopResize, lastSeries = null, offFeed;
const WELCOME_KEY = () => `tradecore.welcome.${session.user?.username}`;

export default {
  html: () => `
  ${welcome()}
  <div class="grid g6">
    <div class="card stat">
      <div class="label">Simulated price</div>
      <div class="stat-row" style="justify-content:flex-start;gap:8px;align-items:baseline">
        <div class="value big accent num" id="ov-price">—</div><span class="pos" id="ov-chg" style="font-size:13px"></span>
      </div>
      <div class="bar" style="margin-top:14px"><i id="ov-pbar" style="width:0"></i></div>
    </div>
    <div class="card stat">
      <div class="label">Best bid</div>
      <div class="stat-row" style="justify-content:flex-start;gap:8px">
        <div class="value big sell num" id="ov-bid">—</div><span class="tag" id="ov-bidq" style="flex-direction:column;align-items:flex-start;gap:0;font-size:12px">Qty:<br>—</span>
      </div>
      <div class="foot" id="ov-biddepth">Depth: —</div>
    </div>
    <div class="card stat">
      <div class="label">Best ask</div>
      <div class="stat-row" style="justify-content:flex-start;gap:8px">
        <div class="value big sell num" id="ov-ask">—</div><span class="tag" id="ov-askq" style="flex-direction:column;align-items:flex-start;gap:0;font-size:12px">Qty:<br>—</span>
      </div>
      <div class="foot" id="ov-askdepth">Depth: —</div>
    </div>
    <div class="card stat">
      <div class="label">Spread</div>
      <div class="stat-row"><div class="value big num" id="ov-spread">—</div><span class="accent" style="font-size:13px" id="ov-spreadpct"></span></div>
      <div class="foot" id="ov-liq">—</div>
    </div>
    <div class="card stat">
      <div class="label">Traded volume</div>
      <div class="stat-row"><div class="value big num" id="ov-vol">—</div><span style="font-size:13px">Shares</span></div>
      <div class="foot" id="ov-turn">— Turnover</div>
    </div>
    <div class="card stat">
      <div class="label">Active orders</div>
      <div class="stat-row"><div class="value big accent num" id="ov-active">—</div><span class="tag sell">Live Match</span></div>
      <div class="foot" id="ov-levels">—</div>
    </div>
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,2.15fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="title-row"><h3>TCX Price Movement</h3><span class="tag solid up" style="font-weight:500">Simulated <span id="ov-rlabel">1H</span></span></div>
          <div class="sub">Real-time matching engine simulation feed</div>
        </div>
        <div class="seg" id="ov-range"><button class="on" data-v="1H">1H</button><button data-v="1D">1D</button><button data-v="1W">1W</button></div>
      </div>
      <div style="border-top:1px solid var(--line);padding-top:14px"><div class="chart" id="ov-chart"></div></div>
      <div class="grid g4" style="border-top:1px solid var(--line);padding-top:16px;margin-top:10px">
        <div><div class="label">Open</div><div class="num" style="font-size:17px;margin-top:6px" id="ov-open">—</div></div>
        <div><div class="label">High</div><div class="num sell" style="font-size:17px;margin-top:6px" id="ov-high">—</div></div>
        <div><div class="label">Low</div><div class="num sell" style="font-size:17px;margin-top:6px" id="ov-low">—</div></div>
        <div><div class="label">VWAP</div><div class="num accent" style="font-size:17px;margin-top:6px" id="ov-vwap">—</div></div>
      </div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card">
        <div class="card-head" style="margin-bottom:10px"><h3>Market Pressure</h3><span class="sub" style="margin:0">Taker volume</span></div>
        <div class="stat-row" style="font-size:13.5px"><span class="sell" id="ov-buyp">Buy Vol: —</span><span class="sell" id="ov-sellp">Sell Vol: —</span></div>
        <div style="display:flex;gap:3px;margin-top:10px;height:8px">
          <div id="ov-buybar" style="background:var(--sell);border-radius:999px 0 0 999px;width:50%"></div>
          <div id="ov-sellbar" style="background:var(--sell);opacity:.75;border-radius:0 999px 999px 0;flex:1"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Order Book Depth</h3><span class="accent" style="font-size:12px">TCX/INR</span></div>
        <div id="ov-depth" style="font-size:13px"></div>
        <div class="stat-row" style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px;font-size:13.5px">
          <span>Total Depth Ratio</span><span class="sell" id="ov-ratio">—</span>
        </div>
      </div>
    </div>
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,1.75fr) minmax(0,1fr)">
  <div class="card">
    <div class="card-head" style="margin-bottom:24px">
      <div><h3>Recent Executed Trades</h3><div class="sub">Live ticker stream from the matching engine</div></div>
      <div class="seg sm" id="ov-filter"><button class="on" data-v="all">${icon('list-filter', 14)} All</button><button data-v="buy">Buy</button><button data-v="sell">Sell</button></div>
    </div>
    <table class="table boxed">
      <thead><tr><th>Execution price</th><th>Quantity</th><th>Time (IST)</th><th>Type</th><th>Buyer → Seller</th><th class="r">Total value</th></tr></thead>
      <tbody id="ov-trades"></tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-head"><div><h3>Who's Trading</h3><div class="sub">Every order, in plain words</div></div><span class="live"><span class="dot pulse"></span>live</span></div>
    <div class="feed" id="ov-feed"></div>
  </div>
  </div>`,

  mount(root) {
    wireSeg(root, '#ov-range', v => { range = v; $('#ov-rlabel').textContent = v; drawChart(); });
    wireSeg(root, '#ov-filter', v => { filter = v; drawTrades(); });
    stopResize = onResize($('#ov-chart'), () => lastSeries && paint());
    $('#ov-welcome-x')?.addEventListener('click', () => { try { localStorage.setItem(WELCOME_KEY(), '1'); } catch { /* ignore */ } $('#ov-welcome').remove(); });
    const items = shared.commandLog.map(c => [describeCommand(c, isMine), c.order?.time_ms]).filter(x => x[0]).slice(0, 9);
    $('#ov-feed').innerHTML = items.map(([d, t]) => feedItem(d, t || Date.now())).join('') || '<div class="empty">Waiting for the next order…</div>';
    offFeed = bus.on('command', cmd => {
      const d = describeCommand(cmd, isMine), el = $('#ov-feed');
      if (!d || !el) return;
      el.querySelector('.empty')?.remove();
      el.insertAdjacentHTML('afterbegin', feedItem(d, Date.now(), true));
      while (el.children.length > 9) el.lastElementChild.remove();
    });
  },

  unmount() { stopResize?.(); offFeed?.(); },

  async refresh() {
    const [s] = await Promise.all([get('/api/summary'), drawChart(), drawTrades()]);
    if (!s.ok) return;
    const last = s.last ?? null;
    $('#ov-price').textContent = inr(last);
    const ch = s.first_price && s.last ? (s.last - s.first_price) / s.first_price * 100 : null;
    $('#ov-chg').textContent = ch == null ? '' : pct(ch);
    $('#ov-chg').className = ch != null && ch < 0 ? 'neg' : 'pos';
    $('#ov-pbar').style.width = s.high && s.low && last ? `${Math.max(4, (last - s.low) / Math.max(s.high - s.low, 0.01) * 100)}%` : '0';
    $('#ov-bid').textContent = inr(s.best_bid);
    $('#ov-ask').textContent = inr(s.best_ask);
    $('#ov-bidq').innerHTML = `Qty:<br>${int(s.best_bid_qty)}`;
    $('#ov-askq').innerHTML = `Qty:<br>${int(s.best_ask_qty)}`;
    $('#ov-biddepth').textContent = `Depth: ${int(s.bid_depth)} units`;
    $('#ov-askdepth').textContent = `Depth: ${int(s.ask_depth)} units`;
    $('#ov-spread').textContent = inr(s.spread);
    const sp = s.spread != null && s.best_ask ? s.spread / s.best_ask * 100 : null;
    $('#ov-spreadpct').textContent = sp == null ? '' : sp.toFixed(2) + '%';
    $('#ov-liq').textContent = sp == null ? 'One side empty' : sp < 0.5 ? 'Tight Liquidity' : sp < 2 ? 'Moderate Liquidity' : 'Wide Spread';
    $('#ov-vol').textContent = int(s.volume);
    $('#ov-turn').textContent = `${inrCompact(s.turnover)} Turnover`;
    $('#ov-active').textContent = int(s.active_orders);
    $('#ov-levels').textContent = `${s.bid_levels} bid / ${s.ask_levels} ask levels`;
    $('#ov-open').textContent = inr(s.open);
    $('#ov-high').textContent = inr(s.high);
    $('#ov-low').textContent = inr(s.low);
    $('#ov-vwap').textContent = inr(s.vwap);
    const tot = s.buy_volume + s.sell_volume;
    const bp = tot ? Math.round(s.buy_volume / tot * 100) : 50;
    $('#ov-buyp').textContent = `Buy Vol: ${bp}% (${int(s.buy_volume)})`;
    $('#ov-sellp').textContent = `Sell Vol: ${100 - bp}% (${int(s.sell_volume)})`;
    $('#ov-buybar').style.width = bp + '%';
    $('#ov-ratio').textContent = s.ask_depth ? (s.bid_depth / s.ask_depth).toFixed(2) + ' Bid/Ask' : '—';
    await drawDepth(s);
  },
};

async function drawChart() {
  lastSeries = await priceSeries(range, 60);
  paint();
}

function paint() {
  const el = $('#ov-chart');
  if (!el || !lastSeries) return;
  areaChart(el, lastSeries.values, { height: 270, dot: true, labels: lastSeries.labels, grid: 3, empty: `No trades in the last ${range}` });
}

async function drawDepth(s) {
  const b = await get('/api/book?depth=3');
  const el = $('#ov-depth');
  if (!b.ok || !el) return;
  const row = (l, cls, tag) => `<div class="stat-row" style="background:${cls === 'ask' ? 'var(--sell-deep)' : 'var(--card-2)'};padding:6px 8px;margin-top:4px;border-radius:2px;${tag ? 'font-weight:700' : ''}">
      <span style="width:42%">${px(l.price)}${tag ? ` (${tag})` : ''}</span><span style="width:20%;text-align:center">${l.qty}</span><span style="width:38%;text-align:right">${px(l.price * l.qty)}</span></div>`;
  const asks = b.asks.slice().reverse();
  el.innerHTML = `${asks.map((l, i) => row(l, 'ask', i === asks.length - 1 ? 'Best Ask' : '')).join('') || '<div class="dim" style="padding:6px 8px">No asks</div>'}
    <div class="accent" style="text-align:center;padding:9px 0">Spread: ${s.spread != null ? `₹${px(s.spread)} (${(s.spread / s.best_ask * 100).toFixed(2)}%)` : '—'}</div>
    ${b.bids.map((l, i) => row(l, 'bid', i === 0 ? 'Best Bid' : '')).join('') || '<div class="dim" style="padding:6px 8px">No bids</div>'}`;
}

async function drawTrades() {
  const r = await get('/api/trades?limit=40');
  const el = $('#ov-trades');
  if (!el) return;
  const rows = (r.trades || []).filter(t => filter === 'all' || t.taker_side === filter).slice(0, 8);
  el.innerHTML = rows.length ? rows.map(t => `<tr>
      <td class="sell num" style="font-weight:600">${inr(t.price)}</td><td class="num">${t.qty}</td>
      <td class="num">${clock(t.time_ms)}</td><td>${sideTag(t.taker_side)}</td>
      <td style="font-size:14px">${who(t, 'buy')} → ${who(t, 'sell')}</td>
      <td class="r num">${inr(t.price * t.qty)}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">No trades yet. Place an order or load a scenario.</td></tr>`;
}

function who(t, side) {
  const takerSide = t.taker_side === side;
  const name = takerSide ? t.taker_trader : t.maker_trader, owner = takerSide ? t.taker_owner : t.maker_owner;
  return isMine(owner) ? '<b class="accent">You</b>' : esc(name || '—');
}

function welcome() {
  let seen = false;
  try { seen = !!localStorage.getItem(WELCOME_KEY()); } catch { /* ignore */ }
  if (seen) return '';
  const u = esc(session.user?.username || '');
  return `<div class="card welcome" id="ov-welcome" style="margin-bottom:var(--gap)">
    <div><h2>Welcome, ${u} 👋</h2>
      <div class="muted">The market is already running — 12 bot traders are buying and selling TCX right now. Here's how to get started:</div>
      <div class="quick">
        <a href="#/trade/terminal">${icon('chart-candlestick', 22)}<span><b>1 · Place your first order</b><small>Buy or sell TCX in the Trading Terminal. Bots will trade with you.</small></span></a>
        <a href="#/dsa/dsa">${icon('workflow', 22)}<span><b>2 · Look inside the engine</b><small>Watch your order travel through the AVL tree, FIFO queue and hash table.</small></span></a>
        <a href="#/lab/market">${icon('flask-conical', 22)}<span><b>3 · Shake the market</b><small>Trigger a flash crash or a bull run in the Demo Lab.</small></span></a>
      </div></div>
    <button class="iconbtn" id="ov-welcome-x" title="Dismiss" style="align-self:start">${icon('x', 18)}</button>
  </div>`;
}
