import { afterEach, describe, expect, it, vi } from "vitest";
import networkProbeExtension from "../examples/extensions/network-probe.ts";

describe("network-probe native extension", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("registers and executes a read-only HTTP tool", async () => {
		const registerTool = vi.fn();
		networkProbeExtension({ registerTool } as never);

		expect(registerTool).toHaveBeenCalledTimes(1);
		const tool = registerTool.mock.calls[0]?.[0];
		expect(tool.name).toBe("network_probe");
		expect(tool.parameters).toBeDefined();

		const fetchMock = vi.fn().mockResolvedValue(
			new Response("hello from fixture", {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/plain" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await tool.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		expect(fetchMock).toHaveBeenCalledWith(
			new URL("https://example.com/"),
			expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }),
		);
		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("HTTP 200 OK");
		expect(result.content[0]?.text).toContain("hello from fixture");
		expect(result.details).toMatchObject({ status: 200, contentType: "text/plain" });
	});

	it("rejects non-HTTP URLs without making a request", async () => {
		const registerTool = vi.fn();
		networkProbeExtension({ registerTool } as never);
		const tool = registerTool.mock.calls[0]?.[0];
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			tool.execute("call-2", { url: "file:///etc/passwd" }, undefined, undefined, undefined),
		).rejects.toThrow("Only http:// and https:// URLs are supported");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
