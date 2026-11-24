/*
 * server.c - Single-threaded HTTP/1.1 server with Server-Sent Events.
 *
 * One process, one thread, one engine: every command runs to completion
 * before the next one starts, so mutations are naturally serialized (the
 * "single engine worker" from the proposal) and no locks are needed.
 *
 * poll() watches the listening socket plus every client socket. Normal
 * requests get one response and the connection closes. Requests to
 * /api/stream stay open; after every command the engine's events are written
 * to all of them in text/event-stream format.
 *
 * Usage: ./build/tradecore [--port 8080] [--host 127.0.0.1] [--static DIR]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include "api.h"

#define MAX_CONNS        512
#define MAX_REQUEST      (1 << 20)       /* 1 MiB */
#define SSE_MAX_BACKLOG  (8 << 20)       /* drop a stream client that lags 8 MiB */
#define HEARTBEAT_MS     15000

typedef struct {
    int  fd;
    Buf  in;
    Buf  out;
    size_t out_off;
    int  is_stream;
    int  close_when_done;
} Conn;

static Conn  g_conns[MAX_CONNS];
static int   g_nconns = 0;
static volatile sig_atomic_t g_stop = 0;
static const char *g_static_dir = NULL;

static void on_signal(int sig) { (void)sig; g_stop = 1; }

static void set_nonblocking(int fd) {
    int fl = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static const char *status_text(int code) {
    switch (code) {
    case 200: return "OK";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 413: return "Payload Too Large";
    case 422: return "Unprocessable Entity";
    default:  return "Error";
    }
}

static const char *CORS =
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n"
    "Access-Control-Allow-Headers: Content-Type, Authorization\r\n";

static void respond(Conn *c, int code, const char *ctype, const char *body, size_t len) {
    buf_printf(&c->out, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
               "%sConnection: close\r\n\r\n", code, status_text(code), ctype, len, CORS);
    buf_putn(&c->out, body, len);
    c->close_when_done = 1;
}

static void conn_close(int i) {
    close(g_conns[i].fd);
    buf_free(&g_conns[i].in);
    buf_free(&g_conns[i].out);
    g_conns[i] = g_conns[--g_nconns];   /* swap-remove */
}

static void broadcast(const Buf *msg) {
    if (!msg->len) return;
    for (int i = 0; i < g_nconns; i++) {
        Conn *c = &g_conns[i];
        if (!c->is_stream) continue;
        if (c->out.len - c->out_off > SSE_MAX_BACKLOG) {   /* too slow: drop */
            c->is_stream = 0;
            c->close_when_done = 1;
            continue;
        }
        buf_putn(&c->out, msg->s, msg->len);
    }
}

static const char *mime_of(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!strcmp(dot, ".html")) return "text/html; charset=utf-8";
    if (!strcmp(dot, ".js"))   return "text/javascript";
    if (!strcmp(dot, ".css"))  return "text/css";
    if (!strcmp(dot, ".json")) return "application/json";
    if (!strcmp(dot, ".svg"))  return "image/svg+xml";
    if (!strcmp(dot, ".png"))  return "image/png";
    if (!strcmp(dot, ".ico"))  return "image/x-icon";
    if (!strcmp(dot, ".woff2")) return "font/woff2";
    if (!strcmp(dot, ".gif"))  return "image/gif";
    if (!strcmp(dot, ".txt") || !strcmp(dot, ".md")) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

/* Serve a built frontend (e.g. React `dist/`) when --static is given. */
static int serve_static(Conn *c, const char *path) {
    if (!g_static_dir || strstr(path, "..")) return 0;
    char full[4096];
    const char *rel = (!strcmp(path, "/")) ? "/index.html" : path;
    int w = snprintf(full, sizeof full, "%s%s", g_static_dir, rel);
    if (w < 0 || (size_t)w >= sizeof full) return 0;      /* path too long */
    struct stat st;
    if (stat(full, &st) != 0 || !S_ISREG(st.st_mode)) {
        /* single-page app fallback */
        snprintf(full, sizeof full, "%s/index.html", g_static_dir);
        if (stat(full, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
        rel = "/index.html";
    }
    FILE *f = fopen(full, "rb");
    if (!f) return 0;
    char *data = malloc((size_t)st.st_size + 1);
    size_t n = data ? fread(data, 1, (size_t)st.st_size, f) : 0;
    fclose(f);
    if (!data) return 0;
    respond(c, 200, mime_of(rel), data, n);
    free(data);
    return 1;
}

/* Try to handle a complete request in c->in. Returns 1 if handled. */
static int try_handle(ApiState *st, Conn *c) {
    char *hdr_end = strstr(c->in.s, "\r\n\r\n");
    if (!hdr_end) {
        if (c->in.len > 16384) { respond(c, 413, "application/json", "{\"ok\":false}", 12); return 1; }
        return 0;
    }
    size_t hdr_len = (size_t)(hdr_end - c->in.s) + 4;

    /* Content-Length and Authorization (case-insensitive header search) */
    size_t clen = 0;
    char token[96] = "";
    for (char *p = c->in.s; p < hdr_end; ) {
        char *eol = strstr(p, "\r\n");
        if (!eol) break;
        if (!strncasecmp(p, "Content-Length:", 15)) clen = (size_t)strtoul(p + 15, NULL, 10);
        if (!strncasecmp(p, "Authorization:", 14)) {
            const char *v = p + 14;
            while (*v == ' ') v++;
            if (!strncasecmp(v, "Bearer ", 7)) {
                v += 7;
                size_t n = 0;
                while (v + n < eol && n < sizeof token - 1) { token[n] = v[n]; n++; }
                token[n] = '\0';
            }
        }
        p = eol + 2;
    }
    if (clen > MAX_REQUEST) { respond(c, 413, "application/json", "{\"ok\":false}", 12); return 1; }
    if (c->in.len < hdr_len + clen) return 0;     /* body not fully arrived */

    /* request line: METHOD SP TARGET SP VERSION */
    char method[8] = "", target[2048] = "";
    if (sscanf(c->in.s, "%7s %2047s", method, target) != 2) {
        respond(c, 400, "application/json", "{\"ok\":false}", 12);
        return 1;
    }
    char *query = strchr(target, '?');
    if (query) *query++ = '\0';
    const char *body = c->in.s + hdr_len;

    if (!strcmp(method, "OPTIONS")) {             /* CORS preflight */
        buf_printf(&c->out, "HTTP/1.1 204 No Content\r\n%sContent-Length: 0\r\n"
                   "Connection: close\r\n\r\n", CORS);
        c->close_when_done = 1;
        return 1;
    }
    if (!strcmp(method, "GET") && !strcmp(target, "/api/stream")) {
        buf_printf(&c->out, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                   "Cache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n%s\r\n", CORS);
        api_stream_hello(st, &c->out);
        c->is_stream = 1;
        return 1;
    }
    if (strncmp(target, "/api/", 5) != 0 && !strcmp(method, "GET") && serve_static(c, target))
        return 1;

    ApiResponse r;
    r.status = 500;
    buf_init(&r.body);
    buf_init(&r.broadcast);
    api_handle(st, method, target, query, body, clen, token[0] ? token : NULL, &r);
    respond(c, r.status, "application/json", r.body.s ? r.body.s : "{}", r.body.len);
    broadcast(&r.broadcast);
    buf_free(&r.body);
    buf_free(&r.broadcast);
    return 1;
}

static int open_listener(const char *host, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        fprintf(stderr, "bad --host %s\n", host);
        close(fd);
        return -1;
    }
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0) { perror("bind"); close(fd); return -1; }
    if (listen(fd, 64) != 0) { perror("listen"); close(fd); return -1; }
    set_nonblocking(fd);
    return fd;
}

int main(int argc, char **argv) {
    int port = 8080;
    int with_sim = 1;
    const char *host = "127.0.0.1";
    /* Cloud hosts (Render, Railway, Fly, Vercel containers) say which port
     * to use through the PORT environment variable. */
    const char *env_port = getenv("PORT");
    if (env_port && atoi(env_port) > 0) port = atoi(env_port);
    const char *env_host = getenv("HOST");
    if (env_host && *env_host) host = env_host;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--host") && i + 1 < argc) host = argv[++i];
        else if (!strcmp(argv[i], "--static") && i + 1 < argc) g_static_dir = argv[++i];
        else if (!strcmp(argv[i], "--no-sim")) with_sim = 0;
        else {
            fprintf(stderr, "usage: %s [--port N] [--host ADDR] [--static DIR] [--no-sim]\n", argv[0]);
            return 1;
        }
    }

    signal(SIGPIPE, SIG_IGN);          /* writing to a closed socket must not kill us */
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    ApiState st;
    if (with_sim) printf("Generating 3 hours of demo market history...\n");
    if (api_init(&st, with_sim) != 0) { fprintf(stderr, "engine init failed\n"); return 1; }
    int lfd = open_listener(host, port);
    if (lfd < 0) return 1;
    printf("TradeCore engine listening on http://%s:%d  (Ctrl+C to stop)\n", host, port);
    printf("  dashboard: http://%s:%d   (demo login: demo / demo1234)\n", host, port);
    printf("  live bots: %s\n", with_sim ? "trading (pause them on the Demo Lab page)" : "off (--no-sim)");
    fflush(stdout);

    struct pollfd pfds[MAX_CONNS + 1];
    int64_t last_beat = tc_now_ms();

    while (!g_stop) {
        pfds[0].fd = lfd;
        pfds[0].events = POLLIN;
        for (int i = 0; i < g_nconns; i++) {
            pfds[i + 1].fd = g_conns[i].fd;
            pfds[i + 1].events = POLLIN;
            if (g_conns[i].out.len > g_conns[i].out_off) pfds[i + 1].events |= POLLOUT;
        }
        int nfds = g_nconns + 1;
        /* wake up in time for the next bot order */
        Buf simb; buf_init(&simb);
        int64_t wait = api_sim_tick(&st, tc_now_ms(), &simb);
        broadcast(&simb); buf_free(&simb);
        for (int i = 0; i < g_nconns; i++)       /* broadcast may have queued output */
            if (g_conns[i].out.len > g_conns[i].out_off) pfds[i + 1].events |= POLLOUT;
        int rc = poll(pfds, (nfds_t)nfds, (int)(wait > 1000 ? 1000 : wait));
        if (rc < 0) { if (errno == EINTR) continue; perror("poll"); break; }

        /* heartbeat keeps proxies/browsers from timing out idle streams */
        int64_t now = tc_now_ms();
        if (now - last_beat >= HEARTBEAT_MS) {
            Buf hb; buf_init(&hb); buf_puts(&hb, ": ping\n\n");
            broadcast(&hb); buf_free(&hb);
            last_beat = now;
        }

        /* walk clients backwards so swap-remove is safe */
        for (int i = nfds - 2; i >= 0; i--) {
            Conn *c = &g_conns[i];
            short re = pfds[i + 1].revents;
            if (pfds[i + 1].fd != c->fd) continue;   /* slot was reshuffled */
            if (re & (POLLERR | POLLNVAL)) { conn_close(i); continue; }

            if (re & (POLLIN | POLLHUP)) {
                char tmp[8192];
                ssize_t n = recv(c->fd, tmp, sizeof tmp, 0);
                if (n == 0) { conn_close(i); continue; }
                if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) { conn_close(i); continue; }
                if (n > 0 && !c->is_stream && !c->close_when_done) {
                    buf_putn(&c->in, tmp, (size_t)n);
                    if (c->in.len > MAX_REQUEST + 16384) { conn_close(i); continue; }
                    try_handle(&st, c);
                }
            }
            if (c->out.len > c->out_off) {
                ssize_t n = send(c->fd, c->out.s + c->out_off, c->out.len - c->out_off, 0);
                if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) { conn_close(i); continue; }
                if (n > 0) c->out_off += (size_t)n;
                if (c->out_off == c->out.len) { buf_reset(&c->out); c->out_off = 0; }
            }
            if (c->close_when_done && c->out.len == c->out_off) conn_close(i);
        }

        /* accept new clients */
        if (pfds[0].revents & POLLIN) {
            for (;;) {
                int cfd = accept(lfd, NULL, NULL);
                if (cfd < 0) break;
                if (g_nconns >= MAX_CONNS) { close(cfd); continue; }
                set_nonblocking(cfd);
                int one = 1;
                setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
                Conn *c = &g_conns[g_nconns++];
                memset(c, 0, sizeof *c);
                c->fd = cfd;
                buf_init(&c->in);
                buf_init(&c->out);
            }
        }
    }

    printf("\nshutting down\n");
    while (g_nconns) conn_close(g_nconns - 1);
    close(lfd);
    api_free(&st);
    return 0;
}
