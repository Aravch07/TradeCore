// Market Charts: price line (EMA / RSI), OHLCV candles, volume, trade tape.
import { get } from '../api.js';
import { $, inr, px, int, pct, clock, onResize } from '../ui.js';
import { icon } from '../icons.js';
import { areaChart, candleChart, barChart, ema, rsi } from '../charts.js';
import { priceSeries, RANGES, wireSeg } from './common.js';

let range = '1H', showEma = false, showRsi = false, series = null, candles = [], stops = [];

export default {
  html: () => `
  <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap">
    <div>
      <div class="title-row"><h1 style="margin:0;font-size:36px;letter-spacing:-.02em">TCX / INR</h1><span class="tag accent up" id="mc-hi">Session high: —</span></div>
      <div style="font-size:14px;margin-top:4px">TradeCore Simulated Exchange • Real-Time Feed</div>
    </div>
    <div class="seg" id="mc-range">${Object.keys(RANGES).map(k => `<button data-v="${k}" class="${k === '1H' ? 'on' : ''}" style="padding:6px 16px">${k}</button>`).join('')}</div>
  </div>

  <div class="grid mt" style="grid-template-columns:minmax(0,2.95fr) minmax(0,1fr)">
    <div class="grid" style="align-content:start">
      <div class="card" id="mc-main">
        <div class="card-head" style="align-items:flex-start">
          <div><div class="label">Price movement (line)</div>
            <div class="title-row" style="margin-top:6px"><span style="font-size:26px;font-weight:700" class="num" id="mc-last">—</span><span class="sell num" id="mc-chg"></span><span class="tag hidden" id="mc-rsi"></span></div></div>
          <div class="title-row">
            <button class="btn sm ghost" id="mc-ema">EMA(20)</button><button class="btn sm ghost" id="mc-rsibtn">RSI</button>
            <button class="btn sm ghost" id="mc-full" title="Fullscreen">${icon('maximize', 15)}</button></div>
        </div>
        <div class="chart" id="mc-chart"></div>
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="stat-row"><div><div class="label">OHLCV candlestick summary</div>
            <div style="font-size:13.5px;margin-top:4px" id="mc-ohlc">—</div></div><span>${icon('chart-candlestick', 22)}</span></div>
          <div class="chart-frame" style="margin-top:14px;padding:6px"><div class="chart" id="mc-candles"></div></div>
        </div>
        <div class="card">
          <div class="stat-row"><div><div class="label">Trading volume</div>
            <div style="font-size:26px;font-weight:700;margin-top:4px" class="num" id="mc-vol">—</div></div><span>${icon('chart-no-axes-column', 22)}</span></div>
          <div class="chart-frame" style="margin-top:14px;padding:6px"><div class="chart" id="mc-volume"></div></div>
        </div>
      </div>
    </div>
    <div class="card" style="display:flex;flex-direction:column">
      <div class="stat-row"><h3>Historical Trades</h3><span class="dot ${''}" style="background:var(--sell)"></span></div>
      <div class="sub" style="margin:10px 0 16px;font-size:13.5px">Real-time order execution stream for TCX asset.</div>
      <div id="mc-tape" style="display:flex;flex-direction:column;gap:10px;flex:1"></div>
      <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:12px;font-size:13.5px">
        <div class="kv" style="border:0"><span>Spread</span><b class="num" id="mc-spread">—</b></div>
        <div class="kv" style="border:0"><span>VWAP</span><b class="sell num" id="mc-vwap">—</b></div>
      </div>
    </div>
  </div>`,

  mount(root) {
    wireSeg(root, '#mc-range', v => { range = v; this.refresh(); });
    $('#mc-ema').onclick = () => { showEma = !showEma; $('#mc-ema').classList.toggle('primary', showEma); paint(); };
    $('#mc-rsibtn').onclick = () => { showRsi = !showRsi; $('#mc-rsibtn').classList.toggle('primary', showRsi); paint(); };
    $('#mc-full').onclick = () => { const c = $('#mc-main'); document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen?.(); };
    stops = ['#mc-chart', '#mc-candles', '#mc-volume'].map(s => onResize($(s), paint));
  },

  unmount() { stops.forEach(f => f()); },

  async refresh() {
    const span = RANGES[range];
    const since = span ? Date.now() - span : 0;
    const [s, ser, tape] = await Promise.all([get(`/api/summary?since_ms=${since}`), priceSeries(range, 120), get('/api/trades?limit=8')]);
    series = ser;
    // pick a candle interval that gives ~12-40 candles for the visible range
    const t0 = ser.trades[0]?.time_ms ?? Date.now();
    const visible = span || Math.max(60e3, Date.now() - t0);
    const steps = [60e3, 300e3, 900e3, 3600e3, 4 * 3600e3, 86400e3, 7 * 86400e3];
    const interval = steps.find(x => visible / x <= 40) || steps[steps.length - 1];
    const c = await get(`/api/candles?interval_ms=${interval}&limit=2000`);
    candles = (c.candles || []).filter(k => k.start_ms + interval > since).slice(-40);

    $('#mc-hi').textContent = `Session high: ${s.high != null ? inr(s.high) : '—'}`;
    $('#mc-last').textContent = inr(s.last);
    const ch = s.open && s.last ? s.last - s.open : null;
    $('#mc-chg').textContent = ch == null ? '' : `${pct(ch / s.open * 100)} (${ch >= 0 ? '+' : '-'}₹${px(Math.abs(ch))})`;
    $('#mc-ohlc').innerHTML = s.open != null
      ? `O: <span class="accent">${px(s.open)}</span> H: <span class="sell">${px(s.high)}</span> L: <span class="sell">${px(s.low)}</span> C: <span class="accent">${px(s.last)}</span>`
      : 'No trades in range';
    $('#mc-vol').textContent = `${int(s.volume)} TCX`;
    $('#mc-spread').textContent = s.spread != null ? `₹${px(s.spread)}` : '—';
    $('#mc-vwap').textContent = inr(s.vwap);
    $('#mc-tape').innerHTML = (tape.trades || []).map(t => `
      <div style="background:var(--bg);border-radius:6px;padding:12px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span class="sell num" style="font-size:15px">${px(t.price)}</span>
        <span class="num" style="text-align:right;font-size:15px">${t.qty}<br><span style="font-size:13px">TCX</span></span>
        <span class="num" style="font-size:13px">${clock(t.time_ms)}</span></div>`).join('') || '<div class="empty">No trades yet</div>';
    paint();
  },
};

function paint() {
  if (!series) return;
  const opts = { height: 280, labels: series.labels, xLabels: series.xLabels, grid: 0, empty: `No trades in the last ${range}` };
  if (showEma) opts.overlays = [{ values: ema(series.values, 20), color: 'var(--sell)', dash: true }];
  areaChart($('#mc-chart'), series.values, opts);
  const r = showRsi ? rsi(series.values) : null;
  const tag = $('#mc-rsi');
  tag.classList.toggle('hidden', !showRsi);
  tag.textContent = r == null ? 'RSI(14): need more trades' : `RSI(14): ${r.toFixed(1)}`;
  tag.className = 'tag ' + (r == null ? '' : r > 70 ? 'sell' : r < 30 ? 'buy' : 'accent') + (showRsi ? '' : ' hidden');
  candleChart($('#mc-candles'), candles, { height: 190 });
  barChart($('#mc-volume'), candles.map(k => k.volume), {
    height: 190, gap: 8,
    colors: i => candles[i].close >= candles[i].open ? 'rgba(244,180,169,0.7)' : 'rgba(63,118,134,0.75)',
    titles: candles.map(k => `${clock(k.start_ms)} · ${k.volume} TCX · ${k.trades} trades`),
  });
}
