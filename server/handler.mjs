import { getAuth } from './auth.mjs';
import { getSnapshot, transact, ExchangeError } from './exchange.mjs';
import { DEMO_USERS } from './config.mjs';

export async function handleRequest(request) {
  const url = new URL(request.url);
  const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' };
  try {
    if (url.pathname.startsWith('/api/auth/')) {
      if (/\/(change-password|update-user|change-email|delete-user|set-password|link-social|unlink-account)\/?$/.test(url.pathname)) {
        const session = await getAuth().api.getSession({ headers: request.headers });
        if (session && DEMO_USERS.some(demo => demo.email === session.user.email))
          throw new ExchangeError('Shared demo profiles cannot be changed. Create your own account for a personal profile.', 403);
      }
      return await getAuth().handler(request);
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true, name: 'TradeCore shared exchange', storage: 'postgres', engine: 'C/WebAssembly' }, { headers });
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (request.method === 'GET' && url.pathname === '/api/market') {
      const data = await getSnapshot({ user: session?.user, symbol: url.searchParams.get('symbol') || 'TCX',
        since: Number(url.searchParams.get('since') || -1), lab: url.searchParams.get('lab') === '1' });
      return Response.json(data, { headers });
    }
    if (request.method === 'POST' && ['/api/orders', '/api/orders/cancel', '/api/demo'].includes(url.pathname)) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new ExchangeError('This action must come from the TradeCore site.', 403);
      if (!request.headers.get('content-type')?.includes('application/json')) throw new ExchangeError('Send a JSON request.');
      const raw = await request.text();
      if (raw.length > 16384) throw new ExchangeError('The request is too large.', 413);
      let body;
      try { body = JSON.parse(raw); } catch { throw new ExchangeError('The request contains invalid JSON.'); }
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new ExchangeError('Send an order object.');
      body.action = url.pathname === '/api/demo' ? 'demo' : url.pathname.endsWith('/cancel') ? 'cancel' : 'order';
      return Response.json(await transact(session?.user, body), { headers });
    }
    return Response.json({ ok: false, message: 'This endpoint does not exist.' }, { status: 404, headers });
  } catch (error) {
    if (!(error instanceof ExchangeError)) console.error('TradeCore request failed:', error.name, error.code || 'internal');
    return Response.json({ ok: false, message: error instanceof ExchangeError ? error.message :
      'The market could not complete this request. Please retry in a moment.' }, { status: error.status || 503, headers });
  }
}
