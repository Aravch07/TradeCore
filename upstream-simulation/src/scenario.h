/*
 * scenario.h - Seeded workloads and classroom scenarios.
 *
 * The same seed always produces the same command stream, so tests,
 * benchmarks and demos are reproducible.
 */
#ifndef TC_SCENARIO_H
#define TC_SCENARIO_H

#include "engine.h"

typedef struct { uint64_t s; } tc_rng;

void     rng_seed(tc_rng *r, uint64_t seed);
uint64_t rng_next(tc_rng *r);
int64_t  rng_range(tc_rng *r, int64_t lo, int64_t hi);   /* inclusive */

typedef struct {
    tc_cmd_kind kind;
    tc_side  side;
    tc_price price;
    tc_qty   qty;
    tc_id    target;      /* cancel / replace */
} GenCmd;

typedef struct {
    tc_rng   rng;
    tc_price mid;          /* drifting "fair" price */
    tc_id    max_id;       /* highest order id handed out so far (caller updates) */
    int      submit_pct, cancel_pct;   /* rest = replace */
    int      invalid_pct;  /* % of submits made deliberately invalid */
    int      spread_ticks; /* prices drawn from mid +/- spread_ticks */
} Workload;

void   workload_init(Workload *w, uint64_t seed, tc_price mid);
GenCmd workload_next(Workload *w);
/* Run one generated command on the engine (updates w->max_id). */
tc_result workload_apply(Workload *w, Engine *e, const GenCmd *c, int64_t now_ms);

/*
 * Load a named scenario: "worked-example", "worked-example-setup",
 * "deep-book", "random". Returns number of commands, or -1 if unknown.
 */
long scenario_load(Engine *e, const char *name, uint64_t seed, long count,
                   int64_t now_ms);

#endif
