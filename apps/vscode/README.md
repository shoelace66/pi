# AutoPi for Visual Studio Code

AutoPi 把同一个通用自动化 Agent 带进 VS Code 侧边栏。它可以启动并监控长任务，在前置任务成功后继续执行后续步骤，并把报告或其他生成文件直接在编辑器中打开。

## 主要能力

- 自然语言连续任务，不需要编写专用工作流配置。
- 每个工作区文件夹独立的 AutoPi RPC 后端与会话。
- 后台任务、等待任务、退出码、日志、取消和生成文件入口。
- 实时显示模型思考过程，并与最终回答分开展示。
- 使用 Markdown 展示回复，支持代码高亮、代码块复制和安全的外部链接。
- 输入 `/` 或 `\` 可查看并补全内置命令、扩展命令、提示词和技能（执行时统一为 `/command`）；`/login` 会安全写入 VS Code SecretStorage，`/resume` 会打开历史会话选择器。
- 命令审批与扩展输入在侧边栏内完成。
- 遵循 VS Code Workspace Trust；未受信任工作区只读，不启动后端。
- Windows x64 与 Linux glibc x64 VSIX 内置 AutoPi 后端，不要求另装 Node.js 或 CLI；支持 VS Code `1.85.0` 及以上版本。

插件发布版本与内置 AutoPi Core 版本分别记录，因此 VS Code 专属修复无需改动其他产品。当前插件版本为 `0.84.3`，内置 Core 版本为 `0.84.1`。

安装和零基础使用说明见 [VS Code 插件中文教程](https://github.com/shoelace66/AutoPi/blob/main/docs/VSCODE-GETTING-STARTED.zh-CN.md)。

## 生命周期

自动化只在对应 VS Code 窗口存活期间运行。隐藏侧边栏不会停止任务；关闭窗口或停用插件会终止该窗口托管的后台进程树。重新打开后只显示恢复提示，不会自动续跑，以避免重复测试或重复生成报告。

## 开发

```powershell
npm run build:vscode
npm run test:vscode
npm run package:vscode
```

正式产物：`.artifacts/vscode/AutoPi-0.84.3-win32-x64.vsix`、`.artifacts/vscode/AutoPi-0.84.3-linux-x64.vsix` 及各自同名 `.sha256` 文件。当前不支持 macOS、Windows ARM64 或 Linux ARM64。
