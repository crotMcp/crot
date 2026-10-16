import subprocess,pathlib,json,hashlib
root=pathlib.Path('/data/wp23c-followup')
pre='''#include <string>
#include <cstring>
#include <iostream>
using HANDLE=long; using DWORD=unsigned long;
constexpr HANDLE INVALID_HANDLE_VALUE=-1;
constexpr DWORD GENERIC_WRITE=1,CREATE_ALWAYS=2;
int scenario=0,closed=0;
HANDLE CreateFileW(const wchar_t*,DWORD,DWORD,void*,DWORD,DWORD,void*){return scenario==1?INVALID_HANDLE_VALUE:42;}
int WriteFile(HANDLE,const char*,DWORD length,DWORD* written,void*){*written=scenario==3?length-1:length;return scenario==2?0:1;}
int CloseHandle(HANDLE){closed++;return scenario==4?0:1;}
'''
post='''
int main(){for(scenario=0;scenario<5;scenario++){closed=0;bool okay=put(L"fixture", "four");bool expected=scenario==0;if(okay!=expected || closed!=(scenario==1?0:1)){std::cout<<"FAIL scenario="<<scenario<<" okay="<<okay<<" closed="<<closed<<std::endl;return 3;}}std::cout<<"PASS 5 mocked I/O outcomes (not native Windows qualification)"<<std::endl;}
'''
results={}
for label,sha in [('before','c635d25c23b53c4f304829ef3452a41fd0cb2396'),('after','6da4386c08ec41ebe9a583f8d61b7c629b473dd1')]:
 source=subprocess.check_output(['git','show',sha+':native/windows-workspace-view/control-profile-child.cpp']).decode()
 fun=next(x for x in source.splitlines() if x.startswith('bool put('))
 path=root/(label+'-partial-write.cpp');path.write_text(pre+fun+post)
 exe=root/(label+'-partial-write');subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror',str(path),'-o',str(exe)],check=True)
 p=subprocess.run([str(exe)],text=True,capture_output=True);(root/(label+'-partial-write.log')).write_text(p.stdout+p.stderr)
 results[label]={'sourceCommit':sha,'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'functionSha256':hashlib.sha256(fun.encode()).hexdigest(),'exit':p.returncode,'output':p.stdout}
assert results['before']['exit']==3 and results['after']['exit']==0
(root/'partial-write-red-green.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
