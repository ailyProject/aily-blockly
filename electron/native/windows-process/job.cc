#define NAPI_VERSION 8
#include <node_api.h>
#include <windows.h>
#include <cstddef>
#include <cstring>
#include <string>
#include <vector>

// Resolve Node-API from the host executable: the same binary loads in both
// Electron and standalone Node, without a dependency on node.exe/node.dll.
#define APIS(X) X(napi_get_cb_info) X(napi_get_value_string_utf16) X(napi_get_value_external) X(napi_create_external) X(napi_throw_error) X(napi_create_object) X(napi_create_uint32) X(napi_create_string_utf8) X(napi_set_named_property) X(napi_create_array_with_length) X(napi_set_element) X(napi_get_undefined) X(napi_create_function) X(napi_get_value_uint32) X(napi_get_boolean) X(napi_get_value_bigint_uint64)
struct Api {
#define DECLARE(name) decltype(&name) name;
  APIS(DECLARE)
#undef DECLARE
};
static thread_local Api api;
struct Job { HANDLE handle; };
static napi_value fail(napi_env env, const char* operation) {
  std::string message = std::string(operation) + " (Win32 " + std::to_string(GetLastError()) + ")";
  api.napi_throw_error(env, "WINDOWS_PROCESS_JOB_FAILED", message.c_str()); return nullptr;
}
static std::wstring text(napi_env env, napi_value value) {
  size_t size=0; api.napi_get_value_string_utf16(env,value,nullptr,0,&size);
  std::vector<char16_t> buffer(size+1); api.napi_get_value_string_utf16(env,value,buffer.data(),buffer.size(),&size);
  return std::wstring((wchar_t*)buffer.data(),size);
}
static void finalize(napi_env, void* value, void*) { auto job=(Job*)value; if(job->handle)CloseHandle(job->handle); delete job; }
static Job* argument(napi_env env,napi_callback_info info) {
  napi_value arg;size_t count=1;void* result=nullptr;api.napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);
  if(count!=1 || api.napi_get_value_external(env,arg,&result)!=napi_ok || !result){api.napi_throw_error(env,nullptr,"Invalid Job handle");return nullptr;}return (Job*)result;
}
static void number(napi_env env,napi_value obj,const char* key,uint32_t n){napi_value value;api.napi_create_uint32(env,n,&value);api.napi_set_named_property(env,obj,key,value);}
static napi_value create(napi_env env,napi_callback_info info) {
  napi_value arg,result;size_t count=1;api.napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);
  auto name=text(env,arg);HANDLE handle=CreateJobObjectW(nullptr,name.c_str());DWORD error=GetLastError();
  if(!handle)return fail(env,"CreateJobObject");
  if(error==ERROR_ALREADY_EXISTS){CloseHandle(handle);SetLastError(error);return fail(env,"Job name already exists");}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(handle,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){CloseHandle(handle);return fail(env,"SetInformationJobObject");}
  auto job=new Job{handle};api.napi_create_external(env,job,finalize,nullptr,&result);return result;
}
static napi_value query(napi_env env,napi_callback_info info) {
  auto job=argument(env,info);if(!job)return nullptr;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting={};
  if(!job->handle || !QueryInformationJobObject(job->handle,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr))return fail(env,"QueryJobAccounting");
  napi_value result,array;api.napi_create_object(env,&result);number(env,result,"active",accounting.ActiveProcesses);
  for(size_t capacity=16;capacity<=65536;capacity*=2){
    std::vector<unsigned char> buffer(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+sizeof(ULONG_PTR)*capacity);
    auto ids=(JOBOBJECT_BASIC_PROCESS_ID_LIST*)buffer.data();
    if(!QueryInformationJobObject(job->handle,JobObjectBasicProcessIdList,ids,(DWORD)buffer.size(),nullptr)){if(GetLastError()==ERROR_MORE_DATA)continue;return fail(env,"QueryJobMembers");}
    api.napi_create_array_with_length(env,ids->NumberOfProcessIdsInList,&array);
    for(DWORD n=0;n<ids->NumberOfProcessIdsInList;n++){napi_value pid;api.napi_create_uint32(env,(uint32_t)ids->ProcessIdList[n],&pid);api.napi_set_element(env,array,n,pid);}
    api.napi_set_named_property(env,result,"pids",array);return result;
  }
  api.napi_throw_error(env,nullptr,"Job member limit exceeded");return nullptr;
}
static napi_value terminate(napi_env env,napi_callback_info info){auto job=argument(env,info);if(!job)return nullptr;if(!job->handle||!TerminateJobObject(job->handle,1))return fail(env,"TerminateJobObject");napi_value result;api.napi_get_undefined(env,&result);return result;}
static napi_value release(napi_env env,napi_callback_info info){
  auto job=argument(env,info);if(!job)return nullptr;napi_value result;
  if(job->handle){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a={};if(!QueryInformationJobObject(job->handle,JobObjectBasicAccountingInformation,&a,sizeof(a),nullptr))return fail(env,"QueryJobBeforeRelease");
    if(a.ActiveProcesses){api.napi_throw_error(env,nullptr,"Cannot release a live Job");return nullptr;}
    CloseHandle(job->handle);job->handle=nullptr;
  }api.napi_get_undefined(env,&result);return result;
}
static napi_value identity(napi_env env,napi_callback_info info){
  napi_value arg,result;size_t count=1;api.napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);uint32_t pid=GetCurrentProcessId();if(count)api.napi_get_value_uint32(env,arg,&pid);
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!process)return fail(env,"OpenProcessIdentity");FILETIME c,e,k,u;BOOL ok=GetProcessTimes(process,&c,&e,&k,&u);CloseHandle(process);if(!ok)return fail(env,"GetProcessTimes");
  auto value=std::to_string(((uint64_t)c.dwHighDateTime<<32)|c.dwLowDateTime);api.napi_create_string_utf8(env,value.c_str(),value.size(),&result);return result;
}
static napi_value removeDescriptor(napi_env env,napi_callback_info info){
  napi_value args[3],result;size_t count=3;api.napi_get_cb_info(env,info,&count,args,nullptr,nullptr);bool removed=false;
  if(count!=3){api.napi_throw_error(env,nullptr,"Descriptor identity required");return nullptr;}
  auto filename=text(env,args[0]),field=text(env,args[1]),expected=text(env,args[2]);
  if((field!=L"instanceId"&&field!=L"token")||expected.empty()||expected.find_first_not_of(L"abcdef0123456789-")!=std::wstring::npos){api.napi_throw_error(env,nullptr,"Invalid descriptor identity");return nullptr;}
  HANDLE file=CreateFileW(filename.c_str(),GENERIC_READ|DELETE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file!=INVALID_HANDLE_VALUE){DWORD size=GetFileSize(file,nullptr);if(size<=65536){std::string bytes(size,'\0'),needle="\"";for(auto c:field)needle+=(char)c;needle+="\":\"";for(auto c:expected)needle+=(char)c;needle+='"';DWORD read=0;
      if(ReadFile(file,bytes.data(),size,&read,nullptr)&&bytes.find(needle)!=std::string::npos){FILE_DISPOSITION_INFO disposition={TRUE};removed=SetFileInformationByHandle(file,FileDispositionInfo,&disposition,sizeof(disposition));}
  }CloseHandle(file);}api.napi_get_boolean(env,removed,&result);return result;
}

struct ScopedFile {
  HANDLE handle;
  ~ScopedFile() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};

static bool matchesFile(HANDLE handle, uint64_t volume, uint64_t id, uint64_t birth, bool directory) {
  BY_HANDLE_FILE_INFORMATION info = {};
  if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, &info)) return false;
  const uint64_t inode = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  const uint64_t created = (static_cast<uint64_t>(info.ftCreationTime.dwHighDateTime) << 32) | info.ftCreationTime.dwLowDateTime;
  constexpr uint64_t epoch = 116444736000000000;
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || inode != id || info.dwVolumeSerialNumber != volume
      || created < epoch || created - epoch != birth || ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) return false;
  return directory || (info.nNumberOfLinks == 1 && info.nFileSizeHigh == 0 && info.nFileSizeLow == 0);
}

static DWORD archiveProjectLock(const std::wstring& directory, const std::wstring& archive, const uint64_t (&identity)[5]) {
  if (directory.size() < 4 || directory[1] != L':' || directory[2] != L'\\'
      || directory.find(L'\0') != std::wstring::npos || directory.find(L'/') != std::wstring::npos
      || GetDriveTypeW(directory.substr(0, 3).c_str()) != DRIVE_FIXED) return ERROR_NOT_SUPPORTED;
  const auto directoryPath = L"\\\\?\\" + directory;
  ScopedFile parent{CreateFileW(directoryPath.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  if (parent.handle == INVALID_HANDLE_VALUE) return GetLastError();
  if (!matchesFile(parent.handle, identity[0], identity[1], identity[2], true)) return ERROR_INVALID_DATA;
  wchar_t format[16] = {};
  if (!GetVolumeInformationByHandleW(parent.handle, nullptr, 0, nullptr, nullptr, nullptr, format, 16)
      || std::wstring(format) != L"NTFS") return ERROR_NOT_SUPPORTED;

  // Old writers kept a write descriptor open until completion. A zero share
  // mode excludes that descriptor even if the writer does not hold the guard.
  const auto marker = directoryPath + L"\\project-files.write.lock";
  ScopedFile file{CreateFileW(marker.c_str(), GENERIC_READ | DELETE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  if (file.handle == INVALID_HANDLE_VALUE) return GetLastError();
  if (!matchesFile(file.handle, identity[0], identity[3], identity[4], false)) return ERROR_INVALID_DATA;
  // The identified parent stays open without delete-sharing throughout this
  // same-directory, no-overwrite rename of the identified marker handle.
  const auto destination = directoryPath + L"\\" + archive;
  const size_t bytes = destination.size() * sizeof(wchar_t);
  std::vector<unsigned char> buffer(sizeof(FILE_RENAME_INFO) + bytes);
  auto rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  rename->ReplaceIfExists = FALSE;
  rename->FileNameLength = static_cast<DWORD>(bytes);
  std::memcpy(rename->FileName, destination.data(), bytes);
  return SetFileInformationByHandle(file.handle, FileRenameInfo, rename, static_cast<DWORD>(buffer.size())) ? ERROR_SUCCESS : GetLastError();
}

static napi_value archiveEmptyProjectLock(napi_env env, napi_callback_info info) {
  napi_value args[7], result;
  size_t count = 7;
  api.napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 7) { api.napi_throw_error(env, nullptr, "Exact project lock identity required"); return nullptr; }
  const auto directory = text(env, args[0]), token = text(env, args[1]);
  if (token.size() != 36 || token.find_first_not_of(L"abcdef0123456789-") != std::wstring::npos) {
    api.napi_throw_error(env, nullptr, "Invalid project lock archive token"); return nullptr;
  }
  uint64_t identity[5];
  for (size_t index = 0; index < 5; index++) {
    bool lossless = false;
    if (api.napi_get_value_bigint_uint64(env, args[index + 2], &identity[index], &lossless) != napi_ok || !lossless) {
      api.napi_throw_error(env, nullptr, "Invalid project lock file identity"); return nullptr;
    }
  }
  const auto error = archiveProjectLock(directory, L".project-files.write.lock.retired-" + token, identity);
  api.napi_create_uint32(env, error, &result);
  return result;
}

NAPI_MODULE_INIT(){
  HMODULE host=GetModuleHandleW(nullptr);
#define LOAD(name) api.name=(decltype(api.name))GetProcAddress(host,#name);if(!api.name)return nullptr;
  APIS(LOAD)
#undef LOAD
  const struct{const char* name;napi_callback callback;} methods[]={{"create",create},{"query",query},{"terminate",terminate},{"release",release},{"identity",identity},{"removeDescriptor",removeDescriptor},{"archiveEmptyProjectLock",archiveEmptyProjectLock}};
  for(auto method:methods){napi_value fn;api.napi_create_function(env,method.name,NAPI_AUTO_LENGTH,method.callback,nullptr,&fn);api.napi_set_named_property(env,exports,method.name,fn);}return exports;
}
