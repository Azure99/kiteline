#include <windows.h>
#include <shlobj.h>
#include <cstdio>
#include <string>

static std::wstring quote(const std::wstring &value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') { ++slashes; continue; }
    result.append(ch == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    result += ch;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}
static int fail(const wchar_t *operation, DWORD error) {
  std::fwprintf(stderr, L"kiteline-agent: %ls failed (Windows error %lu)\n", operation, error);
  return 1;
}
static BOOL WINAPI control(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}
int wmain(int argc, wchar_t **argv) {
  wchar_t system[MAX_PATH];
  UINT length = GetSystemDirectoryW(system, MAX_PATH);
  if (!length || length >= MAX_PATH) return fail(L"locate system PowerShell", GetLastError());
  std::wstring host = std::wstring(system) + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
  PWSTR data = nullptr;
  HRESULT folder = SHGetKnownFolderPath(FOLDERID_ProgramData, 0, nullptr, &data);
  if (FAILED(folder)) return fail(L"locate ProgramData", static_cast<DWORD>(folder));
  std::wstring script = std::wstring(data) + L"\\kiteline-agent\\kiteline-agent.ps1";
  CoTaskMemFree(data);
  if (argc > 1 && (!_wcsicmp(argv[1], L"install") || !_wcsicmp(argv[1], L"upgrade") || !_wcsicmp(argv[1], L"uninstall"))) {
    std::fwprintf(stderr, L"Use the separate PowerShell maintenance command from the Kiteline guide or web app.\n");
    return 1;
  }
  std::wstring command = quote(host) + L" -NoProfile -ExecutionPolicy Bypass -File " + quote(script);
  for (int i = 1; i < argc; ++i) command += L" " + quote(argv[i]);
  if (!SetConsoleCtrlHandler(control, TRUE)) return fail(L"register console handler", GetLastError());
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(host.c_str(), command.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr, &startup, &child))
    return fail(L"start PowerShell", GetLastError());
  CloseHandle(child.hThread);
  DWORD wait = WaitForSingleObject(child.hProcess, INFINITE);
  DWORD code = 1;
  if (wait != WAIT_OBJECT_0) {
    DWORD error = GetLastError();
    CloseHandle(child.hProcess);
    return fail(L"wait for PowerShell", error);
  }
  if (!GetExitCodeProcess(child.hProcess, &code)) {
    DWORD error = GetLastError();
    CloseHandle(child.hProcess);
    return fail(L"read PowerShell result", error);
  }
  CloseHandle(child.hProcess);
  return static_cast<int>(code);
}
