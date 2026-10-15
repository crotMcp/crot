/* Pointer/ABI stand-in only; not a Windows isolation implementation. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static uint16_t prefix[136];
static int fault=0, live=0, invalid=0, opens=0;
static uint32_t error=0;
static void *retained=0;
void SetBnoPrefix(uint16_t *s) { int i=0; for (; i<135 && s[i]; ++i) prefix[i]=s[i]; prefix[i]=0; }
void BnoFault(int n) { fault=n; }
int BnoLive(void) { return live; }
int BnoInvalid(void) { return invalid; }
int BnoOpens(void) { return opens; }
uint32_t GetLastError(void) { return error; }
int OpenProcessToken(void *process, uint32_t access, void **out) {
 if (process!=(void *)0x123 || access!=8) {invalid++;return 0;}
 if(fault==1) {error=5;return 0;}
 *out=malloc(8); live++; opens++; return 1;
}
int IsTokenRestricted(void *t) { return t && fault!=2; }
int GetTokenInformation(void *token, int kind, void *data, uint32_t size, uint32_t *returned) {
 if(!token || kind!=44) {invalid++;return 0;}
 int n=0; while(prefix[n])n++;
 uint32_t bytes=16+(n+1)*2;
 *returned = fault==3 ? 8192 : bytes;
 if(!data) {error=122;return 0;}
 if(fault==4) {error=5;return 0;}
 if(size<bytes) {invalid++;return 0;}
 memset(data,0,size); void *p=(uint8_t *)data+16;
 if(fault==5)p=(void *)0x1;
 if(fault==6)p=(uint8_t *)data+size-2;
 memcpy(data,&p,8); *((uint8_t *)data+8)=fault==7?0:1;
 memcpy((uint8_t *)data+16,prefix,(n+1)*2);
 if(fault==8)*((uint16_t *)((uint8_t *)data+16))='X';
 if(fault==9)*returned=size+1;
 return 1;
}
int CloseHandle(void *h) {
 if(!h) {invalid++;return 0;}
 if(fault==10) {retained=h;error=5;return 0;}
 if(retained==h) retained=0;
 free(h);live--;return 1;
}
