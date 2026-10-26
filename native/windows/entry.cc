#include <windows.h>
#include <shlobj.h>
#include <cstdio>
#include <string>

static std::wstring quote(const std::wstring &value) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    result.append(character == L'"' ? backslashes * 2 + 1 : backslashes, L'\\');
    result += character;
    backslashes = 0;
  }
  result.append(backslashes * 2, L'\\');
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
  wchar_t systemDirectory[MAX_PATH];
  UINT length = GetSystemDirectoryW(systemDirectory, MAX_PATH);
  if (!length || length >= MAX_PATH) return fail(L"locate system PowerShell", GetLastError());
  std::wstring powershell =
    std::wstring(systemDirectory) + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
  PWSTR programData = nullptr;
  HRESULT folderStatus = SHGetKnownFolderPath(FOLDERID_ProgramData, 0, nullptr, &programData);
  if (FAILED(folderStatus)) return fail(L"locate ProgramData", static_cast<DWORD>(folderStatus));
  std::wstring script = std::wstring(programData) + L"\\kiteline-agent\\kiteline-agent.ps1";
  CoTaskMemFree(programData);
  if (argc > 1 &&
      (!_wcsicmp(argv[1], L"install") ||
       !_wcsicmp(argv[1], L"upgrade") ||
       !_wcsicmp(argv[1], L"uninstall"))) {
    std::fwprintf(stderr,
      L"Use the separate PowerShell maintenance command from the Kiteline guide or web app.\n");
    return 1;
  }
  std::wstring command =
    quote(powershell) + L" -NoProfile -ExecutionPolicy Bypass -File " + quote(script);
  for (int i = 1; i < argc; ++i) command += L" " + quote(argv[i]);
  if (!SetConsoleCtrlHandler(control, TRUE)) return fail(L"register console handler", GetLastError());
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(powershell.c_str(), command.data(), nullptr, nullptr,
      TRUE, 0, nullptr, nullptr, &startup, &child))
    return fail(L"start PowerShell", GetLastError());
  CloseHandle(child.hThread);
  DWORD waitStatus = WaitForSingleObject(child.hProcess, INFINITE);
  DWORD exitCode = 1;
  if (waitStatus != WAIT_OBJECT_0) {
    DWORD error = GetLastError();
    CloseHandle(child.hProcess);
    return fail(L"wait for PowerShell", error);
  }
  if (!GetExitCodeProcess(child.hProcess, &exitCode)) {
    DWORD error = GetLastError();
    CloseHandle(child.hProcess);
    return fail(L"read PowerShell result", error);
  }
  CloseHandle(child.hProcess);
  return static_cast<int>(exitCode);
}
