#!/usr/bin/env bash
# SkillDock 发布构建脚本（纯 Go，无 Wails / 无 WebView2）
# 用法: ./scripts/build-release.sh
set -e
cd "$(dirname "$0")/.."

OUT="build/bin/SkillDock.exe"
mkdir -p "$(dirname "$OUT")"

echo "==> 构建纯 Go 可执行文件"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT" .

echo ""
echo "✅ 构建完成: $OUT"
echo "   运行即可在浏览器打开 http://127.0.0.1:38291"
