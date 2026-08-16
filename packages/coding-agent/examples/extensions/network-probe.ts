/**
 * Read-only network probe extension.
 *
 * This is a small native Pi extension fixture for checking that an extension
 * can register a tool which performs network I/O. It intentionally uses the
 * platform `fetch` API and has no dependency on Outer Loop or MCP.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/network-probe.ts
 *   # then ask the agent to use network_probe
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_URL = "https://example.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 4_000;

type NetworkProbeDetails = {
	url?: string;
	status?: number;
	contentType?: string | null;
	truncated?: boolean;
	error?: string;
};

const NETWORK_PROBE_PARAMS = Type.Object({
	url: Type.Optional(
		Type.String({
			description: `HTTP(S) URL to fetch (default: ${DEFAULT_URL})`,
		}),
	),
});

function parseUrl(value: string | undefined): URL {
	const url = new URL(value?.trim() || DEFAULT_URL);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http:// and https:// URLs are supported");
	}
	return url;
}

function createRequestSignal(signal: AbortSignal | undefined): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

export default function networkProbeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "network_probe",
		label: "Network probe",
		description: "Fetch a read-only HTTP(S) URL and return a bounded response preview.",
		promptSnippet: "Fetch a small read-only HTTP(S) response with network_probe.",
		parameters: NETWORK_PROBE_PARAMS,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<NetworkProbeDetails>> {
			let url: URL;
			try {
				url = parseUrl(params.url);
			} catch (error) {
				throw new Error(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
			}

			const request = createRequestSignal(signal);
			try {
				const response = await fetch(url, {
					method: "GET",
					redirect: "error",
					signal: request.signal,
				});
				const body = (await response.text()).slice(0, MAX_BODY_CHARS);
				const truncated = body.length === MAX_BODY_CHARS;

				return {
					content: [
						{
							type: "text",
							text: `HTTP ${response.status} ${response.statusText}\nURL: ${url}\n\n${body}${truncated ? "\n\n[body truncated]" : ""}`,
						},
					],
					details: {
						url: url.toString(),
						status: response.status,
						contentType: response.headers.get("content-type"),
						truncated,
					},
				};
			} catch (error) {
				throw new Error(
					`Network probe failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				request.cleanup();
			}
		},
	});
}
