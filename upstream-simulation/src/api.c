/*
 * api.c - REST endpoints. See docs/API.md for the full reference.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "api.h"
#include "scenario.h"

#define TRACE_CAPACITY   (1u << 18)    /* 262,144 events kept in the ring */
#define SSE_TRACE_LIMIT  2000          /* max trace events pushed per command */

/* The signed-in user for the request being handled (NULL if anonymous). */
static const User *g_user = NULL;
static void broadcast_sim(ApiState *s, Buf *b);

int api_init(ApiState *s, int with_sim) {
    memset(s, 0, sizeof *s);
    if (engine_init(&s->engine, TRACE_CAPACITY) != 0) return -1;
    if (auth_init(&s->auth) != 0) return -1;
    s->stream_trace = 1;
    s->started_ms = tc_now_ms();
    /* demo accounts so the login page works out of the box */
    auth_register(&s->auth, "demo", "demo1234", 1, s->started_ms);
    auth_register(&s->auth, "student", "student123", 1, s->started_ms);
    sim_init(&s->sim, (uint64_t)s->started_ms);
    if (with_sim) {
        /* three hours of bot trading so the charts start full */
        sim_seed_history(&s->sim, &s->engine, s->started_ms - 3 * 3600 * 1000LL, s->started_ms - 1000, 6000);
        s->sim.running = 1;
        s->sim.next_tick_ms = s->started_ms + 500;
        s->engine.lat_count = s->engine.lat_pos = 0;   /* latency stats: live only */
        s->engine.lat_total_ns = 0;
    }
    return 0;
}

void api_free(ApiState *s) { engine_free(&s->engine); auth_free(&s->auth); }

/* ----------------------------------------------------------- helpers */

static int query_get(const char *q, const char *key, char *out, size_t cap) {
    if (!q) return 0;
    size_t kl = strlen(key);
    const char *p = q;
    while (*p) {
        const char *amp = strchr(p, '&');
        size_t len = amp ? (size_t)(amp - p) : strlen(p);
        if (len > kl && p[kl] == '=' && strncmp(p, key, kl) == 0) {
            size_t vl = len - kl - 1, j = 0;
            for (size_t i = 0; i < vl && j + 1 < cap; i++) {
                char c = p[kl + 1 + i];
                if (c == '+') c = ' ';
                out[j++] = c;
            }
            out[j] = '\0';
            return 1;
        }
        if (!amp) break;
        p = amp + 1;
    }
    return 0;
}

static long query_long(const char *q, const char *key, long def, long lo, long hi) {
    char v[32];
    if (!query_get(q, key, v, sizeof v)) return def;
    char *end;
    long x = strtol(v, &end, 10);
    if (*end || end == v) return def;
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    return x;
}

static int parse_side(const char *v, tc_side *out) {
    if (!strcasecmp(v, "buy") || !strcasecmp(v, "bid") || !strcasecmp(v, "b")) { *out = TC_BUY; return 1; }
    if (!strcasecmp(v, "sell") || !strcasecmp(v, "ask") || !strcasecmp(v, "s")) { *out = TC_SELL; return 1; }
    return 0;
}

static void error_json(ApiResponse *r, int status, const char *code, const char *msg) {
    r->status = status;
    buf_reset(&r->body);
    buf_puts(&r->body, "{\"ok\":false,\"error\":");
    buf_json_str(&r->body, code);
    buf_puts(&r->body, ",\"message\":");
    buf_json_str(&r->body, msg);
    buf_puts(&r->body, "}");
}

static void put_price_or_null(Buf *b, tc_price p) {
    if (p > 0) buf_price(b, p); else buf_puts(b, "null");
}

static void put_record(Buf *b, const OrderRecord *o) {
    buf_printf(b, "{\"id\":%llu,\"seq\":%llu,\"side\":\"%s\",\"price\":",
               (unsigned long long)o->id, (unsigned long long)o->seq, side_name(o->side));
    buf_price(b, o->price);
    buf_printf(b, ",\"qty\":%lld,\"remaining\":%lld,\"filled\":%lld,\"status\":\"%s\",\"trader\":",
               (long long)o->qty,
               (long long)((o->status == ST_OPEN || o->status == ST_PARTIAL) ? o->remaining : 0),
               (long long)(o->qty - o->remaining), status_name(o->status));
    buf_json_str(b, o->trader);
    buf_puts(b, ",\"owner\":");
    buf_json_str(b, o->owner);
    buf_printf(b, ",\"time_ms\":%lld,\"replaces\":%llu,\"replaced_by\":%llu}",
               (long long)o->time_ms, (unsigned long long)o->replaces,
               (unsigned long long)o->replaced_by);
}

static void put_trade(Buf *b, const Engine *e, const Trade *t) {
    const OrderRecord *mk = engine_record(e, t->maker_id);
    const OrderRecord *tk = engine_record(e, t->taker_id);
    tc_id buy  = t->taker_side == TC_BUY ? t->taker_id : t->maker_id;
    tc_id sell = t->taker_side == TC_BUY ? t->maker_id : t->taker_id;
    buf_printf(b, "{\"trade_id\":%llu,\"cmd_seq\":%llu,\"time_ms\":%lld,\"price\":",
               (unsigned long long)t->trade_id, (unsigned long long)t->cmd_seq,
               (long long)t->time_ms);
    buf_price(b, t->price);
    buf_printf(b, ",\"qty\":%lld,\"maker_id\":%llu,\"taker_id\":%llu,"
               "\"buy_order_id\":%llu,\"sell_order_id\":%llu,\"taker_side\":\"%s\",",
               (long long)t->qty, (unsigned long long)t->maker_id,
               (unsigned long long)t->taker_id, (unsigned long long)buy,
               (unsigned long long)sell, side_name(t->taker_side));
    buf_puts(b, "\"maker_trader\":");
    buf_json_str(b, mk ? mk->trader : "");
    buf_puts(b, ",\"taker_trader\":");
    buf_json_str(b, tk ? tk->trader : "");
    buf_puts(b, ",\"maker_owner\":");
    buf_json_str(b, mk ? mk->owner : "");
    buf_puts(b, ",\"taker_owner\":");
    buf_json_str(b, tk ? tk->owner : "");
    buf_puts(b, "}");
}

static void put_event(Buf *b, const tc_event *ev) {
    buf_printf(b, "{\"seq\":%llu,\"cmd_seq\":%llu,\"type\":\"%s\"",
               (unsigned long long)ev->seq, (unsigned long long)ev->cmd_seq,
               event_type_name(ev->type));
    if (ev->side == TC_BUY || ev->side == TC_SELL)
        buf_printf(b, ",\"side\":\"%s\"", side_name((tc_side)ev->side));
    if (ev->price) { buf_puts(b, ",\"price\":"); buf_price(b, ev->price); }
    if (ev->order_id) buf_printf(b, ",\"order_id\":%llu", (unsigned long long)ev->order_id);
    long long a = (long long)ev->a, bb = (long long)ev->b;
    switch (ev->type) {
    case EV_FILL:
        buf_printf(b, ",\"maker_id\":%llu,\"qty\":%lld,\"maker_remaining\":%lld,\"taker_remaining\":%lld",
                   (unsigned long long)ev->other_id, (long long)ev->qty, a, bb);
        break;
    case EV_ORDER_ACCEPTED:
        buf_printf(b, ",\"qty\":%lld", (long long)ev->qty); break;
    case EV_ORDER_RESTED:
        buf_printf(b, ",\"qty\":%lld,\"node_id\":%lld", (long long)ev->qty, a); break;
    case EV_ORDER_CANCELLED:
        buf_printf(b, ",\"qty\":%lld", (long long)ev->qty); break;
    case EV_ORDER_REPLACED:
        buf_printf(b, ",\"new_order_id\":%llu,\"qty\":%lld",
                   (unsigned long long)ev->other_id, (long long)ev->qty); break;
    case EV_ORDER_REJECTED:
        buf_printf(b, ",\"reason\":\"%s\"", reject_name((tc_reject)ev->a)); break;
    case EV_BEST_CHANGED:
        buf_printf(b, ",\"node_id\":%lld,\"empty\":%s",
                   a, ev->price ? "false" : "true"); break;
    case EV_AVL_VISIT:
        buf_printf(b, ",\"node_id\":%lld,\"node_price\":", a); buf_price(b, ev->b); break;
    case EV_AVL_INSERT: case EV_AVL_REMOVE:
        buf_printf(b, ",\"node_id\":%lld", a); break;
    case EV_AVL_ROTATE_LEFT: case EV_AVL_ROTATE_RIGHT:
        buf_printf(b, ",\"node_id\":%lld,\"new_root_id\":%lld", a, bb); break;
    case EV_FIFO_ENQUEUE: case EV_FIFO_DEQUEUE: case EV_FIFO_UNLINK:
        buf_printf(b, ",\"remaining\":%lld,\"level_count\":%lld,\"node_id\":%lld",
                   (long long)ev->qty, a, bb); break;
    case EV_LEVEL_QTY:
        buf_printf(b, ",\"total_qty\":%lld,\"node_id\":%lld", (long long)ev->qty, a); break;
    case EV_HASH_INSERT:
        buf_printf(b, ",\"bucket\":%lld,\"chain_len\":%lld", a, bb); break;
    case EV_HASH_ERASE:
        buf_printf(b, ",\"bucket\":%lld,\"probes\":%lld", a, bb); break;
    case EV_HASH_RESIZE:
        buf_printf(b, ",\"old_capacity\":%lld,\"new_capacity\":%lld", a, bb); break;
    default: break;
    }
    buf_puts(b, "}");
}

static void put_best(Buf *b, const Engine *e) {
    tc_price bb = engine_best_bid(e), ba = engine_best_ask(e);
    buf_puts(b, "\"best_bid\":");
    put_price_or_null(b, bb);
    buf_puts(b, ",\"best_ask\":");
    put_price_or_null(b, ba);
    buf_puts(b, ",\"spread\":");
    if (bb && ba) buf_price(b, ba - bb); else buf_puts(b, "null");
}

static const char *cmd_name(tc_cmd_kind k) {
    return k == CMD_SUBMIT ? "submit" : k == CMD_CANCEL ? "cancel" : "replace";
}

/* JSON describing a finished command (used for HTTP reply and SSE). */
static void put_command(Buf *b, const Engine *e, const tc_result *r) {
    buf_printf(b, "{\"ok\":%s,\"command\":\"%s\",\"cmd_seq\":%llu",
               r->ok ? "true" : "false", cmd_name(r->kind),
               (unsigned long long)r->cmd_seq);
    if (!r->ok) {
        buf_puts(b, ",\"error\":");
        buf_json_str(b, reject_name(r->reason));
        buf_puts(b, ",\"message\":");
        buf_json_str(b, reject_message(r->reason));
        if (r->order_id) buf_printf(b, ",\"order_id\":%llu", (unsigned long long)r->order_id);
        if (r->old_id)   buf_printf(b, ",\"order_id\":%llu", (unsigned long long)r->old_id);
    } else {
        const OrderRecord *o = engine_record(e, r->order_id);
        if (o) { buf_puts(b, ",\"order\":"); put_record(b, o); }
        if (r->old_id) {
            const OrderRecord *old = engine_record(e, r->old_id);
            if (old) { buf_puts(b, ",\"replaced\":"); put_record(b, old); }
        }
        buf_puts(b, ",\"fills\":[");
        for (size_t i = 0; i < r->n_trades; i++) {
            if (i) buf_puts(b, ",");
            put_trade(b, e, engine_trade(e, r->first_trade + i));
        }
        buf_puts(b, "]");
    }
    buf_puts(b, ",");
    put_best(b, e);
    buf_printf(b, ",\"events\":{\"from\":%llu,\"to\":%llu},\"engine_ns\":%llu}",
               (unsigned long long)r->first_event, (unsigned long long)r->end_event,
               (unsigned long long)r->engine_ns);
}

static void broadcast_command(ApiState *s, const tc_result *r, ApiResponse *out) {
    Engine *e = &s->engine;
    Buf *b = &out->broadcast;
    buf_printf(b, "id: %llu\nevent: command\ndata: ", (unsigned long long)r->cmd_seq);
    put_command(b, e, r);
    buf_puts(b, "\n\n");
    if (s->stream_trace && e->tracer.enabled && r->end_event > r->first_event) {
        buf_printf(b, "event: trace\ndata: {\"cmd_seq\":%llu,\"truncated\":%s,\"events\":[",
                   (unsigned long long)r->cmd_seq,
                   r->end_event - r->first_event > SSE_TRACE_LIMIT ? "true" : "false");
        uint64_t n = 0;
        for (uint64_t q = r->first_event; q < r->end_event && n < SSE_TRACE_LIMIT; q++) {
            const tc_event *ev = tracer_get(&e->tracer, q);
            if (!ev) continue;
            if (n++) buf_puts(b, ",");
            put_event(b, ev);
        }
        buf_puts(b, "]}\n\n");
    }
}

static void finish_command(ApiState *s, const tc_result *r, ApiResponse *out) {
    out->status = r->ok ? 200 : (r->reason == RJ_UNKNOWN_ORDER ? 404 : 422);
    put_command(&out->body, &s->engine, r);
    broadcast_command(s, r, out);
}

/* --------------------------------------------------------- endpoints */

static void h_health(ApiState *s, ApiResponse *out) {
    out->status = 200;
    buf_printf(&out->body,
               "{\"ok\":true,\"name\":\"TradeCore\",\"symbol\":\"TCX\",\"currency\":\"INR\","
               "\"tick_size\":0.05,\"version\":\"0.1.0\",\"started_ms\":%lld,\"now_ms\":%lld}",
               (long long)s->started_ms, (long long)tc_now_ms());
}

static void h_submit(ApiState *s, const char *body, size_t blen, ApiResponse *out) {
    JKV kv[16];
    int n = json_parse_flat(body, blen, kv, 16);
    if (n < 0) { error_json(out, 400, "BAD_JSON", "body must be a flat JSON object"); return; }
    char side_s[16], trader[TC_TRADER_LEN] = "";
    tc_side side;
    tc_price price;
    int64_t qty;
    if (!json_get_str(kv, n, "side", side_s, sizeof side_s) || !parse_side(side_s, &side)) {
        error_json(out, 400, reject_name(RJ_BAD_SIDE), reject_message(RJ_BAD_SIDE)); return;
    }
    if (!json_get_price(kv, n, "price", &price)) {
        error_json(out, 400, reject_name(RJ_BAD_PRICE),
                   "price must be a number of rupees with at most 2 decimals, e.g. 101.05"); return;
    }
    if (!json_get_i64(kv, n, "qty", &qty) && !json_get_i64(kv, n, "quantity", &qty)) {
        error_json(out, 400, reject_name(RJ_BAD_QTY), reject_message(RJ_BAD_QTY)); return;
    }
    /* Optional display label (e.g. "S1" in a scenario). It may not be
     * another account's name or a bot's name, so nobody can pose as them. */
    if (!json_get_str(kv, n, "label", trader, sizeof trader))
        json_get_str(kv, n, "trader", trader, sizeof trader);
    if (!trader[0] || !strcasecmp(trader, g_user->name)) {
        strcpy(trader, g_user->name);
    } else {
        char key[TC_TRADER_LEN];
        size_t i = 0;
        for (; trader[i]; i++) key[i] = (char)(trader[i] >= 'A' && trader[i] <= 'Z' ? trader[i] + 32 : trader[i]);
        key[i] = '\0';
        if (strmap_get(&s->auth.users, key) || sim_is_bot_name(&s->sim, trader)) {
            error_json(out, 403, "LABEL_NOT_ALLOWED", "that label belongs to another trader"); return;
        }
    }
    tc_result r = engine_submit_as(&s->engine, side, price, qty, trader, g_user->name, tc_now_ms());
    finish_command(s, &r, out);
}

/* Only the account that placed an order may cancel or replace it. */
static int check_owner(ApiState *s, tc_id id, ApiResponse *out) {
    const OrderRecord *o = engine_record(&s->engine, id);
    if (o && strcasecmp(o->owner, g_user->name) != 0) {
        error_json(out, 403, "NOT_YOUR_ORDER", "you can only cancel or replace your own orders");
        return 0;
    }
    return 1;
}

static void h_cancel(ApiState *s, tc_id id, ApiResponse *out) {
    if (!check_owner(s, id, out)) return;
    tc_result r = engine_cancel(&s->engine, id, tc_now_ms());
    finish_command(s, &r, out);
}

static void h_replace(ApiState *s, tc_id id, const char *body, size_t blen, ApiResponse *out) {
    JKV kv[16];
    int n = json_parse_flat(body, blen, kv, 16);
    if (n < 0) { error_json(out, 400, "BAD_JSON", "body must be a flat JSON object"); return; }
    if (!check_owner(s, id, out)) return;
    const OrderRecord *old = engine_record(&s->engine, id);
    tc_price price;
    int64_t qty;
    /* omitted fields keep the current values */
    if (!json_find(kv, n, "price")) price = old ? old->price : 0;
    else if (!json_get_price(kv, n, "price", &price)) {
        error_json(out, 400, reject_name(RJ_BAD_PRICE), reject_message(RJ_BAD_PRICE)); return;
    }
    if (!json_find(kv, n, "qty") && !json_find(kv, n, "quantity"))
        qty = old ? old->remaining : 0;
    else if (!json_get_i64(kv, n, "qty", &qty) && !json_get_i64(kv, n, "quantity", &qty)) {
        error_json(out, 400, reject_name(RJ_BAD_QTY), reject_message(RJ_BAD_QTY)); return;
    }
    tc_result r = engine_replace(&s->engine, id, price, qty, tc_now_ms());
    finish_command(s, &r, out);
}

static void h_order(ApiState *s, tc_id id, ApiResponse *out) {
    const OrderRecord *o = engine_record(&s->engine, id);
    if (!o) { error_json(out, 404, "UNKNOWN_ORDER", "no order with this id exists"); return; }
    out->status = 200;
    Buf *b = &out->body;
    buf_puts(b, "{\"ok\":true,\"order\":");
    put_record(b, o);
    /* where does it live in the data structures right now? */
    Order *node = engine_active(&s->engine, id);
    if (node) {
        size_t pos = 0;
        for (Order *x = node->level->head; x && x != node; x = x->next) pos++;
        buf_printf(b, ",\"book\":{\"node_id\":%u,\"queue_position\":%zu,\"level_count\":%zu,"
                   "\"hash_bucket\":%zu}",
                   node->level->node_id, pos, node->level->count,
                   hm_bucket_of(&s->engine.index, id));
    } else {
        buf_puts(b, ",\"book\":null");
    }
    buf_puts(b, ",\"fills\":[");
    int first = 1;
    for (size_t i = 0; i < s->engine.trades.len; i++) {
        const Trade *t = engine_trade(&s->engine, i);
        if (t->maker_id != id && t->taker_id != id) continue;
        if (!first) buf_puts(b, ",");
        first = 0;
        put_trade(b, &s->engine, t);
    }
    buf_puts(b, "]}");
}

static int status_matches(const char *filter, tc_status st) {
    if (!filter[0] || !strcmp(filter, "all")) return 1;
    if (!strcmp(filter, "open") || !strcmp(filter, "active"))
        return st == ST_OPEN || st == ST_PARTIAL;
    if (!strcmp(filter, "closed")) return st != ST_OPEN && st != ST_PARTIAL;
    return !strcmp(filter, status_name(st));
}

static void h_orders(ApiState *s, const char *q, ApiResponse *out) {
    char filter[16] = "all", trader[TC_TRADER_LEN] = "", owner[TC_TRADER_LEN] = "";
    query_get(q, "status", filter, sizeof filter);
    query_get(q, "trader", trader, sizeof trader);
    query_get(q, "owner", owner, sizeof owner);
    long limit = query_long(q, "limit", 100, 1, 5000);
    const Engine *e = &s->engine;
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"total\":%zu,\"active\":%zu,\"orders\":[",
               e->records.len, e->active_orders);
    long n = 0;
    for (size_t i = e->records.len; i-- > 0 && n < limit;) {   /* newest first */
        const OrderRecord *o = vec_at(&e->records, i);
        if (!status_matches(filter, o->status)) continue;
        if (trader[0] && strcmp(trader, o->trader)) continue;
        if (owner[0] && strcasecmp(owner, o->owner)) continue;
        if (n++) buf_puts(b, ",");
        put_record(b, o);
    }
    buf_puts(b, "]}");
}

static void h_trades(ApiState *s, const char *q, ApiResponse *out) {
    long limit = query_long(q, "limit", 100, 1, 5000);
    long since = query_long(q, "since_id", 0, 0, 0x7fffffffffffffffL);
    long since_ms = query_long(q, "since_ms", 0, 0, 0x7fffffffffffffffL);
    char owner[TC_TRADER_LEN] = "";
    query_get(q, "owner", owner, sizeof owner);
    const Engine *e = &s->engine;
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"total\":%zu,\"trades\":[", e->trades.len);
    long n = 0;
    for (size_t i = e->trades.len; i-- > 0 && n < limit;) {
        const Trade *t = engine_trade(e, i);
        if ((long)t->trade_id <= since || (long)t->time_ms < since_ms) break;
        if (owner[0]) {      /* only trades where this account was maker or taker */
            const OrderRecord *mk = engine_record(e, t->maker_id), *tk = engine_record(e, t->taker_id);
            if (!(mk && !strcasecmp(mk->owner, owner)) && !(tk && !strcasecmp(tk->owner, owner))) continue;
        }
        if (n++) buf_puts(b, ",");
        put_trade(b, e, t);
    }
    buf_puts(b, "]}");
}

/* in-order traversal of levels, best first, up to `limit` levels */
static void walk_levels(Buf *b, const PriceLevel *n, int descending, long *left, int *first) {
    if (!n || *left <= 0) return;
    walk_levels(b, descending ? n->right : n->left, descending, left, first);
    if (*left <= 0) return;
    if (!*first) buf_puts(b, ",");
    *first = 0;
    buf_puts(b, "{\"price\":");
    buf_price(b, n->price);
    buf_printf(b, ",\"qty\":%lld,\"orders\":%zu,\"node_id\":%u}",
               (long long)n->total_qty, n->count, n->node_id);
    (*left)--;
    walk_levels(b, descending ? n->left : n->right, descending, left, first);
}

static void h_book(ApiState *s, const char *q, ApiResponse *out) {
    long depth = query_long(q, "depth", 20, 1, 1000);
    const Engine *e = &s->engine;
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"symbol\":\"TCX\",\"cmd_seq\":%llu,\"event_seq\":%llu,",
               (unsigned long long)e->cmd_seq, (unsigned long long)e->tracer.next_seq);
    put_best(b, e);
    tc_price bb = engine_best_bid(e), ba = engine_best_ask(e);
    buf_puts(b, ",\"mid\":");
    if (bb && ba) buf_printf(b, "%.3f", (double)(bb + ba) / 200.0); else buf_puts(b, "null");
    buf_puts(b, ",\"last_price\":");
    if (e->trades.len) buf_price(b, engine_trade(e, e->trades.len - 1)->price);
    else buf_puts(b, "null");
    buf_printf(b, ",\"bid_levels\":%zu,\"ask_levels\":%zu,\"active_orders\":%zu,\"bids\":[",
               e->bids.size, e->asks.size, e->active_orders);
    long left = depth; int first = 1;
    walk_levels(b, e->bids.root, 1, &left, &first);
    buf_puts(b, "],\"asks\":[");
    left = depth; first = 1;
    walk_levels(b, e->asks.root, 0, &left, &first);
    buf_puts(b, "]}");
}

static void h_level(ApiState *s, const char *q, ApiResponse *out) {
    char side_s[16], price_s[32];
    tc_side side;
    tc_price price;
    if (!query_get(q, "side", side_s, sizeof side_s) || !parse_side(side_s, &side) ||
        !query_get(q, "price", price_s, sizeof price_s) ||
        !parse_price_str(price_s, strlen(price_s), &price)) {
        error_json(out, 400, "BAD_QUERY", "use ?side=buy|sell&price=101.00"); return;
    }
    long limit = query_long(q, "limit", 200, 1, 5000);
    Engine *e = &s->engine;
    AvlTree *t = side == TC_BUY ? &e->bids : &e->asks;
    int saved = e->tracer.enabled;
    e->tracer.enabled = 0;                      /* read-only: no trace noise */
    tc_counters c = e->ctr;
    PriceLevel *lv = avl_find(t, price);
    e->ctr = c;
    e->tracer.enabled = saved;
    if (!lv) { error_json(out, 404, "NO_LEVEL", "no resting orders at this price"); return; }
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"side\":\"%s\",\"price\":", side_name(side));
    buf_price(b, lv->price);
    buf_printf(b, ",\"node_id\":%u,\"total_qty\":%lld,\"count\":%zu,\"head\":%llu,\"tail\":%llu,\"orders\":[",
               lv->node_id, (long long)lv->total_qty, lv->count,
               (unsigned long long)lv->head->id, (unsigned long long)lv->tail->id);
    long n = 0;
    for (Order *o = lv->head; o && n < limit; o = o->next, n++) {
        const OrderRecord *r = engine_record(e, o->id);
        if (n) buf_puts(b, ",");
        buf_printf(b, "{\"id\":%llu,\"seq\":%llu,\"remaining\":%lld,\"qty\":%lld,\"time_ms\":%lld,"
                   "\"prev\":%llu,\"next\":%llu,\"hash_bucket\":%zu,\"trader\":",
                   (unsigned long long)o->id, (unsigned long long)o->seq,
                   (long long)o->remaining, (long long)(r ? r->qty : 0), (long long)(r ? r->time_ms : 0),
                   (unsigned long long)(o->prev ? o->prev->id : 0),
                   (unsigned long long)(o->next ? o->next->id : 0),
                   hm_bucket_of(&e->index, o->id));
        buf_json_str(b, r ? r->trader : "");
        buf_puts(b, "}");
    }
    buf_puts(b, "]}");
}

static void walk_tree(Buf *b, const PriceLevel *n, int depth, int max_depth,
                      long *count, int *first) {
    if (!n || depth > max_depth) return;
    if (!*first) buf_puts(b, ",");
    *first = 0;
    (*count)++;
    buf_printf(b, "{\"id\":%u,\"price\":", n->node_id);
    buf_price(b, n->price);
    buf_printf(b, ",\"height\":%d,\"balance\":%d,\"depth\":%d,\"left\":", n->height,
               avl_height(n->left) - avl_height(n->right), depth);
    if (n->left) buf_printf(b, "%u", n->left->node_id); else buf_puts(b, "null");
    buf_puts(b, ",\"right\":");
    if (n->right) buf_printf(b, "%u", n->right->node_id); else buf_puts(b, "null");
    buf_printf(b, ",\"qty\":%lld,\"orders\":%zu}", (long long)n->total_qty, n->count);
    walk_tree(b, n->left, depth + 1, max_depth, count, first);
    walk_tree(b, n->right, depth + 1, max_depth, count, first);
}

static void h_tree(ApiState *s, const char *q, ApiResponse *out) {
    char side_s[16] = "buy";
    tc_side side;
    query_get(q, "side", side_s, sizeof side_s);
    if (!parse_side(side_s, &side)) { error_json(out, 400, "BAD_QUERY", "side=buy|sell"); return; }
    int max_depth = (int)query_long(q, "max_depth", 6, 0, 30);
    const AvlTree *t = side == TC_BUY ? &s->engine.bids : &s->engine.asks;
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"side\":\"%s\",\"size\":%zu,\"height\":%d,\"root\":",
               side_name(side), t->size, avl_height(t->root));
    if (t->root) buf_printf(b, "%u", t->root->node_id); else buf_puts(b, "null");
    buf_puts(b, ",\"best\":");
    if (t->best) buf_printf(b, "%u", t->best->node_id); else buf_puts(b, "null");
    buf_printf(b, ",\"rotations\":%llu,\"max_depth\":%d,\"nodes\":[",
               (unsigned long long)s->engine.ctr.avl_rotations, max_depth);
    long count = 0; int first = 1;
    walk_tree(b, t->root, 0, max_depth, &count, &first);
    buf_printf(b, "],\"truncated\":%s}", (size_t)count < t->size ? "true" : "false");
}

static void h_hash(ApiState *s, const char *q, ApiResponse *out) {
    HashMap *m = &s->engine.index;
    long from = query_long(q, "from", 0, 0, (long)m->cap - 1);
    long count = query_long(q, "count", 64, 1, 4096);
    long lookup = query_long(q, "order_id", 0, 0, 0x7fffffffffffffffL);
    size_t maxc = 0, used = 0;
    for (size_t i = 0; i < m->cap; i++) {
        size_t c = hm_chain_len(m, i);
        if (c) used++;
        if (c > maxc) maxc = c;
    }
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"capacity\":%zu,\"size\":%zu,\"load_factor\":%.3f,"
               "\"used_buckets\":%zu,\"max_chain\":%zu,\"resizes\":%llu,"
               "\"lookups\":%llu,\"probes\":%llu,",
               m->cap, m->size, (double)m->size / (double)m->cap, used, maxc,
               (unsigned long long)s->engine.ctr.hash_resizes,
               (unsigned long long)s->engine.ctr.hash_lookups,
               (unsigned long long)s->engine.ctr.hash_probes);
    if (lookup) {
        size_t bk = hm_bucket_of(m, (tc_id)lookup);
        buf_printf(b, "\"lookup\":{\"order_id\":%ld,\"bucket\":%zu,\"found\":%s},",
                   lookup, bk, engine_active(&s->engine, (tc_id)lookup) ? "true" : "false");
        from = (long)bk;
        count = 1;
    }
    buf_printf(b, "\"from\":%ld,\"buckets\":[", from);
    for (long i = from; i < from + count && (size_t)i < m->cap; i++) {
        if (i > from) buf_puts(b, ",");
        buf_printf(b, "{\"index\":%ld,\"chain\":[", i);
        int f = 1;
        for (HEntry *e = m->buckets[i]; e; e = e->next) {
            if (!f) buf_puts(b, ",");
            f = 0;
            buf_printf(b, "%llu", (unsigned long long)e->key);
        }
        buf_puts(b, "]}");
    }
    buf_puts(b, "]}");
}

static void h_events(ApiState *s, const char *q, ApiResponse *out) {
    const Tracer *t = &s->engine.tracer;
    long since = query_long(q, "since", 0, 0, 0x7fffffffffffffffL);
    long limit = query_long(q, "limit", 500, 1, 20000);
    uint64_t oldest = tracer_oldest_seq(t);
    uint64_t start = (uint64_t)since < oldest ? oldest : (uint64_t)since;
    int gap = since > 0 && (uint64_t)since < oldest;
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"enabled\":%s,\"detailed\":%s,\"oldest\":%llu,\"next\":%llu,"
               "\"gap\":%s,\"events\":[",
               t->enabled ? "true" : "false", t->detailed ? "true" : "false",
               (unsigned long long)oldest, (unsigned long long)t->next_seq,
               gap ? "true" : "false");
    long n = 0;
    uint64_t q2 = start;
    for (; q2 < t->next_seq && n < limit; q2++) {
        const tc_event *ev = tracer_get(t, q2);
        if (!ev) continue;
        if (n++) buf_puts(b, ",");
        put_event(b, ev);
    }
    buf_printf(b, "],\"resume_from\":%llu}", (unsigned long long)q2);
}

static int cmp_u64(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return x < y ? -1 : x > y;
}

static void h_stats(ApiState *s, ApiResponse *out) {
    Engine *e = &s->engine;
    const tc_counters *c = &e->ctr;
    uint64_t p50 = 0, p95 = 0, p99 = 0, mx = 0;
    if (e->lat_count) {
        uint64_t *tmp = malloc(e->lat_count * sizeof *tmp);
        if (tmp) {
            memcpy(tmp, e->lat_ns, e->lat_count * sizeof *tmp);
            qsort(tmp, e->lat_count, sizeof *tmp, cmp_u64);
            size_t n = e->lat_count;
            p50 = tmp[(n * 50 + 99) / 100 - 1];
            p95 = tmp[(n * 95 + 99) / 100 - 1];
            p99 = tmp[(n * 99 + 99) / 100 - 1];
            mx = tmp[n - 1];
            free(tmp);
        }
    }
    size_t levels = e->bids.size + e->asks.size;
    size_t book_bytes = e->active_orders * (sizeof(Order) + sizeof(HEntry)) +
                        levels * sizeof(PriceLevel) + e->index.cap * sizeof(HEntry *);
    size_t hist_bytes = e->trades.cap * sizeof(Trade) + e->records.cap * sizeof(OrderRecord);
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"mode\":\"%s\",\"uptime_ms\":%lld,",
               e->tracer.enabled ? (e->tracer.detailed ? "demo (detailed tracing)" : "demo (market events)")
                                 : "benchmark (tracing off)",
               (long long)(tc_now_ms() - s->started_ms));
    buf_printf(b, "\"latency_ns\":{\"samples\":%zu,\"p50\":%llu,\"p95\":%llu,\"p99\":%llu,\"max\":%llu,"
               "\"mean\":%.1f},",
               e->lat_count, (unsigned long long)p50, (unsigned long long)p95,
               (unsigned long long)p99, (unsigned long long)mx,
               c->commands ? (double)e->lat_total_ns / (double)c->commands : 0.0);
    buf_printf(b, "\"engine_throughput_cmds_per_s\":%.0f,",
               e->lat_total_ns ? (double)c->commands * 1e9 / (double)e->lat_total_ns : 0.0);
    buf_printf(b, "\"book\":{\"active_orders\":%zu,\"bid_levels\":%zu,\"ask_levels\":%zu,"
               "\"bid_height\":%d,\"ask_height\":%d,\"trades\":%zu,\"orders_total\":%zu},",
               e->active_orders, e->bids.size, e->asks.size, avl_height(e->bids.root),
               avl_height(e->asks.root), e->trades.len, e->records.len);
    buf_printf(b, "\"memory_bytes\":{\"book\":%zu,\"history\":%zu,\"per_active_order\":%.1f,"
               "\"sizeof_order\":%zu,\"sizeof_level\":%zu,\"sizeof_hash_entry\":%zu},",
               book_bytes, hist_bytes,
               e->active_orders ? (double)book_bytes / (double)e->active_orders : 0.0,
               sizeof(Order), sizeof(PriceLevel), sizeof(HEntry));
    buf_printf(b, "\"counters\":{\"commands\":%llu,\"accepted\":%llu,\"rejected\":%llu,"
               "\"submits\":%llu,\"cancels\":%llu,\"replaces\":%llu,\"fills\":%llu,"
               "\"avl_visits\":%llu,\"avl_inserts\":%llu,\"avl_removes\":%llu,\"avl_rotations\":%llu,"
               "\"fifo_enqueues\":%llu,\"fifo_dequeues\":%llu,\"fifo_unlinks\":%llu,"
               "\"hash_lookups\":%llu,\"hash_probes\":%llu,\"hash_inserts\":%llu,"
               "\"hash_erases\":%llu,\"hash_resizes\":%llu,\"allocs\":%llu,\"frees\":%llu}}",
               (unsigned long long)c->commands, (unsigned long long)c->accepted,
               (unsigned long long)c->rejected, (unsigned long long)c->submits,
               (unsigned long long)c->cancels, (unsigned long long)c->replaces,
               (unsigned long long)c->fills, (unsigned long long)c->avl_visits,
               (unsigned long long)c->avl_inserts, (unsigned long long)c->avl_removes,
               (unsigned long long)c->avl_rotations, (unsigned long long)c->fifo_enqueues,
               (unsigned long long)c->fifo_dequeues, (unsigned long long)c->fifo_unlinks,
               (unsigned long long)c->hash_lookups, (unsigned long long)c->hash_probes,
               (unsigned long long)c->hash_inserts, (unsigned long long)c->hash_erases,
               (unsigned long long)c->hash_resizes, (unsigned long long)c->allocs,
               (unsigned long long)c->frees);
}

static void h_candles(ApiState *s, const char *q, ApiResponse *out) {
    long interval = query_long(q, "interval_ms", 60000, 100, 86400000L);
    long limit = query_long(q, "limit", 300, 1, 10000);
    Candle *c;
    size_t n = engine_candles(&s->engine, interval, &c);
    size_t start = n > (size_t)limit ? n - (size_t)limit : 0;
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"interval_ms\":%ld,\"candles\":[", interval);
    for (size_t i = start; i < n; i++) {
        if (i > start) buf_puts(b, ",");
        buf_printf(b, "{\"start_ms\":%lld,\"open\":", (long long)c[i].start_ms);
        buf_price(b, c[i].open);
        buf_puts(b, ",\"high\":");  buf_price(b, c[i].high);
        buf_puts(b, ",\"low\":");   buf_price(b, c[i].low);
        buf_puts(b, ",\"close\":"); buf_price(b, c[i].close);
        buf_printf(b, ",\"volume\":%lld,\"trades\":%u}", (long long)c[i].volume, c[i].trades);
    }
    buf_puts(b, "]}");
    free(c);
}

static void h_trace(ApiState *s, const char *body, size_t blen, ApiResponse *out) {
    JKV kv[8];
    int n = json_parse_flat(body, blen, kv, 8);
    if (n < 0) { error_json(out, 400, "BAD_JSON", "body must be a flat JSON object"); return; }
    int v;
    if (json_get_bool(kv, n, "enabled", &v))  s->engine.tracer.enabled = v;
    if (json_get_bool(kv, n, "detailed", &v)) s->engine.tracer.detailed = v;
    if (json_get_bool(kv, n, "stream", &v))   s->stream_trace = v;
    out->status = 200;
    buf_printf(&out->body, "{\"ok\":true,\"enabled\":%s,\"detailed\":%s,\"stream\":%s}",
               s->engine.tracer.enabled ? "true" : "false",
               s->engine.tracer.detailed ? "true" : "false",
               s->stream_trace ? "true" : "false");
}

static void broadcast_reset(ApiState *s, ApiResponse *out, const char *why) {
    buf_printf(&out->broadcast, "event: reset\ndata: {\"reason\":\"%s\",\"cmd_seq\":%llu,\"event_seq\":%llu,\"sim_running\":%s}\n\n",
               why, (unsigned long long)s->engine.cmd_seq,
               (unsigned long long)s->engine.tracer.next_seq, s->sim.running ? "true" : "false");
}

static void h_reset(ApiState *s, ApiResponse *out) {
    engine_reset(&s->engine);
    out->status = 200;
    buf_puts(&out->body, "{\"ok\":true,\"message\":\"session reset\"}");
    broadcast_reset(s, out, "reset");
}

static void h_scenario(ApiState *s, const char *body, size_t blen, ApiResponse *out) {
    JKV kv[8];
    int n = json_parse_flat(body, blen, kv, 8);
    if (n < 0) { error_json(out, 400, "BAD_JSON", "body must be a flat JSON object"); return; }
    char name[32] = "";
    int64_t seed = 42, count = 0;
    int do_reset = 1;
    json_get_str(kv, n, "name", name, sizeof name);
    json_get_i64(kv, n, "seed", &seed);
    json_get_i64(kv, n, "count", &count);
    json_get_bool(kv, n, "reset", &do_reset);
    if (count > 1000000) count = 1000000;
    s->sim.running = 0;                 /* scenarios run on a quiet market */
    if (do_reset) engine_reset(&s->engine);
    long ran = scenario_load(&s->engine, name, (uint64_t)seed, (long)count, tc_now_ms());
    if (ran < 0) {
        error_json(out, 400, "UNKNOWN_SCENARIO",
                   "name must be worked-example, worked-example-setup, deep-book or random");
        return;
    }
    out->status = 200;
    buf_printf(&out->body, "{\"ok\":true,\"scenario\":");
    buf_json_str(&out->body, name);
    buf_printf(&out->body, ",\"commands\":%ld,\"trades\":%zu,\"active_orders\":%zu,",
               ran, s->engine.trades.len, s->engine.active_orders);
    put_best(&out->body, &s->engine);
    buf_puts(&out->body, "}");
    broadcast_reset(s, out, "scenario");
    broadcast_sim(s, &out->broadcast);
}

static void h_check(ApiState *s, ApiResponse *out) {
    const char *err = engine_check(&s->engine);
    out->status = 200;
    if (!err) buf_puts(&out->body, "{\"ok\":true,\"message\":\"all invariants hold\"}");
    else { buf_puts(&out->body, "{\"ok\":false,\"error\":"); buf_json_str(&out->body, err); buf_puts(&out->body, "}"); }
}

void api_stream_hello(ApiState *s, Buf *out) {
    buf_printf(out, "retry: 2000\nevent: hello\ndata: {\"cmd_seq\":%llu,\"event_seq\":%llu}\n\n",
               (unsigned long long)s->engine.cmd_seq,
               (unsigned long long)s->engine.tracer.next_seq);
}


/* Sum of quantity over every level of one side: O(P). */
static tc_qty side_depth(const PriceLevel *n, size_t *orders) {
    if (!n) return 0;
    *orders += n->count;
    return n->total_qty + side_depth(n->left, orders) + side_depth(n->right, orders);
}

/* Session market summary computed from the trade history: O(H). */
static void h_summary(ApiState *s, const char *q, ApiResponse *out) {
    long since_ms = query_long(q, "since_ms", 0, 0, 0x7fffffffffffffffL);
    const Engine *e = &s->engine;
    tc_price open = 0, high = 0, low = 0, last = 0, first_ever = 0;
    tc_qty volume = 0, buy_vol = 0, sell_vol = 0;
    double turnover = 0;
    size_t count = 0;
    if (e->trades.len) first_ever = engine_trade(e, 0)->price;
    for (size_t i = 0; i < e->trades.len; i++) {
        const Trade *t = engine_trade(e, i);
        if (t->time_ms < since_ms) continue;
        if (!count) open = high = low = t->price;
        if (t->price > high) high = t->price;
        if (t->price < low)  low = t->price;
        last = t->price;
        volume += t->qty;
        turnover += (double)t->price * (double)t->qty / 100.0;
        if (t->taker_side == TC_BUY) buy_vol += t->qty; else sell_vol += t->qty;
        count++;
    }
    size_t bid_orders = 0, ask_orders = 0;
    tc_qty bid_depth = side_depth(e->bids.root, &bid_orders);
    tc_qty ask_depth = side_depth(e->asks.root, &ask_orders);
    Buf *b = &out->body;
    out->status = 200;
    buf_puts(b, "{\"ok\":true,\"symbol\":\"TCX\",");
    put_best(b, e);
    buf_printf(b, ",\"best_bid_qty\":%lld,\"best_ask_qty\":%lld",
               (long long)(e->bids.best ? e->bids.best->total_qty : 0),
               (long long)(e->asks.best ? e->asks.best->total_qty : 0));
    buf_puts(b, ",\"open\":");  put_price_or_null(b, open);
    buf_puts(b, ",\"high\":");  put_price_or_null(b, high);
    buf_puts(b, ",\"low\":");   put_price_or_null(b, low);
    buf_puts(b, ",\"last\":");  put_price_or_null(b, last);
    buf_puts(b, ",\"first_price\":"); put_price_or_null(b, first_ever);
    buf_printf(b, ",\"vwap\":");
    if (volume) buf_printf(b, "%.2f", turnover / (double)volume); else buf_puts(b, "null");
    buf_printf(b, ",\"volume\":%lld,\"turnover\":%.2f,\"trades\":%zu,\"buy_volume\":%lld,"
               "\"sell_volume\":%lld,\"bid_depth\":%lld,\"ask_depth\":%lld,\"bid_orders\":%zu,"
               "\"ask_orders\":%zu,\"bid_levels\":%zu,\"ask_levels\":%zu,\"active_orders\":%zu,"
               "\"cmd_seq\":%llu,\"total_trades\":%zu}",
               (long long)volume, turnover, count, (long long)buy_vol, (long long)sell_vol,
               (long long)bid_depth, (long long)ask_depth, bid_orders, ask_orders,
               e->bids.size, e->asks.size, e->active_orders,
               (unsigned long long)e->cmd_seq, e->trades.len);
}

/* Cancel every open order of one trader. Each cancel is its own command. */
static void h_cancel_all(ApiState *s, const char *body, size_t blen, ApiResponse *out) {
    (void)body; (void)blen;
    const char *trader = g_user->name;     /* always the signed-in account */
    Engine *e = &s->engine;
    Vec ids;
    vec_init(&ids, sizeof(tc_id));
    for (size_t i = 0; i < e->records.len; i++) {
        const OrderRecord *o = vec_at(&e->records, i);
        if ((o->status == ST_OPEN || o->status == ST_PARTIAL) && !strcasecmp(o->owner, trader)) {
            tc_id *slot = vec_push(&ids);
            if (slot) *slot = o->id;
        }
    }
    Buf *b = &out->body;
    out->status = 200;
    buf_printf(b, "{\"ok\":true,\"cancelled\":%zu,\"ids\":[", ids.len);
    for (size_t i = 0; i < ids.len; i++) {
        tc_id id = *(tc_id *)vec_at(&ids, i);
        tc_result r = engine_cancel(e, id, tc_now_ms());
        broadcast_command(s, &r, out);
        buf_printf(b, "%s%llu", i ? "," : "", (unsigned long long)id);
    }
    buf_puts(b, "]}");
    vec_free(&ids);
}

/* ------------------------------------------------------------- accounts */

static void put_user(Buf *b, const User *u) {
    buf_puts(b, "{\"username\":");
    buf_json_str(b, u->name);
    buf_printf(b, ",\"demo\":%s,\"created_ms\":%lld,\"last_login_ms\":%lld}",
               u->is_demo ? "true" : "false", (long long)u->created_ms, (long long)u->last_login_ms);
}

static void auth_error(ApiResponse *out, auth_status st) {
    int code = st == AUTH_WRONG_CREDENTIALS ? 401 : st == AUTH_TAKEN ? 409 : 400;
    error_json(out, code, auth_code(st), auth_message(st));
}

static void h_login(ApiState *s, const char *body, size_t blen, ApiResponse *out, int registering) {
    JKV kv[8];
    int n = json_parse_flat(body, blen, kv, 8);
    char user[64] = "", pw[96] = "";
    if (n < 0 || !json_get_str(kv, n, "username", user, sizeof user) ||
        !json_get_str(kv, n, "password", pw, sizeof pw)) {
        error_json(out, 400, "BAD_JSON", "send {\"username\":\"...\",\"password\":\"...\"}"); return;
    }
    int64_t now = tc_now_ms();
    if (registering) {
        if (sim_is_bot_name(&s->sim, user)) { auth_error(out, AUTH_TAKEN); return; }
        auth_status st = auth_register(&s->auth, user, pw, 0, now);
        if (st != AUTH_OK) { auth_error(out, st); return; }
    }
    char token[AUTH_TOKEN_LEN + 1];
    auth_status st = auth_login(&s->auth, user, pw, now, token);
    if (st != AUTH_OK) { auth_error(out, st); return; }
    const User *u = auth_check(&s->auth, token, now);
    out->status = 200;
    buf_puts(&out->body, "{\"ok\":true,\"token\":");
    buf_json_str(&out->body, token);
    buf_puts(&out->body, ",\"user\":");
    put_user(&out->body, u);
    buf_puts(&out->body, "}");
}

static void h_me(ApiResponse *out) {
    out->status = 200;
    buf_puts(&out->body, "{\"ok\":true,\"user\":");
    put_user(&out->body, g_user);
    buf_puts(&out->body, "}");
}

static void h_logout(ApiState *s, const char *token, ApiResponse *out) {
    auth_logout(&s->auth, token);
    out->status = 200;
    buf_puts(&out->body, "{\"ok\":true}");
}

/* ------------------------------------------------------------ simulator */

static void put_sim(Buf *b, const Sim *m) {
    buf_printf(b, "{\"running\":%s,\"rate\":%.2f,\"mode\":\"%s\",\"blurb\":",
               m->running ? "true" : "false", m->rate, sim_mode_name(m->mode));
    buf_json_str(b, sim_mode_blurb(m->mode));
    buf_printf(b, ",\"fair_price\":%.2f,\"steps\":%llu,\"modes\":[", m->mid / 100.0, (unsigned long long)m->steps);
    for (int i = 0; i < SIM__MODES; i++) {
        buf_printf(b, "%s{\"name\":\"%s\",\"blurb\":", i ? "," : "", sim_mode_name((sim_mode)i));
        buf_json_str(b, sim_mode_blurb((sim_mode)i));
        buf_puts(b, "}");
    }
    buf_puts(b, "],\"bots\":[");
    for (int i = 0; i < m->nbots; i++) {
        const SimBot *t = &m->bots[i];
        buf_printf(b, "%s{\"name\":\"%s\",\"kind\":\"%s\",\"orders\":%llu,\"cancels\":%llu,\"fills\":%llu,\"volume\":%lld}",
                   i ? "," : "", t->name, t->kind, (unsigned long long)t->orders,
                   (unsigned long long)t->cancels, (unsigned long long)t->fills, (long long)t->volume);
    }
    buf_puts(b, "]}");
}

static void broadcast_sim(ApiState *s, Buf *b) {
    buf_puts(b, "event: sim\ndata: ");
    put_sim(b, &s->sim);
    buf_puts(b, "\n\n");
}

static void h_sim_get(ApiState *s, ApiResponse *out) {
    out->status = 200;
    buf_puts(&out->body, "{\"ok\":true,\"sim\":");
    put_sim(&out->body, &s->sim);
    buf_puts(&out->body, "}");
}

static void h_sim_set(ApiState *s, const char *body, size_t blen, ApiResponse *out) {
    JKV kv[8];
    int n = json_parse_flat(body, blen, kv, 8);
    if (n < 0) { error_json(out, 400, "BAD_JSON", "body must be a flat JSON object"); return; }
    int64_t now = tc_now_ms();
    int run;
    int64_t rate;
    char mode[16];
    if (json_get_bool(kv, n, "running", &run)) {
        if (run && !s->sim.running) s->sim.next_tick_ms = now;
        s->sim.running = run;
    }
    if (json_get_i64(kv, n, "rate", &rate)) {
        if (rate < 1) rate = 1;
        if (rate > 50) rate = 50;
        s->sim.rate = (double)rate;
    }
    if (json_get_str(kv, n, "mode", mode, sizeof mode)) {
        sim_mode m;
        if (!sim_parse_mode(mode, &m)) { error_json(out, 400, "UNKNOWN_MODE", "mode must be calm, volatile, bull, bear or crash"); return; }
        sim_set_mode(&s->sim, m, now);
    }
    int reseed = 0;
    if (json_get_bool(kv, n, "reseed", &reseed) && reseed) {
        /* fresh market: wipe the book and generate 3 hours of history again */
        engine_reset(&s->engine);
        Sim fresh;
        sim_init(&fresh, (uint64_t)now);
        fresh.rate = s->sim.rate;
        s->sim = fresh;
        sim_seed_history(&s->sim, &s->engine, now - 3 * 3600 * 1000LL, now - 1000, 6000);
        s->sim.running = 1;
        s->sim.next_tick_ms = now + 300;
        broadcast_reset(s, out, "reseed");
    }
    h_sim_get(s, out);
    broadcast_sim(s, &out->broadcast);
}

int64_t api_sim_tick(ApiState *s, int64_t now_ms, Buf *broadcast) {
    Sim *m = &s->sim;
    if (!m->running) return 1000;
    tc_result res[SIM_MAX_BATCH];
    int guard = 0;
    while (now_ms >= m->next_tick_ms && guard++ < 20) {
        int k = sim_step(m, &s->engine, now_ms, res);
        for (int i = 0; i < k; i++) {
            ApiResponse tmp;
            tmp.broadcast = *broadcast;
            broadcast_command(s, &res[i], &tmp);
            *broadcast = tmp.broadcast;
        }
        /* jittered interval around 1/rate seconds */
        double base = 1000.0 / (m->rate > 0 ? m->rate : 1);
        m->next_tick_ms += (int64_t)(base * (0.4 + 1.2 * (double)(rng_next(&m->rng) % 1000) / 1000.0)) + 1;
    }
    if (now_ms - m->next_tick_ms > 2000) m->next_tick_ms = now_ms;   /* don't try to catch up after a stall */
    int64_t wait = m->next_tick_ms - now_ms;
    return wait < 0 ? 0 : wait;
}

/* ------------------------------------------------------------ router */

/* Parses "/api/orders/<id>[/<action>]". Returns 1 on match. */
static int match_order_path(const char *path, tc_id *id, const char **action) {
    const char *pre = "/api/orders/";
    size_t pl = strlen(pre);
    if (strncmp(path, pre, pl) != 0) return 0;
    const char *p = path + pl;
    if (*p < '0' || *p > '9') return 0;
    char *end;
    unsigned long long v = strtoull(p, &end, 10);
    *id = (tc_id)v;
    if (*end == '\0') { *action = ""; return 1; }
    if (*end == '/') { *action = end + 1; return 1; }
    return 0;
}

void api_handle(ApiState *s, const char *method, const char *path,
                const char *query, const char *body, size_t body_len,
                const char *token, ApiResponse *out) {
    int get = !strcmp(method, "GET"), post = !strcmp(method, "POST");
    int del = !strcmp(method, "DELETE");
    tc_id id;
    const char *action;
    if (!body) { body = ""; body_len = 0; }
    g_user = auth_check(&s->auth, token, tc_now_ms());

    /* public endpoints: sign-in and read-only market data */
    if (post && !strcmp(path, "/api/auth/login"))         { h_login(s, body, body_len, out, 0); return; }
    if (post && !strcmp(path, "/api/auth/register"))      { h_login(s, body, body_len, out, 1); return; }
    if (post && !strcmp(path, "/api/auth/logout"))        { h_logout(s, token, out); return; }

    /* everything that changes state needs a signed-in user */
    if (!get && !g_user) {
        error_json(out, 401, "NOT_LOGGED_IN", "Please sign in first.");
        return;
    }

    if (get && !strcmp(path, "/api/auth/me")) {
        if (!g_user) error_json(out, 401, "NOT_LOGGED_IN", "Please sign in first.");
        else h_me(out);
    }
    else if (get && !strcmp(path, "/api/health"))       h_health(s, out);
    else if (get && !strcmp(path, "/api/book"))          h_book(s, query, out);
    else if (get && !strcmp(path, "/api/book/level"))    h_level(s, query, out);
    else if (get && !strcmp(path, "/api/orders"))        h_orders(s, query, out);
    else if (post && !strcmp(path, "/api/orders"))       h_submit(s, body, body_len, out);
    else if (post && !strcmp(path, "/api/orders/cancel-all")) h_cancel_all(s, body, body_len, out);
    else if (get && !strcmp(path, "/api/summary"))       h_summary(s, query, out);
    else if (match_order_path(path, &id, &action)) {
        if (get && !*action)                             h_order(s, id, out);
        else if ((del && !*action) || (post && !strcmp(action, "cancel")))
                                                         h_cancel(s, id, out);
        else if (post && !strcmp(action, "replace"))     h_replace(s, id, body, body_len, out);
        else error_json(out, 405, "METHOD_NOT_ALLOWED", "unsupported method for this order path");
    }
    else if (get && !strcmp(path, "/api/trades"))        h_trades(s, query, out);
    else if (get && !strcmp(path, "/api/candles"))       h_candles(s, query, out);
    else if (get && !strcmp(path, "/api/dsa/tree"))      h_tree(s, query, out);
    else if (get && !strcmp(path, "/api/dsa/hash"))      h_hash(s, query, out);
    else if (get && !strcmp(path, "/api/events"))        h_events(s, query, out);
    else if (get && !strcmp(path, "/api/stats"))         h_stats(s, out);
    else if (get && !strcmp(path, "/api/check"))         h_check(s, out);
    else if (get && !strcmp(path, "/api/sim"))           h_sim_get(s, out);
    else if (post && !strcmp(path, "/api/sim"))          h_sim_set(s, body, body_len, out);
    else if (post && !strcmp(path, "/api/trace"))        h_trace(s, body, body_len, out);
    else if (post && !strcmp(path, "/api/reset"))        h_reset(s, out);
    else if (post && !strcmp(path, "/api/scenario"))     h_scenario(s, body, body_len, out);
    else error_json(out, 404, "NOT_FOUND", "unknown endpoint - see docs/API.md");
}
