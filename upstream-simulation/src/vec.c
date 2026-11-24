#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "vec.h"

void vec_init(Vec *v, size_t elem_size) {
    v->data = NULL;
    v->len = v->cap = 0;
    v->elem = elem_size;
}

void vec_free(Vec *v) {
    free(v->data);
    v->data = NULL;
    v->len = v->cap = 0;
}

void vec_clear(Vec *v) { v->len = 0; }

void *vec_push(Vec *v) {
    if (v->len == v->cap) {
        size_t ncap = v->cap ? v->cap * 2 : 64;          /* doubling */
        void *nd = realloc(v->data, ncap * v->elem);
        if (!nd) return NULL;
        v->data = nd;
        v->cap = ncap;
    }
    void *slot = (char *)v->data + v->len * v->elem;
    memset(slot, 0, v->elem);
    v->len++;
    return slot;
}

void *vec_at(const Vec *v, size_t i) {
    assert(i < v->len);
    return (char *)v->data + i * v->elem;
}
