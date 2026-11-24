/*
 * trace.h - Ordered trace events emitted by the engine.
 *
 * Every interesting operation (a tree rotation, a FIFO dequeue, a fill...)
 * becomes one event with a global, strictly increasing sequence number. The
 * dashboard replays these to animate the data structures, so what you see
 * is exactly what the C code did.
 *
 * Events live in a RING BUFFER (fixed-size circular array): when it is full,
 * the oldest event is overwritten. A client that asks for events older than
 * the oldest one kept is told there is a "gap" and should reload a snapshot.
 */
#ifndef TC_TRACE_H
#define TC_TRACE_H

#include "types.h"

typedef enum {
    /* market-level events (always recorded while tracing is on) */
    EV_ORDER_ACCEPTED, EV_ORDER_REJECTED, EV_ORDER_RESTED, EV_ORDER_FILLED,
    EV_ORDER_CANCELLED, EV_ORDER_REPLACED, EV_FILL, EV_BEST_CHANGED,
    /* DSA-level events (recorded only in "detailed" mode) */
    EV_AVL_VISIT, EV_AVL_INSERT, EV_AVL_REMOVE,
    EV_AVL_ROTATE_LEFT, EV_AVL_ROTATE_RIGHT,
    EV_FIFO_ENQUEUE, EV_FIFO_DEQUEUE, EV_FIFO_UNLINK, EV_LEVEL_QTY,
    EV_HASH_INSERT, EV_HASH_ERASE, EV_HASH_RESIZE,
    EV__COUNT
} tc_event_type;

/* Generic event record. Meaning of a/b depends on type (see trace.c). */
typedef struct {
    uint64_t seq;          /* global event sequence                 */
    tc_seq   cmd_seq;      /* command that produced it              */
    tc_event_type type;
    int      side;         /* TC_BUY / TC_SELL, or -1 if not relevant */
    tc_price price;
    tc_id    order_id;
    tc_id    other_id;
    tc_qty   qty;
    int64_t  a, b;
} tc_event;

typedef struct {
    tc_event *buf;
    size_t    cap;
    size_t    count;       /* events currently stored (<= cap)      */
    uint64_t  next_seq;    /* seq the next event will receive       */
    int       enabled;     /* record anything at all?               */
    int       detailed;    /* also record DSA-level events?         */
    tc_seq    cur_cmd;
} Tracer;

int   tracer_init(Tracer *t, size_t capacity);
void  tracer_free(Tracer *t);
void  tracer_clear(Tracer *t);
void  tracer_emit(Tracer *t, tc_event_type type, int side, tc_price price,
                  tc_id order_id, tc_id other_id, tc_qty qty,
                  int64_t a, int64_t b);
uint64_t tracer_oldest_seq(const Tracer *t);
/* Returns pointer to event with given seq, or NULL if not kept. */
const tc_event *tracer_get(const Tracer *t, uint64_t seq);
const char *event_type_name(tc_event_type type);
int   event_is_detailed(tc_event_type type);

#endif
