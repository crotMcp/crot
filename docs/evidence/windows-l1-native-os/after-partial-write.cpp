#include <string>
#include <cstring>
#include <iostream>
using HANDLE=long; using DWORD=unsigned long;
constexpr HANDLE INVALID_HANDLE_VALUE=-1;
constexpr DWORD GENERIC_WRITE=1,CREATE_ALWAYS=2;
int scenario=0,closed=0;
HANDLE CreateFileW(const wchar_t*,DWORD,DWORD,void*,DWORD,DWORD,void*){return scenario==1?INVALID_HANDLE_VALUE:42;}
int WriteFile(HANDLE,const char*,DWORD length,DWORD* written,void*){*written=scenario==3?length-1:length;return scenario==2?0:1;}
int CloseHandle(HANDLE){closed++;return scenario==4?0:1;}
bool put(const std::wstring& p,const char* text){HANDLE h=CreateFileW(p.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,0,nullptr);if(h==INVALID_HANDLE_VALUE)return false;DWORD n=0;bool okay=!!WriteFile(h,text,static_cast<DWORD>(strlen(text)),&n,nullptr)&&n==strlen(text);return !!CloseHandle(h)&&okay;}
int main(){for(scenario=0;scenario<5;scenario++){closed=0;bool okay=put(L"fixture", "four");bool expected=scenario==0;if(okay!=expected || closed!=(scenario==1?0:1)){std::cout<<"FAIL scenario="<<scenario<<" okay="<<okay<<" closed="<<closed<<std::endl;return 3;}}std::cout<<"PASS 5 mocked I/O outcomes (not native Windows qualification)"<<std::endl;}
