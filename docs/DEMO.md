# Five-minute faculty demonstration

1. **Explain the project (30 seconds).** “TradeCore is a simulated order book. We place orders, match best prices first and use FIFO for ties. All matching and data structures are written in C.”
2. **Show the terminal (30 seconds).** Point out the fictitious TCX stock, C-generated sample trades, bid/ask depth, order entry and trade history. Pause the simulator before explaining a result.
3. **Run the proposal example (90 seconds).** Open Scenario studio, select Price-time priority and click Next command six times. S1 and S2 sell at Rs. 100; S1 executes first. The first buyer partially fills S3. The second buyer takes S3's remaining 50 and rests with 30. The final book has bid 30 @ 101 and ask 40 @ 102. Total executed volume is 250.
4. **Inspect structures (60 seconds).** Open DSA laboratory. Switch between bids and asks; click a node to inspect its FIFO. Run Check invariants. Load AVL rotations from the studio and advance three steps to show the first actual left rotation. For a hash collision, use its scenario: IDs 1 and 2049 share bucket 433.
5. **Show manual actions (30 seconds).** Start an empty session, place two same-price sell orders, cancel one or replace it. Explain that replacement gets a new ID and loses FIFO priority. Trade against the remaining order.
6. **Show continuous activity and measurements (30 seconds).** Load the sample market and start simulated traders. Pause, open Engine metrics and run 1,000 commands. Explain the measured scope and device dependence. No real users are required.
7. **Finish in the CLI (30 seconds).** Run `build/tradecore.exe --script demos/partial-fill.tcx`, then the interactive program. Use `book`, `trades`, `stats`, `check` and `help`. This is the same C engine as the website.

## Likely questions

**Why an AVL tree?** It keeps price levels ordered and balances worst-case search/update depth. Cache the best bid and ask.

**Why not just a queue?** FIFO solves fairness within one price. It cannot efficiently choose the best price among many prices.

**Why doubly linked lists and hashing together?** The hash table finds a known order; previous/next links remove it without scanning the entire price queue.

**Where is C running on Vercel?** Vercel serves a precompiled WebAssembly file. Each visitor runs that compiled C engine on their own device. Vercel is not hosting a persistent native C exchange process.

**Does it support many real users?** Visitors can independently use the website. They do not share one order book. A shared exchange backend and account ledger are future work, not part of this implementation.

**Is it all C?** The engine, CLI, local server, simulator, JSON and candle aggregation are C. The browser requires HTML/CSS and JavaScript for display, input, storage and calling WebAssembly; no matching logic lives in JavaScript.

**What proves correctness?** The C tests compare with a deliberately simple linear reference matcher, check the exact proposal example, run seeded randomized commands and verify invariants. The native/WASM test requires complete snapshot parity on multiple scenarios.
