#include <stdlib.h>
#include <stdio.h>
#include "reference.h"
#include "engine.h"   /* tc_validate */

void ref_init(RefBook *b) {
    b->a = NULL; b->n = b->cap = 0;
    b->next_id = 1; b->seq = 0;
    b->fills = NULL; b->nfills = b->fcap = 0;
    b->max_id = 0;
}

void ref_free(RefBook *b) { free(b->a); free(b->fills); ref_init(b); }

static void push_fill(RefBook *b, RefFill f) {
    if (b->nfills == b->fcap) {
        b->fcap = b->fcap ? b->fcap * 2 : 256;
        b->fills = realloc(b->fills, b->fcap * sizeof *b->fills);
        if (!b->fills) abort();
    }
    b->fills[b->nfills++] = f;
}

/* Linear scan: best price on `side`, earliest sequence among ties. */
static long find_best(const RefBook *b, tc_side side) {
    long best = -1;
    for (size_t i = 0; i < b->n; i++) {
        const RefOrder *o = &b->a[i];
        if (o->side != side) continue;
        if (best < 0) { best = (long)i; continue; }
        const RefOrder *c = &b->a[best];
        int better = side == TC_BUY ? o->price > c->price : o->price < c->price;
        if (better || (o->price == c->price && o->seq < c->seq)) best = (long)i;
    }
    return best;
}

static void remove_at(RefBook *b, size_t i) {
    b->a[i] = b->a[--b->n];   /* order in the array does not matter */
}

static tc_id do_submit(RefBook *b, tc_side side, tc_price price, tc_qty qty) {
    tc_id id = b->next_id++;
    b->max_id = id;
    tc_side opp = side == TC_BUY ? TC_SELL : TC_BUY;
    while (qty > 0) {
        long i = find_best(b, opp);
        if (i < 0) break;
        RefOrder *m = &b->a[i];
        if (side == TC_BUY ? m->price > price : m->price < price) break;
        tc_qty f = qty < m->rem ? qty : m->rem;
        push_fill(b, (RefFill){ m->id, id, m->price, f });
        qty -= f;
        m->rem -= f;
        if (m->rem == 0) remove_at(b, (size_t)i);
    }
    if (qty > 0) {
        if (b->n == b->cap) {
            b->cap = b->cap ? b->cap * 2 : 256;
            b->a = realloc(b->a, b->cap * sizeof *b->a);
            if (!b->a) abort();
        }
        b->a[b->n++] = (RefOrder){ id, b->seq, side, price, qty };
    }
    return id;
}

int ref_submit(RefBook *b, tc_side side, tc_price price, tc_qty qty, tc_id *new_id) {
    b->seq++;
    if (tc_validate(price, qty) != RJ_NONE) return 0;
    *new_id = do_submit(b, side, price, qty);
    return 1;
}

static long find_id(const RefBook *b, tc_id id) {
    for (size_t i = 0; i < b->n; i++) if (b->a[i].id == id) return (long)i;
    return -1;
}

int ref_cancel(RefBook *b, tc_id id) {
    b->seq++;
    long i = find_id(b, id);
    if (i < 0) return 0;
    remove_at(b, (size_t)i);
    return 1;
}

int ref_replace(RefBook *b, tc_id id, tc_price price, tc_qty qty, tc_id *new_id) {
    b->seq++;
    long i = find_id(b, id);
    if (i < 0 || tc_validate(price, qty) != RJ_NONE) return 0;
    tc_side side = b->a[i].side;
    remove_at(b, (size_t)i);
    *new_id = do_submit(b, side, price, qty);
    return 1;
}

int ref_best(const RefBook *b, tc_side side, tc_price *price, tc_qty *total) {
    long i = find_best(b, side);
    if (i < 0) return 0;
    *price = b->a[i].price;
    *total = 0;
    for (size_t j = 0; j < b->n; j++)
        if (b->a[j].side == side && b->a[j].price == *price) *total += b->a[j].rem;
    return 1;
}
