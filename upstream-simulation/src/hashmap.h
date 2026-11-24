/*
 * hashmap.h - Order id -> Order* hash table with SEPARATE CHAINING.
 *
 * buckets[i] is the head of a singly linked list ("chain") of entries whose
 * hash lands in bucket i. With load factor kept <= 0.75, the expected chain
 * length is constant, so lookup / insert / erase are expected O(1).
 * Worst case (all keys collide) is O(N). Doubling the capacity costs O(N)
 * but happens rarely, so it is amortized O(1) per insert.
 */
#ifndef TC_HASHMAP_H
#define TC_HASHMAP_H

#include "types.h"
#include "trace.h"

typedef struct HEntry {
    tc_id key;
    Order *val;
    struct HEntry *next;
} HEntry;

typedef struct {
    HEntry **buckets;
    size_t   cap;           /* always a power of two */
    size_t   size;
    Tracer  *tracer;
    tc_counters *ctr;
} HashMap;

int    hm_init(HashMap *m, size_t cap, Tracer *t, tc_counters *c);
void   hm_free(HashMap *m);
int    hm_put(HashMap *m, tc_id key, Order *val);   /* 0 ok, -1 oom */
Order *hm_get(HashMap *m, tc_id key);
Order *hm_erase(HashMap *m, tc_id key);             /* returns removed value */
size_t hm_bucket_of(const HashMap *m, tc_id key);
size_t hm_chain_len(const HashMap *m, size_t bucket);

#endif
