import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createEngine } from '../frontend/js/wasm-runtime.js';
import { getPool } from './auth.mjs';
import { STOCKS, DEMO_USERS, INITIAL_CASH, EXCHANGE_ID } from './config.mjs';

const bytes = readFile(new URL('../frontend/wasm/engine.wasm', import.meta.url));
let cached;
const codeFor = id => `u${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
const stockFor = symbol => STOCKS.find(stock => stock.symbol === symbol);
export class ExchangeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function allocateAccount(user) {
  return { id: user.id, code: codeFor(user.id), name: user.name, cash: INITIAL_CASH, realized: 0,
    holdings: Object.fromEntries(STOCKS.map(stock => [stock.symbol, stock.allocation])),
    basis: Object.fromEntries(STOCKS.map(stock => [stock.symbol, stock.allocation * stock.base])) };
}
function systemAccount(code, name) {
  return { id: code, code, name, cash: 100000000000, realized: 0,
    holdings: Object.fromEntries(STOCKS.map(stock => [stock.symbol, 1000000])),
    basis: Object.fromEntries(STOCKS.map(stock => [stock.symbol, stock.base * 1000000])) };
}
async function makeContext(state) {
  const engines = {};
  const clocks = {};
  for (const stock of STOCKS) {
    clocks[stock.symbol] = { value: state.createdAt };
    engines[stock.symbol] = await createEngine(await bytes, { now: () => clocks[stock.symbol].value });
    for (const command of state.journals[stock.symbol]) {
      clocks[stock.symbol].value = command.time;
      engines[stock.symbol].request(command.method, command.path, JSON.stringify(command.body));
    }
  }
  return { state, engines, clocks };
}
async function contextFor(row) {
  if (cached?.version === row.version) return cached.context;
  const context = makeContext(row.state);
  cached = { version: row.version, context };
  return context;
}
function allOrders(ctx, symbol) {
  return ctx.engines[symbol].request('GET', '/api/orders?limit=5000').data.orders;
}
const active = order => order.status === 'open' || order.status === 'partial';
function reservations(ctx, code) {
  let cash = 0;
  const shares = Object.fromEntries(STOCKS.map(stock => [stock.symbol, 0]));
  for (const stock of STOCKS) for (const order of allOrders(ctx, stock.symbol)) {
    if (!active(order) || order.trader !== code) continue;
    if (order.side === 'buy') cash += Math.round(order.price * 100) * order.remaining;
    else shares[stock.symbol] += order.remaining;
  }
  return { cash, shares };
}
function settle(ctx, symbol, result) {
  for (const fill of result.fills || []) {
    const buyer = ctx.state.accounts[fill.taker_side === 'buy' ? fill.taker_trader : fill.maker_trader];
    const seller = ctx.state.accounts[fill.taker_side === 'sell' ? fill.taker_trader : fill.maker_trader];
    if (!buyer || !seller) throw new Error('An order has no matching trading account.');
    const value = Math.round(fill.price * 100) * fill.qty;
    const removedBasis = Math.round(seller.basis[symbol] * fill.qty / seller.holdings[symbol]);
    seller.holdings[symbol] -= fill.qty;
    seller.basis[symbol] -= removedBasis;
    seller.cash += value;
    seller.realized += value - removedBasis;
    buyer.cash -= value;
    buyer.holdings[symbol] += fill.qty;
    buyer.basis[symbol] += value;
  }
}
function execute(ctx, symbol, method, path, body, time = Date.now()) {
  ctx.clocks[symbol].value = time;
  const result = ctx.engines[symbol].request(method, path, JSON.stringify(body));
  if (!result.data.ok) throw new ExchangeError(result.data.message || result.data.error || 'The engine rejected this command.', result.status);
  settle(ctx, symbol, result.data);
  ctx.state.journals[symbol].push({ method, path, body, time });
  return result.data;
}
export async function createSeedState(users = []) {
  const state = { schema: 1, createdAt: Date.now() - 3 * 60 * 60 * 1000,
    accounts: { 'mm-buyer': systemAccount('mm-buyer', 'Demo liquidity'), 'mm-seller': systemAccount('mm-seller', 'Demo liquidity') },
    journals: Object.fromEntries(STOCKS.map(stock => [stock.symbol, []])), activities: [] };
  for (const user of users) { const account = allocateAccount(user); state.accounts[account.code] = account; }
  const ctx = await makeContext(state);
  for (const stock of STOCKS) {
    // Historical prices come from 24 actual pairs of C-engine orders, not fabricated metrics.
    for (let i = 0; i < 24; i++) {
      const offset = [0, -4, -2, 1, 3, 2, -1, 2, 5, 3, 1, 4][i % 12] + Math.floor(i / 12);
      const price = (stock.base + offset * 5) / 100;
      const qty = 6 + (i % 7) * 3;
      const time = state.createdAt + i * 5 * 60 * 1000;
      execute(ctx, stock.symbol, 'POST', '/api/orders', { side: 'sell', price, qty, trader: 'mm-seller' }, time);
      execute(ctx, stock.symbol, 'POST', '/api/orders', { side: 'buy', price, qty, trader: 'mm-buyer' }, time + 1);
    }
    for (let level = 1; level <= 16; level++) {
      for (const side of ['buy', 'sell']) execute(ctx, stock.symbol, 'POST', '/api/orders', {
        side, price: (stock.base + (side === 'buy' ? -1 : 1) * level * 5) / 100,
        qty: 35 + (level % 6) * 10, trader: side === 'buy' ? 'mm-buyer' : 'mm-seller',
      }, state.createdAt + 2 * 60 * 60 * 1000 + level);
    }
  }
  return state;
}
export async function seedExchange(users) {
  const state = await createSeedState(users);
  await getPool().query('INSERT INTO tc_exchange(id, version, state) VALUES($1,1,$2) ON CONFLICT(id) DO NOTHING', [EXCHANGE_ID, state]);
  cached = null;
}
function publicTrade(fill, state, symbol) {
  const buyCode = fill.taker_side === 'buy' ? fill.taker_trader : fill.maker_trader;
  const sellCode = fill.taker_side === 'sell' ? fill.taker_trader : fill.maker_trader;
  return { ...fill, symbol, buyer: state.accounts[buyCode]?.name || 'Trader', seller: state.accounts[sellCode]?.name || 'Trader' };
}
function portfolio(ctx, code, markets) {
  const account = ctx.state.accounts[code];
  const reserved = reservations(ctx, code);
  const positions = STOCKS.map(stock => {
    const qty = account.holdings[stock.symbol];
    const price = markets.find(market => market.symbol === stock.symbol).price;
    return { ...stock, qty, available: qty - reserved.shares[stock.symbol], reserved: reserved.shares[stock.symbol],
      average: qty ? account.basis[stock.symbol] / qty / 100 : 0,
      value: qty * price, pnl: qty * price - account.basis[stock.symbol] / 100 };
  });
  const allAccountOrders = STOCKS.flatMap(stock => allOrders(ctx, stock.symbol).filter(order => order.trader === code).map(order => ({ ...order, symbol: stock.symbol })))
    .sort((a, b) => b.time_ms - a.time_ms);
  const orders = allAccountOrders.slice(0, 100);
  const trades = STOCKS.flatMap(stock => ctx.engines[stock.symbol].request('GET', '/api/trades?limit=5000').data.trades
    .filter(fill => fill.maker_trader === code || fill.taker_trader === code)
    .map(fill => ({ ...publicTrade(fill, ctx.state, stock.symbol), side: (fill.taker_side === 'buy' ? fill.taker_trader : fill.maker_trader) === code ? 'buy' : 'sell' })))
    .sort((a, b) => b.time_ms - a.time_ms).slice(0, 50);
  return { cash: account.cash / 100, availableCash: (account.cash - reserved.cash) / 100, reservedCash: reserved.cash / 100,
    invested: positions.reduce((sum, position) => sum + position.value, 0),
    pnl: positions.reduce((sum, position) => sum + position.pnl, 0) + account.realized / 100,
    realized: account.realized / 100, positions, orders, openOrders: allAccountOrders.filter(active), trades };
}
export async function getSnapshot({ user, symbol = 'TCX', since = -1, lab = false }) {
  if (!stockFor(symbol)) throw new ExchangeError('Choose one of the four demo stocks.');
  let { rows: [row] } = await getPool().query('SELECT version, CASE WHEN version=$2 THEN NULL ELSE state END AS state FROM tc_exchange WHERE id=$1', [EXCHANGE_ID, since]);
  if (!row) throw new ExchangeError('The demo market is being prepared. Please retry in a moment.', 503);
  if (!row.state) return { unchanged: true, version: row.version, serverTime: Date.now() };
  if (user && !row.state.accounts[codeFor(user.id)]) {
    await transact(user, { action: 'join', requestId: `join-${user.id}` });
    ({ rows: [row] } = await getPool().query('SELECT version, state FROM tc_exchange WHERE id=$1', [EXCHANGE_ID]));
  }
  const ctx = await contextFor(row);
  const markets = STOCKS.map(stock => {
    const summary = ctx.engines[stock.symbol].request('GET', '/api/summary').data;
    const price = summary.last ?? stock.base / 100;
    return { ...stock, ...summary, symbol: stock.symbol, price,
      change: (price / (stock.base / 100) - 1) * 100,
      spark: ctx.engines[stock.symbol].request('GET', '/api/candles?interval_ms=300000&limit=40').data.candles.map(candle => candle.close) };
  });
  const engine = ctx.engines[symbol];
  const book = { ...engine.request('GET', '/api/book?depth=16').data, symbol };
  const trades = engine.request('GET', '/api/trades?limit=50').data.trades.map(fill => publicTrade(fill, ctx.state, symbol));
  const candles = engine.request('GET', '/api/candles?interval_ms=300000&limit=120').data.candles;
  const response = { ok: true, version: row.version, serverTime: Date.now(), markets, book, trades, candles,
    user: user ? { id: user.id, name: user.name, email: user.email } : null,
    portfolio: user ? portfolio(ctx, codeFor(user.id), markets) : null,
    demoAccounts: DEMO_USERS, activity: ctx.state.activities.slice(-16).reverse(),
    totalTrades: markets.reduce((sum, market) => sum + market.total_trades, 0),
    openOrders: markets.reduce((sum, market) => sum + market.active_orders, 0) };
  if (lab) {
    const stats = engine.request('GET', '/api/stats').data;
    const next = engine.request('GET', '/api/events?limit=1').data.next;
    response.lab = { bids: engine.request('GET', '/api/dsa/tree?side=buy&max_depth=4').data,
      asks: engine.request('GET', '/api/dsa/tree?side=sell&max_depth=4').data,
      hash: engine.request('GET', '/api/dsa/hash?count=64').data,
      events: engine.request('GET', `/api/events?since=${Math.max(1, next - 50)}&limit=50`).data.events,
      queues: [...book.bids.slice(0, 2).map(level => ({ side: 'buy', price: level.price })),
        ...book.asks.slice(0, 2).map(level => ({ side: 'sell', price: level.price }))]
        .map(level => engine.request('GET', `/api/book/level?side=${level.side}&price=${level.price}`).data),
      stats, check: engine.request('GET', '/api/check').data };
  }
  return response;
}
function validateLedger(ctx) {
  for (const account of Object.values(ctx.state.accounts)) {
    if (!Number.isSafeInteger(account.cash) || account.cash < 0 || Object.values(account.holdings).some(qty => !Number.isSafeInteger(qty) || qty < 0))
      throw new Error('The account ledger invariant failed. No trade was saved.');
    const reserved = reservations(ctx, account.code);
    if (reserved.cash > account.cash || STOCKS.some(stock => reserved.shares[stock.symbol] > account.holdings[stock.symbol]))
      throw new Error('The reservation invariant failed. No trade was saved.');
  }
}
function placeOrder(ctx, account, body) {
  const stock = stockFor(body.symbol);
  if (!stock) throw new ExchangeError('Choose one of the four demo stocks.');
  const { symbol } = stock;
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new ExchangeError('Quantity must be a whole number from 1 to 10,000.');
  if (!['buy', 'sell'].includes(body.side)) throw new ExchangeError('Choose Buy or Sell.');
  let price = Number(body.price);
  const engine = ctx.engines[symbol];
  if (body.execution === 'instant') {
    const book = engine.request('GET', '/api/book?depth=1000').data;
    const levels = body.side === 'buy' ? book.asks : book.bids;
    let remaining = qty;
    for (const level of levels) { price = level.price; remaining -= Math.min(remaining, level.qty); if (!remaining) break; }
    if (remaining) throw new ExchangeError('There are not enough shares on the opposite side. Reduce quantity or place a limit order.');
  }
  const paise = Math.round(price * 100);
  if (!Number.isFinite(price) || price <= 0 || Math.abs(price * 100 - paise) > 1e-5 || paise % 5 || price > 100000)
    throw new ExchangeError('Use a positive price in steps of Rs 0.05, up to Rs 1,00,000.');
  const own = allOrders(ctx, symbol).filter(order => order.trader === account.code && active(order));
  if (own.some(order => order.side !== body.side && (body.side === 'buy' ? order.price <= price : order.price >= price)))
    throw new ExchangeError('This would match your own opposite order. Cancel that order first.');
  const reserved = reservations(ctx, account.code);
  if (body.side === 'buy' && paise * qty > account.cash - reserved.cash)
    throw new ExchangeError('Not enough available demo cash. Reduce quantity or cancel an open buy order.');
  if (body.side === 'sell' && qty > account.holdings[symbol] - reserved.shares[symbol])
    throw new ExchangeError('Not enough available shares. Reduce quantity or cancel an open sell order.');
  return execute(ctx, symbol, 'POST', '/api/orders', { side: body.side, price, qty, trader: account.code });
}
function runDemo(ctx, symbol, scenario) {
  const stock = stockFor(symbol);
  if (!stock) throw new ExchangeError('Choose a stock first.');
  let fills = 0;
  let commands = 0;
  if (scenario === 'avl') {
    const book = ctx.engines[symbol].request('GET', '/api/book?depth=1000').data;
    const low = book.bids.at(-1)?.price ?? stock.base / 100;
    for (let i = 1; i <= 12; i++) {
      execute(ctx, symbol, 'POST', '/api/orders', { side: 'buy', price: Math.max(0.05, Math.round((low - i * 0.05) * 20) / 20), qty: 10, trader: 'mm-buyer' }); commands++;
    }
  } else if (scenario === 'liquidity') {
    const book = ctx.engines[symbol].request('GET', '/api/book?depth=1').data;
    const center = book.mid ?? stock.base / 100;
    for (let i = 1; i <= 8; i++) for (const side of ['buy', 'sell']) {
      const price = Math.round((center + (side === 'buy' ? -1 : 1) * (1 + i) * 0.05) * 20) / 20;
      const r = execute(ctx, symbol, 'POST', '/api/orders', { side, price, qty: 25, trader: side === 'buy' ? 'mm-buyer' : 'mm-seller' });
      fills += r.fills.length; commands++;
    }
  } else {
    for (let i = 0; i < 10; i++) {
      const book = ctx.engines[symbol].request('GET', '/api/book?depth=1').data;
      const side = i % 2 ? 'sell' : 'buy';
      const price = (side === 'buy' ? book.best_ask : book.best_bid) ?? stock.base / 100;
      const r = execute(ctx, symbol, 'POST', '/api/orders', { side, price, qty: 3 + i % 4, trader: side === 'buy' ? 'mm-buyer' : 'mm-seller' });
      fills += r.fills.length; commands++;
    }
  }
  return { ok: true, commands, fills, message: `${commands} real C-engine commands completed; ${fills} fills.` };
}
export async function transact(user, body) {
  if (!user) throw new ExchangeError('Sign in to trade with demo cash and shares.', 401);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId || '')) throw new ExchangeError('A valid request ID is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query('SELECT version, state FROM tc_exchange WHERE id=$1 FOR UPDATE', [EXCHANGE_ID]);
    if (!row) throw new ExchangeError('The market is not ready yet.', 503);
    const { rows: [previous] } = await client.query('SELECT result FROM tc_requests WHERE exchange_id=$1 AND user_id=$2 AND request_id=$3', [EXCHANGE_ID, user.id, body.requestId]);
    if (previous) { await client.query('COMMIT'); return previous.result; }
    const { rows: [rate] } = await client.query("SELECT count(*)::int AS count FROM tc_requests WHERE exchange_id=$1 AND user_id=$2 AND created_at > now() - interval '1 minute'", [EXCHANGE_ID, user.id]);
    if (rate.count >= 60) throw new ExchangeError('Please wait a moment before sending more orders.', 429);
    const ctx = await makeContext(row.state);
    const code = codeFor(user.id);
    if (!ctx.state.accounts[code]) ctx.state.accounts[code] = allocateAccount(user);
    const account = ctx.state.accounts[code];
    // Keep every order within the C API's 5,000-record export so reservations
    // and self-trade checks always see the whole book, including old orders.
    if (STOCKS.some(stock => ctx.state.journals[stock.symbol].length > 4000) && body.action !== 'cancel' && body.action !== 'join')
      throw new ExchangeError('This demo session has reached its command limit. Existing orders can still be cancelled.', 409);
    let result;
    if (body.action === 'join') result = { ok: true };
    else if (body.action === 'cancel') {
      if (!stockFor(body.symbol) || !Number.isSafeInteger(Number(body.id)) || Number(body.id) < 1) throw new ExchangeError('Choose a valid order.');
      const order = ctx.engines[body.symbol].request('GET', `/api/orders/${body.id}`).data.order;
      if (!order || order.trader !== code) throw new ExchangeError('You can only cancel your own orders.', 403);
      result = execute(ctx, body.symbol, 'POST', `/api/orders/${body.id}/cancel`, {});
    } else if (body.action === 'demo') result = runDemo(ctx, body.symbol, body.scenario);
    else result = placeOrder(ctx, account, body);
    validateLedger(ctx);
    if (body.action !== 'join') {
      ctx.state.activities.push({ time: Date.now(), trader: account.name, symbol: body.symbol,
        text: body.action === 'demo' ? (body.scenario === 'avl' ? 'grew the AVL order book' : 'ran a market demonstration') : body.action === 'cancel' ? `cancelled order #${body.id}` :
          `${body.side === 'buy' ? 'bought / bid for' : 'sold / offered'} ${body.qty} shares`, fills: result.fills?.length ?? result.fills ?? 0 });
      ctx.state.activities = ctx.state.activities.slice(-100);
    }
    result = { ...result, version: row.version + 1, symbol: body.symbol };
    await client.query('UPDATE tc_exchange SET state=$2, version=version+1, updated_at=now() WHERE id=$1', [EXCHANGE_ID, ctx.state]);
    await client.query('INSERT INTO tc_requests(exchange_id,user_id,request_id,result) VALUES($1,$2,$3,$4)', [EXCHANGE_ID, user.id, body.requestId, result]);
    await client.query('COMMIT');
    cached = { version: result.version, context: Promise.resolve(ctx) };
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
