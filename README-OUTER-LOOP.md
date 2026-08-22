# AutoPi Wake / Outer Loop：Agent 外循环

> 当前状态说明，更新于 2026-08-22。本文聚焦 AutoPi 的 Wake / Outer Loop 子系统；桌面产品与新手使用见 [README.md](README.md)。

AutoPi `0.84.1` 正式版保留 Pi 兼容的 agent loop，并增加一个统一 `outer_loop` 工具。外循环与 agent loop 解耦，任务在同一进程内并行等待；Agent 仍可继续处理用户输入和其他任务，条件满足后通过统一 `WakeRuntime` 恢复目标 session 执行一轮。

本轮已落地原生兼容边界：没有活动等待任务时不追加 clock prompt；原生 CLI/TUI/SDK/RPC、扩展生命周期、provider、session 和资源机制继续由 Pi 处理，插件无需感知或适配 WakeService。AutoPi Desktop 已复用同一核心运行时；跨重启调度和真实 multi-agent 仍不在当前范围。

当前仍有几个明确限制：认证完成后不会自动恢复被暂停的用户 turn，需要用户发送下一轮；Outer Loop 只在 interactive 模式启动，print/JSON/RPC 保持原生行为但不运行后台调度；唤醒任务只在当前进程内有效；MCP 只提供外部集成边界和 Schema fixture，不内置 server/transport；真实 Kimi/Moonshot 调用和 multi-agent 路由仍待后续开发。

Pi 上游项目及各 package 的通用说明见 [README.md](README.md)。本文只说明本项目新增的外循环能力和当前限制。

## 1. 系统边界

系统分为两层：

- **内循环**：位于 `packages/agent`，负责模型请求、工具调用、上下文推进和单次 agent turn。
- **Wake 基础设施**：位于 `packages/coding-agent/src/core/wake`，负责能力、队列、本地 IPC、统一消息和日志。
- **外循环**：位于 `packages/coding-agent/src/core/outer-loop`，负责任务创建、定时或状态轮询、取消和自动恢复。

本阶段没有改写 `packages/agent` 的 agent loop。外循环通过 Pi 已有的 custom tool、hidden inline extension 和可选的 custom-turn preflight 接入。

```text
用户 <-> AutoPi Desktop / CLI <-> AgentSession <-> agent loop
                                  ^
                                  |
                        outer_loop tool
                                  |
                       OuterLoopRuntime
                         |- timer / file / process monitors
                         |- scheduler + cancellation
                         `- dynamic clock extension
                                  |
                            WakeRuntime
                         |- session queues + capabilities
                         |- local IPC + deduplication
                         `- prompt + journal
```

Outer Loop 子系统不实现界面；AutoPi Desktop 和 CLI 都通过同一个 `AgentSession` 使用它。当前不包含独立托管 server、离线队列、跨机器传输或跨重启任务恢复。journal 只记录事件并提供审计信息，不自动恢复进程结束时丢失的调度任务。旧的 `--mode server` 不是当前启动方式。

## 2. 启动

### 2.1 从源码直接启动（开发时推荐）

依赖已经安装时，在仓库根目录运行：

```powershell
Set-Location C:\path\to\AutoPi
.\pi-test.bat
```

也可以直接执行 PowerShell 脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\pi-test.ps1
```

该方式通过 `tsx` 启动 `packages/coding-agent/src/cli.ts`，不要求先生成 `dist`。

### 2.2 构建后启动

如果 `models.dev` 不可访问，使用已有模型数据进行离线构建：

```powershell
Set-Location C:\path\to\AutoPi
npm.cmd run build:offline
node .\packages\coding-agent\dist\cli.js
```

不要使用普通 `npm run build` 规避网络问题；普通构建会先尝试从 `models.dev` 刷新模型数据。

### 2.3 使用 `pi` 命令

直接输入：

```powershell
pi
```

只有当该命令指向本仓库构建或链接的 coding-agent 时，才包含这里的外循环。可用以下命令确认实际入口：

```powershell
Get-Command pi | Format-List Name,Source,Path
```

普通 `pi` 会启动原生 TUI 并同时启动外循环。不要使用：

```powershell
pi --mode server
```

该参数属于已放弃的早期方案，不是当前运行入口。

## 3. 启动后的行为

交互模式启动时会：

1. 创建进程内 `OuterLoopRuntime`。
2. 注册文件状态和 Windows 进程状态适配器。
3. 把单一 `outer_loop` 工具注入当前 `AgentSession`。
4. 启动 scheduler，然后进入原生 Pi TUI。
5. 条件满足时，通过统一 wake custom message、原生 `before_agent_start` preflight 恢复对应会话并自动执行一轮。
6. TUI 退出时停止 scheduler，所有未完成任务随进程结束。

当前会话唤醒时复用现有 `AgentSession`。用户切换会话后，旧会话的任务仍可在后台触发；runtime 会从该会话文件恢复临时 session，不会把后台消息插入当前聊天。

同一 session 的人工输入和自动唤醒共用异步锁，避免并发写入会话文件。

## 4. `outer_loop` 工具

工具默认在交互模式启用。可显式关闭：

```powershell
pi --exclude-tools outer_loop
pi --no-tools
```

外循环任务要求持久化 session，因此 `--no-session` 下不能创建任务。`list` 和 `cancel` 只操作当前会话拥有的任务。

第二次升级后的模型接口只有以下意图动作：`wait_time`、`wait_file`、`wait_process`、`list`、`cancel`。模型不再看到内部 `field/operator/expected/activation` 条件 DSL；旧 sleeping session、Deferred Inbox 和 legacy wake 工具已经从核心实现与导出中删除。

外挂唤醒不会阻塞 Agent。每次新的 user turn 或 wake turn，在 system prompt 末尾最多显示 10 条动态 clock；Agent 可调用 `outer_loop.cancel({"wakeId":"..."})` 取消过期任务。用户取消通过核心 API 完成：带 note 立即走统一 wake 入口，不带 note 在下一次正常 turn 提示“用户取消了该定时/监测任务”。

### 4.1 定时唤醒：`wait_time`

相对时间：

```json
{
  "action": "wait_time",
  "reason": "等待构建完成后再检查",
  "objective": "读取构建结果并继续处理",
  "checkFirst": ["重新检查构建状态"],
  "after": "00:05:00"
}
```

绝对时间：

```json
{
  "action": "wait_time",
  "reason": "到约定时间继续",
  "objective": "继续当前任务",
  "at": "2026-08-14T18:00:00+08:00"
}
```

`after` 支持毫秒整数或 `HH:MM:SS`。范围为 1 分钟至 30 天。`at` 必须是带时区的 ISO 8601 时间。

### 4.2 文件状态监测：`wait_file`

等待文件出现：

```json
{
  "action": "wait_file",
  "path": "output/result.json",
  "event": "exists",
  "pollInterval": "00:00:30",
  "timeout": { "kind": "after", "value": "01:00:00", "onTimeout": "wake" },
  "reason": "等待结果文件出现",
  "objective": "读取结果文件并继续",
  "checkFirst": ["确认文件存在且内容完整"]
}
```

可观测字段包括：

- `exists`：路径是否存在。
- `type`：`file`、`directory` 或 `other`。
- `size`：字节数。
- `mtimeMs`、`ctimeMs`：文件系统时间戳。
- `sha256`：`content_changed` 会自动建立 SHA-256 基线；普通 `modified` 只比较元数据。

路径相对当前项目目录解析，也可以传入项目目录内的绝对路径。解析后的路径和符号链接目标都必须位于允许的项目根目录内。

`exists` 和 `missing` 是直接的意图语义；创建任务时会立即采样，当前已满足就进入 `ready`。

### 4.3 Windows 进程状态监测：`wait_process`

等待进程退出：

```json
{
  "action": "wait_process",
  "pid": 12345,
  "event": "exited",
  "pollInterval": "00:00:30",
  "timeout": { "kind": "after", "value": "00:30:00", "onTimeout": "wake" },
  "reason": "等待进程退出",
  "objective": "检查进程结果并继续",
  "checkFirst": ["再次确认 PID 已不存在"]
}
```

进程监测只接受正整数 PID，并且当前只支持 Windows。适配器使用只读 `Get-Process -Id` 查询，不会调用 `kill`、`taskkill` 或 `Stop-Process`。

可观测字段为：

```ts
{
  pid: number;
  exists: boolean;
  running: boolean;
  status: "running" | "exited" | "not_found";
  exitCode?: number;
}
```

PID 不存在是正常观测结果，不是查询错误。Windows 无法提供退出码时，`exitCode` 会缺省，不会伪造数值。当前只按 PID 判断，接受 PID 复用风险。

创建 `wait_process` 时会立即采样：

- 首次状态已经匹配时，任务直接进入 `ready`。
- 首次查询失败时，任务保持 `armed`，错误会出现在 `list` 和 journal 中；查询错误不会被当成条件满足。
- 首次不匹配时，任务进入正常 polling。

### 4.4 查询与取消

```json
{ "action": "list" }
```

默认只列出非终态任务。包含已完成、取消或过期任务：

```json
{ "action": "list", "includeTerminal": true }
```

取消任务：

```json
{ "action": "cancel", "wakeId": "wake_xxx" }
```

## 5. 条件、轮询和超时语义

模型只提交意图，不提交内部字段或操作符：

- `exists`：当前路径存在时满足。
- `missing`：当前路径不存在时满足。
- `modified`：首次采样建立元数据基线，后续创建、删除或元数据变化时满足。
- `content_changed`：首次采样建立 SHA-256 基线，后续创建、删除或内容变化时满足。
- `process.exited`：进程已退出或 PID 已不存在时满足。

监测轮询间隔支持毫秒整数或 `HH:MM:SS`，范围为 30 秒至 24 小时。scheduler 自身默认约每 15 秒运行一次，因此实际触发可能晚于名义到期时间一个 tick。

每个文件或进程任务都必须显式提供 `timeout.kind`、`timeout.value` 和 `timeout.onTimeout`。超时值支持带时区 ISO 时间或相对 `HH:MM:SS`，范围为 1 分钟至 7 天。

- `onTimeout: "wake"`：超时后以 `monitor_timeout` 恢复 agent。
- `onTimeout: "expire"`：任务进入 `expired`，不调用模型。

监测结果会区分：

- `monitor_match`：条件满足。
- `monitor_timeout`：达到监测期限。
- `monitor_error`：适配器无法正常查询或解析状态。

## 6. 模型实际看到的说明

`outer_loop` 对模型的说明由三部分组成，不是单独一个 prompt 文件：

1. [基础 system prompt](packages/coding-agent/src/core/system-prompt.ts)。
2. [`outer_loop` 的 prompt snippet、guidelines 和意图级 JSON schema](packages/coding-agent/src/core/outer-loop/tool.ts)。
3. [每轮动态 clock](packages/coding-agent/src/core/outer-loop/clock-extension.ts)。没有活动任务时不追加任何文本。
4. [统一 wake custom message](packages/coding-agent/src/core/wake/prompt.ts)。timer、monitor、用户取消和未来 agent 信件共用 JSON 编码格式。

## 7. 已知限制

- 调度任务只在当前进程的 `InMemoryWakeStore` 中有效；关闭 Pi 后不自动恢复。journal 持久保留在 `<agentDir>/logs/wake-events.jsonl`，下次启动只注入恢复通知。
- 外循环只在普通交互模式启动，RPC/print 模式不启动该 runtime。
- `wait_process` 当前只支持 Windows。
- 文件监测使用 polling，不是 `fs.watch`；进程监测也使用 polling，不是进程退出事件。
- 同一时刻满足的多个 job 会分别恢复 agent，每个 job 对应一轮。
- 真实 multi-agent 和跨重启调度不在本阶段范围内；桌面界面由 `apps/desktop` 提供，并复用同一运行时。
- 底部外循环状态只在统计值变化时重绘，避免周期性无效刷新干扰 TUI 滚动位置。

## 8. 当前验证情况

最近一次本地验证包括：

- 定时任务的相对时间和绝对时间唤醒。
- 文件出现、mtime、SHA-256 和静默过期。
- Windows 进程存活、进程退出、超时和查询错误。
- 30 秒轮询持续执行。
- 并发 job 的独立触发。
- `outer_loop_wake` 注入和单轮 AgentSession 执行。
- intent-level `outer_loop`、clock、用户取消和 journal recovery notice。
- 外循环重复轮询不再重复触发 TUI 状态重绘。

当前相关测试主要位于：

- `packages/coding-agent/test/wakeup.test.ts`
- `packages/coding-agent/test/wakeup-v2.test.ts`
- `packages/coding-agent/test/footer-data-provider.test.ts`
- `packages/coding-agent/test/suite/regressions/wakeup-exists-operator-trap.test.ts`
- `packages/coding-agent/test/suite/regressions/wakeup-runner-resume-e2e.test.ts`

其中生产路径回归明确覆盖 `WakeScheduler → WakeRunner → AgentWakeService → outer_loop_wake → before_agent_start → settled`，不再使用旧的 `self_wakeup` 直注入路径。

正式分支使用 [GitHub Actions 的 build、check 和 test 门禁](https://github.com/shoelace66/AutoPi/actions/workflows/ci.yml)。Moonshot 兼容层目前以 sanitizer 单测、MCP 风格 fixture 和 OpenAI 请求快照为必需验证；没有可用 Key 时，不把真实 Kimi/Moonshot 网络调用作为 CI 前置条件。

## 9. 相关文档

- [项目总览](README.md)
- [上游关系与许可证说明](UPSTREAM.md)
- [贡献指南](CONTRIBUTING.md)

历史测试报告和早期 server 设计稿不属于当前公开接口；如需复核实现，应以源码、正式桌面包和当前回归测试为准。

## 10. 开发原则

- 不在 `packages/agent` 中加入外循环调度逻辑。
- 唤醒事件不是新的用户授权，不能绕过原有权限和安全策略。
- 自动恢复后先重新检查 `checkFirst`，再执行外部副作用。
- 监测错误不能伪装成目标状态已经满足。
- 工具返回、TUI 状态和 session 日志应提供可审计的 cause、观测证据和错误信息。
- 对模型行为的判断以可复现测试和真实调用记录为准，不用推测代替证据。
