/*
 * auth.h - User accounts and login sessions.
 *
 * Two string-keyed hash tables (separate chaining, FNV-1a hash):
 *   users    : lower-case username -> User
 *   sessions : random 64-hex-char token -> Session
 *
 * Passwords are never stored. Each user gets a random 16-byte salt and we keep
 * SHA-256 applied AUTH_ROUNDS times to (salt, password). Logging in recomputes
 * the hash and compares in constant time.
 *
 * Accounts live in memory only (no persistence), so they reset when the
 * server restarts; the demo accounts are created again at start-up.
 */
#ifndef TC_AUTH_H
#define TC_AUTH_H

#include <stdint.h>
#include <stddef.h>
#include "types.h"

#define AUTH_ROUNDS        20000
#define AUTH_SESSION_MS    (12LL * 3600 * 1000)   /* 12 hours */
#define AUTH_TOKEN_LEN     64

typedef struct {
    char     name[TC_TRADER_LEN];     /* display name, also the order "trader" */
    uint8_t  salt[16];
    uint8_t  hash[32];
    int64_t  created_ms;
    int64_t  last_login_ms;
    int      is_demo;
} User;

typedef struct {
    char     token[AUTH_TOKEN_LEN + 1];
    char     user_key[TC_TRADER_LEN];
    int64_t  expires_ms;
} Session;

/* Generic string-keyed hash table with separate chaining. */
typedef struct SNode { char *key; void *val; struct SNode *next; } SNode;
typedef struct {
    SNode  **buckets;
    size_t   cap, size;
} StrMap;

int    strmap_init(StrMap *m, size_t cap);
void   strmap_free(StrMap *m, void (*free_val)(void *));
void  *strmap_get(const StrMap *m, const char *key);
int    strmap_put(StrMap *m, const char *key, void *val);   /* 0 ok, -1 oom */
void  *strmap_remove(StrMap *m, const char *key);

typedef enum {
    AUTH_OK = 0, AUTH_BAD_USERNAME, AUTH_BAD_PASSWORD_RULES, AUTH_TAKEN,
    AUTH_WRONG_CREDENTIALS, AUTH_NO_SESSION, AUTH_NO_MEMORY
} auth_status;

typedef struct {
    StrMap users;
    StrMap sessions;
} Auth;

int          auth_init(Auth *a);
void         auth_free(Auth *a);
auth_status  auth_register(Auth *a, const char *name, const char *password, int is_demo, int64_t now_ms);
/* On success writes a new session token (AUTH_TOKEN_LEN chars + NUL). */
auth_status  auth_login(Auth *a, const char *name, const char *password, int64_t now_ms, char *token_out);
/* Returns the user for a valid, unexpired token, else NULL. */
const User  *auth_check(Auth *a, const char *token, int64_t now_ms);
void         auth_logout(Auth *a, const char *token);
const char  *auth_message(auth_status s);
const char  *auth_code(auth_status s);
int          auth_valid_username(const char *name);
void         auth_random_bytes(uint8_t *out, size_t n);

#endif
