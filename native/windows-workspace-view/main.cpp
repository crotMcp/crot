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
#include <memory>
struct Handle { HANDLE h=nullptr; ~Handle(){if(h && h!=INVALID_HANDLE_VALUE)CloseHandle(h);} };
const char* phase="setup";
const char* launchStep="none";
DWORD failureCode=0;
std::wstring ownedTemp,ownedCache;
void need(bool okay){if(!okay)throw std::runtime_error("native prerequisite");}
#include "acl-lease.h"
std::wstring quote(const std::wstring& s){std::wstring r=L"\"";unsigned n=0;for(auto c:s){if(c==L'\\'){n++;continue;}if(c==L'"')r.append(n*2+1,L'\\');else r.append(n,L'\\');n=0;r+=c;}r.append(n*2,L'\\');return r+L"\"";}
struct Grant {
 std::wstring path;PSID sid;bool installed=false;std::vector<BYTE> original,expected;const char* restoreError="none";
 // Keep the same root/protected object pinned for the COMPLETE lease, not
 // just while taking/restoring its snapshot. Never opt into DELETE sharing.
 std::unique_ptr<PinnedAcl> pinned;
 Grant(std::wstring p,PSID s):path(p),sid(s){pinned=std::make_unique<PinnedAcl>(path,sid);original=pinned->original;}
 std::vector<BYTE> descriptor(){
  PSECURITY_DESCRIPTOR sd=nullptr;need(GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&sd)==ERROR_SUCCESS);
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
 void add(bool deny=false){installed=true;change(deny?DENY_ACCESS:GRANT_ACCESS,deny?FILE_ALL_ACCESS:0x1301bf,deny?0:SUB_CONTAINERS_AND_OBJECTS_INHERIT);expected=descriptor();}
 bool remove(){if(!installed)return true;try{
  auto& pinned=*this->pinned;auto current=pinned.descriptor();auto foreign=pinned.withoutOwned(PinnedAcl::acl(current));
  restoreError="missing-installed-snapshot";need(!expected.empty());auto installedForeign=pinned.withoutOwned(PinnedAcl::acl(expected));
  restoreError="foreign-acl-changed";need(PinnedAcl::equal(reinterpret_cast<PACL>(foreign.data()),reinterpret_cast<PACL>(installedForeign.data())));
  constexpr WORD flags=SE_DACL_PRESENT|SE_DACL_DEFAULTED|SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  restoreError="foreign-control-changed";need((PinnedAcl::control(current)&flags)==(PinnedAcl::control(expected)&flags));
  // Root-only restoration. In particular, NEVER traverse private temp/cache.
  restoreError="native-restore-failed";pinned.restore(original);auto final=pinned.descriptor();
  restoreError="restored-acl-mismatch";need(PinnedAcl::rawEqual(PinnedAcl::acl(final),PinnedAcl::acl(original)));
  restoreError="restored-control-mismatch";need((PinnedAcl::control(final)&flags)==(PinnedAcl::control(original)&flags));
  installed=false;restoreError="none";return true;
 }catch(...){return false;}}
 ~Grant(){remove();}
};
// Explicit curator scope: workspace ONLY. No invocation on temp/cache.
// Existing single-link nodes get original snapshots; shared MFT objects use
// their separate link lease. The protected fixture has its own Grant snapshot.
void snapshotWorkspaceNodes(const std::wstring& directory,PSID sid,const std::wstring& protectedFile,std::vector<std::unique_ptr<PinnedAcl>>& saved,unsigned depth=0){
 need(depth<=64);WIN32_FIND_DATAW item{};HANDLE find=FindFirstFileW((directory+L"\\*").c_str(),&item);if(find==INVALID_HANDLE_VALUE){need(GetLastError()==ERROR_FILE_NOT_FOUND);return;}
 try{do{std::wstring name=item.cFileName;if(name==L"."||name==L"..")continue;need(!(item.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));auto p=directory+L"\\"+name;
  if(p==protectedFile)continue;auto lease=std::make_unique<PinnedAcl>(p,sid);BY_HANDLE_FILE_INFORMATION info{};need(!!GetFileInformationByHandle(lease->object.h,&info));
  if(item.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)snapshotWorkspaceNodes(p,sid,protectedFile,saved,depth+1);
  else if(info.nNumberOfLinks>1)continue;
  // Only ordinary existing nodes strictly below root reach this path. The
  // constructor rechecks single-link identity before accepting rename sharing.
  // Root, ancestors, protected files and all multi-link leases keep defaults.
  lease=std::make_unique<PinnedAcl>(p,sid,true);
  need(saved.size()<10000);saved.push_back(std::move(lease));
 }while(FindNextFileW(find,&item));need(GetLastError()==ERROR_NO_MORE_FILES);}catch(...){FindClose(find);throw;}need(!!FindClose(find));
}
// After every Job has drained, remove only this fresh SID from current ACLs.
// No SetNamedSecurityInfo here: no inheritance walk or writes to other ACEs.
void stripWorkspaceSid(const std::wstring& directory,PSID sid,unsigned depth=0){
 need(depth<=64);WIN32_FIND_DATAW item{};HANDLE find=FindFirstFileW((directory+L"\\*").c_str(),&item);if(find==INVALID_HANDLE_VALUE){need(GetLastError()==ERROR_FILE_NOT_FOUND);return;}
 try{do{std::wstring name=item.cFileName;if(name==L"."||name==L"..")continue;need(!(item.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));auto p=directory+L"\\"+name;
  if(item.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)stripWorkspaceSid(p,sid,depth+1);
  PinnedAcl lease(p,sid);auto now=lease.descriptor();auto filtered=lease.withoutOwned(PinnedAcl::acl(now));auto clean=reinterpret_cast<PACL>(filtered.data());
  if(clean->AceCount!=PinnedAcl::acl(now)->AceCount){lease.set(clean,PinnedAcl::control(now));auto after=lease.descriptor();need(PinnedAcl::equal(PinnedAcl::acl(after),clean));}
 }while(FindNextFileW(find,&item));need(GetLastError()==ERROR_NO_MORE_FILES);}catch(...){FindClose(find);throw;}need(!!FindClose(find));
}
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
struct DescriptorObservation {
 std::wstring path;std::vector<BYTE> initial;
 static std::vector<BYTE> read(const std::wstring& p){PSECURITY_DESCRIPTOR sd=nullptr;need(GetNamedSecurityInfoW(p.c_str(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&sd)==ERROR_SUCCESS);std::vector<BYTE> result(GetSecurityDescriptorLength(sd));memcpy(result.data(),sd,result.size());LocalFree(sd);return result;}
 DescriptorObservation(const std::wstring& p):path(p),initial(read(p)){}
 bool unchanged(){auto now=read(path);return PinnedAcl::rawEqual(PinnedAcl::acl(initial),PinnedAcl::acl(now))&&PinnedAcl::control(initial)==PinnedAcl::control(now);}
};
bool validProfileName(const std::wstring& name){if(name.size()!=44||name.substr(0,8)!=L"crot.l1.")return false;unsigned dash=0;for(size_t i=8;i<name.size();i++){wchar_t c=name[i];if(c==L'-'){++dash;continue;}if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')))return false;}return dash==4;}
int wmain(int argc,wchar_t** argv){
 if(argc==3&&std::wstring(argv[1])==L"--derive-sid"){
  if(!validProfileName(argv[2]))return 2;PSID derived=nullptr;if(DeriveAppContainerSidFromAppContainerName(argv[2],&derived)!=S_OK)return 3;LPWSTR text=nullptr;bool okay=!!ConvertSidToStringSidW(derived,&text);if(okay){std::wcout<<text;LocalFree(text);}FreeSid(derived);return okay?0:3;
 }
 if(argc!=7&&argc!=14)return 2;
 std::wstring root=argv[1],temp=argv[2],cache=argv[3],outside=argv[4],protectedFile=argv[5],node=argv[6];
 for(int i=1;i<=6;i++){std::wstring p=argv[i];if(p.size()<4||p[1]!=L':'||p[2]!=L'\\'||p.find(L'"')!=p.npos)return 2;}
 ownedTemp=temp;ownedCache=cache;
 GUID guid{};need(SUCCEEDED(CoCreateGuid(&guid)));wchar_t id[64]{};StringFromGUID2(guid,id,64);std::wstring name=L"crot.l1.";for(auto c:std::wstring(id))if(c!=L'{'&&c!=L'}')name+=c;
 if(argc==14){if(!validProfileName(argv[7]))return 2;name=argv[7];for(int i=8;i<=12;i++){std::wstring p=argv[i];if(p.size()<4||p[1]!=L':'||p[2]!=L'\\'||p.find(L'"')!=p.npos)return 2;}std::wstring endpoint=argv[13];if(endpoint.find(L"\\\\.\\pipe\\crot-control-")!=0||endpoint.size()>256||endpoint.find(L'"')!=endpoint.npos)return 2;}
 DWORD serviceCode=STILL_ACTIVE;bool serviceAttempted=false;std::vector<bool> pinnedObjectRenames;
 PSID package=nullptr;bool owns=false,cleanup=true;unsigned linkedCount=0,deniedLinkedCount=0;std::vector<std::string> restoreReasons;DWORD nativeCode=0,nodeCode=0,cmdCode=0,psCode=0;bool verified=false;
 std::vector<DescriptorObservation> observations;observations.emplace_back(root);observations.emplace_back(protectedFile);observations.emplace_back(root+L"\\link-source.txt");auto parents=ancestors(root);std::reverse(parents.begin(),parents.end());for(const auto& p:parents)observations.emplace_back(p);
 std::vector<bool> snapshotApisAgree;for(auto& o:observations){PinnedAcl probe(o.path,nullptr);auto query=probe.descriptor();snapshotApisAgree.push_back(PinnedAcl::rawEqual(PinnedAcl::acl(o.initial),PinnedAcl::acl(query)));}
 std::vector<std::vector<bool>> observedStages;auto observe=[&](){std::vector<bool> row;for(auto& o:observations)row.push_back(o.unchanged());observedStages.push_back(row);};
 try {
  phase="profile";need(CreateAppContainerProfile(name.c_str(),L"CROT qualification",L"Owned disposable profile",nullptr,0,&package)==S_OK);owns=true;observe();
  PSID derived=nullptr;need(DeriveAppContainerSidFromAppContainerName(name.c_str(),&derived)==S_OK);bool sameSid=!!EqualSid(package,derived);FreeSid(derived);need(sameSid);
  Grant workspace(root,package),tmp(temp,package),tools(cache,package),secret(protectedFile,package);
  wchar_t self[32768]{};need(GetModuleFileNameW(nullptr,self,32768)>0);std::wstring source=self;source=source.substr(0,source.find_last_of(L'\\')+1)+L"control-profile-child.exe";
  std::wstring child=cache+L"\\fixed-child.exe",nodeCopy=cache+L"\\node.exe";
  need(!!CopyFileW(source.c_str(),child.c_str(),TRUE)&&!!CopyFileW(node.c_str(),nodeCopy.c_str(),TRUE));
  need(put(root+L"\\link-source.txt","host-owned")&&put(outside+L"\\target.txt","unchanged"));
  need(!!CreateHardLinkW((outside+L"\\alias.txt").c_str(),(root+L"\\link-source.txt").c_str(),nullptr));
  need(put(root+L"\\internal-source.txt","internal-before"));
  need(!!CreateHardLinkW((root+L"\\internal-alias.txt").c_str(),(root+L"\\internal-source.txt").c_str(),nullptr));
  phase="snapshot-hardlinks";std::vector<LinkedFile> linked;scanLinks(root,package,linked);linkedCount=static_cast<unsigned>(linked.size());
  // The cross-root link is a host setup action too: keep its PRE-setup snapshot.
  for(auto& f:linked)if(f.lease->path==root+L"\\link-source.txt")f.lease->original=observations[2].initial;
  std::vector<std::unique_ptr<PinnedAcl>> existing;snapshotWorkspaceNodes(root,package,protectedFile,existing);
  phase="ancestor-snapshots";std::vector<std::unique_ptr<PinnedAcl>> reads;
  for(const auto& p:ancestors(root))reads.push_back(std::make_unique<PinnedAcl>(p,package));
  phase="ancestor-read";for(auto& lease:reads){++ancestorIndex;lease->add(FILE_TRAVERSE|FILE_READ_ATTRIBUTES|FILE_READ_EA|FILE_LIST_DIRECTORY|SYNCHRONIZE);}
  phase="grants";workspace.add();tmp.add();tools.add();secret.add(true);
  phase="deny-external-hardlinks";for(auto& f:linked){if(hasExternalName(root,f.lease->path)){// Deny the concrete write/metadata bits. A GENERIC_WRITE request maps to
   // these too; do not deny shared READ_CONTROL/SYNCHRONIZE and break reads.
   f.lease->protectLinkedReadOnly(DELETE|WRITE_DAC|WRITE_OWNER|FILE_WRITE_DATA|FILE_APPEND_DATA|FILE_WRITE_ATTRIBUTES|FILE_WRITE_EA);f.denied=true;++deniedLinkedCount;}}

  for(auto& lease:existing){lease->expected=lease->descriptor();lease->installed=true;}
  for(auto& f:linked)if(!f.denied){f.lease->expected=f.lease->descriptor();f.lease->installed=true;}
  // Owner-positive disposable objects must reject even a trusted rename
  // while held. Do not try renaming any shared/user ancestor.
  phase="verify-protected-pins";for(const auto& p:std::vector<std::wstring>{root,temp,cache,protectedFile,root+L"\\link-source.txt"}){
   SetLastError(ERROR_SUCCESS);bool moved=!!MoveFileW(p.c_str(),(p+L".pin-probe").c_str());DWORD error=GetLastError();
   if(moved)need(!!MoveFileW((p+L".pin-probe").c_str(),p.c_str()));pinnedObjectRenames.push_back(!moved&&error==ERROR_SHARING_VIOLATION);
  }
  phase="native";nativeCode=launch(child,{root,temp,cache,outside,protectedFile},root,package,verified,nativeCode);
  const std::wstring js=L"const f=require('fs');let r={ready:true};try{f.writeFileSync('node-created.txt','live');f.renameSync('node-created.txt','node-renamed.txt');r.read=f.readFileSync('node-renamed.txt','utf8')==='live';f.unlinkSync('node-renamed.txt');const h=f.openSync('\\\\\\\\.\\\\NUL','r+');f.closeSync(h);r.nul=true}catch(e){r.error=e.code;process.exitCode=1}f.writeFileSync('node-result.json',JSON.stringify(r));";
  phase="node";nodeCode=launch(nodeCopy,{L"-e",js},root,package,verified,nodeCode);
  wchar_t system[32768]{};need(GetSystemDirectoryW(system,32768)>0);std::wstring sys=system;
  phase="cmd";cmdCode=launch(sys+L"\\cmd.exe",{L"echo cmd-ready>cmd-result.txt & echo nul>NUL"},root,package,verified,cmdCode,true);
  std::wstring psRoot=root;for(size_t at=0;(at=psRoot.find(L"'",at))!=std::wstring::npos;at+=2)psRoot.insert(at,L"'");
  const std::wstring ps=L"$ErrorActionPreference='Stop';Import-Module -Name \"$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1\";Import-Module -Name \"$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1\" -ErrorAction Stop; $initial=Get-Location; [Console]::Out.WriteLine('CROT-PS-INITIAL-FILESYSTEM=' + ($initial.Provider.Name -eq 'FileSystem')); [Console]::Out.WriteLine('CROT-PS-INITIAL-ROOT=' + ($initial.Path -eq '"+psRoot+L"')); Set-Location -LiteralPath '"+psRoot+L"' -ErrorAction Stop; 'ps-ready' > ps-result.txt; $info=New-Object System.Diagnostics.ProcessStartInfo; $info.FileName=$env:ComSpec; $info.Arguments='/d /c \"echo nul>NUL && type NUL >NUL && echo nul-child-ready>ps-child-marker.txt\"'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.WorkingDirectory=(Get-Location).Path; $child=[System.Diagnostics.Process]::Start($info); try { if (!$child.WaitForExit(5000)) { $child.Kill(); throw 'NUL descendant timeout' }; [Console]::Out.WriteLine('CROT-PS-NUL-EXIT=' + $child.ExitCode); if ($child.ExitCode -ne 0) { throw 'NUL descendant failed' }; if ([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path 'ps-child-marker.txt')).Trim() -ne 'nul-child-ready') { throw 'NUL descendant marker failed' } } finally { $child.Dispose() }";
  phase="powershell";psCode=launch(sys+L"\\WindowsPowerShell\\v1.0\\powershell.exe",{L"-NoProfile",L"-NonInteractive",L"-Command",ps},root,package,verified,psCode);
  if(argc==14){phase="service";serviceAttempted=true;std::vector<std::wstring> args{L"service-actor.cjs"};for(int i=8;i<=13;i++)args.push_back(argv[i]);serviceCode=launch(nodeCopy,args,root,package,verified,serviceCode);}
  phase="cleanup-workspace-only";stripWorkspaceSid(root,package);
  // Object-handle restoration is non-propagating. Restore leaves first;
  // exact independent snapshots remain the acceptance gate.
  for(auto it=reads.rbegin();it!=reads.rend();++it){auto& lease=*it;bool okay=lease->remove();restoreReasons.push_back(lease->restoreError);cleanup=okay&&cleanup;}
  for(auto* grant:{&secret,&workspace,&tmp,&tools}){bool okay=grant->remove();restoreReasons.push_back(grant->restoreError);cleanup=okay&&cleanup;}
  for(auto& lease:existing){bool okay=lease->remove();restoreReasons.push_back(lease->restoreError);cleanup=okay&&cleanup;}
  for(auto& f:linked){bool okay=f.lease->remove();restoreReasons.push_back(f.lease->restoreError);cleanup=okay&&cleanup;}need(cleanup);
 }catch(...){failureCode=GetLastError();cleanup=false;}
 observe();if(owns){bool removed=false;for(unsigned i=0;i<20&&!removed;i++){removed=DeleteAppContainerProfile(name.c_str())==S_OK;if(!removed)Sleep(50);}cleanup=cleanup&&removed;}
 observe();if(package)FreeSid(package);
 std::cout<<"{\"snapshotApisAgree\":[";for(size_t i=0;i<snapshotApisAgree.size();i++){if(i)std::cout<<",";std::cout<<(snapshotApisAgree[i]?"true":"false");}std::cout<<"],\"nativeBaselineStages\":[";for(size_t i=0;i<observedStages.size();i++){if(i)std::cout<<",";std::cout<<"[";for(size_t j=0;j<observedStages[i].size();j++){if(j)std::cout<<",";std::cout<<(observedStages[i][j]?"true":"false");}std::cout<<"]";}std::cout<<"],";
 std::cout<<"\"pinnedObjectRenames\":[";for(size_t i=0;i<pinnedObjectRenames.size();i++){if(i)std::cout<<",";std::cout<<(pinnedObjectRenames[i]?"true":"false");}std::cout<<"],";
 std::cout<<"\"serviceAttempted\":"<<(serviceAttempted?"true":"false")<<",\"serviceCode\":"<<serviceCode<<",\"linkedCount\":"<<linkedCount<<",\"deniedLinkedCount\":"<<deniedLinkedCount<<",\"restoreReasons\":[";for(size_t i=0;i<restoreReasons.size();i++){if(i)std::cout<<",";std::cout<<"\""<<restoreReasons[i]<<"\"";}std::cout<<"],\"phase\":\""<<phase<<"\",\"aclStep\":\""<<aclStep<<"\",\"aclError\":"<<aclError<<",\"ancestorIndex\":"<<ancestorIndex<<",\"launchStep\":\""<<launchStep<<"\",\"lastWin32Error\":"<<failureCode<<",\"verified\":"<<(verified?"true":"false")<<",\"nativeCode\":"<<nativeCode<<",\"nodeCode\":"<<nodeCode<<",\"cmdCode\":"<<cmdCode<<",\"psCode\":"<<psCode<<",\"cleanup\":"<<(cleanup?"true":"false")<<"}";
 return cleanup?0:1;
}
