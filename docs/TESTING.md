# Verification and measurement

## Reproduce

Windows: `./build.ps1 -Wasm -Test`, then `node tests/test-wasm.mjs`.

Linux/macOS: `make all test`, then `node tests/test-wasm.mjs`. A committed WASM module is supplied; after editing the engine rebuild with `make wasm`.

The C suite verifies:

- Exact maker order, execution price, FIFO sequence, partial fill and final quantities in the faculty proposal.
- Head/middle/tail cancellation, replacement losing priority and rejected replacement preserving the original.
- Invalid IDs, invalid side/price/quantity and unknown cancellations.
- Hundreds of ascending price insertions and arbitrary level removals, with AVL/link/hash invariants after each command.
- Maximum active-order capacity and 64-bit quantity totals above signed 32-bit range.
- **12,000 fixed-seed randomized submit/cancel/replace commands** against a simple linear reference matcher; active quantities and fill records are compared.
- All four scenarios and **20,000 additional simulated commands**.
- Native C/WebAssembly snapshot parity, actual hash collision, C-generated candle constraints and a WASM module with zero host imports.

Tests count individual assertions as well as command sequences. Assertion count is not a throughput metric. CI additionally requests AddressSanitizer and UndefinedBehaviorSanitizer on Linux; inspect the workflow outcome before treating a remote sanitizer run as verified.

## Browser checklist

- Engine starts successfully; no JavaScript matching fallback exists.
- Submit a noncrossing buy, cancel it, submit another and replace it. Confirm new ID/priority and persistence after reload.
- Submit crossing orders and inspect each execution; inspect the queue by clicking its level.
- Play and single-step each scenario, inspect rotations/hash collision and run the invariant checker.
- Start/pause simulated traders; switch charts and history tabs; export trades and a session.
- Import a session and compare the reconstructed book; malformed/oversized/unbounded files are rejected.
- Check narrow-screen layout, keyboard focus and horizontal scroll for wide tables and trees.

## Honest performance reporting

Browser command-call duration includes the synchronous C operation, simulator work and engine trace writes. It excludes later JSON serialization and rendering. The benchmark's 1,000-command rate includes C simulation generation, not only matching. Report device, browser/compiler, build flags, book sizes, fill counts and tracing settings with any result.

The native CLI's `bench COUNT` uses C `clock()` around simulation generation and matching; it excludes terminal output and persistence. Its resolution depends on the host. A very short run may be too small for a useful rate. Repeat with fixed seeds and state, warm up, use at least five measured runs and publish variation rather than a single headline number.

Reserved-buffer bytes are derived from C `sizeof`, not estimated process RSS. Memory is preallocated, so this number does not fall when orders are cancelled. The project does not promise exchange-scale latency, recall any experimental result from a proposal, or claim production reliability.
