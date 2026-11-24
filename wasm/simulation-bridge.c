/* Browser adapter for Aaryaman-25/TradeCore f30903c. */
#include <string.h>
#include "api.h"
static ApiState state;
static ApiResponse response;
static Buf stream;
int tc_init(void) { return api_init(&state, 1); }
int tc_request(const char *method, const char *path, const char *query, const char *body, const char *token) {
    buf_free(&response.body); buf_free(&response.broadcast); response.status = 200;
    api_handle(&state, method, path, query, body, strlen(body), token && *token ? token : NULL, &response);
    return response.status;
}
const char *tc_json(void) { return response.body.s ? response.body.s : "{}"; }
const char *tc_events(void) { return response.broadcast.s ? response.broadcast.s : ""; }
const char *tc_tick(int64_t now_ms) {
    buf_free(&stream); api_sim_tick(&state, now_ms, &stream);
    return stream.s ? stream.s : "";
}
