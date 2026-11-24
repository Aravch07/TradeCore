/*
 * reference.h - Deliberately simple LINEAR reference matcher.
 *
 * It keeps every resting order in one plain array and finds the best order
 * by scanning all of them: O(N) per step. It is slow but obviously correct,
 * so the tests run the real engine and this matcher side by side on the same
 * command stream and require identical fills.
 */
#ifndef TC_REFERENCE_H
#define TC_REFERENCE_H

#include "types.h"

typedef struct {
    tc_id id; tc_seq seq; tc_side side; tc_price price; tc_qty rem;
} RefOrder;

typedef struct {
    tc_id maker, taker; tc_price price; tc_qty qty;
} RefFill;

typedef struct {
    RefOrder *a;
    size_t n, cap;
    tc_id next_id;
    tc_seq seq;
    RefFill *fills;
    size_t nfills, fcap;
    tc_id max_id;          /* ids <= max_id have existed */
} RefBook;

void  ref_init(RefBook *b);
void  ref_free(RefBook *b);
/* Each returns 1 if accepted, 0 if rejected. Fills are appended to b->fills. */
int   ref_submit(RefBook *b, tc_side side, tc_price price, tc_qty qty, tc_id *new_id);
int   ref_cancel(RefBook *b, tc_id id);
int   ref_replace(RefBook *b, tc_id id, tc_price price, tc_qty qty, tc_id *new_id);
int   ref_best(const RefBook *b, tc_side side, tc_price *price, tc_qty *total);

#endif
