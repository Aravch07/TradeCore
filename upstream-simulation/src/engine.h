/*
 * engine.h - The TradeCore order book and matching engine (one symbol).
 *
 * Rules (from the proposal):
 *   - Price-time priority: best price first; FIFO by engine sequence within
 *     a price.
 *   - Executions happen at the RESTING (maker) order's price.
 *   - Good-till-cancelled limit orders; remainders rest at their limit;
 *     partially filled makers keep their place in the queue.
 *   - Cancel removes the remainder.
 *   - Replace = cancel-and-replace: new id and sequence, priority is lost;
 *     an invalid replacement leaves the original untouched.
 */
#ifndef TC_ENGINE_H
#define TC_ENGINE_H

#include "types.h"
#include "trace.h"
#include "avl.h"
#include "hashmap.h"
#include "vec.h"

/* One execution between a resting maker and an incoming taker. */
typedef struct {
    uint64_t trade_id;
    tc_seq   cmd_seq;
    int64_t  time_ms;
    tc_price price;
    tc_qty   qty;
    tc_id    maker_id;
    tc_id    taker_id;
    tc_side  taker_side;
} Trade;

/* Permanent history record of every accepted order (index = id - 1). */
typedef struct {
    tc_id    id;
    tc_seq   seq;
    tc_side  side;
    tc_price price;
    tc_qty   qty;          /* original quantity */
    tc_qty   remaining;
    tc_status status;
    int64_t  time_ms;
    tc_id    replaces;     /* id of the order this one replaced, or 0 */
    tc_id    replaced_by;  /* id of the replacement, or 0             */
    char     trader[TC_TRADER_LEN];  /* display label (account name, bot or scenario role) */
    char     owner[TC_TRADER_LEN];   /* account allowed to cancel / replace it          */
} OrderRecord;

typedef struct {
    int64_t  start_ms;
    tc_price open, high, low, close;
    tc_qty   volume;
    uint32_t trades;
} Candle;

typedef enum {
    RJ_NONE = 0,
    RJ_BAD_SIDE, RJ_BAD_PRICE, RJ_PRICE_TICK, RJ_BAD_QTY,
    RJ_UNKNOWN_ORDER, RJ_NOT_ACTIVE, RJ_NO_MEMORY
} tc_reject;

typedef enum { CMD_SUBMIT, CMD_CANCEL, CMD_REPLACE } tc_cmd_kind;

/* Result of one command. Holds indices/ids only - no raw pointers. */
typedef struct {
    int       ok;
    tc_reject reason;
    tc_cmd_kind kind;
    tc_seq    cmd_seq;
    tc_id     order_id;      /* new/target order id (0 if rejected submit) */
    tc_id     old_id;        /* replace: the original order                 */
    size_t    first_trade;   /* trades[first_trade .. first_trade+n_trades) */
    size_t    n_trades;
    uint64_t  first_event;   /* trace events [first_event, end_event)       */
    uint64_t  end_event;
    uint64_t  engine_ns;     /* time spent inside the engine                */
} tc_result;

#define TC_LAT_SAMPLES 100000

typedef struct {
    AvlTree  bids, asks;
    HashMap  index;          /* active order id -> Order node */
    Vec      trades;         /* Trade       */
    Vec      records;        /* OrderRecord */
    Tracer   tracer;
    tc_counters ctr;
    tc_seq   cmd_seq;
    tc_id    next_order_id;
    int64_t  last_time_ms;
    size_t   active_orders;
    /* latency ring buffer (engine-only time per command) */
    uint64_t *lat_ns;
    size_t    lat_count, lat_pos;
    uint64_t  lat_total_ns;
    int       measure;       /* time each command? */
} Engine;

int  engine_init(Engine *e, size_t trace_capacity);
void engine_free(Engine *e);
int  engine_reset(Engine *e);

tc_reject tc_validate(tc_price price, tc_qty qty);

tc_result engine_submit(Engine *e, tc_side side, tc_price price, tc_qty qty,
                        const char *trader, int64_t now_ms);
/* Same as engine_submit, but the order's label and owning account differ
 * (e.g. a scenario order labelled "S1" placed by user "demo"). */
tc_result engine_submit_as(Engine *e, tc_side side, tc_price price, tc_qty qty,
                           const char *trader, const char *owner, int64_t now_ms);
tc_result engine_cancel(Engine *e, tc_id id, int64_t now_ms);
tc_result engine_replace(Engine *e, tc_id id, tc_price new_price,
                         tc_qty new_qty, int64_t now_ms);

const OrderRecord *engine_record(const Engine *e, tc_id id);
const Trade       *engine_trade(const Engine *e, size_t idx);
Order             *engine_active(Engine *e, tc_id id);
tc_price engine_best_bid(const Engine *e);   /* 0 if empty */
tc_price engine_best_ask(const Engine *e);   /* 0 if empty */

/* Check every invariant listed in the proposal. NULL = all good. */
const char *engine_check(Engine *e);

/* Build OHLCV candles from the fill history: O(H). Caller frees *out. */
size_t engine_candles(const Engine *e, int64_t interval_ms, Candle **out);

const char *reject_name(tc_reject r);
const char *reject_message(tc_reject r);
const char *status_name(tc_status s);
const char *side_name(tc_side s);
uint64_t    tc_now_ns(void);
int64_t     tc_now_ms(void);

#endif
