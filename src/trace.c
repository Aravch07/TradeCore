/*
 * trace.c - Ring buffer of trace events.
 *
 * Field meanings per event type:
 *   FILL           order_id = taker, other_id = maker, price/qty = execution
 *   AVL_VISIT      a = node_id visited while searching for `price`
 *   AVL_INSERT     a = node_id of the new node
 *   AVL_REMOVE     a = node_id removed
 *   AVL_ROTATE_*   a = node_id of the node rotated down, b = new subtree root
 *   FIFO_*         order_id, qty = order's remaining, a = level count after
 *   LEVEL_QTY      qty = new aggregate quantity of the level, a = node_id
 *   HASH_INSERT    a = bucket index, b = chain length after insert
 *   HASH_ERASE     a = bucket index, b = probes needed to find it
 *   HASH_RESIZE    a = old capacity, b = new capacity
 *   BEST_CHANGED   price = new best (0 = side empty)
 */
#include <stdlib.h>
#include <string.h>
#include "trace.h"

int tracer_init(Tracer *t, size_t capacity) {
    memset(t, 0, sizeof *t);
    t->buf = calloc(capacity, sizeof(tc_event));
    if (!t->buf) return -1;
    t->cap = capacity;
    t->next_seq = 1;
    t->enabled = 1;
    t->detailed = 1;
    return 0;
}

void tracer_free(Tracer *t) {
    free(t->buf);
    t->buf = NULL;
}

void tracer_clear(Tracer *t) {
    /* keep next_seq increasing so clients notice the jump */
    t->count = 0;
}

int event_is_detailed(tc_event_type type) {
    return type >= EV_AVL_VISIT;
}

void tracer_emit(Tracer *t, tc_event_type type, int side, tc_price price,
                 tc_id order_id, tc_id other_id, tc_qty qty,
                 int64_t a, int64_t b) {
    if (!t || !t->enabled || !t->buf) return;
    if (!t->detailed && event_is_detailed(type)) return;

    /* slot = seq mod capacity: the oldest entry is overwritten when full */
    tc_event *e = &t->buf[t->next_seq % t->cap];
    e->seq = t->next_seq++;
    e->cmd_seq = t->cur_cmd;
    e->type = type;
    e->side = side;
    e->price = price;
    e->order_id = order_id;
    e->other_id = other_id;
    e->qty = qty;
    e->a = a;
    e->b = b;
    if (t->count < t->cap) t->count++;
}

uint64_t tracer_oldest_seq(const Tracer *t) {
    return t->next_seq - t->count;
}

const tc_event *tracer_get(const Tracer *t, uint64_t seq) {
    if (seq < tracer_oldest_seq(t) || seq >= t->next_seq) return NULL;
    return &t->buf[seq % t->cap];
}

const char *event_type_name(tc_event_type type) {
    static const char *names[EV__COUNT] = {
        "ORDER_ACCEPTED", "ORDER_REJECTED", "ORDER_RESTED", "ORDER_FILLED",
        "ORDER_CANCELLED", "ORDER_REPLACED", "FILL", "BEST_CHANGED",
        "AVL_VISIT", "AVL_INSERT", "AVL_REMOVE",
        "AVL_ROTATE_LEFT", "AVL_ROTATE_RIGHT",
        "FIFO_ENQUEUE", "FIFO_DEQUEUE", "FIFO_UNLINK", "LEVEL_QTY",
        "HASH_INSERT", "HASH_ERASE", "HASH_RESIZE"
    };
    if ((int)type < 0 || type >= EV__COUNT) return "UNKNOWN";
    return names[type];
}
