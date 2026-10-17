// AD-29 fixed OS-only child. No arbitrary program or RPC interface.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <vector>
#include <string>
#include <cstring>
#include <iostream>
bool put(const std::wstring& p,const char* text){HANDLE h=CreateFileW(p.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,0,nullptr);if(h==INVALID_HANDLE_VALUE)return false;DWORD n=0;bool okay=!!WriteFile(h,text,static_cast<DWORD>(strlen(text)),&n,nullptr)&&n==strlen(text);return !!CloseHandle(h)&&okay;}
// Read-only host-path diagnosis. Do not enumerate names, read file bytes,
// change a descriptor, enable privileges, or turn observations into grants.
// A successful directory open with a write mask is recorded, never exercised.
DWORD existingDirectoryDeleteOpen=ERROR_NOT_READY;
DWORD existingWorkspaceSteps[7]={ERROR_NOT_READY,ERROR_NOT_READY,ERROR_NOT_READY,ERROR_NOT_READY,ERROR_NOT_READY,ERROR_NOT_READY,ERROR_NOT_READY};
// Finite owner-only pipe creation controls, NEVER a retry loop or a grant on
// shared pipe namespaces. Each successful new instance is closed immediately.
// Explicit descriptors apply only to our fresh diagnostic pipe instance.
void pipeCreationDiagnostics(){
 HANDLE token=nullptr;DWORD tokenError=ERROR_SUCCESS;std::vector<BYTE> package,user;
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))tokenError=GetLastError();
 auto info=[&](TOKEN_INFORMATION_CLASS type,std::vector<BYTE>& value){DWORD n=0;GetTokenInformation(token,type,nullptr,0,&n);if(!n||n>65536)return false;value.resize(n);return !!GetTokenInformation(token,type,value.data(),n,&n);};
 PSECURITY_DESCRIPTOR descriptor=nullptr;
 if(tokenError==ERROR_SUCCESS){
  if(info(TokenAppContainerSid,package)&&info(TokenUser,user)){
   auto p=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(package.data())->TokenAppContainer;auto u=reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
   LPWSTR packageText=nullptr,userText=nullptr;
   if(p&&IsValidSid(p)&&IsValidSid(u)&&ConvertSidToStringSidW(p,&packageText)&&ConvertSidToStringSidW(u,&userText)){
    std::wstring sddl=L"D:P(A;;GA;;;"+std::wstring(packageText)+L")(A;;GA;;;"+std::wstring(userText)+L")";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),1,&descriptor,nullptr))tokenError=GetLastError();
   }else tokenError=GetLastError();
   if(packageText)LocalFree(packageText);if(userText)LocalFree(userText);
  }else tokenError=GetLastError();
 }
 if(token)CloseHandle(token);
 if(!descriptor&&tokenError==ERROR_SUCCESS)tokenError=ERROR_INVALID_DATA;
 std::cout<<"\"pipeCreationDiagnostics\":{\"descriptorError\":"<<tokenError<<",\"attempts\":[";
 const wchar_t* prefixes[]={L"\\\\.\\pipe\\",L"\\\\?\\pipe\\uv\\",L"\\\\.\\pipe\\LOCAL\\"};
 for(unsigned space=0;space<3;space++)for(unsigned explicitAcl=0;explicitAcl<2;explicitAcl++){
  auto name=std::wstring(prefixes[space])+L"crot-own-probe-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(space)+L"-"+std::to_wstring(explicitAcl);
  SECURITY_ATTRIBUTES sa{sizeof(sa),descriptor,FALSE};DWORD error=tokenError,closeError=ERROR_SUCCESS;
  if(!explicitAcl||descriptor){SetLastError(ERROR_SUCCESS);HANDLE h=CreateNamedPipeW(name.c_str(),PIPE_ACCESS_INBOUND|FILE_FLAG_OVERLAPPED|WRITE_DAC|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,1,65536,65536,0,explicitAcl?&sa:nullptr);error=h==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;if(h!=INVALID_HANDLE_VALUE&&!CloseHandle(h))closeError=GetLastError();}
  if(space||explicitAcl)std::cout<<",";std::cout<<"{\"namespaceIndex\":"<<space<<",\"explicitOwnedAcl\":"<<(explicitAcl?"true":"false")<<",\"createError\":"<<error<<",\"closeError\":"<<closeError<<"}";
 }
 if(descriptor)LocalFree(descriptor);std::cout<<"]},";
}
void pathDiagnostics(std::wstring directory,bool existingCrud){
 std::cout<<"{";pipeCreationDiagnostics();std::cout<<"\"existingDirectoryDeleteOpen\":"<<existingDirectoryDeleteOpen<<",\"existingWorkspaceCrud\":"<<(existingCrud?"true":"false")<<",\"existingWorkspaceSteps\":[";for(unsigned i=0;i<7;i++){if(i)std::cout<<",";std::cout<<existingWorkspaceSteps[i];}std::cout<<"],\"directoryAccess\":[";bool first=true;
 for(unsigned depth=0;depth<64;depth++){
  if(!first)std::cout<<",";first=false;
  SetLastError(ERROR_SUCCESS);DWORD attributes=GetFileAttributesW(directory.c_str());
  DWORD attributeError=attributes==INVALID_FILE_ATTRIBUTES?GetLastError():ERROR_SUCCESS;
  std::cout<<"{\"depth\":"<<depth<<",\"attributeError\":"<<attributeError<<",\"opens\":[";
  const DWORD masks[]={FILE_READ_ATTRIBUTES,FILE_TRAVERSE,FILE_LIST_DIRECTORY,FILE_ADD_FILE,FILE_ADD_SUBDIRECTORY,DELETE,WRITE_DAC,WRITE_OWNER};
  for(unsigned i=0;i<sizeof(masks)/sizeof(masks[0]);i++){
   SetLastError(ERROR_SUCCESS);HANDLE h=CreateFileW(directory.c_str(),masks[i],FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
   DWORD error=h==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;
   DWORD closeError=ERROR_SUCCESS;if(h!=INVALID_HANDLE_VALUE&&!CloseHandle(h))closeError=GetLastError();
   if(i)std::cout<<",";std::cout<<"{\"mask\":"<<masks[i]<<",\"error\":"<<error<<",\"closeError\":"<<closeError<<"}";
  }
  std::cout<<"]}";
  if(directory.size()<=3)break;
  size_t slash=directory.find_last_of(L'\\');if(slash==std::wstring::npos)break;
  directory=directory.substr(0,slash<3?3:slash);
 }
 std::cout<<"],\"childConsoleModes\":[";
 wchar_t self[32768]{};DWORD length=GetModuleFileNameW(nullptr,self,32768);
 for(unsigned mode=0;mode<2;mode++){
  STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};DWORD code=STILL_ACTIVE,error=ERROR_SUCCESS;
  std::wstring line=L"\""+std::wstring(self)+L"\" --smoke-child";
  if(!length||length>=32768||!CreateProcessW(self,line.data(),nullptr,nullptr,FALSE,mode?CREATE_NO_WINDOW:0,nullptr,nullptr,&si,&pi))error=GetLastError();
  else{if(WaitForSingleObject(pi.hProcess,5000)!=WAIT_OBJECT_0){error=WAIT_TIMEOUT;TerminateProcess(pi.hProcess,1);WaitForSingleObject(pi.hProcess,5000);}GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);}
  if(mode)std::cout<<",";std::cout<<"{\"noWindow\":"<<(mode?"true":"false")<<",\"createError\":"<<error<<",\"exit\":"<<code<<"}";
 }
 std::cout<<"]}"<<std::endl;
}
DWORD openedFlags=0;
bool denied(const std::wstring& p,DWORD mask,DWORD openedBit=0){HANDLE h=CreateFileW(p.c_str(),mask,7,nullptr,OPEN_EXISTING,0,nullptr);DWORD e=GetLastError();if(h!=INVALID_HANDLE_VALUE){openedFlags|=openedBit;CloseHandle(h);return false;}return e==ERROR_ACCESS_DENIED;}
int wmain(int argc,wchar_t**argv){if(argc==2&&std::wstring(argv[1])==L"--smoke-child")return 0;if(argc!=6)return 2;std::wstring root=argv[1],temp=argv[2],cache=argv[3],outside=argv[4],secret=argv[5];DWORD bits=0;
 // Mutate an EXISTING single-link file while its original SD is pinned.
 // Sharing permissions do not grant access: the AppContainer DACL still gates it.
 auto dir=root+L"\\existing-directory",renamedDir=root+L"\\existing-renamed";
 auto file=dir+L"\\before.txt",renamedFile=dir+L"\\after.txt";
 HANDLE existing=CreateFileW(file.c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,0,nullptr);
 existingWorkspaceSteps[0]=existing==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;
 bool existingCrud=false;
 if(existing!=INVALID_HANDLE_VALUE){DWORD n=0;bool written=!!WriteFile(existing,"changed",7,&n,nullptr)&&n==7;existingWorkspaceSteps[1]=written?ERROR_SUCCESS:GetLastError();bool closed=!!CloseHandle(existing);existingWorkspaceSteps[2]=closed?ERROR_SUCCESS:GetLastError();
  if(written&&closed){
   const std::wstring from[]={file,renamedFile,dir,renamedDir},to[]={renamedFile,file,renamedDir,dir};
   existingCrud=true;for(unsigned i=0;i<4;i++){bool moved=!!MoveFileW(from[i].c_str(),to[i].c_str());existingWorkspaceSteps[3+i]=moved?ERROR_SUCCESS:GetLastError();if(!moved){existingCrud=false;break;}}
  }
 }
 HANDLE directoryDelete=CreateFileW(dir.c_str(),DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);existingDirectoryDeleteOpen=directoryDelete==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;if(directoryDelete!=INVALID_HANDLE_VALUE)CloseHandle(directoryDelete);
 pathDiagnostics(root,existingCrud);
 HANDLE nul=CreateFileW(L"\\\\.\\NUL",GENERIC_READ|GENERIC_WRITE,7,nullptr,OPEN_EXISTING,0,nullptr);if(nul!=INVALID_HANDLE_VALUE){char b=0;DWORD written=0,read=1;bool okay=!!WriteFile(nul,"x",1,&written,nullptr)&&written==1&&!!ReadFile(nul,&b,1,&read,nullptr)&&read==0;bool closed=!!CloseHandle(nul);if(okay&&closed)bits|=1;}
 auto from=root+L"\\native-юникод.txt",to=root+L"\\native-renamed.txt";
 if(put(from,"live")&&MoveFileW(from.c_str(),to.c_str())&&DeleteFileW(to.c_str()))bits|=2;
 if(put(temp+L"\\temp.txt","temp"))bits|=4;if(put(cache+L"\\cache.txt","cache"))bits|=8;
 if(denied(outside+L"\\target.txt",GENERIC_WRITE))bits|=16;
 if(denied(secret,GENERIC_READ,512))bits|=32;if(denied(secret,GENERIC_WRITE,1024))bits|=64;
 if(denied(outside+L"\\alias.txt",GENERIC_WRITE,256))bits|=128;
 if(denied(root+L"\\link-source.txt",GENERIC_WRITE,4096))bits|=2048;
 HANDLE linkedRead=CreateFileW((root+L"\\link-source.txt").c_str(),GENERIC_READ,7,nullptr,OPEN_EXISTING,0,nullptr);
 if(linkedRead!=INVALID_HANDLE_VALUE){char text[16]{};DWORD n=0;bool okay=!!ReadFile(linkedRead,text,sizeof(text),&n,nullptr)&&n==10&&memcmp(text,"host-owned",10)==0;bool closed=!!CloseHandle(linkedRead);if(okay&&closed)bits|=16384;}

 bool linkSource=put(root+L"\\node-source.txt","ordinary");SetLastError(ERROR_SUCCESS);if(linkSource&&!CreateHardLinkW((outside+L"\\actor-created-link.txt").c_str(),(root+L"\\node-source.txt").c_str(),nullptr)&&GetLastError()==ERROR_ACCESS_DENIED)bits|=8192;

 bool internal=put(root+L"\\internal-source.txt","internal-first");
 auto readText=[](const std::wstring& p,const char* expected){HANDLE h=CreateFileW(p.c_str(),GENERIC_READ,7,nullptr,OPEN_EXISTING,0,nullptr);if(h==INVALID_HANDLE_VALUE)return false;char b[64]{};DWORD n=0;bool okay=!!ReadFile(h,b,sizeof(b),&n,nullptr)&&n==strlen(expected)&&memcmp(b,expected,n)==0;return !!CloseHandle(h)&&okay;};
 internal=internal&&readText(root+L"\\internal-alias.txt","internal-first")&&put(root+L"\\internal-alias.txt","internal-final")&&readText(root+L"\\internal-source.txt","internal-final");
 if(internal)bits|=32768;
 return static_cast<int>(0x43520000u|bits|openedFlags);
}
