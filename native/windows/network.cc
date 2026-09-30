#include "common.hpp"
#include <iphlpapi.h>
#include <set>

namespace kiteline {
struct NetworkWork {
  napi_async_work work = nullptr;
  napi_deferred result;
  DWORD error = 0;
  std::set<uint32_t> ports;
};
template <class Table, class Fetch> static std::vector<BYTE> snapshot(Fetch fetch) {
  ULONG size = sizeof(Table);
  std::vector<BYTE> data(size);
  for (int attempt = 0; attempt < 3; attempt++) {
    DWORD code = fetch(reinterpret_cast<Table *>(data.data()), &size, FALSE);
    if (!code) return data;
    if (code != ERROR_INSUFFICIENT_BUFFER) throw WinError{code, "read TCP table"};
    data.resize(size);
  }
  throw WinError{ERROR_INSUFFICIENT_BUFFER, "TCP table changed during snapshot"};
}
static void executeNetwork(napi_env, void *data) {
  auto &item = *static_cast<NetworkWork *>(data);
  try {
    auto add = [&](DWORD port) {
      uint32_t value = ntohs(static_cast<u_short>(port));
      if (value) item.ports.insert(value);
    };
    auto ipv4 = snapshot<MIB_TCPTABLE>(GetTcpTable);
    auto table = reinterpret_cast<MIB_TCPTABLE *>(ipv4.data());
    for (DWORD i = 0; i < table->dwNumEntries; i++) {
      auto &row = table->table[i];
      if (row.dwState == MIB_TCP_STATE_LISTEN &&
          (row.dwLocalAddr == 0 || row.dwLocalAddr == htonl(0x7f000001))) add(row.dwLocalPort);
    }
    auto ipv6 = snapshot<MIB_TCP6TABLE>(GetTcp6Table);
    auto table6 = reinterpret_cast<MIB_TCP6TABLE *>(ipv6.data());
    for (DWORD i = 0; i < table6->dwNumEntries; i++) {
      auto &row = table6->table[i];
      if (row.State == MIB_TCP_STATE_LISTEN &&
          (IN6_IS_ADDR_UNSPECIFIED(&row.LocalAddr) || IN6_IS_ADDR_LOOPBACK(&row.LocalAddr))) add(row.dwLocalPort);
    }
  } catch (const WinError &error) { item.error = error.code; }
  catch (...) { item.error = ERROR_NOT_ENOUGH_MEMORY; }
}
static void completeNetwork(napi_env env, napi_status status, void *data) {
  std::unique_ptr<NetworkWork> item(static_cast<NetworkWork *>(data));
  if (status != napi_ok && !item->error) item->error = ERROR_OPERATION_ABORTED;
  if (item->error) {
    napi_value message, error;
    std::string detail = "TCP snapshot failed: Win32 error " + std::to_string(item->error);
    napi_create_string_utf8(env, detail.c_str(), detail.size(), &message);
    napi_create_error(env, nullptr, message, &error);
    napi_set_named_property(env, error, "win32Code", number(env, item->error));
    napi_reject_deferred(env, item->result, error);
  } else {
    napi_value result; napi_create_array_with_length(env, item->ports.size(), &result);
    uint32_t index = 0;
    for (auto port : item->ports) napi_set_element(env, result, index++, number(env, port));
    napi_resolve_deferred(env, item->result, result);
  }
  napi_delete_async_work(env, item->work);
}
static napi_value listeningPorts(napi_env env, napi_callback_info) {
  return call(env, [&] {
    auto item = std::make_unique<NetworkWork>();
    napi_value promise, name; napi_create_promise(env, &item->result, &promise);
    napi_create_string_utf8(env, "kiteline TCP snapshot", NAPI_AUTO_LENGTH, &name);
    if (napi_create_async_work(env, nullptr, name, executeNetwork, completeNetwork, item.get(), &item->work) != napi_ok)
      throw std::runtime_error("Could not prepare TCP snapshot");
    if (napi_queue_async_work(env, item->work) != napi_ok) {
      napi_delete_async_work(env, item->work);
      throw std::runtime_error("Could not queue TCP snapshot");
    }
    item.release(); return promise;
  });
}
void exportNetwork(napi_env env, napi_value exports) {
  napi_property_descriptor property{"listeningPorts", nullptr, listeningPorts, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &property);
}
}
