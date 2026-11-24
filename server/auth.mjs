import { betterAuth } from 'better-auth';
import pg from 'pg';

let pool;
let auth;
export function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Connect the TradeCore database before starting.');
  if (!pool) {
    const databaseURL = new URL(process.env.DATABASE_URL);
    databaseURL.searchParams.set('sslmode', 'verify-full');
    pool = new pg.Pool({ connectionString: databaseURL.toString(), max: 5,
      connectionTimeoutMillis: 15000, idleTimeoutMillis: 20000, allowExitOnIdle: true });
    pool.on('error', () => console.error('A database connection was interrupted. The next request will reconnect.'));
  }
  return pool;
}
export function getAuth() {
  if (!process.env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required.');
  if (!auth) auth = betterAuth({
    database: getPool(),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL || { allowedHosts: ['tcxcore.vercel.app', 'tradecore-liart.vercel.app',
      'tradecore-uni-321d.vercel.app', 'tradecore-*-uni-321d.vercel.app', '127.0.0.1:4173', 'localhost:4173'],
      fallback: process.env.VERCEL ? 'https://tcxcore.vercel.app' : 'http://127.0.0.1:4173', protocol: 'auto' },
    trustedOrigins: ['https://tcxcore.vercel.app', 'https://tradecore-liart.vercel.app',
      'https://tradecore-uni-321d.vercel.app', 'https://tradecore-git-main-uni-321d.vercel.app',
      'http://127.0.0.1:4173', 'http://localhost:4173', 'https://tradecore-*-uni-321d.vercel.app',
      ...[process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].filter(Boolean).map(host => `https://${host}`)],
    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: true, maxAge: 60 } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100 },
    advanced: { ipAddress: { ipAddressHeaders: process.env.VERCEL ? ['x-vercel-forwarded-for', 'x-forwarded-for'] : ['x-tradecore-client-ip'] } },
  });
  return auth;
}
