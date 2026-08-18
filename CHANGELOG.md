# Changelog

## Unreleased — core second-development closeout

- Added the unified `outer_loop` wake tool for time, file, process, list, and cancel intents.
- Added `AgentWakeService`, settled-session dispatch, request-id deduplication, wake journaling, dynamic clock prompts, and native extension preflight.
- Removed the legacy sleeping-session, deferred-inbox, and direct self-wakeup paths from the core flow.
- Added Moonshot MFJS Schema sanitization at the OpenAI-compatible request boundary without changing registered plugin schemas or non-Moonshot providers.
- Added regression coverage for native extension compatibility, MCP-style schemas, cancellation races, wake dispatch, provider snapshots, and CLI behavior.

## Current limitations

- Wake jobs are process-local and are not automatically restored after restart.
- GUI/desktop integration, bundled MCP transport, authentication handoff, and real multi-agent routing are deferred.
- The project remains an experimental developer release.
