import { getMigrations } from 'better-auth/db/migration';
import { getAuth, getPool } from '../server/auth.mjs';
import { DEMO_USERS, DEMO_PASSWORD, EXCHANGE_ID } from '../server/config.mjs';
import { seedExchange } from '../server/exchange.mjs';

const auth = getAuth();
const migration = await getMigrations(auth.options);
await migration.runMigrations();
await getPool().query(`CREATE TABLE IF NOT EXISTS tc_exchange (
  id text PRIMARY KEY, version integer NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS tc_requests (exchange_id text NOT NULL, user_id text NOT NULL,
  request_id text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(exchange_id,user_id,request_id));
  CREATE INDEX IF NOT EXISTS tc_requests_rate ON tc_requests(exchange_id,user_id,created_at);`);
const users = [];
for (const demo of DEMO_USERS) {
  const existing = await getPool().query('SELECT id, name, email FROM "user" WHERE email=$1', [demo.email]);
  if (existing.rows[0]) users.push(existing.rows[0]);
  else users.push((await auth.api.signUpEmail({ body: { name: demo.name, email: demo.email, password: DEMO_PASSWORD } })).user);
}
await seedExchange(users);
console.log(`Market ready (${EXCHANGE_ID}): four demo accounts, four stocks, 96 executed seed trades and 128 open seed orders.`);
await getPool().end();
