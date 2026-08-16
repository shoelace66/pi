<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="112">
  </a>
</p>

<h1 align="center">PI Outer Loop</h1>

<p align="center">
  Native-compatible wakeups for Pi.<br>
  Timers, file state, and process state without rewriting Pi's agent loop or plugins.
</p>

<p align="center">
  <a href="https://github.com/shoelace66/pi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/shoelace66/pi/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/shoelace66/pi?style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"></a>
  <a href="https://github.com/earendil-works/pi"><img alt="Based on Pi" src="https://img.shields.io/badge/based%20on-Pi-111827?style=flat-square"></a>
</p>

> **Status:** core-first, in-process, and experimental. This repository publishes the core runtime only; GUI and desktop code are intentionally out of scope.

## What this project adds

PI Outer Loop keeps Pi's normal interaction model and adds one model-facing tool, `outer_loop`:

| Action | Purpose |
| --- | --- |
| `wait_time` | Wake at a relative or absolute time |
| `wait_file` | Wake when a file is created, removed, modified, or changed in content |
| `wait_process` | Wake when a Windows process exits |
| `list` | Inspect active wake jobs and their clock entries |
| `cancel` | Cancel an obsolete wake job from the current turn |

The scheduler runs alongside the agent. Creating a wake job does not put the session to sleep: the agent can keep accepting user turns, and an obsolete job can be cancelled by either the agent or the user.

When a job is active, a small dynamic clock is appended to the end of the system prompt for normal and wake turns. With no active jobs, no clock text is added.

## Compatibility contract

The product should feel like **native Pi plus one optional tool**:

- Pi's interactive, print, JSON, RPC, TUI, SDK, session, model, provider, and configuration flows remain available.
- Existing extensions keep their tools, commands, events, providers, prompt changes, resources, and session hooks.
- `--tools`, `--exclude-tools`, `--no-tools`, and `--no-extensions` keep their native meaning.
- The `packages/agent` agent loop is not replaced.
- Wake turns reuse native `before_agent_start` preflight and the normal extension prompt chain.
- Existing session files do not need migration; wake events are stored as Pi custom messages.
- GUI code, cross-restart scheduling, and real multi-agent routing are not part of this repository.

The detailed runtime contract is in [README-OUTER-LOOP.md](README-OUTER-LOOP.md).

## Quick start

### Windows from source

```powershell
git clone https://github.com/shoelace66/pi.git
cd pi
npm install --ignore-scripts
.\pi-test.bat
```

### macOS/Linux from source

```bash
git clone https://github.com/shoelace66/pi.git
cd pi
npm install --ignore-scripts
./pi-test.sh
```

To build with the model data already in the checkout:

```bash
npm run build:offline
node packages/coding-agent/dist/cli.js
```

Run `pi --help` for the native CLI surface. Disable the added tool with `pi --exclude-tools outer_loop` or disable all tools with `pi --no-tools`.

## Example

Ask the agent to create a timer, or use the tool payload directly:

```json
{
  "action": "wait_time",
  "after": "00:05:00",
  "objective": "检查构建结果并继续处理",
  "reason": "等待构建完成"
}
```

The next turn may show a clock entry such as:

```text
clock: wake_123 | timer | due 18:30+08:00 | 等待构建完成
```

For full schemas, file/process semantics, cancellation, journaling, and recovery notices, see [the outer-loop guide](README-OUTER-LOOP.md).

## Native extension compatibility

Extensions are still loaded through Pi's `ExtensionAPI`; no extension-specific Outer Loop adapter is required. The repository includes a small opt-in network fixture:

```powershell
pi --extension .\packages\coding-agent\examples\extensions\network-probe.ts
```

It registers a read-only `network_probe` tool using the platform `fetch` API. This is a normal Pi extension, not a built-in MCP client. MCP remains an external integration point and requires a concrete MCP server/package configuration.

See [extension examples](packages/coding-agent/examples/extensions/README.md) and the wake/compaction regression tests under [packages/coding-agent/test](packages/coding-agent/test).

## Architecture

```text
Pi TUI / CLI / SDK / RPC
              |
         AgentSession
              |
          Pi agent loop       (unchanged)
              |
       outer_loop custom tool
              |
      OuterLoopRuntime
       |- InMemoryWakeStore
       |- WakeScheduler + monitors
       |- AgentWakeService
       |- unified wake composer
       `- dynamic clock extension
```

The wake service resolves a target Pi session, waits for a busy target to settle, injects an `outer_loop_wake` custom message, runs the normal extension preflight, and waits for the session to settle. A request ID prevents duplicate injection.

## Repository map

| Path | Role |
| --- | --- |
| `packages/agent` | Pi's low-level agent runtime; not replaced by Outer Loop |
| `packages/coding-agent` | Native Pi CLI, session integration, and extension API |
| `packages/coding-agent/src/core/wakeup` | Outer Loop service, scheduler, monitors, journal, and clock |
| `packages/coding-agent/examples/extensions` | Native extension examples, including the network fixture |
| `packages/coding-agent/test/suite` | Faux-provider and regression coverage |
| `README-OUTER-LOOP.md` | Full core behavior and interface reference |

## Scope and roadmap

Current core scope:

- in-process wake jobs;
- timer, file, and process monitors;
- unified agent/user cancellation;
- journaled wake events;
- native extension and compaction compatibility tests.

Deferred work:

- GUI controls;
- cross-restart task restoration;
- a real multi-agent target resolver;
- an MCP server or MCP transport bundled into Pi.

## Development

```bash
npm run check
./test.sh
```

For focused wake and extension tests:

```bash
npm exec vitest --run packages/coding-agent/test/suite/regressions/wakeup-runner-resume-e2e.test.ts --config packages/coding-agent/vitest.config.ts
npm exec vitest --run packages/coding-agent/test/network-probe-extension.test.ts --config packages/coding-agent/vitest.config.ts
```

Read [AGENTS.md](AGENTS.md) before making code changes. Keep GUI artifacts and generated release bundles out of the core branch.

## Upstream and license

This project is built on the Pi Agent Harness packages and keeps their MIT licensing and attribution. See [upstream Pi](https://github.com/earendil-works/pi) for the base project and [LICENSE](LICENSE) for the complete license text.

PI Outer Loop is released under the MIT License.
