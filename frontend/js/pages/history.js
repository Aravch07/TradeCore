// Trade History: every fill, linked to maker, taker and command sequence.
import { get } from '../api.js';
import { settings } from '../store.js';
import { $, esc, px, int, inr, inrCompact, clock, toast, sideTag } from '../ui.js';
import { icon } from '../icons.js';
import { pageHead, wireSeg } from './common.js';

const PER_PAGE = 12;
let trades = [], side = 'all', mine = false, q = '', page = 1;

export default {
  html: () => `
  ${pageHead('Trade History', 'Every execution from the matching engine, linked to its maker, taker and command sequence.',
    `<button class="btn ghost" id="th-csv">${icon('download', 16)} Export CSV</button>`)}
  <div class="grid g4">
    ${stat('Total trades', 'th-count', 'list-ordered', '')}
    ${stat('Volume traded', 'th-vol', 'chart-no-axes-column', 'sell')}
    ${stat('Turnover', 'th-turn', 'banknote', 'buy')}
    ${stat('VWAP', 'th-vwap', 'activity', 'plain')}
  </div>
  <div class="card mt" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <label class="search">${icon('search', 16)}<input id="th-q" placeholder="Search order ID, trader…"></label>
    <div class="seg" id="th-side"><button class="on" data-v="all">All</button><button data-v="buy">Buy-initiated</button><button data-v="sell">Sell-initiated</button></div>
    <div style="flex:1"></div>
    <label class="title-row" style="font-size:14px;gap:10px">Only my trades
      <span class="toggle"><input type="checkbox" id="th-mine"><span></span></span></label>
  </div>
  <div class="card mt" style="padding:0;overflow:hidden">
    <div class="table-wrap"><table class="table boxed">
      <thead><tr><th>Trade #</th><th>Time (IST)</th><th class="r">Price (₹)</th><th class="r">Qty</th><th class="r">Value (₹)</th>
        <th style="padding-left:24px">Aggressor</th><th>Buy order</th><th>Sell order</th><th>Maker → Taker</th><th class="r">Cmd seq</th></tr></thead>
      <tbody id="th-rows"></tbody></table></div>
    <div class="pagination"><span id="th-showing" style="font-size:13.5px"></span><div class="pages" id="th-pages"></div></div>
  </div>`,

  mount(root) {
    wireSeg(root, '#th-side', v => { side = v; page = 1; draw(); });
    $('#th-mine').onchange = e => { mine = e.target.checked; page = 1; draw(); };
    $('#th-q').oninput = e => { q = e.target.value.trim().toLowerCase(); page = 1; draw(); };
    $('#th-pages').onclick = e => { const b = e.target.closest('button[data-p]'); if (b && !b.disabled) { page = +b.dataset.p; draw(); } };
    $('#th-csv').onclick = exportCsv;
  },

  async refresh() {
    const [r, s] = await Promise.all([get('/api/trades?limit=5000'), get('/api/summary')]);
    trades = r.trades || [];
    $('#th-count').textContent = int(s.total_trades ?? trades.length);
    $('#th-vol').textContent = `${int(s.volume)} TCX`;
    $('#th-turn').textContent = inrCompact(s.turnover);
    $('#th-vwap').textContent = inr(s.vwap);
    draw();
  },
};

function stat(label, id, ic, cls) {
  return `<div class="card"><div class="stat-row" style="align-items:flex-start"><div>
    <div style="font-size:17px;letter-spacing:.05em;text-transform:uppercase;line-height:1.35">${label.replace(' ', '<br>')}</div>
    <div class="accent num" style="font-size:17px;margin-top:8px" id="${id}">—</div></div>
    <span class="metric-ico ${cls}">${icon(ic, 22)}</span></div></div>`;
}

function filtered() {
  const me = settings.get('trader');
  return trades.filter(t => (side === 'all' || t.taker_side === side) &&
    (!mine || t.maker_trader === me || t.taker_trader === me) &&
    (!q || [t.trade_id, t.buy_order_id, t.sell_order_id].some(x => String(x) === q.replace(/^#?(ord-)?/, '')) ||
      t.maker_trader.toLowerCase().includes(q) || t.taker_trader.toLowerCase().includes(q)));
}

function draw() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  page = Math.min(page, pages);
  const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $('#th-rows').innerHTML = slice.length ? slice.map(t => `<tr>
    <td class="accent" style="font-weight:700">#${t.trade_id}</td><td class="num">${clock(t.time_ms, true)}</td>
    <td class="r sell num" style="font-weight:600">${px(t.price)}</td><td class="r num">${int(t.qty)}</td><td class="r num">${px(t.price * t.qty)}</td>
    <td style="padding-left:24px">${sideTag(t.taker_side)}</td>
    <td class="mono">ORD-${t.buy_order_id}</td><td class="mono">ORD-${t.sell_order_id}</td>
    <td style="font-size:14px">${esc(t.maker_trader || '—')} → ${esc(t.taker_trader || '—')}</td>
    <td class="r num dim">${t.cmd_seq}</td></tr>`).join('')
    : '<tr><td colspan="10" class="empty">No trades match these filters.</td></tr>';
  const from = rows.length ? (page - 1) * PER_PAGE + 1 : 0;
  $('#th-showing').innerHTML = `Showing <b>${from}-${Math.min(page * PER_PAGE, rows.length)}</b> of <b>${rows.length}</b> trades${trades.length >= 5000 ? ' (latest 5,000)' : ''}`;
  const nums = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  $('#th-pages').innerHTML = `<button data-p="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>
    ${nums.map(p => `<button data-p="${p}" class="${p === page ? 'on' : ''}">${p}</button>`).join('')}
    <button data-p="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
}

function exportCsv() {
  const rows = filtered();
  const body = rows.map(t => [t.trade_id, new Date(t.time_ms).toISOString(), t.price.toFixed(2), t.qty, t.taker_side,
    t.buy_order_id, t.sell_order_id, t.maker_id, t.taker_id, `"${t.maker_trader}"`, `"${t.taker_trader}"`, t.cmd_seq].join(','));
  const blob = new Blob([['trade_id,time,price,qty,aggressor,buy_order,sell_order,maker,taker,maker_trader,taker_trader,cmd_seq', ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `tradecore-trades-${Date.now()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${rows.length} trades`, 'ok');
}
