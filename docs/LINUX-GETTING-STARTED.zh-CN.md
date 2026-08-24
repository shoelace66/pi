# AutoPi Linux x64 零基础教程

AutoPi Linux 首版面向使用 glibc 的 x64 系统，已纳入 Ubuntu 22.04、Ubuntu 24.04 和 Debian 12 验收范围。它不支持 Alpine/musl、ARM64，也暂不包含 Linux Electron 桌面端。

## 使用命令行包

从同一个 GitHub Release 下载：

- `AutoPi-0.84.1-linux-x64.tar.gz`
- `AutoPi-0.84.1-linux-x64.tar.gz.sha256`

在下载目录打开终端并执行：

```bash
sha256sum -c AutoPi-0.84.1-linux-x64.tar.gz.sha256
mkdir AutoPi-0.84.1-linux-x64
tar -xzf AutoPi-0.84.1-linux-x64.tar.gz -C AutoPi-0.84.1-linux-x64
cd AutoPi-0.84.1-linux-x64
./autopi
```

校验结果必须显示 `OK`。如果系统提示没有执行权限，运行一次：

```bash
chmod u+x autopi pi pi-wake
```

`autopi` 是正式命令，`pi` 是兼容入口，`pi-wake` 用于向仍在线的 AutoPi 会话投递 Wake 事件。发行包已经包含运行时，不要求安装 Node.js。

首次启动后，在 AutoPi 中选择模型并按提供商要求登录或配置 API Key。只在可信项目目录内运行 AutoPi，并审查写文件、运行命令等高风险操作。

## 安装 Linux VS Code 插件

下载 `AutoPi-0.84.1-linux-x64.vsix` 及同名 `.sha256` 文件，然后校验：

```bash
sha256sum -c AutoPi-0.84.1-linux-x64.vsix.sha256
code --install-extension AutoPi-0.84.1-linux-x64.vsix
```

也可以在 VS Code 扩展面板右上角选择“从 VSIX 安装…”。打开项目后：

1. 建立工作区信任；未受信任工作区只能查看，不能执行命令。
2. 运行“AutoPi: 配置 API 密钥”。
3. 点击活动栏中的 AutoPi 图标。
4. 用自然语言描述任务，例如：

```text
训练成功后运行测试集，分析真实输出并在 reports/eval.md 生成报告；任何阶段失败都停止后续步骤并说明原因。
```

侧边栏会显示工具调用、审批、后台任务和日志。报告生成后可直接从消息中的文件入口在编辑器打开。

## Remote SSH 与 WSL

AutoPi 是工作区扩展，必须安装在代码实际所在的扩展宿主：

- Linux 本地项目：安装 Linux x64 VSIX 到本地 VS Code。
- Windows 连接 Linux Remote SSH：连接远程主机后，在远程扩展面板选择“从 VSIX 安装…”。
- WSL 项目：打开 WSL 窗口后，将 Linux x64 VSIX 安装到 WSL 扩展宿主。

不要把 Windows x64 VSIX 安装到 Linux 远程宿主；AutoPi 会检查内置后端平台和构建清单，并拒绝启动不匹配的包。

## 自动化生命周期

后台训练、测试和报告任务只在对应 AutoPi CLI 或 VS Code 进程存活时运行。退出宿主会终止托管进程树；重新打开后只显示恢复提示，不会自动重复训练或测试。
