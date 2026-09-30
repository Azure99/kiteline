#include "common.hpp"
#include <aclapi.h>
#include <sddl.h>

namespace kiteline {
struct Pipe {
  std::wstring name;
  PSECURITY_DESCRIPTOR security = nullptr;
  Handle pipe, event;
  OVERLAPPED operation{};
  bool pending = false, retry = false, stopping = false;
  explicit Pipe(std::wstring name) : name(std::move(name)) {
    auto sid = userSid(); auto text = sidText(sid.data());
    auto sddl = L"O:" + text + L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + text + L")";
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &security, nullptr), "build pipe DACL");
  }
  ~Pipe() {
    if (pending) { CancelIoEx(pipe.value, &operation); DWORD bytes; GetOverlappedResult(pipe.value, &operation, &bytes, TRUE); }
    if (security) LocalFree(security);
  }
  void next(bool first) {
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), security, FALSE};
    pipe.reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, &attributes));
    check(pipe.valid(), "create private pipe");
    event.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); check(event.valid(), "create pipe event");
    connect();
  }
  void connect() {
    operation = {}; operation.hEvent = event.value;
    check(ResetEvent(event.value), "reset pipe event");
    if (!ConnectNamedPipe(pipe.value, &operation)) {
      DWORD code = GetLastError();
      if (code == ERROR_IO_PENDING) pending = true;
      else if (code == ERROR_NO_DATA) retry = true;
      else if (code != ERROR_PIPE_CONNECTED) throw WinError{code, "accept private pipe"};
    }
  }
  bool complete() {
    if (retry) {
      if (stopping) return true;
      if (!DisconnectNamedPipe(pipe.value) && GetLastError() != ERROR_PIPE_NOT_CONNECTED)
        throw WinError{GetLastError(), "reset closed pipe client"};
      retry = false;
      connect();
      return false;
    }
    if (!pending) return true;
    DWORD bytes;
    if (!GetOverlappedResult(pipe.value, &operation, &bytes, FALSE)) {
      DWORD code = GetLastError();
      if (code == ERROR_IO_INCOMPLETE) return false;
      pending = false;
      if (code == ERROR_NO_DATA || code == ERROR_BROKEN_PIPE || code == ERROR_PIPE_NOT_CONNECTED) {
        if (stopping) return true;
        retry = true;
        return false;
      }
      if (!(stopping && code == ERROR_OPERATION_ABORTED)) throw WinError{code, "complete pipe accept"};
    }
    pending = false; return true;
  }
};
static int descriptor(HANDLE handle) {
  int fd = uv_open_osfhandle(handle);
  if (fd < 0) { CloseHandle(handle); throw WinError{ERROR_INVALID_HANDLE, "adopt private pipe"}; }
  return fd;
}
static napi_value start(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = std::make_unique<Pipe>(string(env, arguments(env, info, 1)[0]));
    value->next(true); return resource(env, std::move(value));
  });
}
static napi_value poll(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Pipe>(env, arguments(env, info, 1)[0]);
    if (value->stopping || !value->complete()) return nothing(env);
    // Keep the connected instance alive until the next listener owns the name.
    Handle accepted(value->pipe.take());
    value->next(false);
    napi_value fd; napi_create_int32(env, descriptor(accepted.take()), &fd); return fd;
  });
}
static napi_value stop(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Pipe>(env, arguments(env, info, 1)[0]);
    if (!value->stopping) {
      value->stopping = true;
      if (value->pending && !CancelIoEx(value->pipe.value, &value->operation)) {
        DWORD code = GetLastError();
        if (code != ERROR_NOT_FOUND) throw WinError{code, "cancel pipe accept"};
      }
    }
    bool done = value->complete();
    if (done) { value->pipe.reset(); value->event.reset(); }
    return boolean(env, done);
  });
}
static napi_value connect(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto name = string(env, arguments(env, info, 1)[0]);
    // FILE_GENERIC_WRITE includes FILE_CREATE_PIPE_INSTANCE; clients do not need it.
    const DWORD access = FILE_GENERIC_READ | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
    Handle pipe(CreateFileW(name.c_str(), access, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (!pipe.valid()) {
      DWORD code = GetLastError();
      if (code == ERROR_PIPE_BUSY) return nothing(env);
      throw WinError{code, "connect private pipe"};
    }
    PSID owner = nullptr; PSECURITY_DESCRIPTOR security = nullptr;
    DWORD code = GetSecurityInfo(pipe.value, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &security);
    if (code) throw WinError{code, "read pipe owner"};
    auto sid = userSid(); bool same = EqualSid(owner, sid.data()); LocalFree(security);
    if (!same) throw WinError{ERROR_ACCESS_DENIED, "private pipe belongs to another identity"};
    napi_value fd; napi_create_int32(env, descriptor(pipe.take()), &fd); return fd;
  });
}
void exportPipes(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"pipeStart", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pipePoll", nullptr, poll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pipeStop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pipeConnect", nullptr, connect, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
}
}
