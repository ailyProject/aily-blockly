#include <windows.h>
#include <shellapi.h>
#include <io.h>
#include <string>
#include <vector>
#include <cstdio>
#include <cstdint>

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
static void closeStandardCopies(const STARTUPINFOW& startup) {
  // Only the target retains the duplicated CRT/Node IPC descriptors.
  if (startup.cbReserved2 >= sizeof(int)) {
    const int descriptors = *reinterpret_cast<int*>(startup.lpReserved2);
    for (int fd = 0; fd < descriptors; fd++) _close(fd);
  } else for (int fd = 0; fd < 3; fd++) _close(fd);
}
static bool writeBuildTag(const std::wstring& filename, const std::wstring& jobName) {
  const auto file = CreateFileW(filename.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
    CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  const std::wstring prefix = L"Global\\AilyBuild-";
  if (jobName.compare(0, prefix.size(), prefix) || jobName.size() != prefix.size()+36
    || jobName.find_first_not_of(L"0123456789abcdef-", prefix.size()) != std::wstring::npos) {
    CloseHandle(file);
    return false;
  }
  std::string tag;
  for (const auto character : jobName) tag += static_cast<char>(character);
  DWORD written = 0;
  const bool ok = WriteFile(file, tag.data(), static_cast<DWORD>(tag.size()), &written, nullptr)
    && written == tag.size() && FlushFileBuffers(file);
  CloseHandle(file);
  return ok;
}
static bool pathAbsent(const std::wstring& filename) {
  if (GetFileAttributesW(filename.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  const auto reason = GetLastError();
  return reason == ERROR_FILE_NOT_FOUND || reason == ERROR_PATH_NOT_FOUND;
}
static bool startBuildTarget(HANDLE job, int argc, wchar_t** argv, PROCESS_INFORMATION& process) {
  const unsigned flags = wcstoul(argv[2], nullptr, 10);
  const bool verbatim = (flags & 1) != 0;
  std::wstring file = argv[3], command = quote(argv[4]);
  for (int n = 5; n < argc; n++) command += L" " + (verbatim ? std::wstring(argv[n]) : quote(argv[n]));
  wchar_t found[32768];
  if (SearchPathW(nullptr, file.c_str(), L".exe", 32768, found, nullptr)) file = found;

  STARTUPINFOEXW startup = {};
  GetStartupInfoW(&startup.StartupInfo);
  startup.StartupInfo.cb = sizeof(startup);
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  if (!bytes) return false;
  std::vector<unsigned char> storage(bytes);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) return false;
  // The supervisor remains outside this Job. The target must belong to it
  // from creation, even if the supervisor exits before its next instruction.
  const bool started = UpdateProcThreadAttribute(startup.lpAttributeList, 0,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr)
    && CreateProcessW(file.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | ((flags & 2) ? CREATE_NO_WINDOW : 0),
      nullptr, nullptr, &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (started) closeStandardCopies(startup.StartupInfo);
  return started;
}
static int monitorBuild(int argc, wchar_t** argv) {
  if (argc < 9) return 124;
  const DWORD pid = wcstoul(argv[2], nullptr, 10);
  const auto expected = _wcstoui64(argv[3], nullptr, 10);
  const std::wstring receipt = argv[4], jobName = argv[5], stop = receipt + L".stop";
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!parent) return error("OpenBuildHost");
  FILETIME c, e, k, u;
  if (!GetProcessTimes(parent, &c, &e, &k, &u)
    || ((static_cast<uint64_t>(c.dwHighDateTime) << 32) | c.dwLowDateTime) != expected) {
    CloseHandle(parent);
    return 125;
  }
  const auto job = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, jobName.c_str());
  if (!job) { CloseHandle(parent); return error("OpenBuildJob"); }
  const auto shouldStop = [&] { return WaitForSingleObject(parent, 0) != WAIT_TIMEOUT || !pathAbsent(stop); };
  PROCESS_INFORMATION process = {};
  DWORD exitCode = 125, active = 0;
  SetConsoleCtrlHandler(ignoreInterrupt, TRUE);
  if (!shouldStop() && writeBuildTag(receipt + L".admitted", jobName)
    && startBuildTarget(job, argc - 4, argv + 4, process)) {
    BOOL member = FALSE;
    if (!IsProcessInJob(process.hProcess, job, &member) || !member || shouldStop()
      || ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
      TerminateProcess(process.hProcess, 125);
    }
    CloseHandle(process.hThread);
  }
  bool terminated = false;
  while (count(job, active) && active) {
    if (!terminated && shouldStop()) terminated = TerminateJobObject(job, 1) != FALSE;
    Sleep(5);
  }
  // Zero members is meaningful only after this gate can no longer launch.
  if (!count(job, active) || active || !writeBuildTag(receipt, jobName)) {
    CloseHandle(job);
    CloseHandle(parent);
    if (process.hProcess) CloseHandle(process.hProcess);
    return 125;
  }
  if (process.hProcess) { GetExitCodeProcess(process.hProcess, &exitCode); CloseHandle(process.hProcess); }
  CloseHandle(job);
  CloseHandle(parent);
  return static_cast<int>(exitCode);
}
int wmain(int argc,wchar_t** argv){
  if(argc>1 && std::wstring(argv[1])==L"--watch")return watch(argc,argv);
  if(argc>1 && std::wstring(argv[1])==L"--monitor-build")return monitorBuild(argc,argv);
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
  closeStandardCopies(startup);
  WaitForSingleObject(process.hProcess,INFINITE);DWORD exitCode=125;GetExitCodeProcess(process.hProcess,&exitCode);CloseHandle(process.hProcess);
  // A root may finish before a detached child. Keep the owning ChildProcess
  // registered until the entire task is empty, without adopting arbitrary PIDs.
  while(true){HANDLE current=OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,argv[1]);if(!current)return 125;DWORD active=0;bool ok=count(current,active);CloseHandle(current);if(!ok)return 125;if(active<=1)break;Sleep(5);}
  return (int)exitCode;
}
