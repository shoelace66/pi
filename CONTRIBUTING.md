# Contributing to PI Outer Loop

PI Outer Loop is a core-only layer on top of Pi. Contributions should preserve the experience of native Pi and should not require existing Pi extensions, skills, providers, or session files to change.

## Scope

In scope:

- `packages/coding-agent/src/core/wakeup` and its tests;
- native `ExtensionAPI` compatibility;
- scheduler, monitor, journal, clock, cancellation, and wake dispatch behavior;
- documentation and reproducible core tests.

Out of scope for this repository:

- GUI or desktop application design;
- cross-restart scheduling;
- a bundled MCP server or transport;
- real multi-agent routing.

## Before opening a pull request

1. Read [AGENTS.md](AGENTS.md).
2. Keep the change focused and explain the compatibility impact.
3. Do not add generated release bundles, desktop artifacts, credentials, or private session files.
4. Preserve native Pi CLI flags, session formats, extension hooks, and tool filtering semantics.
5. Add a regression test for behavior changes.

Run the relevant checks from the repository root:

```bash
npm run check
./test.sh
```

For focused changes, also run the package test that covers the modified behavior. Wake tests use the faux provider and must not require a real provider key.

## Extension compatibility rule

Use the existing Pi `ExtensionAPI`. Do not add a new event type or require a plugin-specific adapter merely to support Outer Loop. If a design would change existing extension behavior, revise the Outer Loop integration instead.

## Pull requests

Describe:

- the problem and the user-visible behavior;
- the exact packages and interfaces touched;
- how ordinary Pi turns and wake turns were validated;
- any behavior intentionally deferred to a later release.

The pull request template is intentionally small so review can focus on the core runtime.

## License

By contributing, you agree that your contribution is released under the repository's [MIT License](LICENSE).
