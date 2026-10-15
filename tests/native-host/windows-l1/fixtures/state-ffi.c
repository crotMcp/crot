/* Native pointer/ABI stand-in. NOT Windows security evidence. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct {uint16_t length,max;void *buffer;} UNICODE;
typedef struct {uint32_t length;void *root;UNICODE *name;uint32_t flags;void *sd,*qos;} ATTR;
typedef struct {int directory;uint16_t sd[2048];} OBJECT;
static int fault=0,handles=0,memory=0,invalid=0,sets=0;
static int n16(uint16_t *s){int n=0;while(s[n])n++;return n;}
static uint16_t *copy(uint16_t *s){int n=n16(s);uint16_t *p=malloc((n+1)*2);memcpy(p,s,(n+1)*2);memory++;return p;}
static void ascii(uint16_t *p,const char *s){while(*s)*p++=(uint8_t)*s++;*p=0;}
static OBJECT *object(int directory){OBJECT *p=calloc(1,sizeof(*p));p->directory=directory;ascii(p->sd,fault==12?"S:(ML;;NW;;;LW)":fault==13?"S:(ML;;NR;;;ME)":"S:(ML;;NW;;;ME)");handles++;return p;}
void StateFault(int f){fault=f;}
int StateHandles(void){return handles;}
int StateMemory(void){return memory;}
int StateInvalid(void){return invalid;}
int StateSets(void){return sets;}
void *CreateFileW(uint16_t *path,uint32_t access,uint32_t share,void *security,uint32_t disposition,uint32_t flags,void *templ){
 if(!path||access!=0x1200a0||share!=3||security||disposition!=3||flags!=0x02200000||templ){invalid++;return (void *)(intptr_t)-1;}
 if(fault==1)return (void *)(intptr_t)-1;return object(1);
}
int32_t NtCreateFile(void **out,uint32_t access,ATTR *a,void *status,void *allocation,uint32_t attrs,uint32_t share,uint32_t disposition,uint32_t options,void *ea,uint32_t eaSize){
 if(!a||a->length!=48||!a->root||!a->name||a->name->length==0||a->name->max!=a->name->length+2||a->flags!=0x1040||a->sd||a->qos||!status||allocation||attrs||share!=3||disposition!=1||(options&0x200020)!=0x200020||ea||eaSize||(access!=0x1e0080&&access!=0x120080&&access!=0x1200a0)){invalid++;return (int32_t)0xc000000d;}
 *out=object((options&1)!=0);return fault==2?(int32_t)0xc0000022:0;
}
int GetFileInformationByHandle(OBJECT *h,uint8_t *data){if(!h){invalid++;return 0;}memset(data,0,52);*(uint32_t *)data=(h->directory?0x10:0)|(fault==3?0x400:0);*(uint32_t *)(data+40)=fault==4&&!h->directory?2:1;return 1;}
int CloseHandle(void *h){if(!h){invalid++;return 0;}if(fault==10)return 0;free(h);handles--;return 1;}
void *LocalFree(void *p){if(!p){invalid++;return 0;}if(fault==11)return p;free(p);memory--;return 0;}
int ConvertStringSecurityDescriptorToSecurityDescriptorW(uint16_t *text,uint32_t revision,void **out,void *length){if(!text||revision!=1||length){invalid++;return 0;}*out=copy(text);return fault!=5;}
int ConvertSecurityDescriptorToStringSecurityDescriptorW(uint16_t *sd,uint32_t revision,uint32_t flags,void **out,uint32_t *length){if(!sd||revision!=1||(flags!=0x0c&&flags!=0x08)){invalid++;return 0;}*out=copy(sd);*length=fault==14?65537:n16(sd)+1;return fault!=8;}
int GetSecurityDescriptorSacl(void *sd,uint32_t *present,void **acl,uint32_t *defaulted){if(!sd||!present||!acl||!defaulted){invalid++;return 0;}*present=fault==15?0:fault==18?2:1;*acl=fault==15?NULL:sd;*defaulted=0;return fault!=17;}
int SetKernelObjectSecurity(OBJECT *h,uint32_t flags,uint16_t *sd){sets++;if(!h||flags!=0x80000014||!sd){invalid++;return 0;}if(fault==6)return 0;memcpy(h->sd,sd,(n16(sd)+1)*2);return 1;}
uint32_t GetSecurityInfo(OBJECT *h,int kind,uint32_t flags,void *owner,void *group,void *dacl,void *sacl,void **out){if(!h||kind!=1||(flags!=0x14&&flags!=0x10)||owner||group||dacl||sacl){invalid++;return 87;}*out=copy(h->sd);if(fault==9&&flags==0x14)((uint16_t *)*out)[0]='X';if(fault==16&&flags==0x14){uint16_t *p=*out;for(int i=0;i<n16(p)-1;i++)if(p[i]=='M'&&p[i+1]=='E'){p[i]='L';p[i+1]='W';}}return fault==7?5:0;}
