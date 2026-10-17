/* Allocator/UTF16 ABI stand-in ONLY; no claim about Windows security. */
#include <stdint.h>
#include <stdlib.h>
typedef struct { void *value; } OUTPUT;
static int live=0,created=0,removed=0;
int ProfileLive(void){return live;}
int ProfileCreated(void){return created;}
int ProfileRemoved(void){return removed;}
int32_t CreateAppContainerProfile(uint16_t *name,uint16_t *display,uint16_t *description,void *capabilities,uint32_t count,OUTPUT *out){
 if(!name||!display||!description||capabilities||count)return -1;
 uint32_t *sid=malloc(4);if(!sid)return -1;*sid=0x43524f54;out->value=sid;live++;created++;return 0;
}
int32_t DeleteAppContainerProfile(uint16_t *name){if(!name)return -1;removed++;return 0;}
int IsValidSid(void *sid){return sid&&*(uint32_t*)sid==0x43524f54;}
int ConvertSidToStringSidW(void *sid,OUTPUT *out){
 const char *s="S-1-15-2-1-2-3-4-5-6-7";if(!IsValidSid(sid))return 0;
 unsigned n=0;while(s[n])n++;uint16_t *text=calloc(n+1,sizeof(uint16_t));if(!text)return 0;
 for(unsigned i=0;i<n;i++)text[i]=(uint16_t)s[i];out->value=text;live++;return 1;
}
void *FreeSid(void *sid){if(!sid)return sid;free(sid);live--;return NULL;}
void *LocalFree(void *value){if(value){free(value);live--;}return NULL;}
