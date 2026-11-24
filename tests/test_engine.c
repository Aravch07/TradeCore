/*
 * test_engine.c - Unit tests + randomized differential tests.
 *
 * Run with:  make test        (or  make asan  for memory-safety checking)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "../src/engine.h"
#include "../src/reference.h"
#include "../src/scenario.h"
#include "../src/json.h"

static int g_pass = 0, g_fail = 0;

#define CHECK(cond) do {                                                  \
    if (cond) g_pass++;                                                   \
    else { g_fail++; printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
} while (0)

#define CHECK_BOOK(e) do {                                                \
    const char *err_ = engine_check(e);                                   \
    if (err_) { g_fail++; printf("  INVARIANT %s:%d: %s\n", __FILE__, __LINE__, err_); } \
    else g_pass++;                                                        \
} while (0)

#define RS(x) ((tc_price)llround((x) * 100.0))

static const Trade *T(Engine *e, size_t i) { return engine_trade(e, i); }

/* ---------------------------------------------------------------- tests */

static void test_worked_example(void) {
    printf("worked example from the proposal\n");
    Engine e; engine_init(&e, 4096);
    tc_result s1 = engine_submit(&e, TC_SELL, RS(100), 80, "S1", 0);
    tc_result s2 = engine_submit(&e, TC_SELL, RS(100), 70, "S2", 0);
    tc_result s3 = engine_submit(&e, TC_SELL, RS(101), 100, "S3", 0);
    tc_result s4 = engine_submit(&e, TC_SELL, RS(102), 40, "S4", 0);
    CHECK(s1.cmd_seq == 1 && s4.cmd_seq == 4);
    CHECK_BOOK(&e);

    tc_result b1 = engine_submit(&e, TC_BUY, RS(101), 200, "B1", 0);
    CHECK(b1.ok && b1.n_trades == 3);
    const Trade *t0 = T(&e, b1.first_trade);
    const Trade *t1 = T(&e, b1.first_trade + 1);
    const Trade *t2 = T(&e, b1.first_trade + 2);
    CHECK(t0->maker_id == s1.order_id && t0->price == RS(100) && t0->qty == 80);
    CHECK(t1->maker_id == s2.order_id && t1->price == RS(100) && t1->qty == 70);
    CHECK(t2->maker_id == s3.order_id && t2->price == RS(101) && t2->qty == 50);
    CHECK(engine_record(&e, b1.order_id)->status == ST_FILLED);
    CHECK(engine_record(&e, s3.order_id)->remaining == 50);
    CHECK(engine_record(&e, s3.order_id)->status == ST_PARTIAL);
    CHECK(engine_record(&e, s4.order_id)->remaining == 40);
    CHECK(engine_best_ask(&e) == RS(101));
    CHECK_BOOK(&e);

    tc_result b2 = engine_submit(&e, TC_BUY, RS(101), 80, "B2", 0);
    CHECK(b2.n_trades == 1);
    CHECK(T(&e, b2.first_trade)->maker_id == s3.order_id);
    CHECK(T(&e, b2.first_trade)->qty == 50);
    CHECK(engine_best_bid(&e) == RS(101));
    CHECK(engine_best_ask(&e) == RS(102));
    CHECK(engine_record(&e, b2.order_id)->remaining == 30);
    CHECK(e.bids.best->total_qty == 30 && e.asks.best->total_qty == 40);

    /* conservation: 250 executed in 4 fills */
    tc_qty exec = 0;
    for (size_t i = 0; i < e.trades.len; i++) exec += T(&e, i)->qty;
    CHECK(e.trades.len == 4 && exec == 250);
    CHECK(280 == exec + 30 && 290 == exec + 40);
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_fifo_priority_and_partial(void) {
    printf("FIFO priority, partial maker keeps its place\n");
    Engine e; engine_init(&e, 1024);
    tc_result a = engine_submit(&e, TC_BUY, RS(50), 100, "A", 0);
    tc_result b = engine_submit(&e, TC_BUY, RS(50), 100, "B", 0);
    tc_result s = engine_submit(&e, TC_SELL, RS(50), 30, "X", 0);
    CHECK(T(&e, s.first_trade)->maker_id == a.order_id);
    CHECK(e.bids.best->head->id == a.order_id);   /* A still first */
    CHECK(e.bids.best->total_qty == 170);
    engine_submit(&e, TC_SELL, RS(50), 100, "Y", 0);  /* 70 from A, 30 from B */
    CHECK(engine_record(&e, a.order_id)->status == ST_FILLED);
    CHECK(engine_record(&e, b.order_id)->remaining == 70);
    CHECK(e.bids.best->head->id == b.order_id);
    /* a sell above the bid must not trade */
    tc_result n = engine_submit(&e, TC_SELL, RS(50.05), 10, "Z", 0);
    CHECK(n.n_trades == 0 && engine_best_ask(&e) == RS(50.05));
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_cancel_positions(void) {
    printf("cancel head / middle / tail, empty level deletion\n");
    Engine e; engine_init(&e, 1024);
    tc_id id[5];
    for (int i = 0; i < 5; i++)
        id[i] = engine_submit(&e, TC_SELL, RS(10), 10 * (i + 1), "c", 0).order_id;
    CHECK(engine_cancel(&e, id[2], 0).ok);          /* middle */
    CHECK_BOOK(&e);
    CHECK(engine_cancel(&e, id[0], 0).ok);          /* head */
    CHECK_BOOK(&e);
    CHECK(engine_cancel(&e, id[4], 0).ok);          /* tail */
    CHECK_BOOK(&e);
    CHECK(e.asks.best->count == 2 && e.asks.best->total_qty == 20 + 40);
    CHECK(e.asks.best->head->id == id[1] && e.asks.best->tail->id == id[3]);
    engine_cancel(&e, id[1], 0);
    engine_cancel(&e, id[3], 0);
    CHECK(e.asks.size == 0 && e.asks.best == NULL);  /* level removed */
    CHECK(engine_record(&e, id[3])->status == ST_CANCELLED);
    /* double cancel and unknown id */
    tc_result r = engine_cancel(&e, id[3], 0);
    CHECK(!r.ok && r.reason == RJ_NOT_ACTIVE);
    r = engine_cancel(&e, 999, 0);
    CHECK(!r.ok && r.reason == RJ_UNKNOWN_ORDER);
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_replace(void) {
    printf("replace loses priority; invalid replace changes nothing\n");
    Engine e; engine_init(&e, 1024);
    tc_id a = engine_submit(&e, TC_BUY, RS(20), 50, "A", 0).order_id;
    tc_id b = engine_submit(&e, TC_BUY, RS(20), 50, "B", 0).order_id;
    tc_result r = engine_replace(&e, a, RS(20), 60, 0);
    CHECK(r.ok && r.order_id != a && r.old_id == a);
    CHECK(engine_record(&e, a)->status == ST_REPLACED);
    CHECK(engine_record(&e, a)->replaced_by == r.order_id);
    CHECK(engine_record(&e, r.order_id)->replaces == a);
    CHECK(strcmp(engine_record(&e, r.order_id)->trader, "A") == 0);
    CHECK(e.bids.best->head->id == b);              /* A moved to back */
    CHECK(e.bids.best->tail->id == r.order_id);
    CHECK(e.bids.best->total_qty == 110);

    tc_id na = r.order_id;
    tc_result bad = engine_replace(&e, na, RS(20.01), 10, 0);   /* off-tick */
    CHECK(!bad.ok && bad.reason == RJ_PRICE_TICK);
    CHECK(engine_active(&e, na) != NULL);           /* original intact */
    CHECK(engine_record(&e, na)->status == ST_OPEN);
    bad = engine_replace(&e, na, RS(20), 0, 0);
    CHECK(!bad.ok && bad.reason == RJ_BAD_QTY);
    CHECK_BOOK(&e);

    /* a replace that crosses executes immediately */
    tc_id s = engine_submit(&e, TC_SELL, RS(21), 30, "S", 0).order_id;
    tc_result cross = engine_replace(&e, s, RS(20), 30, 0);
    CHECK(cross.ok && cross.n_trades == 1);
    CHECK(T(&e, cross.first_trade)->maker_id == b);
    CHECK(T(&e, cross.first_trade)->price == RS(20));
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_rejections(void) {
    printf("input validation\n");
    Engine e; engine_init(&e, 1024);
    CHECK(engine_submit(&e, TC_BUY, RS(10.03), 1, "", 0).reason == RJ_PRICE_TICK);
    CHECK(engine_submit(&e, TC_BUY, 0, 1, "", 0).reason == RJ_BAD_PRICE);
    CHECK(engine_submit(&e, TC_BUY, -500, 1, "", 0).reason == RJ_BAD_PRICE);
    CHECK(engine_submit(&e, TC_BUY, TC_MAX_PRICE + 5, 1, "", 0).reason == RJ_BAD_PRICE);
    CHECK(engine_submit(&e, TC_BUY, RS(10), 0, "", 0).reason == RJ_BAD_QTY);
    CHECK(engine_submit(&e, TC_BUY, RS(10), -1, "", 0).reason == RJ_BAD_QTY);
    CHECK(engine_submit(&e, (tc_side)7, RS(10), 1, "", 0).reason == RJ_BAD_SIDE);
    CHECK(e.records.len == 0 && e.ctr.rejected == 7);
    tc_result ok = engine_submit(&e, TC_BUY, RS(10), 1, "", 0);
    CHECK(ok.ok && ok.order_id == 1 && ok.cmd_seq == 8);
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_avl_balance(void) {
    printf("AVL stays balanced under sorted inserts and deletes\n");
    Engine e; engine_init(&e, 0);
    const int n = 4000;
    tc_id ids[4000];
    for (int i = 0; i < n; i++)
        ids[i] = engine_submit(&e, TC_BUY, RS(10) + i * TC_TICK_PAISE, 1, "", 0).order_id;
    CHECK(e.bids.size == (size_t)n);
    int h = avl_height(e.bids.root);
    CHECK(h <= (int)(1.45 * log2(n + 2)));
    CHECK(e.ctr.avl_rotations > 0);
    CHECK_BOOK(&e);
    for (int i = 0; i < n; i += 2) engine_cancel(&e, ids[i], 0);
    CHECK(e.bids.size == (size_t)n / 2);
    CHECK_BOOK(&e);
    /* a large sell sweeps every remaining level */
    tc_result sweep = engine_submit(&e, TC_SELL, RS(10), n, "", 0);
    CHECK(sweep.n_trades == (size_t)n / 2);
    CHECK(e.bids.size == 0 && e.asks.size == 1);
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_hash_resize(void) {
    printf("hash table growth\n");
    Engine e; engine_init(&e, 0);
    for (int i = 0; i < 50000; i++)
        engine_submit(&e, i % 2 ? TC_BUY : TC_SELL,
                      i % 2 ? RS(99) - (i % 40) * 5 : RS(101) + (i % 40) * 5, 1, "", 0);
    CHECK(e.index.size == 50000);
    CHECK(e.ctr.hash_resizes >= 6);
    CHECK(e.index.size * 4 <= e.index.cap * 3);
    for (tc_id id = 1; id <= 50000; id += 7) CHECK(engine_active(&e, id) != NULL);
    CHECK_BOOK(&e);
    engine_free(&e);
}

static void test_trace_events(void) {
    printf("trace events describe the operations\n");
    Engine e; engine_init(&e, 4096);
    engine_submit(&e, TC_SELL, RS(100), 10, "", 0);
    tc_result r = engine_submit(&e, TC_BUY, RS(100), 10, "", 0);
    int saw_fill = 0, saw_dequeue = 0, saw_remove = 0, saw_erase = 0;
    for (uint64_t s = r.first_event; s < r.end_event; s++) {
        const tc_event *ev = tracer_get(&e.tracer, s);
        CHECK(ev && ev->cmd_seq == r.cmd_seq);
        if (!ev) continue;
        saw_fill    |= ev->type == EV_FILL;
        saw_dequeue |= ev->type == EV_FIFO_DEQUEUE;
        saw_remove  |= ev->type == EV_AVL_REMOVE;
        saw_erase   |= ev->type == EV_HASH_ERASE;
    }
    CHECK(saw_fill && saw_dequeue && saw_remove && saw_erase);
    /* ring buffer overwrites oldest */
    Engine s; engine_init(&s, 16);
    for (int i = 0; i < 20; i++) engine_submit(&s, TC_BUY, RS(1) + i * 5, 1, "", 0);
    CHECK(s.tracer.count == 16);
    CHECK(tracer_get(&s.tracer, 1) == NULL);
    CHECK(tracer_get(&s.tracer, s.tracer.next_seq - 1) != NULL);
    engine_free(&s);
    engine_free(&e);
}

static void test_candles(void) {
    printf("OHLCV candles\n");
    Engine e; engine_init(&e, 0);
    engine_submit(&e, TC_SELL, RS(100), 100, "", 1000);
    engine_submit(&e, TC_SELL, RS(101), 100, "", 1000);
    engine_submit(&e, TC_BUY, RS(100), 10, "", 1500);   /* 100 x10 */
    engine_submit(&e, TC_BUY, RS(101), 100, "", 2500);  /* 100 x90, 101 x10 */
    engine_submit(&e, TC_SELL, RS(99), 5, "", 7200);    /* no bid -> rests */
    engine_submit(&e, TC_BUY, RS(102), 20, "", 7300);   /* 99 x5, 101 x15 */
    Candle *c;
    size_t n = engine_candles(&e, 1000, &c);
    CHECK(n == 3);
    CHECK(c[0].start_ms == 1000 && c[0].volume == 10 && c[0].trades == 1);
    CHECK(c[1].start_ms == 2000 && c[1].open == RS(100) && c[1].close == RS(101));
    CHECK(c[1].volume == 100 && c[1].high == RS(101));
    CHECK(c[2].start_ms == 7000 && c[2].low == RS(99) && c[2].high == RS(101));
    free(c);
    engine_free(&e);
}

/* Run engine and reference on the same stream; demand identical results. */
static void differential(uint64_t seed, int ncmds) {
    Engine e; engine_init(&e, 0);
    RefBook ref; ref_init(&ref);
    Workload w; workload_init(&w, seed, RS(100));
    if (seed % 3 == 0) w.spread_ticks = 3;     /* dense: many FIFO ties */
    if (seed % 3 == 1) w.cancel_pct = 30;      /* cancel-heavy */
    int ok = 1;
    for (int i = 0; i < ncmds && ok; i++) {
        GenCmd c = workload_next(&w);
        size_t ref_before = ref.nfills;
        tc_id rid = 0;
        int racc;
        if (c.kind == CMD_SUBMIT)      racc = ref_submit(&ref, c.side, c.price, c.qty, &rid);
        else if (c.kind == CMD_CANCEL) racc = ref_cancel(&ref, c.target);
        else                           racc = ref_replace(&ref, c.target, c.price, c.qty, &rid);
        tc_result r = workload_apply(&w, &e, &c, i);

        if (r.ok != racc) { ok = 0; printf("  seed %llu cmd %d: accept mismatch\n", (unsigned long long)seed, i); break; }
        if (racc && c.kind != CMD_CANCEL && rid != r.order_id) { ok = 0; printf("  seed %llu cmd %d: id mismatch\n", (unsigned long long)seed, i); break; }
        if (ref.nfills - ref_before != r.n_trades) { ok = 0; printf("  seed %llu cmd %d: fill count %zu vs %zu\n", (unsigned long long)seed, i, r.n_trades, ref.nfills - ref_before); break; }
        for (size_t k = 0; k < r.n_trades; k++) {
            const Trade *t = T(&e, r.first_trade + k);
            const RefFill *f = &ref.fills[ref_before + k];
            if (t->maker_id != f->maker || t->taker_id != f->taker ||
                t->price != f->price || t->qty != f->qty) {
                ok = 0;
                printf("  seed %llu cmd %d: fill %zu differs\n", (unsigned long long)seed, i, k);
                break;
            }
        }
        const char *err = engine_check(&e);
        if (err) { ok = 0; printf("  seed %llu cmd %d: %s\n", (unsigned long long)seed, i, err); }
        tc_price rp; tc_qty rq;
        int has = ref_best(&ref, TC_BUY, &rp, &rq);
        if (has != (e.bids.best != NULL) || (has && (rp != e.bids.best->price || rq != e.bids.best->total_qty))) { ok = 0; printf("  seed %llu cmd %d: best bid differs\n", (unsigned long long)seed, i); }
        has = ref_best(&ref, TC_SELL, &rp, &rq);
        if (has != (e.asks.best != NULL) || (has && (rp != e.asks.best->price || rq != e.asks.best->total_qty))) { ok = 0; printf("  seed %llu cmd %d: best ask differs\n", (unsigned long long)seed, i); }
    }
    if (ok && ref.n != e.active_orders) { ok = 0; printf("  seed %llu: resting count differs\n", (unsigned long long)seed); }

    /* quantity conservation over the whole run */
    tc_qty submitted = 0, executed = 0, resting = 0, removed = 0;
    for (size_t i = 0; i < e.records.len; i++) {
        const OrderRecord *rec = vec_at(&e.records, i);
        submitted += rec->qty;
        if (rec->status == ST_OPEN || rec->status == ST_PARTIAL) resting += rec->remaining;
        if (rec->status == ST_CANCELLED || rec->status == ST_REPLACED) removed += rec->remaining;
    }
    for (size_t i = 0; i < e.trades.len; i++) executed += T(&e, i)->qty;
    if (submitted != 2 * executed + resting + removed) { ok = 0; printf("  seed %llu: conservation broken\n", (unsigned long long)seed); }
    if (ok) g_pass++; else g_fail++;
    ref_free(&ref);
    engine_free(&e);
}

static void test_differential(void) {
    printf("differential vs linear reference matcher (30 seeds x 3000 cmds)\n");
    for (uint64_t s = 1; s <= 30; s++) differential(s, 3000);
}

static void test_reset_and_scenarios(void) {
    printf("scenarios and reset\n");
    Engine e; engine_init(&e, 1 << 16);
    CHECK(scenario_load(&e, "worked-example", 0, 0, 0) == 6);
    CHECK(e.trades.len == 4);
    CHECK_BOOK(&e);
    CHECK(engine_reset(&e) == 0);
    CHECK(e.records.len == 0 && e.bids.size == 0 && e.cmd_seq == 0);
    CHECK(scenario_load(&e, "deep-book", 0, 63, 0) == 126);
    CHECK(e.bids.size == 63 && e.asks.size == 63);
    CHECK(avl_height(e.bids.root) == 6);   /* perfectly packed */
    CHECK_BOOK(&e);
    engine_reset(&e);
    CHECK(scenario_load(&e, "random", 7, 2000, 1000000) == 2000);
    CHECK_BOOK(&e);
    CHECK(scenario_load(&e, "nope", 0, 0, 0) == -1);
    engine_free(&e);
}

static void test_json(void) {
    printf("request parsing (prices without floating point)\n");
    tc_price p;
    CHECK(parse_price_str("101", 3, &p) && p == 10100);
    CHECK(parse_price_str("101.5", 5, &p) && p == 10150);
    CHECK(parse_price_str("101.05", 6, &p) && p == 10105);
    CHECK(parse_price_str("101.050", 7, &p) && p == 10105);
    CHECK(!parse_price_str("101.055", 7, &p));
    CHECK(!parse_price_str("1e3", 3, &p));
    CHECK(!parse_price_str("", 0, &p));
    const char *body = "{ \"side\" : \"buy\", \"price\": 99.95, \"qty\":200, \"x\":true }";
    JKV kv[8];
    int n = json_parse_flat(body, strlen(body), kv, 8);
    char side[8];
    int64_t q;
    int bv;
    CHECK(n == 4);
    CHECK(json_get_str(kv, n, "side", side, sizeof side) && !strcmp(side, "buy"));
    CHECK(json_get_price(kv, n, "price", &p) && p == 9995);
    CHECK(json_get_i64(kv, n, "qty", &q) && q == 200);
    CHECK(json_get_bool(kv, n, "x", &bv) && bv == 1);
    CHECK(json_parse_flat("{\"a\":{}}", 8, kv, 8) < 0);
    CHECK(json_parse_flat("nope", 4, kv, 8) < 0);
    const char *frac = "{\"qty\":1.5}";
    n = json_parse_flat(frac, strlen(frac), kv, 8);
    CHECK(n == 1 && !json_get_i64(kv, n, "qty", &q));
}

int main(void) {
    test_json();
    test_worked_example();
    test_fifo_priority_and_partial();
    test_cancel_positions();
    test_replace();
    test_rejections();
    test_avl_balance();
    test_hash_resize();
    test_trace_events();
    test_candles();
    test_differential();
    test_reset_and_scenarios();
    printf("\n%d checks passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
