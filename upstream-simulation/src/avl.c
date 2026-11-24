/*
 * avl.c - AVL tree of PriceLevel nodes.
 *
 * Rotations (x = unbalanced node):
 *
 *   rotate_right(x)            rotate_left(x)
 *        x          y             x              y
 *       / \        / \           / \            / \
 *      y   C  ->  A   x         A   y     ->   x   C
 *     / \            / \           / \        / \
 *    A   B          B   C         B   C      A   B
 *
 * The four imbalance cases:
 *   LL: left child is left-heavy  -> rotate_right(x)
 *   RR: right child right-heavy   -> rotate_left(x)
 *   LR: left child right-heavy    -> rotate_left(x->left), rotate_right(x)
 *   RL: right child left-heavy    -> rotate_right(x->right), rotate_left(x)
 *
 * IMPORTANT design point: orders keep a pointer to their PriceLevel node, so
 * removal must never "copy the successor's data into the node" (the usual
 * textbook trick). Instead we relink the successor NODE into the removed
 * node's place, so every node keeps its identity.
 */
#include <stdlib.h>
#include "avl.h"

int avl_height(const PriceLevel *n) { return n ? n->height : 0; }

static int max_int(int a, int b) { return a > b ? a : b; }

static void update_height(PriceLevel *n) {
    n->height = 1 + max_int(avl_height(n->left), avl_height(n->right));
}

static int balance_factor(const PriceLevel *n) {
    return avl_height(n->left) - avl_height(n->right);
}

static PriceLevel *rotate_right(AvlTree *t, PriceLevel *x) {
    PriceLevel *y = x->left;
    x->left = y->right;
    y->right = x;
    update_height(x);
    update_height(y);
    t->ctr->avl_rotations++;
    tracer_emit(t->tracer, EV_AVL_ROTATE_RIGHT, (int)t->side, x->price,
                0, 0, 0, x->node_id, y->node_id);
    return y;
}

static PriceLevel *rotate_left(AvlTree *t, PriceLevel *x) {
    PriceLevel *y = x->right;
    x->right = y->left;
    y->left = x;
    update_height(x);
    update_height(y);
    t->ctr->avl_rotations++;
    tracer_emit(t->tracer, EV_AVL_ROTATE_LEFT, (int)t->side, x->price,
                0, 0, 0, x->node_id, y->node_id);
    return y;
}

/* Restore the AVL property at n (children already balanced). */
static PriceLevel *rebalance(AvlTree *t, PriceLevel *n) {
    update_height(n);
    int bf = balance_factor(n);
    if (bf > 1) {                                   /* left heavy  */
        if (balance_factor(n->left) < 0)            /* LR case     */
            n->left = rotate_left(t, n->left);
        return rotate_right(t, n);                  /* LL case     */
    }
    if (bf < -1) {                                  /* right heavy */
        if (balance_factor(n->right) > 0)           /* RL case     */
            n->right = rotate_right(t, n->right);
        return rotate_left(t, n);                   /* RR case     */
    }
    return n;
}

void avl_init(AvlTree *t, tc_side side, Tracer *tr, tc_counters *c) {
    t->root = t->best = NULL;
    t->side = side;
    t->is_bid = (side == TC_BUY);
    t->size = 0;
    t->next_node_id = 1;
    t->tracer = tr;
    t->ctr = c;
}

static void destroy_rec(AvlTree *t, PriceLevel *n) {
    if (!n) return;
    destroy_rec(t, n->left);
    destroy_rec(t, n->right);
    free(n);
    t->ctr->frees++;
}

void avl_destroy(AvlTree *t) {
    destroy_rec(t, t->root);
    t->root = t->best = NULL;
    t->size = 0;
}

static void visit(AvlTree *t, PriceLevel *n, tc_price target) {
    t->ctr->avl_visits++;
    tracer_emit(t->tracer, EV_AVL_VISIT, (int)t->side, target,
                0, 0, 0, n->node_id, n->price);
}

/* Walk to the extreme node: O(log P). Used to refresh the best cache. */
static PriceLevel *extreme(AvlTree *t) {
    PriceLevel *n = t->root;
    if (!n) return NULL;
    if (t->is_bid) while (n->right) n = n->right;   /* max */
    else           while (n->left)  n = n->left;    /* min */
    return n;
}

static void set_best(AvlTree *t, PriceLevel *b) {
    if (t->best != b) {
        t->best = b;
        tracer_emit(t->tracer, EV_BEST_CHANGED, (int)t->side,
                    b ? b->price : 0, 0, 0, b ? b->total_qty : 0,
                    b ? b->node_id : 0, 0);
    }
}

PriceLevel *avl_find(AvlTree *t, tc_price price) {
    PriceLevel *n = t->root;
    while (n) {
        visit(t, n, price);
        if (price == n->price) return n;
        n = price < n->price ? n->left : n->right;
    }
    return NULL;
}

static PriceLevel *new_level(AvlTree *t, tc_price price) {
    PriceLevel *n = calloc(1, sizeof *n);
    if (!n) return NULL;
    t->ctr->allocs++;
    n->price = price;
    n->height = 1;
    n->node_id = t->next_node_id++;
    return n;
}

/*
 * Recursive insert. *out receives the node for `price` (existing or new).
 * *created is set when a new node was made.
 */
static PriceLevel *insert_rec(AvlTree *t, PriceLevel *n, tc_price price,
                              PriceLevel **out, int *created) {
    if (!n) {
        PriceLevel *m = new_level(t, price);
        *out = m;
        if (m) {
            *created = 1;
            t->ctr->avl_inserts++;
            tracer_emit(t->tracer, EV_AVL_INSERT, (int)t->side, price,
                        0, 0, 0, m->node_id, 0);
        }
        return m;
    }
    visit(t, n, price);
    if (price == n->price) { *out = n; return n; }
    if (price < n->price) {
        PriceLevel *c = insert_rec(t, n->left, price, out, created);
        if (!c) return n;               /* allocation failed: unchanged */
        n->left = c;
    } else {
        PriceLevel *c = insert_rec(t, n->right, price, out, created);
        if (!c) return n;
        n->right = c;
    }
    return *created ? rebalance(t, n) : n;
}

PriceLevel *avl_find_or_insert(AvlTree *t, tc_price price) {
    PriceLevel *out = NULL;
    int created = 0;
    PriceLevel *r = insert_rec(t, t->root, price, &out, &created);
    if (r) t->root = r;
    if (created) {
        t->size++;
        /* new level can only become best if it beats the current best */
        if (!t->best ||
            (t->is_bid ? price > t->best->price : price < t->best->price))
            set_best(t, out);
    }
    return out;
}

/* Detach the minimum node of subtree n; return the new subtree root. */
static PriceLevel *detach_min(AvlTree *t, PriceLevel *n, PriceLevel **min) {
    if (!n->left) { *min = n; return n->right; }
    n->left = detach_min(t, n->left, min);
    return rebalance(t, n);
}

static PriceLevel *remove_rec(AvlTree *t, PriceLevel *n, PriceLevel *target) {
    if (!n) return NULL;
    visit(t, n, target->price);
    if (target->price < n->price) {
        n->left = remove_rec(t, n->left, target);
    } else if (target->price > n->price) {
        n->right = remove_rec(t, n->right, target);
    } else {
        PriceLevel *l = n->left, *r = n->right;
        if (!l) return r;               /* 0 or 1 child: splice out */
        if (!r) return l;
        /* 2 children: in-order successor NODE takes n's place */
        PriceLevel *succ;
        PriceLevel *rest = detach_min(t, r, &succ);
        succ->right = rest;
        succ->left = l;
        return rebalance(t, succ);
    }
    return rebalance(t, n);
}

void avl_remove(AvlTree *t, PriceLevel *lv) {
    int was_best = (lv == t->best);
    tracer_emit(t->tracer, EV_AVL_REMOVE, (int)t->side, lv->price,
                0, 0, 0, lv->node_id, 0);
    t->root = remove_rec(t, t->root, lv);
    t->size--;
    t->ctr->avl_removes++;
    free(lv);
    t->ctr->frees++;
    if (was_best) { t->best = NULL; set_best(t, extreme(t)); }
}
