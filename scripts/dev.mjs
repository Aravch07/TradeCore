import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../server/handler.mjs';

const root = fileURLToPath(new URL('../frontend/', import.meta.url));
const port = Number(process.env.PORT || process.argv[2] || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.gif': 'image/gif' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
        if (chunks.reduce((sum, value) => sum + value.length, 0) > 32768) { res.writeHead(413); res.end(); return; }
      }
      const request = new Request(url, { method: req.method, headers: { ...req.headers, 'x-tradecore-client-ip': req.socket.remoteAddress },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await handleRequest(request);
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    const path = resolve(root, `.${decodeURIComponent(pathname)}`);
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`TradeCore shared exchange: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', () => server.close());
