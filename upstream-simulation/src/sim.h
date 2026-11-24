/*
 * sim.h - Live market simulator: named bot traders that keep the order book
 * busy so the dashboard always has something happening.
 *
 * Every bot action is an ordinary engine command (submit / cancel / replace),
 * so the bots exercise exactly the same AVL / FIFO / hash code as a user.
 *
 * The simulator keeps a hidden "fair price" (mid) that follows a random walk.
 * The market MODE changes the drift and noise of that walk.
 */
#ifndef TC_SIM_H
#define TC_SIM_H

#include "engine.h"
#include "scenario.h"

typedef enum { SIM_CALM = 0, SIM_VOLATILE, SIM_BULL, SIM_BEAR, SIM_CRASH, SIM__MODES } sim_mode;

typedef struct {
    const char *name;
    const char *kind;      /* "market maker", "retail", "momentum", "institution" */
    uint64_t orders, cancels, fills;
    tc_qty   volume;
} SimBot;

#define SIM_RING      512
#define SIM_MAX_BOTS  12
#define SIM_MAX_BATCH 16

typedef struct {
    int      running;
    double   rate;            /* bot commands per second (live mode) */
    sim_mode mode;
    tc_rng   rng;
    double   mid;             /* fair price in paise */
    double   last_mid;
    int64_t  next_tick_ms;
    int64_t  mode_started_ms;
    tc_id    ring[SIM_RING];  /* recent bot order ids (for cancels) */
    size_t   ring_pos, ring_len;
    uint64_t steps;
    SimBot   bots[SIM_MAX_BOTS];
    int      nbots;
} Sim;

void        sim_init(Sim *s, uint64_t seed);
/*
 * One simulator step at time now_ms: usually one bot command, sometimes a few
 * clean-up cancels. Results are written to out[]; returns how many.
 */
int         sim_step(Sim *s, Engine *e, int64_t now_ms, tc_result *out);
/* Generate history: n steps spread evenly over [start_ms, end_ms]. */
void        sim_seed_history(Sim *s, Engine *e, int64_t start_ms, int64_t end_ms, long n);
void        sim_set_mode(Sim *s, sim_mode m, int64_t now_ms);
int         sim_parse_mode(const char *name, sim_mode *out);
const char *sim_mode_name(sim_mode m);
const char *sim_mode_blurb(sim_mode m);
int         sim_is_bot_name(const Sim *s, const char *name);

#endif
