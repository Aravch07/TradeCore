// App shell: sidebar navigation, top bar, router and live refresh.
import { icon } from './icons.js';
import { get, connectStream } from './api.js';
import { settings, bus, shared, applySettings } from './store.js';
import { $, esc, inr, pct, toast, clock, beep } from './ui.js';

const PAGES = [
  { id: 'overview',    label: 'Overview',              icon: 'layout-dashboard' },
  { id: 'terminal',    label: 'Trading Terminal',      icon: 'chart-candlestick' },
  { id: 'orderbook',   label: 'Live Order Book',       icon: 'table-properties' },
  { id: 'charts',      label: 'Market Charts',         icon: 'trending-up' },
  { id: 'dsa',         label: 'DSA Visualizer',        icon: 'workflow' },
  { id: 'orders',      label: 'My Orders',             icon: 'notebook-text' },
  { id: 'history',     label: 'Trade History',         icon: 'history' },
  { id: 'performance', label: 'Performance Analytics', icon: 'chart-column' },
  { id: 'scenarios',   label: 'Scenarios',             icon: 'flask-conical' },
  { id: 'settings',    label: 'Settings',              icon: 'settings' },
];

let current = null;      // { id, mod }
let refreshTimer = null;
let unreadNotif = false;

// ---------------------------------------------------------------- sidebar
function renderNav() {
  $('#nav').innerHTML = PAGES.map(p =>
    `<a href="#/${p.id}" data-id="${p.id}">${icon(p.icon, 19)}<span>${p.label}</span></a>`).join('');
}

// ----------------------------------------------------------------- top bar
function renderTopbar() {
  $('#topbar').innerHTML = `
    <div class="ticker"><b>TCX/INR</b><span class="px num" id="tb-px">—</span><span class="chg" id="tb-chg">—</span></div>
    <div class="live"><span class="dot pulse" id="tb-dot"></span><span id="tb-live">Connecting…</span></div>
    <div class="simtime">${icon('clock', 16)}<span id="tb-time">SIM TIME: --:--:-- IST</span></div>
    <div class="spacer"></div>
    <button class="iconbtn" id="tb-bell" title="Notifications">${icon('bell', 20)}<span class="badge hidden" id="tb-badge"></span></button>
    <button class="avatar" id="tb-user" title="Trader settings">${icon('user', 18)}</button>
    <div class="notif-panel hidden" id="tb-notif"></div>`;
  $('#tb-bell').onclick = toggleNotifications;
  $('#tb-user').onclick = () => { location.hash = '#/settings'; };
  document.addEventListener('click', e => {
    if (!e.target.closest('#tb-notif') && !e.target.closest('#tb-bell')) $('#tb-notif')?.classList.add('hidden');
  });
}

function toggleNotifications() {
  const p = $('#tb-notif');
  p.classList.toggle('hidden');
  unreadNotif = false;
  $('#tb-badge').classList.add('hidden');
  p.innerHTML = shared.notifications.length
    ? shared.notifications.slice(0, 40).map(n => `<div class="n">${n.html}<small>${clock(n.t)}</small></div>`).join('')
    : '<div class="n muted">No notifications yet. Fills and rejections of your orders appear here.</div>';
}

function notify(html, kind) {
  shared.notifications.unshift({ html, t: Date.now() });
  if (shared.notifications.length > 100) shared.notifications.pop();
  unreadNotif = true;
  $('#tb-badge')?.classList.remove('hidden');
  toast(html, kind);
}

async function refreshTopbar() {
  try {
    const s = await get('/api/summary');
    if (!s.ok) return;
    shared.summary = s;
    const last = s.last ?? (s.best_bid && s.best_ask ? (s.best_bid + s.best_ask) / 2 : null);
    const prev = $('#tb-px').dataset.v;
    $('#tb-px').textContent = inr(last);
    if (prev && last != null && +prev !== last) {
      const el = $('#tb-px');
      el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth;
      el.classList.add(last > +prev ? 'flash-up' : 'flash-down');
    }
    $('#tb-px').dataset.v = last ?? '';
    const ch = s.first_price && s.last ? ((s.last - s.first_price) / s.first_price) * 100 : null;
    const chg = $('#tb-chg');
    chg.textContent = ch == null ? '0.00%' : pct(ch);
    chg.className = 'chg' + (ch != null && ch >= 0 ? ' up' : '');
    bus.emit('summary', s);
  } catch { /* shown via connection state */ }
}

function setConnection(v) {
  $('#tb-dot').classList.toggle('off', !v);
  $('#tb-live').textContent = v ? 'Market Live' : 'Engine offline';
  if (settings.get('connToasts')) toast(v ? 'Live stream connected' : 'Live stream disconnected — retrying', v ? 'ok' : 'err');
}

function tickClock() {
  const el = $('#tb-time');
  if (el) el.textContent = `SIM TIME: ${clock(Date.now())} IST`;
}

// ------------------------------------------------------------------ router
async function route() {
  const id = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const page = PAGES.find(p => p.id === id) || PAGES[0];
  if (current?.mod?.unmount) current.mod.unmount();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.id === page.id));
  const view = $('#view');
  const mod = (await import(`./pages/${page.id}.js`)).default;
  current = { id: page.id, mod };
  document.title = `${page.label} · TradeCore`;
  view.innerHTML = mod.html();
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  try { await mod.mount?.(view); await mod.refresh?.('mount'); }
  catch (e) { console.error(e); toast(esc(e.message), 'err'); }
}

function scheduleRefresh(reason) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    refreshTopbar();
    try { await current?.mod?.refresh?.(reason); } catch (e) { console.error(e); }
  }, 120);
}

// ------------------------------------------------------------------- start
function start() {
  applySettings();
  renderNav();
  renderTopbar();
  window.addEventListener('hashchange', route);
  route();
  refreshTopbar();
  tickClock();
  setInterval(tickClock, 1000);
  // fallback polling when the stream is down
  setInterval(() => { if (!shared.connected) scheduleRefresh('poll'); }, 4000);

  bus.on('connection', setConnection);
  bus.on('reset', () => scheduleRefresh('reset'));
  bus.on('command', cmd => {
    scheduleRefresh('command');
    const me = settings.get('trader');
    const mine = cmd.order?.trader === me || cmd.replaced?.trader === me;
    if (cmd.ok && cmd.fills?.length) {
      beep(cmd.order?.side === 'buy' ? 740 : 520);
      const myFills = cmd.fills.filter(f => f.maker_trader === me || f.taker_trader === me);
      if (myFills.length) {
        const q = myFills.reduce((a, f) => a + f.qty, 0);
        notify(`<b>Filled ${q} TCX</b> at ${inr(myFills[0].price)}${myFills.length > 1 ? ` (+${myFills.length - 1} more fills)` : ''}`, 'ok');
      }
    }
    if (!cmd.ok && mine) notify(`<b>Rejected:</b> ${esc(cmd.message)}`, 'err');
  });
  bus.on('settings', s => { if (current?.id === 'settings') return; scheduleRefresh('settings'); });
  connectStream();
}

start();
