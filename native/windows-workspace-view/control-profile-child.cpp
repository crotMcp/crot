// AD-29 fixed OS-only child. No arbitrary program or RPC interface.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <cstring>
#include <iostream>
bool put(const std::wstring& p,const char* text){HANDLE h=CreateFileW(p.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,0,nullptr);if(h==INVALID_HANDLE_VALUE)return false;DWORD n=0;bool okay=!!WriteFile(h,text,static_cast<DWORD>(strlen(text)),&n,nullptr)&&n==strlen(text);return !!CloseHandle(h)&&okay;}
// Read-only host-path diagnosis. Do not enumerate names, read file bytes,
// change a descriptor, enable privileges, or turn observations into grants.
// A successful directory open with a write mask is recorded, never exercised.
void pathDiagnostics(std::wstring directory){
 std::cout<<"{\"directoryAccess\":[";bool first=true;
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
 pathDiagnostics(root);
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

 return static_cast<int>(0x43520000u|bits|openedFlags);
}
