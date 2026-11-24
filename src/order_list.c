/*
 * order_list.c - Doubly linked FIFO operations.
 *
 *        head                               tail
 *         |                                  |
 *   NULL <- [S1] <-> [S2] <-> [S3] <-> [S4] -> NULL
 *
 * Every operation only touches a constant number of pointers, so all are O(1).
 */
#include "order_list.h"

void fifo_push_back(PriceLevel *lv, Order *o, Tracer *t, tc_counters *c) {
    o->level = lv;
    o->next = NULL;
    o->prev = lv->tail;
    if (lv->tail) lv->tail->next = o;   /* old tail now points to new order */
    else          lv->head = o;         /* queue was empty                  */
    lv->tail = o;
    lv->count++;
    lv->total_qty += o->remaining;
    c->fifo_enqueues++;
    tracer_emit(t, EV_FIFO_ENQUEUE, o->side, lv->price, o->id, 0,
                o->remaining, (int64_t)lv->count, lv->node_id);
    tracer_emit(t, EV_LEVEL_QTY, o->side, lv->price, 0, 0,
                lv->total_qty, lv->node_id, 0);
}

Order *fifo_pop_front(PriceLevel *lv, Tracer *t, tc_counters *c) {
    Order *o = lv->head;
    if (!o) return NULL;
    lv->head = o->next;
    if (lv->head) lv->head->prev = NULL;
    else          lv->tail = NULL;      /* queue became empty */
    lv->count--;
    lv->total_qty -= o->remaining;      /* normally 0 when popped after a fill */
    o->next = o->prev = NULL;
    o->level = NULL;
    c->fifo_dequeues++;
    tracer_emit(t, EV_FIFO_DEQUEUE, o->side, lv->price, o->id, 0,
                o->remaining, (int64_t)lv->count, lv->node_id);
    return o;
}

void fifo_unlink(PriceLevel *lv, Order *o, Tracer *t, tc_counters *c) {
    /* bridge the neighbours over the removed node */
    if (o->prev) o->prev->next = o->next;
    else         lv->head = o->next;    /* o was the head */
    if (o->next) o->next->prev = o->prev;
    else         lv->tail = o->prev;    /* o was the tail */
    lv->count--;
    lv->total_qty -= o->remaining;
    o->next = o->prev = NULL;
    o->level = NULL;
    c->fifo_unlinks++;
    tracer_emit(t, EV_FIFO_UNLINK, o->side, lv->price, o->id, 0,
                o->remaining, (int64_t)lv->count, lv->node_id);
    tracer_emit(t, EV_LEVEL_QTY, o->side, lv->price, 0, 0,
                lv->total_qty, lv->node_id, 0);
}

void level_reduce(PriceLevel *lv, tc_qty qty, Tracer *t) {
    lv->total_qty -= qty;
    tracer_emit(t, EV_LEVEL_QTY, lv->head ? (int)lv->head->side : -1,
                lv->price, 0, 0, lv->total_qty, lv->node_id, 0);
}
