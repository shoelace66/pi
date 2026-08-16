# Security policy

PI Outer Loop runs inside the permissions of the local Pi process. It is not a sandbox and does not make untrusted repositories, prompts, extensions, skills, or MCP servers safe.

## Reporting a vulnerability

Do not open a public issue for a security-sensitive report. Use a private GitHub Security Advisory for [shoelace66/pi](https://github.com/shoelace66/pi/security/advisories/new). Include:

- the affected commit, package, and configuration;
- a minimal reproduction or proof of concept;
- the security boundary that is crossed;
- any known mitigation.

Remove credentials, private session data, and personal filesystem paths from reports.

## Scope

In scope are vulnerabilities in the distributed core packages, CLI integration, wake scheduler, monitor adapters, journal handling, and repository workflows when the issue crosses a boundary that Pi is expected to enforce.

The following are expected trust-boundary limitations rather than vulnerabilities:

- local code execution by the normal Pi tools;
- malicious instructions in a trusted repository, `AGENTS.md`, extension, skill, provider, or MCP server;
- behavior that requires prior write access to the user's workspace, home directory, environment, or Pi configuration;
- public exposure of a Pi process that the user intentionally made reachable;
- prompt injection or malicious model output without an additional privilege boundary.
