#!/usr/bin/env bash
# 一条命令准备环境并启动独立验收空间；不安装系统 Java，不触碰正式资料。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_entry="accept-desktop.cjs"
case "${1:-}" in
  --connected) task_entry="accept-connected.cjs"; shift ;;
  --journey) task_entry="test-daily-journey.cjs"; shift ;;
esac
task_node=""
task_check=false
for task_arg in "$@"; do
  # 定向回收只需要已有 Node，不应为了清理临时空间重新下载工具。
  [[ "$task_arg" != "--check" && "$task_arg" != "--cleanup" ]] || task_check=true
done
for task_candidate in "${LEXIMEET_NODE:-}" "$(command -v node || true)" "$HOME/Library/PhpWebStudy/env/node/bin/node" "$task_root/.runtime/tools/node/bin/node"; do
  if [[ -n "$task_candidate" && -x "$task_candidate" ]] && "$task_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
    task_node="$task_candidate"; break
  fi
done
if [[ -z "$task_node" ]]; then
  if [[ "$task_check" == true ]]; then
    echo '环境检查未通过：未找到 Node.js 24+。检查模式不会下载或安装工具。正常启动时脚本会自动准备环境。'
    exit 1
  fi
  task_os="$(uname -s)"; task_arch="$(uname -m)"
  case "$task_os" in Darwin) task_os=darwin;; Linux) task_os=linux;; *) echo '请安装 Node.js 24+，然后运行 npm run accept:desktop'; exit 1;; esac
  case "$task_arch" in arm64|aarch64) task_arch=arm64;; x86_64) task_arch=x64;; *) echo '暂不支持这个 CPU 的自动环境准备'; exit 1;; esac
  task_archive="node-v24.14.0-$task_os-$task_arch.tar.gz"
  task_tools="$task_root/.runtime/tools"; mkdir -p "$task_tools"
  task_download() {
    local task_url="$1" task_output="$2"
    curl -fL --connect-timeout 10 --max-time 240 "$task_url" -o "$task_output" && return 0
    curl -fL --proxy http://127.0.0.1:7897 --connect-timeout 10 --max-time 240 "$task_url" -o "$task_output" && return 0
    curl -fL --proxy http://127.0.0.1:12334 --connect-timeout 10 --max-time 240 "$task_url" -o "$task_output"
  }
  echo '正在准备项目内 Node.js 24.14.0…'
  task_download "https://nodejs.org/dist/v24.14.0/SHASUMS256.txt" "$task_tools/node-shasums.txt"
  task_download "https://nodejs.org/dist/v24.14.0/$task_archive" "$task_tools/$task_archive"
  task_expected="$(awk -v name="$task_archive" '$2==name {print $1}' "$task_tools/node-shasums.txt")"
  task_actual="$(shasum -a 256 "$task_tools/$task_archive" | awk '{print $1}')"
  [[ -n "$task_expected" && "$task_expected" == "$task_actual" ]] || { echo 'Node.js 校验失败，拒绝启动'; exit 1; }
  task_unpack="$(mktemp -d "$task_tools/node-install-XXXXXX")"
  tar -xzf "$task_tools/$task_archive" -C "$task_unpack" --strip-components=1
  [[ ! -e "$task_tools/node" ]] || { echo '已有项目内 Node 目录，请检查它后重试'; exit 1; }
  mv "$task_unpack" "$task_tools/node"
  task_node="$task_tools/node/bin/node"
fi
export PATH="$(dirname "$task_node"):$PATH"
if [[ "$task_entry" == "test-daily-journey.cjs" ]]; then
  # 只读检查不启动测试进程，无需调整优先级，也不应产生沙箱权限警告。
  if [[ "$task_check" == true ]]; then
    exec "$task_node" "$task_root/scripts/$task_entry" "$@"
  fi
  exec nice -n 10 "$task_node" "$task_root/scripts/$task_entry" "$@"
fi
exec "$task_node" "$task_root/scripts/$task_entry" "$@"
