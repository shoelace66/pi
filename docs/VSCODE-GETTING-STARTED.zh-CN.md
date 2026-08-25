# AutoPi VS Code 插件零基础使用教程

本文适用于 AutoPi VS Code 插件 `0.84.3`（VS Code `1.85.0` 及以上版本；Windows x64 与 Linux glibc x64），内置 AutoPi Core 版本为 `0.84.1`。插件发布版本与内置 Core 版本分别记录，因此 VS Code 专属修复可以独立发布。平台专用 VSIX 不需要另外安装 Node.js、Python 版客户端或 AutoPi CLI。项目本身需要的训练框架、Python 环境等仍应按项目说明准备。当前不提供 macOS、Windows ARM64 或 Linux ARM64 安装包。

## 1. 下载与校验

从 AutoPi GitHub Release 下载：

- Windows：`AutoPi-0.84.3-win32-x64.vsix` 及同名 `.sha256`
- Linux、Remote SSH 或 WSL：`AutoPi-0.84.3-linux-x64.vsix` 及同名 `.sha256`

可选但推荐：在 VSIX 所在目录打开 PowerShell，运行：

```powershell
Get-FileHash .\AutoPi-0.84.3-win32-x64.vsix -Algorithm SHA256
Get-Content .\AutoPi-0.84.3-win32-x64.vsix.sha256
```

两个 SHA-256 值应完全相同。

Linux 可直接运行：

```bash
sha256sum -c AutoPi-0.84.3-linux-x64.vsix.sha256
```

## 2. 安装 VSIX

1. 打开 VS Code。
2. 按 `Ctrl+Shift+X` 打开“扩展”。
3. 点击扩展面板右上角的 `…`。
4. 选择“从 VSIX 安装…”。
5. 选择与当前扩展宿主匹配的 VSIX。
6. 安装完成后，按提示重新加载窗口。

左侧 Activity Bar 会出现 AutoPi 图标。也可以按 `Ctrl+Shift+P`，运行“AutoPi: 打开侧边栏”。

## 3. 打开并信任项目

选择“文件 → 打开文件夹”，打开要处理的项目。AutoPi 遵循 VS Code Workspace Trust：

- 未受信任时，侧边栏只允许查看，不启动后端，也不执行任何命令。
- 只有你确认项目来源可信并在 VS Code 中授予信任后，AutoPi 才会启用 Agent。

不要为了省事信任来源不明的代码仓库。AutoPi 使用当前系统用户权限运行命令，并不是安全沙箱。

Remote SSH 和 WSL 中，扩展运行在远程 Linux 工作区宿主。请连接远程窗口后把 Linux x64 VSIX 安装到“SSH/WSL：已安装”区域，而不是只安装到 Windows 本地。

## 4. 配置模型和密钥

1. 点击侧边栏空白页的“打开设置”，或打开 VS Code 设置并搜索 `AutoPi`。
2. 按所用服务填写 `AutoPi: Provider` 和 `AutoPi: Model`；留空则使用 AutoPi 当前默认配置。
3. 点击侧边栏的“配置 API 密钥”，或按 `Ctrl+Shift+P` 运行“AutoPi: 配置 API 密钥”。
4. 粘贴密钥并确认。

密钥按“工作区文件夹 + Provider”隔离存入 VS Code SecretStorage，不写入 `settings.json`，也不会出现在后端命令行参数中。重新执行该命令并提交空内容可删除当前工作区和 Provider 的密钥。

## 5. 发送连续任务

在 AutoPi 侧边栏底部直接描述目标。例如：

```text
启动本项目的训练命令。训练成功后运行测试集测试，分析真实输出，并在 reports/eval.md 生成报告；任何阶段失败都停止后续命令并说明原因，不要伪造指标。
```

这只是验收示例，不是固定 CV 模板。AutoPi 会先阅读当前仓库来确定实际命令、输出和报告要求；信息不足时会在执行前询问。你也可以对构建、数据处理、基准测试或其他长流程下达同类指令。

“附带当前文件/选区”默认开启：

- 有选区时，将选中文本及相对文件路径加入本次请求。
- 无选区时，只加入当前文件路径。
- 当前编辑器不属于所选工作区时，不会附带内容。

## 6. AutoPi 会怎样执行

对于预计跨越当前回复的命令，Agent 会使用通用后台任务能力：

1. 启动命令并返回任务 ID、PID 和日志路径。
2. 注册“任务结束”等待，不阻塞侧边栏的其他交互。
3. 任务结束后重新检查状态、退出码、日志和已有产物。
4. 前置阶段成功才启动下一阶段。
5. 失败或取消时停止依赖步骤并给出真实原因。
6. 生成报告后提供“在编辑器中打开”入口。

这套能力同时位于共享核心，CLI、桌面端与 VS Code 端使用一致的任务语义。

## 7. 查看任务、日志和报告

侧边栏会显示：

- 当前模型与执行状态；
- 工具调用及成功/失败状态；
- 活跃或已结束的后台任务和等待任务；
- “打开日志”和“取消”按钮；
- 对话中检测到的项目内生成文件。

点击“打开日志”可在 VS Code 编辑器中查看任务 JSONL/文本日志。点击报告按钮会直接打开工作区内对应文件。测试失败时，报告或回复只能总结实际错误，不应出现虚构指标。

## 8. 多根工作区与生命周期

多根工作区顶部可以切换文件夹。每个访问过的文件夹都有独立 RPC 后端和会话：

- 切换文件夹不会混用任务和日志。
- 隐藏 AutoPi 侧边栏不会停止任务。
- 关闭 VS Code 窗口、重新加载窗口或停用插件会终止该窗口托管的任务进程树。
- 重启后如检测到上次未完成记录，只显示恢复提示，不自动续跑。请先检查产物与日志，再决定是否重新执行。

## 9. 常见问题

### 一直显示“启动中”或“后端启动失败”

先使用错误横幅中的“配置 API 密钥”“打开设置”或“重试”按钮。然后检查：

- 当前工作区是否已受信任；
- Provider、Model 和 API 密钥是否匹配；
- 安全软件或文件权限是否阻止 VSIX 内置的 `autopi.exe`（Windows）或 `autopi`（Linux）；
- 是否把 Windows VSIX 安装到了 Linux 扩展宿主，或反之；
- 错误信息中是否明确提示模型、认证或项目环境缺失。

### 训练结束后没有开始测试

查看后台任务退出码和日志。训练非零退出、被取消或超时后，AutoPi 应停止后续步骤。若训练实际成功但仓库没有明确测试命令，请补充命令或让 Agent 先检查项目说明。

### 如何完全移除

在扩展面板找到 AutoPi，点击“卸载”，再重新加载 VS Code。插件不会安装系统服务；关闭窗口后没有常驻调度器。

## 10. 开发者构建

在 AutoPi 仓库根目录运行：

```powershell
npm install --ignore-scripts
npm run build:vscode
npm run test:vscode
npm run package:vscode:windows
npm run package:vscode:linux
```

产物位于：

```text
.artifacts/vscode/AutoPi-0.84.3-win32-x64.vsix
.artifacts/vscode/AutoPi-0.84.3-win32-x64.vsix.sha256
.artifacts/vscode/AutoPi-0.84.3-linux-x64.vsix
.artifacts/vscode/AutoPi-0.84.3-linux-x64.vsix.sha256
```

Marketplace 正式上架需要 `shoelace66` 发布者凭据；本地 VSIX 和 GitHub Release 分发不需要用户登录 Marketplace。
