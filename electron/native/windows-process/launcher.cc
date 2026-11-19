#include <windows.h>
#include <shellapi.h>
#include <io.h>
#include <string>
#include <vector>
#include <cstdio>

static std::wstring quote(const std::wstring& value){
  std::wstring out=L"\"";size_t slashes=0;
  for(wchar_t c:value){if(c==L'\\'){slashes++;continue;}out.append(slashes*(c==L'"'?2:1)+(c==L'"'?1:0),L'\\');slashes=0;out+=c;}
  out.append(slashes*2,L'\\');return out+L'"';
}
static int error(const char* operation){fprintf(stderr,"[aily-process] %s failed (Win32 %lu)\n",operation,GetLastError());return 125;}
static bool count(HANDLE job,DWORD& active){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a={};if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&a,sizeof(a),nullptr))return false;active=a.ActiveProcesses;return true;}
static BOOL WINAPI ignoreInterrupt(DWORD event){return event==CTRL_C_EVENT||event==CTRL_BREAK_EVENT;}
static void removeDescriptor(const wchar_t* filename,const wchar_t* instance){
  // Hold the actual file with write/delete sharing denied. A replaced descriptor
  // cannot be unlinked by a stale watcher after a host PID is recycled.
  HANDLE file=CreateFileW(filename,GENERIC_READ|DELETE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);if(file==INVALID_HANDLE_VALUE)return;
  DWORD size=GetFileSize(file,nullptr);if(size<=65536){std::string data(size,'\0');DWORD read=0;if(ReadFile(file,data.data(),size,&read,nullptr)){
    std::string id;for(const wchar_t* p=instance;*p;p++)id+=(char)*p;
    if(data.find("\"instanceId\":\""+id+"\"")!=std::string::npos){FILE_DISPOSITION_INFO disposition={TRUE};SetFileInformationByHandle(file,FileDispositionInfo,&disposition,sizeof(disposition));}
  }}CloseHandle(file);
}
static int watch(int argc,wchar_t** argv){
  if(argc!=6)return 124;DWORD pid=wcstoul(argv[2],nullptr,10);unsigned long long expected=_wcstoui64(argv[3],nullptr,10);
  HANDLE parent=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
  if(parent){FILETIME c,e,k,u;if(!GetProcessTimes(parent,&c,&e,&k,&u)){CloseHandle(parent);return error("GetProcessTimes");}
    auto actual=((unsigned long long)c.dwHighDateTime<<32)|c.dwLowDateTime;if(actual==expected)WaitForSingleObject(parent,INFINITE);
    removeDescriptor(argv[4],argv[5]);CloseHandle(parent);
  }else if(GetLastError()==ERROR_INVALID_PARAMETER)removeDescriptor(argv[4],argv[5]);
  return 0;
}
int wmain(int argc,wchar_t** argv){
  if(argc>1 && std::wstring(argv[1])==L"--watch")return watch(argc,argv);
  if(argc<5)return 124;
  // This gate runs before the target executable. The main process owns the only
  // lasting Job handle. Closing it (including a crash) kills every descendant.
  HANDLE job=OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS|JOB_OBJECT_QUERY,FALSE,argv[1]);if(!job)return error("OpenJobObject");
  if(!AssignProcessToJobObject(job,GetCurrentProcess())){CloseHandle(job);return error("AssignLauncherToJob");}
  unsigned flags=wcstoul(argv[2],nullptr,10);bool verbatim=(flags&1)!=0;
  std::wstring file=argv[3],command=quote(argv[4]);
  for(int n=5;n<argc;n++)command+=L" "+(verbatim?std::wstring(argv[n]):quote(argv[n]));
  wchar_t found[32768];if(SearchPathW(nullptr,file.c_str(),L".exe",32768,found,nullptr))file=found;
  // Preserve libuv's CRT descriptor table, including the Node IPC descriptor.
  // ConPTY children inherit the launcher's existing console instead.
  STARTUPINFOW startup={};startup.cb=sizeof(startup);GetStartupInfoW(&startup);
  SetConsoleCtrlHandler(ignoreInterrupt,TRUE);
  PROCESS_INFORMATION process={};
  if(!CreateProcessW(file.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|((flags&2)?CREATE_NO_WINDOW:0),nullptr,nullptr,&startup,&process)){CloseHandle(job);return error("CreateProcessSuspended");}
  BOOL member=FALSE;
  if(!IsProcessInJob(process.hProcess,job,&member)||!member||ResumeThread(process.hThread)==(DWORD)-1){
    TerminateProcess(process.hProcess,125);WaitForSingleObject(process.hProcess,5000);CloseHandle(process.hThread);CloseHandle(process.hProcess);CloseHandle(job);return error("StartOwnedTarget");
  }
  CloseHandle(process.hThread);CloseHandle(job);
  // The target owns its duplicated descriptors. Keeping an IPC or pipe copy in
  // this gate would prevent disconnect/EOF from reaching the actual parent.
  if(startup.cbReserved2>=sizeof(int)){int descriptors=*(int*)startup.lpReserved2;for(int fd=0;fd<descriptors;fd++)_close(fd);}
  else for(int fd=0;fd<3;fd++)_close(fd);
  WaitForSingleObject(process.hProcess,INFINITE);DWORD exitCode=125;GetExitCodeProcess(process.hProcess,&exitCode);CloseHandle(process.hProcess);
  // A root may finish before a detached child. Keep the owning ChildProcess
  // registered until the entire task is empty, without adopting arbitrary PIDs.
  while(true){HANDLE current=OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,argv[1]);if(!current)return 125;DWORD active=0;bool ok=count(current,active);CloseHandle(current);if(!ok)return 125;if(active<=1)break;Sleep(5);}
  return (int)exitCode;
}
