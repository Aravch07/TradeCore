/*
 * types.h - Shared types for the TradeCore matching engine.
 *
 * Every price is stored as a 64-bit integer number of PAISE (1 rupee = 100
 * paise). Integers avoid floating-point rounding errors: 0.1 + 0.2 != 0.3 in
 * floating point, but 10 + 20 == 30 always.
 */
#ifndef TC_TYPES_H
#define TC_TYPES_H

#include <stdint.h>
#include <stddef.h>

typedef int64_t  tc_price;   /* price in paise                      */
typedef int64_t  tc_qty;     /* whole shares                         */
typedef uint64_t tc_id;      /* order id (assigned by engine, from 1) */
typedef uint64_t tc_seq;     /* command sequence number              */

/* Tick size: every price must be a multiple of this (Rs 0.05, as on NSE). */
#define TC_TICK_PAISE   5
#define TC_MAX_PRICE    1000000000LL      /* Rs 1,00,00,000.00 in paise     */
#define TC_MAX_QTY      1000000000LL      /* 100 crore shares per order      */
#define TC_TRADER_LEN   16                /* trader label incl. terminator   */

typedef enum { TC_BUY = 0, TC_SELL = 1 } tc_side;

typedef enum {
    ST_OPEN = 0,      /* resting, nothing filled yet           */
    ST_PARTIAL,       /* resting, some quantity already filled  */
    ST_FILLED,        /* fully executed, no longer in the book  */
    ST_CANCELLED,     /* removed by a cancel command            */
    ST_REPLACED       /* removed by cancel-and-replace          */
} tc_status;

struct PriceLevel;

/*
 * Order: one node of the doubly linked FIFO queue at a price level.
 * prev/next give O(1) unlink of ANY order once we hold a pointer to it
 * (the hash table gives us that pointer).
 */
typedef struct Order {
    tc_id    id;
    tc_seq   seq;            /* engine sequence when accepted (time priority) */
    tc_side  side;
    tc_price price;
    tc_qty   remaining;
    struct PriceLevel *level;      /* back-pointer to the AVL node it lives in */
    struct Order *prev, *next;     /* neighbours in the FIFO                   */
    size_t   record;               /* index of its history record              */
} Order;

/*
 * PriceLevel: one node of an AVL tree AND the head of a FIFO queue.
 * The tree is keyed by price; the queue holds orders at that price in
 * arrival order.
 */
typedef struct PriceLevel {
    tc_price price;
    tc_qty   total_qty;      /* sum of remaining over the FIFO (aggregate) */
    size_t   count;          /* number of orders in the FIFO               */
    Order   *head, *tail;
    struct PriceLevel *left, *right;
    int      height;         /* AVL height (leaf = 1)                       */
    uint32_t node_id;        /* stable id for the visualizer                */
} PriceLevel;

/* Operation counters, reported by /api/stats and the benchmark. */
typedef struct {
    uint64_t commands, accepted, rejected;
    uint64_t submits, cancels, replaces, fills;
    uint64_t avl_visits, avl_inserts, avl_removes, avl_rotations;
    uint64_t fifo_enqueues, fifo_dequeues, fifo_unlinks;
    uint64_t hash_lookups, hash_probes, hash_inserts, hash_erases, hash_resizes;
    uint64_t allocs, frees;
} tc_counters;

#endif
