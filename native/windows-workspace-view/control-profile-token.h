// AD-28: OS-only, in-memory effective LPAC check. No real object ACL is changed.
#pragma once
namespace crot_control {
inline bool effectiveLpac(HANDLE token,ULONG& less,DWORD& error) {
  error=0; less=0;
  HANDLE copy=nullptr;
  if (!DuplicateTokenEx(token,TOKEN_QUERY,nullptr,SecurityImpersonation,TokenImpersonation,&copy)) {
    error=GetLastError(); return false;
  }
  bool okay=false;
  const auto information=[&](TOKEN_INFORMATION_CLASS type,std::vector<unsigned char>& data) {
    DWORD n=0; GetTokenInformation(copy,type,nullptr,0,&n);
    if (n<4 || n>65536) return false;
    data.resize(n); return !!GetTokenInformation(copy,type,data.data(),n,&n);
  };
  std::vector<unsigned char> user,package;
  if (information(TokenUser,user) && information(TokenAppContainerSid,package)) {
    const PSID u=reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    const PSID p=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(package.data())->TokenAppContainer;
    LPWSTR us=nullptr,ps=nullptr;
    if (u && p && IsValidSid(u) && IsValidSid(p) && ConvertSidToStringSidW(u,&us) && ConvertSidToStringSidW(p,&ps)) {
      const std::wstring base=L"O:"+std::wstring(us)+L"G:"+std::wstring(us)+L"D:P(A;;0x1;;;"+std::wstring(us)+L")";
      const auto check=[&](const std::wstring& descriptor,bool& allowed) {
        PSECURITY_DESCRIPTOR sd=nullptr;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.c_str(),SDDL_REVISION_1,&sd,nullptr)) return false;
        GENERIC_MAPPING mapping{1,1,1,1};
        // Fixed desired bit has no token privilege override. Buffer remains bounded.
        alignas(PRIVILEGE_SET) unsigned char privileges[4096]{};
        DWORD bytes=sizeof(privileges),granted=0; BOOL status=FALSE;
        const BOOL ran=AccessCheck(sd,copy,1,&mapping,reinterpret_cast<PRIVILEGE_SET*>(privileges),&bytes,&granted,&status);
        const DWORD saved=ran?0:GetLastError();
        const bool freed=LocalFree(sd)==nullptr;
        if (!ran || !freed) { error=saved?saved:ERROR_INVALID_DATA; return false; }
        allowed=status && (granted&1)==1; return true;
      };
      bool userOnly=false,exact=false,all=false,restricted=false;
      okay=check(base,userOnly) && !userOnly &&
          check(base+L"(A;;0x1;;;"+std::wstring(ps)+L")",exact) && exact &&
          check(base+L"(A;;0x1;;;S-1-15-2-1)",all) &&
          check(base+L"(A;;0x1;;;S-1-15-2-2)",restricted);
      if (okay) { less=all?0u:1u; okay=all || restricted; }
    }
    if (ps && LocalFree(ps)!=nullptr) okay=false;
    if (us && LocalFree(us)!=nullptr) okay=false;
  }
  if (!okay && !error) error=ERROR_INVALID_DATA;
  if (!CloseHandle(copy)) { error=GetLastError(); okay=false; }
  return okay;
}
}
