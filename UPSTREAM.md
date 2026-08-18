# Upstream relationship and attribution

PI Outer Loop is based on [Pi](https://github.com/earendil-works/pi), the open-source Pi agent project maintained by Mario Zechner and contributors.

## What is inherited

This repository retains the upstream Pi package structure, native agent loop, CLI/TUI/SDK/RPC surfaces, extension API, provider interfaces, session formats, and MIT license notices. Existing Pi extensions, skills, providers, prompt templates, and context files are intended to remain usable without an Outer Loop-specific adapter.

## What is maintained here

The project-maintained delta is the core Outer Loop integration:

- the intent-level `outer_loop` tool;
- in-process timer, file, and process wake jobs;
- `AgentWakeService`, settled-session dispatch, cancellation, clock prompts, and wake journaling;
- native-extension compatibility and provider-boundary tests;
- Moonshot MFJS tool-schema compatibility at the outgoing request boundary.

GUI/desktop code, cross-restart scheduling, bundled MCP transport, authentication handoff, and real multi-agent routing are not part of the current core scope.

## License

The upstream MIT license text is preserved in [LICENSE](LICENSE). Copyright notices and attribution in upstream files must remain intact when those files are redistributed. New project changes are also released under the MIT License.

For the canonical upstream project and its current license history, see [earendil-works/pi](https://github.com/earendil-works/pi).
