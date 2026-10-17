// AD-29 A.2: compatibility only. Windows AppContainer/Job/DACL remain the boundary.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <cstring>
#include "detours.h"
#include "pipe-prefix.h"
static decltype(&CreateNamedPipeW) realPipe=CreateNamedPipeW;
static decltype(&CreateFileW) realFile=CreateFileW;
static decltype(&CreateNamedPipeA) realPipeA=CreateNamedPipeA;
static decltype(&CreateFileA) realFileA=CreateFileA;
static decltype(&CreateProcessW) realProcess=CreateProcessW;
static char ownedDll[32768]{};
static HMODULE selfModule=nullptr;
static bool isAppContainer(){
 HANDLE token=nullptr;DWORD app=0,bytes=0;
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return false;
 BOOL okay=GetTokenInformation(token,TokenIsAppContainer,&app,sizeof(app),&bytes);CloseHandle(token);
 return okay&&bytes==sizeof(app)&&app==1;
}
static bool dllAnsiPath(HMODULE module,char* output,DWORD count){
 wchar_t name[32768]{},shortName[32768]{};
 DWORD n=GetModuleFileNameW(module,name,32768);if(!n||n>=32768)return false;
 // PE import names are ANSI. Never lossy-convert an installation path.
 BOOL used=FALSE;int size=WideCharToMultiByte(CP_ACP,WC_NO_BEST_FIT_CHARS,name,-1,output,count,nullptr,&used);
 if(size>0&&!used)return true;
 n=GetShortPathNameW(name,shortName,32768);if(!n||n>=32768)return false;
 used=FALSE;size=WideCharToMultiByte(CP_ACP,WC_NO_BEST_FIT_CHARS,shortName,-1,output,count,nullptr,&used);
 return size>0&&!used;
}
static HANDLE WINAPI localPipe(LPCWSTR name,DWORD openMode,DWORD mode,DWORD instances,DWORD outSize,DWORD inSize,DWORD timeout,LPSECURITY_ATTRIBUTES security){
 try{HANDLE result;DWORD error;{std::wstring local;result=realPipe(crotLocalPipeName(name,local)?local.c_str():name,openMode,mode,instances,outSize,inSize,timeout,security);error=GetLastError();}SetLastError(error);return result;}
 catch(...){SetLastError(ERROR_NOT_ENOUGH_MEMORY);return INVALID_HANDLE_VALUE;}
}
static HANDLE WINAPI localFile(LPCWSTR name,DWORD access,DWORD share,LPSECURITY_ATTRIBUTES security,DWORD disposition,DWORD flags,HANDLE templateFile){
 try{HANDLE result;DWORD error;{std::wstring local;result=realFile(crotLocalPipeName(name,local)?local.c_str():name,access,share,security,disposition,flags,templateFile);error=GetLastError();}SetLastError(error);return result;}
 catch(...){SetLastError(ERROR_NOT_ENOUGH_MEMORY);return INVALID_HANDLE_VALUE;}
}
static HANDLE WINAPI localPipeA(LPCSTR name,DWORD openMode,DWORD mode,DWORD instances,DWORD outSize,DWORD inSize,DWORD timeout,LPSECURITY_ATTRIBUTES security){
 try{HANDLE result;DWORD error;{std::string local;result=realPipeA(crotLocalPipeName(name,local)?local.c_str():name,openMode,mode,instances,outSize,inSize,timeout,security);error=GetLastError();}SetLastError(error);return result;}
 catch(...){SetLastError(ERROR_NOT_ENOUGH_MEMORY);return INVALID_HANDLE_VALUE;}
}
static HANDLE WINAPI localFileA(LPCSTR name,DWORD access,DWORD share,LPSECURITY_ATTRIBUTES security,DWORD disposition,DWORD flags,HANDLE templateFile){
 try{HANDLE result;DWORD error;{std::string local;result=realFileA(crotLocalPipeName(name,local)?local.c_str():name,access,share,security,disposition,flags,templateFile);error=GetLastError();}SetLastError(error);return result;}
 catch(...){SetLastError(ERROR_NOT_ENOUGH_MEMORY);return INVALID_HANDLE_VALUE;}
}
static BOOL WINAPI localProcess(LPCWSTR app,LPWSTR command,LPSECURITY_ATTRIBUTES pa,LPSECURITY_ATTRIBUTES ta,BOOL inherit,DWORD flags,LPVOID env,LPCWSTR cwd,LPSTARTUPINFOW startup,LPPROCESS_INFORMATION output){
 PROCESS_INFORMATION child{};
 if(!realProcess(app,command,pa,ta,inherit,flags|CREATE_SUSPENDED,env,cwd,startup,&child))return FALSE;
 LPCSTR dll=ownedDll;DWORD error=ERROR_SUCCESS;
 // No helper process, elevation, architecture fallback or resumed-on-failure path.
 if(!DetourUpdateProcessWithDll(child.hProcess,&dll,1)){error=GetLastError();if(!error)error=ERROR_DLL_INIT_FAILED;}
 else if(!(flags&CREATE_SUSPENDED)&&ResumeThread(child.hThread)!=1)error=GetLastError()?GetLastError():ERROR_INVALID_STATE;
 if(error){
  TerminateProcess(child.hProcess,1);WaitForSingleObject(child.hProcess,5000);
  CloseHandle(child.hThread);CloseHandle(child.hProcess);
  if(output)ZeroMemory(output,sizeof(*output));SetLastError(error);return FALSE;
 }
 if(output)*output=child;else{CloseHandle(child.hThread);CloseHandle(child.hProcess);}return TRUE;
}
// Host-only seam: called AFTER token readback and Job assignment, BEFORE ResumeThread.
// The caller supplies only its owned process handle, never an actor-selected PID/path.
extern "C" __declspec(dllexport) DWORD WINAPI CrotInjectLocalShim(HANDLE process){
 if(isAppContainer())return ERROR_ACCESS_DENIED;
 char name[32768]{};if(!dllAnsiPath(selfModule,name,sizeof(name)))return ERROR_NO_UNICODE_TRANSLATION;
 LPCSTR dll=name;if(DetourUpdateProcessWithDll(process,&dll,1))return ERROR_SUCCESS;
 DWORD error=GetLastError();return error?error:ERROR_DLL_INIT_FAILED;
}
extern "C" __declspec(dllexport) DWORD WINAPI CrotLocalShimVersion(){return 1;}
extern "C" __declspec(dllexport) DWORD WINAPI CrotMapPipeName(LPCWSTR name,LPWSTR output,DWORD count){
 try{std::wstring mapped;if(!crotLocalPipeName(name,mapped))return 0;if(mapped.size()+1>count)return 2;memcpy(output,mapped.c_str(),(mapped.size()+1)*sizeof(wchar_t));return 1;}catch(...){return 2;}
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID){
 if(reason!=DLL_PROCESS_ATTACH)return TRUE;
 selfModule=instance;DisableThreadLibraryCalls(instance);
 if(DetourIsHelperProcess())return FALSE; // no cross-architecture helper is a supported fallback
 if(!isAppContainer())return TRUE; // FFI host loads the control export, but is NEVER hooked
 if(!DetourRestoreAfterWith()||!dllAnsiPath(instance,ownedDll,sizeof(ownedDll)))return FALSE;
 if(DetourTransactionBegin()!=NO_ERROR)return FALSE;
 LONG error=DetourUpdateThread(GetCurrentThread());
 if(!error)error=DetourAttach(reinterpret_cast<PVOID*>(&realPipe),localPipe);
 if(!error)error=DetourAttach(reinterpret_cast<PVOID*>(&realFile),localFile);
 if(!error)error=DetourAttach(reinterpret_cast<PVOID*>(&realPipeA),localPipeA);
 if(!error)error=DetourAttach(reinterpret_cast<PVOID*>(&realFileA),localFileA);
 if(!error)error=DetourAttach(reinterpret_cast<PVOID*>(&realProcess),localProcess);
 if(error){DetourTransactionAbort();return FALSE;}
 return DetourTransactionCommit()==NO_ERROR;
}
