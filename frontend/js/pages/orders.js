// My Orders: history of orders with filters, CSV export and cancel-all.
import { get, post } from '../api.js';
import { settings } from '../store.js';
import { $, esc, px, int, inr, ns, clock, toast, modal, statusTag, sideTag } from '../ui.js';
import { icon } from '../icons.js';
import { pageHead, wireSeg } from './common.js';

const PER_PAGE = 8;
let orders = [], status = 'all', sideF = 'all', sort = 'new', q = '', page = 1, scope = 'mine';

export default {
  html: () => `
  ${pageHead('Active &amp; Historical Orders', 'Real-time order book management, execution tracking, and cancellation pipelines.',
    `<button class="btn ghost" id="mo-csv">${icon('download', 16)} Export CSV</button>
     <button class="btn danger-ghost" id="mo-cancelall">${icon('circle-x', 16)} Cancel All Open</button>`)}
  <div class="grid g4">
    ${stat('Total open orders', 'mo-open', 'receipt', '')}
    ${stat('Notional volume', 'mo-notional', 'banknote', 'sell')}
    ${stat('Partially filled', 'mo-partial', 'chart-pie', 'buy')}
    ${stat('Execution latency', 'mo-lat', 'zap', 'plain')}
  </div>
  <div class="card mt" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <label class="search">${icon('search', 16)}<input id="mo-q" placeholder="Search order ID, trader…"></label>
    <div class="seg" id="mo-status">
      ${['all', 'open', 'partial', 'filled', 'cancelled', 'replaced'].map(s => `<button data-v="${s}" class="${s === 'all' ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
    </div>
    <div style="flex:1"></div>
    <select class="select" id="mo-scope"><option value="mine">Trader: Mine</option><option value="all">Trader: All</option></select>
    <select class="select" id="mo-side"><option value="all">Side: All</option><option value="buy">Side: Buy</option><option value="sell">Side: Sell</option></select>
    <select class="select" id="mo-sort"><option value="new">Sort: Timestamp (Newest)</option><option value="old">Sort: Timestamp (Oldest)</option>
      <option value="pricehi">Sort: Price (High)</option><option value="pricelo">Sort: Price (Low)</option><option value="qty">Sort: Quantity</option></select>
  </div>
  <div class="card mt" style="padding:0;overflow:hidden">
    <div class="table-wrap"><table class="table boxed">
      <thead><tr><th>Order ID / Seq</th><th>Symbol</th><th>Side</th><th class="r">Price (₹)</th><th class="r">Original Qty</th>
        <th class="r">Filled Qty</th><th class="r">Remaining Qty</th><th style="padding-left:24px">Status</th><th>Timestamp</th></tr></thead>
      <tbody id="mo-rows"></tbody></table></div>
    <div class="pagination"><span id="mo-showing" style="font-size:13.5px"></span><div class="pages" id="mo-pages"></div></div>
  </div>`,

  mount(root) {
    wireSeg(root, '#mo-status', v => { status = v; page = 1; draw(); });
    $('#mo-side').onchange = e => { sideF = e.target.value; page = 1; draw(); };
    $('#mo-sort').onchange = e => { sort = e.target.value; draw(); };
    $('#mo-scope').value = scope;
    $('#mo-scope').onchange = e => { scope = e.target.value; page = 1; this.refresh(); };
    $('#mo-q').oninput = e => { q = e.target.value.trim().toLowerCase(); page = 1; draw(); };
    $('#mo-pages').onclick = e => { const b = e.target.closest('button[data-p]'); if (b && !b.disabled) { page = +b.dataset.p; draw(); } };
    $('#mo-csv').onclick = exportCsv;
    $('#mo-cancelall').onclick = cancelAll;
  },

  async refresh() {
    const trader = settings.get('trader');
    const [r, st] = await Promise.all([
      get(`/api/orders?status=all&limit=5000${scope === 'mine' ? `&trader=${encodeURIComponent(trader)}` : ''}`),
      get('/api/stats'),
    ]);
    orders = r.orders || [];
    const open = orders.filter(o => o.status === 'open' || o.status === 'partial');
    $('#mo-open').textContent = int(open.length);
    $('#mo-notional').textContent = inr(open.reduce((a, o) => a + o.price * o.remaining, 0));
    $('#mo-partial').textContent = int(orders.filter(o => o.status === 'partial').length);
    $('#mo-lat').textContent = st.ok ? `${ns(st.latency_ns.p50)} p50` : '—';
    $('#mo-cancelall').title = `Cancel every open order of ${trader}`;
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
  let rows = orders.filter(o =>
    (status === 'all' || o.status === status) && (sideF === 'all' || o.side === sideF) &&
    (!q || String(o.id).includes(q.replace(/^#?(ord-)?/, '')) || o.trader.toLowerCase().includes(q)));
  const cmp = { new: (a, b) => b.id - a.id, old: (a, b) => a.id - b.id, pricehi: (a, b) => b.price - a.price, pricelo: (a, b) => a.price - b.price, qty: (a, b) => b.qty - a.qty }[sort];
  return rows.sort(cmp);
}

function draw() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  page = Math.min(page, pages);
  const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $('#mo-rows').innerHTML = slice.length ? slice.map(o => {
    const live = o.status === 'open' || o.status === 'partial';
    const unfilled = o.qty - o.filled;
    const faded = o.status === 'cancelled' || o.status === 'replaced';
    return `<tr style="${faded ? 'color:var(--dim)' : ''}">
      <td><b class="${faded ? '' : 'accent'}" style="font-size:16px">#ORD-${o.id}</b><div style="font-size:12.5px">SEQ: ${o.seq}${o.trader ? ` · ${esc(o.trader)}` : ''}</div></td>
      <td style="font-weight:600">TCX/INR</td><td>${sideTag(o.side)}</td>
      <td class="r num">₹${px(o.price)}</td><td class="r num">${int(o.qty)}</td><td class="r num">${int(o.filled)}</td>
      <td class="r num ${live ? 'accent' : ''}">${int(live ? o.remaining : (o.status === 'filled' ? 0 : unfilled))}</td>
      <td style="padding-left:24px">${statusTag(o.status)}${o.replaced_by ? `<div class="dim" style="font-size:12px;margin-top:4px">→ #${o.replaced_by}</div>` : ''}</td>
      <td class="num">${clock(o.time_ms)} IST</td></tr>`;
  }).join('') : `<tr><td colspan="9" class="empty">No orders match. ${scope === 'mine' ? `Orders placed as <b>${esc(settings.get('trader'))}</b> appear here; switch “Trader” to All to see scenario orders.` : ''}</td></tr>`;
  const from = rows.length ? (page - 1) * PER_PAGE + 1 : 0;
  $('#mo-showing').innerHTML = `Showing <b>${from}-${Math.min(page * PER_PAGE, rows.length)}</b> of <b>${rows.length}</b> orders`;
  const nums = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  $('#mo-pages').innerHTML = `<button data-p="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>
    ${nums.map(p => `<button data-p="${p}" class="${p === page ? 'on' : ''}">${p}</button>`).join('')}
    <button data-p="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
}

function exportCsv() {
  const rows = filtered();
  const head = 'id,seq,trader,side,price,qty,filled,remaining,status,time,replaces,replaced_by';
  const body = rows.map(o => [o.id, o.seq, `"${o.trader.replace(/"/g, '""')}"`, o.side, o.price.toFixed(2), o.qty, o.filled,
    o.remaining, o.status, new Date(o.time_ms).toISOString(), o.replaces, o.replaced_by].join(','));
  const blob = new Blob([[head, ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tradecore-orders-${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${rows.length} orders`, 'ok');
}

async function cancelAll() {
  const trader = settings.get('trader');
  const n = orders.filter(o => (o.status === 'open' || o.status === 'partial') && o.trader === trader).length;
  if (!n) return toast(`No open orders for ${esc(trader)}`);
  const ok = await modal({ title: 'Cancel all open orders?', body: `This cancels <b>${n}</b> open order(s) placed as <b>${esc(trader)}</b>. Each cancel is a separate engine command.`, okText: 'Cancel All', danger: true });
  if (!ok) return;
  const r = await post('/api/orders/cancel-all', { trader });
  toast(r.ok ? `Cancelled ${r.cancelled} order(s)` : esc(r.message), r.ok ? 'ok' : 'err');
}
