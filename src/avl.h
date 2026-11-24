/*
 * avl.h - Self-balancing binary search tree of price levels.
 *
 * One tree holds the BID levels, another the ASK levels. Keys are integer
 * prices. AVL rule: at every node, |height(left) - height(right)| <= 1, which
 * keeps the height <= ~1.44 log2(P), so find/insert/remove are O(log P)
 * worst case (P = number of price levels).
 *
 * The best price (max bid / min ask) is cached in `best`, so reading it is
 * O(1). The cache is refreshed only when the tree changes.
 */
#ifndef TC_AVL_H
#define TC_AVL_H

#include "types.h"
#include "trace.h"

typedef struct {
    PriceLevel *root;
    PriceLevel *best;        /* cached: max price if is_bid, else min */
    int         is_bid;
    tc_side     side;
    size_t      size;        /* number of levels (P for this side)   */
    uint32_t    next_node_id;
    Tracer     *tracer;
    tc_counters *ctr;
} AvlTree;

void        avl_init(AvlTree *t, tc_side side, Tracer *tr, tc_counters *c);
void        avl_destroy(AvlTree *t);   /* frees levels (not orders) */
PriceLevel *avl_find(AvlTree *t, tc_price price);
/* Find the level for `price`, creating it if absent. NULL on out-of-memory. */
PriceLevel *avl_find_or_insert(AvlTree *t, tc_price price);
/* Remove (and free) an EMPTY level. */
void        avl_remove(AvlTree *t, PriceLevel *lv);
int         avl_height(const PriceLevel *n);

#endif
