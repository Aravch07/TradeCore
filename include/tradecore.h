#ifndef TRADECORE_H
#define TRADECORE_H

/* Fixed-capacity pools make ownership explicit and avoid pointer invalidation.
 * Indices are stable references: -1 is the null link. Prices are integer paise. */
#define TC_MAX_ORDERS 8192
#define TC_MAX_LEVELS 2048
#define TC_HASH_BUCKETS 2048
#define TC_HISTORY 2048
#define TC_EVENTS 128
#define TC_BUY 0
#define TC_SELL 1
#define TC_MANUAL 0
#define TC_BOT 1

typedef struct {
    int id, side, price, initial, remaining, sequence, owner;
    int prev, next, hash_next, level, used, prev_active, next_active;
} TCOrder;
typedef struct {
    int price, side, left, right, height, head, tail, count, used;
    long long total;
} TCLevel;
typedef struct { int id, maker, taker, price, quantity, side, sequence; } TCTrade;
typedef struct { int code, order, price, quantity, side, sequence, serial; } TCEvent;
typedef struct { int id, side, price, initial, remaining, sequence, owner, state; } TCRecord;
typedef struct {
    int commands, accepted, rejected, fills, active, levels, rotations;
    long long volume;
    int comparisons, hash_probes, last_price, bid, ask, sequence, scenario_step, scenario;
    unsigned int seed;
    unsigned long reserved_bytes;
} TCStats;

void tc_reset(unsigned int seed);
int tc_submit(int side, int price, int quantity, int owner);
int tc_cancel(int id);
int tc_replace(int id, int price, int quantity);
void tc_seed_market(void);
void tc_simulate(int count);
void tc_scenario(int scenario);
int tc_scenario_next(void);
int tc_check(void);
const char *tc_error(void);
const char *tc_snapshot(void);
const char *tc_queue(int side, int price);
const TCStats *tc_stats(void);
const TCOrder *tc_find_order(int id);
const TCOrder *tc_orders(void);
const TCLevel *tc_levels(void);
int tc_root(int side);
int tc_trade_count(void);
const TCTrade *tc_trade_at(int chronological_index);

#endif
