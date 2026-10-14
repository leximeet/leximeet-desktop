"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { currentWindowsAccount, currentWindowsSid } = require("./identity.cjs");

const FORBIDDEN_TRUSTEES = [
  /Everyone/i,
  /BUILTIN\\Users/i,
  /NT AUTHORITY\\Authenticated Users/i,
  /\*S-1-1-0/,
  /\*S-1-5-11/,
  /\*S-1-5-32-545/,
];

function runIcacls(args, { timeout = 15000 } = {}) {
  return execFileSync("icacls", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
}

/**
 * 禁用继承后只保留当前用户完全控制，并去掉 Users / Everyone。
 * SYSTEM 若仍残留可接受；断言时拒绝 Everyone/Users 可写。
 */
function protectWindowsPath(target) {
  if (process.platform !== "win32") return target;
  const account = currentWindowsAccount();
  const directory = fs.lstatSync(target).isDirectory();
  // 目录带 (OI)(CI) 让子项继承；文件只能 (F)，否则 icacls 不写入当前用户 ACE。
  const grant = `${account}:${directory ? "(OI)(CI)(F)" : "(F)"}`;
  runIcacls([target, "/inheritance:r", "/grant:r", grant, "/Q"]);
  for (const group of [
    "Everyone",
    "Users",
    "Authenticated Users",
    "*S-1-1-0",
    "*S-1-5-11",
    "*S-1-5-32-545",
  ]) {
    try {
      runIcacls([target, "/remove:g", group, "/Q"]);
    } catch {
      // 组本来就不在 DACL 上。
    }
  }
  assertWindowsPrivate(target);
  return target;
}

function icaclsListing(target) {
  return runIcacls([target]);
}

function assertWindowsPrivate(target) {
  if (process.platform !== "win32") return;
  const listing = icaclsListing(target);
  for (const pattern of FORBIDDEN_TRUSTEES) {
    if (pattern.test(listing)) throw new Error("UNSAFE_PRIVATE_PATH");
  }
  const sid = currentWindowsSid();
  const account = currentWindowsAccount();
  const accountTail = account.split("\\").pop();
  const listingLower = listing.toLowerCase();
  const ownerOk =
    listingLower.includes(account.toLowerCase()) ||
    (accountTail && listingLower.includes(accountTail.toLowerCase())) ||
    (sid && listing.includes(sid));
  if (!ownerOk) throw new Error("UNSAFE_PRIVATE_PATH");
}

/**
 * 收紧已监听命名管道的 DACL：当前用户 + SYSTEM。
 * Node listen 默认已排除 Everyone；此处再用 Win32 API 明确覆盖。
 */
function restrictNamedPipe(pipePath) {
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Security.AccessControl;",
    "using System.Security.Principal;",
    "public static class LexiMeetPipeAcl {",
    "  const int SE_KERNEL_OBJECT = 6;",
    "  const uint DACL_SECURITY_INFORMATION = 4;",
    "  const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;",
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  static extern int SetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);",
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    "  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, out uint size);",
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    "  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);",
    '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);',
    "  public static void Restrict(string pipe) {",
    "    var user = WindowsIdentity.GetCurrent().User;",
    "    var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);",
    '    var sddl = "D:P(A;;GA;;;" + user.Value + ")(A;;GA;;;" + system.Value + ")";',
    "    IntPtr sd; uint size;",
    "    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, out size))",
    "      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());",
    "    try {",
    "      bool present, defaulted; IntPtr dacl;",
    "      if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted) || !present)",
    '        throw new InvalidOperationException("NO_DACL");',
    "      int rc = SetNamedSecurityInfo(pipe, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);",
    "      if (rc != 0) throw new System.ComponentModel.Win32Exception(rc);",
    "    } finally { LocalFree(sd); }",
    "  }",
    "}",
    "'@",
    `[LexiMeetPipeAcl]::Restrict(${JSON.stringify(pipePath)})`,
  ].join("\n");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
}

module.exports = {
  protectWindowsPath,
  assertWindowsPrivate,
  restrictNamedPipe,
  icaclsListing,
  FORBIDDEN_TRUSTEES,
};
