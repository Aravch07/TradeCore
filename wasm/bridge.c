/* Browser entry points for the original C API; no matching logic is duplicated. */
#include <string.h>
#include "api.h"

static ApiState state;
static ApiResponse response;

int tc_init(void) { return api_init(&state); }

int tc_request(const char *method, const char *path, const char *query,
               const char *body) {
    buf_free(&response.body);
    buf_free(&response.broadcast);
    response.status = 200;
    api_handle(&state, method, path, query, body, strlen(body), &response);
    return response.status;
}

const char *tc_json(void) { return response.body.s ? response.body.s : "{}"; }
const char *tc_events(void) { return response.broadcast.s ? response.broadcast.s : ""; }
