// AD-29. OS-only AppContainer qualification controller, NOT a production backend.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <objbase.h>
#include <string>
#include <vector>
#include <iostream>
#include <stdexcept>
#include <cstring>
#include <algorithm>
struct Handle { HANDLE h=nullptr; ~Handle(){if(h && h!=INVALID_HANDLE_VALUE)CloseHandle(h);} };
const char* phase="setup";
const char* launchStep="none";
DWORD failureCode=0;
std::wstring ownedTemp,ownedCache;
void need(bool okay){if(!okay)throw std::runtime_error("native prerequisite");}
std::wstring quote(const std::wstring& s){std::wstring r=L"\"";unsigned n=0;for(auto c:s){if(c==L'\\'){n++;continue;}if(c==L'"')r.append(n*2+1,L'\\');else r.append(n,L'\\');n=0;r+=c;}r.append(n*2,L'\\');return r+L"\"";}
struct Grant {
 std::wstring path;PSID sid;bool installed=false;std::vector<BYTE> original;
 Grant(std::wstring p,PSID s):path(p),sid(s){}
 std::vector<BYTE> descriptor(){
  PSECURITY_DESCRIPTOR sd=nullptr;need(GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&sd)==ERROR_SUCCESS);
  DWORD length=GetSecurityDescriptorLength(sd);std::vector<BYTE> bytes(length);memcpy(bytes.data(),sd,length);LocalFree(sd);return bytes;
 }
 PACL acl(std::vector<BYTE>& bytes){PACL a=nullptr;BOOL present=FALSE,defaulted=FALSE;need(!!GetSecurityDescriptorDacl(bytes.data(),&present,&a,&defaulted)&&present&&a);return a;}
 void change(ACCESS_MODE mode,DWORD rights,DWORD inheritance){
  auto current=descriptor();PACL old=acl(current),next=nullptr;
  EXPLICIT_ACCESSW a{};a.grfAccessPermissions=rights;a.grfAccessMode=mode;a.grfInheritance=inheritance;
  a.Trustee.TrusteeForm=TRUSTEE_IS_SID;a.Trustee.TrusteeType=TRUSTEE_IS_UNKNOWN;a.Trustee.ptstrName=static_cast<LPWSTR>(sid);
  DWORD result=SetEntriesInAclW(1,&a,old,&next);
  if(result==ERROR_SUCCESS)result=SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,next,nullptr);
  if(next)LocalFree(next);need(result==ERROR_SUCCESS);
 }
 // Fresh SID is never adopted; cleanup owns a possibly partial mutation too.
 void add(bool deny=false){original=descriptor();installed=true;change(deny?DENY_ACCESS:GRANT_ACCESS,deny?FILE_ALL_ACCESS:0x1301bf,deny?0:SUB_CONTAINERS_AND_OBJECTS_INHERIT);}
 bool remove(){if(!installed)return true;try{
  auto current=descriptor();PACL old=acl(current);std::vector<BYTE> storage(old->AclSize);auto next=reinterpret_cast<PACL>(storage.data());need(!!InitializeAcl(next,old->AclSize,old->AclRevision));
  for(DWORD i=0;i<old->AceCount;i++){
   void* value=nullptr;need(!!GetAce(old,i,&value));auto header=static_cast<ACE_HEADER*>(value);bool own=false;
   // REVOKE_ACCESS does NOT remove ACCESS_DENIED_ACE. Remove both forms
   // explicitly, and only for this newly created exact package SID.
   if(header->AceType==ACCESS_ALLOWED_ACE_TYPE||header->AceType==ACCESS_DENIED_ACE_TYPE){auto entry=static_cast<ACCESS_ALLOWED_ACE*>(value);own=!!EqualSid(&entry->SidStart,sid);}
   if(!own)need(!!AddAce(next,old->AclRevision,MAXDWORD,value,header->AceSize));
  }
  need(SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,next,nullptr)==ERROR_SUCCESS);
  // SetNamedSecurityInfo propagates our removal, but can convert existing ACEs
  // to inherited form. This DISPOSABLE fixture has no concurrent ACL writers.
  // Restore original provenance ONLY after byte-checking every other ACE,
  // ignoring solely INHERITED_ACE. Never blindly restore changed user rights.
  auto readback=descriptor();auto actual=acl(readback),before=acl(original);need(actual->AceCount==before->AceCount);
  for(DWORD i=0;i<actual->AceCount;i++){
   void *x=nullptr,*y=nullptr;need(!!GetAce(actual,i,&x)&&!!GetAce(before,i,&y));auto hx=static_cast<ACE_HEADER*>(x),hy=static_cast<ACE_HEADER*>(y);
   need(hx->AceSize==hy->AceSize&&hx->AceType==hy->AceType&&(hx->AceFlags&~INHERITED_ACE)==(hy->AceFlags&~INHERITED_ACE));
   need(memcmp(static_cast<BYTE*>(x)+sizeof(ACE_HEADER),static_cast<BYTE*>(y)+sizeof(ACE_HEADER),hx->AceSize-sizeof(ACE_HEADER))==0);
  }
  need(!!SetFileSecurityW(path.c_str(),DACL_SECURITY_INFORMATION,original.data()));
  installed=false;return true;
 }catch(...){return false;}}
 ~Grant(){remove();}
};
std::vector<unsigned char> information(HANDLE token,TOKEN_INFORMATION_CLASS kind){DWORD n=0;GetTokenInformation(token,kind,nullptr,0,&n);need(n>=4&&n<=65536);std::vector<unsigned char>b(n);need(!!GetTokenInformation(token,kind,b.data(),n,&n));return b;}
DWORD launch(const std::wstring& exe,const std::vector<std::wstring>& args,const std::wstring& cwd,PSID package,bool& verified,DWORD& observedExit,bool cmdSyntax=false){
 launchStep="create-job";
 Handle job;job.h=CreateJobObjectW(nullptr,nullptr);need(job.h!=nullptr);
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
 need(!!SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)));
 launchStep="owned-stdio";
 SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};Handle input,output,error;
 input.h=CreateFileW(L"\\\\.\\NUL",GENERIC_READ|GENERIC_WRITE,7,&sa,OPEN_EXISTING,0,nullptr);
 std::wstring label;for(const char* c=phase;*c;c++)label+=static_cast<wchar_t>(*c);
 output.h=CreateFileW((cwd+L"\\"+label+L"-stdout.txt").c_str(),GENERIC_WRITE,FILE_SHARE_READ,&sa,CREATE_NEW,0,nullptr);
 error.h=CreateFileW((cwd+L"\\"+label+L"-stderr.txt").c_str(),GENERIC_WRITE,FILE_SHARE_READ,&sa,CREATE_NEW,0,nullptr);
 need(input.h!=INVALID_HANDLE_VALUE&&output.h!=INVALID_HANDLE_VALUE&&error.h!=INVALID_HANDLE_VALUE);
 HANDLE inherited[]={input.h,output.h,error.h};
 SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,3,0,&size);need(size>0&&size<65536);
 std::vector<unsigned char> storage(size);auto list=reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
 need(!!InitializeProcThreadAttributeList(list,3,0,&size));
 SECURITY_CAPABILITIES caps{};caps.AppContainerSid=package;
 bool okay=!!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps),nullptr,nullptr)&&
   !!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.h,sizeof(job.h),nullptr,nullptr)&&
   !!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr);
 if(!okay){DeleteProcThreadAttributeList(list);need(false);}
 STARTUPINFOEXW si{};si.StartupInfo.cb=sizeof(si);si.lpAttributeList=list;si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;si.StartupInfo.hStdInput=input.h;si.StartupInfo.hStdOutput=output.h;si.StartupInfo.hStdError=error.h;PROCESS_INFORMATION pi{};
 wchar_t win[32768]{};need(GetWindowsDirectoryW(win,32768)>0);
 std::vector<std::wstring> envs={L"SystemRoot="+std::wstring(win),L"WINDIR="+std::wstring(win),L"ComSpec="+std::wstring(win)+L"\\System32\\cmd.exe",L"PATH="+std::wstring(win)+L"\\System32;"+std::wstring(win),L"TEMP="+ownedTemp,L"TMP="+ownedTemp,L"USERPROFILE="+ownedTemp,L"LOCALAPPDATA="+ownedCache,L"APPDATA="+ownedCache};
 std::sort(envs.begin(),envs.end(),[](const auto& a,const auto& b){return _wcsicmp(a.c_str(),b.c_str())<0;});
 std::vector<wchar_t> env;for(const auto& e:envs){env.insert(env.end(),e.begin(),e.end());env.push_back(0);}env.push_back(0);
 std::wstring command=quote(exe);
 if(cmdSyntax){need(args.size()==1);command+=L" /d /s /c \""+args[0]+L"\"";}
 else for(const auto& arg:args)command+=L" "+quote(arg);
 launchStep="create-process";
 okay=!!CreateProcessW(exe.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env.data(),cwd.c_str(),&si.StartupInfo,&pi);
 DeleteProcThreadAttributeList(list);need(okay);Handle process,thread,token;process.h=pi.hProcess;thread.h=pi.hThread;
 try {
  launchStep="verify-token-job";
  BOOL member=FALSE;need(!!IsProcessInJob(process.h,job.h,&member)&&member);
  need(!!OpenProcessToken(process.h,TOKEN_QUERY,&token.h));
  auto ac=information(token.h,TokenIsAppContainer),ps=information(token.h,TokenAppContainerSid),cs=information(token.h,TokenCapabilities),il=information(token.h,TokenIntegrityLevel);
  auto label=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
  auto sid=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(ps.data())->TokenAppContainer;
  need(*reinterpret_cast<DWORD*>(ac.data())!=0&&sid&&IsValidSid(sid)&&EqualSid(sid,package));
  need(reinterpret_cast<TOKEN_GROUPS*>(cs.data())->GroupCount==0&&IsValidSid(label)&&*GetSidSubAuthorityCount(label)==1&&*GetSidSubAuthority(label,0)==4096);
  verified=true;launchStep="resume";need(ResumeThread(thread.h)==1);
  launchStep="wait-process";need(WaitForSingleObject(process.h,30000)==WAIT_OBJECT_0);
  launchStep="exit-code";need(!!GetExitCodeProcess(process.h,&observedExit));
  // The process handle can signal before Job accounting has settled. Keep the
  // Job alive, deny breakaway, and wait a bounded interval before ACL teardown.
  launchStep="drain-job";ULONGLONG deadline=GetTickCount64()+5000;
  for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};need(!!QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr));
   if(accounting.ActiveProcesses==0)break;need(GetTickCount64()<deadline);Sleep(10);}
  launchStep="complete";return observedExit;
 } catch(...){TerminateJobObject(job.h,1);WaitForSingleObject(process.h,5000);throw;}
}
bool put(const std::wstring& p,const char* text){Handle h;h.h=CreateFileW(p.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,0,nullptr);if(h.h==INVALID_HANDLE_VALUE)return false;DWORD n=0;return !!WriteFile(h.h,text,static_cast<DWORD>(strlen(text)),&n,nullptr)&&n==strlen(text);}
int wmain(int argc,wchar_t** argv){
 if(argc!=7)return 2;
 std::wstring root=argv[1],temp=argv[2],cache=argv[3],outside=argv[4],protectedFile=argv[5],node=argv[6];
 for(int i=1;i<argc;i++){std::wstring p=argv[i];if(p.size()<4||p[1]!=L':'||p[2]!=L'\\'||p.find(L'"')!=p.npos)return 2;}
 ownedTemp=temp;ownedCache=cache;
 GUID guid{};need(SUCCEEDED(CoCreateGuid(&guid)));wchar_t id[64]{};StringFromGUID2(guid,id,64);std::wstring name=L"crot.l1.";for(auto c:std::wstring(id))if(c!=L'{'&&c!=L'}')name+=c;
 PSID package=nullptr;bool owns=false,cleanup=true;DWORD nativeCode=0,nodeCode=0,cmdCode=0,psCode=0;bool verified=false;
 try {
  phase="profile";need(CreateAppContainerProfile(name.c_str(),L"CROT qualification",L"Owned disposable profile",nullptr,0,&package)==S_OK);owns=true;
  Grant workspace(root,package),tmp(temp,package),tools(cache,package),secret(protectedFile,package);
  wchar_t self[32768]{};need(GetModuleFileNameW(nullptr,self,32768)>0);std::wstring source=self;source=source.substr(0,source.find_last_of(L'\\')+1)+L"control-profile-child.exe";
  std::wstring child=cache+L"\\fixed-child.exe",nodeCopy=cache+L"\\node.exe";
  need(!!CopyFileW(source.c_str(),child.c_str(),TRUE)&&!!CopyFileW(node.c_str(),nodeCopy.c_str(),TRUE));
  need(put(root+L"\\link-source.txt","host-owned")&&put(outside+L"\\target.txt","unchanged"));
  need(!!CreateHardLinkW((outside+L"\\alias.txt").c_str(),(root+L"\\link-source.txt").c_str(),nullptr));
  phase="grants";workspace.add();tmp.add();tools.add();secret.add(true);
  phase="native";nativeCode=launch(child,{root,temp,cache,outside,protectedFile},root,package,verified,nativeCode);
  const std::wstring js=L"const f=require('fs');let r={ready:true};try{f.writeFileSync('node-created.txt','live');f.renameSync('node-created.txt','node-renamed.txt');r.read=f.readFileSync('node-renamed.txt','utf8')==='live';f.unlinkSync('node-renamed.txt');const h=f.openSync('\\\\\\\\.\\\\NUL','r+');f.closeSync(h);r.nul=true}catch(e){r.error=e.code;process.exitCode=1}f.writeFileSync('node-result.json',JSON.stringify(r));";
  phase="node";nodeCode=launch(nodeCopy,{L"-e",js},root,package,verified,nodeCode);
  wchar_t system[32768]{};need(GetSystemDirectoryW(system,32768)>0);std::wstring sys=system;
  phase="cmd";cmdCode=launch(sys+L"\\cmd.exe",{L"echo cmd-ready>cmd-result.txt & echo nul>NUL"},root,package,verified,cmdCode,true);
  std::wstring psRoot=root;for(size_t at=0;(at=psRoot.find(L"'",at))!=std::wstring::npos;at+=2)psRoot.insert(at,L"'");
  const std::wstring ps=L"$ErrorActionPreference='Stop';Import-Module -Name \"$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1\";Import-Module -Name \"$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1\" -ErrorAction Stop;Set-Location -LiteralPath '"+psRoot+L"' -ErrorAction Stop; 'ps-ready' > ps-result.txt; 'nul' > NUL";
  phase="powershell";psCode=launch(sys+L"\\WindowsPowerShell\\v1.0\\powershell.exe",{L"-NoProfile",L"-NonInteractive",L"-Command",ps},root,package,verified,psCode);
  phase="cleanup";cleanup=secret.remove();cleanup=tools.remove()&&cleanup;cleanup=tmp.remove()&&cleanup;cleanup=workspace.remove()&&cleanup;need(cleanup);
 }catch(...){failureCode=GetLastError();cleanup=false;}
 if(owns){bool removed=false;for(unsigned i=0;i<20&&!removed;i++){removed=DeleteAppContainerProfile(name.c_str())==S_OK;if(!removed)Sleep(50);}cleanup=cleanup&&removed;}
 if(package)FreeSid(package);
 std::cout<<"{\"phase\":\""<<phase<<"\",\"launchStep\":\""<<launchStep<<"\",\"lastWin32Error\":"<<failureCode<<",\"verified\":"<<(verified?"true":"false")<<",\"nativeCode\":"<<nativeCode<<",\"nodeCode\":"<<nodeCode<<",\"cmdCode\":"<<cmdCode<<",\"psCode\":"<<psCode<<",\"cleanup\":"<<(cleanup?"true":"false")<<"}";
 return cleanup?0:1;
}
