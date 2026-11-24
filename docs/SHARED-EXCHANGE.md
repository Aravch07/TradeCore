# TradeCore shared exchange

Live website: https://tcxcore.vercel.app

## What is available

The main trading desk has four simple choices: Market, Portfolio, DSA lab,
and Simulation. The market is stored in Postgres and is shared across users,
browsers, refreshes, and deployments. All stocks and funds are fictitious.

Every new account receives Rs 1,00,000 in cash and 40 TCX, 25 NOVA, 50 APEX,
and 30 ORBT shares. Available shares can be sold immediately into the seeded
buy orders. The initial market has 96 executed historical trades and 128
resting buy/sell orders across the four companies. Displayed prices, volume,
trades and DSA counters come from C-engine executions rather than random UI data.

## Demo logins

Use the named buttons in Sign in, or these deliberately public credentials:

| Trader | Email | Password |
|---|---|---|
| Arav | arav@tradecore.test | TradeCore123! |
| Priya | priya@tradecore.test | TradeCore123! |
| Rohan | rohan@tradecore.test | TradeCore123! |
| Ananya | ananya@tradecore.test | TradeCore123! |

These are shared accounts, so their portfolios change when someone trades.
Create an account to get a separate saved portfolio. Better Auth manages password
hashes, sessions, cookies and login rate limits; the database credentials and
session-signing secret are server-side environment variables. Shared demo profile
and password changes are blocked.

## Two-person demonstration

1. Open two browser profiles (or a normal and a private window).
2. Sign in as Arav in one and Priya in the other.
3. Arav sells 3 TCX using a limit price between the current best bid and ask.
   For the initial book, Rs 100.00 is between Rs 99.95 and Rs 100.05.
4. Priya chooses Instant trade and buys 3 TCX. Arav's order is first in the ask
   book, so those accounts match at the maker's price.
5. Check both portfolios: shares and cash move together, and a fill receipt and
   trade history show the actual counterparty. The open book updates in both.
6. Place a non-crossing limit order and cancel it from Portfolio. The reserved
   cash or shares are released.

Active tabs check for a new market version every 1.5 seconds. Unchanged versions
return a small response; hidden tabs stop polling, and focus triggers a fresh
read. Form inputs are not rebuilt on every market update. Neon Free can have
cold-start latency after inactivity; this is a small educational exchange, not
a low-latency production trading platform.

## Simulation: Aaryaman's newest project

The Simulation option opens `/simulation/`, imported from
`Aaryaman-25/TradeCore` commit `f30903cc7a7b663691e7fa62e9c312b48046aa62`.
It preserves the original four-section interface, 12 bot traders, three hours
of seeded history, scenarios, DSA playback, and calm / volatile / bull / bear /
flash-crash controls. Choose Explore with the demo account, or use
**demo / demo1234** (also **student / student123**).

This separate simulation runs the updated C engine, C auth and bot loop in a
browser worker through WebAssembly. It is private to the tab and resets on
reload; its credentials and paper portfolio are separate from the shared desk.
`upstream-simulation/` preserves the source. Its generated browser build fixes
64-bit timestamp parsing on wasm32 and uses browser crypto for random bytes.
Use demo credentials for this learning simulation rather than a personal password.

## How the shared engine and ledger work

Each stock has an instance of the original C engine. A persisted command journal
reconstructs each book on a cold start. Warm snapshots reuse a versioned engine
cache. A Postgres row transaction serializes mutations across function instances:
it validates available cash/shares, executes C matching, settles actual fills,
checks reservations, and commits the journal and account ledger together.

Open buys reserve limit price times remaining shares; open sells reserve shares.
Cancellation releases reservations. Self-crossing orders are rejected. An order
request ID is saved with its result so retrying the same request cannot trade
twice. The server assigns the trader from the authenticated session and checks
ownership before cancellation. Demo flow buttons execute genuine C commands.

Cash and cost basis are integers in paise. Matching still uses price-time
priority, cached AVL best prices, FIFO order queues, a chained hash table,
dynamic arrays and a bounded trace buffer. The main DSA lab shows the current
shared structures and their recent events; the standalone Simulation retains
the upstream's richer playback and market-mood experiments.

## Run locally

Node.js 24 is used by this project. Install dependencies, pull the environment
for the existing Vercel project, then initialize and start:

```sh
npm ci
npx vercel link --project tradecore --scope uni-321d
npx vercel env pull .env.local
npm run setup
npm start
```

Open http://127.0.0.1:4173. On Windows PowerShell, `npm.cmd` and `npx.cmd` can
be used instead. Only an authorized project member can pull the live credentials.
To use a separate local database/room, provide your own DATABASE_URL and a random
BETTER_AUTH_SECRET, and set a distinct TRADECORE_EXCHANGE_ID before setup.
Setup creates auth/schema tables and inserts initial market state only if the
exchange ID does not already exist; it does not reset an existing portfolio.
Never commit `.env.local` or include it in an archive.

The standalone Simulation needs no database when served as static files. Its
compiled binary is already included. To run the original native upstream server
on Linux/macOS/WSL:

```sh
make -C upstream-simulation test
make -C upstream-simulation run
```

The root `make run` delegates to that server. Its source GUI and C authentication
remain unchanged and work together on http://127.0.0.1:8080. Plain Windows lacks
the native `/dev/urandom` source used by upstream auth tests; the browser adapter
uses secure browser random bytes and passes the full suite under WebAssembly.

## Tests and rebuilds

```sh
npm run test:exchange      # real DB/auth, two users, settlement, races, idempotency
npm run test:wasm          # original C API in WebAssembly
npm run test:simulation    # updated upstream auth, bots, controls and matching
npm run build:wasm         # rebuild shared matching core after root C edits
npm run build:simulation   # rebuild updated simulation after upstream C edits
```

Both rebuilds require official WASI SDK 34 and accept WASI_SDK_PATH. The binaries
are committed, so normal deployment doesn't need a C compiler. Database tests
use a unique exchange ID and temporary users, then remove only their own fixtures.

## Deployment

Vercel installs with `npm ci`, serves `frontend/`, and bundles the catch-all
Node function in `api/index.js`. An explicit rewrite includes nested auth routes.
Functions and the Neon database are in
Singapore. The public aliases are attached to the existing TradeCore project.
No credentials are needed in the browser. Preview builds use the connected
database too, so never run destructive resets or migrations against it.
