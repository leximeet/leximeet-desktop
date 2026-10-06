#!/usr/bin/env bash
# 工作期间的自动回归入口：准备隔离环境，降低子进程优先级，不打开可见验收应用。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == "--help" && $# == 1 ]]; then
  echo '后台自动回归：bash scripts/test-background.sh'
  echo '可见人工验收：bash scripts/test-desktop.sh'
  exit 0
fi
[[ $# == 0 ]] || { echo '后台入口不接受可见验收参数；使用 --help 查看入口。'; exit 1; }
exec nice -n 10 bash "$task_root/scripts/test-desktop.sh" --verify
