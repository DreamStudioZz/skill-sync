#!/usr/bin/env bash
# SkillDock 发布构建脚本
# 用法: ./scripts/build-release.sh
# 说明: 分步执行，规避 vite emptyDir 在受限环境下的删除问题
set -e
cd "$(dirname "$0")/.."

echo "==> [1/3] 清空 frontend/dist"
rm -rf frontend/dist

echo "==> [2/3] 构建前端"
(cd frontend && npm run build)

echo "==> [3/3] 打包 (跳过前端与 bindings 生成)"
export PATH="$PATH:$(go env GOPATH)/bin"
wails build -s -skipbindings

echo ""
echo "✅ 构建完成: build/bin/SkillDock.exe"
