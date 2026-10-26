#include "common.hpp"
#include <cstring>

namespace kiteline {
enum class FileOperation { attributes, entry, rename };
struct FileWork {
  napi_async_work work = nullptr;
  napi_deferred result;
  std::wstring source, target;
  FileOperation operation = FileOperation::attributes;
  bool replace = false;
  DWORD error = 0;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  WIN32_FIND_DATAW entry{};
};
static void executeFile(napi_env, void *data) {
  auto &item = *static_cast<FileWork *>(data);
  try {
    if (item.operation == FileOperation::entry) {
      HANDLE search = FindFirstFileW(item.source.c_str(), &item.entry);
      check(search != INVALID_HANDLE_VALUE, "read directory entry");
      check(FindClose(search), "close directory entry search");
      item.attributes.FileAttributes = item.entry.dwFileAttributes;
      item.attributes.ReparseTag = item.entry.dwReserved0;
      return;
    }
    const bool rename = item.operation == FileOperation::rename;
    if (rename && !item.replace) {
      check(MoveFileExW(item.source.c_str(), item.target.c_str(), 0), "rename without replacement");
      return;
    }
    Handle file(CreateFileW(item.source.c_str(), rename ? DELETE : FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    check(file.valid(), "open file without following reparse point");
    if (rename) {
      size_t length = item.target.size() * sizeof(wchar_t);
      std::vector<BYTE> buffer(sizeof(FILE_RENAME_INFO) + length);
      auto info = reinterpret_cast<FILE_RENAME_INFO *>(buffer.data());
      // POSIX replacement can replace a directory link without traversing its target.
      *reinterpret_cast<DWORD *>(info) = 3; // REPLACE_IF_EXISTS | POSIX_SEMANTICS
      info->FileNameLength = static_cast<DWORD>(length);
      std::memcpy(info->FileName, item.target.data(), length);
      BOOL renamed = SetFileInformationByHandle(file.value,
        static_cast<FILE_INFO_BY_HANDLE_CLASS>(22), info, static_cast<DWORD>(buffer.size()));
      if (!renamed && GetLastError() == ERROR_INVALID_PARAMETER) {
        // SMB can reject FileRenameInfoEx while supporting atomic FileRenameInfo.
        info->ReplaceIfExists = TRUE;
        renamed = SetFileInformationByHandle(file.value, FileRenameInfo,
          info, static_cast<DWORD>(buffer.size()));
      }
      check(renamed, "replace file atomically");
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
    if (item->operation != FileOperation::rename) {
      napi_create_object(env, &result);
      napi_set_named_property(env, result, "attributes", number(env, item->attributes.FileAttributes));
      napi_set_named_property(env, result, "tag", number(env, item->attributes.ReparseTag));
      if (item->operation == FileOperation::entry) {
        napi_value size, mtime;
        uint64_t bytes = (uint64_t(item->entry.nFileSizeHigh) << 32) | item->entry.nFileSizeLow;
        uint64_t ticks = (uint64_t(item->entry.ftLastWriteTime.dwHighDateTime) << 32) | item->entry.ftLastWriteTime.dwLowDateTime;
        napi_create_double(env, double(bytes), &size);
        napi_create_double(env, double(ticks / 10000) - 11644473600000.0, &mtime);
        napi_set_named_property(env, result, "size", size);
        napi_set_named_property(env, result, "mtimeMs", mtime);
      }
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
static napi_value directoryEntry(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto item = std::make_unique<FileWork>();
    item->source = string(env, arguments(env, info, 1)[0]);
    item->operation = FileOperation::entry;
    return queueFile(env, std::move(item));
  });
}
static napi_value renameFile(napi_env env, napi_callback_info info) {
  return call(env, [&] {
    auto args = arguments(env, info, 3);
    auto item = std::make_unique<FileWork>();
    item->source = string(env, args[0]); item->target = string(env, args[1]);
    item->operation = FileOperation::rename;
    if (napi_get_value_bool(env, args[2], &item->replace) != napi_ok)
      throw std::invalid_argument("Expected replacement flag");
    return queueFile(env, std::move(item));
  });
}
void exportFiles(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"fileAttributes", nullptr, fileAttributes, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"directoryEntry", nullptr, directoryEntry, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameFile", nullptr, renameFile, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
}
}
