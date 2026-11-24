/*
 * api.h - Turns HTTP requests into engine commands and JSON responses.
 * Kept separate from the socket code so it can be read on its own.
 */
#ifndef TC_API_H
#define TC_API_H

#include "engine.h"
#include "json.h"

typedef struct {
    int  status;          /* HTTP status code                          */
    Buf  body;            /* JSON body                                 */
    Buf  broadcast;       /* SSE text to push to every stream client   */
} ApiResponse;

typedef struct {
    Engine engine;
    int    stream_trace;  /* push detailed trace events over SSE? */
    int64_t started_ms;
} ApiState;

int  api_init(ApiState *s);
void api_free(ApiState *s);
void api_handle(ApiState *s, const char *method, const char *path,
                const char *query, const char *body, size_t body_len,
                ApiResponse *out);
/* Text sent to a client right after it opens /api/stream. */
void api_stream_hello(ApiState *s, Buf *out);

#endif
