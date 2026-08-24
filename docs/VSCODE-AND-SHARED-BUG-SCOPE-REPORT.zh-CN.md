# AutoPi VS Code 与共享核心问题影响范围报告

- 检查日期：2026-08-23
- 初始检查对象：工作区初始未提交实现、AutoPi Core `0.84.1`、VS Code 插件 `0.1.0`
- 复核完成状态：AutoPi Core 与 VS Code 插件均为 `0.84.1`；第 1～7 节保留修复前的证据和建议，第 8 节记录最终实现与验证结果

## 1. 初始结论（修复前）

`outer_loop` 和 `background_task` 的根级 `anyOf` 兼容性问题不是 VS Code 专属问题。两个工具定义在共享的 `packages/coding-agent` 核心中，并由 CLI 交互模式、CLI RPC 模式、桌面端和 VS Code RPC 后端共同使用。只要这些入口启用了两个工具，并选择会错误处理根级 union schema 的模型后端（目前已知为 OpenRouter 上的 `stealth/ox-alpha`），模型工具调用就可能被压缩成空参数 `{}`。

但并非所有运行方式都受影响：CLI 单次 print/json 模式当前不创建 Outer Loop Runtime；默认 SDK 也不会自动注册这两个工具。它们只有在调用方显式注入相同工具时才受影响。

此前发现的 VSIX 启动参数缺失、Webview 高频刷新、VSIX 包体过大、Windows CI 产物缺失等问题是 VS Code 专属问题，与根级 `anyOf` 缺陷不是同一个故障。

## 2. 影响矩阵

| 运行入口 | 是否默认暴露两个工具 | 根级 `anyOf` 问题 | 说明 |
| --- | --- | --- | --- |
| CLI 交互模式 | 是 | 受影响 | `main.ts` 为 interactive 模式创建 Outer Loop Runtime 并注册两个工具。 |
| CLI `--mode rpc` | 是 | 受影响 | 与 VS Code 后端使用相同 RPC 模式和共享工具。 |
| CLI print/text | 否 | 不受影响 | 当前只在 interactive/rpc 模式创建 Outer Loop Runtime。 |
| CLI `--mode json` | 否 | 不受影响 | 与 print 模式走相同的单次执行分支。 |
| AutoPi Desktop | 是 | 受影响 | Desktop 创建共享 Outer Loop Runtime，并把 `createTools(cwd)` 传给每个 AgentSession。 |
| AutoPi VS Code | 是 | 受影响 | 插件启动 `pi-coding-agent --mode rpc`，继承 RPC 模式的两个工具。 |
| `createAgentSession()` 默认 SDK | 否 | 默认不受影响 | SDK 只注册调用方传入的 `customTools`。 |
| 显式注入 Outer Loop 工具的 SDK/第三方宿主 | 视调用方而定 | 受影响 | 只要传入相同 schema 并使用受影响模型，就会复现。 |

补充边界：问题只影响模型生成的 tool call。桌面端或 VS Code 通过宿主 API 直接执行的列表、取消等操作不经过模型工具 schema，因此不受根级 `anyOf` 退化影响。

## 3. 共享核心问题的证据链

### 3.1 两个公开 schema 都是根级 union

- [`outer_loop`](../packages/coding-agent/src/core/outer-loop/tool.ts#L42) 使用 `Type.Union` 包装 `wait_time`、`wait_file`、`wait_process`、`wait_task`、`list` 和 `cancel`。
- [`background_task`](../packages/coding-agent/src/core/background-task/tool.ts#L7) 使用 `Type.Union` 包装 `start`、`status`、`list` 和 `cancel`。

本地展开两个 TypeBox schema 后，结果都具有以下根结构：

```json
{
  "type": "object",
  "anyOf": ["各 action 分支"],
  "properties": {}
}
```

给 `Type.Union` 额外传入 `{ type: "object" }` 并不会消除根级 `anyOf`。

### 3.2 Pi 没有把完整参数清空

模型响应进入 Agent Loop 后，Pi 先执行可选的 `prepareArguments`，再调用 [`validateToolArguments`](../packages/agent/src/agent-loop.ts#L586)。验证器会克隆模型返回的 arguments、执行 TypeBox 转换并按原 schema 校验，见 [`validation.ts`](../packages/ai/src/utils/validation.ts#L285)。

因此，如果 Session 原始日志记录的 tool arguments 已经是 `{}`，空对象产生在 Pi 验证之前。Pi 对 `{}` 的正常行为是返回 schema 验证错误，而不是执行不完整的工具调用。

### 3.3 发给 OpenRouter 的 schema 基本未改写

OpenAI-compatible 请求转换器直接把 `tool.parameters` 放入 function `parameters`，见 [`openai-completions.ts`](../packages/ai/src/api/openai-completions.ts#L1339)。这两个工具没有主动请求 Pi 的严格约束采样，因此请求中的 `strict` 为 false；如果上游仍进行受限解码并把根级 union 退化成 `{}`，故障位于 OpenRouter 路由到的模型推理后端或其 schema 编译层。

### 3.4 各宿主确实共享同一工具实现

- [`OuterLoopRuntime.createTools()`](../packages/coding-agent/src/core/outer-loop/runtime.ts#L118) 同时返回 `outer_loop` 和 `background_task`。
- CLI 在 [`main.ts`](../packages/coding-agent/src/main.ts#L855) 中只为 interactive/rpc 模式创建该 Runtime，并在创建会话时注入 `createTools(cwd)`。
- Desktop 在 [`session-supervisor.ts`](../apps/desktop/electron/services/session-supervisor.ts#L328) 中把同一个 `createTools(cwd)` 传给 `createAgentSession()`。
- VS Code 在 [`backend-host.ts`](../apps/vscode/src/backend-host.ts#L150) 中启动共享 `RpcClient`，最终进入 CLI RPC 模式。
- SDK 的 [`createAgentSession()`](../packages/coding-agent/src/core/sdk.ts#L490) 默认只使用调用方提供的 `customTools`，不会自行创建 Outer Loop Runtime。

## 4. 推荐的共享修复

公开给模型的 schema 应改为单个根级 `Type.Object`：

- `action` 保持必填；
- action 相关字段在公开 schema 中设为 optional；
- action、event 等离散值优先输出为 JSON Schema `enum`，减少不必要的嵌套 `anyOf`；
- 每个字段说明中写清楚它适用的 action 和必填条件。

工具执行前必须再调用内部判别解析器，例如：

```text
parseOuterLoopInput(raw)
parseBackgroundTaskInput(raw)
```

解析器应恢复当前判别联合的约束：

- `background_task.start` 必须有非空 `command`；
- `status/cancel` 必须有 `taskId`；
- `wait_time` 必须且只能提供 `after` 或 `at`；
- `wait_file/process/task` 必须提供各自的目标、event 和 timeout；
- 未知 action、空对象和 action/字段错配必须产生明确且可重试的验证错误。

不能只依赖 [`normalizeCreateWakeInput`](../packages/coding-agent/src/core/outer-loop/wake-policy.ts#L199)。该函数处理的是已经组装好的内部 Wake 数据；在调用它之前，`outer_loop` 已读取 `reason`、`objective`、`timeout`、`at` 等公开输入。`background_task` 当前没有等价的公开输入 normalizer。

## 5. VS Code 专属问题

以下问题不影响 CLI 或 Desktop：

| 严重度 | 问题 | 当前证据与影响 |
| --- | --- | --- |
| 阻断 | 现有 Windows VSIX 的 Node 后端参数缺失 | 本地 `0.1.0` VSIX manifest 标记为 `bundled-node`，但没有 CLI `backendArgs`；实际执行 `node.exe --mode rpc`，已复现 `bad option: --mode`。当前打包源码已经补充参数和 RPC 冒烟测试，但现有 VSIX 早于当前源码。 |
| 高 | Node fallback 完整性校验不完整 | [`backend-runtime.ts`](../apps/vscode/src/backend-runtime.ts#L65) 只校验 `node.exe` 哈希；真正执行的 runtime CLI 和依赖树只检查存在性。 |
| 高 | 集成测试未启动内置后端 | [`suite.ts`](../apps/vscode/test/integration/suite.ts#L8) 只覆盖激活、命令注册和打开文档，无法发现 VSIX 后端启动失败。 |
| 高 | GitHub Release 只构建 Linux VSIX | [`build-binaries.yml`](../.github/workflows/build-binaries.yml#L81) 只运行 `package:vscode:linux`，没有 Windows VSIX 构建和上传。 |
| 高 | 插件/Core 版本生命周期不一致 | 插件固定 `0.1.0` 并锁定 Core `0.84.1`。只更新 Core 会生成内容不同但版本相同的 VSIX，VS Code 无法识别更新。 |
| 中 | Webview 高频完整刷新 | [`backend-host.ts`](../apps/vscode/src/backend-host.ts#L283) 对所有 Agent 事件调用 `onChanged()`；流式 `message_update` 会重复发送完整快照并重建全部 DOM。 |
| 中 | VSIX 体积和文件数过大 | 本地 VSIX 为 67,720,368 字节，解压约 192.7 MB、13,943 个文件；[`.vscodeignore`](../apps/vscode/.vscodeignore#L12) 重新包含整个 runtime `node_modules`，带入大量 source map、类型声明和文档。 |
| 中 | 配置重启存在双后端窗口 | [`restartHosts()`](../apps/vscode/src/sidebar-provider.ts#L56) 异步停止旧 host 后立即清空并启动新 host，可能短暂并存。 |
| 中 | 多工作区共用一个 SecretStorage API Key | 所有 workspace/provider 都读取同一个 `autopi.apiKey`，无法同时安全配置不同服务商密钥。 |
| 低 | 自定义后端扩展名处理不完整 | 只有 `.js` 被当作 Node CLI；`.mjs`、`.cjs` 在 Windows 上会被当作原生可执行文件。 |
| 兼容性 | 支持范围较窄 | 当前最低 VS Code 为 `1.134.0`，目标平台只有 Windows/Linux x64。 |

## 6. 修复与验证顺序

### 第一阶段：共享核心兼容性

1. 扁平化两个模型侧 schema，但保留必填 `action`。
2. 增加 action 级内部解析器和错误信息。
3. 添加 schema 结构测试，断言顶层没有 `anyOf`、`oneOf` 或 `allOf`。
4. 添加每个 action 的有效输入、缺字段、错字段、空对象测试。
5. 使用 `stealth/ox-alpha` 对扁平 schema 做人工 OpenRouter 冒烟测试。

共享修复完成后，需要重新构建 CLI、Desktop 和 VS Code 内置 Core；只重新打包 VSIX 不能修复已发布的 CLI/Desktop。

### 第二阶段：VS Code 交付阻断

1. 用当前源码重新生成 Windows VSIX。
2. 在隔离的 VS Code 用户目录安装真实 VSIX。
3. 打开受信任工作区，等待 `rpc_ready`，执行 `get_state` 和一次真实 prompt。
4. 验证关闭/重载窗口会终止后端及后台任务进程树。
5. 补 Windows CI、动态插件版本产物名和真实 VSIX 冒烟测试。

### 第三阶段：性能与包体

1. 对流式事件做节流或增量消息传输，避免每个 token 发送完整快照。
2. 为 Node fallback 生成最小运行时文件清单，排除 `.map`、`.d.ts`、文档和无关 CLI shim。
3. 对 Node fallback 的入口脚本和运行时文件树生成可验证的整体摘要。

## 7. 本次检查限制

本次检查验证了本地代码调用链、实际 TypeBox 根结构、当前 VSIX manifest、后端启动命令和已有测试覆盖。没有在本次检查中再次调用 OpenRouter 付费/外部 API；关于 `stealth/ox-alpha` 的直接 anyOf/object 对照响应采用用户提供的复现证据。修复后仍必须进行一次真实上游回归验证。

## 8. 2026-08-23 复核、修复与最终验证

### 8.1 最终归因

共享工具问题确认存在，但不属于 Pi 内核：

- 修复前两个公开 schema 的实际根结构是 `type: "object"` 加根级 `anyOf`，根级并没有 `properties`。因此第 3.1 节展示的 `properties: {}` 是对兼容性结果的近似描述，结构风险和影响范围结论仍然成立。
- schema 定义和修复均位于 `packages/coding-agent`。`packages/ai` 会把工具 schema 传给 OpenAI-compatible API，`packages/agent` 会对返回参数执行转换和校验；定向测试确认空对象会被拒绝，没有发现 Pi 把完整参数清空或绕过校验的证据。
- 本轮没有修改 `packages/ai` 或 `packages/agent`。如果扁平 schema 上线后 `stealth/ox-alpha` 仍返回空参数，现有证据会把问题指向 OpenRouter 路由到的模型后端或其 schema 编译层，而不是 Pi 内核。
- `autopi-v0.84.1` 标签中的历史实现与当前仍标为 `0.84.1` 的工作区并不完全相同：历史标签只包含 `outer_loop`，RPC 当时也没有默认注入；当前工作区还包含 `background_task` 和 RPC 暴露。因此不能只根据版本字符串判断影响范围。

### 8.2 问题处置状态

| 问题 | 复核结论 | 当前处置 |
| --- | --- | --- |
| `outer_loop` / `background_task` 根级 union | 确认存在，属于共享 `coding-agent` 层 | 两个公开 schema 已改为单根对象；`action` 使用明确枚举；根级无 `anyOf`、`oneOf`、`allOf`；执行边界加入按 action 的严格解析和可重试错误。 |
| 模型返回 `{}` 是否由 Pi 内核造成 | 未发现 Pi 内核缺陷 | Pi schema 透传、参数验证和 Agent Loop 定向测试通过；未修改 Pi 内核。 |
| Windows Node VSIX 缺少 CLI 启动参数 | 确认存在于旧 `0.1.0` VSIX | 打包器现在为 Node fallback 同时写入 Node runtime、CLI 资源和正确启动参数；真实安装后的 RPC 测试通过。 |
| Node fallback 完整性校验不完整 | 确认存在 | manifest 升级为 schema v2，覆盖入口、CLI、runtime、原生模块、WASM、目录树及全部顶层后端资源；未列出、缺失或摘要不符均拒绝启动。 |
| 集成测试没有启动内置后端 | 确认存在 | 测试改为安装真实 VSIX，在隔离的扩展目录、用户数据目录、工作区和 profile 中激活 AutoPi，并执行 `autopi.newSession` 与刷新 RPC。 |
| Release 缺少 Windows VSIX | 确认存在 | CI/release 增加原生 Windows VSIX 构建、安装测试、上传、校验和 release staging。 |
| 插件/Core 版本不同步 | 确认存在 | VS Code 与 Core 锁步为 `0.84.1`；补齐根 workspace、应用版本、显式版本设置、changelog 归档和生成目录排除测试。 |
| Webview 流式事件触发完整快照 | 确认存在 | `message_update` 不再逐 token 发送完整快照；只在有意义的稳定事件刷新。 |
| Node fallback 包体和文件数过大 | 确认存在 | 从 runtime 中删除 7,839 个声明文件和 source map；验证包由 13,981 个文件/66.99 MB 降至 6,164 个文件/53.74 MB。保留的依赖仍是可运行 Node fallback 所需内容。 |
| 配置重启可能并存双后端 | 确认存在 | host generation/restart 已串行化，先停止旧 host 再创建新 host，并处理 dispose 竞态。 |
| SecretStorage 密钥跨工作区/服务商共用 | 确认存在 | 密钥名改为工作区 URI 与规范化 provider 的稳定 SHA-256 作用域；实现不包含特定服务商分支。 |
| `.mjs` / `.cjs` 自定义后端识别错误 | 确认存在 | `.js`、`.mjs`、`.cjs` 均按 Node CLI 启动。 |
| 首次刷新失败后残留不可重试 client | 最终审计中新发现 | 失败时只清除并停止本次启动的 client，下一次 `ensureStarted()` 可以重试；已有回归测试。 |
| 静态检查扫描隔离运行目录中的 IPC endpoint | 最终验证中新发现 | Biome 已强制忽略纯生成的 `.artifacts`、`.vscode-test` 和内置后端 staging 目录；源码检查范围仍为 1,122 个文件。 |
| VS Code/平台支持范围较窄 | 是产品支持边界，不是本次代码故障 | CI 覆盖 Ubuntu 22.04、Ubuntu 24.04、Debian 12 和 Windows x64；没有在本轮擅自扩大架构或最低 VS Code 版本。 |

所有非内核修复均以通用协议、schema、资源清单、工作区作用域和进程生命周期为边界，没有为 OpenRouter、`stealth/ox-alpha` 或其他单一服务商加入行为分支。

### 8.3 自动化与实际运行验证

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check` | 通过 | Biome、依赖版本、导入边界、shrinkwrap/install lock、TypeScript、Desktop 类型检查和浏览器 smoke 均通过。 |
| VS Code 单元/类型测试 | 通过 | 5 个测试文件、27 项测试；两个 tsconfig 均通过。 |
| 共享 schema/工作流测试 | 通过 | 3 个文件、15 项测试，覆盖根 schema、有效 action、空对象、缺字段、错字段及唤醒/后台任务工作流。 |
| 后台任务/唤醒进程生命周期 | 通过 | 4 个文件、23 项测试。 |
| Pi AI 参数验证 | 通过 | 7/7；空对象按 schema 被拒绝。 |
| Pi Agent Loop | 通过 | 23/23；未发现参数被内核清空。 |
| 脚本与 release target 测试 | 通过 | 版本同步、显式版本、生成后端排除和 release target 共 6 项通过；脚本总测试 13/13。 |
| `npm run build:offline` | 通过 | 所有 workspace 离线构建及模型数据检查通过。 |
| `npm run build:desktop` | 通过 | Renderer 与 Electron 构建通过。 |
| VS Code 编译和 VSIX 打包 | 通过 | Windows Bun、Linux Bun 和 Windows Node fallback 三种分支均成功。 |
| Windows Bun VSIX 真实安装 | 通过 | 在 VS Code 1.134 隔离环境中安装并激活，执行 `autopi.newSession` 和刷新 RPC，进程退出码为 0。 |
| Windows Node fallback VSIX 真实安装 | 通过 | 强制 Node 分支安装后启动内置 Node + CLI 后端，完成相同 RPC 测试，进程退出码为 0。 |
| Desktop 可执行文件 | 通过 | 生成、打包、解压同源验证；隐藏启动 8 秒保持存活，随后只清理本次新建进程。内置 CLI 的版本、help 和 RPC `get_state` smoke 均通过。 |
| Linux CLI/VSIX 结构验证 | 通过 | ELF x64、可执行位、manifest、文件树和 SHA-256 均通过；二进制最高 GLIBC 基线为 2.17。 |
| YAML 与 diff 审计 | 通过 | 两个 workflow 可解析，`git diff --check` 无 whitespace 错误。 |

仓库级 `npm test` 也已完整执行，但在当前 Windows 主机上不是全绿，不能把它误报为通过。失败集中在已有的跨平台/环境基线：Unix domain socket `EACCES`、未开启 Windows Developer Mode 导致 symlink `EPERM`、POSIX 路径断言，以及当前离线模型目录与部分新模型预期不一致。与本次改动直接相关的测试集、构建和真实 Windows VSIX 安装均单独通过；这些基线失败没有通过修改 Pi 内核来掩盖。

### 8.4 交付物与同源性

| 产物 | 大小 | SHA-256 / 同源标识 |
| --- | ---: | --- |
| `.artifacts/vscode/AutoPi-0.84.1-win32-x64.vsix` | 48,921,767 bytes | `1ed6bbe046a48e530edec7f5353cb54f39db2c7ef1907258cc61d2de1367aebf` |
| `.artifacts/vscode/AutoPi-0.84.1-linux-x64.vsix` | 45,472,547 bytes | `b4c0c5632ca83aa6d351da6337c31d2eed3daa20d38347702f10716706b081a0` |
| `.artifacts/vscode/validation/AutoPi-0.84.1-win32-x64-node-fallback.vsix` | 56,346,836 bytes | `586e315ed3cd2c584c256e1f41dd307de32b97dc41b217b5ee351cd8881ba3a6` |
| `.artifacts/cli/AutoPi-0.84.1-linux-x64.tar.gz` | 118,446,487 bytes | `b886198b0245ace693183948746dc5d6d76e28ba471e106c6e703538b69b2c6c` |
| `.artifacts/delivery-20260823/AutoPi-0.84.1-win-x64.zip` | 178,364,395 bytes | `c687be71eb1e428e4dc045ecbb2e0b4a0b8ebb342ebfffb26580759c89526ccc` |

Desktop ZIP 和同目录解包版本均为 build ID `autopi-0.84.1-4e8e4891f352f047`，包含 14,072 个文件，文件树摘要为 `d57ede89207069805e51a60e5104ec9a2e03856138e56e47202e9b361d62c241`。默认 `.artifacts/AutoPi-0.84.1-win-x64` 当时被用户正在运行的 AutoPi 进程占用，因此没有终止用户进程或覆盖该目录，而是写入独立的 `delivery-20260823` 目录。

### 8.5 尚需外部环境完成的验证

- 当前环境没有 `OPENROUTER_API_KEY`，也没有本轮付费调用授权，因此没有对 `stealth/ox-alpha` 发起真实外部 prompt。现有结论来自 schema 展开、请求透传路径、Pi 校验测试和用户复现证据；发布前仍建议用扁平 schema 做一次受控的上游回归。
- 本机 WSL 只有 Docker Desktop 的 Alpine/musl 环境，不能执行需要 glibc loader 的 Linux 构建；Docker daemon 也不可用。因此本轮完成了 ELF/GLIBC/manifest/权限/摘要验证，但 Ubuntu/Debian 原生启动需要由已配置的 CI matrix 执行。
- `D:\\PiDesktop` 当前不存在，且该路径位于工作区之外。本轮没有在未取得明确外部目录替换授权的情况下创建或同步它；工作区内已经保留同一构建的 ZIP 与解包目录，可在获得授权后原样同步。
