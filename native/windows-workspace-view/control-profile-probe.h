// AD-28. Included inside the helper's private namespace after tokenInfo().
// This controller never grants package rights to the raw device or workspace.
DWORD controlProfileDiagnostic=0;
bool diagnoseControlProfiles=false;
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
  const auto s=ntCreate(&h.h,access,&a,&io,nullptr,0,7,1,0,nullptr,0);
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
    // Public API; no profile/registry registration or persistent identity.
    if (FAILED(DeriveAppContainerSidFromAppContainerName(package.c_str(),&packageSid)) || !packageSid) deny();
    LPWSTR text=nullptr;
    if (!ConvertSidToStringSidW(packageSid,&text)) deny();
    std::wstring sid;
    try { sid=text; } catch (...) { LocalFree(text); throw; }
    if (LocalFree(text)) deny();
    LPWSTR ownerText=nullptr;
    if (!ConvertSidToStringSidW(ownerSid,&ownerText)) deny();
    std::wstring owner;
    try { owner=ownerText; } catch (...) { LocalFree(ownerText); throw; }
    if (LocalFree(ownerText)) deny();
    const auto sddl=L"D:P(A;OICI;FA;;;"+owner+L")(A;OICI;FA;;;SY)(A;OICI;GRGX;;;"+sid+L")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),1,&sd,nullptr)) deny();
    SECURITY_ATTRIBUTES sa{sizeof(sa),sd,FALSE};
    // Collision is failure, never adoption or rewriting an existing object.
    if (!CreateDirectoryW(directory.c_str(),&sa)) deny(); directoryOwned=true;
    if (!CopyFileW(source.c_str(),target.c_str(),TRUE)) deny(); fileOwned=true;
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
        CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,nullptr,directory.c_str(),&startup.StartupInfo,&pi)) deny();
    process.h=pi.hProcess; thread.h=pi.hThread; jobSettled=false;
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
  if (!clean) { fault(); return 0x20a; }
  return outcome;
}
DWORD probeControlProfiles(const std::wstring& device) {
  try {
    // Positive controls precede untrusted identities. Check both namespaces and
    // both access masks; an absent endpoint is not a denial result.
    const auto raw=L"\\\\?\\GLOBALROOT"+device;
    for (ACCESS_MASK access:{ACCESS_MASK(0),ACCESS_MASK(GENERIC_READ)}) {
      Handle h(CreateFileW(raw.c_str(),access,7,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr));
      if (!h.valid() || !ownedNativeControl(device,access)) return 0xa5d00000u;
    }
    wchar_t exe[32768]{};
    const DWORD n=GetModuleFileNameW(nullptr,exe,32768);
    if (!n || n>=32768) return 0xa5d00000u;
    std::wstring binary(exe,n); auto separator=binary.find_last_of(L"\\/");
    if (separator==std::wstring::npos || binary.find(L'"')!=std::wstring::npos) return 0xa5d00000u;
    const auto source=binary.substr(0,separator)+L"\\control-profile-child.exe";
    const auto nonce=mountPath.substr(mountPath.find_last_of(L"\\")+1);
    if (nonce.size()!=53 || nonce.compare(0,5,L"view-") || nonce.find_first_not_of(L"0123456789abcdef",5)!=std::wstring::npos)
      return 0xa5d00000u;
    // The trusted fixture owns this existing parent and retries recursive
    // cleanup only after the exact helper exits. Its environment TEMP may be
    // a not-yet-created layout path; never assume GetTempPath creates it.
    const auto base=binary.substr(0,separator)+L"\\crot-control-"+nonce;
    const DWORD ac=oneControlProfile(device,source,base+L"-ac",L"crot.control."+nonce+L".ac",false);
    if (failed || ac==0x20a) return 0xa5c00000u;
    const DWORD lpac=oneControlProfile(device,source,base+L"-lpac",L"crot.control."+nonce+L".lpac",true);
    if (failed || lpac==0x20a) return 0xa5c00000u;
    return 0xa5b00000u|ac|(lpac<<10);
  } catch (...) { return 0xa5d00000u; }
}
