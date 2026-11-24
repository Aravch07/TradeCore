# TradeCore: a DSA-powered order-matching engine in C

A pure C11 backend for the TradeCore proposal plus a browser dashboard. The
backend has a hand-written matching engine (AVL trees, doubly linked FIFO
queues, a hash table, dynamic arrays and a ring buffer) and a small HTTP +
Server-Sent Events server. The same server also serves the dashboard in
`frontend/`, which is plain HTML, CSS and JavaScript with no build step. It
uses no external libraries and no Python.

```
React dashboard  --HTTP-->  server.c (poll loop)  -->  api.c  -->  engine.c
                 <--SSE---                                          |-- avl.c        price levels
                                                                    |-- order_list.c FIFO queues
                                                                    |-- hashmap.c    id -> order
                                                                    |-- vec.c        history arrays
                                                                    `-- trace.c      event ring buffer
```

## Quick start (macOS)

```sh
xcode-select --install      # once, if you don't have clang/make yet
make                        # builds build/tradecore, build/test_engine, build/bench
make test                   # 7,301 checks, including the proposal's worked example
make run                    # engine + dashboard on http://127.0.0.1:8080
open http://127.0.0.1:8080  # the dashboard (any browser)
sh scripts/demo.sh          # (optional, second terminal) replays the worked example with curl
```

Other targets:

- `make asan` runs the tests under AddressSanitizer and UndefinedBehaviorSanitizer.
- `make bench` runs the reproducible benchmark.
- Server flags: `./build/tradecore --port 8080 --host 127.0.0.1 --static ../frontend/dist`

The full endpoint list is in [docs/API.md](docs/API.md). How the dashboard
is organised is in [frontend/README.md](frontend/README.md).

To demo the project: open **Scenarios**, load *Worked Example TCX* and press
**Start Replay**, with the **DSA Visualizer** open in a second browser tab.

## Reading order

Read the code bottom-up. Each file is short and depends only on the ones above it.

| # | File | What to understand |
|---|---|---|
| 1 | `src/types.h` | `Order` (a FIFO node) and `PriceLevel` (an AVL node that is also a FIFO head). Prices are integer **paise**. |
| 2 | `src/order_list.c` | O(1) push_back, pop_front and unlink on a doubly linked list |
| 3 | `src/avl.c` | Rotations, rebalance, insert, and **delete by relinking nodes** (see below) |
| 4 | `src/hashmap.c` | Separate chaining, load factor 0.75, doubling resize |
| 5 | `src/vec.c` | Dynamic array with amortized O(1) push |
| 6 | `src/trace.c` | Ring buffer of trace events |
| 7 | `src/engine.c` | `match_and_rest()` is the heart of the project; also cancel, replace, invariants and candles |
| 8 | `src/reference.c` | Linear matcher used to verify the engine |
| 9 | `src/api.c`, `src/json.c`, `src/server.c` | Plumbing: HTTP, JSON and SSE |
| 10 | `frontend/js/pages/dsa.js` | How the visualizer replays the engine's trace events |

## How the data structures work together

```
bids AVL (max cached)                    asks AVL (min cached)
        [100.00]                                 [101.50]
        /      \                                 /      \
   [99.00]   [100.50] <- best bid    best ask -> [101.00]  [102.00]
                 |
                 head -> [B2 seq6] <-> [B3 seq8] <-> [B4 seq9] <- tail   (FIFO)
                                            ^
hash: id 8 --(bucket 488)-------------------+  direct pointer, so cancel needs no scanning
```

**Submit (match, then rest).**

1. Read the cached best opposite level in O(1).
2. While the order still has quantity and the prices cross, fill against that
   level's FIFO **head**.
3. A fully filled maker is popped from the head (O(1)) and erased from the hash
   (expected O(1)).
4. An emptied level is removed from the AVL tree (O(log P)).
5. Any remainder goes at the **tail** of the level for its own price (find or
   insert, O(log P)) and its id is added to the hash table.

The total cost is expected amortized **O(F + (D+1) log P)** for F fills and D
emptied levels.

**Cancel.** A hash lookup gives the order node. `fifo_unlink` bridges its
neighbours in O(1). If the level becomes empty, it is removed from the AVL
tree (O(log P)).

**Replace.** First everything is validated. If anything is invalid, nothing
changes. Otherwise the order is cancelled and resubmitted with a new id and
sequence, so it goes to the back of the queue.

**Why AVL deletion relinks nodes.** The textbook delete copies the in-order
successor's key into the node being deleted. That would break this design,
because every order holds a pointer to its `PriceLevel`. Instead,
`avl_remove` detaches the successor *node* and puts it in the deleted node's
place, so no node ever changes its price. This also keeps `node_id` stable
for the visualizer.

## Complexity summary

N is the number of active orders, P the number of price levels and H the
number of history entries.

| Operation | Cost |
|---|---|
| Best bid / best ask | O(1) (cached) |
| Find or insert a price level | O(log P) worst case |
| Add an order to a level / remove the head / unlink any order | O(1) |
| Find an order by id | expected O(1), O(N) worst case |
| Hash resize | O(N), amortized O(1) per insert |
| Cancel | expected O(1), plus O(log P) if the level empties |
| Submit | expected amortized O(F + (D+1) log P) |
| Candles | O(H) per request |
| Memory | O(N + P + H) |

## Verification

The tests are in `tests/test_engine.c`.

- **The worked example from the proposal, exactly.** It checks the fills
  80@100 (S1), 70@100 (S2), 50@101 (S3) and 50@101 (S3), the final book
  (30@101 bid, 40@102 ask) and conservation (280 = 250 + 30, 290 = 250 + 40).
- **Other rules:**
  - FIFO ties, and a partially filled maker keeping priority
  - cancelling the head, middle and tail of a queue
  - empty-level deletion
  - double cancel and unknown ids
  - replace losing priority
  - an invalid replace leaving the original intact
  - a replace that crosses the book
  - input validation
- **Stress tests:** AVL height stays under 1.45·log₂(n) with 4,000 sorted
  inserts, the hash table grows to 50k entries, the ring buffer overwrites,
  and candles are built correctly.
- **Differential testing.** 30 seeded random streams of 3,000 commands are run
  through both the engine and the linear reference matcher. The fill
  sequences, prices, quantities and best bid/ask totals must match exactly.
  `engine_check()` (every invariant from the proposal) runs after **every**
  command, and quantity conservation is checked at the end.
- `make asan` reports no leaks, use-after-free or undefined behaviour.

### Sample benchmark output

Measured in my Linux build sandbox. **Re-run `make bench` on your Mac for your
report**, and record your hardware.

```
200,000 commands, seed 42, tracing OFF, -O2
p50 ~110 ns   p95 ~300-370 ns   p99 ~460-580 ns   ~5.7M commands/s
Scaling vs linear reference (20k mixed commands on a resting book):
  N=1,000: 5x faster   N=10,000: 34x faster   N=50,000: 83x faster
```

The speedup growing with N is the empirical evidence that the engine's cost
grows like O(log P) per command while the reference grows like O(N).

## Differences from the proposal

| Proposal | This prototype | Why |
|---|---|---|
| FastAPI bridge + Python ctypes | HTTP + SSE server written in C (`server.c`) | You asked for a backend in C only. A single thread gives the "one serialized engine worker" for free. |
| React + TypeScript dashboard | Plain HTML/CSS/JavaScript modules (`frontend/`) | No Node.js or build step: the C server serves it directly, so `make run` is the whole setup. |
| WebSockets | Server-Sent Events | Updates only flow server to client (commands go over HTTP POST). SSE is plain HTTP, easier to write correctly in C, and works with the browser's built-in `EventSource`. |
| SQLite persistence + replay | In-memory only | You chose no persistence. Scenarios are seeded, so any demo can be reproduced. |
| Request-ID deduplication | Not implemented | It only matters for retries when persistence exists. |

## Owning this code

The aim is that you can explain every line, not just run it. A few things to
be ready for in a viva:

1. *Why does an order need both `prev` and `next`?* With a singly linked list,
   cancelling an order in the middle of the queue means scanning from the head
   to find its predecessor, which is O(n).
2. *The order ids are sequential. Why not use an array instead of a hash
   table?* Be honest: an array indexed by id would also work here (the
   history array does exactly that). The hash table keeps the lookup
   structure proportional to *active* orders, and it would still work if ids
   came from clients or were not sequential. Know both sides of this argument.
3. *What happens if all ids collide in one bucket?* Lookup degrades to O(N).
   `/api/dsa/hash` shows `max_chain`, so you can demonstrate that it stays small.
4. *Why integers for prices?* `0.1 + 0.2 != 0.3` in floating point.
5. *Walk through the LR rotation case on paper* using `scenario deep-book`
   and `/api/dsa/tree`.

Good exercises to do yourself, without AI:

- Add a `MARKET` order type: it crosses until filled or the book is empty, and
  never rests.
- Add a min-heap or a second AVL tree for stop orders.
- Add request-id deduplication using your own second hash table.
- Write a test for a scenario you invent, compute the expected fills by hand
  first, and then make the test pass.
