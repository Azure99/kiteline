#include "common.hpp"
#include <aclapi.h>
#include <sddl.h>

namespace kiteline {
struct Pipe {
  std::wstring name;
  PSECURITY_DESCRIPTOR security = nullptr;
  Handle listener;
  Handle acceptEvent;
  OVERLAPPED acceptOperation{};
  bool pending = false;
  bool retry = false;
  bool stopping = false;
  explicit Pipe(std::wstring name) : name(std::move(name)) {
    auto sid = userSid();
    auto ownerSid = sidText(sid.data());
    auto sddl = L"O:" + ownerSid + L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + ownerSid + L")";
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
      &security, nullptr), "build pipe DACL");
  }
  ~Pipe() {
    if (pending) {
      CancelIoEx(listener.value, &acceptOperation);
      DWORD bytes;
      GetOverlappedResult(listener.value, &acceptOperation, &bytes, TRUE);
    }
    if (security) LocalFree(security);
  }
  void next(bool first) {
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), security, FALSE};
    DWORD openMode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
      (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
    DWORD pipeMode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    const DWORD bufferSize = 64 * 1024;
    listener.reset(CreateNamedPipeW(name.c_str(), openMode, pipeMode,
      PIPE_UNLIMITED_INSTANCES, bufferSize, bufferSize, 0, &attributes));
    check(listener.valid(), "create private pipe");
    acceptEvent.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    check(acceptEvent.valid(), "create pipe event");
    connect();
  }
  void connect() {
    acceptOperation = {};
    acceptOperation.hEvent = acceptEvent.value;
    check(ResetEvent(acceptEvent.value), "reset pipe event");
    if (!ConnectNamedPipe(listener.value, &acceptOperation)) {
      DWORD code = GetLastError();
      if (code == ERROR_IO_PENDING) {
        pending = true;
      } else if (code == ERROR_NO_DATA) {
        retry = true;
      } else if (code != ERROR_PIPE_CONNECTED) {
        throw WinError{code, "accept private pipe"};
      }
    }
  }
  bool complete() {
    if (retry) {
      if (stopping) return true;
      if (!DisconnectNamedPipe(listener.value) && GetLastError() != ERROR_PIPE_NOT_CONNECTED)
        throw WinError{GetLastError(), "reset closed pipe client"};
      retry = false;
      connect();
      return false;
    }
    if (!pending) return true;
    DWORD bytes;
    if (!GetOverlappedResult(listener.value, &acceptOperation, &bytes, FALSE)) {
      DWORD code = GetLastError();
      if (code == ERROR_IO_INCOMPLETE) return false;
      pending = false;
      if (code == ERROR_NO_DATA || code == ERROR_BROKEN_PIPE || code == ERROR_PIPE_NOT_CONNECTED) {
        if (stopping) return true;
        retry = true;
        return false;
      }
      if (!(stopping && code == ERROR_OPERATION_ABORTED))
        throw WinError{code, "complete pipe accept"};
    }
    pending = false;
    return true;
  }
};
static int descriptor(HANDLE handle) {
  int fd = uv_open_osfhandle(handle);
  if (fd < 0) {
    CloseHandle(handle);
    throw WinError{ERROR_INVALID_HANDLE, "adopt private pipe"};
  }
  return fd;
}
static napi_value start(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = std::make_unique<Pipe>(string(env, arguments(env, info, 1)[0]));
    value->next(true);
    return resource(env, std::move(value));
  });
}
static napi_value poll(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Pipe>(env, arguments(env, info, 1)[0]);
    if (value->stopping || !value->complete()) return nothing(env);
    // Keep the connected instance alive until the next listener owns the name.
    Handle accepted(value->listener.take());
    value->next(false);
    int acceptedFd = descriptor(accepted.take());
    napi_value result;
    napi_create_int32(env, acceptedFd, &result);
    return result;
  });
}
static napi_value stop(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto value = external<Pipe>(env, arguments(env, info, 1)[0]);
    if (!value->stopping) {
      value->stopping = true;
      if (value->pending && !CancelIoEx(value->listener.value, &value->acceptOperation)) {
        DWORD code = GetLastError();
        if (code != ERROR_NOT_FOUND) throw WinError{code, "cancel pipe accept"};
      }
    }
    bool done = value->complete();
    if (done) {
      value->listener.reset();
      value->acceptEvent.reset();
    }
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
    PSID owner = nullptr;
    PSECURITY_DESCRIPTOR security = nullptr;
    DWORD code = GetSecurityInfo(pipe.value, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
      &owner, nullptr, nullptr, nullptr, &security);
    if (code) throw WinError{code, "read pipe owner"};
    auto sid = userSid();
    bool sameOwner = EqualSid(owner, sid.data());
    LocalFree(security);
    if (!sameOwner) throw WinError{ERROR_ACCESS_DENIED, "private pipe belongs to another identity"};
    int connectedFd = descriptor(pipe.take());
    napi_value result;
    napi_create_int32(env, connectedFd, &result);
    return result;
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
