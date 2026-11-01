/* Minimal local-only static preview server, written in C. No npm server is
 * needed. This serves a strict allowlist and binds to loopback, not the LAN. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET Socket;
#define CLOSE closesocket
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
typedef int Socket;
#define CLOSE close
#endif
static void send_all(Socket s,const char *data,int size){int sent=0,n;while(sent<size){n=send(s,data+sent,size-sent,0);if(n<=0)break;sent+=n;}}
int main(int argc,char **argv){int port=argc>1?atoi(argv[1]):4173;Socket listener;struct sockaddr_in addr;
#ifdef _WIN32
    WSADATA wsa;if(WSAStartup(MAKEWORD(2,2),&wsa))return 1;
#endif
    if(port<1024||port>65535){fputs("Port must be 1024-65535.\n",stderr);return 1;}
    listener=socket(AF_INET,SOCK_STREAM,0);memset(&addr,0,sizeof addr);addr.sin_family=AF_INET;
    addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);addr.sin_port=htons((unsigned short)port);
    if(bind(listener,(struct sockaddr*)&addr,sizeof addr)!=0||listen(listener,8)!=0){fputs("Cannot start local server; choose another port.\n",stderr);return 1;}
    printf("TradeCore C preview: http://127.0.0.1:%d\n",port);fflush(stdout);
    while(1){Socket client=accept(listener,0,0);char req[4096],method[16],path[256],header[512],file[300],chunk[8192];int n;FILE *f=0;const char *mime="text/plain";
        if(client==(Socket)-1)continue;
        n=recv(client,req,sizeof req-1,0);if(n<=0){CLOSE(client);continue;}req[n]=0;
        if(sscanf(req,"%15s %255s",method,path)!=2||strcmp(method,"GET")!=0){const char *msg="HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";send_all(client,msg,(int)strlen(msg));CLOSE(client);continue;}
        {char *q=strchr(path,'?');if(q)*q=0;}
        if(strcmp(path,"/")==0||strcmp(path,"/index.html")==0){strcpy(file,"web/index.html");mime="text/html; charset=utf-8";}
        else if(strcmp(path,"/styles.css")==0){strcpy(file,"web/styles.css");mime="text/css; charset=utf-8";}
        else if(strcmp(path,"/app.js")==0){strcpy(file,"web/app.js");mime="text/javascript; charset=utf-8";}
        else if(strcmp(path,"/engine.wasm")==0){strcpy(file,"web/engine.wasm");mime="application/wasm";}
        else if(strcmp(path,"/favicon.svg")==0){strcpy(file,"web/favicon.svg");mime="image/svg+xml";}
        else file[0]=0;
        if(file[0])f=fopen(file,"rb");
        if(!f){const char *msg="HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found";send_all(client,msg,(int)strlen(msg));CLOSE(client);continue;}
        fseek(f,0,SEEK_END);{long size=ftell(f);rewind(f);snprintf(header,sizeof header,"HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",mime,size);}
        send_all(client,header,(int)strlen(header));while((n=(int)fread(chunk,1,sizeof chunk,f))>0)send_all(client,chunk,n);fclose(f);CLOSE(client);
    }
}
