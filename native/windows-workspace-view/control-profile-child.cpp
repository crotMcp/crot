// AD-28: fixed diagnostic child. OS SDK only; never an actor/backend.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <cwchar>
#include <string>
#include <vector>
namespace {
using NtCreate = NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,
    PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
bool info(HANDLE token,TOKEN_INFORMATION_CLASS type,std::vector<unsigned char>& out) {
  DWORD n=0; GetTokenInformation(token,type,nullptr,0,&n);
  if (n<4 || n>65536) return false;
  out.resize(n); return !!GetTokenInformation(token,type,out.data(),n,&n);
}
unsigned classify(HANDLE h,DWORD error) {
  if (h!=INVALID_HANDLE_VALUE && h) return CloseHandle(h)?1u:3u;
  if (error==ERROR_ACCESS_DENIED) return 0;
  if (error==ERROR_FILE_NOT_FOUND || error==ERROR_PATH_NOT_FOUND) return 2;
  return 3;
}
unsigned nativeOpen(NtCreate create,const std::wstring& device,ACCESS_MASK access) {
  UNICODE_STRING name{}; name.Buffer=const_cast<PWSTR>(device.c_str());
  name.Length=static_cast<USHORT>(device.size()*2); name.MaximumLength=name.Length;
  OBJECT_ATTRIBUTES a{}; a.Length=sizeof(a); a.ObjectName=&name; a.Attributes=0x40;
  IO_STATUS_BLOCK io{}; HANDLE h=INVALID_HANDLE_VALUE;
  // Win32 zero DesiredAccess implicitly permits a metadata handle. Test the
  // equivalent native handle, not an unsupported literal zero-access create.
  const NTSTATUS s=create(&h,access|FILE_READ_ATTRIBUTES|SYNCHRONIZE,&a,&io,nullptr,0,7,1,0x40,nullptr,0);
  if (s>=0 && h && h!=INVALID_HANDLE_VALUE) return CloseHandle(h)?1u:3u;
  if (h && h!=INVALID_HANDLE_VALUE && !CloseHandle(h)) return 3;
  if (s==static_cast<NTSTATUS>(0xc0000022)) return 0;
  if (s==static_cast<NTSTATUS>(0xc0000034) || s==static_cast<NTSTATUS>(0xc000003a)) return 2;
  return 3;
}
}
int wmain(int argc,wchar_t** argv) {
  // Fixed bounded diagnostic frame in exit status; absence means NOT ready.
  if (argc!=3 || (wcscmp(argv[2],L"0") && wcscmp(argv[2],L"1"))) return 2;
  const std::wstring device=argv[1];
  if (device.size()!=52 || device.compare(0,15,L"\\Device\\Volume{") || device.back()!=L'}' ||
      device.find_first_not_of(L"0123456789abcdefABCDEF-",15)<device.size()-1) return 2;
  HANDLE token=nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return 3;
  std::vector<unsigned char> app,caps,il;
  using QueryToken=NTSTATUS(NTAPI*)(HANDLE,TOKEN_INFORMATION_CLASS,PVOID,ULONG,PULONG);
  static_assert(sizeof(ULONG)==4,"LPAC query ULONG ABI");
  auto query=reinterpret_cast<QueryToken>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryInformationToken"));
  ULONG lpac=0,returned=0;
  bool okay=info(token,TokenIsAppContainer,app) && info(token,TokenCapabilities,caps) &&
      info(token,TokenIntegrityLevel,il) && query &&
      query(token,static_cast<TOKEN_INFORMATION_CLASS>(46),&lpac,sizeof(lpac),&returned)>=0 && returned==sizeof(lpac);
  if (okay) {
    auto sid=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
    okay=!!*reinterpret_cast<DWORD*>(app.data()) &&
        reinterpret_cast<TOKEN_GROUPS*>(caps.data())->GroupCount==0 && IsValidSid(sid) &&
        *GetSidSubAuthorityCount(sid)==1 && *GetSidSubAuthority(sid,0)==4096 &&
        !!lpac==(argv[2][0]==L'1');
  }
  if (!CloseHandle(token) || !okay) return 4;
  auto create=reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile"));
  if (!create) return 5;
  const std::wstring raw=L"\\\\?\\GLOBALROOT"+device;
  unsigned bits=0;
  for (unsigned i=0;i<2;i++) {
    HANDLE h=CreateFileW(raw.c_str(),i?GENERIC_READ:0,7,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
    const DWORD e=GetLastError(); bits|=classify(h,e)<<(i*2);
    bits|=nativeOpen(create,device,i?GENERIC_READ:0)<<((i+2)*2);
  }
  HANDLE nul=CreateFileW(L"NUL",GENERIC_READ|GENERIC_WRITE,7,nullptr,OPEN_EXISTING,0,nullptr);
  if (nul!=INVALID_HANDLE_VALUE) { if (!CloseHandle(nul)) return 6; bits|=0x100; }
  return static_cast<int>(0x43520000u|bits);
}
