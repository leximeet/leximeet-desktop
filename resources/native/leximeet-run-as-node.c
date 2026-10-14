/* 词遇 Windows 启动器：按旁路 .launch 配置以 ELECTRON_RUN_AS_NODE 拉起随包 Electron。
 * 同时提供 --protect-file / --set-pipe-acl，供本机私有文件与命名管道收紧 DACL。 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shellapi.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "advapi32")
#pragma comment(lib, "shell32")

static void fail(const wchar_t *code) {
  fwprintf(stderr, L"LEXIMEET_STUB_%s\n", code);
  ExitProcess(1);
}

static int apply_current_user_dacl(const wchar_t *object_name, SE_OBJECT_TYPE type) {
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &needed);
  TOKEN_USER *user = (TOKEN_USER *)LocalAlloc(LPTR, needed);
  if (!user || !GetTokenInformation(token, TokenUser, user, needed, &needed)) {
    DWORD err = GetLastError();
    if (user) LocalFree(user);
    CloseHandle(token);
    return err;
  }
  EXPLICIT_ACCESSW ea[2];
  ZeroMemory(ea, sizeof(ea));
  ea[0].grfAccessPermissions = GENERIC_ALL;
  ea[0].grfAccessMode = SET_ACCESS;
  ea[0].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  ea[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  ea[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  ea[0].Trustee.ptstrName = (LPWSTR)user->User.Sid;

  PSID system_sid = NULL;
  SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY;
  AllocateAndInitializeSid(&nt, 1, SECURITY_LOCAL_SYSTEM_RID, 0, 0, 0, 0, 0, 0, 0, &system_sid);
  ea[1].grfAccessPermissions = GENERIC_ALL;
  ea[1].grfAccessMode = SET_ACCESS;
  ea[1].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  ea[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  ea[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  ea[1].Trustee.ptstrName = (LPWSTR)system_sid;

  PACL dacl = NULL;
  DWORD rc = SetEntriesInAclW(2, ea, NULL, &dacl);
  if (rc == ERROR_SUCCESS) {
    rc = SetNamedSecurityInfoW(
        (LPWSTR)object_name, type,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, dacl, NULL);
  }
  if (dacl) LocalFree(dacl);
  if (system_sid) FreeSid(system_sid);
  LocalFree(user);
  CloseHandle(token);
  return rc;
}

static void read_sidecar(const wchar_t *exe, wchar_t *electron, wchar_t *script,
                         wchar_t prefix[][MAX_PATH], int *prefix_count) {
  wchar_t sidecar[MAX_PATH];
  wcsncpy(sidecar, exe, MAX_PATH - 8);
  sidecar[MAX_PATH - 8] = 0;
  wcscat(sidecar, L".launch");
  HANDLE file = CreateFileW(sidecar, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) fail(L"LAUNCH_MISSING");
  char buf[8192];
  DWORD n = 0;
  if (!ReadFile(file, buf, sizeof(buf) - 1, &n, NULL)) {
    CloseHandle(file);
    fail(L"LAUNCH_READ");
  }
  CloseHandle(file);
  buf[n] = 0;
  electron[0] = script[0] = 0;
  *prefix_count = 0;
  char *line = buf;
  while (line && *line) {
    char *end = strchr(line, '\n');
    if (end) *end = 0;
    if (end && end > line && end[-1] == '\r') end[-1] = 0;
    wchar_t wide[MAX_PATH];
    MultiByteToWideChar(CP_UTF8, 0, line, -1, wide, MAX_PATH);
    if (wcsncmp(wide, L"electron=", 9) == 0) wcsncpy(electron, wide + 9, MAX_PATH);
    else if (wcsncmp(wide, L"script=", 7) == 0) wcsncpy(script, wide + 7, MAX_PATH);
    else if (wcsncmp(wide, L"arg=", 4) == 0 && *prefix_count < 8) {
      wcsncpy(prefix[*prefix_count], wide + 4, MAX_PATH);
      (*prefix_count)++;
    }
    line = end ? end + 1 : NULL;
  }
  if (!electron[0] || !script[0]) fail(L"LAUNCH_INCOMPLETE");
}

static void launch_electron(int argc, wchar_t **argv) {
  wchar_t exe[MAX_PATH];
  if (!GetModuleFileNameW(NULL, exe, MAX_PATH)) fail(L"SELF_PATH");
  wchar_t electron[MAX_PATH], script[MAX_PATH], prefix[8][MAX_PATH];
  int prefix_count = 0;
  read_sidecar(exe, electron, script, prefix, &prefix_count);

  SetEnvironmentVariableW(L"NODE_OPTIONS", NULL);
  SetEnvironmentVariableW(L"NODE_PATH", NULL);
  SetEnvironmentVariableW(L"ELECTRON_NO_ASAR", NULL);
  SetEnvironmentVariableW(L"ELECTRON_ENABLE_LOGGING", NULL);
  SetEnvironmentVariableW(L"ELECTRON_LOG_FILE", NULL);
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1");

  wchar_t cmdline[32768];
  cmdline[0] = 0;
  wcscat(cmdline, L"\"");
  wcscat(cmdline, electron);
  wcscat(cmdline, L"\" \"");
  wcscat(cmdline, script);
  wcscat(cmdline, L"\"");
  for (int i = 0; i < prefix_count; i++) {
    wcscat(cmdline, L" \"");
    wcscat(cmdline, prefix[i]);
    wcscat(cmdline, L"\"");
  }
  for (int i = 1; i < argc; i++) {
    wcscat(cmdline, L" \"");
    wcscat(cmdline, argv[i]);
    wcscat(cmdline, L"\"");
  }

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  ZeroMemory(&pi, sizeof(pi));
  if (!CreateProcessW(electron, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi))
    fail(L"CREATE_PROCESS");
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  ExitProcess(code);
}

int main(void) {
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) fail(L"ARGV");
  if (argc >= 3 && wcscmp(argv[1], L"--protect-file") == 0) {
    DWORD rc = apply_current_user_dacl(argv[2], SE_FILE_OBJECT);
    LocalFree(argv);
    if (rc != ERROR_SUCCESS) fail(L"PROTECT_FILE");
    return 0;
  }
  if (argc >= 3 && wcscmp(argv[1], L"--set-pipe-acl") == 0) {
    DWORD rc = apply_current_user_dacl(argv[2], SE_KERNEL_OBJECT);
    LocalFree(argv);
    if (rc != ERROR_SUCCESS) fail(L"SET_PIPE_ACL");
    return 0;
  }
  launch_electron(argc, argv);
  LocalFree(argv);
  return 0;
}
