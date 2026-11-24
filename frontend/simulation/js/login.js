// Sign-in / create-account screen. Accounts are checked by the C engine
// (POST /api/auth/login and /api/auth/register).
import { get, post } from './api.js';
import { session } from './store.js';
import { $, esc, inr, pct, onResize } from './ui.js';
import { icon } from './icons.js';
import { areaChart } from './charts.js';

let timer = null, stopResize = null, prices = [];

export function renderLogin(root, onDone) {
  let mode = 'login';
  root.innerHTML = `
  <div class="login">
    <section class="login-hero">
      <a class="brand" style="padding:0 0 40px"><img src="img/logo.svg" alt=""><span>TradeCore</span></a>
      <h1>A real order-matching engine, written in C.</h1>
      <p class="muted">Trade against live bot traders, then watch the AVL trees, FIFO queues and hash table that execute every order.</p>
      <div class="login-live card">
        <div class="stat-row"><div><div class="label muted">TCX / INR · live market</div>
          <div class="title-row" style="margin-top:6px"><span class="num" style="font-size:30px;font-weight:700" id="lg-px">—</span><span class="chg" id="lg-chg"></span></div></div>
          <div class="live"><span class="dot pulse"></span>Bots trading</div></div>
        <div class="chart" id="lg-chart" style="margin-top:10px"></div>
        <div class="stat-row" style="font-size:13px;margin-top:6px"><span id="lg-trades">—</span><span id="lg-spread">—</span></div>
      </div>
      <ul class="login-points">
        <li>${icon('chart-candlestick', 18)}<span><b>Trade</b> — place limit orders and get filled by 12 simulated traders</span></li>
        <li>${icon('workflow', 18)}<span><b>See inside</b> — every rotation, enqueue and hash lookup, step by step</span></li>
        <li>${icon('flask-conical', 18)}<span><b>Experiment</b> — trigger a flash crash or a bull run and watch the book react</span></li>
      </ul>
    </section>

    <section class="login-panel">
      <form class="card login-card" id="lg-form" autocomplete="on" novalidate>
        <div class="seg login-tabs" id="lg-tabs"><button type="button" class="on" data-m="login">Sign in</button><button type="button" data-m="register">Create account</button></div>
        <h2 id="lg-title">Welcome back</h2>
        <p class="muted" id="lg-sub" style="margin-top:-6px">Sign in to your trading account.</p>
        <label class="field"><span>Username</span><div class="input">${icon('user', 17)}<input id="lg-user" name="username" autocomplete="username" maxlength="15" placeholder="e.g. aaryaman" required></div></label>
        <label class="field"><span>Password</span><div class="input">${icon('shield-check', 17)}<input id="lg-pass" name="password" type="password" autocomplete="current-password" maxlength="64" placeholder="At least 6 characters" required>
          <button type="button" class="iconbtn" id="lg-eye" title="Show password" style="padding:2px">${icon('eye', 16)}</button></div></label>
        <label class="field hidden" id="lg-confirm-wrap"><span>Confirm password</span><div class="input">${icon('shield-check', 17)}<input id="lg-pass2" type="password" autocomplete="new-password" maxlength="64"></div></label>
        <div class="login-error hidden" id="lg-err"></div>
        <button class="btn primary lg block" type="submit" id="lg-submit">Sign in</button>
        <div class="login-or"><span>or</span></div>
        <button class="btn ghost lg block" type="button" id="lg-demo">${icon('play', 16)} Explore with the demo account</button>
        <p class="dim" style="font-size:12.5px;margin:14px 0 0;line-height:1.5">Demo login: <b>demo</b> / <b>demo1234</b>. Accounts live in the running engine's memory
          (passwords are stored as salted SHA-256 hashes) and reset when the engine restarts.</p>
      </form>
    </section>
  </div>`;

  const setMode = m => {
    mode = m;
    $('#lg-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    $('#lg-title').textContent = m === 'login' ? 'Welcome back' : 'Create your account';
    $('#lg-sub').textContent = m === 'login' ? 'Sign in to your trading account.' : 'Pick a username — it appears on your orders and trades.';
    $('#lg-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#lg-confirm-wrap').classList.toggle('hidden', m === 'login');
    $('#lg-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    showError('');
  };
  const showError = msg => { const e = $('#lg-err'); e.textContent = msg; e.classList.toggle('hidden', !msg); };

  $('#lg-tabs').onclick = e => { const b = e.target.closest('[data-m]'); if (b) setMode(b.dataset.m); };
  $('#lg-eye').onclick = () => {
    const p = $('#lg-pass'), show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#lg-pass2').type = p.type;
  };

  const submit = async (username, password) => {
    const btn = $('#lg-submit');
    btn.disabled = true;
    showError('');
    try {
      const r = await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { username, password });
      if (!r.ok) { showError(r.message || 'Something went wrong'); return; }
      session.set(r.token, r.user);
      clearInterval(timer); stopResize?.();
      onDone(r.user);
    } catch (e) {
      showError(e.message);
    } finally { btn.disabled = false; }
  };

  $('#lg-form').onsubmit = e => {
    e.preventDefault();
    const u = $('#lg-user').value.trim(), p = $('#lg-pass').value;
    if (!u || !p) return showError('Enter a username and password.');
    if (mode === 'register') {
      if (!/^[A-Za-z0-9_.-]{3,15}$/.test(u)) return showError('Username must be 3-15 characters: letters, numbers, _ - .');
      if (p.length < 6) return showError('Password must be at least 6 characters.');
      if (p !== $('#lg-pass2').value) return showError('The two passwords do not match.');
    }
    submit(u, p);
  };
  $('#lg-demo').onclick = () => { setMode('login'); $('#lg-user').value = 'demo'; $('#lg-pass').value = 'demo1234'; submit('demo', 'demo1234'); };

  // live market preview: proof the engine is running
  const tick = async () => {
    try {
      const [s, t] = await Promise.all([get('/api/summary'), get('/api/trades?limit=80')]);
      if (!$('#lg-px')) return;
      $('#lg-px').textContent = inr(s.last);
      const ch = s.first_price && s.last ? (s.last - s.first_price) / s.first_price * 100 : null;
      $('#lg-chg').textContent = ch == null ? '' : pct(ch);
      $('#lg-chg').className = 'chg' + (ch >= 0 ? ' up' : '');
      $('#lg-trades').textContent = `${(s.total_trades || 0).toLocaleString('en-US')} trades so far`;
      $('#lg-spread').textContent = s.spread != null ? `Spread ₹${s.spread.toFixed(2)}` : '';
      prices = (t.trades || []).slice().reverse().map(x => x.price);
      areaChart($('#lg-chart'), prices, { height: 120, grid: 0, empty: 'Waiting for trades…' });
    } catch {
      if ($('#lg-px')) { $('#lg-px').textContent = 'Engine offline'; $('#lg-trades').textContent = 'Start it with: make run'; }
    }
  };
  tick();
  timer = setInterval(tick, 2000);
  stopResize = onResize($('#lg-chart'), () => areaChart($('#lg-chart'), prices, { height: 120, grid: 0, empty: 'Waiting for trades…' }));
  $('#lg-user').focus();
}
