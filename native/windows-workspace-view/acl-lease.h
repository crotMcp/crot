// AD-29 curator refinement. Qualification only: no production crash journal.
// Root/ancestor/protected/link handles stay pinned without DELETE sharing.
// Only qualified ordinary existing workspace nodes may opt into rename sharing.
// Reparse objects are rejected; shared ancestor updates
// MUST NOT propagate existing inheritable ACEs into unrelated child trees.
const char* aclStep="none";DWORD aclError=0;unsigned ancestorIndex=0;
void aclResult(DWORD result){if(result!=ERROR_SUCCESS){aclError=result;SetLastError(result);need(false);}}
struct PinnedAcl {
 Handle object,renameGuard;HANDLE volumeHint=nullptr;BY_HANDLE_FILE_INFORMATION identity{};bool renameAllowed=false,reopenedById=false;std::wstring path;PSID sid;std::vector<BYTE> original,expected;bool installed=false;const char* restoreError="none";
 PinnedAcl(const std::wstring& p,PSID s,bool allowRename=false):renameAllowed(allowRename),path(p),sid(s){
  // Capture before opening a mutation handle. Compare the same requested
  // sections as the independent owner snapshot, never only a DACL projection.
  PSECURITY_DESCRIPTOR initial=nullptr;aclResult(GetNamedSecurityInfoW(p.c_str(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&initial));need(initial!=nullptr);original.resize(GetSecurityDescriptorLength(initial));memcpy(original.data(),initial,original.size());LocalFree(initial);
  aclStep="open-pinned";object.h=CreateFileW(p.c_str(),READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|(allowRename?FILE_SHARE_DELETE:0),nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(object.h==INVALID_HANDLE_VALUE){aclError=GetLastError();need(false);}BY_HANDLE_FILE_INFORMATION info{};need(!!GetFileInformationByHandle(object.h,&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
  // Multi-link objects retain their separate non-renamable protection lease.
  identity=info;
  if(allowRename)need(info.nNumberOfLinks<=1);
  else {
   // Metadata-only opens (READ_CONTROL/WRITE_DAC/READ_ATTRIBUTES) do NOT
   // participate in the I/O manager's data/delete share-access accounting.
   // A separate read/list handle makes the no-DELETE-share guard effective;
   // no bytes are read and no ACL/label is broadened by this owner handle.
   renameGuard.h=CreateFileW(p.c_str(),FILE_READ_DATA|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
   need(renameGuard.h!=INVALID_HANDLE_VALUE);
   BY_HANDLE_FILE_INFORMATION guardInfo{};need(!!GetFileInformationByHandle(renameGuard.h,&guardInfo));
   need(guardInfo.dwVolumeSerialNumber==info.dwVolumeSerialNumber&&guardInfo.nFileIndexHigh==info.nFileIndexHigh&&guardInfo.nFileIndexLow==info.nFileIndexLow);
  }
 }
 // Only after all hardlink names have been verified INTERNAL before actors.
 // External links, roots, ancestors and protected files never call this.
 void releaseInternalRenameGuard(){if(renameGuard.h&&renameGuard.h!=INVALID_HANDLE_VALUE){need(!!CloseHandle(renameGuard.h));renameGuard.h=nullptr;}}
 // NTFS blocks renaming a directory with ANY open descendant file, even if
 // all opens specify DELETE sharing (qualified by the isolated owner controls).
 // Ordinary single-link files therefore keep their snapshot + NTFS file ID,
 // not a live file handle during actors. Protected objects never use this path.
 void releaseOrdinaryFileForActors(HANDLE hint){
  need(renameAllowed&&!(identity.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&identity.nNumberOfLinks==1&&installed&&!expected.empty());
  need(!renameGuard.h&&hint&&hint!=INVALID_HANDLE_VALUE&&object.h&&object.h!=INVALID_HANDLE_VALUE);
  volumeHint=hint;need(!!CloseHandle(object.h));object.h=nullptr;
 }
 void ensureObject(){
  if(object.h&&object.h!=INVALID_HANDLE_VALUE)return;
  need(renameAllowed&&volumeHint&&volumeHint!=INVALID_HANDLE_VALUE);
  FILE_ID_DESCRIPTOR id{};id.dwSize=sizeof(id);id.Type=FileIdType;
  id.FileId.QuadPart=(static_cast<ULONGLONG>(identity.nFileIndexHigh)<<32)|identity.nFileIndexLow;
  // No name lookup or following a replacement at the old pathname.
  Handle candidate;candidate.h=OpenFileById(volumeHint,&id,READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT);
  need(candidate.h!=INVALID_HANDLE_VALUE);BY_HANDLE_FILE_INFORMATION now{};need(!!GetFileInformationByHandle(candidate.h,&now));
  need(now.dwVolumeSerialNumber==identity.dwVolumeSerialNumber&&now.nFileIndexHigh==identity.nFileIndexHigh&&now.nFileIndexLow==identity.nFileIndexLow);
  need(!(now.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)));
  // A missing/deleted/reused identity fails cleanup; never fall back to a path.
  need(now.ftCreationTime.dwHighDateTime==identity.ftCreationTime.dwHighDateTime&&now.ftCreationTime.dwLowDateTime==identity.ftCreationTime.dwLowDateTime);
  object.h=candidate.h;candidate.h=nullptr;reopenedById=true;
 }
 std::vector<BYTE> descriptor(){ensureObject();PSECURITY_DESCRIPTOR value=nullptr;aclStep="query-descriptor";DWORD result=GetSecurityInfo(object.h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&value);aclResult(result);need(value!=nullptr);DWORD size=GetSecurityDescriptorLength(value);std::vector<BYTE>b(size);memcpy(b.data(),value,size);LocalFree(value);return b;}
 static PACL acl(std::vector<BYTE>& b){BOOL present=FALSE,def=FALSE;PACL a=nullptr;need(!!GetSecurityDescriptorDacl(b.data(),&present,&a,&def)&&present&&a);return a;}
 static SECURITY_DESCRIPTOR_CONTROL control(std::vector<BYTE>& b){SECURITY_DESCRIPTOR_CONTROL c=0;DWORD rev=0;need(!!GetSecurityDescriptorControl(b.data(),&c,&rev));return c;}
 void set(PACL a,SECURITY_DESCRIPTOR_CONTROL c){
  // Direct object-handle writes avoid Win32 tree inheritance propagation.
  // MAXIMUM_ALLOWED cannot open a busy volume root (DELETE sharing conflict).
  // Use only READ_CONTROL/WRITE_DAC/READ_ATTRIBUTES, and pin against rename.
  need(a!=nullptr);SECURITY_DESCRIPTOR sd{};need(!!InitializeSecurityDescriptor(&sd,SECURITY_DESCRIPTOR_REVISION));
  need(!!SetSecurityDescriptorDacl(&sd,TRUE,a,(c&SE_DACL_DEFAULTED)!=0));
  constexpr WORD flags=SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  need(!!SetSecurityDescriptorControl(&sd,flags,c&flags));aclStep="set-nonpropagating-file-acl";
  auto existing=descriptor();SECURITY_INFORMATION bits=DACL_SECURITY_INFORMATION;
  if((control(existing)&SE_DACL_PROTECTED)!=(c&SE_DACL_PROTECTED))bits|=(c&SE_DACL_PROTECTED)?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION;
  if(c&SE_DACL_AUTO_INHERITED)need(!!SetSecurityDescriptorControl(&sd,SE_DACL_AUTO_INHERIT_REQ,SE_DACL_AUTO_INHERIT_REQ));
  if(!SetKernelObjectSecurity(object.h,bits,&sd)){aclError=GetLastError();need(false);}
 }
 void set(PACL a){set(a,control(original));}
 void restore(std::vector<BYTE>& snapshot){
  aclStep="restore-raw-dacl-control";auto c=control(snapshot);
  // The input request bit asks NT to preserve AUTO_INHERITED; it is not
  // accepted as proof. Readback must still match every original control bit.
  SECURITY_DESCRIPTOR sd{};need(!!InitializeSecurityDescriptor(&sd,SECURITY_DESCRIPTOR_REVISION));
  need(!!SetSecurityDescriptorDacl(&sd,TRUE,acl(snapshot),(c&SE_DACL_DEFAULTED)!=0));
  constexpr WORD controls=SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  WORD requested=c&controls;if(c&SE_DACL_AUTO_INHERITED)requested|=SE_DACL_AUTO_INHERIT_REQ;
  need(!!SetSecurityDescriptorControl(&sd,controls,requested));
  auto now=descriptor();SECURITY_INFORMATION flags=DACL_SECURITY_INFORMATION;
  if((control(now)&SE_DACL_PROTECTED)!=(c&SE_DACL_PROTECTED))
   flags|=(c&SE_DACL_PROTECTED)?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION;
  if(!SetKernelObjectSecurity(object.h,flags,&sd)){aclError=GetLastError();need(false);}
 }
 static bool rawEqual(PACL a,PACL b){return a->AclSize==b->AclSize&&memcmp(a,b,a->AclSize)==0;}
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
 void protectLinkedReadOnly(DWORD denyMask){
  auto now=descriptor();auto foreign=withoutOwned(acl(now));auto base=reinterpret_cast<PACL>(foreign.data());need(equal(base,acl(original),true));
  EXPLICIT_ACCESSW entries[2]{};for(auto& a:entries){a.grfInheritance=NO_INHERITANCE;a.Trustee.TrusteeForm=TRUSTEE_IS_SID;a.Trustee.TrusteeType=TRUSTEE_IS_UNKNOWN;a.Trustee.ptstrName=static_cast<LPWSTR>(sid);}
  entries[0].grfAccessPermissions=denyMask;entries[0].grfAccessMode=DENY_ACCESS;
  entries[1].grfAccessPermissions=FILE_GENERIC_READ|FILE_GENERIC_EXECUTE;entries[1].grfAccessMode=GRANT_ACCESS;
  PACL next=nullptr;aclResult(SetEntriesInAclW(2,entries,base,&next));need(next!=nullptr);installed=true;
  try{set(next,control(now)|SE_DACL_PROTECTED);}catch(...){LocalFree(next);throw;}LocalFree(next);
  auto readback=descriptor();PACL actual=acl(readback);bool read=false,deny=false;
  for(DWORD i=0;i<actual->AceCount;i++){void* e=nullptr;need(!!GetAce(actual,i,&e));if(!owns(e))continue;auto h=static_cast<ACE_HEADER*>(e);auto a=static_cast<ACCESS_ALLOWED_ACE*>(e);need(h->AceFlags==0);if(h->AceType==ACCESS_ALLOWED_ACE_TYPE){need(a->Mask==(FILE_GENERIC_READ|FILE_GENERIC_EXECUTE));read=true;}else{need(a->Mask==denyMask);deny=true;}}
  need(read&&deny&&(control(readback)&SE_DACL_PROTECTED));auto afterForeign=withoutOwned(actual);need(equal(reinterpret_cast<PACL>(afterForeign.data()),base,true));expected=std::move(readback);
 }
 // Remove fresh-SID entries from CURRENT ACL, then compare every other entry.
 // Never return an old snapshot over changed user permissions.
 bool remove(){if(!installed)return true;try{
  auto now=descriptor();PACL a=acl(now);std::vector<BYTE>b(a->AclSize);auto next=reinterpret_cast<PACL>(b.data());need(!!InitializeAcl(next,a->AclSize,a->AclRevision));
  for(DWORD i=0;i<a->AceCount;i++){void* e=nullptr;need(!!GetAce(a,i,&e));if(!owns(e))need(!!AddAce(next,a->AclRevision,MAXDWORD,e,static_cast<ACE_HEADER*>(e)->AceSize));}
  restoreError="missing-installed-snapshot";need(!expected.empty());auto foreign=withoutOwned(acl(expected));
  restoreError="foreign-acl-changed";need(equal(next,reinterpret_cast<PACL>(foreign.data())));
  constexpr WORD controlled=SE_DACL_PRESENT|SE_DACL_DEFAULTED|SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  restoreError="foreign-control-changed";need((control(now)&controlled)==(control(expected)&controlled));
  restoreError="native-restore-failed";restore(original);auto after=descriptor();restoreError="restored-acl-mismatch";need(rawEqual(acl(after),acl(original)));
  constexpr WORD bits=SE_DACL_PRESENT|SE_DACL_DEFAULTED|SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_AUTO_INHERIT_REQ;
  restoreError="restored-control-mismatch";need((control(after)&bits)==(control(original)&bits));installed=false;restoreError="none";return true;
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
// Compare filesystem object identity, not folded path strings. This respects
// both ordinary case-insensitive lookup and per-directory case sensitivity.
bool hasExternalName(const std::wstring& root,const std::wstring& file){
 need(root.size()>3&&root[1]==L':');
 Handle rootHandle;rootHandle.h=CreateFileW(root.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
 BY_HANDLE_FILE_INFORMATION rootInfo{};need(rootHandle.h!=INVALID_HANDLE_VALUE&&!!GetFileInformationByHandle(rootHandle.h,&rootInfo));
 unsigned components=1;for(size_t i=3;i<root.size();i++)if(root[i]==L'\\')++components;
 std::vector<wchar_t> buffer(32768);DWORD n=static_cast<DWORD>(buffer.size());HANDLE search=FindFirstFileNameW(file.c_str(),0,&n,buffer.data());need(search!=INVALID_HANDLE_VALUE);bool outside=false;unsigned count=0;
 try{for(;;){need(++count<=10000);std::wstring name=buffer.data();size_t boundary=0;
  for(unsigned i=0;i<components;i++){boundary=name.find(L'\\',boundary+1);if(boundary==name.npos)break;}
  bool inside=false;
  if(boundary!=name.npos){std::wstring candidate=root.substr(0,2)+name.substr(0,boundary);Handle h;h.h=CreateFileW(candidate.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);BY_HANDLE_FILE_INFORMATION info{};
   need(h.h!=INVALID_HANDLE_VALUE&&!!GetFileInformationByHandle(h.h,&info));inside=!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&info.dwVolumeSerialNumber==rootInfo.dwVolumeSerialNumber&&info.nFileIndexHigh==rootInfo.nFileIndexHigh&&info.nFileIndexLow==rootInfo.nFileIndexLow;}
  outside=outside||!inside;n=static_cast<DWORD>(buffer.size());if(!FindNextFileNameW(search,&n,buffer.data())){need(GetLastError()==ERROR_HANDLE_EOF);break;}
 }}catch(...){FindClose(search);throw;}need(!!FindClose(search));return outside;
}
