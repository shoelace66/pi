# Change Log

## [Unreleased]

### Changed

- Kept the VS Code extension version in lockstep with its bundled AutoPi Core version.

### Fixed

- Verified the bundled backend executable, Node CLI entry point, and complete fallback runtime before startup.
- Exercised the installed VSIX and its real RPC backend in an isolated VS Code integration profile.
- Serialized workspace-host restarts, scoped API keys by workspace and provider, and avoided full Webview refreshes for token-stream updates.
- Recognized `.js`, `.mjs`, and `.cjs` custom backends as Node entry points.
- Displayed generic custom-monitor adapter state, check counts, journal trigger causes and structured monitor errors.
- Packaged and verified target-specific Windows and Linux x64 VSIX backends while keeping monitor and wake behavior in the shared CLI RPC implementation.

## 0.1.0

- Added the AutoPi Activity Bar container and secure sidebar experience.
- Added one embedded AutoPi RPC backend per workspace folder on Windows x64.
- Added natural-language prompts with active editor and selection context.
- Added model/run state, tool activity, extension approvals, background tasks, logs, cancellation, and generated-file links.
- Added Workspace Trust view-only mode, strict webview CSP, SecretStorage credentials, and process-tree cleanup on deactivation.
