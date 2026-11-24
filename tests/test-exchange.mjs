import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const testId = randomUUID();
process.env.TRADECORE_EXCHANGE_ID = `test-${testId}`;
const { handleRequest } = await import('../server/handler.mjs');
const { seedExchange } = await import('../server/exchange.mjs');
const { getPool } = await import('../server/auth.mjs');
const users = [];
const origin = 'http://127.0.0.1:4173';
async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await handleRequest(new Request(origin + path, { method,
    headers: { Origin: origin, 'x-tradecore-client-ip': '127.0.0.1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined }));
  return { status: response.status, data: await response.json(),
    cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
const order = (cookie, body) => request('/api/orders', { method: 'POST', cookie, body: { requestId: randomUUID(), symbol: 'TCX', ...body } });
const snapshot = cookie => request('/api/market?symbol=TCX&lab=1', { cookie });
try {
  for (let i = 0; i < 2; i++) {
    const result = await request('/api/auth/sign-up/email', { method: 'POST', body: {
      name: `Test Trader ${i}`, email: `tradecore-${testId}-${i}@example.test`, password: 'TestTrading123!',
    } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(result.cookie);
    users.push({ ...result.data.user, cookie: result.cookie });
  }
  await seedExchange(users);
  const a = users[0].cookie, b = users[1].cookie;
  const initial = (await snapshot(a)).data;
  assert.equal(initial.totalTrades, 96);
  assert.equal(initial.openOrders, 128);
  assert.equal(initial.portfolio.cash, 100000);
  assert.equal(initial.portfolio.openOrders.length, 0);
  assert.equal(initial.portfolio.positions.find(position => position.symbol === 'TCX').qty, 40);
  assert.equal(initial.lab.check.ok, true);
  assert.equal((await order(undefined, { side: 'buy', qty: 1, execution: 'instant' })).status, 401);
  const key = randomUUID();
  const payload = { symbol: 'TCX', side: 'buy', qty: 5, execution: 'instant', requestId: key };
  const first = await request('/api/orders', { method: 'POST', cookie: a, body: payload });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const again = await request('/api/orders', { method: 'POST', cookie: a, body: payload });
  assert.equal(again.data.version, first.data.version);
  let afterA = (await snapshot(a)).data;
  assert.equal(afterA.portfolio.positions.find(position => position.symbol === 'TCX').qty, 45);
  assert.equal(afterA.portfolio.cash, 100000 - first.data.fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0));
  const seenByB = (await snapshot(b)).data;
  assert.equal(seenByB.book.asks[0].qty, initial.book.asks[0].qty - 5);
  const sell = await order(a, { side: 'sell', qty: 4, price: 100, execution: 'limit' });
  assert.equal(sell.status, 200, JSON.stringify(sell.data));
  assert.equal(sell.data.order.remaining, 4);
  const buy = await order(b, { side: 'buy', qty: 4, execution: 'instant' });
  assert.equal(buy.status, 200);
  assert.equal(buy.data.fills[0].maker_id, sell.data.order.id);
  assert.equal(buy.data.fills[0].price, 100);
  const afterB = (await snapshot(b)).data;
  assert.equal(afterB.portfolio.positions.find(position => position.symbol === 'TCX').qty, 44);
  afterA = (await snapshot(a)).data;
  assert.equal(afterA.portfolio.positions.find(position => position.symbol === 'TCX').qty, 41);
  assert.equal((await order(a, { side: 'sell', qty: 10000, price: 110, execution: 'limit' })).status, 400);
  assert.equal((await order(a, { side: 'buy', qty: 1, price: 99.99, execution: 'limit' })).status, 400);
  const reserved = await order(a, { side: 'buy', qty: 800, price: 99, execution: 'limit' });
  assert.equal(reserved.status, 200);
  assert.ok((await snapshot(a)).data.portfolio.openOrders.some(item => item.id === reserved.data.order.id));
  assert.equal((await order(a, { side: 'buy', qty: 800, price: 99, execution: 'limit' })).status, 400);
  const foreignCancel = await request('/api/orders/cancel', { method: 'POST', cookie: b, body: { symbol: 'TCX', id: reserved.data.order.id, requestId: randomUUID() } });
  assert.equal(foreignCancel.status, 403);
  const cancel = await request('/api/orders/cancel', { method: 'POST', cookie: a, body: { symbol: 'TCX', id: reserved.data.order.id, requestId: randomUUID() } });
  assert.equal(cancel.status, 200);
  assert.equal((await snapshot(a)).data.portfolio.reservedCash, 0);
  const concurrent = await Promise.all([order(a, { side: 'buy', qty: 1, execution: 'instant' }), order(b, { side: 'buy', qty: 1, execution: 'instant' })]);
  assert.ok(concurrent.every(result => result.status === 200));
  assert.notEqual(concurrent[0].data.version, concurrent[1].data.version);
  assert.equal((await snapshot(a)).data.portfolio.positions.find(position => position.symbol === 'TCX').qty, 42);
  assert.equal((await snapshot(b)).data.portfolio.positions.find(position => position.symbol === 'TCX').qty, 45);
  const contested = await Promise.all([order(a, { side: 'buy', qty: 800, price: 98, execution: 'limit' }), order(a, { side: 'buy', qty: 800, price: 98, execution: 'limit' })]);
  assert.deepEqual(contested.map(result => result.status).sort(), [200, 400]);
  const final = (await snapshot(a)).data;
  assert.equal(final.lab.check.ok, true);
  assert.ok(final.portfolio.availableCash >= 0);
  assert.equal((await request(`/api/market?symbol=TCX&since=${final.version}`, { cookie: a })).data.unchanged, true);
  const demo = await request('/api/demo', { method: 'POST', cookie: b, body: { symbol: 'NOVA', scenario: 'flow', requestId: randomUUID() } });
  assert.equal(demo.status, 200, JSON.stringify(demo.data));
  assert.equal(demo.data.commands, 10);
  assert.equal((await request('/api/auth/sign-in/email', { method: 'POST', body: { email: users[0].email, password: 'WrongPassword123!' } })).status, 401);
  console.log('Shared exchange checks passed: sign-up/session, seeded market, real two-user matching, settlement, reservations, cancellation ownership, idempotency, concurrent writes, overspend/oversell rejection, change polling, demo orders and C invariants.');
} finally {
  const pool = getPool();
  await pool.query('DELETE FROM tc_requests WHERE exchange_id=$1', [process.env.TRADECORE_EXCHANGE_ID]);
  await pool.query('DELETE FROM tc_exchange WHERE id=$1', [process.env.TRADECORE_EXCHANGE_ID]);
  const ids = users.filter(user => user.email.startsWith(`tradecore-${testId}-`)).map(user => user.id);
  if (ids.length) {
    await pool.query('DELETE FROM "session" WHERE "userId"=ANY($1::text[])', [ids]);
    await pool.query('DELETE FROM "account" WHERE "userId"=ANY($1::text[])', [ids]);
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
  }
  await pool.end();
}
