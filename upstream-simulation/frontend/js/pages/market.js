// Demo Lab → Live Market: control the bot traders that keep the market busy.
import { get, post, isMine } from '../api.js';
import { bus, shared } from '../store.js';
import { $, esc, int, toast, modal } from '../ui.js';
import { icon } from '../icons.js';
import { pageHead, describeCommand, feedItem } from './common.js';

const MODE_UI = {
  calm: { icon: 'waves', title: 'Calm' },
  volatile: { icon: 'activity', title: 'Volatile' },
  bull: { icon: 'rocket', title: 'Bull run' },
  bear: { icon: 'trending-down', title: 'Bear market' },
  crash: { icon: 'zap', title: 'Flash crash' },
};
let sim = null, offs = [];

export default {
  html: () => `
  ${pageHead('Live Market Simulator', 'Twelve bot traders send real orders to the C engine so there is always something happening. Change how they behave and watch every page react.',
    '', 'DEMO LAB // MARKET SIMULATION')}

  <div class="card">
    <div class="stat-row" style="flex-wrap:wrap;gap:20px">
      <div class="bigswitch">
        <button class="btn lg" id="mk-toggle" style="min-width:170px"></button>
        <div><div style="font-size:20px;font-weight:700" id="mk-status">—</div><div class="muted" style="font-size:14px" id="mk-sub">—</div></div>
      </div>
      <div style="min-width:280px;flex:1;max-width:420px">
        <div class="stat-row" style="font-size:13.5px;margin-bottom:6px"><span class="label">Bot speed</span><b id="mk-ratev">—</b></div>
        <input type="range" min="1" max="20" step="1" id="mk-rate">
        <div class="stat-row dim" style="font-size:12px"><span>1 order/s · relaxed</span><span>20 orders/s · frantic</span></div>
      </div>
      <button class="btn ghost" id="mk-reseed">${icon('refresh-cw', 16)} Fresh market</button>
    </div>
  </div>

  <div class="card mt">
    <div class="card-head"><div><h3>Market mood</h3><div class="sub">Changes how the hidden fair price moves and how aggressively bots buy or sell.</div></div></div>
    <div class="modes" id="mk-modes"></div>
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head"><h3>Bot traders</h3><span class="tag">${icon('bot', 13)} 12 bots</span></div>
      <table class="table tight">
        <thead><tr><th>Trader</th><th>Style</th><th class="r">Orders</th><th class="r">Cancels</th><th class="r">Fills</th><th class="r">Volume</th></tr></thead>
        <tbody id="mk-bots"></tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head"><h3>Live activity</h3><span class="live"><span class="dot pulse"></span>streaming</span></div>
      <div class="feed" id="mk-feed"></div>
    </div>
  </div>

  <div class="card mt">
    <h3 style="margin-bottom:14px">Things to try</h3>
    <div class="quick" style="margin-top:0">
      <a href="#/dashboard/charts">${icon('zap', 20)}<span><b>Trigger a flash crash</b><small>Pick “Flash crash” above, then open Charts and watch the price fall for ~40 s and recover.</small></span></a>
      <a href="#/trade/terminal">${icon('chart-candlestick', 20)}<span><b>Trade against the bots</b><small>Post a buy just below the best ask — a bot will usually fill it within seconds.</small></span></a>
      <a href="#/dsa/dsa">${icon('workflow', 20)}<span><b>Slow everything down</b><small>Set speed to 1/s, open the DSA Visualizer and switch “Animate” to all activity.</small></span></a>
    </div>
  </div>`,

  mount() {
    $('#mk-toggle').onclick = () => set({ running: !sim?.running });
    $('#mk-rate').oninput = e => { $('#mk-ratev').textContent = `${e.target.value} orders / s`; };
    $('#mk-rate').onchange = e => set({ rate: +e.target.value });
    $('#mk-reseed').onclick = async () => {
      const ok = await modal({ title: 'Start a fresh market?', body: 'This clears the order book and every order and trade (including yours), then generates 3 new hours of bot history.', okText: 'Fresh market', danger: true });
      if (ok) { await set({ reseed: true }); toast('Fresh market generated', 'ok'); }
    };
    $('#mk-modes').onclick = e => { const b = e.target.closest('[data-mode]'); if (b) set({ mode: b.dataset.mode }); };
    drawFeed();
    offs = [
      bus.on('sim', s => { sim = s; draw(); }),
      bus.on('command', cmd => {
        const d = describeCommand(cmd, isMine);
        const el = $('#mk-feed');
        if (!d || !el) return;
        el.insertAdjacentHTML('afterbegin', feedItem(d, Date.now(), true));
        while (el.children.length > 11) el.lastElementChild.remove();
      }),
    ];
  },

  unmount() { offs.forEach(f => f()); },

  async refresh() {
    const r = await get('/api/sim');
    if (r.ok) { sim = r.sim; draw(); }
  },
};

async function set(patch) {
  const r = await post('/api/sim', patch);
  if (!r.ok) return toast(esc(r.message), 'err');
  sim = r.sim;
  draw();
  if (patch.mode) toast(`Market mood: <b>${MODE_UI[patch.mode].title}</b>`, 'ok');
}

function draw() {
  if (!sim || !$('#mk-toggle')) return;
  const t = $('#mk-toggle');
  t.className = `btn lg ${sim.running ? 'danger-ghost' : 'success'}`;
  t.innerHTML = sim.running ? `${icon('pause', 18)} Pause bots` : `${icon('play', 18)} Start bots`;
  $('#mk-status').innerHTML = sim.running ? `<span class="buy">●</span> Bots are trading` : `<span class="dim">●</span> Bots paused`;
  $('#mk-sub').textContent = sim.running
    ? `${MODE_UI[sim.mode]?.title || sim.mode} market · fair price ₹${sim.fair_price.toFixed(2)} · ${int(sim.steps)} bot actions so far`
    : 'The market is frozen — only your own orders change the book.';
  const rate = Math.round(sim.rate);
  if (document.activeElement !== $('#mk-rate')) $('#mk-rate').value = rate;
  $('#mk-ratev').textContent = `${rate} orders / s`;
  $('#mk-modes').innerHTML = sim.modes.map(m => `<button class="mode ${m.name === sim.mode ? 'on' : ''}" data-mode="${m.name}">
    <b><span class="${m.name === 'crash' || m.name === 'bear' ? 'sell' : m.name === 'bull' ? 'buy' : 'accent'}">${icon(MODE_UI[m.name].icon, 18)}</span>${MODE_UI[m.name].title}</b>
    <small>${esc(m.blurb)}</small></button>`).join('');
  $('#mk-bots').innerHTML = sim.bots.map(b => `<tr><td><b>${esc(b.name)}</b></td>
    <td><span class="tag ${b.kind === 'market maker' ? 'accent' : b.kind === 'retail' ? '' : b.kind === 'momentum' ? 'buy' : 'sell'}">${b.kind}</span></td>
    <td class="r num">${int(b.orders)}</td><td class="r num">${int(b.cancels)}</td><td class="r num">${int(b.fills)}</td><td class="r num">${int(b.volume)}</td></tr>`).join('');
}

function drawFeed() {
  const items = shared.commandLog.map(c => [describeCommand(c, isMine), c.order?.time_ms]).filter(x => x[0]).slice(0, 11);
  $('#mk-feed').innerHTML = items.length ? items.map(([d, t]) => feedItem(d, t || Date.now())).join('')
    : '<div class="empty">Waiting for the next bot order…</div>';
}
