/*
 * hashmap.c - Separate-chaining hash table.
 */
#include <stdlib.h>
#include "hashmap.h"

/*
 * Mix the bits of the key (SplitMix64 finalizer). Order ids are sequential
 * (1, 2, 3, ...), and mixing spreads them evenly instead of relying on the
 * low bits alone.
 */
static uint64_t mix64(uint64_t x) {
    x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27; x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

size_t hm_bucket_of(const HashMap *m, tc_id key) {
    return (size_t)(mix64(key) & (m->cap - 1));   /* cap is a power of 2 */
}

int hm_init(HashMap *m, size_t cap, Tracer *t, tc_counters *c) {
    size_t p = 16;
    while (p < cap) p <<= 1;
    m->buckets = calloc(p, sizeof(HEntry *));
    if (!m->buckets) return -1;
    m->cap = p;
    m->size = 0;
    m->tracer = t;
    m->ctr = c;
    return 0;
}

void hm_free(HashMap *m) {
    for (size_t i = 0; i < m->cap; i++) {
        HEntry *e = m->buckets[i];
        while (e) { HEntry *n = e->next; free(e); m->ctr->frees++; e = n; }
    }
    free(m->buckets);
    m->buckets = NULL;
    m->size = m->cap = 0;
}

/* Rehash every entry into a table twice as big. O(N). */
static int grow(HashMap *m) {
    size_t ncap = m->cap * 2;
    HEntry **nb = calloc(ncap, sizeof(HEntry *));
    if (!nb) return -1;
    size_t old = m->cap;
    for (size_t i = 0; i < old; i++) {
        HEntry *e = m->buckets[i];
        while (e) {
            HEntry *n = e->next;
            size_t j = (size_t)(mix64(e->key) & (ncap - 1));
            e->next = nb[j];
            nb[j] = e;
            e = n;
        }
    }
    free(m->buckets);
    m->buckets = nb;
    m->cap = ncap;
    m->ctr->hash_resizes++;
    tracer_emit(m->tracer, EV_HASH_RESIZE, -1, 0, 0, 0, 0,
                (int64_t)old, (int64_t)ncap);
    return 0;
}

int hm_put(HashMap *m, tc_id key, Order *val) {
    /* keep load factor size/cap <= 0.75 */
    if ((m->size + 1) * 4 > m->cap * 3 && grow(m) != 0) return -1;
    size_t b = hm_bucket_of(m, key);
    HEntry *e = malloc(sizeof *e);
    if (!e) return -1;
    m->ctr->allocs++;
    e->key = key;
    e->val = val;
    e->next = m->buckets[b];      /* insert at chain head: O(1) */
    m->buckets[b] = e;
    m->size++;
    m->ctr->hash_inserts++;
    tracer_emit(m->tracer, EV_HASH_INSERT, -1, 0, key, 0, 0,
                (int64_t)b, (int64_t)hm_chain_len(m, b));
    return 0;
}

Order *hm_get(HashMap *m, tc_id key) {
    m->ctr->hash_lookups++;
    for (HEntry *e = m->buckets[hm_bucket_of(m, key)]; e; e = e->next) {
        m->ctr->hash_probes++;
        if (e->key == key) return e->val;
    }
    return NULL;
}

Order *hm_erase(HashMap *m, tc_id key) {
    size_t b = hm_bucket_of(m, key);
    HEntry **pp = &m->buckets[b];   /* pointer to the link we may rewrite */
    int64_t probes = 0;
    m->ctr->hash_lookups++;
    while (*pp) {
        probes++;
        m->ctr->hash_probes++;
        if ((*pp)->key == key) {
            HEntry *dead = *pp;
            Order *v = dead->val;
            *pp = dead->next;
            free(dead);
            m->ctr->frees++;
            m->size--;
            m->ctr->hash_erases++;
            tracer_emit(m->tracer, EV_HASH_ERASE, -1, 0, key, 0, 0,
                        (int64_t)b, probes);
            return v;
        }
        pp = &(*pp)->next;
    }
    return NULL;
}

size_t hm_chain_len(const HashMap *m, size_t bucket) {
    size_t n = 0;
    for (HEntry *e = m->buckets[bucket]; e; e = e->next) n++;
    return n;
}
