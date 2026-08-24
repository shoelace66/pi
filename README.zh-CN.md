<p align="center">
  <img alt="AutoPi" src="autopi-wordmark-2565.png" width="460">
</p>

<h1 align="center">AutoPi</h1>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  一体化桌面、VS Code 与命令行 AI Agent，能托管长任务，并在计时、文件、进程或任务条件满足后自动继续。
</p>

<p align="center">
  <a href="https://github.com/shoelace66/AutoPi/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/shoelace66/AutoPi?display_name=tag&style=flat-square"></a>
  <a href="https://github.com/shoelace66/AutoPi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/shoelace66/AutoPi/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/shoelace66/AutoPi?style=flat-square"></a>
  <img alt="Windows x64" src="https://img.shields.io/badge/desktop-Windows%20x64-3E56D0?style=flat-square&logo=windows11&logoColor=white">
  <img alt="Linux CLI x64" src="https://img.shields.io/badge/CLI-Linux%20x64-F0B90B?style=flat-square&logo=linux&logoColor=black">
  <img alt="VS Code Windows and Linux x64" src="https://img.shields.io/badge/VS%20Code-0.84.1%20Windows%20%7C%20Linux%20x64-31A8FF?style=flat-square&logo=visualstudiocode&logoColor=white">
</p>

> [!IMPORTANT]
> AutoPi 是 [earendil-works/pi](https://github.com/earendil-works/pi) 的独立维护分支，于 **2026 年 8 月 20 日**完成分叉并固定上游基线。基线为 Pi `0.84.1`、提交 [`31b513e3`](https://github.com/earendil-works/pi/commit/31b513e316ab2b5ec736268350635511297fa3c1)。此后 AutoPi 独立演进，不自动同步后续上游版本。完整来源关系见 [UPSTREAM.md](UPSTREAM.md)。

## 下载与开始使用

### Windows 新手推荐：绿色免安装包

1. 打开 [最新正式版本](https://github.com/shoelace66/AutoPi/releases/latest)。
2. 下载 `AutoPi-0.84.1-win-x64.zip`。
3. 右键 ZIP，选择“全部解压缩”。不要直接在压缩包预览窗口中运行。
4. 双击解压目录里的 `AutoPi.exe`。
5. 点击“打开文件夹”，选择你希望 AutoPi 协助处理的项目目录。
6. 按界面提示选择模型并配置对应服务的 API Key，然后就可以直接描述任务。

发布包根目录自带 `START-HERE-开始使用.txt`、许可证、构建清单和 SHA-256 校验信息。它不写入系统目录，也不需要管理员权限；删除整个文件夹即可移除。

> Windows 可能对尚未进行商业代码签名的新程序显示 SmartScreen 提示。请先确认下载地址属于本仓库，并可用同一 Release 中的 `.sha256` 文件校验；确认无误后再选择“更多信息 → 仍要运行”。

更完整的操作说明见 [零基础使用教程](docs/GETTING-STARTED.zh-CN.md)。

### Linux x64 命令行包

1. 下载 `AutoPi-0.84.1-linux-x64.tar.gz` 和同名 `.sha256`。
2. 运行 `sha256sum -c AutoPi-0.84.1-linux-x64.tar.gz.sha256`。
3. 解压后进入目录，运行 `./autopi`。

Linux 包内置 `autopi`、兼容命令 `pi`、`pi-wake` 和所需运行时，不要求安装 Node.js。支持范围为 Ubuntu 22.04/24.04、Debian 12 等 glibc x64 系统。完整步骤见 [Linux x64 零基础教程](docs/LINUX-GETTING-STARTED.zh-CN.md)。

### VS Code 用户：平台专用 VSIX

1. Windows 下载 `AutoPi-0.84.1-win32-x64.vsix`，Linux/Remote SSH/WSL 下载 `AutoPi-0.84.1-linux-x64.vsix`，并同时下载对应 `.sha256`。
2. 在 VS Code 扩展面板右上角选择“从 VSIX 安装…”。
3. 打开并信任你的项目文件夹。
4. 运行“AutoPi: 配置 API 密钥”，然后从左侧 AutoPi 图标开始使用。

每个 VSIX 都内置与目标平台匹配的 AutoPi x64 后端，不要求另装 Node.js 或 AutoPi CLI。远程工作区必须把 Linux VSIX 安装到远程扩展宿主。完整步骤、校验方式和训练后自动测试示例见 [VS Code 插件零基础教程](docs/VSCODE-GETTING-STARTED.zh-CN.md)。

### 命令行用户

Windows 发布包同时附带：

- `autopi.cmd`：启动 AutoPi CLI；
- `pi.cmd`：兼容原 Pi 命令入口；
- `pi-wake.cmd`：向在线 AutoPi 会话投递 Wake 事件。

Linux 发布包提供无扩展名的 `autopi`、`pi` 和 `pi-wake` 可执行文件。

## AutoPi 能做什么

| 能力 | 说明 |
| --- | --- |
| 桌面工作区 | 图形化会话、项目文件、Git、终端、模型和活动状态；会自动恢复每个工作区最近使用的会话。 |
| VS Code 侧边栏 | 独立于 Copilot/内置 Chat；按工作区隔离会话，显示工具、审批、后台任务、日志和生成文件。 |
| CLI / TUI / SDK / RPC | 保留 Pi 的原生命令行、终端界面、SDK、RPC、会话和扩展兼容性。 |
| 通用后台任务 | 通过 `background_task` 启动长命令，记录任务 ID、PID、退出码、时间和 stdout/stderr 日志，并支持取消。 |
| 自动继续工作 | 通过统一 `outer_loop` 工具等待时间、文件变化、Windows 进程结束或托管任务完成，再恢复同一会话。 |
| Wake 基础设施 | 按会话排队、能力校验、请求去重、本地 IPC、取消和 JSONL 日志。 |
| 明暗主题 | AutoPi Dark 使用 `#090D20` 品牌基调；AutoPi Light 自动切换反色字标与浅色图标。 |
| 可验证交付 | Windows 便携桌面包、Linux x64 CLI、平台专用 VSIX、构建清单和 SHA-256。 |

### 一个“自动继续”的例子

直接告诉 AutoPi：

```text
运行项目构建；如果还没结束就等待这个进程，结束后检查结果并修复错误。
```

也可以让它按时间或文件变化继续：

```text
10 分钟后继续检查日志。
等 output.json 被修改后读取结果并生成报告。
```

也可以一次描述完整流水线：

```text
训练成功后运行测试集测试，分析真实输出，并在 reports/eval.md 生成报告；任何阶段失败都停止后续步骤并说明原因。
```

CV 只是示例。AutoPi 不内置训练框架、数据集字段或固定报告模板；它会从用户指令和当前仓库确定命令、产物与报告格式。

AutoPi 创建等待任务后仍可继续接收其他消息；过时任务可以由你或 Agent 取消。

## 当前边界

- Wake 注册目前随 AutoPi 进程存在；完全退出后不会自动恢复尚未触发的等待任务。
- 后台任务随对应 AutoPi/VS Code 进程存在；关闭宿主时会终止托管进程树，重启后只提示恢复信息，不自动续跑。
- 本地 Wake 只面向在线会话，不提供离线队列、跨机器传输或托管调度服务。
- Linux 首版仅支持 glibc x64，不支持 Alpine/musl、ARM64 或 Electron 桌面端。
- 第三方邮箱、聊天、MCP 等连接器没有捆绑在正式包内，可通过扩展或外部程序接入。
- AutoPi 不是沙箱。它使用当前用户权限读取文件和运行命令，请只打开可信工作区并审查高风险操作。

## 产品结构

```text
AutoPi Desktop   AutoPi VS Code   AutoPi CLI / TUI / SDK / RPC
        \              |                    /
                 AgentSession
                       |
               Pi-compatible loop
                       |
       BackgroundTaskManager + WakeRuntime
       task · timer · file · process · IPC
```

桌面端、VS Code 与命令行并不是三个 Agent：它们共用 `@earendil-works/pi-coding-agent`、模型配置、会话文件、扩展、工具和 Wake 运行时。

## 从源码运行

要求 Node.js `22.19+`。Windows：

```powershell
git clone https://github.com/shoelace66/AutoPi.git
cd AutoPi
npm install --ignore-scripts
npm run build:offline
.\autopi.bat
```

启动命令行：

```powershell
.\autopi.bat --cli
```

macOS / Linux 当前以 CLI 为主：

```bash
git clone https://github.com/shoelace66/AutoPi.git
cd AutoPi
npm install --ignore-scripts
npm run build:offline
./autopi.sh --cli
```

普通 `npm run build` 会尝试刷新在线模型目录；在离线或网络受限环境中优先使用 `npm run build:offline`。

## 开发与验证

```bash
npm run check
npm --workspace @autopi/desktop test
npm run test:vscode
```

创建经过校验的发布包：

```powershell
npm run package:desktop
npm run package:cli:linux
npm run package:vscode:windows
npm run package:vscode:linux
```

输出位于 `.artifacts`：

- `AutoPi-<version>-win-x64/`
- `AutoPi-<version>-win-x64.zip`
- `AutoPi-<version>-win-x64.zip.sha256`
- `cli/AutoPi-0.84.1-linux-x64.tar.gz`
- `cli/AutoPi-0.84.1-linux-x64.tar.gz.sha256`
- `vscode/AutoPi-0.84.1-win32-x64.vsix`
- `vscode/AutoPi-0.84.1-win32-x64.vsix.sha256`
- `vscode/AutoPi-0.84.1-linux-x64.vsix`
- `vscode/AutoPi-0.84.1-linux-x64.vsix.sha256`

每次打包都会再次解压 ZIP，并对构建 ID、组件哈希和目录树摘要执行同构建验证。维护者还可运行 `npm run release:desktop`，把同一构建同步到 `D:\PiDesktop`。

## 仓库导航

| 路径 | 内容 |
| --- | --- |
| [`apps/desktop`](apps/desktop) | AutoPi Electron 桌面应用 |
| [`apps/vscode`](apps/vscode) | AutoPi VS Code 扩展、侧边栏和宿主通信层 |
| [`packages/coding-agent`](packages/coding-agent) | CLI、会话、扩展 API 与 Agent 集成 |
| [`packages/coding-agent/src/core/background-task`](packages/coding-agent/src/core/background-task) | 通用后台命令、日志、状态和进程树清理 |
| [`packages/coding-agent/src/core/wake`](packages/coding-agent/src/core/wake) | Wake 运行时、队列、IPC、能力和日志 |
| [`packages/coding-agent/src/core/outer-loop`](packages/coding-agent/src/core/outer-loop) | 时间、文件、进程监控与 `outer_loop` 工具 |
| [`docs/GETTING-STARTED.zh-CN.md`](docs/GETTING-STARTED.zh-CN.md) | 零基础中文教程 |
| [`docs/VSCODE-GETTING-STARTED.zh-CN.md`](docs/VSCODE-GETTING-STARTED.zh-CN.md) | VSIX 安装、配置与训练后测试示例 |
| [`docs/LINUX-GETTING-STARTED.zh-CN.md`](docs/LINUX-GETTING-STARTED.zh-CN.md) | Linux CLI、VSIX、Remote SSH 与 WSL 教程 |
| [`docs/AUTOPI-DESKTOP.md`](docs/AUTOPI-DESKTOP.md) | 桌面集成与发布说明 |
| [`README-OUTER-LOOP.md`](README-OUTER-LOOP.md) | Wake / Outer Loop 行为和接口细节 |
| [`UPSTREAM.md`](UPSTREAM.md) | 上游基线、继承范围与署名 |

## 贡献与安全

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub 私密安全报告，不要公开披露凭据或可利用细节。

## 上游与许可证

AutoPi 保留 Pi 的 Git 历史、包结构、原生 Agent loop、CLI/TUI/SDK/RPC、扩展接口和 MIT 许可证署名。AutoPi 新增的桌面产品、VS Code 扩展、Wake 运行时、Outer Loop 集成与交付工具同样以 MIT License 发布。

感谢 [Mario Zechner](https://github.com/badlogic) 与 [earendil-works/pi](https://github.com/earendil-works/pi) 的原始工作和所有上游贡献者。详见 [UPSTREAM.md](UPSTREAM.md) 与 [LICENSE](LICENSE)。
