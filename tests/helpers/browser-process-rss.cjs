"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// 将 ps 的 KiB RSS 清单解析为进程树节点；命令列保留空格以匹配独立 profile。
function parseProcessRows(output) {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKiB: Number(match[3]),
            command: match[4],
          },
        ]
      : [];
  });
}

// Windows CIM 的工作集用字节表示；坏行不能静默变成零内存样本。
function parseWindowsProcessRows(output) {
  const value = JSON.parse(output);
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) throw new Error("Windows 进程清单为空");
  return items.flatMap((item) => {
    const pid = Number(item.ProcessId);
    const ppid = Number(item.ParentProcessId);
    const rssBytes = Number(item.WorkingSetSize);
    if (pid === 0) return [];
    if (
      !Number.isInteger(pid) ||
      pid < 0 ||
      !Number.isInteger(ppid) ||
      ppid < 0 ||
      item.WorkingSetSize == null ||
      item.WorkingSetSize === "" ||
      !Number.isFinite(rssBytes) ||
      rssBytes < 0
    )
      throw new Error("Windows 进程清单包含无效 PID 或工作集");
    return [
      {
        pid,
        ppid,
        rssKiB: rssBytes / 1024,
        command: typeof item.CommandLine === "string" ? item.CommandLine : "",
      },
    ];
  });
}

// Windows 命令列可能给 profile 加引号，路径大小写也不稳定；仍要求参数值完整相等。
function belongsToProfile(command, profile, platform) {
  const text = platform === "win32" ? command.toLowerCase() : command;
  const value = platform === "win32" ? profile.toLowerCase() : profile;
  if (text.includes(`--user-data-dir="${value}"`)) return true;
  const marker = `--user-data-dir=${value}`;
  const start = text.indexOf(marker);
  return (
    start >= 0 && (start + marker.length === text.length || /\s/.test(text[start + marker.length]))
  );
}

// 仅以本例 --user-data-dir 定位浏览器根进程，再汇总其子进程；不按全局 Chrome 名称猜测。
function profileProcessTree(rows, profile, platform = process.platform) {
  const roots = rows.filter(
    (row) => belongsToProfile(row.command, profile, platform) && !row.command.includes("--type="),
  );
  if (roots.length !== 1) throw new Error(`本例 Chromium 根进程数量异常：${roots.length}`);
  const children = new Map();
  for (const row of rows) {
    const siblings = children.get(row.ppid) || [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const pending = [roots[0]];
  const visited = new Set();
  let totalKiB = 0;
  while (pending.length) {
    const row = pending.pop();
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    totalKiB += row.rssKiB;
    pending.push(...(children.get(row.pid) || []));
  }
  return { processCount: visited.size, rssBytes: totalKiB * 1024 };
}

// 离散采样本例 Chromium 进程树 RSS；共享页可能被重复计入，不能当作唯一物理占用。
async function startBrowserProcessRssSampler(profile) {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    throw new Error(`尚不支持测量 ${process.platform} 的 Chromium 进程树 RSS`);
  }
  const samples = [];
  let stopped = false;
  let failure;
  async function sample() {
    if (process.platform === "win32") {
      // PowerShell 仅读进程元数据，命令列只用于定位本例 profile，不写入报告或日志。
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress -Depth 2",
        ],
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          timeout: 15000,
        },
      );
      samples.push(profileProcessTree(parseWindowsProcessRows(stdout), profile));
    } else {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      samples.push(profileProcessTree(parseProcessRows(stdout), profile));
    }
  }
  await sample();
  const loop = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 750 : 250));
      if (stopped) break;
      try {
        await sample();
      } catch (error) {
        failure = error;
        break;
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      if (failure) throw failure;
      // 收尾时再读取一次，避免恰好错过操作完成前后的最后一个采样窗口。
      await sample();
      if (samples.length < 2) throw new Error("本例 Chromium 进程树 RSS 采样不足");
      return {
        supported: true,
        method:
          process.platform === "win32"
            ? "Windows CIM 进程树各进程 WorkingSetSize 求和（共享页可能重复计入）"
            : "ps 进程树各进程 RSS 求和（共享页可能重复计入）",
        samples: samples.length,
        firstRssBytes: samples[0].rssBytes,
        lastRssBytes: samples.at(-1).rssBytes,
        peakRssBytes: Math.max(...samples.map((item) => item.rssBytes)),
        peakProcessCount: Math.max(...samples.map((item) => item.processCount)),
      };
    },
  };
}

module.exports = {
  parseProcessRows,
  parseWindowsProcessRows,
  profileProcessTree,
  startBrowserProcessRssSampler,
};
