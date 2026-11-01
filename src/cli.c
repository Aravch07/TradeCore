#include "tradecore.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <limits.h>

static char journal[32768][160];
static int journal_count, quiet;
static void remember(const char *s){if(journal_count<32768){snprintf(journal[journal_count++],160,"%s",s);}}
static int parse_int(const char *s,int *out){char *end;long x;errno=0;x=strtol(s,&end,10);
    if(errno||!*s||*end||x<1||x>INT_MAX)return 0;
    *out=(int)x;return 1;}
static int parse_price(const char *s,int *out){
    /* Decimal parsing without float rounding: reject >2 decimal places. */
    long long whole=0;int cents=0,digits=0,seen=0;if(!*s)return 0;
    while(*s>='0'&&*s<='9'){seen=1;whole=whole*10+(*s++-'0');if(whole>1000000)return 0;}
    if(!seen)return 0;
    if(*s=='.'){s++;while(*s>='0'&&*s<='9'){if(++digits>2)return 0;cents=cents*10+(*s++-'0');}if(!digits)return 0;}
    if(*s)return 0;
    if(digits==1)cents*=10;
    whole=whole*100+cents;
    if(whole<1||whole>100000000)return 0;
    *out=(int)whole;return 1;
}
static void show_book(void){const TCLevel *ls=tc_levels();const TCStats *s=tc_stats();int prices[TC_MAX_LEVELS],i,j,n=0;
    puts("\n  SIDE     PRICE (Rs.)       QUANTITY    ORDERS");
    for(i=0;i<TC_MAX_LEVELS;i++)if(ls[i].used)prices[n++]=i;
    for(i=1;i<n;i++){int t=prices[i];j=i-1;while(j>=0&&ls[prices[j]].price>ls[t].price){prices[j+1]=prices[j];j--;}prices[j+1]=t;}
    for(i=n-1;i>=0;i--){const TCLevel *l=&ls[prices[i]];if(l->side==1)printf("  ASK   %10.2f   %12lld    %6d\n",l->price/100.0,l->total,l->count);}
    puts("  --------------------------------------------");
    for(i=n-1;i>=0;i--){const TCLevel *l=&ls[prices[i]];if(l->side==0)printf("  BID   %10.2f   %12lld    %6d\n",l->price/100.0,l->total,l->count);}
    printf("  Spread: %s",s->bid&&s->ask?"Rs. ":"unavailable\n");if(s->bid&&s->ask)printf("%.2f\n",(s->ask-s->bid)/100.0);
}
static void show_orders(void){const TCOrder *os=tc_orders();int i;puts("\n  ID       SIDE       PRICE     INITIAL   REMAINING   SEQUENCE");
    for(i=0;i<TC_MAX_ORDERS;i++)if(os[i].used){const TCOrder *o=&os[i];printf("  %-8d %-5s %10.2f %10d %11d %10d\n",o->id,o->side?"SELL":"BUY",o->price/100.0,o->initial,o->remaining,o->sequence);}}
static void show_trades(void){int i,n=tc_trade_count(),start=n>30?n-30:0;puts("\n  FILL     MAKER    TAKER       PRICE     SHARES");
    for(i=start;i<n;i++){const TCTrade *t=tc_trade_at(i);printf("  %-8d %-8d %-8d %9.2f %10d\n",t->id,t->maker,t->taker,t->price/100.0,t->quantity);}
    printf("  Showing %d of %d retained fills (history capacity: %d).\n",n-start,n,TC_HISTORY);}
static void show_stats(void){const TCStats *s=tc_stats();printf("\n  Commands: %d | accepted: %d | rejected: %d\n",s->commands,s->accepted,s->rejected);
    printf("  Active orders: %d | price levels: %d | fills: %d | volume: %lld\n",s->active,s->levels,s->fills,s->volume);
    printf("  AVL rotations: %d | price comparisons: %d | hash probes: %d\n",s->rotations,s->comparisons,s->hash_probes);
    printf("  Reserved engine buffers: %.2f MiB | invariants: %s\n",s->reserved_bytes/1048576.0,tc_check()?"PASS":"FAIL");}
static int execute(const char *line,int record);
static int replay(const char *path){FILE *f=fopen(path,"r");char line[200];int row=0;
    if(!f){perror(path);return 0;}tc_reset(42);journal_count=0;
    while(fgets(line,sizeof line,f)){size_t n=strlen(line);row++;while(n&&(line[n-1]=='\n'||line[n-1]=='\r'))line[--n]=0;
        if(!n||line[0]=='#')continue;
        if(strncmp(line,"load ",5)==0||strncmp(line,"save ",5)==0||strncmp(line,"export ",7)==0||strcmp(line,"quit")==0){fprintf(stderr,"Unsafe replay command at line %d\n",row);fclose(f);return 0;}
        if(!execute(line,1)){fprintf(stderr,"Replay failed at line %d\n",row);fclose(f);return 0;}
    }fclose(f);return 1;
}
static int execute(const char *line,int record){
    char cmd[32]={0},a[100]={0},b[100]={0},c[100]={0},extra[8]={0};int fields,id=0,p=0,q=0,result=0,mutates=0;
    fields=sscanf(line,"%31s %99s %99s %99s %7s",cmd,a,b,c,extra);if(fields<1||cmd[0]=='#')return 1;
    if(strcmp(cmd,"buy")==0||strcmp(cmd,"sell")==0){
        if(fields!=3||!parse_price(a,&p)||!parse_int(b,&q)){puts("Use: buy|sell PRICE QUANTITY (price has at most 2 decimals)");return 0;}
        result=tc_submit(strcmp(cmd,"buy")==0?0:1,p,q,TC_MANUAL);mutates=1;
    }else if(strcmp(cmd,"cancel")==0){if(fields!=2||!parse_int(a,&id))return 0;result=tc_cancel(id);mutates=1;}
    else if(strcmp(cmd,"replace")==0){if(fields!=4||!parse_int(a,&id)||!parse_price(b,&p)||!parse_int(c,&q))return 0;result=tc_replace(id,p,q);mutates=1;}
    else if(strcmp(cmd,"simulate")==0){if(fields!=2||!parse_int(a,&q)||q>10000)return 0;tc_simulate(q);mutates=1;result=1;}
    else if(strcmp(cmd,"reset")==0){tc_reset(42);journal_count=0;mutates=1;result=1;}
    else if(strcmp(cmd,"market")==0){tc_seed_market();journal_count=0;mutates=1;result=1;}
    else if(strcmp(cmd,"scenario")==0){int s=strcmp(a,"rotation")==0?3:strcmp(a,"hash")==0?4:strcmp(a,"partial")==0?2:strcmp(a,"fifo")==0?1:0;
        if(!s)return 0;
        tc_scenario(s);journal_count=0;mutates=1;result=1;}
    else if(strcmp(cmd,"next")==0){result=tc_scenario_next();if(result==0){puts("Scenario complete.");return 1;}mutates=1;}
    else if(strcmp(cmd,"book")==0){show_book();return 1;}
    else if(strcmp(cmd,"orders")==0){show_orders();return 1;}
    else if(strcmp(cmd,"trades")==0){show_trades();return 1;}
    else if(strcmp(cmd,"stats")==0){show_stats();return 1;}
    else if(strcmp(cmd,"json")==0){puts(tc_snapshot());return 1;}
    else if(strcmp(cmd,"check")==0){result=tc_check();puts(result?"All engine invariants PASS.":"Engine invariant FAILURE.");return result;}
    else if(strcmp(cmd,"save")==0||strcmp(cmd,"export")==0){FILE *f;const char *path=strchr(line,' ');if(!path||!path[1])return 0;while(*path==' ')path++;
        f=fopen(path,"w");if(!f){perror(path);return 0;}
        if(strcmp(cmd,"save")==0){int i;fputs("# TradeCore C session v1; prices in rupees\n",f);for(i=0;i<journal_count;i++)fprintf(f,"%s\n",journal[i]);}
        else fputs(tc_snapshot(),f);
        fclose(f);if(!quiet)puts("File saved.");return 1;
    }else if(strcmp(cmd,"load")==0){const char *path=strchr(line,' ');if(!path)return 0;while(*path==' ')path++;return replay(path);}
    else if(strcmp(cmd,"bench")==0){clock_t start;double elapsed;
        if(fields!=2||!parse_int(a,&q)||q>10000)return 0;
        start=clock();tc_simulate(q);elapsed=(double)(clock()-start)/CLOCKS_PER_SEC;
        printf("Measured native run: %d commands in %.6f s (%.1f commands/s).\n",q,elapsed,elapsed>0?q/elapsed:0.0);
        puts("Includes C simulation generation; excludes rendering, persistence and JSON. Not a production benchmark.");
        {char replay_cmd[80];snprintf(replay_cmd,sizeof replay_cmd,"simulate %d",q);remember(replay_cmd);}return 1;
    }else if(strcmp(cmd,"help")==0){puts("\n  buy PRICE QTY       sell PRICE QTY      cancel ID\n  replace ID PRICE QTY  book  orders  trades  stats  check\n  simulate COUNT      market              reset\n  scenario fifo|partial|rotation|hash      next\n  save FILE.tcx       load FILE.tcx       export FILE.json\n  bench COUNT         json                quit\n\n  Prices are rupees, quantities whole shares. Simulation only.\n  Replacement quantity is the NEW remaining quantity and loses FIFO priority.");return 1;}
    else if(strcmp(cmd,"quit")==0||strcmp(cmd,"exit")==0)return 2;
    else {puts("Unknown command. Type help.");return 0;}
    if(mutates&&result>=0){if(record)remember(line);if(!quiet){if(strcmp(cmd,"buy")==0||strcmp(cmd,"sell")==0||strcmp(cmd,"replace")==0)printf("Accepted order #%d\n",result);else puts("Done.");}return 1;}
    fprintf(stderr,"Rejected: %s\n",tc_error());return 0;
}
int main(int argc,char **argv){char line[256];tc_reset(42);
    if(argc>=3&&strcmp(argv[1],"--script")==0){quiet=1;if(!replay(argv[2]))return 1;if(argc>3&&strcmp(argv[3],"--json")==0)puts(tc_snapshot());else{show_book();show_stats();}return tc_check()?0:1;}
    puts("\n  TRADECORE | C ORDER-MATCHING ENGINE\n  AVL trees + FIFO linked lists + hash table + history arrays\n  Simulated trades only. Type help to get started.\n");
    while(1){int r;printf("tradecore> ");fflush(stdout);if(!fgets(line,sizeof line,stdin))break;line[strcspn(line,"\r\n")]=0;r=execute(line,1);if(r==2)break;}
    return 0;
}
