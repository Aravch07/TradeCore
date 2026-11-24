/*
 * json.h - Minimal JSON writer (growable string buffer) and a reader for
 * flat request objects such as {"side":"buy","price":101.00,"qty":200}.
 */
#ifndef TC_JSON_H
#define TC_JSON_H

#include <stddef.h>
#include <stdint.h>
#include "types.h"

typedef struct { char *s; size_t len, cap; } Buf;

void buf_init(Buf *b);
void buf_free(Buf *b);
void buf_reset(Buf *b);
void buf_putn(Buf *b, const char *s, size_t n);
void buf_puts(Buf *b, const char *s);
void buf_printf(Buf *b, const char *fmt, ...);
void buf_json_str(Buf *b, const char *s);      /* quoted + escaped */
void buf_price(Buf *b, tc_price p);            /* 10100 -> 101.00  */

/* ---- reader for one flat object ---- */
typedef enum { JV_STRING, JV_NUMBER, JV_BOOL, JV_NULL } jv_type;
typedef struct {
    const char *key;  size_t klen;
    const char *val;  size_t vlen;   /* string: contents without quotes */
    jv_type type;
} JKV;

/* Returns number of pairs parsed, or -1 if not a flat JSON object. */
int json_parse_flat(const char *s, size_t n, JKV *out, int max);
const JKV *json_find(const JKV *kv, int n, const char *key);
int json_get_str(const JKV *kv, int n, const char *key, char *out, size_t cap);
int json_get_i64(const JKV *kv, int n, const char *key, int64_t *out);
int json_get_bool(const JKV *kv, int n, const char *key, int *out);
/* Price as number or string, e.g. 101, 101.5, "101.05". Rejects >2 decimals. */
int json_get_price(const JKV *kv, int n, const char *key, tc_price *out);
int parse_price_str(const char *s, size_t n, tc_price *out);

#endif
