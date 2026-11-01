#include "tradecore.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int checks;
#define CHECK(x) do {checks++;if(!(x)){fprintf(stderr,"FAIL %s:%d: %s\n",__FILE__,__LINE__,#x);return 0;}} while(0)
static int proposal_example(void){const TCOrder *o;const TCStats *s;int i;tc_reset(42);
    CHECK(tc_submit(1,10000,80,0)==1);CHECK(tc_submit(1,10000,70,0)==2);
    CHECK(tc_submit(1,10100,100,0)==3);CHECK(tc_submit(1,10200,40,0)==4);
    CHECK(tc_submit(0,10100,200,0)==5);CHECK(tc_check());
    CHECK(tc_trade_count()==3);CHECK(tc_trade_at(0)->maker==1&&tc_trade_at(0)->quantity==80);
    CHECK(tc_trade_at(1)->maker==2&&tc_trade_at(1)->quantity==70);
    o=tc_find_order(3);CHECK(o&&o->remaining==50&&o->sequence==3);
    CHECK(tc_submit(0,10100,80,0)==6);s=tc_stats();CHECK(s->volume==250&&s->fills==4);
    CHECK(s->bid==10100&&s->ask==10200);CHECK(tc_find_order(6)->remaining==30);CHECK(tc_find_order(4)->remaining==40);
    CHECK(!tc_find_order(3));CHECK(tc_check());
    for(i=0;i<4;i++)CHECK(tc_trade_at(i)->price==(i<2?10000:10100));
    return 1;
}
static int cancel_replace(void){int i,ids[5];const TCOrder *o;tc_reset(1);
    for(i=0;i<5;i++)ids[i]=tc_submit(1,10000,20,0);
    CHECK(tc_cancel(ids[2])==ids[2]);CHECK(tc_cancel(ids[0])==ids[0]);CHECK(tc_cancel(ids[4])==ids[4]);CHECK(tc_check());
    CHECK(tc_replace(ids[1],-1,10)<0);o=tc_find_order(ids[1]);CHECK(o&&o->remaining==20);
    CHECK(tc_replace(ids[1],10000,15)==6);CHECK(!tc_find_order(ids[1]));
    CHECK(tc_submit(0,10000,30,0)==7);CHECK(tc_trade_at(0)->maker==ids[3]);
    CHECK(tc_trade_at(1)->maker==6);CHECK(tc_find_order(6)->remaining==5);CHECK(tc_check());
    CHECK(tc_cancel(999999)<0);CHECK(tc_submit(2,100,1,0)<0);CHECK(tc_submit(0,0,1,0)<0);CHECK(tc_submit(0,100,0,0)<0);CHECK(tc_check());return 1;
}
static int trees_and_capacity(void){int i;tc_reset(42);
    for(i=0;i<600;i++){CHECK(tc_submit(1,10000+i,1,0)>0);CHECK(tc_check());}
    for(i=0;i<600;i+=2){CHECK(tc_cancel(i+1)>0);CHECK(tc_check());}
    CHECK(tc_submit(0,20000,300,0)>0);CHECK(tc_stats()->active==0&&tc_stats()->levels==0);CHECK(tc_check());
    tc_reset(42);for(i=0;i<TC_MAX_ORDERS;i++)CHECK(tc_submit(1,10000,1000000,0)>0);
    CHECK(tc_stats()->active==8192);CHECK(tc_levels()[tc_root(1)].total==8192000000LL);CHECK(tc_check());
    CHECK(tc_submit(1,10000,1,0)<0);CHECK(tc_cancel(1)>0);CHECK(tc_submit(0,10000,1000000,0)>0);CHECK(tc_check());return 1;
}
typedef struct {int side,price,remaining;} Ref;
static Ref ref[50000];static TCTrade expected[100000];static int ref_next,expected_count;
static int ref_submit(int side,int price,int qty){int id=ref_next++,left=qty;
    while(left){int i,best_id=0;for(i=1;i<id;i++)if(ref[i].remaining&&ref[i].side!=side&&
        (side==0?ref[i].price<=price:ref[i].price>=price)){
        if(!best_id||(side==0?ref[i].price<ref[best_id].price:ref[i].price>ref[best_id].price))best_id=i;
    }if(!best_id)break;
    {int fill=left<ref[best_id].remaining?left:ref[best_id].remaining;TCTrade *t=&expected[expected_count++];
     t->maker=best_id;t->taker=id;t->price=ref[best_id].price;t->quantity=fill;t->side=side;
     ref[best_id].remaining-=fill;left-=fill;}}
    ref[id].side=side;ref[id].price=price;ref[id].remaining=left;return id;
}
static unsigned int rnd_state=1234567;
static unsigned int rnd(void){rnd_state^=rnd_state<<13;rnd_state^=rnd_state>>17;rnd_state^=rnd_state<<5;return rnd_state;}
static int differential(void){int k;tc_reset(42);memset(ref,0,sizeof ref);ref_next=1;expected_count=0;
    for(k=0;k<12000;k++){int r=(int)(rnd()%10),id,p,q,side;
        if(r<7){side=(int)(rnd()%2);p=9900+(int)(rnd()%201);q=1+(int)(rnd()%80);id=ref_submit(side,p,q);CHECK(tc_submit(side,p,q,0)==id);}
        else {id=1+(int)(rnd()%(unsigned int)(ref_next-1));
            if(r<9){if(ref[id].remaining){CHECK(tc_cancel(id)==id);ref[id].remaining=0;}else CHECK(tc_cancel(id)<0);}
            else {p=9900+(int)(rnd()%201);q=1+(int)(rnd()%80);
                if(ref[id].remaining){int new_id;side=ref[id].side;ref[id].remaining=0;new_id=ref_submit(side,p,q);CHECK(tc_replace(id,p,q)==new_id);}else CHECK(tc_replace(id,p,q)<0);}}
        CHECK(tc_check());CHECK(tc_stats()->fills==expected_count);
        if(expected_count){const TCTrade *actual=tc_trade_at(tc_trade_count()-1),*e=&expected[expected_count-1];
            CHECK(actual->maker==e->maker&&actual->taker==e->taker&&actual->price==e->price&&actual->quantity==e->quantity&&actual->side==e->side);}
        if(k%100==0){int i;for(i=1;i<ref_next;i++){const TCOrder *o=tc_find_order(i);CHECK(ref[i].remaining?(o&&o->remaining==ref[i].remaining&&o->price==ref[i].price):!o);}}
    }
    {int i,n=tc_trade_count(),start=expected_count-n;for(i=0;i<n;i++){const TCTrade *a=tc_trade_at(i),*e=&expected[start+i];CHECK(a->maker==e->maker&&a->taker==e->taker&&a->price==e->price&&a->quantity==e->quantity);}}
    return 1;
}
static int scenarios_simulation(void){int i,s;for(s=1;s<=4;s++){tc_scenario(s);while(tc_scenario_next()>0)CHECK(tc_check());CHECK(tc_check());}
    tc_seed_market();CHECK(tc_check());for(i=0;i<20;i++){tc_simulate(1000);CHECK(tc_check());}
    CHECK(strstr(tc_snapshot(),"\"candles\"")!=0);return 1;
}
int main(void){if(!proposal_example()||!cancel_replace()||!trees_and_capacity()||!differential()||!scenarios_simulation())return 1;
    printf("PASS: %d assertions. Proposal fills, cancellation, replacement, AVL deletion, capacities, 12,000 differential commands, scenarios and 20,000 simulated commands.\n",checks);return 0;}
