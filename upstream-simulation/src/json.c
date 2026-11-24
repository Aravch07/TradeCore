#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "json.h"

/* ------------------------------------------------------------ writer */

void buf_init(Buf *b) { b->s = NULL; b->len = b->cap = 0; }
void buf_free(Buf *b) { free(b->s); buf_init(b); }
void buf_reset(Buf *b) { b->len = 0; if (b->s) b->s[0] = '\0'; }

static void reserve(Buf *b, size_t extra) {
    if (b->len + extra + 1 <= b->cap) return;
    size_t ncap = b->cap ? b->cap : 256;
    while (ncap < b->len + extra + 1) ncap *= 2;
    char *ns = realloc(b->s, ncap);
    if (!ns) { fprintf(stderr, "tradecore: out of memory\n"); abort(); }
    b->s = ns;
    b->cap = ncap;
}

void buf_putn(Buf *b, const char *s, size_t n) {
    reserve(b, n);
    memcpy(b->s + b->len, s, n);
    b->len += n;
    b->s[b->len] = '\0';
}

void buf_puts(Buf *b, const char *s) { buf_putn(b, s, strlen(s)); }

void buf_printf(Buf *b, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char tmp[512];
    int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if ((size_t)n < sizeof tmp) { buf_putn(b, tmp, (size_t)n); return; }
    reserve(b, (size_t)n);
    va_start(ap, fmt);
    vsnprintf(b->s + b->len, (size_t)n + 1, fmt, ap);
    va_end(ap);
    b->len += (size_t)n;
}

void buf_json_str(Buf *b, const char *s) {
    buf_putn(b, "\"", 1);
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; buf_putn(b, e, 2); }
        else if (c == '\n') buf_puts(b, "\\n");
        else if (c == '\t') buf_puts(b, "\\t");
        else if (c < 0x20) buf_printf(b, "\\u%04x", c);
        else buf_putn(b, (const char *)&c, 1);
    }
    buf_putn(b, "\"", 1);
}

void buf_price(Buf *b, tc_price p) {
    if (p < 0) { buf_putn(b, "-", 1); p = -p; }
    buf_printf(b, "%lld.%02lld", (long long)(p / 100), (long long)(p % 100));
}

/* ------------------------------------------------------------ reader */

static const char *skip_ws(const char *p, const char *end) {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
    return p;
}

/* Scan a string starting after the opening quote; returns ptr to closing quote. */
static const char *scan_string(const char *p, const char *end) {
    while (p < end && *p != '"') {
        if (*p == '\\') p++;
        p++;
    }
    return p < end ? p : NULL;
}

int json_parse_flat(const char *s, size_t n, JKV *out, int max) {
    const char *p = s, *end = s + n;
    int count = 0;
    p = skip_ws(p, end);
    if (p >= end || *p != '{') return -1;
    p = skip_ws(p + 1, end);
    if (p < end && *p == '}') return 0;
    while (p < end) {
        if (*p != '"') return -1;
        const char *ks = p + 1, *ke = scan_string(ks, end);
        if (!ke) return -1;
        p = skip_ws(ke + 1, end);
        if (p >= end || *p != ':') return -1;
        p = skip_ws(p + 1, end);
        if (p >= end) return -1;
        JKV kv = { ks, (size_t)(ke - ks), NULL, 0, JV_NULL };
        if (*p == '"') {
            const char *vs = p + 1, *ve = scan_string(vs, end);
            if (!ve) return -1;
            kv.val = vs; kv.vlen = (size_t)(ve - vs); kv.type = JV_STRING;
            p = ve + 1;
        } else {
            const char *vs = p;
            while (p < end && *p != ',' && *p != '}' && *p != ' ' &&
                   *p != '\n' && *p != '\r' && *p != '\t') p++;
            kv.val = vs; kv.vlen = (size_t)(p - vs);
            if (kv.vlen == 0) return -1;
            if (*vs == '{' || *vs == '[') return -1;      /* not flat */
            if ((kv.vlen == 4 && !memcmp(vs, "true", 4)) ||
                (kv.vlen == 5 && !memcmp(vs, "false", 5))) kv.type = JV_BOOL;
            else if (kv.vlen == 4 && !memcmp(vs, "null", 4)) kv.type = JV_NULL;
            else kv.type = JV_NUMBER;
        }
        if (count < max) out[count++] = kv;
        p = skip_ws(p, end);
        if (p < end && *p == ',') { p = skip_ws(p + 1, end); continue; }
        if (p < end && *p == '}') return count;
        return -1;
    }
    return -1;
}

const JKV *json_find(const JKV *kv, int n, const char *key) {
    size_t kl = strlen(key);
    for (int i = 0; i < n; i++)
        if (kv[i].klen == kl && memcmp(kv[i].key, key, kl) == 0) return &kv[i];
    return NULL;
}

int json_get_str(const JKV *kv, int n, const char *key, char *out, size_t cap) {
    const JKV *v = json_find(kv, n, key);
    if (!v || v->type != JV_STRING || cap == 0) return 0;
    size_t j = 0;
    for (size_t i = 0; i < v->vlen && j + 1 < cap; i++) {
        char c = v->val[i];
        if (c == '\\' && i + 1 < v->vlen) c = v->val[++i];   /* basic unescape */
        out[j++] = c;
    }
    out[j] = '\0';
    return 1;
}

int json_get_i64(const JKV *kv, int n, const char *key, int64_t *out) {
    const JKV *v = json_find(kv, n, key);
    if (!v || (v->type != JV_NUMBER && v->type != JV_STRING) || v->vlen == 0 || v->vlen > 18)
        return 0;
    size_t i = 0;
    int neg = 0;
    if (v->val[0] == '-') { neg = 1; i = 1; }
    if (i == v->vlen) return 0;
    int64_t x = 0;
    for (; i < v->vlen; i++) {
        if (v->val[i] < '0' || v->val[i] > '9') return 0;   /* integers only */
        x = x * 10 + (v->val[i] - '0');
    }
    *out = neg ? -x : x;
    return 1;
}

int json_get_bool(const JKV *kv, int n, const char *key, int *out) {
    const JKV *v = json_find(kv, n, key);
    if (!v || v->type != JV_BOOL) return 0;
    *out = v->val[0] == 't';
    return 1;
}

/* Decimal rupees string -> paise, using integers only (no float). */
int parse_price_str(const char *s, size_t n, tc_price *out) {
    size_t i = 0;
    int neg = 0;
    if (n == 0) return 0;
    if (s[0] == '-') { neg = 1; i++; }
    int64_t whole = 0, frac = 0;
    int digits = 0, fdigits = 0;
    for (; i < n && s[i] >= '0' && s[i] <= '9'; i++) {
        if (++digits > 12) return 0;
        whole = whole * 10 + (s[i] - '0');
    }
    if (i < n && s[i] == '.') {
        for (i++; i < n && s[i] >= '0' && s[i] <= '9'; i++) {
            if (fdigits < 2) { frac = frac * 10 + (s[i] - '0'); fdigits++; }
            else if (s[i] != '0') return 0;     /* finer than 1 paisa */
        }
    }
    if (i != n || (digits == 0 && fdigits == 0)) return 0;
    if (fdigits == 1) frac *= 10;
    tc_price p = whole * 100 + frac;
    *out = neg ? -p : p;
    return 1;
}

int json_get_price(const JKV *kv, int n, const char *key, tc_price *out) {
    const JKV *v = json_find(kv, n, key);
    if (!v || (v->type != JV_NUMBER && v->type != JV_STRING)) return 0;
    return parse_price_str(v->val, v->vlen, out);
}
