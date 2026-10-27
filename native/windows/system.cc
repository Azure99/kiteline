#include "common.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>

namespace kiteline {
std::vector<BYTE> userSid() {
  Handle token;
  check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "open user token");
  DWORD bytes = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
  std::vector<BYTE> data(bytes);
  check(GetTokenInformation(token.value, TokenUser, data.data(), bytes, &bytes), "read user SID");
  auto sid = reinterpret_cast<TOKEN_USER *>(data.data())->User.Sid;
  std::vector<BYTE> result(GetLengthSid(sid));
  check(CopySid(static_cast<DWORD>(result.size()), result.data(), sid), "copy user SID");
  return result;
}
std::wstring sidText(PSID sid) {
  LPWSTR formattedSid = nullptr;
  check(ConvertSidToStringSidW(sid, &formattedSid), "format user SID");
  std::wstring result(formattedSid);
  LocalFree(formattedSid);
  return result;
}
static std::wstring folder(REFKNOWNFOLDERID id) {
  PWSTR folderPath = nullptr;
  HRESULT status = SHGetKnownFolderPath(id, 0, nullptr, &folderPath);
  if (FAILED(status)) throw WinError{static_cast<DWORD>(status), "read Known Folder"};
  std::wstring result(folderPath);
  CoTaskMemFree(folderPath);
  return result;
}
static napi_value installationDirectories(napi_env env, napi_callback_info) {
  return call(env, [&] {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "programFiles", text(env, folder(FOLDERID_ProgramFiles)));
    napi_set_named_property(env, result, "programData", text(env, folder(FOLDERID_ProgramData)));
    return result;
  });
}
static napi_value identity(napi_env env, napi_callback_info) {
  return call(env, [&] {
    auto sid = userSid();
    napi_value result;
    napi_value roots;
    napi_create_object(env, &result);
    napi_create_array(env, &roots);
    napi_set_named_property(env, result, "sid", text(env, sidText(sid.data())));
    DWORD session;
    check(ProcessIdToSessionId(GetCurrentProcessId(), &session), "read Windows session");
    napi_set_named_property(env, result, "sessionId", number(env, session));
    napi_set_named_property(env, result, "home", text(env, folder(FOLDERID_Profile)));
    napi_set_named_property(env, result, "localAppData", text(env, folder(FOLDERID_LocalAppData)));
    DWORD length = GetLogicalDriveStringsW(0, nullptr);
    check(length != 0, "read drive roots");
    std::vector<wchar_t> drives(length + 1);
    check(GetLogicalDriveStringsW(static_cast<DWORD>(drives.size()), drives.data()) != 0,
      "read drive roots");
    uint32_t index = 0;
    for (const wchar_t *drive = drives.data(); *drive; drive += wcslen(drive) + 1)
      napi_set_element(env, roots, index++, text(env, drive));
    napi_set_named_property(env, result, "roots", roots);
    return result;
  });
}
static napi_value privateDirectory(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto path = string(env, arguments(env, info, 1)[0]);
    auto sid = userSid();
    auto ownerSid = sidText(sid.data());
    auto sddl =
      L"O:" + ownerSid + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + ownerSid + L")";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr), "build directory DACL");
    std::unique_ptr<void, decltype(&LocalFree)> security(descriptor, LocalFree);
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor, FALSE};
    if (!CreateDirectoryW(path.c_str(), &attributes)) {
      DWORD error = GetLastError();
      if (error != ERROR_ALREADY_EXISTS) throw WinError{error, "create private directory"};
      DWORD flags = GetFileAttributesW(path.c_str());
      if (flags == INVALID_FILE_ATTRIBUTES)
        throw WinError{GetLastError(), "read private directory"};
      if (!(flags & FILE_ATTRIBUTE_DIRECTORY) || (flags & FILE_ATTRIBUTE_REPARSE_POINT))
        throw std::runtime_error("Private application directory must be a real directory, not a link");
      PSID owner = nullptr;
      PSECURITY_DESCRIPTOR ownerDescriptor = nullptr;
      DWORD code = GetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        &owner, nullptr, nullptr, nullptr, &ownerDescriptor);
      if (code) throw WinError{code, "read private directory owner"};
      bool sameOwner = EqualSid(owner, sid.data());
      LocalFree(ownerDescriptor);
      if (!sameOwner)
        throw std::runtime_error("Private application directory belongs to another Windows identity");
      PACL dacl = nullptr;
      BOOL present;
      BOOL defaulted;
      check(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted), "read private DACL");
      code = SetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl, nullptr);
      if (code) throw WinError{code, "protect application directory"};
    }
    return nothing(env);
  });
}
static napi_value lock(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto path = string(env, arguments(env, info, 1)[0]);
    auto lockHandle = std::make_unique<Handle>(CreateFileW(
      path.c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
    check(lockHandle->valid(), "open lock file");
    OVERLAPPED offset{};
    check(LockFileEx(lockHandle->value,
      LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK,
      0, 1, 0, &offset), "acquire lock");
    return resource(env, std::move(lockHandle));
  });
}
static napi_value closeHandle(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto handle = external<Handle>(env, arguments(env, info, 1)[0]);
    if (handle->valid()) {
      check(CloseHandle(handle->value), "close native handle");
      handle->value = nullptr;
    }
    return nothing(env);
  });
}
void exportSystem(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"installationDirectories", nullptr, installationDirectories, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"identity", nullptr, identity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"privateDirectory", nullptr, privateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"lock", nullptr, lock, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeHandle", nullptr, closeHandle, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
}
}
