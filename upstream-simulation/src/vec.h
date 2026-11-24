/*
 * vec.h - Generic dynamic array (like a growable C array).
 *
 *   index  : O(1)
 *   push   : amortized O(1) - when full, capacity doubles and elements are
 *            copied once; over n pushes total copying is < 2n.
 *
 * Used for trade history and order history records.
 */
#ifndef TC_VEC_H
#define TC_VEC_H

#include <stddef.h>

typedef struct {
    void  *data;
    size_t len, cap, elem;
} Vec;

void  vec_init(Vec *v, size_t elem_size);
void  vec_free(Vec *v);
void  vec_clear(Vec *v);
void *vec_push(Vec *v);                 /* returns zeroed slot, NULL on oom */
void *vec_at(const Vec *v, size_t i);   /* no bounds check beyond assert    */

#endif
