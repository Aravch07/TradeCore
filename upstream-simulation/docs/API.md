# TradeCore API reference

Base URL: `http://127.0.0.1:8080`. Everything is JSON. CORS is open (`*`), so a
React dev server on another port (e.g. Vite on 5173) can call it directly.

## Signing in

Reading market data (`GET`) is public. **Every command that changes something
(`POST`/`DELETE`) needs a signed-in account.** Send the session token in a
header:

```
Authorization: Bearer <token>
```

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/register` `{"username","password"}` | Create an account (username 3–15 chars `A-Z a-z 0-9 _ - .`; password 6–64 chars) and sign in. Returns `{token, user}`. `409 USERNAME_TAKEN` (bot names are reserved). |
| `POST /api/auth/login` `{"username","password"}` | Returns `{token, user}`; `401 WRONG_CREDENTIALS` otherwise. Usernames are case-insensitive. |
| `GET /api/auth/me` | The account behind the token, or `401 NOT_LOGGED_IN`. |
| `POST /api/auth/logout` | Ends the session. |

Demo accounts created at start-up: `demo` / `demo1234` and `student` / `student123`.
Passwords are stored as salted SHA-256 hashes (20,000 rounds); tokens are 256-bit
random values that expire after 12 hours. Accounts live in memory and reset
when the engine restarts.

**Ownership.** Every order records its `owner` (the account that placed it)
and a display `trader` label. You can only cancel or replace orders whose
owner is you (`403 NOT_YOUR_ORDER`).

**Conventions**

- **Prices** are rupees with at most 2 decimals and must be a multiple of the
  **Rs 0.05 tick**. You can send them as a number (`101.05`) or a string
  (`"101.05"`). Responses always return numbers with 2 decimals.
- **Quantities** are whole shares (1 to 1,000,000,000).
- **Sides** are `"buy"` or `"sell"` (`"bid"` and `"ask"` are also accepted).
- `cmd_seq` is the engine's command sequence. Every command gets one, even a
  rejected command.
- Order `id`s are given only to accepted orders, so ids and `cmd_seq` can
  differ.
- Order `status` is one of `open`, `partial`, `filled`, `cancelled` or `replaced`.

**HTTP status codes**

| Code | Meaning |
|---|---|
| 200 | OK |
| 400 | Malformed request (bad JSON, unparsable price) |
| 404 | Unknown order or endpoint |
| 422 | The engine rejected the command (off-tick price, order not active, ...) |

**Error body**

```json
{"ok":false,"error":"PRICE_NOT_TICK_ALIGNED","message":"price must be a multiple of the Rs 0.05 tick"}
```

**Error codes:** `INVALID_SIDE`, `INVALID_PRICE`, `PRICE_NOT_TICK_ALIGNED`,
`INVALID_QUANTITY`, `UNKNOWN_ORDER`, `ORDER_NOT_ACTIVE`, `BAD_JSON`,
`BAD_QUERY`, `NO_LEVEL`, `UNKNOWN_SCENARIO`, `NOT_FOUND`.

---

## Trading commands

### `POST /api/orders` submits a limit order

```json
{"side":"buy","price":101.00,"qty":200,"trader":"B1"}
```

`label` is optional: a display name of up to 15 characters (for example `"S1"`
in a scenario). It defaults to your username and may not be another account's
or a bot's name (`403 LABEL_NOT_ALLOWED`). The order's `owner` is always you.

The response is a **command result**. The `/api/stream` command event uses the same shape.

```json
{
  "ok": true, "command": "submit", "cmd_seq": 5,
  "order": {"id":5,"seq":5,"side":"buy","price":101.00,"qty":200,"remaining":0,
            "filled":200,"status":"filled","trader":"B1","time_ms":1795511515307,
            "replaces":0,"replaced_by":0},
  "fills": [
    {"trade_id":1,"cmd_seq":5,"time_ms":1795511515307,"price":100.00,"qty":80,
     "maker_id":1,"taker_id":5,"buy_order_id":5,"sell_order_id":1,
     "taker_side":"buy","maker_trader":"S1","taker_trader":"B1"}
  ],
  "best_bid": null, "best_ask": 101.00, "spread": null,
  "events": {"from": 9, "to": 41},
  "engine_ns": 2150
}
```

`events.from` and `events.to` give the half-open range of trace event
sequences this command produced. Use it with `/api/events`.

### `POST /api/orders/{id}/cancel` (or `DELETE /api/orders/{id}`) cancels the remainder of an active order

### `POST /api/orders/cancel-all` cancels every open order you own

No body needed. Each cancel is its own engine command, broadcast over the stream. Returns `{"ok":true,"cancelled":3,"ids":[4,7,9]}`.

### `POST /api/orders/{id}/replace` cancels and replaces an order

```json
{"price": 100.50, "qty": 60}
```

Both fields are optional. An omitted field keeps the current price or the
remaining quantity. The new order gets a **new id and sequence**, so it loses
time priority. If the new values are invalid, nothing changes. The result has
`order` (the new order) and `replaced` (the old one, with status `replaced`
and `replaced_by` set).

---

## Market data

| Endpoint | Returns |
|---|---|
| `GET /api/book?depth=20` | `best_bid`, `best_ask`, `spread`, `mid`, `last_price`, `bids[]` (highest first) and `asks[]` (lowest first). Each level is `{price, qty, orders, node_id}`. |
| `GET /api/book/level?side=buy&price=101.00` | The FIFO queue at one price: `orders[]` in time order, each with `id`, `seq`, `remaining`, `qty` (original), `time_ms`, `prev`, `next`, `hash_bucket` and `trader`. Also `head`, `tail`, `total_qty` and `count`. |
| `GET /api/orders?status=open&owner=demo&trader=B1&limit=100` | Order history, newest first. `status` can be `all`, `open` (open plus partial), `closed`, or any single status. `owner` filters by account, `trader` by label. |
| `GET /api/orders/{id}` | One order, its fills, and `book` = `{node_id, queue_position, level_count, hash_bucket}` while it is active (`null` otherwise). |
| `GET /api/trades?limit=100&since_id=0&since_ms=0&owner=demo` | Fills, newest first, with `maker_trader`/`taker_trader` labels and `maker_owner`/`taker_owner` accounts. `since_ms` keeps only fills at or after that time; `owner` keeps only fills where that account was maker or taker. |
| `GET /api/summary?since_ms=0` | Session summary: `open`, `high`, `low`, `last`, `vwap`, `volume`, `turnover`, `trades`, `buy_volume` / `sell_volume` (by aggressor), best bid/ask with quantities, and total `bid_depth` / `ask_depth`. |
| `GET /api/candles?interval_ms=60000&limit=300` | OHLCV bars built from fills. Intervals with no trades are **omitted**, so the UI should mark gaps. |

---

## DSA visualizer

| Endpoint | Returns |
|---|---|
| `GET /api/dsa/tree?side=buy&max_depth=6` | The AVL tree in pre-order: `nodes[]` of `{id, price, height, balance, depth, left, right, qty, orders}`. `left` and `right` are child node ids. Also `root`, `best`, `height`, `rotations`, and `truncated` (true if deeper nodes were cut off). |
| `GET /api/dsa/hash?from=0&count=64` | Hash table summary (`capacity`, `size`, `load_factor`, `max_chain`, `resizes`, `probes`) plus the bucket range, each as `{index, chain:[order ids]}`. |
| `GET /api/dsa/hash?order_id=42` | Just the bucket that order 42 hashes to. |
| `GET /api/events?since=1&limit=500` | Trace events in order. `gap:true` means events older than `oldest` were overwritten (ring buffer), so reload a snapshot. Continue with `since=resume_from`. |

### Trace event types

Every event has `seq`, `cmd_seq` and `type`. Most also have `side`, `price`
and `order_id`.

| type | extra fields | meaning |
|---|---|---|
| `ORDER_ACCEPTED` | qty | command passed validation |
| `ORDER_REJECTED` | reason | command refused |
| `AVL_VISIT` | node_id, node_price | search passed through this node (`price` = the price being searched for) |
| `AVL_INSERT` / `AVL_REMOVE` | node_id | price level created / deleted |
| `AVL_ROTATE_LEFT` / `AVL_ROTATE_RIGHT` | node_id, new_root_id | node_id moved down; new_root_id took its place |
| `BEST_CHANGED` | node_id, empty | cached best bid or best ask changed |
| `FIFO_ENQUEUE` | remaining, level_count, node_id | order joined the tail of a queue |
| `FIFO_DEQUEUE` | remaining, level_count, node_id | fully filled head was removed |
| `FIFO_UNLINK` | remaining, level_count, node_id | order removed from anywhere in the queue (cancel/replace) |
| `LEVEL_QTY` | total_qty, node_id | aggregate quantity of a level changed |
| `HASH_INSERT` | bucket, chain_len | id added to the hash table |
| `HASH_ERASE` | bucket, probes | id removed (probes = chain nodes inspected) |
| `HASH_RESIZE` | old_capacity, new_capacity | table doubled and all entries rehashed |
| `FILL` | maker_id, qty, maker_remaining, taker_remaining | one execution |
| `ORDER_FILLED` / `ORDER_RESTED` / `ORDER_CANCELLED` / `ORDER_REPLACED` | (varies) | order lifecycle |

---

## Live stream: `GET /api/stream` (Server-Sent Events)

```js
const es = new EventSource("http://127.0.0.1:8080/api/stream");
es.addEventListener("command", e => { const r = JSON.parse(e.data); /* same shape as POST result */ });
es.addEventListener("trace",   e => { const { cmd_seq, events, truncated } = JSON.parse(e.data); });
es.addEventListener("reset",   e => { /* scenario loaded or session reset: refetch everything */ });
es.addEventListener("hello",   e => { const { cmd_seq, event_seq } = JSON.parse(e.data); });
es.addEventListener("sim",     e => { /* simulator settings changed: same shape as GET /api/sim */ });
```

- `command` events carry `id: <cmd_seq>`. If a `cmd_seq` is skipped, refetch
  `/api/book`.
- `trace` holds at most 2000 events per command. If `truncated` is true, fetch
  the rest from `/api/events`.
- Comment lines (`: ping`) arrive every 15 s to keep the connection alive.

---

## Live market simulator (bots)

Twelve bot traders (2 market makers, 8 retail traders, a momentum trader and an
institution) send ordinary engine commands so the market is always moving. At
start-up the engine generates three hours of bot history so charts are full.
Bots never trade with themselves: before sending an order they cancel their own
resting orders it would cross (self-trade prevention). Start the engine with
`--no-sim` to turn all of this off.

| Endpoint | Purpose |
|---|---|
| `GET /api/sim` | `running`, `rate` (bot commands/s), `mode`, hidden `fair_price`, `steps`, every mode with its description, and per-bot `orders` / `cancels` / `fills` / `volume`. |
| `POST /api/sim` `{"running":true,"rate":5,"mode":"bull","reseed":false}` | Any subset. `mode` is `calm`, `volatile`, `bull`, `bear` or `crash` (crash returns to calm after ~2 minutes). `rate` is 1–50. `reseed:true` clears everything and generates fresh history. |

Loading a scenario with `POST /api/scenario` pauses the bots. The stream sends
an `event: sim` message whenever the simulator settings change.

## Session, performance and debugging

| Endpoint | Purpose |
|---|---|
| `POST /api/scenario` `{"name":"worked-example","seed":42,"count":500,"reset":true}` | Load a scenario. `name` is one of `worked-example` (the 6 orders from the proposal), `worked-example-setup` (S1 to S4 only, so you submit B1 yourself), `deep-book` (`count` levels per side inserted in sorted order, which forces rotations) or `random` (seeded stream of `count` commands). |
| `POST /api/reset` | Clear the book and history. |
| `POST /api/trace` `{"enabled":true,"detailed":true,"stream":true}` | Turn tracing settings on or off. `detailed:false` keeps only market events. `enabled:false` is benchmark mode. `stream:false` stops trace events over SSE. |
| `GET /api/stats` | Latency `p50`/`p95`/`p99`/`max`/`mean` (engine ns per command, last 100k commands), throughput, book sizes, tree heights, memory estimates and every operation counter. |
| `GET /api/check` | Runs every invariant check: AVL balance, FIFO order, level totals, hash consistency and an uncrossed book. |
| `GET /api/health` | Server info, including tick size and symbol. |

Run the server with `--static path/to/frontend/dist` to also serve a built
frontend from the same port.
