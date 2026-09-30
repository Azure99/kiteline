#include "common.hpp"
#include <cstring>

namespace kiteline {
struct FileWork {
  napi_async_work work = nullptr;
  napi_deferred result;
  std::wstring source, target;
  bool rename = false, replace = false;
  DWORD error = 0;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
};
static void executeFile(napi_env, void *data) {
  auto &item = *static_cast<FileWork *>(data);
  try {
    if (item.rename && !item.replace) {
      check(MoveFileExW(item.source.c_str(), item.target.c_str(), 0), "rename without replacement");
      return;
    }
    Handle file(CreateFileW(item.source.c_str(), item.rename ? DELETE : FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    check(file.valid(), "open file without following reparse point");
    if (item.rename) {
      size_t length = item.target.size() * sizeof(wchar_t);
      std::vector<BYTE> buffer(sizeof(FILE_RENAME_INFO) + length);
      auto info = reinterpret_cast<FILE_RENAME_INFO *>(buffer.data());
      // POSIX replacement can replace a directory link without traversing its target.
      *reinterpret_cast<DWORD *>(info) = 3; // REPLACE_IF_EXISTS | POSIX_SEMANTICS
      info->FileNameLength = static_cast<DWORD>(length);
      std::memcpy(info->FileName, item.target.data(), length);
      check(SetFileInformationByHandle(file.value, static_cast<FILE_INFO_BY_HANDLE_CLASS>(22),
        info, static_cast<DWORD>(buffer.size())), "replace file atomically");
    } else {
      check(GetFileInformationByHandleEx(file.value, FileAttributeTagInfo,
        &item.attributes, sizeof(item.attributes)), "read reparse attributes");
    }
  } catch (const WinError &error) { item.error = error.code; }
  catch (...) { item.error = ERROR_NOT_ENOUGH_MEMORY; }
}
static void completeFile(napi_env env, napi_status status, void *data) {
  std::unique_ptr<FileWork> item(static_cast<FileWork *>(data));
  if (status != napi_ok && !item->error) item->error = ERROR_OPERATION_ABORTED;
  if (item->error) {
    int code = uv_translate_sys_error(item->error);
    napi_value error, name, message;
    napi_create_string_utf8(env, uv_err_name(code), NAPI_AUTO_LENGTH, &name);
    napi_create_string_utf8(env, uv_strerror(code), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, name, message, &error);
    napi_set_named_property(env, error, "win32Code", number(env, item->error));
    napi_reject_deferred(env, item->result, error);
  } else {
    napi_value result = nothing(env);
    if (!item->rename) {
      napi_create_object(env, &result);
      napi_set_named_property(env, result, "attributes", number(env, item->attributes.FileAttributes));
      napi_set_named_property(env, result, "tag", number(env, item->attributes.ReparseTag));
    }
    napi_resolve_deferred(env, item->result, result);
  }
  napi_delete_async_work(env, item->work);
}
static napi_value queueFile(napi_env env, std::unique_ptr<FileWork> item) {
  napi_value promise, name;
  napi_create_promise(env, &item->result, &promise);
  napi_create_string_utf8(env, "kiteline file operation", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, executeFile, completeFile, item.get(), &item->work) != napi_ok)
    throw std::runtime_error("Could not prepare file operation");
  if (napi_queue_async_work(env, item->work) != napi_ok) {
    napi_delete_async_work(env, item->work);
    throw std::runtime_error("Could not queue file operation");
  }
  item.release();
  return promise;
}
static napi_value fileAttributes(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto item = std::make_unique<FileWork>();
    item->source = string(env, arguments(env, info, 1)[0]);
    return queueFile(env, std::move(item));
  });
}
static napi_value renameFile(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto args = arguments(env, info, 3);
    auto item = std::make_unique<FileWork>();
    item->source = string(env, args[0]); item->target = string(env, args[1]); item->rename = true;
    if (napi_get_value_bool(env, args[2], &item->replace) != napi_ok)
      throw std::invalid_argument("Expected replacement flag");
    return queueFile(env, std::move(item));
  });
}
void exportFiles(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"fileAttributes", nullptr, fileAttributes, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameFile", nullptr, renameFile, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
}
}
