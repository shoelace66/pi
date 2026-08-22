# Changelog

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
