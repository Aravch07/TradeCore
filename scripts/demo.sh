#!/bin/sh
# Replays the worked example from the proposal (page 2) against a running
# server. Start the server first:  make run
# Then in another terminal:        sh scripts/demo.sh
B=${TRADECORE_URL:-http://127.0.0.1:8080}

step() { printf '\n== %s\n' "$1"; }

step "Reset the session"
curl -s -X POST "$B/api/reset"; echo

step "Rest four sell orders S1..S4"
curl -s -X POST "$B/api/orders" -d '{"side":"sell","price":100.00,"qty":80,"trader":"S1"}' >/dev/null
curl -s -X POST "$B/api/orders" -d '{"side":"sell","price":100.00,"qty":70,"trader":"S2"}' >/dev/null
curl -s -X POST "$B/api/orders" -d '{"side":"sell","price":101.00,"qty":100,"trader":"S3"}' >/dev/null
curl -s -X POST "$B/api/orders" -d '{"side":"sell","price":102.00,"qty":40,"trader":"S4"}' >/dev/null
curl -s "$B/api/book"; echo

step "B1: buy 200 @ 101.00  (expect fills 80@100 S1, 70@100 S2, 50@101 S3)"
curl -s -X POST "$B/api/orders" -d '{"side":"buy","price":101.00,"qty":200,"trader":"B1"}'; echo

step "B2: buy 80 @ 101.00  (expect 50@101 from S3, 30 rests as a bid)"
curl -s -X POST "$B/api/orders" -d '{"side":"buy","price":101.00,"qty":80,"trader":"B2"}'; echo

step "Final book  (best bid 30 @ 101.00, best ask 40 @ 102.00)"
curl -s "$B/api/book"; echo

step "Invariant check"
curl -s "$B/api/check"; echo
