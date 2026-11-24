#include <string.h>
#include "scenario.h"

/* xorshift64* - tiny, fast, deterministic PRNG */
void rng_seed(tc_rng *r, uint64_t seed) { r->s = seed ? seed : 0x9e3779b97f4a7c15ULL; }

uint64_t rng_next(tc_rng *r) {
    uint64_t x = r->s;
    x ^= x >> 12; x ^= x << 25; x ^= x >> 27;
    r->s = x;
    return x * 0x2545F4914F6CDD1DULL;
}

int64_t rng_range(tc_rng *r, int64_t lo, int64_t hi) {
    return lo + (int64_t)(rng_next(r) % (uint64_t)(hi - lo + 1));
}

void workload_init(Workload *w, uint64_t seed, tc_price mid) {
    rng_seed(&w->rng, seed);
    w->mid = mid;
    w->max_id = 0;
    w->submit_pct = 65;
    w->cancel_pct = 20;
    w->invalid_pct = 2;
    w->spread_ticks = 15;
}

GenCmd workload_next(Workload *w) {
    GenCmd c;
    memset(&c, 0, sizeof c);
    /* random walk of the mid price */
    int64_t step = rng_range(&w->rng, -1, 1) * TC_TICK_PAISE;
    if (w->mid + step > 100 * TC_TICK_PAISE) w->mid += step;

    int roll = (int)rng_range(&w->rng, 0, 99);
    if (w->max_id == 0 || roll < w->submit_pct) c.kind = CMD_SUBMIT;
    else if (roll < w->submit_pct + w->cancel_pct) c.kind = CMD_CANCEL;
    else c.kind = CMD_REPLACE;

    c.side = rng_range(&w->rng, 0, 1) ? TC_BUY : TC_SELL;
    c.price = w->mid + rng_range(&w->rng, -w->spread_ticks, w->spread_ticks) * TC_TICK_PAISE;
    c.qty = rng_range(&w->rng, 1, 20) * 10;
    if (c.kind != CMD_SUBMIT) {
        /* mostly recent orders (likely still resting); 5% any id incl. unknown */
        int64_t window = (int64_t)w->max_id < 300 ? (int64_t)w->max_id : 300;
        if (rng_range(&w->rng, 0, 99) < 5)
            c.target = (tc_id)rng_range(&w->rng, 1, (int64_t)w->max_id + 1);
        else
            c.target = w->max_id - (tc_id)rng_range(&w->rng, 0, window - 1);
    }
    if (rng_range(&w->rng, 0, 99) < w->invalid_pct) {
        if (rng_range(&w->rng, 0, 1)) c.price += 1;   /* off-tick */
        else c.qty = 0;                              /* bad qty  */
    }
    return c;
}

tc_result workload_apply(Workload *w, Engine *e, const GenCmd *c, int64_t now_ms) {
    tc_result r;
    switch (c->kind) {
    case CMD_SUBMIT:  r = engine_submit(e, c->side, c->price, c->qty, "sim", now_ms); break;
    case CMD_CANCEL:  r = engine_cancel(e, c->target, now_ms); break;
    default:          r = engine_replace(e, c->target, c->price, c->qty, now_ms); break;
    }
    if (r.ok && c->kind != CMD_CANCEL && r.order_id > w->max_id) w->max_id = r.order_id;
    return r;
}

#define RS(x) ((tc_price)((x) * 100))   /* rupees -> paise (integer rupees) */

long scenario_load(Engine *e, const char *name, uint64_t seed, long count,
                   int64_t now_ms) {
    if (strcmp(name, "worked-example") == 0 ||
        strcmp(name, "worked-example-setup") == 0) {
        /* The exact example from the proposal (page 2). */
        engine_submit(e, TC_SELL, RS(100), 80,  "S1", now_ms);
        engine_submit(e, TC_SELL, RS(100), 70,  "S2", now_ms);
        engine_submit(e, TC_SELL, RS(101), 100, "S3", now_ms);
        engine_submit(e, TC_SELL, RS(102), 40,  "S4", now_ms);
        if (strcmp(name, "worked-example-setup") == 0) return 4;
        engine_submit(e, TC_BUY, RS(101), 200, "B1", now_ms);
        engine_submit(e, TC_BUY, RS(101), 80,  "B2", now_ms);
        return 6;
    }
    if (strcmp(name, "deep-book") == 0) {
        /* Insert levels in sorted order: the worst case for a plain BST,
         * so the AVL tree has to rotate repeatedly to stay balanced. */
        long n = count > 0 && count <= 2000 ? count : 31;
        for (long i = 0; i < n; i++) {
            engine_submit(e, TC_BUY,  RS(100) - (i + 1) * TC_TICK_PAISE, 10 + i, "deep", now_ms);
            engine_submit(e, TC_SELL, RS(100) + (i + 1) * TC_TICK_PAISE, 10 + i, "deep", now_ms);
        }
        return 2 * n;
    }
    if (strcmp(name, "random") == 0) {
        long n = count > 0 ? count : 500;
        Workload w;
        workload_init(&w, seed ? seed : 42, RS(100));
        w.max_id = e->next_order_id - 1;
        /* spread simulated time so candles are meaningful: 250 ms apart,
         * ending at now_ms */
        int64_t t = now_ms - (int64_t)n * 250;
        if (t < e->last_time_ms) t = e->last_time_ms;
        for (long i = 0; i < n; i++, t += 250) {
            GenCmd c = workload_next(&w);
            workload_apply(&w, e, &c, t);
        }
        return n;
    }
    return -1;
}
