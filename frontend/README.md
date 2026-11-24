# TradeCore dashboard (frontend)

This is plain HTML, CSS and JavaScript (ES modules), with no framework and no
build step. The C engine serves it:

```sh
make run          # from the project root: ./build/tradecore --port 8080 --static frontend
# then open http://127.0.0.1:8080
```

ES modules don't load from `file://`, so open the page through the server and
not by double-clicking `index.html`. To serve the frontend from somewhere
else, set **Settings → Engine & API → Engine URL** to `http://127.0.0.1:8080`.
The engine sends CORS headers.

## Layout

```
frontend/
├── index.html          shell: sidebar + top bar + <main id="view">
├── css/style.css       design tokens (colours, spacing), dark + light theme, all components
├── fonts/              Newsreader (SIL Open Font License), bundled so it works offline
├── img/                logo, Lucide icon licence
└── js/
    ├── app.js          router (#/page), top bar, notifications, live refresh
    ├── api.js          fetch wrapper + Server-Sent Events stream (/api/stream)
    ├── store.js        settings saved in localStorage + a tiny event bus
    ├── ui.js           formatting (₹, times, ns), toasts, modal, aggregation
    ├── charts.js       hand-written SVG charts: area, candles, bars, depth
    ├── icons.js        Lucide icons (ISC licence) as inline SVG
    └── pages/          one file per sidebar entry
        overview.js  terminal.js  orderbook.js  charts.js  dsa.js
        orders.js    history.js   performance.js  scenarios.js  settings.js
```

Each page module exports `html()` (static markup), `mount()` (wire events),
`refresh()` (fetch data and update the DOM) and `unmount()`. `app.js` calls
`refresh()` whenever the engine streams a command, debounced to 120 ms.

## Where the screens differ from the mockups

The layout, colours and typography follow the supplied designs. A few panels
showed things this engine does not have. Displaying invented numbers in an
academic project would be misleading, so each of those panels shows the
closest **real** measurement in the same place:

| Mockup | Dashboard | Why |
|---|---|---|
| TCX/USD with $ prices | TCX/INR in ₹ throughout | The proposal prices TCX in rupees; the mockups mixed $ and ₹ |
| 24H High/Low/Volume | Session high/low/volume | A simulated session, not 24 hours of trading |
| Funding rate | Last fill / VWAP / spread | There are no perpetual futures in scope |
| Market and Stop-Limit buttons | Shown but disabled | The proposal limits scope to limit orders |
| Available balance ₹54,250 | Trader label | There is no cash ledger (out of scope) |
| Thread pool, 16 cores | Operation mix of the single engine thread | The engine is deliberately single-threaded |
| GC pauses, 1.24 GB heap | Live heap blocks (allocs − frees), book/history memory | C has no garbage collector; these are the real counters |
| "Zero memory leaks over 168h" | Live result of `/api/check` (all invariants) | A claim the dashboard can actually verify |
| Default leverage 1x/5x/10x/20x | Default order quantity | There is no margin trading |
| WebSocket settings | Server-Sent Events settings | The engine streams over SSE |
| Flash Crunch / HF Arbitrage presets | AVL stress, cancel/replace drill, random flow | Scenarios that demonstrate the course's data structures |

The **Trade History** page and the redesigned **DSA Visualizer** use the same
cards, page header, stat tiles and tables as the other pages.

## How the DSA Visualizer works

1. It fetches a **snapshot** of both AVL trees (`/api/dsa/tree`), the hash
   table (`/api/dsa/hash`) and the selected price level's queue
   (`/api/book/level`).
2. Every engine command streams its ordered **trace events** (AVL visits,
   rotations, FIFO enqueue/dequeue/unlink, hash insert/erase, fills).
3. Playback steps through those events on the snapshot taken *before* the
   command. It highlights the node, queue entry or bucket each event touches
   and explains the event in plain words.
4. When a command's events are done, a new snapshot shows the resulting shape.

Play, pause, single-step and speed controls change only the playback; the
engine itself always runs at full speed.
