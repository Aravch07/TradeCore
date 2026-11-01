#include "tradecore.h"

/* This file has no host imports or libc dependency. It is compiled unchanged
 * into a native C executable and into WebAssembly. The matching algorithm,
 * AVL trees, FIFO linked lists, hash chains, simulation and JSON are all C. */
static TCOrder orders[TC_MAX_ORDERS];
static TCLevel levels[TC_MAX_LEVELS];
static int buckets[TC_HASH_BUCKETS], roots[2], best[2];
static int order_free[TC_MAX_ORDERS], level_free[TC_MAX_LEVELS], order_top, level_top;
static TCTrade trades[TC_HISTORY];
static TCRecord archive[512];
static TCEvent events[TC_EVENTS];
static int trade_total, archive_total, event_total, next_id;
static int active_head, active_tail;
static TCStats stats;
static const char *error_message = "";
static char json[1048576];
static int json_pos, json_failed;

static int maximum(int a,int b) { return a>b?a:b; }
static unsigned int random_u32(void) {
    unsigned int x=stats.seed; x^=x<<13; x^=x>>17; x^=x<<5;
    stats.seed=x?x:42; return stats.seed;
}
static void event(int code,int id,int price,int qty,int side) {
    TCEvent *e=&events[event_total%TC_EVENTS];
    e->code=code;e->order=id;e->price=price;e->quantity=qty;e->side=side;
    e->sequence=stats.sequence;e->serial=++event_total;
}
static int reject(const char *msg) { error_message=msg;stats.rejected++;return -1; }
static int height(int n) {return n<0?0:levels[n].height;}
static void update(int n) {levels[n].height=1+maximum(height(levels[n].left),height(levels[n].right));}
static int rotate_right(int n) {
    int x=levels[n].left,t=levels[x].right;
    levels[x].right=n;levels[n].left=t;update(n);update(x);stats.rotations++;
    event(3,0,levels[x].price,0,levels[x].side);return x;
}
static int rotate_left(int n) {
    int x=levels[n].right,t=levels[x].left;
    levels[x].left=n;levels[n].right=t;update(n);update(x);stats.rotations++;
    event(4,0,levels[x].price,0,levels[x].side);return x;
}
static int balance(int n) {
    int d;if(n<0)return n;update(n);d=height(levels[n].left)-height(levels[n].right);
    if(d>1) {
        int l=levels[n].left;
        if(height(levels[l].left)<height(levels[l].right)) levels[n].left=rotate_left(l);
        return rotate_right(n);
    }
    if(d< -1) {
        int r=levels[n].right;
        if(height(levels[r].right)<height(levels[r].left)) levels[n].right=rotate_right(r);
        return rotate_left(n);
    }
    return n;
}
static int tree_insert(int root,int node) {
    if(root<0)return node;
    stats.comparisons++;
    if(levels[node].price<levels[root].price)levels[root].left=tree_insert(levels[root].left,node);
    else levels[root].right=tree_insert(levels[root].right,node);
    return balance(root);
}
/* Detach and transplant the successor node, rather than copying a price into
 * another node. Every order's reference to its owning level remains valid. */
static int detach_min(int root,int *out) {
    if(levels[root].left<0){*out=root;return levels[root].right;}
    levels[root].left=detach_min(levels[root].left,out);return balance(root);
}
static int tree_remove(int root,int price) {
    if(root<0)return -1;
    if(price<levels[root].price)levels[root].left=tree_remove(levels[root].left,price);
    else if(price>levels[root].price)levels[root].right=tree_remove(levels[root].right,price);
    else {
        int l=levels[root].left,r=levels[root].right,s;
        if(l<0)return r;
        if(r<0)return l;
        r=detach_min(r,&s);levels[s].left=l;levels[s].right=r;return balance(s);
    }
    return balance(root);
}
static int extreme(int root,int side) {
    int n=root;if(n<0)return -1;
    if(side==TC_BUY){while(levels[n].right>=0)n=levels[n].right;}
    else {while(levels[n].left>=0)n=levels[n].left;}
    return n;
}
static int find_level(int side,int price) {
    int n=roots[side];while(n>=0){stats.comparisons++;event(2,0,levels[n].price,0,side);
        if(price==levels[n].price)return n;
        n=price<levels[n].price?levels[n].left:levels[n].right;
    }return -1;
}
static int hash(int id){return (int)(((unsigned int)id*2654435761u)&(TC_HASH_BUCKETS-1));}
static int find_order(int id) {
    int n;if(id<=0)return -1;n=buckets[hash(id)];
    while(n>=0){stats.hash_probes++;if(orders[n].id==id)return n;n=orders[n].hash_next;}return -1;
}
static void hash_add(int n) {
    int h=hash(orders[n].id);orders[n].hash_next=buckets[h];buckets[h]=n;
    event(9,orders[n].id,orders[n].price,h,orders[n].side);
    orders[n].prev_active=active_tail;orders[n].next_active=-1;
    if(active_tail>=0)orders[active_tail].next_active=n;else active_head=n;
    active_tail=n;
}
static void hash_remove(int n) {
    int h=hash(orders[n].id),p=-1,x=buckets[h];
    while(x>=0&&x!=n){p=x;x=orders[x].hash_next;}
    if(x<0)return;
    if(p<0)buckets[h]=orders[x].hash_next;else orders[p].hash_next=orders[x].hash_next;
}
static void archive_order(int n,int state) {
    TCOrder *o=&orders[n];TCRecord *r=&archive[archive_total++%512];
    r->id=o->id;r->side=o->side;r->price=o->price;r->initial=o->initial;
    r->remaining=o->remaining;r->sequence=o->sequence;r->owner=o->owner;r->state=state;
}
static void release_order(int n) {orders[n].used=0;order_free[order_top++]=n;}
static void remove_level(int n) {
    int side=levels[n].side,price=levels[n].price;
    roots[side]=tree_remove(roots[side],price);levels[n].used=0;
    level_free[level_top++]=n;stats.levels--;best[side]=extreme(roots[side],side);
    event(8,0,price,0,side);
}
static void unlink_order(int n) {
    TCOrder *o=&orders[n];TCLevel *l=&levels[o->level];
    if(o->prev>=0)orders[o->prev].next=o->next;else l->head=o->next;
    if(o->next>=0)orders[o->next].prev=o->prev;else l->tail=o->prev;
    l->total-=o->remaining;l->count--;hash_remove(n);stats.active--;
    if(o->prev_active>=0)orders[o->prev_active].next_active=o->next_active;else active_head=o->next_active;
    if(o->next_active>=0)orders[o->next_active].prev_active=o->prev_active;else active_tail=o->prev_active;
    if(l->count==0)remove_level(o->level);
}
static void refresh_stats(void) {
    stats.bid=best[0]<0?0:levels[best[0]].price;
    stats.ask=best[1]<0?0:levels[best[1]].price;
}
void tc_reset(unsigned int seed) {
    int i;TCStats empty={0};stats=empty;stats.seed=seed?seed:42;stats.last_price=124500;
    roots[0]=roots[1]=best[0]=best[1]=-1;order_top=TC_MAX_ORDERS;level_top=TC_MAX_LEVELS;
    for(i=0;i<TC_MAX_ORDERS;i++){orders[i].used=0;order_free[i]=TC_MAX_ORDERS-1-i;}
    for(i=0;i<TC_MAX_LEVELS;i++){levels[i].used=0;level_free[i]=TC_MAX_LEVELS-1-i;}
    for(i=0;i<TC_HASH_BUCKETS;i++)buckets[i]=-1;
    trade_total=archive_total=event_total=0;next_id=1;error_message="";
    active_head=active_tail=-1;
    stats.reserved_bytes=sizeof orders+sizeof levels+sizeof buckets+sizeof order_free+sizeof level_free+
        sizeof trades+sizeof archive+sizeof events+sizeof json+sizeof stats+
        (TC_MAX_ORDERS+TC_MAX_LEVELS)*sizeof(int);
}
static int valid_order(int side,int price,int qty) {
    if(side!=0&&side!=1)return reject("Side must be buy or sell.");
    if(price<1||price>100000000)return reject("Price must be between Rs. 0.01 and Rs. 1,000,000.00.");
    if(qty<1||qty>1000000)return reject("Quantity must be 1 to 1,000,000 whole shares.");
    if(next_id>=2000000000)return reject("Session ID capacity reached. Start a new session.");
    if(order_top==0)return reject("Active order capacity reached (8192).");
    /* Conservative preflight guarantees allocation even after partial execution. */
    if(level_top==0&&find_level(side,price)<0)return reject("Price-level capacity reached (2048).");
    return 1;
}
static int submit(int side,int price,int qty,int owner) {
    int n=order_free[--order_top],id=next_id++,opp=1-side;
    TCOrder *o=&orders[n];TCOrder zero={0};*o=zero;
    o->used=1;o->id=id;o->side=side;o->price=price;o->initial=o->remaining=qty;
    o->sequence=stats.sequence;o->owner=owner;o->prev=o->next=o->hash_next=o->level=-1;
    event(1,id,price,qty,side);
    while(o->remaining>0&&best[opp]>=0) {
        int lidx=best[opp],midx=levels[lidx].head,p=levels[lidx].price;
        TCOrder *m=&orders[midx];int fill;
        stats.comparisons++;
        if((side==0&&price<p)||(side==1&&price>p))break;
        fill=o->remaining<m->remaining?o->remaining:m->remaining;
        o->remaining-=fill;m->remaining-=fill;levels[lidx].total-=fill;
        {TCTrade *t=&trades[trade_total%TC_HISTORY];t->id=++trade_total;t->maker=m->id;t->taker=id;
         t->price=p;t->quantity=fill;t->side=side;t->sequence=stats.sequence;}
        stats.fills++;stats.volume+=fill;stats.last_price=p;
        event(6,m->id,p,fill,side);
        if(m->remaining==0){unlink_order(midx);archive_order(midx,2);release_order(midx);}
    }
    if(o->remaining) {
        int lidx=find_level(side,price);TCLevel *l;
        if(lidx<0){TCLevel zero_level={0};lidx=level_free[--level_top];levels[lidx]=zero_level;
            l=&levels[lidx];l->used=1;l->side=side;l->price=price;l->height=1;
            l->left=l->right=l->head=l->tail=-1;
            roots[side]=tree_insert(roots[side],lidx);stats.levels++;event(7,id,price,0,side);
            best[side]=extreme(roots[side],side);
        }
        l=&levels[lidx];o->level=lidx;o->prev=l->tail;
        if(l->tail>=0)orders[l->tail].next=n;else l->head=n;
        l->tail=n;l->count++;l->total+=o->remaining;hash_add(n);stats.active++;
        event(5,id,price,o->remaining,side);
    } else {archive_order(n,2);release_order(n);}
    stats.accepted++;refresh_stats();return id;
}
int tc_submit(int side,int price,int quantity,int owner) {
    stats.commands++;error_message="";if(valid_order(side,price,quantity)<0)return -1;
    stats.sequence++;return submit(side,price,quantity,owner==TC_BOT?TC_BOT:TC_MANUAL);
}
int tc_cancel(int id) {
    int n;stats.commands++;error_message="";n=find_order(id);
    if(n<0)return reject("Order is not active; it may already be filled or cancelled.");
    stats.sequence++;event(10,id,orders[n].price,orders[n].remaining,orders[n].side);
    unlink_order(n);archive_order(n,3);release_order(n);stats.accepted++;refresh_stats();return id;
}
int tc_replace(int id,int price,int quantity) {
    int n,side,owner;stats.commands++;error_message="";n=find_order(id);
    if(n<0)return reject("Only an active order can be replaced.");
    side=orders[n].side;owner=orders[n].owner;
    if(valid_order(side,price,quantity)<0)return -1;
    stats.sequence++;event(10,id,orders[n].price,orders[n].remaining,side);
    unlink_order(n);archive_order(n,4);release_order(n);return submit(side,price,quantity,owner);
}
void tc_simulate(int count) {
    int k;if(count<0)count=0;if(count>10000)count=10000;
    for(k=0;k<count;k++) {
        unsigned int r=random_u32();int side=(int)(r&1),center=stats.last_price;
        if((r%9)==0&&stats.active>0){int i,start=(int)(random_u32()%TC_MAX_ORDERS);
            for(i=0;i<TC_MAX_ORDERS;i++){int n=(start+i)%TC_MAX_ORDERS;
                if(orders[n].used&&orders[n].level>=0){tc_cancel(orders[n].id);break;}}
        } else {
            int price=center+((int)(random_u32()%17)-8)*25;
            if(price<25)price=25;
            tc_submit(side,price,5+(int)(random_u32()%116),TC_BOT);
        }
    }
}
void tc_seed_market(void) {
    int i;tc_reset(42);
    for(i=0;i<12;i++){
        tc_submit(0,124400-i*50,40+(i*37)%140,TC_BOT);
        tc_submit(1,124600+i*50,40+(i*53)%140,TC_BOT);
    }
    tc_simulate(960);error_message="";
}
void tc_scenario(int scenario) {
    tc_reset(42);stats.scenario=scenario;stats.last_price=10000;
    if(scenario<1||scenario>4)stats.scenario=1;
}
int tc_scenario_next(void) {
    int s=stats.scenario,k=stats.scenario_step,result=-1;
    if(s==1||s==2){
        static const int sell_price[]={10000,10000,10100,10200};
        static const int sell_qty[]={80,70,100,40};
        if(k<4)result=tc_submit(1,sell_price[k],sell_qty[k],TC_BOT);
        else if(k==4)result=tc_submit(0,10100,200,TC_MANUAL);
        else if(k==5)result=tc_submit(0,10100,80,TC_MANUAL);
        else return 0;
    }else if(s==3){
        static const int p[]={10000,10100,10200,10300,10400,10500,10600};
        if(k<7)result=tc_submit(1,p[k],20,TC_MANUAL);else return 0;
    }else if(s==4){
        /* IDs 1 and 2049 collide in the 2048-bucket multiplicative hash.
         * Fill intermediate IDs immediately so the active book stays small. */
        if(k==0)result=tc_submit(1,10500,10,TC_MANUAL);
        else if(k==1){int i;for(i=0;i<1023;i++){tc_submit(1,10000,1,TC_BOT);tc_submit(0,10000,1,TC_BOT);}
            tc_submit(1,10400,10,TC_MANUAL);result=tc_submit(1,10300,10,TC_MANUAL);}
        else if(k==2)result=tc_cancel(1);else return 0;
    }else return 0;
    if(result>=0)stats.scenario_step++;
    return result>=0?1:-1;
}
const char *tc_error(void){return error_message;}
const TCStats *tc_stats(void){refresh_stats();return &stats;}
const TCOrder *tc_find_order(int id){int n=find_order(id);return n<0?0:&orders[n];}
const TCOrder *tc_orders(void){return orders;}
const TCLevel *tc_levels(void){return levels;}
int tc_root(int side){return side==0||side==1?roots[side]:-1;}
int tc_trade_count(void){return trade_total<TC_HISTORY?trade_total:TC_HISTORY;}
const TCTrade *tc_trade_at(int i){int n=tc_trade_count(),start=trade_total-n;if(i<0||i>=n)return 0;return &trades[(start+i)%TC_HISTORY];}

/* Validate tree ordering, structure, height, linked-list ownership, hash
 * membership, counts, cached extrema and the non-crossed book invariant. */
static int seen_orders[TC_MAX_ORDERS], seen_levels[TC_MAX_LEVELS];
static int check_tree(int n,int side,int low,int high,int *count,int *active) {
    TCLevel *l;int a,b,x,prev=-1,num=0;long long sum=0;
    if(n<0)return 0;
    if(n>=TC_MAX_LEVELS||seen_levels[n]++)return -10000;
    l=&levels[n];if(!l->used||l->side!=side||l->price<=low||l->price>=high)return -10000;
    a=check_tree(l->left,side,low,l->price,count,active);
    b=check_tree(l->right,side,l->price,high,count,active);
    if(a<0||b<0||a-b>1||b-a>1||l->height!=1+maximum(a,b))return -10000;
    x=l->head;while(x>=0){TCOrder *o;
        if(x>=TC_MAX_ORDERS||num>=TC_MAX_ORDERS||seen_orders[x]++)return -10000;
        o=&orders[x];if(!o->used||o->prev!=prev||o->side!=side||o->price!=l->price||o->level!=n||o->remaining<=0)return -10000;
        if(prev>=0&&orders[prev].sequence>=o->sequence)return -10000;
        if(find_order(o->id)!=x)return -10000;
        sum+=o->remaining;num++;prev=x;x=o->next;
    }
    if(num==0||prev!=l->tail||num!=l->count||sum!=l->total)return -10000;
    (*count)++;*active+=num;return 1+maximum(a,b);
}
int tc_check(void) {
    int i,c=0,a=0,h=0,old_probes=stats.hash_probes;
    for(i=0;i<TC_MAX_ORDERS;i++)seen_orders[i]=0;
    for(i=0;i<TC_MAX_LEVELS;i++)seen_levels[i]=0;
    if(check_tree(roots[0],0,0,100000001,&c,&a)<0||check_tree(roots[1],1,0,100000001,&c,&a)<0)return 0;
    for(i=0;i<TC_MAX_ORDERS;i++)if(orders[i].used&&!seen_orders[i])return 0;
    for(i=0;i<TC_MAX_LEVELS;i++)if(levels[i].used&&!seen_levels[i])return 0;
    for(i=0;i<TC_HASH_BUCKETS;i++){int x=buckets[i],guard=0;while(x>=0){
        if(x>=TC_MAX_ORDERS||guard++>=TC_MAX_ORDERS||!orders[x].used||hash(orders[x].id)!=i)return 0;
        h++;x=orders[x].hash_next;}}
    {int x=active_head,prev=-1,count=0;
     while(x>=0){if(x>=TC_MAX_ORDERS||++count>TC_MAX_ORDERS||!orders[x].used||orders[x].prev_active!=prev)return 0;
        prev=x;x=orders[x].next_active;}
     if(count!=a||prev!=active_tail)return 0;}
    stats.hash_probes=old_probes;refresh_stats();
    return c==stats.levels&&a==stats.active&&h==a&&order_top+a==TC_MAX_ORDERS&&level_top+c==TC_MAX_LEVELS&&
        best[0]==extreme(roots[0],0)&&best[1]==extreme(roots[1],1)&&(!stats.bid||!stats.ask||stats.bid<stats.ask);
}

/* Bounded JSON writer. Strings below are controlled engine labels. */
static void put(char c){if(json_pos<(int)sizeof(json)-1)json[json_pos++]=c;else json_failed=1;}
static void str(const char *s){while(*s)put(*s++);}
static void number(long long n){char b[24];int k=0;if(n<0){put('-');n=-n;}do{b[k++]=(char)('0'+n%10);n/=10;}while(n);while(k)put(b[--k]);}
static void field(const char *key,long long value){put('"');str(key);str("\":");number(value);put(',');}
static void record_json(int id,int side,int price,int initial,int remaining,int seq,int owner,int state){
    put('{');field("id",id);field("side",side);field("price",price);field("initial",initial);
    field("remaining",remaining);field("sequence",seq);field("owner",owner);str("\"state\":");number(state);put('}');
}
static void level_json(int n){TCLevel *l=&levels[n];int x=l->head,k=0;
    put('{');field("index",n);field("price",l->price);field("side",l->side);field("quantity",l->total);
    field("count",l->count);field("height",l->height);field("balance",height(l->left)-height(l->right));
    field("left",l->left);field("right",l->right);str("\"orders\":[");
    while(x>=0&&k<16){if(k++)put(',');number(orders[x].id);x=orders[x].next;}str("]}");
}
static void book_json(int n,int side,int *count){if(n<0||*count>=24)return;
    book_json(side==0?levels[n].right:levels[n].left,side,count);
    if(*count<24){if((*count)++)put(',');level_json(n);}
    book_json(side==0?levels[n].left:levels[n].right,side,count);
}
static void tree_json(int n,int *side_count,int *all_count){
    if(n<0||*side_count>=50)return;
    if((*all_count)++)put(',');
    (*side_count)++;level_json(n);
    tree_json(levels[n].left,side_count,all_count);
    tree_json(levels[n].right,side_count,all_count);
}
const char *tc_snapshot(void) {
    int i,k,n,c;refresh_stats();json_pos=json_failed=0;str("{\"stats\":{");
    field("commands",stats.commands);field("accepted",stats.accepted);field("rejected",stats.rejected);
    field("fills",stats.fills);field("volume",stats.volume);field("active",stats.active);field("levels",stats.levels);
    field("rotations",stats.rotations);field("comparisons",stats.comparisons);field("hashProbes",stats.hash_probes);
    field("lastPrice",stats.last_price);field("bid",stats.bid);field("ask",stats.ask);field("sequence",stats.sequence);
    field("reservedBytes",stats.reserved_bytes);field("scenario",stats.scenario);str("\"scenarioStep\":");number(stats.scenario_step);
    str("},\"roots\":[");number(roots[0]);put(',');number(roots[1]);str("],\"bids\":[");
    c=0;book_json(roots[0],0,&c);str("],\"asks\":[");c=0;book_json(roots[1],1,&c);
    str("],\"tree\":[");k=0;c=0;tree_json(roots[0],&c,&k);c=0;tree_json(roots[1],&c,&k);
    str("],\"orders\":[");k=0;i=active_tail;while(i>=0&&k<120){TCOrder *o=&orders[i];
        if(k++)put(',');
        record_json(o->id,o->side,o->price,o->initial,o->remaining,o->sequence,o->owner,o->remaining<o->initial?1:0);
        i=o->prev_active;}
    n=archive_total<60?archive_total:60;for(i=0;i<n;i++){TCRecord *r=&archive[(archive_total-1-i)%512];if(k++)put(',');
        record_json(r->id,r->side,r->price,r->initial,r->remaining,r->sequence,r->owner,r->state);}
    str("],\"candles\":[");n=tc_trade_count();
    for(i=0;i<n;i+=16){int j,end=i+16<n?i+16:n;const TCTrade *first=tc_trade_at(i),*last=tc_trade_at(end-1);
        int hi=first->price,lo=first->price;long long volume=0;
        for(j=i;j<end;j++){const TCTrade *t=tc_trade_at(j);if(t->price>hi)hi=t->price;if(t->price<lo)lo=t->price;volume+=t->quantity;}
        if(i)put(',');
        put('{');field("open",first->price);field("high",hi);field("low",lo);field("close",last->price);field("volume",volume);str("\"lastFill\":");number(last->id);put('}');
    }
    str("],\"trades\":[");n=tc_trade_count();for(i=0;i<n;i++){const TCTrade *t=tc_trade_at(i);if(i)put(',');put('{');
        field("id",t->id);field("maker",t->maker);field("taker",t->taker);field("price",t->price);field("quantity",t->quantity);
        field("side",t->side);str("\"sequence\":");number(t->sequence);put('}');}
    str("],\"events\":[");n=event_total<TC_EVENTS?event_total:TC_EVENTS;
    for(i=0;i<n;i++){TCEvent *e=&events[(event_total-n+i)%TC_EVENTS];if(i)put(',');put('{');
        field("code",e->code);field("order",e->order);field("price",e->price);field("quantity",e->quantity);
        field("side",e->side);field("sequence",e->sequence);str("\"serial\":");number(e->serial);put('}');}
    str("],\"hash\":[");k=0;for(i=0;i<TC_HASH_BUCKETS&&k<48;i++)if(buckets[i]>=0){int x=buckets[i],guard=0;
        if(k++)put(',');
        str("{\"bucket\":");number(i);str(",\"ids\":[");
        while(x>=0&&guard<20){if(guard++)put(',');number(orders[x].id);x=orders[x].hash_next;}str("]}");}
    str("]}");json[json_pos]=0;return json_failed?"{\"error\":\"Snapshot capacity exceeded\"}":json;
}
const char *tc_queue(int side,int price) {
    int n,x,k=0;json_pos=json_failed=0;str("[");if(side!=0&&side!=1){str("]");json[json_pos]=0;return json;}
    n=roots[side];while(n>=0&&levels[n].price!=price)n=price<levels[n].price?levels[n].left:levels[n].right;
    x=n<0?-1:levels[n].head;while(x>=0&&k<200){TCOrder *o=&orders[x];if(k++)put(',');
        record_json(o->id,o->side,o->price,o->initial,o->remaining,o->sequence,o->owner,o->remaining<o->initial?1:0);x=o->next;}
    str("]");json[json_pos]=0;return json;
}
