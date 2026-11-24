/*
 * engine.c - Matching engine: submit, cancel, replace, invariants, candles.
 *
 * Cost summary (N active orders, P price levels, F fills, D emptied levels):
 *   submit  : expected amortized O(F + (D + 1) log P)
 *   cancel  : expected O(1) to find + unlink, plus O(log P) if the level empties
 *   replace : cancel + submit
 *   best bid/ask : O(1) (cached in the AVL tree)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "engine.h"
#include "order_list.h"

/* ------------------------------------------------------------------ util */

uint64_t tc_now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

int64_t tc_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void *xmalloc(Engine *e, size_t n) {
    void *p = malloc(n);
    if (!p) { fprintf(stderr, "tradecore: out of memory\n"); abort(); }
    e->ctr.allocs++;
    return p;
}

static void xfree(Engine *e, void *p) {
    free(p);
    e->ctr.frees++;
}

const char *side_name(tc_side s) { return s == TC_BUY ? "buy" : "sell"; }

const char *status_name(tc_status s) {
    switch (s) {
    case ST_OPEN:      return "open";
    case ST_PARTIAL:   return "partial";
    case ST_FILLED:    return "filled";
    case ST_CANCELLED: return "cancelled";
    case ST_REPLACED:  return "replaced";
    }
    return "unknown";
}

const char *reject_name(tc_reject r) {
    switch (r) {
    case RJ_NONE:          return "NONE";
    case RJ_BAD_SIDE:      return "INVALID_SIDE";
    case RJ_BAD_PRICE:     return "INVALID_PRICE";
    case RJ_PRICE_TICK:    return "PRICE_NOT_TICK_ALIGNED";
    case RJ_BAD_QTY:       return "INVALID_QUANTITY";
    case RJ_UNKNOWN_ORDER: return "UNKNOWN_ORDER";
    case RJ_NOT_ACTIVE:    return "ORDER_NOT_ACTIVE";
    case RJ_NO_MEMORY:     return "OUT_OF_MEMORY";
    }
    return "UNKNOWN";
}

const char *reject_message(tc_reject r) {
    switch (r) {
    case RJ_NONE:          return "ok";
    case RJ_BAD_SIDE:      return "side must be 'buy' or 'sell'";
    case RJ_BAD_PRICE:     return "price must be > 0 and <= Rs 1,00,00,000.00";
    case RJ_PRICE_TICK:    return "price must be a multiple of the Rs 0.05 tick";
    case RJ_BAD_QTY:       return "quantity must be a whole number between 1 and 1,000,000,000";
    case RJ_UNKNOWN_ORDER: return "no order with this id exists";
    case RJ_NOT_ACTIVE:    return "order is already filled, cancelled or replaced";
    case RJ_NO_MEMORY:     return "engine ran out of memory";
    }
    return "";
}

tc_reject tc_validate(tc_price price, tc_qty qty) {
    if (price <= 0 || price > TC_MAX_PRICE) return RJ_BAD_PRICE;
    if (price % TC_TICK_PAISE != 0)         return RJ_PRICE_TICK;
    if (qty <= 0 || qty > TC_MAX_QTY)       return RJ_BAD_QTY;
    return RJ_NONE;
}

/* ------------------------------------------------------------ lifecycle */

int engine_init(Engine *e, size_t trace_capacity) {
    memset(e, 0, sizeof *e);
    if (tracer_init(&e->tracer, trace_capacity ? trace_capacity : 1) != 0)
        return -1;
    if (!trace_capacity) e->tracer.enabled = 0;
    avl_init(&e->bids, TC_BUY, &e->tracer, &e->ctr);
    avl_init(&e->asks, TC_SELL, &e->tracer, &e->ctr);
    if (hm_init(&e->index, 1024, &e->tracer, &e->ctr) != 0) return -1;
    vec_init(&e->trades, sizeof(Trade));
    vec_init(&e->records, sizeof(OrderRecord));
    e->lat_ns = calloc(TC_LAT_SAMPLES, sizeof(uint64_t));
    if (!e->lat_ns) return -1;
    e->next_order_id = 1;
    e->measure = 1;
    return 0;
}

/* Free every order node, level by level (post-order walk). */
static void free_levels(Engine *e, PriceLevel *n) {
    if (!n) return;
    free_levels(e, n->left);
    free_levels(e, n->right);
    Order *o = n->head;
    while (o) { Order *nx = o->next; xfree(e, o); o = nx; }
    n->head = n->tail = NULL;
}

static void free_book(Engine *e) {
    free_levels(e, e->bids.root);
    free_levels(e, e->asks.root);
    avl_destroy(&e->bids);
    avl_destroy(&e->asks);
    hm_free(&e->index);
}

void engine_free(Engine *e) {
    free_book(e);
    vec_free(&e->trades);
    vec_free(&e->records);
    tracer_free(&e->tracer);
    free(e->lat_ns);
    e->lat_ns = NULL;
}

int engine_reset(Engine *e) {
    free_book(e);
    vec_clear(&e->trades);
    vec_clear(&e->records);
    tracer_clear(&e->tracer);
    memset(&e->ctr, 0, sizeof e->ctr);
    avl_init(&e->bids, TC_BUY, &e->tracer, &e->ctr);
    avl_init(&e->asks, TC_SELL, &e->tracer, &e->ctr);
    if (hm_init(&e->index, 1024, &e->tracer, &e->ctr) != 0) return -1;
    e->cmd_seq = 0;
    e->next_order_id = 1;
    e->last_time_ms = 0;
    e->active_orders = 0;
    e->lat_count = e->lat_pos = 0;
    e->lat_total_ns = 0;
    return 0;
}

/* --------------------------------------------------------------- access */

const OrderRecord *engine_record(const Engine *e, tc_id id) {
    if (id == 0 || id > e->records.len) return NULL;
    return vec_at(&e->records, (size_t)(id - 1));
}

const Trade *engine_trade(const Engine *e, size_t idx) {
    if (idx >= e->trades.len) return NULL;
    return vec_at(&e->trades, idx);
}

Order *engine_active(Engine *e, tc_id id) { return hm_get(&e->index, id); }

tc_price engine_best_bid(const Engine *e) {
    return e->bids.best ? e->bids.best->price : 0;
}

tc_price engine_best_ask(const Engine *e) {
    return e->asks.best ? e->asks.best->price : 0;
}

static AvlTree *tree_of(Engine *e, tc_side s) {
    return s == TC_BUY ? &e->bids : &e->asks;
}

static OrderRecord *rec_mut(Engine *e, size_t idx) {
    return vec_at(&e->records, idx);
}

/* ------------------------------------------------- command bookkeeping */

static uint64_t g_cmd_start;

static void begin_cmd(Engine *e, tc_result *r, tc_cmd_kind kind,
                      int64_t *now_ms) {
    memset(r, 0, sizeof *r);
    r->kind = kind;
    r->cmd_seq = ++e->cmd_seq;           /* every command gets a sequence */
    e->tracer.cur_cmd = r->cmd_seq;
    r->first_event = e->tracer.next_seq;
    r->first_trade = e->trades.len;
    e->ctr.commands++;
    /* history must be time-ordered for candles: never go backwards */
    if (*now_ms < e->last_time_ms) *now_ms = e->last_time_ms;
    e->last_time_ms = *now_ms;
    if (e->measure) g_cmd_start = tc_now_ns();
}

static void end_cmd(Engine *e, tc_result *r) {
    if (e->measure) {
        r->engine_ns = tc_now_ns() - g_cmd_start;
        e->lat_ns[e->lat_pos] = r->engine_ns;
        e->lat_pos = (e->lat_pos + 1) % TC_LAT_SAMPLES;
        if (e->lat_count < TC_LAT_SAMPLES) e->lat_count++;
        e->lat_total_ns += r->engine_ns;
    }
    r->n_trades = e->trades.len - r->first_trade;
    r->end_event = e->tracer.next_seq;
    if (r->ok) e->ctr.accepted++;
    else       e->ctr.rejected++;
}

static void reject(Engine *e, tc_result *r, tc_reject why, tc_id id) {
    r->ok = 0;
    r->reason = why;
    tracer_emit(&e->tracer, EV_ORDER_REJECTED, -1, 0, id, 0, 0, why, 0);
}

/* Take an active order out of the book (cancel / replace). */
static void remove_active(Engine *e, Order *o, tc_status final_status) {
    PriceLevel *lv = o->level;
    fifo_unlink(lv, o, &e->tracer, &e->ctr);      /* O(1)              */
    hm_erase(&e->index, o->id);                   /* expected O(1)     */
    if (lv->count == 0)
        avl_remove(tree_of(e, o->side), lv);      /* O(log P) if empty */
    OrderRecord *rec = rec_mut(e, o->record);
    rec->remaining = o->remaining;
    rec->status = final_status;
    e->active_orders--;
    xfree(e, o);
}

/* ---------------------------------------------------------- matching */

/*
 * Core of the engine. Match an incoming order against the opposite side,
 * then rest whatever is left. Returns the new order id.
 */
static tc_id match_and_rest(Engine *e, tc_side side, tc_price price,
                            tc_qty qty, const char *trader, int64_t now_ms,
                            tc_id replaces) {
    tc_id id = e->next_order_id++;
    size_t rec_idx = e->records.len;
    OrderRecord *rec = vec_push(&e->records);
    if (!rec) { fprintf(stderr, "tradecore: out of memory\n"); abort(); }
    rec->id = id;
    rec->seq = e->cmd_seq;
    rec->side = side;
    rec->price = price;
    rec->qty = qty;
    rec->remaining = qty;
    rec->status = ST_OPEN;
    rec->time_ms = now_ms;
    rec->replaces = replaces;
    if (trader) {
        strncpy(rec->trader, trader, TC_TRADER_LEN - 1);
        rec->trader[TC_TRADER_LEN - 1] = '\0';
    }
    e->ctr.submits++;
    tracer_emit(&e->tracer, EV_ORDER_ACCEPTED, side, price, id, 0, qty,
                (int64_t)e->cmd_seq, 0);

    AvlTree *opp = (side == TC_BUY) ? &e->asks : &e->bids;
    tc_qty left = qty;

    /* Keep trading while there is quantity left and the prices cross. */
    while (left > 0 && opp->best) {
        PriceLevel *lv = opp->best;                       /* O(1) cached */
        int crosses = (side == TC_BUY) ? (lv->price <= price)
                                       : (lv->price >= price);
        if (!crosses) break;

        Order *maker = lv->head;                          /* FIFO head   */
        tc_qty fill = left < maker->remaining ? left : maker->remaining;

        Trade *t = vec_push(&e->trades);
        if (!t) { fprintf(stderr, "tradecore: out of memory\n"); abort(); }
        t->trade_id = e->trades.len;
        t->cmd_seq = e->cmd_seq;
        t->time_ms = now_ms;
        t->price = lv->price;          /* execute at the MAKER's price */
        t->qty = fill;
        t->maker_id = maker->id;
        t->taker_id = id;
        t->taker_side = side;
        e->ctr.fills++;

        left -= fill;
        maker->remaining -= fill;
        level_reduce(lv, fill, &e->tracer);
        tracer_emit(&e->tracer, EV_FILL, side, lv->price, id, maker->id,
                    fill, (int64_t)maker->remaining, (int64_t)left);

        OrderRecord *mrec = rec_mut(e, maker->record);
        mrec->remaining = maker->remaining;
        if (maker->remaining == 0) {
            /* maker done: dequeue from FIFO head and forget its id */
            fifo_pop_front(lv, &e->tracer, &e->ctr);
            hm_erase(&e->index, maker->id);
            mrec->status = ST_FILLED;
            tracer_emit(&e->tracer, EV_ORDER_FILLED, maker->side, maker->price,
                        maker->id, 0, 0, 0, 0);
            e->active_orders--;
            xfree(e, maker);
        } else {
            mrec->status = ST_PARTIAL;    /* keeps its place at the head */
        }
        if (lv->count == 0) avl_remove(opp, lv);  /* no empty levels */
    }

    rec = rec_mut(e, rec_idx);
    rec->remaining = left;
    if (left == 0) {
        rec->status = ST_FILLED;
        tracer_emit(&e->tracer, EV_ORDER_FILLED, side, price, id, 0, 0, 0, 0);
        return id;
    }

    /* Rest the remainder at its limit price, at the back of the queue. */
    rec->status = (left < qty) ? ST_PARTIAL : ST_OPEN;
    Order *o = xmalloc(e, sizeof *o);
    o->id = id;
    o->seq = e->cmd_seq;
    o->side = side;
    o->price = price;
    o->remaining = left;
    o->prev = o->next = NULL;
    o->record = rec_idx;
    PriceLevel *lv = avl_find_or_insert(tree_of(e, side), price);
    if (!lv) { fprintf(stderr, "tradecore: out of memory\n"); abort(); }
    fifo_push_back(lv, o, &e->tracer, &e->ctr);
    if (hm_put(&e->index, id, o) != 0) {
        fprintf(stderr, "tradecore: out of memory\n");
        abort();
    }
    e->active_orders++;
    tracer_emit(&e->tracer, EV_ORDER_RESTED, side, price, id, 0, left,
                lv->node_id, 0);
    return id;
}

tc_result engine_submit(Engine *e, tc_side side, tc_price price, tc_qty qty,
                        const char *trader, int64_t now_ms) {
    tc_result r;
    begin_cmd(e, &r, CMD_SUBMIT, &now_ms);
    tc_reject why = (side != TC_BUY && side != TC_SELL) ? RJ_BAD_SIDE
                                                        : tc_validate(price, qty);
    if (why != RJ_NONE) {
        reject(e, &r, why, 0);
    } else {
        r.ok = 1;
        r.order_id = match_and_rest(e, side, price, qty, trader, now_ms, 0);
    }
    end_cmd(e, &r);
    return r;
}

static tc_reject lookup_active(Engine *e, tc_id id, Order **out) {
    *out = hm_get(&e->index, id);
    if (*out) return RJ_NONE;
    return engine_record(e, id) ? RJ_NOT_ACTIVE : RJ_UNKNOWN_ORDER;
}

tc_result engine_cancel(Engine *e, tc_id id, int64_t now_ms) {
    tc_result r;
    begin_cmd(e, &r, CMD_CANCEL, &now_ms);
    r.order_id = id;
    Order *o;
    tc_reject why = lookup_active(e, id, &o);
    if (why != RJ_NONE) {
        reject(e, &r, why, id);
    } else {
        tc_side s = o->side;
        tc_price p = o->price;
        tc_qty rem = o->remaining;
        remove_active(e, o, ST_CANCELLED);
        e->ctr.cancels++;
        tracer_emit(&e->tracer, EV_ORDER_CANCELLED, s, p, id, 0, rem, 0, 0);
        r.ok = 1;
    }
    end_cmd(e, &r);
    return r;
}

tc_result engine_replace(Engine *e, tc_id id, tc_price new_price,
                         tc_qty new_qty, int64_t now_ms) {
    tc_result r;
    begin_cmd(e, &r, CMD_REPLACE, &now_ms);
    r.old_id = id;
    Order *o;
    /* Validate EVERYTHING first: an invalid replace must change nothing. */
    tc_reject why = lookup_active(e, id, &o);
    if (why == RJ_NONE) why = tc_validate(new_price, new_qty);
    if (why != RJ_NONE) {
        reject(e, &r, why, id);
        end_cmd(e, &r);
        return r;
    }
    tc_side side = o->side;
    size_t old_idx = o->record;
    char trader[TC_TRADER_LEN];
    memcpy(trader, rec_mut(e, old_idx)->trader, TC_TRADER_LEN);

    remove_active(e, o, ST_REPLACED);
    tracer_emit(&e->tracer, EV_ORDER_REPLACED, side, new_price, id,
                e->next_order_id, new_qty, 0, 0);
    tc_id nid = match_and_rest(e, side, new_price, new_qty, trader, now_ms, id);
    rec_mut(e, old_idx)->replaced_by = nid;  /* re-fetch: vec may have moved */
    e->ctr.replaces++;
    r.ok = 1;
    r.order_id = nid;
    end_cmd(e, &r);
    return r;
}

/* ---------------------------------------------------------- invariants */

static char g_err[256];

#define FAIL(...) do { snprintf(g_err, sizeof g_err, __VA_ARGS__); return -1; } while (0)

/*
 * Recursively verify one subtree. Returns its height, or -1 on failure.
 * lo/hi are exclusive price bounds implied by the BST property.
 */
static int check_level_tree(Engine *e, AvlTree *t, PriceLevel *n,
                            tc_price lo, tc_price hi, size_t *levels,
                            size_t *orders) {
    if (!n) return 0;
    if (n->price <= lo || n->price >= hi)
        FAIL("BST order broken at price %lld", (long long)n->price);
    int hl = check_level_tree(e, t, n->left, lo, n->price, levels, orders);
    if (hl < 0) return -1;
    int hr = check_level_tree(e, t, n->right, n->price, hi, levels, orders);
    if (hr < 0) return -1;
    int h = 1 + (hl > hr ? hl : hr);
    if (n->height != h)
        FAIL("stored height wrong at %lld", (long long)n->price);
    if (hl - hr > 1 || hr - hl > 1)
        FAIL("AVL balance factor %d at %lld", hl - hr, (long long)n->price);
    if (n->count == 0 || !n->head)
        FAIL("empty price level %lld left in tree", (long long)n->price);

    /* walk the FIFO */
    tc_qty sum = 0;
    size_t cnt = 0;
    Order *prev = NULL;
    for (Order *o = n->head; o; o = o->next) {
        if (o->prev != prev) FAIL("FIFO prev link broken at order %llu",
                                  (unsigned long long)o->id);
        if (prev && o->seq <= prev->seq)
            FAIL("FIFO sequence not increasing at order %llu",
                 (unsigned long long)o->id);
        if (o->level != n) FAIL("order %llu has wrong level pointer",
                                (unsigned long long)o->id);
        if (o->price != n->price || o->side != t->side)
            FAIL("order %llu price/side mismatch", (unsigned long long)o->id);
        if (o->remaining <= 0)
            FAIL("order %llu has non-positive remaining",
                 (unsigned long long)o->id);
        if (hm_get(&e->index, o->id) != o)
            FAIL("order %llu missing from hash table",
                 (unsigned long long)o->id);
        const OrderRecord *rec = engine_record(e, o->id);
        if (!rec || rec->remaining != o->remaining ||
            (rec->status != ST_OPEN && rec->status != ST_PARTIAL))
            FAIL("history record out of sync for order %llu",
                 (unsigned long long)o->id);
        sum += o->remaining;
        cnt++;
        prev = o;
    }
    if (prev != n->tail) FAIL("FIFO tail wrong at %lld", (long long)n->price);
    if (sum != n->total_qty)
        FAIL("level %lld total %lld != linked sum %lld", (long long)n->price,
             (long long)n->total_qty, (long long)sum);
    if (cnt != n->count) FAIL("level %lld count mismatch", (long long)n->price);
    (*levels)++;
    *orders += cnt;
    return h;
}

const char *engine_check(Engine *e) {
    tc_counters saved = e->ctr;              /* checking must not skew stats */
    const char *res = NULL;
    size_t levels, orders, total_orders = 0;
    AvlTree *trees[2] = { &e->bids, &e->asks };

    for (int i = 0; i < 2 && !res; i++) {
        AvlTree *t = trees[i];
        levels = orders = 0;
        if (check_level_tree(e, t, t->root, 0, TC_MAX_PRICE + 1,
                             &levels, &orders) < 0) {
            res = g_err;
            break;
        }
        if (levels != t->size) {
            snprintf(g_err, sizeof g_err, "%s tree size %zu != counted %zu",
                     side_name(t->side), t->size, levels);
            res = g_err;
            break;
        }
        PriceLevel *x = t->root;
        if (x) {
            if (t->is_bid) while (x->right) x = x->right;
            else           while (x->left)  x = x->left;
        }
        if (x != t->best) {
            snprintf(g_err, sizeof g_err, "cached best %s is stale",
                     side_name(t->side));
            res = g_err;
        }
        total_orders += orders;
    }
    if (!res && total_orders != e->index.size) {
        snprintf(g_err, sizeof g_err, "hash has %zu entries but book has %zu",
                 e->index.size, total_orders);
        res = g_err;
    }
    if (!res && total_orders != e->active_orders) {
        snprintf(g_err, sizeof g_err, "active order counter out of sync");
        res = g_err;
    }
    if (!res && e->bids.best && e->asks.best &&
        e->bids.best->price >= e->asks.best->price) {
        snprintf(g_err, sizeof g_err, "book is crossed: bid %lld >= ask %lld",
                 (long long)e->bids.best->price, (long long)e->asks.best->price);
        res = g_err;
    }
    e->ctr = saved;
    return res;
}

/* -------------------------------------------------------------- candles */

size_t engine_candles(const Engine *e, int64_t interval_ms, Candle **out) {
    *out = NULL;
    if (interval_ms <= 0 || e->trades.len == 0) return 0;
    size_t cap = 64, n = 0;
    Candle *c = malloc(cap * sizeof *c);
    if (!c) return 0;
    for (size_t i = 0; i < e->trades.len; i++) {
        const Trade *t = vec_at(&e->trades, i);
        int64_t start = t->time_ms - (t->time_ms % interval_ms);
        if (n == 0 || c[n - 1].start_ms != start) {
            if (n == cap) {
                cap *= 2;
                Candle *nc = realloc(c, cap * sizeof *c);
                if (!nc) break;
                c = nc;
            }
            Candle *k = &c[n++];
            k->start_ms = start;
            k->open = k->high = k->low = k->close = t->price;
            k->volume = 0;
            k->trades = 0;
        }
        Candle *k = &c[n - 1];
        if (t->price > k->high) k->high = t->price;
        if (t->price < k->low)  k->low = t->price;
        k->close = t->price;
        k->volume += t->qty;
        k->trades++;
    }
    *out = c;
    return n;
}
