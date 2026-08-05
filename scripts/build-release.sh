#!/usr/bin/env bash
# SkillDock 发布构建脚本（纯 Go，无 Wails / 无 WebView2）
# 用法: ./scripts/build-release.sh
set -e
cd "$(dirname "$0")/.."

OUT="build/bin/SkillDock.exe"
mkdir -p "$(dirname "$OUT")"

# 生成 Windows 资源（exe 图标 / 版本信息），需要 go-winres：
#   go install github.com/tc-hib/go-winres@latest
if command -v go-winres >/dev/null 2>&1; then
  echo "==> 生成 Windows 资源 (go-winres make)"
  go-winres make
else
  echo "⚠️ 未找到 go-winres，跳过图标/版本资源生成（exe 将使用默认图标）"
  echo "   安装: go install github.com/tc-hib/go-winres@latest"
fi

echo "==> 构建纯 Go 可执行文件"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT" .

echo ""
echo "✅ 构建完成: $OUT"
echo "   运行即可在浏览器打开 http://127.0.0.1:38291"
