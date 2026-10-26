#include "common.hpp"

namespace kiteline {
struct Job {
  Handle job;
  Handle process;
  Handle thread;
};
struct Fd {
  int value = -1;
  ~Fd() {
    if (value >= 0) closeFd(value);
  }
  int take() {
    int result = value;
    value = -1;
    return result;
  }
};
struct Attributes {
  std::vector<BYTE> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  explicit Attributes(DWORD count) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    storage.resize(size);
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    check(InitializeProcThreadAttributeList(list, count, 0, &size), "initialize process attributes");
  }
  ~Attributes() {
    DeleteProcThreadAttributeList(list);
  }
  void set(DWORD_PTR kind, void *data, SIZE_T size) {
    check(UpdateProcThreadAttribute(list, 0, kind, data, size, nullptr, nullptr), "set process attribute");
  }
};
static napi_value start(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto args = arguments(env, info, 6);
    auto executable = string(env, args[0]);
    auto command = string(env, args[1]);
    auto cwd = string(env, args[2]);
    auto environment = string(env, args[3]);
    bool privateConsole;
    if (napi_get_value_bool(env, args[5], &privateConsole) != napi_ok)
      throw std::invalid_argument("Private console option must be a boolean");
    Fd parentPipeFds[3];
    Fd childPipeFds[3];
    Handle ownedChildHandles[3];
    HANDLE inheritedHandles[3];
    for (int stdioIndex = 0; stdioIndex < 3; stdioIndex++) {
      bool isInput = stdioIndex == 0;
      napi_value modeValue;
      napi_get_element(env, args[4], stdioIndex, &modeValue);
      auto mode = string(env, modeValue);
      if (mode == L"pipe") {
        int pipeFds[2];
        // Only the parent's end is nonblocking; the child uses ordinary stdio.
        int readFlags = isInput ? 0 : UV_NONBLOCK_PIPE;
        int writeFlags = isInput ? UV_NONBLOCK_PIPE : 0;
        int code = uv_pipe(pipeFds, readFlags, writeFlags);
        if (code) throw std::runtime_error(std::string("uv_pipe: ") + uv_strerror(code));
        if (isInput) {
          parentPipeFds[stdioIndex].value = pipeFds[1];
          childPipeFds[stdioIndex].value = pipeFds[0];
        } else {
          parentPipeFds[stdioIndex].value = pipeFds[0];
          childPipeFds[stdioIndex].value = pipeFds[1];
        }
        HANDLE childHandle = uv_get_osfhandle(childPipeFds[stdioIndex].value);
        check(SetHandleInformation(childHandle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT),
          "inherit stdio");
        inheritedHandles[stdioIndex] = childHandle;
      } else if (mode == L"ignore") {
        SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
        ownedChildHandles[stdioIndex].reset(CreateFileW(L"NUL",
          isInput ? GENERIC_READ : GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
        check(ownedChildHandles[stdioIndex].valid(), "open ignored stdio");
        inheritedHandles[stdioIndex] = ownedChildHandles[stdioIndex].value;
      } else {
        throw std::invalid_argument("Stdio mode must be pipe or ignore");
      }
    }
    auto value = std::make_unique<Job>();
    value->job.reset(CreateJobObjectW(nullptr, nullptr));
    check(value->job.valid(), "create Job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(SetInformationJobObject(value->job.value, JobObjectExtendedLimitInformation,
      &limits, sizeof(limits)), "configure Job");
    Attributes attributes(2);
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &value->job.value, sizeof(HANDLE));
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritedHandles, sizeof(inheritedHandles));
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes.list;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    if (privateConsole) {
      startup.StartupInfo.dwFlags |= STARTF_USESHOWWINDOW;
      startup.StartupInfo.wShowWindow = SW_HIDE;
    }
    startup.StartupInfo.hStdInput = inheritedHandles[0];
    startup.StartupInfo.hStdOutput = inheritedHandles[1];
    startup.StartupInfo.hStdError = inheritedHandles[2];
    DWORD creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
      CREATE_UNICODE_ENVIRONMENT | (privateConsole ? CREATE_NEW_CONSOLE : 0);
    PROCESS_INFORMATION process{};
    check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      creationFlags,
      environment.data(), cwd.empty() ? nullptr : cwd.c_str(), &startup.StartupInfo, &process), "create process in Job");
    value->process.reset(process.hProcess);
    value->thread.reset(process.hThread);
    napi_value result, fds;
    napi_create_object(env, &result);
    napi_create_array_with_length(env, 3, &fds);
    napi_set_named_property(env, result, "handle", resource(env, std::move(value)));
    napi_set_named_property(env, result, "pid", number(env, process.dwProcessId));
    for (int i = 0; i < 3; i++) {
      napi_value fd;
      napi_create_int32(env, parentPipeFds[i].take(), &fd);
      napi_set_element(env, fds, i, fd);
    }
    napi_set_named_property(env, result, "fds", fds);
    return result;
  });
}
static napi_value resume(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Job>(env, arguments(env, info, 1)[0]);
    check(ResumeThread(value->thread.value) != static_cast<DWORD>(-1), "resume Job process");
    value->thread.reset();
    return nothing(env);
  });
}
static napi_value inspect(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Job>(env, arguments(env, info, 1)[0]);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    check(QueryInformationJobObject(value->job.value, JobObjectBasicAccountingInformation,
      &accounting, sizeof(accounting), nullptr), "query Job members");
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "active", number(env, accounting.ActiveProcesses));
    DWORD status = WaitForSingleObject(value->process.value, 0);
    if (status == WAIT_FAILED) throw WinError{GetLastError(), "query process exit"};
    if (status == WAIT_OBJECT_0) {
      DWORD code;
      check(GetExitCodeProcess(value->process.value, &code), "read process exit code");
      napi_set_named_property(env, result, "code", number(env, code));
    }
    return result;
  });
}
static napi_value terminate(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Job>(env, arguments(env, info, 1)[0]);
    check(TerminateJobObject(value->job.value, 1), "terminate Job");
    return nothing(env);
  });
}
static napi_value release(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Job>(env, arguments(env, info, 1)[0]);
    for (auto handle : {&value->thread, &value->process, &value->job}) {
      if (!handle->valid()) continue;
      check(CloseHandle(handle->value), "close Job resource");
      handle->value = nullptr;
    }
    return nothing(env);
  });
}
static napi_value releaseFd(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    int32_t fd;
    if (napi_get_value_int32(env, arguments(env, info, 1)[0], &fd) != napi_ok || fd < 0)
      throw std::invalid_argument("Invalid pipe fd");
    closeFd(fd);
    return nothing(env);
  });
}
static napi_value outputUtf8(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    (void)info;
    check(SetConsoleOutputCP(CP_UTF8), "set console output to UTF-8");
    return nothing(env);
  });
}
void exportJobs(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"setConsoleOutputUtf8", nullptr, outputUtf8, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"jobStart", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"jobResume", nullptr, resume, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"jobInspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"jobTerminate", nullptr, terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"jobRelease", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeFd", nullptr, releaseFd, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
}
}
