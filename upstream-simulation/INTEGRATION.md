# Aaryaman’s updated simulation

Source: https://github.com/Aaryaman-25/TradeCore
Imported commit: f30903cc7a7b663691e7fa62e9c312b48046aa62

The Simulation option at `/simulation/` preserves the upstream four-section GUI,
sign-in, 12 bot traders, three hours of seeded history, market moods, scenarios,
and DSA visualizer. Demo login: **demo / demo1234**; the second upstream account
is **student / student123**.

The original source is kept here. `frontend/simulation/` contains its served
frontend plus an adapter. `scripts/build-simulation.mjs` compiles the C engine,
auth, simulation and API to WebAssembly, applying wasm32 timestamp portability
fixes in a generated build copy. Browser crypto supplies secure random bytes.
The actual bot loop runs in a background worker; matching is still upstream C.

This standalone learning simulation is separate from the persistent shared
exchange. Its accounts and market live in the tab and reset on reload. Its
username-based demo logins are distinct from the main exchange's email accounts.
No Render service or external engine URL is required for the default mode.
