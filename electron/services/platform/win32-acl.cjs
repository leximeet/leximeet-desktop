"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const {
  currentWindowsAccount,
  currentWindowsSid,
  windowsSystem32Binary,
} = require("./identity.cjs");
const { runPowerShell } = require("./powershell.cjs");

const FORBIDDEN_TRUSTEES = [
  /Everyone/i,
  /BUILTIN\\Users/i,
  /NT AUTHORITY\\Authenticated Users/i,
  /\*S-1-1-0/,
  /\*S-1-5-11/,
  /\*S-1-5-32-545/,
];

/** 命名管道 DACL 禁止的受信者：Everyone / 匿名 / Authenticated Users / Users。 */
const PIPE_FORBIDDEN_SIDS = Object.freeze(["S-1-1-0", "S-1-5-7", "S-1-5-11", "S-1-5-32-545"]);
const PIPE_FORBIDDEN_ALIASES = Object.freeze(["WD", "AN", "AU", "BU"]);

function runIcacls(args, { timeout = 15000 } = {}) {
  return execFileSync(windowsSystem32Binary("icacls.exe"), args, {
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
 * 路径经 $env:LEXIMEET_PIPE_PATH 传入，避免 JSON.stringify 嵌进 PowerShell
 * 双引号后反斜杠被当成字面量，变成 Restrict("\\\\.\\pipe\\...")。
 */
function namedPipeAclScript(entryPoint) {
  if (!["Restrict", "Inspect"].includes(entryPoint)) throw new Error("INVALID_PIPE_ACL_ENTRY");
  return [
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
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  static extern int GetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr sd);",
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    "  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, out uint size);",
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, uint rev, uint info, out IntPtr str, out uint size);",
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    "  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);",
    '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);',
    "  static string[] Names(string pipe) {",
    '    var shortName = pipe.StartsWith(@"\\\\.\\pipe\\") ? pipe.Substring(9) : pipe;',
    "    return new[] { pipe, shortName };",
    "  }",
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
    "      int last = 0;",
    "      foreach (var name in Names(pipe)) {",
    "        int rc = SetNamedSecurityInfo(name, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);",
    "        if (rc == 0) return;",
    "        last = rc;",
    "      }",
    "      throw new System.ComponentModel.Win32Exception(last);",
    "    } finally { LocalFree(sd); }",
    "  }",
    "  public static string Inspect(string pipe) {",
    "    int last = 0;",
    "    foreach (var name in Names(pipe)) {",
    "      IntPtr dacl, sd;",
    "      int rc = GetNamedSecurityInfo(name, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);",
    "      if (rc != 0) { last = rc; continue; }",
    "      try {",
    "        IntPtr str; uint size;",
    "        if (!ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, DACL_SECURITY_INFORMATION, out str, out size))",
    "          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());",
    "        try { return Marshal.PtrToStringUni(str); }",
    "        finally { LocalFree(str); }",
    "      } finally { LocalFree(sd); }",
    "    }",
    "    throw new System.ComponentModel.Win32Exception(last);",
    "  }",
    "}",
    "'@",
    `[LexiMeetPipeAcl]::${entryPoint}($env:LEXIMEET_PIPE_PATH)`,
  ].join("\n");
}

function runNamedPipeAcl(pipePath, entryPoint) {
  if (process.platform !== "win32") throw new Error("NAMED_PIPE_ACL_PLATFORM");
  if (!pipePath) throw new Error("NAMED_PIPE_ACL_PATH");
  return runPowerShell(namedPipeAclScript(entryPoint), {
    timeout: 30000,
    env: { ...process.env, LEXIMEET_PIPE_PATH: pipePath },
  });
}

/**
 * 收紧已监听命名管道的 DACL：当前用户 + SYSTEM。
 * Node 默认 DACL 仍给 Everyone / 匿名读权限，不是独占；失败必须由调用方关闭监听。
 */
function restrictNamedPipe(pipePath) {
  if (process.platform !== "win32") return;
  runNamedPipeAcl(pipePath, "Restrict");
}

function inspectNamedPipe(pipePath) {
  return String(runNamedPipeAcl(pipePath, "Inspect") || "").trim();
}

function aceSidPattern(sid) {
  const escaped = String(sid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\([^)]*;${escaped}\\)`, "i");
}

/** 断言管道 DACL 只有当前用户（按设计可含 SYSTEM），没有 Everyone / Users / 匿名。 */
function assertNamedPipeExclusive(sddl, { sid = currentWindowsSid() } = {}) {
  const text = String(sddl || "");
  if (!text) throw new Error("UNSAFE_NAMED_PIPE_DACL");
  for (const forbidden of PIPE_FORBIDDEN_SIDS) {
    if (aceSidPattern(forbidden).test(text)) throw new Error("UNSAFE_NAMED_PIPE_DACL");
  }
  for (const alias of PIPE_FORBIDDEN_ALIASES) {
    if (aceSidPattern(alias).test(text)) throw new Error("UNSAFE_NAMED_PIPE_DACL");
  }
  if (!sid || !text.includes(sid)) throw new Error("UNSAFE_NAMED_PIPE_DACL");
  return {
    sddl: text,
    hasSystem: aceSidPattern("S-1-5-18").test(text) || aceSidPattern("SY").test(text),
  };
}

module.exports = {
  protectWindowsPath,
  assertWindowsPrivate,
  restrictNamedPipe,
  inspectNamedPipe,
  assertNamedPipeExclusive,
  namedPipeAclScript,
  icaclsListing,
  FORBIDDEN_TRUSTEES,
  PIPE_FORBIDDEN_SIDS,
};
