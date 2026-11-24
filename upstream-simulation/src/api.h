/*
 * api.h - Turns HTTP requests into engine commands and JSON responses.
 * Kept separate from the socket code so it can be read on its own.
 */
#ifndef TC_API_H
#define TC_API_H

#include "engine.h"
#include "json.h"
#include "auth.h"
#include "sim.h"

typedef struct {
    int  status;          /* HTTP status code                          */
    Buf  body;            /* JSON body                                 */
    Buf  broadcast;       /* SSE text to push to every stream client   */
} ApiResponse;

typedef struct {
    Engine engine;
    Auth   auth;
    Sim    sim;
    int    stream_trace;  /* push detailed trace events over SSE? */
    int64_t started_ms;
} ApiState;

/* with_sim: seed 3 hours of bot history and start the live bots. */
int  api_init(ApiState *s, int with_sim);
void api_free(ApiState *s);
/* token: value of "Authorization: Bearer <token>", or NULL. */
void api_handle(ApiState *s, const char *method, const char *path,
                const char *query, const char *body, size_t body_len,
                const char *token, ApiResponse *out);
/* Run bot steps that are due at now_ms; SSE text is appended to broadcast.
 * Returns milliseconds until the next step is due (or 1000 if paused). */
int64_t api_sim_tick(ApiState *s, int64_t now_ms, Buf *broadcast);
/* Text sent to a client right after it opens /api/stream. */
void api_stream_hello(ApiState *s, Buf *out);

#endif
