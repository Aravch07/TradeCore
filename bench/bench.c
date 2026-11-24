/*
 * bench.c - Reproducible engine benchmark.
 *
 * Protocol (as in the proposal): identical seeded stream, warm-up run, then
 * at least 5 measured runs; report p50/p95/p99 per-command engine time,
 * throughput, book size and operation counts. Tracing is OFF (benchmark
 * mode). The linear reference matcher runs the same stream for comparison.
 *
 * Usage: ./build/bench [commands] [seed] [runs]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "../src/engine.h"
#include "../src/reference.h"
#include "../src/scenario.h"

static int cmp_u64(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return x < y ? -1 : x > y;
}

static uint64_t pct(uint64_t *sorted, size_t n, double p) {
    size_t i = (size_t)ceil(p / 100.0 * (double)n);
    if (i == 0) i = 1;
    return sorted[i - 1];
}

typedef struct { double p50, p95, p99, mean, total_ms, cps; } RunStats;

static RunStats run_engine(long n, uint64_t seed, Engine *keep) {
    Engine e; engine_init(&e, 0);          /* tracing disabled */
    e.measure = 0;                          /* we time externally */
    Workload w; workload_init(&w, seed, 10000);
    uint64_t *lat = malloc((size_t)n * sizeof *lat);
    GenCmd *cmds = malloc((size_t)n * sizeof *cmds);
    /* pre-generate so RNG cost is not measured; ids depend on results so
     * we regenerate targets from the live max_id */
    uint64_t start = tc_now_ns();
    for (long i = 0; i < n; i++) {
        cmds[i] = workload_next(&w);
        uint64_t t0 = tc_now_ns();
        workload_apply(&w, &e, &cmds[i], i);
        lat[i] = tc_now_ns() - t0;
    }
    uint64_t total = tc_now_ns() - start;
    qsort(lat, (size_t)n, sizeof *lat, cmp_u64);
    double sum = 0;
    for (long i = 0; i < n; i++) sum += (double)lat[i];
    RunStats s = { (double)pct(lat, n, 50), (double)pct(lat, n, 95),
                   (double)pct(lat, n, 99), sum / n, total / 1e6,
                   n / (sum / 1e9) };
    free(lat);
    free(cmds);
    if (keep) *keep = e; else engine_free(&e);
    return s;
}

static double run_reference(long n, uint64_t seed) {
    RefBook b; ref_init(&b);
    Workload w; workload_init(&w, seed, 10000);
    uint64_t t0 = tc_now_ns();
    for (long i = 0; i < n; i++) {
        GenCmd c = workload_next(&w);
        tc_id id = 0;
        int ok;
        if (c.kind == CMD_SUBMIT)      ok = ref_submit(&b, c.side, c.price, c.qty, &id);
        else if (c.kind == CMD_CANCEL) ok = ref_cancel(&b, c.target);
        else                           ok = ref_replace(&b, c.target, c.price, c.qty, &id);
        if (ok && c.kind != CMD_CANCEL && id > w.max_id) w.max_id = id;
    }
    double ms = (tc_now_ns() - t0) / 1e6;
    ref_free(&b);
    return ms;
}

static void scaling(void) {
    printf("\nScaling with book depth (resting book of N orders, then 20k mixed cmds)\n");
    printf("%10s %8s %12s %12s %12s\n", "N resting", "P levels", "engine ns", "ref ns", "speedup");
    long sizes[] = { 1000, 10000, 50000 };
    for (int k = 0; k < 3; k++) {
        long N = sizes[k];
        Engine e; engine_init(&e, 0); e.measure = 0;
        RefBook b; ref_init(&b);
        tc_id id;
        /* deep non-crossing book: bids below 100, asks above, many levels */
        for (long i = 0; i < N; i++) {
            tc_side s = i % 2 ? TC_BUY : TC_SELL;
            tc_price p = s == TC_BUY ? 10000 - 5 * (1 + (i / 2) % 2000)
                                     : 10000 + 5 * (1 + (i / 2) % 2000);
            engine_submit(&e, s, p, 10, "", 0);
            ref_submit(&b, s, p, 10, &id);
        }
        Workload w1, w2;
        workload_init(&w1, 99, 10000); w1.max_id = (tc_id)N;
        workload_init(&w2, 99, 10000); w2.max_id = (tc_id)N;
        w1.submit_pct = w2.submit_pct = 50; w1.cancel_pct = w2.cancel_pct = 40;
        uint64_t t0 = tc_now_ns();
        for (int i = 0; i < 20000; i++) { GenCmd c = workload_next(&w1); workload_apply(&w1, &e, &c, 0); }
        double en = (double)(tc_now_ns() - t0) / 20000;
        t0 = tc_now_ns();
        for (int i = 0; i < 20000; i++) {
            GenCmd c = workload_next(&w2);
            int ok;
            if (c.kind == CMD_SUBMIT)      ok = ref_submit(&b, c.side, c.price, c.qty, &id);
            else if (c.kind == CMD_CANCEL) ok = ref_cancel(&b, c.target);
            else                           ok = ref_replace(&b, c.target, c.price, c.qty, &id);
            if (ok && c.kind != CMD_CANCEL && id > w2.max_id) w2.max_id = id;
        }
        double rn = (double)(tc_now_ns() - t0) / 20000;
        printf("%10ld %8zu %12.0f %12.0f %11.1fx\n", N, e.bids.size + e.asks.size, en, rn, rn / en);
        engine_free(&e);
        ref_free(&b);
    }
}

int main(int argc, char **argv) {
    long n = argc > 1 ? atol(argv[1]) : 200000;
    uint64_t seed = argc > 2 ? strtoull(argv[2], NULL, 10) : 42;
    int runs = argc > 3 ? atoi(argv[3]) : 5;
    if (n <= 0 || runs <= 0) { fprintf(stderr, "usage: bench [commands] [seed] [runs]\n"); return 1; }

    printf("TradeCore engine benchmark\n");
    printf("workload: %ld commands, seed %llu, mix 65%% submit / 20%% cancel / 15%% replace,\n"
           "          2%% invalid, prices mid +/- 15 ticks, tracing OFF\n",
           n, (unsigned long long)seed);
    printf("build: %s, sizeof(Order)=%zu sizeof(PriceLevel)=%zu sizeof(HEntry)=%zu\n\n",
#ifdef __OPTIMIZE__
           "optimized",
#else
           "debug",
#endif
           sizeof(Order), sizeof(PriceLevel), sizeof(HEntry));

    run_engine(n / 10 > 0 ? n / 10 : 1, seed, NULL);   /* warm-up */

    printf("%4s %9s %9s %9s %9s %12s\n", "run", "p50 ns", "p95 ns", "p99 ns", "mean ns", "cmds/s");
    double p50s[64], cps[64];
    Engine last;
    for (int r = 0; r < runs && r < 64; r++) {
        RunStats s = run_engine(n, seed, r == runs - 1 ? &last : NULL);
        p50s[r] = s.p50; cps[r] = s.cps;
        printf("%4d %9.0f %9.0f %9.0f %9.1f %12.0f\n", r + 1, s.p50, s.p95, s.p99, s.mean, s.cps);
    }
    double m = 0, sd = 0;
    for (int r = 0; r < runs; r++) m += cps[r];
    m /= runs;
    for (int r = 0; r < runs; r++) sd += (cps[r] - m) * (cps[r] - m);
    sd = sqrt(sd / runs);
    printf("throughput mean %.0f cmds/s, std dev %.1f%%\n", m, 100 * sd / m);
    (void)p50s;

    const tc_counters *c = &last.ctr;
    printf("\nFinal book (last run): N=%zu active orders, P=%zu levels (bids %zu, asks %zu), H=%zu fills\n",
           last.active_orders, last.bids.size + last.asks.size, last.bids.size,
           last.asks.size, last.trades.len);
    printf("operations: accepted %llu, rejected %llu, fills %llu, cancels %llu, replaces %llu\n",
           (unsigned long long)c->accepted, (unsigned long long)c->rejected,
           (unsigned long long)c->fills, (unsigned long long)c->cancels,
           (unsigned long long)c->replaces);
    printf("AVL: %llu rotations, %llu inserts, %llu removes, %llu node visits\n",
           (unsigned long long)c->avl_rotations, (unsigned long long)c->avl_inserts,
           (unsigned long long)c->avl_removes, (unsigned long long)c->avl_visits);
    printf("hash: %llu lookups, %.3f probes/lookup, %llu resizes, capacity %zu, load %.2f\n",
           (unsigned long long)c->hash_lookups,
           c->hash_lookups ? (double)c->hash_probes / c->hash_lookups : 0.0,
           (unsigned long long)c->hash_resizes, last.index.cap,
           (double)last.index.size / last.index.cap);
    size_t book_bytes = last.active_orders * (sizeof(Order) + sizeof(HEntry)) +
                        (last.bids.size + last.asks.size) * sizeof(PriceLevel) +
                        last.index.cap * sizeof(HEntry *);
    printf("memory: book ~%zu bytes (%.1f bytes per active order incl. hash), history %zu bytes\n",
           book_bytes, last.active_orders ? (double)book_bytes / last.active_orders : 0.0,
           last.trades.cap * sizeof(Trade) + last.records.cap * sizeof(OrderRecord));
    engine_free(&last);

    long rn = n < 50000 ? n : 50000;
    double ref_ms = run_reference(rn, seed);
    Engine tmp;
    RunStats es = run_engine(rn, seed, &tmp);
    engine_free(&tmp);
    printf("\nReference matcher on first %ld commands: %.1f ms vs engine %.1f ms\n",
           rn, ref_ms, es.total_ms);
    scaling();
    return 0;
}
