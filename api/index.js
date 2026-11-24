import { handleRequest } from '../server/handler.mjs';

export default async function handler(req, res) {
  const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined :
    typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const url = new URL(req.url, origin);
  // Vercel's plain Node routes need an explicit rewrite for nested auth paths.
  const route = req.query?.__path || url.searchParams.get('__path');
  if (route) url.pathname = `/api/${Array.isArray(route) ? route.join('/') : route}`;
  url.searchParams.delete('__path');
  const response = await handleRequest(new Request(url, { method: req.method, headers, body }));
  res.statusCode = response.status;
  for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
