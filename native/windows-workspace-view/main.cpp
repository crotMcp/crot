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
DWORD failureCode=0;
std::wstring ownedTemp,ownedCache;
void need(bool okay){if(!okay)throw std::runtime_error("native prerequisite");}
std::wstring quote(const std::wstring& s){std::wstring r=L"\"";unsigned n=0;for(auto c:s){if(c==L'\\'){n++;continue;}if(c==L'"')r.append(n*2+1,L'\\');else r.append(n,L'\\');n=0;r+=c;}r.append(n*2,L'\\');return r+L"\"";}
struct Grant {
 std::wstring path;PSID sid;bool installed=false;
 Grant(std::wstring p,PSID s):path(p),sid(s){}
 void change(ACCESS_MODE mode,DWORD rights,DWORD inheritance){
  PACL old=nullptr,next=nullptr;PSECURITY_DESCRIPTOR sd=nullptr;
  need(GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&old,nullptr,&sd)==ERROR_SUCCESS);
  EXPLICIT_ACCESSW a{};a.grfAccessPermissions=rights;a.grfAccessMode=mode;a.grfInheritance=inheritance;
  a.Trustee.TrusteeForm=TRUSTEE_IS_SID;a.Trustee.TrusteeType=TRUSTEE_IS_UNKNOWN;a.Trustee.ptstrName=static_cast<LPWSTR>(sid);
  DWORD result=SetEntriesInAclW(1,&a,old,&next);
  if(result==ERROR_SUCCESS)result=SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,next,nullptr);
  if(next)LocalFree(next);if(sd)LocalFree(sd);need(result==ERROR_SUCCESS);
 }
 void add(bool deny=false){change(deny?DENY_ACCESS:GRANT_ACCESS,deny?FILE_ALL_ACCESS:0x1301bf,deny?0:SUB_CONTAINERS_AND_OBJECTS_INHERIT);installed=true;}
 bool remove(){if(!installed)return true;try{change(REVOKE_ACCESS,0,NO_INHERITANCE);installed=false;return true;}catch(...){return false;}}
 ~Grant(){remove();}
};
std::vector<unsigned char> information(HANDLE token,TOKEN_INFORMATION_CLASS kind){DWORD n=0;GetTokenInformation(token,kind,nullptr,0,&n);need(n>=4&&n<=65536);std::vector<unsigned char>b(n);need(!!GetTokenInformation(token,kind,b.data(),n,&n));return b;}
DWORD launch(const std::wstring& exe,const std::vector<std::wstring>& args,const std::wstring& cwd,PSID package,bool& verified){
 Handle job;job.h=CreateJobObjectW(nullptr,nullptr);need(job.h!=nullptr);
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
 need(!!SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)));
 SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,2,0,&size);need(size>0&&size<65536);
 std::vector<unsigned char> storage(size);auto list=reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
 need(!!InitializeProcThreadAttributeList(list,2,0,&size));
 SECURITY_CAPABILITIES caps{};caps.AppContainerSid=package;
 bool okay=!!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps),nullptr,nullptr)&&
   !!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.h,sizeof(job.h),nullptr,nullptr);
 if(!okay){DeleteProcThreadAttributeList(list);need(false);}
 STARTUPINFOEXW si{};si.StartupInfo.cb=sizeof(si);si.lpAttributeList=list;PROCESS_INFORMATION pi{};
 wchar_t win[32768]{};need(GetWindowsDirectoryW(win,32768)>0);
 std::vector<std::wstring> envs={L"SystemRoot="+std::wstring(win),L"WINDIR="+std::wstring(win),L"ComSpec="+std::wstring(win)+L"\\System32\\cmd.exe",L"PATH="+std::wstring(win)+L"\\System32;"+std::wstring(win),L"TEMP="+ownedTemp,L"TMP="+ownedTemp,L"USERPROFILE="+ownedTemp,L"LOCALAPPDATA="+ownedCache,L"APPDATA="+ownedCache};
 std::sort(envs.begin(),envs.end(),[](const auto& a,const auto& b){return _wcsicmp(a.c_str(),b.c_str())<0;});
 std::vector<wchar_t> env;for(const auto& e:envs){env.insert(env.end(),e.begin(),e.end());env.push_back(0);}env.push_back(0);
 std::wstring command=quote(exe);for(const auto& arg:args)command+=L" "+quote(arg);
 okay=!!CreateProcessW(exe.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env.data(),cwd.c_str(),&si.StartupInfo,&pi);
 DeleteProcThreadAttributeList(list);need(okay);Handle process,thread,token;process.h=pi.hProcess;thread.h=pi.hThread;
 try {
  BOOL member=FALSE;need(!!IsProcessInJob(process.h,job.h,&member)&&member);
  need(!!OpenProcessToken(process.h,TOKEN_QUERY,&token.h));
  auto ac=information(token.h,TokenIsAppContainer),ps=information(token.h,TokenAppContainerSid),cs=information(token.h,TokenCapabilities),il=information(token.h,TokenIntegrityLevel);
  auto label=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
  auto sid=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(ps.data())->TokenAppContainer;
  need(*reinterpret_cast<DWORD*>(ac.data())!=0&&sid&&IsValidSid(sid)&&EqualSid(sid,package));
  need(reinterpret_cast<TOKEN_GROUPS*>(cs.data())->GroupCount==0&&IsValidSid(label)&&*GetSidSubAuthorityCount(label)==1&&*GetSidSubAuthority(label,0)==4096);
  verified=true;need(ResumeThread(thread.h)==1);
  need(WaitForSingleObject(process.h,30000)==WAIT_OBJECT_0);DWORD code=0;need(!!GetExitCodeProcess(process.h,&code));
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};need(!!QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr));
  need(accounting.ActiveProcesses==0);return code;
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
  phase="native";nativeCode=launch(child,{root,temp,cache,outside,protectedFile},root,package,verified);
  const std::wstring js=L"const f=require('fs');let r={ready:true};try{f.writeFileSync('node-created.txt','live');f.renameSync('node-created.txt','node-renamed.txt');r.read=f.readFileSync('node-renamed.txt','utf8')==='live';f.unlinkSync('node-renamed.txt');const h=f.openSync('\\\\\\\\.\\\\NUL','r+');f.closeSync(h);r.nul=true}catch(e){r.error=e.code;process.exitCode=1}f.writeFileSync('node-result.json',JSON.stringify(r));";
  phase="node";nodeCode=launch(nodeCopy,{L"-e",js},root,package,verified);
  wchar_t system[32768]{};need(GetSystemDirectoryW(system,32768)>0);std::wstring sys=system;
  phase="cmd";cmdCode=launch(sys+L"\\cmd.exe",{L"/d",L"/c",L"echo cmd-ready>cmd-result.txt & echo nul>NUL"},root,package,verified);
  const std::wstring ps=L"$ErrorActionPreference='Stop';Import-Module -Name \"$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1\"; 'ps-ready' > ps-result.txt; 'nul' > NUL";
  phase="powershell";psCode=launch(sys+L"\\WindowsPowerShell\\v1.0\\powershell.exe",{L"-NoProfile",L"-NonInteractive",L"-Command",ps},root,package,verified);
  phase="cleanup";cleanup=secret.remove();cleanup=tools.remove()&&cleanup;cleanup=tmp.remove()&&cleanup;cleanup=workspace.remove()&&cleanup;need(cleanup);
 }catch(...){failureCode=GetLastError();cleanup=false;}
 if(owns){bool removed=false;for(unsigned i=0;i<20&&!removed;i++){removed=DeleteAppContainerProfile(name.c_str())==S_OK;if(!removed)Sleep(50);}cleanup=cleanup&&removed;}
 if(package)FreeSid(package);
 std::cout<<"{\"phase\":\""<<phase<<"\",\"lastWin32Error\":"<<failureCode<<",\"verified\":"<<(verified?"true":"false")<<",\"nativeCode\":"<<nativeCode<<",\"nodeCode\":"<<nodeCode<<",\"cmdCode\":"<<cmdCode<<",\"psCode\":"<<psCode<<",\"cleanup\":"<<(cleanup?"true":"false")<<"}";
 return cleanup?0:1;
}
