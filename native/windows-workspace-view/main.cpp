// AD-27: scoped same-backing filesystem component. NOT production L1 acceptance.
// Uses installed Dokan headers/DLL; no third-party implementation is embedded.
#define WIN32_LEAN_AND_MEAN
#include <dokan.h>
#include <sddl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cwctype>
#include <cwchar>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
struct Error { NTSTATUS status; };
[[noreturn]] void deny(NTSTATUS s = STATUS_ACCESS_DENIED) { throw Error{s}; }
NTSTATUS winerror() { return DokanNtStatusFromWin32(GetLastError()); }
std::atomic<bool> failed{false};
HANDLE stopEvent = nullptr;
void fault() { failed = true; if (stopEvent) SetEvent(stopEvent); }
// A failed release is still owned. A fixed registry avoids allocating in a
// destructor; no further filesystem allocation is allowed after fault().
std::mutex releaseLock;
std::array<HANDLE,1024> retained{};
void release(HANDLE h) noexcept {
  if (!h || h==INVALID_HANDLE_VALUE || CloseHandle(h)) return;
  fault();
  std::lock_guard<std::mutex> lock(releaseLock);
  for (auto& slot:retained) if (!slot) { slot=h; return; }
  // Exhaustion cannot silently discard ownership or continue serving requests.
  ExitProcess(3);
}
bool retryReleases() {
  bool okay=true;
  std::lock_guard<std::mutex> lock(releaseLock);
  for (auto& slot:retained) if (slot) {
    if (CloseHandle(slot)) slot=nullptr; else okay=false;
  }
  return okay;
}
struct Handle {
  HANDLE h = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE v):h(v) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& o) noexcept:h(o.h) { o.h = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& o) noexcept {
    if (this != &o) { release(h); h=o.h; o.h=INVALID_HANDLE_VALUE; }
    return *this;
  }
  ~Handle() { release(h); }
  bool valid() const { return h && h != INVALID_HANDLE_VALUE; }
};
struct NativeAttributes { ULONG Length; HANDLE RootDirectory; PUNICODE_STRING ObjectName; ULONG Attributes; PVOID SecurityDescriptor; PVOID SecurityQualityOfService; };
struct NativeStatus { union { NTSTATUS Status; PVOID Pointer; }; ULONG_PTR Information; };
static_assert(sizeof(NativeAttributes)==48 && sizeof(NativeStatus)==16 && sizeof(void*)==8,"64-bit ABI required");
using NtCreate = NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,NativeAttributes*,NativeStatus*,
    PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
NtCreate ntCreate = nullptr;
std::wstring rootPath, mountPath, jobName;
std::vector<std::wstring> deniedRoots;
std::vector<Handle> rootPins;
HANDLE root = INVALID_HANDLE_VALUE;
Handle job;
PSECURITY_DESCRIPTOR projected = nullptr;
PSID ownerSid = nullptr, uniqueSid = nullptr;
std::mutex mutations;

std::wstring fold(std::wstring s) {
  for (auto& c:s) c = static_cast<wchar_t>(towupper(c));
  return s;
}
std::vector<std::wstring> parts(const std::wstring& name, bool absolute = false) {
  if (name.empty() || name.size() > 32000 || name.front() != L'\\') deny();
  std::vector<std::wstring> out;
  size_t p = 1;
  if (name == L"\\") return out;
  while (p < name.size()) {
    auto end = name.find(L'\\',p);
    auto s = name.substr(p,end == std::wstring::npos ? end : end-p);
    if (s.empty() || s.size()>255 || s==L"." || s==L".." || s.back()==L'.' || s.back()==L' ') deny();
    for (wchar_t c:s) if (c<32 || wcschr(L"/:*?\"<>|",c) || (!absolute && c==L'~')) deny();
    auto upper = fold(s.substr(0,s.find(L'.')));
    if (upper==L"CON" || upper==L"PRN" || upper==L"AUX" || upper==L"NUL" ||
        upper==L"CONIN$" || upper==L"CONOUT$" || upper==L"CLOCK$" ||
        (upper.size()==4 && (upper.substr(0,3)==L"COM" || upper.substr(0,3)==L"LPT") &&
          (upper[3]>=L'0' && upper[3]<=L'9'))) deny();
    out.push_back(s);
    if (out.size()>128) deny();
    if (end==std::wstring::npos) break;
    p=end+1;
  }
  if (!absolute) {
    auto f=fold(name);
    for (const auto& d:deniedRoots)
      if (f==d || (f.size()>d.size() && f.compare(0,d.size(),d)==0 && f[d.size()]==L'\\')) deny();
  }
  return out;
}
BY_HANDLE_FILE_INFORMATION inspect(HANDLE h, bool directory) {
  BY_HANDLE_FILE_INFORMATION b{};
  if (!GetFileInformationByHandle(h,&b)) deny(winerror());
  if ((b.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT) ||
      !!(b.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory || (!directory && b.nNumberOfLinks!=1)) deny();
  return b;
}
Handle openRelative(HANDLE parent,const std::wstring& leaf,ACCESS_MASK access,ULONG disposition,
    ULONG options,ULONG share,ULONG* action=nullptr) {
  if (failed) deny();
  UNICODE_STRING text{};
  text.Buffer=const_cast<PWSTR>(leaf.c_str());
  text.Length=static_cast<USHORT>(leaf.size()*2); text.MaximumLength=text.Length;
  NativeAttributes a{}; a.Length=sizeof(a); a.RootDirectory=parent; a.ObjectName=&text;
  a.Attributes=0x1040; // CASE_INSENSITIVE | DONT_REPARSE, never OPENIF on objects
  NativeStatus io{}; Handle h;
  auto s=ntCreate(&h.h,access|SYNCHRONIZE|FILE_READ_ATTRIBUTES,&a,&io,nullptr,FILE_ATTRIBUTE_NORMAL,
      share,disposition,options|0x200020,nullptr,0); // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT
  if (s<0 || !h.valid()) deny(s<0?s:STATUS_INVALID_HANDLE);
  if (action) *action=static_cast<ULONG>(io.Information);
  return h;
}
struct Bound {
  std::vector<Handle> pins;
  HANDLE parent = INVALID_HANDLE_VALUE;
  std::wstring leaf;
};
Bound bindParent(const std::vector<std::wstring>& p) {
  Bound b; b.parent=root;
  for (size_t i=0;i+1<p.size();++i) {
    auto h=openRelative(b.parent,p[i],FILE_TRAVERSE|FILE_LIST_DIRECTORY,FILE_OPEN,
        FILE_DIRECTORY_FILE,FILE_SHARE_READ|FILE_SHARE_WRITE);
    inspect(h.h,true); b.parent=h.h; b.pins.push_back(std::move(h));
  }
  if (!p.empty()) b.leaf=p.back();
  return b;
}
std::vector<unsigned char> tokenInfo(HANDLE token,TOKEN_INFORMATION_CLASS type) {
  DWORD n=0; GetTokenInformation(token,type,nullptr,0,&n);
  if (n<4 || n>65536) deny();
  std::vector<unsigned char> b(n);
  if (!GetTokenInformation(token,type,b.data(),n,&n)) deny();
  return b;
}
void authorize(PDOKAN_FILE_INFO fi) {
  if (failed || !fi->ProcessId) deny();
  Handle request(DokanOpenRequestorToken(fi));
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,fi->ProcessId));
  if (!request.valid() || !process.valid() || WaitForSingleObject(process.h,0)!=WAIT_TIMEOUT) deny();
  Handle primary;
  if (!OpenProcessToken(process.h,TOKEN_QUERY,&primary.h)) deny();
  auto a=tokenInfo(request.h,TokenStatistics), b=tokenInfo(primary.h,TokenStatistics);
  if (memcmp(&reinterpret_cast<TOKEN_STATISTICS*>(a.data())->TokenId,
             &reinterpret_cast<TOKEN_STATISTICS*>(b.data())->TokenId,sizeof(LUID))) deny();
  BOOL member=FALSE;
  if (!IsProcessInJob(process.h,job.h,&member) || !member || !IsTokenRestricted(request.h)) deny();
  auto u=tokenInfo(request.h,TokenUser), g=tokenInfo(request.h,TokenRestrictedSids), il=tokenInfo(request.h,TokenIntegrityLevel);
  auto groups=reinterpret_cast<TOKEN_GROUPS*>(g.data());
  auto label=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
  if (!EqualSid(reinterpret_cast<TOKEN_USER*>(u.data())->User.Sid,ownerSid) ||
      groups->GroupCount!=1 || !EqualSid(groups->Groups[0].Sid,uniqueSid) ||
      !IsValidSid(label) || *GetSidSubAuthorityCount(label)!=1 || *GetSidSubAuthority(label,0)!=4096) deny();
}
struct File {
  Handle handle;
  std::vector<Handle> pins;
  std::mutex lock;
  bool directory=false, root=false;
  ACCESS_MASK granted=0;
};
File& context(PDOKAN_FILE_INFO fi) {
  if (failed || !fi->Context) deny(STATUS_INVALID_HANDLE);
  return *reinterpret_cast<File*>(fi->Context);
}
template<class Fn> NTSTATUS status(Fn fn) noexcept {
  try { fn(); return STATUS_SUCCESS; }
  catch (const Error& e) { return e.status; }
  catch (...) { fault(); return STATUS_INTERNAL_ERROR; }
}
NTSTATUS DOKAN_CALLBACK create(LPCWSTR name,PDOKAN_IO_SECURITY_CONTEXT,ACCESS_MASK access,
    ULONG attributes,ULONG,ULONG disposition,ULONG options,PDOKAN_FILE_INFO fi) {
  bool openedExisting=false;
  auto outcome=status([&] {
    authorize(fi);
    GENERIC_MAPPING mapping{FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};
    MapGenericMask(&access,&mapping);
    auto p=parts(name);
    if (fi->Context || access&(WRITE_DAC|WRITE_OWNER|ACCESS_SYSTEM_SECURITY) ||
        attributes&FILE_ATTRIBUTE_REPARSE_POINT || options&FILE_OPEN_BY_FILE_ID || disposition==FILE_SUPERSEDE) deny();
    std::lock_guard<std::mutex> mutation(mutations);
    auto f=std::make_unique<File>();
    f->directory=!!(options&FILE_DIRECTORY_FILE); f->root=p.empty(); f->granted=access;
    if (f->root) {
      if (disposition!=FILE_OPEN || access&(FILE_WRITE_DATA|FILE_APPEND_DATA|DELETE|FILE_WRITE_ATTRIBUTES)) deny();
      f->directory=true;
      if (!DuplicateHandle(GetCurrentProcess(),root,GetCurrentProcess(),&f->handle.h,0,FALSE,DUPLICATE_SAME_ACCESS)) deny(winerror());
    } else {
      auto bound=bindParent(p);
      ULONG action=0;
      const ULONG safeDisposition=(disposition==FILE_OVERWRITE_IF)?FILE_OPEN_IF:
          (disposition==FILE_OVERWRITE)?FILE_OPEN:disposition;
      if (safeDisposition!=FILE_OPEN && safeDisposition!=FILE_CREATE && safeDisposition!=FILE_OPEN_IF) deny();
      ULONG safeOptions=options&(FILE_DIRECTORY_FILE|FILE_NON_DIRECTORY_FILE);
      // No overwrite/delete before reparse/type/link checks. Exclusive backing
      // file handles conservatively reject sharing; this is not full acceptance.
      auto h=openRelative(bound.parent,bound.leaf,access,safeDisposition,safeOptions,0,&action);
      BY_HANDLE_FILE_INFORMATION detected{};
      if (!GetFileInformationByHandle(h.h,&detected)) deny(winerror());
      f->directory=!!(detected.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY);
      if ((fi->IsDirectory || (options&FILE_DIRECTORY_FILE)) && !f->directory) deny(STATUS_NOT_A_DIRECTORY);
      inspect(h.h,f->directory);
      openedExisting=action==1 && (disposition==FILE_OPEN_IF || disposition==FILE_OVERWRITE_IF);
      if (disposition==FILE_OVERWRITE || disposition==FILE_OVERWRITE_IF) {
        if (f->directory || !(access&FILE_WRITE_DATA)) deny();
        FILE_END_OF_FILE_INFO end{};
        if (!SetFileInformationByHandle(h.h,FileEndOfFileInfo,&end,sizeof(end))) deny(winerror());
      }
      f->handle=std::move(h); f->pins=std::move(bound.pins);
    }
    inspect(f->handle.h,f->directory);
    fi->IsDirectory=f->directory; fi->Context=reinterpret_cast<ULONG64>(f.release());
  });
  return outcome==STATUS_SUCCESS && openedExisting ? STATUS_OBJECT_NAME_COLLISION : outcome;
}
void DOKAN_CALLBACK cleanup(LPCWSTR,PDOKAN_FILE_INFO fi) {
  if (!fi->Context || !fi->DeletePending) return;
  auto s=status([&] { auto& f=context(fi); std::lock_guard<std::mutex> lock(f.lock);
    if (f.root || !(f.granted&DELETE)) deny();
    FILE_DISPOSITION_INFO d{TRUE};
    if (!SetFileInformationByHandle(f.handle.h,FileDispositionInfo,&d,sizeof(d))) deny(winerror());
  });
  if (s<0) fault(); // cleanup cannot report a failed delete as success
}
void DOKAN_CALLBACK closeFile(LPCWSTR,PDOKAN_FILE_INFO fi) {
  auto p=reinterpret_cast<File*>(fi->Context); fi->Context=0; delete p;
}
NTSTATUS DOKAN_CALLBACK readFile(LPCWSTR,LPVOID buffer,DWORD size,LPDWORD done,LONGLONG offset,PDOKAN_FILE_INFO fi) {
  *done=0; return status([&] { auto& f=context(fi); std::lock_guard<std::mutex> lock(f.lock);
    if (offset<0 || f.directory || !(f.granted&FILE_READ_DATA)) deny();
    LARGE_INTEGER pos; pos.QuadPart=offset;
    if (!SetFilePointerEx(f.handle.h,pos,nullptr,FILE_BEGIN) || !ReadFile(f.handle.h,buffer,size,done,nullptr)) deny(winerror());
  });
}
NTSTATUS DOKAN_CALLBACK writeFile(LPCWSTR,LPCVOID buffer,DWORD size,LPDWORD done,LONGLONG offset,PDOKAN_FILE_INFO fi) {
  *done=0; return status([&] { auto& f=context(fi); std::lock_guard<std::mutex> lock(f.lock);
    if (f.directory || !(f.granted&(FILE_WRITE_DATA|FILE_APPEND_DATA))) deny();
    LARGE_INTEGER pos; pos.QuadPart=offset;
    if (fi->WriteToEndOfFile || offset==-1) {
      if (!GetFileSizeEx(f.handle.h,&pos)) deny(winerror());
    }
    if (pos.QuadPart<0) deny();
    if (fi->PagingIo) {
      LARGE_INTEGER end{}; if (!GetFileSizeEx(f.handle.h,&end)) deny(winerror());
      if (pos.QuadPart>=end.QuadPart) return;
      size=static_cast<DWORD>((std::min)(static_cast<LONGLONG>(size),end.QuadPart-pos.QuadPart));
    }
    if (!SetFilePointerEx(f.handle.h,pos,nullptr,FILE_BEGIN) || !WriteFile(f.handle.h,buffer,size,done,nullptr)) deny(winerror());
  });
}
NTSTATUS DOKAN_CALLBACK information(LPCWSTR,LPBY_HANDLE_FILE_INFORMATION out,PDOKAN_FILE_INFO fi) {
  return status([&] { auto& f=context(fi); *out=inspect(f.handle.h,f.directory); });
}
NTSTATUS DOKAN_CALLBACK flush(LPCWSTR,PDOKAN_FILE_INFO fi) {
  return status([&] { auto& f=context(fi); if (!FlushFileBuffers(f.handle.h)) deny(winerror()); });
}
NTSTATUS DOKAN_CALLBACK deleteFile(LPCWSTR,PDOKAN_FILE_INFO fi) {
  return status([&] { auto& f=context(fi); if (f.root || !(f.granted&DELETE)) deny();
    std::lock_guard<std::mutex> lock(f.lock);
    FILE_DISPOSITION_INFO d{}; d.DeleteFile=fi->DeletePending ? TRUE : FALSE;
    if (!SetFileInformationByHandle(f.handle.h,FileDispositionInfo,&d,sizeof(d))) deny(winerror());
  });
}
NTSTATUS DOKAN_CALLBACK renameFile(LPCWSTR,LPCWSTR target,BOOL,PDOKAN_FILE_INFO fi) {
  return status([&] { auto& f=context(fi);
    if (f.root || !(f.granted&DELETE)) deny();
    std::lock_guard<std::mutex> mutation(mutations); std::lock_guard<std::mutex> lock(f.lock);
    auto p=parts(target); if (p.empty()) deny(); auto b=bindParent(p);
    const size_t bytes=b.leaf.size()*sizeof(wchar_t);
    std::vector<unsigned char> data(offsetof(FILE_RENAME_INFO,FileName)+bytes);
    auto r=reinterpret_cast<FILE_RENAME_INFO*>(data.data());
    r->ReplaceIfExists=FALSE; r->RootDirectory=b.parent; r->FileNameLength=static_cast<DWORD>(bytes);
    memcpy(r->FileName,b.leaf.data(),bytes);
    if (!SetFileInformationByHandle(f.handle.h,FileRenameInfo,r,static_cast<DWORD>(data.size()))) deny(winerror());
    for (auto& pin:b.pins) f.pins.push_back(std::move(pin));
  });
}
NTSTATUS DOKAN_CALLBACK setEnd(LPCWSTR,LONGLONG size,PDOKAN_FILE_INFO fi) {
  return status([&] { auto& f=context(fi); std::lock_guard<std::mutex> lock(f.lock);
    if (size<0 || f.directory || !(f.granted&FILE_WRITE_DATA)) deny();
    FILE_END_OF_FILE_INFO e{}; e.EndOfFile.QuadPart=size;
    if (!SetFileInformationByHandle(f.handle.h,FileEndOfFileInfo,&e,sizeof(e))) deny(winerror());
  });
}
NTSTATUS DOKAN_CALLBACK security(LPCWSTR,PSECURITY_INFORMATION,PSECURITY_DESCRIPTOR out,ULONG size,PULONG needed,PDOKAN_FILE_INFO) {
  *needed=GetSecurityDescriptorLength(projected);
  if (size<*needed) return STATUS_BUFFER_OVERFLOW;
  memcpy(out,projected,*needed); return STATUS_SUCCESS;
}
NTSTATUS DOKAN_CALLBACK setSecurity(LPCWSTR,PSECURITY_INFORMATION,PSECURITY_DESCRIPTOR,ULONG,PDOKAN_FILE_INFO) {
  return STATUS_ACCESS_DENIED;
}
NTSTATUS DOKAN_CALLBACK volume(LPWSTR label,DWORD ln,LPDWORD serial,LPDWORD max,LPDWORD flags,LPWSTR fs,DWORD fn,PDOKAN_FILE_INFO) {
  if (ln<5 || fn<5) return STATUS_BUFFER_TOO_SMALL;
  wcscpy_s(label,ln,L"CROT"); wcscpy_s(fs,fn,L"NTFS"); *serial=0x43524f54; *max=255;
  *flags=FILE_CASE_PRESERVED_NAMES|FILE_UNICODE_ON_DISK|FILE_PERSISTENT_ACLS;
  return STATUS_SUCCESS;
}
NTSTATUS DOKAN_CALLBACK findFiles(LPCWSTR name,PFillFindData fill,PDOKAN_FILE_INFO fi) {
  return status([&] { auto& f=context(fi); std::lock_guard<std::mutex> lock(f.lock);
    if (!f.directory || !(f.granted&FILE_LIST_DIRECTORY)) deny();
    std::vector<ULONGLONG> storage(2048); bool restart=true;
    for (;;) {
      if (!GetFileInformationByHandleEx(f.handle.h,restart?FileIdBothDirectoryRestartInfo:FileIdBothDirectoryInfo,
          storage.data(),static_cast<DWORD>(storage.size()*8))) {
        if (GetLastError()==ERROR_NO_MORE_FILES) break;
        deny(winerror());
      }
      restart=false; auto entry=reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(storage.data());
      size_t used=0;
      for (;;) {
        if (used+offsetof(FILE_ID_BOTH_DIR_INFO,FileName)>storage.size()*8 || entry->FileNameLength>510 ||
            used+offsetof(FILE_ID_BOTH_DIR_INFO,FileName)+entry->FileNameLength>storage.size()*8 || entry->FileNameLength%2) deny();
        std::wstring leaf(entry->FileName,entry->FileNameLength/2);
        bool allowed=!(entry->FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT);
        try { parts(std::wstring(name)+(std::wstring(name)==L"\\"?L"":L"\\")+leaf); }
        catch(const Error&) { allowed=false; }
        if (allowed) {
          WIN32_FIND_DATAW data{}; data.dwFileAttributes=entry->FileAttributes;
          data.ftCreationTime.dwLowDateTime=entry->CreationTime.LowPart; data.ftCreationTime.dwHighDateTime=entry->CreationTime.HighPart;
          data.ftLastAccessTime.dwLowDateTime=entry->LastAccessTime.LowPart; data.ftLastAccessTime.dwHighDateTime=entry->LastAccessTime.HighPart;
          data.ftLastWriteTime.dwLowDateTime=entry->LastWriteTime.LowPart; data.ftLastWriteTime.dwHighDateTime=entry->LastWriteTime.HighPart;
          data.nFileSizeLow=entry->EndOfFile.LowPart; data.nFileSizeHigh=entry->EndOfFile.HighPart;
          wmemcpy(data.cFileName,leaf.c_str(),leaf.size());
          if (fill(&data,fi)) return;
        }
        if (!entry->NextEntryOffset) break;
        if (entry->NextEntryOffset<offsetof(FILE_ID_BOTH_DIR_INFO,FileName) || used+entry->NextEntryOffset>=storage.size()*8) deny();
        used+=entry->NextEntryOffset; entry=reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<unsigned char*>(storage.data())+used);
      }
    }
  });
}
NTSTATUS DOKAN_CALLBACK space(PULONGLONG available,PULONGLONG total,PULONGLONG free,PDOKAN_FILE_INFO) {
  ULARGE_INTEGER a{},t{},f{};
  if (!GetDiskFreeSpaceExW(rootPath.c_str(),&a,&t,&f)) return winerror();
  *available=a.QuadPart; *total=t.QuadPart; *free=f.QuadPart; return STATUS_SUCCESS;
}
size_t frameRemaining=256*1024;
bool exactRead(void* p,DWORD size) {
  if (size>frameRemaining) return false;
  frameRemaining-=size;
  auto b=static_cast<unsigned char*>(p);
  while (size) { DWORD n=0; if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE),b,size,&n,nullptr) || !n) return false; b+=n; size-=n; }
  return true;
}
std::wstring field() {
  DWORD n=0; if (!exactRead(&n,4) || n>32000) deny();
  std::wstring s(n,L'\0');
  if (!exactRead(s.data(),n*2) || s.find(L'\0')!=std::wstring::npos) deny();
  return s;
}
void pinRoot() {
  if (rootPath.size()<3 || !iswalpha(rootPath[0]) || rootPath.substr(1,2)!=L":\\") deny();
  auto p=parts(rootPath.substr(2),true);
  rootPins.emplace_back(CreateFileW(rootPath.substr(0,3).c_str(),FILE_TRAVERSE|FILE_READ_ATTRIBUTES|READ_CONTROL|SYNCHRONIZE,
      FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if (!rootPins.back().valid()) deny(winerror()); inspect(rootPins.back().h,true);
  root=rootPins.back().h;
  for (const auto& leaf:p) {
    auto h=openRelative(root,leaf,FILE_TRAVERSE|FILE_LIST_DIRECTORY,FILE_OPEN,FILE_DIRECTORY_FILE,FILE_SHARE_READ|FILE_SHARE_WRITE);
    inspect(h.h,true); root=h.h; rootPins.push_back(std::move(h));
  }
}
void joinInput(std::thread& input) {
  if (!input.joinable()) return;
  // Cancellation can race a not-yet-issued synchronous read. Retry on the
  // exact owned thread until it exits; never strand shutdown in join().
  for (unsigned i=0;i<400;i++) {
    const DWORD state=WaitForSingleObject(input.native_handle(),5);
    if (state==WAIT_OBJECT_0) { input.join(); return; }
    if (state!=WAIT_TIMEOUT) break;
    CancelSynchronousIo(input.native_handle());
  }
  ExitProcess(3); // OS releases this failed helper; no graceful-release claim.
}
} // namespace
int wmain() {
  int result=1; DOKAN_HANDLE instance=nullptr;
  std::thread input; bool initialized=false;
  try {
    SetDllDirectoryW(L"");
    ntCreate=reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile"));
    if (!ntCreate) deny();
    DWORD magic=0; if (!exactRead(&magic,4) || magic!=0x43525631) deny();
    rootPath=field(); mountPath=field(); auto owner=field(), unique=field(); jobName=field();
    DWORD count=0; if (!exactRead(&count,4) || count>1024) deny();
    for (DWORD i=0;i<count;i++) { auto d=field(); parts(d,true); deniedRoots.push_back(fold(d)); }
    if (jobName.find(L"Local\\crot-view-job-")!=0 || jobName.size()!=68 ||
        !ConvertStringSidToSidW(owner.c_str(),&ownerSid) || !ConvertStringSidToSidW(unique.c_str(),&uniqueSid) || EqualSid(ownerSid,uniqueSid)) deny();
    job.h=OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,jobName.c_str()); if (!job.valid()) deny(winerror());
    pinRoot();
    auto sddl=L"O:"+owner+L"D:P(A;;FA;;;"+owner+L")(A;;FA;;;SY)(A;;FA;;;"+unique+L")S:(ML;;NW;;;LW)";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),1,&projected,nullptr)) deny(winerror());
    DOKAN_OPTIONS options{}; options.Version=DOKAN_VERSION; options.Options=DOKAN_OPTION_CURRENT_SESSION;
    options.MountPoint=mountPath.c_str(); options.Timeout=15000; options.AllocationUnitSize=4096; options.SectorSize=512;
    options.VolumeSecurityDescriptorLength=GetSecurityDescriptorLength(projected);
    if (options.VolumeSecurityDescriptorLength>sizeof(options.VolumeSecurityDescriptor)) deny();
    memcpy(options.VolumeSecurityDescriptor,projected,options.VolumeSecurityDescriptorLength);
    DOKAN_OPERATIONS operations{};
    operations.ZwCreateFile=create; operations.Cleanup=cleanup; operations.CloseFile=closeFile;
    operations.ReadFile=readFile; operations.WriteFile=writeFile; operations.FlushFileBuffers=flush;
    operations.FindFiles=findFiles; operations.GetFileInformation=information; operations.DeleteFile=deleteFile; operations.DeleteDirectory=deleteFile;
    operations.MoveFile=renameFile; operations.SetEndOfFile=setEnd; operations.GetFileSecurity=security;
    operations.SetFileSecurity=setSecurity; operations.GetVolumeInformation=volume; operations.GetDiskFreeSpace=space;
    stopEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr); if (!stopEvent) deny();
    DokanInit(); initialized=true;
    const int mounted=DokanCreateFileSystem(&options,&operations,&instance);
    if (mounted!=DOKAN_SUCCESS) deny(static_cast<NTSTATUS>(mounted));
    // Config stdin is not an operation endpoint. Any byte, EOF, broken pipe or
    // callback fatal stops this exact owned mount. No mutation is replayed.
    input=std::thread([] { unsigned char b=0; DWORD n=0; ReadFile(GetStdHandle(STD_INPUT_HANDLE),&b,1,&n,nullptr); SetEvent(stopEvent); });
    if (failed) deny();
    const char marker[]="CROT_VIEW_READY\n"; DWORD written=0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),marker,sizeof(marker)-1,&written,nullptr) || written!=sizeof(marker)-1) deny();
    WaitForSingleObject(stopEvent,INFINITE); DokanCloseHandle(instance); instance=nullptr;
    joinInput(input);
    result=failed?2:0;
  } catch (const Error& e) { std::fprintf(stderr,"CROT_VIEW_ERROR:%08lx\n",static_cast<unsigned long>(e.status)); }
    catch (...) { std::fputs("CROT_VIEW_ERROR:internal\n",stderr); }
  if (instance) DokanCloseHandle(instance);
  joinInput(input);
  if (initialized) DokanShutdown();
  rootPins.clear(); root=INVALID_HANDLE_VALUE; release(job.h); job.h=INVALID_HANDLE_VALUE;
  if (!retryReleases() || failed) result=3;
  if (projected && LocalFree(projected)) result=3;
  if (ownerSid && LocalFree(ownerSid)) result=3;
  if (uniqueSid && LocalFree(uniqueSid)) result=3;
  if (stopEvent && !CloseHandle(stopEvent)) result=3;
  stopEvent=nullptr;
  return result;
}
