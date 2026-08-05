# SkillDock 构建说明

SkillDock 是一个 **纯 Go** 程序：本地启动一个 HTTP 服务，用浏览器访问其界面（没有 Wails / WebView2 依赖）。前端 UI 通过 Go 的 `html/template` 做服务端渲染（SSR），静态资源（`templates/`、`static/`）由 `//go:embed` 在编译时直接打进 exe。

## 环境要求

- **Go 1.25 或以上**（见 `go.mod`）。
- 目标平台：**Windows / amd64**（exe 图标与自动开浏览器逻辑针对 Windows；理论上可在 macOS / Linux 编译运行，但 exe 图标资源仅对 Windows 生效）。
- 依赖已全部写入 `go.mod`（`fsnotify`、`golang.org/x/sys`），无需额外安装。

## 必装（推荐）：go-winres

如果你希望编译出来的 `SkillDock.exe` 带有**项目图标**和**版本信息**（而不是系统默认图标），需要先装 `go-winres`：

```bash
go install github.com/tc-hib/go-winres@latest
```

安装后二进制在 `$GOPATH/bin`（Windows 下通常是 `C:\Users\<你>\go\bin`），请确保该目录在 `PATH` 中，或调用时写全路径。

> 如果你不装 go-winres 也完全可以构建，只是 exe 会是默认图标、不带版本信息。

## 构建方式

### 方式一：直接 `go build`（最快）

```bash
# 在项目根目录
go build -o SkillDock.exe .
```

- 如果之前跑过 `go-winres make`，这次构建会自带图标；否则是默认图标。
- 因为 UI 是 `//go:embed` 嵌入的，**任何改了 `internal/server/templates/` 或 `internal/server/static/` 的改动，都必须重新 `go build` 才会生效**。

### 方式二：发布构建脚本（带图标 + 裁剪体积）

```bash
./scripts/build-release.sh
```

脚本会：
1. 先尝试 `go-winres make` 生成 `*.syso` 资源（找不到 go-winres 时告警跳过）；
2. 再执行 `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o build/bin/SkillDock.exe .`（去掉调试符号、体积更小）。

产物在 `build/bin/SkillDock.exe`。

### 关于 go-winres 资源

- 图标/版本信息定义在 `winres/winres.json`，图标帧在 `winres/icon_*.png`（由 `assets/icon.ico` 抽取，原始 ICO 是 PNG 帧编码，go-winres 只认 BMP 帧，所以这里拆成了 PNG）。
- `go-winres make` 会生成 `rsrc_windows_amd64.syso`（和 `rsrc_windows_386.syso`），Go 链接器会自动把它们编进 Windows 构建。
- `*.syso` 已在 `.gitignore` 中，**由 `go-winres make` 重建，不需要提交**；干净检出后第一次构建前记得先 `go-winres make`（发布脚本已自动处理）。

## 运行

```bash
# 直接双击 SkillDock.exe，或命令行：
./SkillDock.exe
```

- 启动后在默认浏览器打开 `http://127.0.0.1:38291`。
- **单实例锁**：通过占用端口实现。若端口已被占用（程序已在运行），再次启动只会帮你打开浏览器并退出，不会起第二个实例。
- 关闭：直接关掉终端 / 结束进程即可（`SIGINT`/`SIGTERM` 优雅退出）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SKILLDOCK_PORT` | `38291` | 监听端口 |
| `SKILLDOCK_HOST` | `127.0.0.1` | 监听地址。本地使用保持 `127.0.0.1`；若要让局域网/容器访问可设 `0.0.0.0` |
| `SKILLDOCK_HOME` | `~/.skilldock` | 数据目录（配置、历史、备份存放处） |
| `SKILLDOCK_NO_BROWSER` | 空（即自动开浏览器） | 设为任意非空值（如 `1`）可禁用自动打开浏览器 |

示例（不自动开浏览器、用其它端口）：

```bash
SKILLDOCK_NO_BROWSER=1 SKILLDOCK_PORT=38999 ./SkillDock.exe
```

## 配置位置

配置文件在 `$SKILLDOCK_HOME/config.json`（默认 `C:\Users\<你>\.skilldock\config.json`）。同步历史的备份在 `$SKILLDOCK_HOME/backups/`。

## 开发期常用命令

```bash
go vet ./...            # 静态检查
go test ./internal/...  # 跑单元测试
go build ./...          # 编译所有包（不产出 exe，用于快速验证）
go build -o SkillDock.exe . && ./SkillDock.exe   # 改完 UI 后重建并运行
```

> 注意：改了 `internal/server/static/app.js`、模板或样式后，必须重新 `go build` 才能让改动生效（它们被嵌入进 exe，不会从磁盘实时读取）。
