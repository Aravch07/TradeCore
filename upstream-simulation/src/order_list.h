/*
 * order_list.h - FIFO queue of orders at one price level, implemented as a
 * doubly linked list (head = oldest = first to trade, tail = newest).
 *
 *   push_back : O(1)  new order joins the back of the queue
 *   pop_front : O(1)  head order is fully filled
 *   unlink    : O(1)  cancel an order anywhere in the queue (needs pointer)
 *
 * These functions also keep level->total_qty and level->count up to date.
 */
#ifndef TC_ORDER_LIST_H
#define TC_ORDER_LIST_H

#include "types.h"
#include "trace.h"

void   fifo_push_back(PriceLevel *lv, Order *o, Tracer *t, tc_counters *c);
Order *fifo_pop_front(PriceLevel *lv, Tracer *t, tc_counters *c);
void   fifo_unlink(PriceLevel *lv, Order *o, Tracer *t, tc_counters *c);
/* A partial fill of the head reduces the level aggregate. */
void   level_reduce(PriceLevel *lv, tc_qty qty, Tracer *t);

#endif
