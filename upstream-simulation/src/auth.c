/*
 * auth.c - Accounts, password hashing and sessions.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <time.h>
#include "auth.h"
#include "sha256.h"

/* ------------------------------------------------------- string hash map */

/* FNV-1a: simple, well-distributed hash for short strings. */
static uint64_t fnv1a(const char *s) {
    uint64_t h = 1469598103934665603ULL;
    while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211ULL; }
    return h;
}

int strmap_init(StrMap *m, size_t cap) {
    size_t p = 16;
    while (p < cap) p <<= 1;
    m->buckets = calloc(p, sizeof(SNode *));
    if (!m->buckets) return -1;
    m->cap = p;
    m->size = 0;
    return 0;
}

void strmap_free(StrMap *m, void (*free_val)(void *)) {
    for (size_t i = 0; i < m->cap; i++) {
        SNode *n = m->buckets[i];
        while (n) {
            SNode *nx = n->next;
            if (free_val) free_val(n->val);
            free(n->key);
            free(n);
            n = nx;
        }
    }
    free(m->buckets);
    m->buckets = NULL;
    m->cap = m->size = 0;
}

void *strmap_get(const StrMap *m, const char *key) {
    for (SNode *n = m->buckets[fnv1a(key) & (m->cap - 1)]; n; n = n->next)
        if (!strcmp(n->key, key)) return n->val;
    return NULL;
}

static int strmap_grow(StrMap *m) {
    size_t ncap = m->cap * 2;
    SNode **nb = calloc(ncap, sizeof(SNode *));
    if (!nb) return -1;
    for (size_t i = 0; i < m->cap; i++) {
        SNode *n = m->buckets[i];
        while (n) {
            SNode *nx = n->next;
            size_t j = fnv1a(n->key) & (ncap - 1);
            n->next = nb[j];
            nb[j] = n;
            n = nx;
        }
    }
    free(m->buckets);
    m->buckets = nb;
    m->cap = ncap;
    return 0;
}

int strmap_put(StrMap *m, const char *key, void *val) {
    if ((m->size + 1) * 4 > m->cap * 3 && strmap_grow(m) != 0) return -1;
    size_t b = fnv1a(key) & (m->cap - 1);
    SNode *n = malloc(sizeof *n);
    if (!n) return -1;
    n->key = malloc(strlen(key) + 1);
    if (!n->key) { free(n); return -1; }
    strcpy(n->key, key);
    n->val = val;
    n->next = m->buckets[b];
    m->buckets[b] = n;
    m->size++;
    return 0;
}

void *strmap_remove(StrMap *m, const char *key) {
    SNode **pp = &m->buckets[fnv1a(key) & (m->cap - 1)];
    while (*pp) {
        if (!strcmp((*pp)->key, key)) {
            SNode *dead = *pp;
            void *v = dead->val;
            *pp = dead->next;
            free(dead->key);
            free(dead);
            m->size--;
            return v;
        }
        pp = &(*pp)->next;
    }
    return NULL;
}

/* ------------------------------------------------------------- helpers */

void auth_random_bytes(uint8_t *out, size_t n) {
    FILE *f = fopen("/dev/urandom", "rb");
    size_t got = f ? fread(out, 1, n, f) : 0;
    if (f) fclose(f);
    if (got == n) return;
    /* fallback (should not happen on macOS/Linux) */
    uint64_t x = (uint64_t)time(NULL) ^ (uint64_t)(uintptr_t)out;
    for (size_t i = got; i < n; i++) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        out[i] = (uint8_t)x;
    }
}

static void lower_key(const char *name, char *key) {
    size_t i = 0;
    for (; name[i] && i < TC_TRADER_LEN - 1; i++) key[i] = (char)tolower((unsigned char)name[i]);
    key[i] = '\0';
}

int auth_valid_username(const char *name) {
    size_t n = strlen(name);
    if (n < 3 || n > TC_TRADER_LEN - 1) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)name[i];
        if (!isalnum(c) && c != '_' && c != '-' && c != '.') return 0;
    }
    return 1;
}

static void hash_password(const uint8_t salt[16], const char *pw, uint8_t out[32]) {
    Sha256 c;
    sha256_init(&c);
    sha256_update(&c, salt, 16);
    sha256_update(&c, pw, strlen(pw));
    sha256_final(&c, out);
    /* key stretching: makes guessing passwords slower */
    for (int i = 1; i < AUTH_ROUNDS; i++) {
        sha256_init(&c);
        sha256_update(&c, out, 32);
        sha256_update(&c, salt, 16);
        sha256_final(&c, out);
    }
}

/* compare without stopping early, so timing doesn't leak where it differs */
static int equal_ct(const uint8_t *a, const uint8_t *b, size_t n) {
    uint8_t d = 0;
    for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i];
    return d == 0;
}

/* --------------------------------------------------------------- public */

int auth_init(Auth *a) {
    if (strmap_init(&a->users, 64) != 0) return -1;
    if (strmap_init(&a->sessions, 64) != 0) return -1;
    return 0;
}

void auth_free(Auth *a) {
    strmap_free(&a->users, free);
    strmap_free(&a->sessions, free);
}

auth_status auth_register(Auth *a, const char *name, const char *password, int is_demo, int64_t now_ms) {
    if (!auth_valid_username(name)) return AUTH_BAD_USERNAME;
    size_t pl = strlen(password);
    if (pl < 6 || pl > 64) return AUTH_BAD_PASSWORD_RULES;
    char key[TC_TRADER_LEN];
    lower_key(name, key);
    if (strmap_get(&a->users, key)) return AUTH_TAKEN;
    User *u = calloc(1, sizeof *u);
    if (!u) return AUTH_NO_MEMORY;
    strncpy(u->name, name, TC_TRADER_LEN - 1);
    auth_random_bytes(u->salt, sizeof u->salt);
    hash_password(u->salt, password, u->hash);
    u->created_ms = now_ms;
    u->is_demo = is_demo;
    if (strmap_put(&a->users, key, u) != 0) { free(u); return AUTH_NO_MEMORY; }
    return AUTH_OK;
}

auth_status auth_login(Auth *a, const char *name, const char *password, int64_t now_ms, char *token_out) {
    char key[TC_TRADER_LEN];
    if (strlen(name) >= TC_TRADER_LEN) return AUTH_WRONG_CREDENTIALS;
    lower_key(name, key);
    User *u = strmap_get(&a->users, key);
    uint8_t h[32];
    /* hash even for unknown users so both cases take the same time */
    static const uint8_t dummy_salt[16] = { 0 };
    hash_password(u ? u->salt : dummy_salt, password, h);
    if (!u || !equal_ct(h, u->hash, 32)) return AUTH_WRONG_CREDENTIALS;

    Session *s = calloc(1, sizeof *s);
    if (!s) return AUTH_NO_MEMORY;
    uint8_t raw[AUTH_TOKEN_LEN / 2];
    auth_random_bytes(raw, sizeof raw);
    for (size_t i = 0; i < sizeof raw; i++) sprintf(s->token + 2 * i, "%02x", raw[i]);
    strcpy(s->user_key, key);
    s->expires_ms = now_ms + AUTH_SESSION_MS;
    if (strmap_put(&a->sessions, s->token, s) != 0) { free(s); return AUTH_NO_MEMORY; }
    u->last_login_ms = now_ms;
    strcpy(token_out, s->token);
    return AUTH_OK;
}

const User *auth_check(Auth *a, const char *token, int64_t now_ms) {
    if (!token || strlen(token) != AUTH_TOKEN_LEN) return NULL;
    Session *s = strmap_get(&a->sessions, token);
    if (!s) return NULL;
    if (s->expires_ms < now_ms) { free(strmap_remove(&a->sessions, token)); return NULL; }
    return strmap_get(&a->users, s->user_key);
}

void auth_logout(Auth *a, const char *token) {
    if (token) free(strmap_remove(&a->sessions, token));
}

const char *auth_code(auth_status s) {
    switch (s) {
    case AUTH_OK: return "OK";
    case AUTH_BAD_USERNAME: return "INVALID_USERNAME";
    case AUTH_BAD_PASSWORD_RULES: return "WEAK_PASSWORD";
    case AUTH_TAKEN: return "USERNAME_TAKEN";
    case AUTH_WRONG_CREDENTIALS: return "WRONG_CREDENTIALS";
    case AUTH_NO_SESSION: return "NOT_LOGGED_IN";
    case AUTH_NO_MEMORY: return "OUT_OF_MEMORY";
    }
    return "ERROR";
}

const char *auth_message(auth_status s) {
    switch (s) {
    case AUTH_OK: return "ok";
    case AUTH_BAD_USERNAME: return "Username must be 3-15 characters: letters, numbers, _ - .";
    case AUTH_BAD_PASSWORD_RULES: return "Password must be 6-64 characters.";
    case AUTH_TAKEN: return "That username is already taken.";
    case AUTH_WRONG_CREDENTIALS: return "Wrong username or password.";
    case AUTH_NO_SESSION: return "Please sign in first.";
    case AUTH_NO_MEMORY: return "Server out of memory.";
    }
    return "error";
}
