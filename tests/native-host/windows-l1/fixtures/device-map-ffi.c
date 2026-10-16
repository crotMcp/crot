/* Real pointer/Unicode/object-attribute ABI stand-in, NOT Windows isolation. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct { uint16_t length,maximum; uint16_t *buffer; } U;
typedef union { struct { void *directory; } set; struct { uint32_t drives; uint8_t types[32]; } query; } M;
_Static_assert(sizeof(M)==40,"PROCESS_DEVICEMAP_INFORMATION x64 ABI");
typedef struct { uint32_t length; void *root; U *name; uint32_t attributes; void *sd,*qos; } A;
static int handles[3],fault,applications,descriptors;
static int equal(U *u,const char *s){if(!u||u->length!=strlen(s)*2||u->maximum!=u->length+2||!u->buffer)return 0;for(unsigned i=0;i<strlen(s);i++)if(u->buffer[i]!=(uint16_t)s[i])return 0;return u->buffer[strlen(s)]==0;}
static int prefix(U *u,const char *s){if(!u||u->length<strlen(s)*2||!u->buffer)return 0;for(unsigned i=0;i<strlen(s);i++)if(u->buffer[i]!=(uint16_t)s[i])return 0;return 1;}
int32_t NtOpenDirectoryObject(void **out,uint32_t access,A *a){if(fault==1)return (int32_t)0xc0000022; if(!a||a->length!=48||a->root||a->attributes!=64||!equal(a->name,"\\??")||access!=0xb)return -99; handles[0]=1;*out=&handles[0];return 0;}
int32_t NtCreateDirectoryObjectEx(void **out,uint32_t access,A *a,void *shadow,uint32_t flags){if(fault==2)return (int32_t)0xc0000022;if(!a||a->length!=48||!prefix(a->name,"CrotPipeMap-")||a->root!=&handles[0]||!a->sd||shadow!=&handles[0]||!handles[0]||flags||access!=0xf000f)return -99;handles[1]=1;*out=&handles[1];return 0;}
int32_t NtCreateSymbolicLinkObject(void **out,uint32_t access,A *a,U *target){if(fault==3)return (int32_t)0xc0000022;if(!a||a->length!=48||a->root!=&handles[1]||!handles[1]||!equal(a->name,"PIPE")||!a->sd||access!=0xf0001||!prefix(target,"\\Device\\NamedPipe\\LOCAL\\crot-"))return -99;handles[2]=1;*out=&handles[2];return 0;}
int32_t NtSetInformationProcess(void *p,int kind,void *buf,uint32_t len){if(fault==4)return (int32_t)0xc0000022;if(p!=(void*)42||kind!=23||len!=sizeof(((M*)0)->set)||*(void**)buf!=&handles[1]||!handles[1]||!handles[2])return -99;for(unsigned i=sizeof(void*);i<len;i++)if(((uint8_t*)buf)[i])return -98;applications++;return 0;}
int ConvertStringSecurityDescriptorToSecurityDescriptorW(uint16_t *s,uint32_t revision,void **out,void *size){if(!s||revision!=1||size)return 0;unsigned n=0;while(s[n])n++;*out=malloc((n+1)*2);memcpy(*out,s,(n+1)*2);descriptors++;return 1;}
void *LocalFree(void *p){free(p);descriptors--;return 0;}
int CloseHandle(void *h){if(fault==5)return 0;for(int i=0;i<3;i++)if(h==&handles[i]&&handles[i]){handles[i]=0;return 1;}return 0;}
uint32_t GetLastError(void){return 5;}
void MapFault(int n){fault=n;}
int MapLive(void){return handles[0]+handles[1]+handles[2]+descriptors;}
int MapApplications(void){return applications;}
