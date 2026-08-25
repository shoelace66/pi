# Change Log

## [Unreleased]

### Changed

- Recorded the bundled AutoPi Core version independently so VS Code-only fixes can be released without changing other products.
- Replaced provider-named tool schema handling in the bundled Core with capability-selected protocol profiles while preserving canonical schemas for runtime validation.
- Streamed model reasoning into a dedicated expandable sidebar section while keeping final answers separate.
- Added slash-command discovery, filtering, keyboard completion and native VS Code command handling in the composer.
- Added a native `/resume` session picker backed by a read-only RPC session listing operation.
- Accepted both slash keys for command discovery while normalizing execution to canonical `/command` syntax.
- Rendered sanitized Markdown with syntax highlighting, safe links and per-code-block copy actions.
- Added direct setup and recovery actions, persisted approval drafts, broadened generated-file discovery and scoped host restarts to affected workspaces.
- Lowered the supported VS Code baseline to 1.85 while keeping platform availability explicit.

### Fixed

- Verified the bundled backend executable, Node CLI entry point, and complete fallback runtime before startup.
- Exercised the installed VSIX and its real RPC backend in an isolated VS Code integration profile.
- Serialized workspace-host restarts, scoped API keys by workspace and provider, and avoided full Webview refreshes for token-stream updates.
- Recognized `.js`, `.mjs`, and `.cjs` custom backends as Node entry points.
- Displayed generic custom-monitor adapter state, check counts, journal trigger causes and structured monitor errors.
- Packaged and verified target-specific Windows and Linux x64 VSIX backends while keeping monitor and wake behavior in the shared CLI RPC implementation.
- Restricted unit-test discovery to the extension test directory so downloaded VS Code integration runtimes are never collected as project tests.
- Read canonical `thinking` content blocks correctly and throttled live Webview updates to keep reasoning streams responsive.
- Prevented editor context from corrupting slash commands and routed `/login` through VS Code SecretStorage instead of the model.
- Prevented `/resume` from reaching the model or triggering unintended workspace inspection.
- Rejected unknown commands before model dispatch and preserved conversation scroll position during rapid streaming renders.
- Refreshed command suggestions immediately while typing and blocked Enter from submitting another prompt while a task is running.
- Opened images in VS Code's binary preview and PDFs with the system viewer instead of the text editor.

## 0.1.0

- Added the AutoPi Activity Bar container and secure sidebar experience.
- Added one embedded AutoPi RPC backend per workspace folder on Windows x64.
- Added natural-language prompts with active editor and selection context.
- Added model/run state, tool activity, extension approvals, background tasks, logs, cancellation, and generated-file links.
- Added Workspace Trust view-only mode, strict webview CSP, SecretStorage credentials, and process-tree cleanup on deactivation.
