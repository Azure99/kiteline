#pragma once
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <node_api.h>
#include <uv.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace kiteline {
struct WinError { DWORD code; const char *operation; };
inline void check(BOOL ok, const char *operation) {
  if (!ok) throw WinError{GetLastError(), operation};
}
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE value) : value(value) {}
  Handle(const Handle &) = delete;
  Handle &operator=(const Handle &) = delete;
  ~Handle() { reset(); }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
  void reset(HANDLE next = nullptr) { if (valid()) CloseHandle(value); value = next; }
  HANDLE take() { HANDLE result = value; value = nullptr; return result; }
};
inline void closeFd(int fd) {
  uv_fs_t request;
  uv_fs_close(nullptr, &request, fd, nullptr);
  uv_fs_req_cleanup(&request);
}
inline std::wstring string(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok)
    throw std::invalid_argument("Expected a string");
  std::vector<char16_t> data(length + 1);
  napi_get_value_string_utf16(env, value, data.data(), data.size(), &length);
  return std::wstring(reinterpret_cast<wchar_t *>(data.data()), length);
}
inline napi_value text(napi_env env, const std::wstring &value) {
  napi_value result;
  napi_create_string_utf16(env, reinterpret_cast<const char16_t *>(value.data()), value.size(), &result);
  return result;
}
inline napi_value number(napi_env env, uint32_t value) {
  napi_value result; napi_create_uint32(env, value, &result); return result;
}
inline napi_value boolean(napi_env env, bool value) {
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
inline napi_value nothing(napi_env env) {
  napi_value result; napi_get_undefined(env, &result); return result;
}
inline std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t count) {
  std::vector<napi_value> result(count);
  size_t actual = count;
  napi_get_cb_info(env, info, &actual, result.data(), nullptr, nullptr);
  if (actual != count) throw std::invalid_argument("Invalid native argument count");
  return result;
}
template <class T> T *external(napi_env env, napi_value value) {
  void *result = nullptr;
  if (napi_get_value_external(env, value, &result) != napi_ok || !result)
    throw std::invalid_argument("Invalid native resource");
  return static_cast<T *>(result);
}
template <class T> napi_value resource(napi_env env, std::unique_ptr<T> value) {
  napi_value result;
  if (napi_create_external(env, value.get(), [](napi_env, void *data, void *) {
        delete static_cast<T *>(data);
      }, nullptr, &result) != napi_ok) throw std::runtime_error("Could not export native resource");
  value.release();
  return result;
}
template <class F> napi_value call(napi_env env, F action) {
  try { return action(); }
  catch (const WinError &error) {
    std::string message = std::string(error.operation) + ": Win32 error " + std::to_string(error.code);
    napi_value value, messageValue;
    napi_create_string_utf8(env, message.c_str(), message.size(), &messageValue);
    napi_create_error(env, nullptr, messageValue, &value);
    napi_set_named_property(env, value, "win32Code", number(env, error.code));
    napi_throw(env, value);
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); }
  return nullptr;
}
std::vector<BYTE> userSid();
std::wstring sidText(PSID sid);
void exportJobs(napi_env env, napi_value exports);
void exportSystem(napi_env env, napi_value exports);
void exportPipes(napi_env env, napi_value exports);
void exportFiles(napi_env env, napi_value exports);
void exportNetwork(napi_env env, napi_value exports);
}
