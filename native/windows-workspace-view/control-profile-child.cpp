// AD-29 fixed OS-only child. No arbitrary program or RPC interface.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <cstring>
bool put(const std::wstring& p,const char* text){HANDLE h=CreateFileW(p.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,0,nullptr);if(h==INVALID_HANDLE_VALUE)return false;DWORD n=0;bool okay=!!WriteFile(h,text,static_cast<DWORD>(strlen(text)),&n,nullptr);return !!CloseHandle(h)&&okay;}
bool denied(const std::wstring& p,DWORD mask){HANDLE h=CreateFileW(p.c_str(),mask,7,nullptr,OPEN_EXISTING,0,nullptr);DWORD e=GetLastError();if(h!=INVALID_HANDLE_VALUE){CloseHandle(h);return false;}return e==ERROR_ACCESS_DENIED;}
int wmain(int argc,wchar_t**argv){if(argc!=6)return 2;std::wstring root=argv[1],temp=argv[2],cache=argv[3],outside=argv[4],secret=argv[5];DWORD bits=0;
 HANDLE nul=CreateFileW(L"\\\\.\\NUL",GENERIC_READ|GENERIC_WRITE,7,nullptr,OPEN_EXISTING,0,nullptr);if(nul!=INVALID_HANDLE_VALUE&&CloseHandle(nul))bits|=1;
 auto from=root+L"\\native-юникод.txt",to=root+L"\\native-renamed.txt";
 if(put(from,"live")&&MoveFileW(from.c_str(),to.c_str())&&DeleteFileW(to.c_str()))bits|=2;
 if(put(temp+L"\\temp.txt","temp"))bits|=4;if(put(cache+L"\\cache.txt","cache"))bits|=8;
 if(denied(outside+L"\\target.txt",GENERIC_WRITE))bits|=16;
 if(denied(secret,GENERIC_READ))bits|=32;if(denied(secret,GENERIC_WRITE))bits|=64;
 if(denied(outside+L"\\alias.txt",GENERIC_WRITE))bits|=128;
 return static_cast<int>(0x43520000u|bits);
}
