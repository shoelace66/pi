import { describe, expect, it } from "vitest";
import { apiKeyProviderLabel, apiKeySecretKey } from "../src/api-key-secret.ts";

describe("VS Code API key secret scoping", () => {
	it("is stable for the same workspace and normalized provider", () => {
		expect(apiKeySecretKey("file:///workspace-a", " OpenRouter ")).toBe(
			apiKeySecretKey("file:///workspace-a", "openrouter"),
		);
	});

	it("isolates credentials by workspace and provider", () => {
		const base = apiKeySecretKey("file:///workspace-a", "openrouter");
		expect(apiKeySecretKey("file:///workspace-b", "openrouter")).not.toBe(base);
		expect(apiKeySecretKey("file:///workspace-a", "openai")).not.toBe(base);
	});

	it("uses an explicit default profile when no provider is configured", () => {
		expect(apiKeySecretKey("file:///workspace-a", undefined)).toBe(
			apiKeySecretKey("file:///workspace-a", "  "),
		);
		expect(apiKeyProviderLabel(undefined)).toBe("default");
	});
});
