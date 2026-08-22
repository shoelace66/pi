# AutoPi source relationship and attribution

AutoPi was forked from [Pi](https://github.com/earendil-works/pi), the open-source agent project maintained by Mario Zechner and contributors. The fork was formally frozen on **2026-08-20** and is now an independent repository, product identity, and development line.

## Frozen Pi baseline

| Field | Value |
| --- | --- |
| Pi release | `0.84.1` |
| Source commit | [`31b513e316ab2b5ec736268350635511297fa3c1`](https://github.com/earendil-works/pi/commit/31b513e316ab2b5ec736268350635511297fa3c1) |
| Commit date | 2026-08-10 |
| Freeze date | 2026-08-20 |

This baseline is permanent. The repository does not track, merge, or automatically synchronize later Pi releases. All development after the frozen commit is maintained here as project-owned work. The retained Git history records the exact source lineage; the README and license notices provide the public attribution.

## What is inherited

This repository retains the upstream Pi package structure, native agent loop, CLI/TUI/SDK/RPC surfaces, extension API, provider interfaces, session formats, and MIT license notices. Existing Pi extensions, skills, providers, prompt templates, and context files are intended to remain usable without an Outer Loop-specific adapter.

## What is maintained here

The independently maintained AutoPi delta includes the desktop product, Wake foundation, Outer Loop integration, and Windows delivery:

- the Electron desktop application, shared workspace/session UI, terminal, Git view, themes, and typed bridge;
- the intent-level `outer_loop` tool;
- `WakeRuntime`, per-session dispatch, local IPC, capabilities, queues, deduplication, unified prompts, and wake journaling;
- extension-facing Wake registrations and session inboxes;
- in-process timer, file, and process monitoring through the built-in Outer Loop plugin;
- the `WakeClient` SDK and `pi-wake` CLI;
- native-extension compatibility and provider-boundary tests;
- Moonshot MFJS tool-schema compatibility at the outgoing request boundary.
- a reproducible Windows x64 portable package, branded executable, build manifest, archive verification, and beginner documentation.

Cross-restart wake restoration, offline or cross-machine delivery, bundled third-party connectors, and MCP transport are not part of the current product scope.

## License

The upstream MIT license text is preserved in [LICENSE](LICENSE). Copyright notices and attribution in upstream files must remain intact when those files are redistributed. New project changes are also released under the MIT License.

For the original project and its continuing release history, see [earendil-works/pi](https://github.com/earendil-works/pi). Later upstream changes are not part of this repository unless independently implemented and documented here.
