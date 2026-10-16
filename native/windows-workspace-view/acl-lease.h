// AD-29 curator refinement. Qualification only: no production crash journal.
// Handles stay pinned without DELETE sharing, reparse objects are rejected; shared ancestor updates
// MUST NOT propagate existing inheritable ACEs into unrelated child trees.
const char* aclStep="none";DWORD aclError=0;unsigned ancestorIndex=0;
void aclResult(DWORD result){if(result!=ERROR_SUCCESS){aclError=result;SetLastError(result);need(false);}}
struct PinnedAcl {
 Handle object;std::wstring path;PSID sid;std::vector<BYTE> original,expected;bool installed=false;
 PinnedAcl(const std::wstring& p,PSID s):path(p),sid(s){
  aclStep="open-pinned";object.h=CreateFileW(p.c_str(),READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(object.h==INVALID_HANDLE_VALUE){aclError=GetLastError();need(false);}BY_HANDLE_FILE_INFORMATION info{};need(!!GetFileInformationByHandle(object.h,&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));original=descriptor();
 }
 std::vector<BYTE> descriptor(){PSECURITY_DESCRIPTOR value=nullptr;aclStep="query-descriptor";DWORD result=GetSecurityInfo(object.h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&value);aclResult(result);need(value!=nullptr);DWORD size=GetSecurityDescriptorLength(value);std::vector<BYTE>b(size);memcpy(b.data(),value,size);LocalFree(value);return b;}
 static PACL acl(std::vector<BYTE>& b){BOOL present=FALSE,def=FALSE;PACL a=nullptr;need(!!GetSecurityDescriptorDacl(b.data(),&present,&a,&def)&&present&&a);return a;}
 static SECURITY_DESCRIPTOR_CONTROL control(std::vector<BYTE>& b){SECURITY_DESCRIPTOR_CONTROL c=0;DWORD rev=0;need(!!GetSecurityDescriptorControl(b.data(),&c,&rev));return c;}
 void set(PACL a,SECURITY_DESCRIPTOR_CONTROL c){
  // SetFileSecurity is obsolete but documented NOT to propagate to children.
  // MAXIMUM_ALLOWED cannot open a busy volume root (DELETE sharing conflict).
  // Use only READ_CONTROL/WRITE_DAC/READ_ATTRIBUTES, and pin against rename.
  need(a!=nullptr);SECURITY_DESCRIPTOR sd{};need(!!InitializeSecurityDescriptor(&sd,SECURITY_DESCRIPTOR_REVISION));
  need(!!SetSecurityDescriptorDacl(&sd,TRUE,a,(c&SE_DACL_DEFAULTED)!=0));
  constexpr WORD flags=SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  need(!!SetSecurityDescriptorControl(&sd,flags,c&flags));aclStep="set-nonpropagating-file-acl";
  SECURITY_INFORMATION bits=DACL_SECURITY_INFORMATION|((c&SE_DACL_PROTECTED)?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION);
  if(!SetFileSecurityW(path.c_str(),bits,&sd)){aclError=GetLastError();need(false);}
 }
 void set(PACL a){set(a,control(original));}
 static bool equal(PACL a,PACL b,bool inheritedDifference=false){
  if(a->AceCount!=b->AceCount||a->AclRevision!=b->AclRevision)return false;
  for(DWORD i=0;i<a->AceCount;i++){void *x=nullptr,*y=nullptr;need(!!GetAce(a,i,&x)&&!!GetAce(b,i,&y));auto hx=static_cast<ACE_HEADER*>(x),hy=static_cast<ACE_HEADER*>(y);if(hx->AceSize!=hy->AceSize||hx->AceType!=hy->AceType)return false;BYTE ignore=inheritedDifference?INHERITED_ACE:0;if((hx->AceFlags&~ignore)!=(hy->AceFlags&~ignore)||memcmp(static_cast<BYTE*>(x)+sizeof(ACE_HEADER),static_cast<BYTE*>(y)+sizeof(ACE_HEADER),hx->AceSize-sizeof(ACE_HEADER)))return false;}return true;
 }
 bool owns(void* value){auto h=static_cast<ACE_HEADER*>(value);if(h->AceType!=ACCESS_ALLOWED_ACE_TYPE&&h->AceType!=ACCESS_DENIED_ACE_TYPE)return false;auto a=static_cast<ACCESS_ALLOWED_ACE*>(value);return !!EqualSid(&a->SidStart,sid);}
 std::vector<BYTE> withoutOwned(PACL a){std::vector<BYTE>b(a->AclSize);auto next=reinterpret_cast<PACL>(b.data());need(!!InitializeAcl(next,a->AclSize,a->AclRevision));for(DWORD i=0;i<a->AceCount;i++){void* e=nullptr;need(!!GetAce(a,i,&e));if(!owns(e))need(!!AddAce(next,a->AclRevision,MAXDWORD,e,static_cast<ACE_HEADER*>(e)->AceSize));}return b;}
 void add(DWORD rights,bool deny=false){
  auto now=descriptor();PACL next=nullptr;EXPLICIT_ACCESSW a{};a.grfAccessPermissions=rights;a.grfAccessMode=deny?DENY_ACCESS:GRANT_ACCESS;a.grfInheritance=NO_INHERITANCE;a.Trustee.TrusteeForm=TRUSTEE_IS_SID;a.Trustee.TrusteeType=TRUSTEE_IS_UNKNOWN;a.Trustee.ptstrName=static_cast<LPWSTR>(sid);
  aclStep="compose-acl";aclResult(SetEntriesInAclW(1,&a,acl(now),&next));need(next!=nullptr);installed=true;
  try{set(next,control(now));}catch(...){LocalFree(next);throw;}LocalFree(next);
  auto readback=descriptor();PACL actual=acl(readback);aclStep="verify-owned-ace";bool found=false;for(DWORD i=0;i<actual->AceCount;i++){void* e=nullptr;need(!!GetAce(actual,i,&e));if(owns(e)){auto h=static_cast<ACE_HEADER*>(e);auto ace=static_cast<ACCESS_ALLOWED_ACE*>(e);if(h->AceType==(deny?ACCESS_DENIED_ACE_TYPE:ACCESS_ALLOWED_ACE_TYPE)&&h->AceFlags==0&&ace->Mask==rights)found=true;}}if(!found){aclError=ERROR_INVALID_DATA;SetLastError(aclError);need(false);}
  auto foreign=withoutOwned(actual);need(equal(reinterpret_cast<PACL>(foreign.data()),acl(original),true));expected=std::move(readback);
 }
 // Remove fresh-SID entries from CURRENT ACL, then compare every other entry.
 // Never return an old snapshot over changed user permissions.
 bool remove(){if(!installed)return true;try{
  auto now=descriptor();PACL a=acl(now);std::vector<BYTE>b(a->AclSize);auto next=reinterpret_cast<PACL>(b.data());need(!!InitializeAcl(next,a->AclSize,a->AclRevision));
  for(DWORD i=0;i<a->AceCount;i++){void* e=nullptr;need(!!GetAce(a,i,&e));if(!owns(e))need(!!AddAce(next,a->AclRevision,MAXDWORD,e,static_cast<ACE_HEADER*>(e)->AceSize));}
  need(!expected.empty());auto foreign=withoutOwned(acl(expected));
  need(equal(next,reinterpret_cast<PACL>(foreign.data())));
  constexpr WORD controlled=SE_DACL_PRESENT|SE_DACL_DEFAULTED|SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  need((control(now)&controlled)==(control(expected)&controlled));
  set(acl(original));auto after=descriptor();need(equal(acl(after),acl(original)));
  constexpr WORD bits=SE_DACL_PRESENT|SE_DACL_DEFAULTED|SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  need((control(after)&bits)==(control(original)&bits));installed=false;return true;
 }catch(...){return false;}}
 ~PinnedAcl(){remove();}
};
std::vector<std::wstring> ancestors(std::wstring root){std::vector<std::wstring> result;while(root.size()>3){size_t slash=root.find_last_of(L'\\');need(slash!=root.npos);root=root.substr(0,slash<3?3:slash);result.push_back(root);need(result.size()<=64);}std::reverse(result.begin(),result.end());return result;}
struct LinkedFile {
 std::unique_ptr<PinnedAcl> lease;DWORD volume=0,high=0,low=0;bool denied=false;
};
void scanLinks(const std::wstring& directory,PSID sid,std::vector<LinkedFile>& linked,unsigned depth=0){
 need(depth<=64);WIN32_FIND_DATAW entry{};HANDLE search=FindFirstFileW((directory+L"\\*").c_str(),&entry);if(search==INVALID_HANDLE_VALUE){need(GetLastError()==ERROR_FILE_NOT_FOUND);return;}
 try{do{std::wstring name=entry.cFileName;if(name==L"."||name==L"..")continue;need(!(entry.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));std::wstring p=directory+L"\\"+name;
  if(entry.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY){scanLinks(p,sid,linked,depth+1);continue;}
  auto lease=std::make_unique<PinnedAcl>(p,sid);BY_HANDLE_FILE_INFORMATION info{};need(!!GetFileInformationByHandle(lease->object.h,&info));if(info.nNumberOfLinks<=1)continue;
  bool known=false;for(const auto& f:linked)if(f.volume==info.dwVolumeSerialNumber&&f.high==info.nFileIndexHigh&&f.low==info.nFileIndexLow)known=true;
  if(!known){need(linked.size()<10000);linked.push_back({std::move(lease),info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow,false});}
 }while(FindNextFileW(search,&entry));need(GetLastError()==ERROR_NO_MORE_FILES);}catch(...){FindClose(search);throw;}need(!!FindClose(search));
}
bool hasExternalName(const std::wstring& root,const std::wstring& file){
 need(root.size()>3&&root[1]==L':');std::wstring prefix=root.substr(2);std::vector<wchar_t> buffer(32768);DWORD n=static_cast<DWORD>(buffer.size());HANDLE search=FindFirstFileNameW(file.c_str(),0,&n,buffer.data());need(search!=INVALID_HANDLE_VALUE);bool outside=false;unsigned count=0;
 try{for(;;){need(++count<=10000);std::wstring name=buffer.data();bool inside=name.size()>prefix.size()&&name[prefix.size()]==L'\\'&&CompareStringOrdinal(name.data(),static_cast<int>(prefix.size()),prefix.data(),static_cast<int>(prefix.size()),TRUE)==CSTR_EQUAL;outside=outside||!inside;n=static_cast<DWORD>(buffer.size());if(!FindNextFileNameW(search,&n,buffer.data())){need(GetLastError()==ERROR_HANDLE_EOF);break;}}}catch(...){FindClose(search);throw;}need(!!FindClose(search));return outside;
}
