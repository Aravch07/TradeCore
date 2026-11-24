// App shell: sign-in gate, sidebar sections with tabs, top bar, router,
// help hints and live refresh.
import { icon } from './icons.js';
import { get, post, connectStream, isMine } from './api.js';
import { settings, bus, shared, applySettings, session } from './store.js';
import { $, $$, esc, inr, pct, toast, clock, beep } from './ui.js';
import { renderLogin } from './login.js';

// Four sections in the sidebar; each groups a few pages as tabs.
export const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', tabs: [
    { id: 'overview', label: 'Overview', hint: 'A live snapshot of the TCX market. Bots trade around the clock, so prices, depth and trades update by themselves.' },
    { id: 'orderbook', label: 'Order Book', hint: 'Every resting order, grouped by price. Click “N orders” on a level to open its first-in-first-out queue.' },
    { id: 'charts', label: 'Charts', hint: 'Price, candlesticks and volume built from every trade the engine has executed. Try the EMA and RSI buttons.' },
  ] },
  { id: 'trade', label: 'Trading Terminal', icon: 'chart-candlestick', tabs: [
    { id: 'terminal', label: 'Terminal', hint: 'Place limit orders against the live bots. Buy at or above the best ask (or sell at or below the best bid) to trade immediately.' },
    { id: 'orders', label: 'My Orders', hint: 'Everything you have ordered, with fills and status. You can cancel all your open orders at once.' },
    { id: 'history', label: 'Trade History', hint: 'Every execution in the market. Switch on “Only my trades” to see your own fills.' },
  ] },
  { id: 'dsa', label: 'DSA Visualizer', icon: 'workflow', tabs: [
    { id: 'dsa', label: 'Visualizer', hint: 'Place an order here and watch the engine search the AVL tree, update the FIFO queue and hash table — one step at a time.' },
    { id: 'performance', label: 'Performance', hint: 'Real measurements from the C engine: latency per command, tree rotations, hash probes and memory.' },
  ] },
  { id: 'lab', label: 'Demo Lab', icon: 'flask-conical', tabs: [
    { id: 'market', label: 'Live Market', hint: 'Control the bot traders: pause them, speed them up, or switch the market into a bull run, a bear market or a flash crash.' },
    { id: 'scenarios', label: 'Scenarios', hint: 'Replay prepared order sequences step by step, like the worked example from the project proposal.' },
  ] },
];
const SETTINGS = { id: 'settings', label: 'Settings', hint: '' };

// old single-page routes still work (links, bookmarks)
const ALIASES = { overview: 'dashboard/overview', orderbook: 'dashboard/orderbook', charts: 'dashboard/charts',
  terminal: 'trade/terminal', orders: 'trade/orders', history: 'trade/history', performance: 'dsa/performance',
  scenarios: 'lab/scenarios', market: 'lab/market' };

let current = null;          // { page, mod }
let refreshTimer = null, lastRefresh = 0;
let started = false;

// ------------------------------------------------------------------ shell
function renderShell() {
  $('#root').innerHTML = `
  <div class="app">
    <aside class="sidebar">
      <a class="brand" href="#/dashboard/overview"><img src="img/logo.svg" alt=""><span>TradeCore</span></a>
      <nav class="nav" id="nav">${SECTIONS.map(s => `<a href="#/${s.id}/${s.tabs[0].id}" data-id="${s.id}">${icon(s.icon, 20)}<span>${s.label}</span></a>`).join('')}</nav>
      <div class="side-card" id="side-sim"></div>
      <div class="sidebar-foot">Academic simulation · fictitious stock TCX<br>Engine: hand-written C</div>
    </aside>
    <div class="main">
      <header class="topbar" id="topbar"></header>
      <div class="tabbar" id="tabbar"></div>
      <div id="hint"></div>
      <main id="view"></main>
    </div>
  </div>`;
  renderTopbar();
}

function renderTopbar() {
  const u = session.user;
  $('#topbar').innerHTML = `
    <div class="ticker"><b>TCX/INR</b><span class="px num" id="tb-px">—</span><span class="chg" id="tb-chg">—</span></div>
    <div class="live"><span class="dot pulse" id="tb-dot"></span><span id="tb-live">Connecting…</span></div>
    <div class="simtime">${icon('clock', 16)}<span id="tb-time">--:--:-- IST</span></div>
    <div class="spacer"></div>
    <button class="iconbtn" id="tb-help" title="Show tips for this page">${icon('info', 20)}</button>
    <button class="iconbtn" id="tb-bell" title="Notifications">${icon('bell', 20)}<span class="badge hidden" id="tb-badge"></span></button>
    <button class="account" id="tb-user" title="Account">
      <span class="avatar">${esc((u?.username || '?')[0].toUpperCase())}</span>
      <span class="who"><b>${esc(u?.username || '')}</b><small>${u?.demo ? 'Demo account' : 'Trader'}</small></span>${icon('chevron-down', 15)}
    </button>
    <div class="notif-panel hidden" id="tb-notif"></div>
    <div class="menu hidden" id="tb-menu">
      <div class="menu-head"><span class="avatar">${esc((u?.username || '?')[0].toUpperCase())}</span><div><b>${esc(u?.username || '')}</b><small>${u?.demo ? 'Shared demo account' : 'Your account'}</small></div></div>
      <a href="#/trade/orders">${icon('notebook-text', 16)} My orders</a>
      <a href="#/settings">${icon('settings', 16)} Settings</a>
      <button id="tb-tips">${icon('info', 16)} Show all tips again</button>
      <button id="tb-logout" class="sell">${icon('log-out', 16)} Sign out</button>
    </div>`;
  $('#tb-bell').onclick = e => { e.stopPropagation(); $('#tb-menu').classList.add('hidden'); toggleNotifications(); };
  $('#tb-user').onclick = e => { e.stopPropagation(); $('#tb-notif').classList.add('hidden'); $('#tb-menu').classList.toggle('hidden'); };
  $('#tb-help').onclick = () => { hintsDismissed().delete(current?.page.id); saveHints(); renderHint(true); };
  $('#tb-tips').onclick = () => { localStorage.removeItem(HINT_KEY); hints = null; renderHint(true); $('#tb-menu').classList.add('hidden'); toast('Tips will show again on every page', 'ok'); };
  $('#tb-logout').onclick = logout;
  document.addEventListener('click', e => {
    if (!e.target.closest('#tb-notif') && !e.target.closest('#tb-bell')) $('#tb-notif')?.classList.add('hidden');
    if (!e.target.closest('#tb-menu') && !e.target.closest('#tb-user')) $('#tb-menu')?.classList.add('hidden');
  });
}

function toggleNotifications() {
  const p = $('#tb-notif');
  p.classList.toggle('hidden');
  $('#tb-badge').classList.add('hidden');
  p.innerHTML = shared.notifications.length
    ? shared.notifications.slice(0, 40).map(n => `<div class="n">${n.html}<small>${clock(n.t)}</small></div>`).join('')
    : '<div class="n muted">No notifications yet. When the bots trade with your orders, you will see it here.</div>';
}

function notify(html, kind) {
  shared.notifications.unshift({ html, t: Date.now() });
  if (shared.notifications.length > 100) shared.notifications.pop();
  $('#tb-badge')?.classList.remove('hidden');
  toast(html, kind);
}

async function refreshTopbar() {
  const s = await get('/api/summary').catch(() => null);
  if (!s?.ok || !$('#tb-px')) return;
  shared.summary = s;
  const last = s.last ?? (s.best_bid && s.best_ask ? (s.best_bid + s.best_ask) / 2 : null);
  const el = $('#tb-px'), prev = el.dataset.v;
  el.textContent = inr(last);
  if (prev && last != null && +prev !== last) {
    el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth;
    el.classList.add(last > +prev ? 'flash-up' : 'flash-down');
  }
  el.dataset.v = last ?? '';
  const ch = s.first_price && s.last ? ((s.last - s.first_price) / s.first_price) * 100 : null;
  const chg = $('#tb-chg');
  chg.textContent = ch == null ? '0.00%' : pct(ch);
  chg.className = 'chg' + (ch != null && ch >= 0 ? ' up' : '');
}

async function refreshSideSim(sim) {
  const el = $('#side-sim');
  if (!el) return;
  if (!sim) { const r = await get('/api/sim').catch(() => null); sim = r?.sim; }
  if (!sim) return;
  el.innerHTML = `<a href="#/lab/market" class="side-sim">
    <span class="dot ${sim.running ? 'pulse' : 'off'}"></span>
    <span><b>${sim.running ? 'Bots trading' : 'Bots paused'}</b><small>${sim.running ? `${sim.mode[0].toUpperCase() + sim.mode.slice(1)} market · ${Math.round(sim.rate)} orders/s` : 'Open Demo Lab to resume'}</small></span></a>`;
}

function setConnection(v) {
  $('#tb-dot')?.classList.toggle('off', !v);
  if ($('#tb-live')) $('#tb-live').textContent = v ? 'Market Live' : 'Engine offline';
  if (settings.get('connToasts')) toast(v ? 'Live stream connected' : 'Live stream disconnected — retrying', v ? 'ok' : 'err');
}

function tickClock() {
  const el = $('#tb-time');
  if (el) el.textContent = `${clock(Date.now())} IST`;
}

// ------------------------------------------------------------------ hints
const HINT_KEY = 'tradecore.hints.v1';
let hints = null;
function hintsDismissed() {
  if (!hints) { try { hints = new Set(JSON.parse(localStorage.getItem(HINT_KEY) || '[]')); } catch { hints = new Set(); } }
  return hints;
}
function saveHints() { try { localStorage.setItem(HINT_KEY, JSON.stringify([...hintsDismissed()])); } catch { /* ignore */ } }

function renderHint(force = false) {
  const el = $('#hint');
  const page = current?.page;
  if (!el || !page?.hint || (!force && hintsDismissed().has(page.id))) { if (el) el.innerHTML = ''; return; }
  el.innerHTML = `<div class="hint">${icon('info', 18)}<span>${page.hint}</span><button class="btn sm ghost" id="hint-ok">Got it</button></div>`;
  $('#hint-ok').onclick = () => { hintsDismissed().add(page.id); saveHints(); el.innerHTML = ''; };
}

// ------------------------------------------------------------------ router
function parseRoute() {
  let r = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (ALIASES[r]) r = ALIASES[r];
  if (r === 'settings') return { section: null, page: SETTINGS };
  const [sid, tid] = r.split('/');
  const section = SECTIONS.find(s => s.id === sid) || SECTIONS[0];
  const page = section.tabs.find(t => t.id === tid) || section.tabs[0];
  return { section, page };
}

async function route() {
  if (!started) return;
  const { section, page } = parseRoute();
  if (current?.mod?.unmount) current.mod.unmount();
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.id === section?.id));
  $('#tabbar').innerHTML = section
    ? `<div class="tabs">${section.tabs.map(t => `<a href="#/${section.id}/${t.id}" class="${t.id === page.id ? 'on' : ''}">${t.label}</a>`).join('')}</div>`
    : '';
  const mod = (await import(`./pages/${page.id}.js`)).default;
  current = { page, mod };
  document.title = `${page.label} · TradeCore`;
  renderHint();
  const view = $('#view');
  view.innerHTML = mod.html();
  window.scrollTo(0, 0);
  try { await mod.mount?.(view); await mod.refresh?.('mount'); }
  catch (e) { console.error(e); toast(esc(e.message), 'err'); }
}

/* Refresh the visible page when the market changes: at most every 700 ms,
 * so a busy market (bots trading several times a second) stays smooth. */
function scheduleRefresh(reason) {
  if (refreshTimer) return;
  const wait = Math.max(120, 700 - (Date.now() - lastRefresh));
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    lastRefresh = Date.now();
    refreshTopbar();
    try { await current?.mod?.refresh?.(reason); } catch (e) { console.error(e); }
  }, wait);
}

// ------------------------------------------------------------- sign in/out
async function logout() {
  await post('/api/auth/logout').catch(() => {});
  session.clear();
  location.hash = '';
  location.reload();
}

function startApp() {
  started = true;
  renderShell();
  window.addEventListener('hashchange', route);
  if (!location.hash || location.hash === '#/') history.replaceState(null, '', '#/dashboard/overview');
  route();
  refreshTopbar();
  refreshSideSim();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { if (!shared.connected) scheduleRefresh('poll'); }, 4000);

  bus.on('connection', setConnection);
  bus.on('reset', () => scheduleRefresh('reset'));
  bus.on('sim', sim => refreshSideSim(sim));
  bus.on('unauthorized', () => { toast('Your session expired — please sign in again', 'err'); setTimeout(logout, 1200); });
  bus.on('command', cmd => {
    scheduleRefresh('command');
    if (!cmd.ok || !cmd.fills?.length) return;
    const myFills = cmd.fills.filter(f => isMine(f.maker_owner) || isMine(f.taker_owner));
    if (!myFills.length) return;
    beep(cmd.order?.side === 'buy' ? 740 : 520);
    const q = myFills.reduce((a, f) => a + f.qty, 0);
    const f = myFills[0];
    const mine = isMine(f.taker_owner) ? f.taker_side : (f.taker_side === 'buy' ? 'sell' : 'buy');
    const other = isMine(f.taker_owner) ? f.maker_trader : f.taker_trader;
    notify(`<b>You ${mine === 'buy' ? 'bought' : 'sold'} ${q} TCX</b> at ${inr(f.price)}${other ? ` — matched with ${esc(other)}` : ''}`, 'ok');
  });
  connectStream();
}

async function boot() {
  applySettings();
  if (session.token) {
    const me = await get('/api/auth/me').catch(() => null);
    if (me?.ok) { session.set(session.token, me.user); return startApp(); }
    session.clear();
  }
  renderLogin($('#root'), user => {
    toast(`Welcome, <b>${esc(user.username)}</b>!`, 'ok');
    startApp();
  });
}

boot();
