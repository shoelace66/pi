# Contributing to AutoPi

AutoPi is an independently maintained desktop and command-line agent derived from Pi. Contributions should improve the unified product while preserving the inherited Pi compatibility boundary.

## Project scope

In scope:

- AutoPi Desktop UI, Electron integration, accessibility, localization, and Windows delivery;
- Pi-compatible CLI, TUI, SDK, RPC, sessions, extensions, providers, and tools;
- Wake runtime, local IPC, scheduler, monitor, journal, clock, cancellation, and dispatch behavior;
- documentation, tests, release reproducibility, and beginner-friendly installation.

Current product boundaries include process-local wake registrations, online local delivery, and no bundled cross-machine transport or hosted scheduler. Proposals may extend those boundaries, but should document migration, security, and compatibility impact.

## Before opening a pull request

1. Read [AGENTS.md](AGENTS.md), [README.md](README.md), and [UPSTREAM.md](UPSTREAM.md).
2. Keep the change focused and explain user-visible behavior.
3. Do not add generated release bundles, credentials, private sessions, personal paths, or model-provider secrets.
4. Preserve upstream copyright and MIT license notices.
5. Preserve Pi CLI flags, session formats, extension hooks, tool filtering, and provider behavior unless the change explicitly migrates them.
6. Add or update regression coverage for behavior changes.

Run the repository checks:

```bash
npm run check
npm --workspace @autopi/desktop test
```

Run the focused package tests that cover the modified area. Tests should use fixtures or faux providers and must not require a real provider key.

## Desktop changes

- Verify dark and light themes, window controls, keyboard focus, and the initial workspace flow.
- Keep the renderer isolated behind the typed Electron bridge; do not expose Node.js directly to web content.
- Keep the desktop and CLI on the same `AgentSession` and core packages instead of duplicating Agent behavior.
- Do not commit `.artifacts`, packaged Electron runtimes, or local user-data profiles.

## Wake and extension compatibility

Use the existing Pi `ExtensionAPI` and AutoPi Wake interfaces. An ordinary extension should not need an Outer Loop-specific adapter. Wake turns must continue through native preflight and the normal prompt chain.

## Pull request description

Include:

- the problem and the resulting user behavior;
- the packages, interfaces, and platforms affected;
- checks and tests performed;
- security or compatibility considerations;
- intentionally deferred work.

## License

By contributing, you agree that your contribution is released under the repository's [MIT License](LICENSE). Upstream Pi attribution is documented in [UPSTREAM.md](UPSTREAM.md).
