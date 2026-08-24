# Changelog

## Unreleased

### Automation core

- Added generic background task execution, status, logs, cancellation and process-tree cleanup.
- Added `outer_loop.wait_task` so dependent steps resume only after a managed task finishes, then re-check exit status, logs and artifacts.
- Enabled the same Outer Loop and task runtime in interactive CLI, desktop and RPC hosts.
- Enabled the same globally bounded `outer_loop.wait_custom` monitor policy in CLI and Desktop, with VS Code continuing to reuse it through the CLI RPC backend.
- Added an explicit typed RPC ready handshake, automation events/list/cancel operations, extension UI replies and custom executable launch options.

### VS Code 0.84.1

- Added the `shoelace66.autopi` Windows x64 VS Code extension with an AutoPi sidebar, per-workspace RPC hosts, editor/selection context, approvals, task logs, cancellation and generated-file links.
- Added Workspace Trust enforcement, strict webview CSP/resource boundaries, VS Code SecretStorage integration and shutdown cleanup.
- Added an offline VSIX packaging pipeline with an embedded AutoPi Windows x64 backend and SHA-256 output, plus a zero-basis Chinese tutorial.
- Kept the extension and bundled Core versions in lockstep, verified the complete Node fallback runtime, and added native Windows release artifacts plus installed-VSIX RPC integration coverage.
- Serialized backend restarts, reduced token-stream Webview rebuilds, scoped credentials by workspace and provider, and supported Node `.js`, `.mjs`, and `.cjs` backend entries.
- Added generic custom-monitor status, trigger cause and structured error details to the automation view, plus Windows and Linux x64 VSIX packaging.
- Added a Linux x64 CLI package with executable launchers, bundled runtime assets, build manifests and reproducible archive verification.

## 0.84.1 — 2026-08-22

First formal AutoPi product release.

### Product

- Integrated the Pi-compatible core CLI and the AutoPi Electron desktop into one shared product.
- Added branded AutoPi Dark and AutoPi Light themes, theme-specific symbols and wordmarks, and a frameless Windows title area with native window controls.
- Added workspaces, session restoration, model and mode controls, terminal, project files, Git status, activity inspection, localization, and optional launch at Windows login.
- Added a Windows x64 portable package with `AutoPi.exe`, CLI compatibility launchers, beginner documentation, license, build manifest, SHA-256 checksum, and same-build archive verification.

### Automation

- Added the unified `outer_loop` wake tool for time, file, process, list, and cancel intents.
- Added `AgentWakeService`, settled-session dispatch, request-id deduplication, wake journaling, dynamic clock prompts, and native extension preflight.
- Removed the legacy sleeping-session, deferred-inbox, and direct self-wakeup paths from the core flow.
- Added Moonshot MFJS Schema sanitization at the OpenAI-compatible request boundary without changing registered plugin schemas or non-Moonshot providers.
- Added regression coverage for native extension compatibility, MCP-style schemas, cancellation races, wake dispatch, provider snapshots, and CLI behavior.

### Current limitations

- Wake jobs are process-local and are not automatically restored after restart.
- Bundled MCP transport, automatic authentication handoff, offline/cross-machine delivery, and real multi-agent routing are deferred.
