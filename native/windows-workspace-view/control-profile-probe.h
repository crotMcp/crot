// AD-28. Included inside the helper's private namespace after tokenInfo().
// This controller never grants package rights to the raw device or workspace.
DWORD controlProfileDiagnostic=0;
DWORD controlProfileNtStatus=0; // last fixed native prerequisite status, NTSTATUS or Win32 code
bool diagnoseControlProfiles=false;
struct ProfileOwner { std::wstring name; bool owned=false; bool settled=true; };
std::array<ProfileOwner,2> controlProfileOwners{};
bool retryControlProfileCleanup() {
  // Token/process close failures must be retried before profile deletion.
  { std::lock_guard<std::mutex> lock(releaseLock);
    for (const auto h:retained) if (h) return false;
  }
  bool okay=true;
  for (auto& owner:controlProfileOwners) if (owner.owned) {
    if (!owner.settled) { okay=false; continue; }
    bool removed=false;
    for (unsigned attempt=0;attempt<10;attempt++) {
      const HRESULT hr=DeleteAppContainerProfile(owner.name.c_str());
      if (hr==S_OK) { removed=true; break; }
      Sleep(25);
    }
    if (removed) { owner.owned=false; owner.name.clear(); }
    else okay=false; // exact name retained, no adoption or broad cleanup
  }
  return okay;
}
struct Attributes {
  std::vector<unsigned char> storage;
  PPROC_THREAD_ATTRIBUTE_LIST p=nullptr;
  explicit Attributes(DWORD count) {
    SIZE_T n=0; InitializeProcThreadAttributeList(nullptr,count,0,&n);
    if (!n || n>65536) deny();
    storage.resize(n); p=reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(p,count,0,&n)) { p=nullptr; deny(); }
  }
  ~Attributes() { if (p) DeleteProcThreadAttributeList(p); }
  bool set(DWORD_PTR key,void* value,SIZE_T size) {
    return !!UpdateProcThreadAttribute(p,0,key,value,size,nullptr,nullptr);
  }
};
bool ownedNativeControl(const std::wstring& device,ACCESS_MASK access) {
  UNICODE_STRING text{}; text.Buffer=const_cast<PWSTR>(device.c_str());
  text.Length=static_cast<USHORT>(device.size()*2); text.MaximumLength=text.Length;
  NativeAttributes a{}; a.Length=sizeof(a); a.ObjectName=&text; a.Attributes=0x40;
  NativeStatus io{}; Handle h;
  // Match CreateFile minimum metadata/non-directory semantics, without DOS lookup.
  const auto s=ntCreate(&h.h,access|FILE_READ_ATTRIBUTES|SYNCHRONIZE,&a,&io,nullptr,0,7,1,0x40,nullptr,0);
  if (s<0 || !h.valid()) controlProfileNtStatus=static_cast<DWORD>(s);
  return s>=0 && h.valid();
}
// 0..511: child entry/readback + four 2-bit results and NUL bit.
// 512+stage: no qualified entry, never an access-denial result.
DWORD oneControlProfile(const std::wstring& device,const std::wstring& source,
    const std::wstring& directory,const std::wstring& package,bool lpac) {
  DWORD outcome=0x201; PSID packageSid=nullptr; PSECURITY_DESCRIPTOR sd=nullptr;
  bool directoryOwned=false,fileOwned=false,jobSettled=true;
  const auto target=directory+L"\\control-profile-child.exe";
  Handle probeJob,process,thread;
  try {
    // Microsoft's public sequence provisions a NEW per-user profile first.
    // Never adopt an existing profile; reserve bookkeeping before OS mutation.
    outcome=0x20b;
    if (package.empty() || package.size()>64) deny();
    for (const auto& owner:controlProfileOwners) if (owner.owned) deny();
    auto& profile=controlProfileOwners[lpac?1:0]; profile.name=package;
    const HRESULT created=CreateAppContainerProfile(package.c_str(),L"CROT native control probe",
        L"Disposable zero-capability diagnostic",nullptr,0,&packageSid);
    if (created==S_OK) profile.owned=true;
    if (created!=S_OK || !packageSid) { controlProfileNtStatus=static_cast<DWORD>(created); deny(); }

    LPWSTR text=nullptr;
    outcome=0x20c;
    if (!ConvertSidToStringSidW(packageSid,&text)) deny();
    std::wstring sid;
    try { sid=text; } catch (...) { LocalFree(text); throw; }
    if (LocalFree(text)) deny();
    LPWSTR ownerText=nullptr;
    outcome=0x20d;
    if (!ConvertSidToStringSidW(ownerSid,&ownerText)) deny();
    std::wstring owner;
    try { owner=ownerText; } catch (...) { LocalFree(ownerText); throw; }
    if (LocalFree(ownerText)) deny();
    const auto sddl=L"D:P(A;OICI;FA;;;"+owner+L")(A;OICI;FA;;;SY)(A;OICI;GRGX;;;"+sid+L")";
    outcome=0x20e;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),1,&sd,nullptr)) deny();
    SECURITY_ATTRIBUTES sa{sizeof(sa),sd,FALSE};
    // Collision is failure, never adoption or rewriting an existing object.
    outcome=0x20f;
    if (!CreateDirectoryW(directory.c_str(),&sa)) deny(); directoryOwned=true;
    outcome=0x210;
    if (!CopyFileW(source.c_str(),target.c_str(),TRUE)) deny(); fileOwned=true;
    outcome=0x211;
    if (!SetFileSecurityW(target.c_str(),DACL_SECURITY_INFORMATION,sd)) deny();
    outcome=0x202;
    probeJob.h=CreateJobObjectW(nullptr,nullptr); if (!probeJob.valid()) deny();
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!SetInformationJobObject(probeJob.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)) ||
        !QueryInformationJobObject(probeJob.h,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr) ||
        accounting.ActiveProcesses || accounting.TotalProcesses) deny();
    SECURITY_CAPABILITIES caps{}; caps.AppContainerSid=packageSid;
    DWORD policy=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    Attributes attrs(lpac?3:2);
    if (!attrs.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps)) ||
        !attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST,&probeJob.h,sizeof(HANDLE)) ||
        (lpac && !attrs.set(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&policy,sizeof(policy)))) deny();
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup); startup.lpAttributeList=attrs.p;
    PROCESS_INFORMATION pi{};
    auto command=L"\""+target+L"\" \""+device+L"\" "+(lpac?L"1":L"0");
    outcome=0x203;
    if (!CreateProcessW(target.c_str(),command.data(),nullptr,nullptr,FALSE,
        CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,nullptr,directory.c_str(),&startup.StartupInfo,&pi)) {
      const DWORD error=GetLastError(); controlProfileNtStatus=error;
      switch (error) {
        case ERROR_ACCESS_DENIED: outcome=0x212; break;
        case ERROR_PRIVILEGE_NOT_HELD: outcome=0x213; break;
        case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: outcome=0x214; break;
        case ERROR_NOT_SUPPORTED: case ERROR_INVALID_PARAMETER: outcome=0x215; break;
        case ERROR_BAD_EXE_FORMAT: outcome=0x216; break;
        case ERROR_NOT_FOUND: outcome=0x217; break;
        default: outcome=0x218; break;
      }
      deny();
    }
    process.h=pi.hProcess; thread.h=pi.hThread; jobSettled=false;
    controlProfileOwners[lpac?1:0].settled=false;
    outcome=0x204;
    BOOL member=FALSE; Handle token;
    if (!IsProcessInJob(process.h,probeJob.h,&member) || !member ||
        !OpenProcessToken(process.h,TOKEN_QUERY,&token.h)) deny();
    auto ac=tokenInfo(token.h,TokenIsAppContainer), ps=tokenInfo(token.h,TokenAppContainerSid),
        capabilities=tokenInfo(token.h,TokenCapabilities), il=tokenInfo(token.h,TokenIntegrityLevel),
        less=tokenInfo(token.h,static_cast<TOKEN_INFORMATION_CLASS>(46));
    auto label=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
    auto actualSid=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(ps.data())->TokenAppContainer;
    if (*reinterpret_cast<DWORD*>(ac.data())!=1 || !actualSid || !IsValidSid(actualSid) ||
        !EqualSid(actualSid,packageSid) || reinterpret_cast<TOKEN_GROUPS*>(capabilities.data())->GroupCount ||
        !IsValidSid(label) || *GetSidSubAuthorityCount(label)!=1 || *GetSidSubAuthority(label,0)!=4096 ||
        !!*reinterpret_cast<DWORD*>(less.data())!=lpac) deny();
    outcome=0x205;
    if (ResumeThread(thread.h)!=1) deny();
    outcome=0x206;
    if (WaitForSingleObject(process.h,3000)!=WAIT_OBJECT_0) deny();
    DWORD exit=0; outcome=0x207;
    if (!GetExitCodeProcess(process.h,&exit)) deny();
    if ((exit&0xfffffe00u)!=0x43520000u) {
      // Differentiate common loader failure from failed child protocol.
      outcome=exit==0xc0000142u?0x208:0x209; deny();
    }
    outcome=exit&0x1ff;
  } catch (...) { /* fixed bounded stage only; never native message/path */ }
  if (process.valid()) {
    if (!TerminateJobObject(probeJob.h,1) || WaitForSingleObject(process.h,3000)!=WAIT_OBJECT_0) jobSettled=false;
    else {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a{};
      jobSettled=!!QueryInformationJobObject(probeJob.h,JobObjectBasicAccountingInformation,&a,sizeof(a),nullptr) && !a.ActiveProcesses;
    }
  }
  controlProfileOwners[lpac?1:0].settled=jobSettled;
  // Retain failed handle ownership in the existing helper registry. A failed
  // cleanup cannot produce qualified profile evidence or new allocations.
  release(thread.h); thread.h=INVALID_HANDLE_VALUE;
  release(process.h); process.h=INVALID_HANDLE_VALUE;
  release(probeJob.h); probeJob.h=INVALID_HANDLE_VALUE;
  bool clean=jobSettled && !failed;
  if (fileOwned && jobSettled && !DeleteFileW(target.c_str())) clean=false;
  if (directoryOwned && jobSettled && !RemoveDirectoryW(directory.c_str())) clean=false;
  if (sd && LocalFree(sd)) clean=false;
  if (packageSid && FreeSid(packageSid)!=nullptr) clean=false;
  if (!retryControlProfileCleanup()) clean=false;
  if (!clean) { fault(); return 0x20a; }
  return outcome;
}
DWORD probeControlProfiles(const std::wstring& device) {
  try {
    if (!retryControlProfileCleanup()) return 0xa5c00000u;
    // Positive controls precede untrusted identities. Check both namespaces and
    // both access masks; an absent endpoint is not a denial result.
    const auto raw=L"\\\\?\\GLOBALROOT"+device;
    for (ACCESS_MASK access:{ACCESS_MASK(0),ACCESS_MASK(GENERIC_READ)}) {
      Handle h(CreateFileW(raw.c_str(),access,7,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr));
      if (!h.valid()) return access?0xa5d00003u:0xa5d00001u;
      if (!ownedNativeControl(device,access)) return access?0xa5d00004u:0xa5d00002u;
    }
    wchar_t exe[32768]{};
    const DWORD n=GetModuleFileNameW(nullptr,exe,32768);
    if (!n || n>=32768) return 0xa5d00005u;
    std::wstring binary(exe,n); auto separator=binary.find_last_of(L"\\/");
    if (separator==std::wstring::npos || binary.find(L'"')!=std::wstring::npos) return 0xa5d00006u;
    const auto source=binary.substr(0,separator)+L"\\control-profile-child.exe";
    const auto nonce=mountPath.substr(mountPath.find_last_of(L"\\")+1);
    if (nonce.size()!=53 || nonce.compare(0,5,L"view-") || nonce.find_first_not_of(L"0123456789abcdef",5)!=std::wstring::npos)
      return 0xa5d00007u;
    // The trusted fixture owns this existing parent and retries recursive
    // cleanup only after the exact helper exits. Its environment TEMP may be
    // a not-yet-created layout path; never assume GetTempPath creates it.
    const auto base=binary.substr(0,separator)+L"\\crot-control-"+nonce;
    // Keep every derived name below the public profile-name 64-character bound.
    const auto package=L"crot.cp."+nonce.substr(5);
    const DWORD ac=oneControlProfile(device,source,base+L"-ac",package+L".ac",false);
    if (failed || ac==0x20a) return 0xa5c00000u;
    const DWORD lpac=oneControlProfile(device,source,base+L"-lpac",package+L".lpac",true);
    if (failed || lpac==0x20a) return 0xa5c00000u;
    return 0xa5b00000u|ac|(lpac<<10);
  } catch (...) { return 0xa5d00008u; }
}
