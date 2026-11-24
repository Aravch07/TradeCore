/*
 * sim.c - Bot traders for the live demo market.
 */
#include <math.h>
#include <string.h>
#include <strings.h>
#include "sim.h"

static const struct { const char *name, *kind; } BOTS[] = {
    { "MM-Alpha", "market maker" }, { "MM-Beta", "market maker" },
    { "Riya", "retail" }, { "Arjun", "retail" }, { "Kabir", "retail" }, { "Meera", "retail" },
    { "Dev", "retail" }, { "Ananya", "retail" }, { "Ishaan", "retail" }, { "Zara", "retail" },
    { "Quant-X", "momentum" }, { "BlueRock", "institution" },
};

static const char *MODE_NAMES[SIM__MODES] = { "calm", "volatile", "bull", "bear", "crash" };
static const char *MODE_BLURBS[SIM__MODES] = {
    "Small random moves around a stable price; steady two-sided liquidity.",
    "Large swings, wider quotes and bursts of aggressive orders.",
    "Buyers dominate: the fair price drifts upwards and asks get swept.",
    "Sellers dominate: the fair price drifts downwards and bids get hit.",
    "Flash crash: a sharp sell-off for ~40 s, a recovery, then back to calm.",
};

#define TICK ((double)TC_TICK_PAISE)

void sim_init(Sim *s, uint64_t seed) {
    memset(s, 0, sizeof *s);
    rng_seed(&s->rng, seed);
    s->rate = 3.0;
    s->mode = SIM_CALM;
    s->mid = s->last_mid = 10000.0;             /* Rs 100.00 */
    s->nbots = (int)(sizeof BOTS / sizeof BOTS[0]);
    for (int i = 0; i < s->nbots; i++) { s->bots[i].name = BOTS[i].name; s->bots[i].kind = BOTS[i].kind; }
}

const char *sim_mode_name(sim_mode m) { return (m >= 0 && m < SIM__MODES) ? MODE_NAMES[m] : "calm"; }
const char *sim_mode_blurb(sim_mode m) { return (m >= 0 && m < SIM__MODES) ? MODE_BLURBS[m] : ""; }

int sim_parse_mode(const char *name, sim_mode *out) {
    for (int i = 0; i < SIM__MODES; i++)
        if (!strcasecmp(name, MODE_NAMES[i])) { *out = (sim_mode)i; return 1; }
    return 0;
}

void sim_set_mode(Sim *s, sim_mode m, int64_t now_ms) { s->mode = m; s->mode_started_ms = now_ms; }

int sim_is_bot_name(const Sim *s, const char *name) {
    for (int i = 0; i < s->nbots; i++) if (!strcasecmp(s->bots[i].name, name)) return 1;
    return !strcasecmp(name, "sim") || !strcasecmp(name, "deep");
}

/* uniform double in [0,1) */
static double urand(Sim *s) { return (double)(rng_next(&s->rng) >> 11) / 9007199254740992.0; }
/* approximately normal(0,1): sum of 4 uniforms, rescaled */
static double nrand(Sim *s) { return (urand(s) + urand(s) + urand(s) + urand(s) - 2.0) * 1.732; }
static int64_t irange(Sim *s, int64_t lo, int64_t hi) { return rng_range(&s->rng, lo, hi); }

static tc_price snap(double paise) {
    tc_price p = (tc_price)llround(paise / TICK) * TC_TICK_PAISE;
    if (p < 20 * 100) p = 20 * 100;
    return p;
}

/* Move the hidden fair price one step according to the mode. */
static void walk(Sim *s, Engine *e, int64_t now_ms) {
    double drift = 0, sigma = 0.5;
    switch (s->mode) {
    case SIM_CALM: break;
    case SIM_VOLATILE: sigma = 1.6; break;
    case SIM_BULL: drift = 0.14; sigma = 0.6; break;
    case SIM_BEAR: drift = -0.14; sigma = 0.6; break;
    case SIM_CRASH: {
        int64_t t = now_ms - s->mode_started_ms;
        if (t < 40000)       { drift = -1.6; sigma = 1.0; }
        else if (t < 120000) { drift = 0.7; sigma = 0.7; }
        else                 { sim_set_mode(s, SIM_CALM, now_ms); }
        break;
    }
    default: break;
    }
    s->last_mid = s->mid;
    s->mid += (drift + sigma * nrand(s)) * TICK;
    /* stay anchored to where the market actually trades */
    if (e->trades.len) {
        const Trade *t = engine_trade(e, e->trades.len - 1);
        s->mid = 0.97 * s->mid + 0.03 * (double)t->price;
    }
    if (s->mid < 2500) s->mid = 2500;      /* Rs 25  */
    if (s->mid > 50000) s->mid = 50000;    /* Rs 500 */
}

static void remember(Sim *s, tc_id id) {
    s->ring[s->ring_pos] = id;
    s->ring_pos = (s->ring_pos + 1) % SIM_RING;
    if (s->ring_len < SIM_RING) s->ring_len++;
}

static SimBot *bot_by_name(Sim *s, const char *name) {
    for (int i = 0; i < s->nbots; i++) if (!strcmp(s->bots[i].name, name)) return &s->bots[i];
    return NULL;
}

/* Credit fills to the bots involved (maker or taker). */
static void count_fills(Sim *s, Engine *e, const tc_result *r) {
    for (size_t k = 0; k < r->n_trades; k++) {
        const Trade *t = engine_trade(e, r->first_trade + k);
        const OrderRecord *m = engine_record(e, t->maker_id), *tk = engine_record(e, t->taker_id);
        SimBot *b;
        if (m && (b = bot_by_name(s, m->trader)))  { b->fills++; b->volume += t->qty; }
        if (tk && (b = bot_by_name(s, tk->trader))) { b->fills++; b->volume += t->qty; }
    }
}

/*
 * Self-trade prevention: before a bot sends an order, it cancels its own
 * resting orders on the other side that the new order would trade against
 * (real exchanges do the same). We visit only the crossing price levels with
 * an iterative in-order walk of the AVL tree, best price first, and stop at
 * the first level beyond the order's limit price.
 */
static int own_crossing(const Engine *e, const char *name, tc_side side, tc_price limit, tc_id *ids, int max) {
    const AvlTree *opp = side == TC_BUY ? &e->asks : &e->bids;
    const PriceLevel *stack[64], *n = opp->root;      /* AVL height << 64 */
    int sp = 0, k = 0, buy = side == TC_BUY;
    while ((n || sp) && k < max) {
        while (n) { stack[sp++] = n; n = buy ? n->left : n->right; }
        n = stack[--sp];
        if (buy ? n->price > limit : n->price < limit) break;
        for (const Order *o = n->head; o && k < max; o = o->next) {
            const OrderRecord *r = engine_record(e, o->id);
            if (r && !strcmp(r->trader, name)) ids[k++] = o->id;
        }
        n = buy ? n->right : n->left;
    }
    return k;
}

static int submit(Sim *s, Engine *e, SimBot *b, tc_side side, double price, tc_qty qty,
                  int64_t now_ms, tc_result *out) {
    tc_price p = snap(price);
    tc_id ids[SIM_MAX_BATCH];
    int n = 0, k = own_crossing(e, b->name, side, p, ids, SIM_MAX_BATCH - 2);
    for (int i = 0; i < k; i++) { out[n++] = engine_cancel(e, ids[i], now_ms); b->cancels++; }
    out[n] = engine_submit(e, side, p, qty, b->name, now_ms);
    b->orders++;
    if (out[n].ok) { remember(s, out[n].order_id); count_fills(s, e, &out[n]); }
    return n + 1;
}

int sim_step(Sim *s, Engine *e, int64_t now_ms, tc_result *out) {
    int n = 0;
    s->steps++;
    walk(s, e, now_ms);
    double m = s->mid;
    int up_bias = s->mode == SIM_BULL ? 62 : s->mode == SIM_BEAR ? 38 :
                  s->mode == SIM_CRASH ? (now_ms - s->mode_started_ms < 40000 ? 20 : 70) : 50;
    int wide = s->mode == SIM_VOLATILE ? 2 : 1;
    int64_t r = irange(s, 0, 99);

    /* 1. cancels / replaces of recent bot orders */
    if (s->ring_len > 20 && r < 14) {
        tc_id id = s->ring[(size_t)irange(s, 0, (int64_t)s->ring_len - 1)];
        const OrderRecord *rec = engine_record(e, id);
        SimBot *b = rec ? bot_by_name(s, rec->trader) : NULL;
        if (rec && b && (rec->status == ST_OPEN || rec->status == ST_PARTIAL)) {
            if (r < 10) {
                out[n++] = engine_cancel(e, id, now_ms);
                b->cancels++;
            } else {
                double np = m + (rec->side == TC_BUY ? -1 : 1) * irange(s, 1, 4) * TICK;
                out[n] = engine_replace(e, id, snap(np), rec->remaining, now_ms);
                if (out[n].ok) { remember(s, out[n].order_id); count_fills(s, e, &out[n]); }
                b->orders++;
                n++;
            }
            return n;
        }
    }

    /* 2. a bot places an order */
    int64_t who = irange(s, 0, 99);
    if (who < 38) {                                   /* market makers: passive quotes */
        SimBot *b = &s->bots[irange(s, 0, 1)];
        tc_side side = irange(s, 0, 1) ? TC_BUY : TC_SELL;
        double off = (double)irange(s, 1, 5) * wide * TICK;
        n += submit(s, e, b, side, side == TC_BUY ? m - off : m + off, irange(s, 1, 10) * 10, now_ms, &out[n]);
    } else if (who < 78) {                            /* retail: around the mid, some crossing */
        SimBot *b = &s->bots[irange(s, 2, 9)];
        tc_side side = irange(s, 0, 99) < up_bias ? TC_BUY : TC_SELL;
        double off = (double)irange(s, -3, 3) * wide * TICK;
        n += submit(s, e, b, side, side == TC_BUY ? m + off : m - off, irange(s, 1, 12) * 5, now_ms, &out[n]);
    } else if (who < 92) {                            /* momentum: follows the last move */
        SimBot *b = bot_by_name(s, "Quant-X");
        tc_side side = (s->mid - s->last_mid) >= 0 ? TC_BUY : TC_SELL;
        if (irange(s, 0, 99) < 25) side = side == TC_BUY ? TC_SELL : TC_BUY;
        double off = 3 * TICK * wide;
        n += submit(s, e, b, side, side == TC_BUY ? m + off : m - off, irange(s, 2, 12) * 10, now_ms, &out[n]);
    } else {                                          /* institution: large block */
        SimBot *b = bot_by_name(s, "BlueRock");
        tc_side side = irange(s, 0, 99) < up_bias ? TC_BUY : TC_SELL;
        double off = 2 * TICK;
        n += submit(s, e, b, side, side == TC_BUY ? m + off : m - off, irange(s, 20, 80) * 10, now_ms, &out[n]);
    }

    /* 3. housekeeping: every 30 steps, cancel bot orders far from the mid */
    if (s->steps % 30 == 0) {
        for (size_t i = 0; i < s->ring_len && n < SIM_MAX_BATCH; i++) {
            tc_id id = s->ring[i];
            const OrderRecord *rec = engine_record(e, id);
            if (!rec || (rec->status != ST_OPEN && rec->status != ST_PARTIAL)) continue;
            SimBot *b = bot_by_name(s, rec->trader);
            if (!b || fabs((double)rec->price - m) < 30 * TICK) continue;
            out[n++] = engine_cancel(e, id, now_ms);
            b->cancels++;
        }
    }
    return n;
}

void sim_seed_history(Sim *s, Engine *e, int64_t start_ms, int64_t end_ms, long n) {
    tc_result buf[SIM_MAX_BATCH];
    int saved = e->tracer.enabled;
    e->tracer.enabled = 0;               /* don't flood the trace ring with history */
    for (long i = 0; i < n; i++) {
        int64_t t = start_ms + (int64_t)((double)(end_ms - start_ms) * (double)i / (double)n);
        /* a few regime changes so the history chart has some shape */
        if (i == n / 5)      sim_set_mode(s, SIM_BULL, t);
        if (i == n / 2)      sim_set_mode(s, SIM_VOLATILE, t);
        if (i == 7 * n / 10) sim_set_mode(s, SIM_BEAR, t);
        if (i == 9 * n / 10) sim_set_mode(s, SIM_CALM, t);
        sim_step(s, e, t, buf);
    }
    e->tracer.enabled = saved;
}
