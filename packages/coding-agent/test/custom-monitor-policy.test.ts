import { describe, expect, it } from "vitest";
import { resolveCustomMonitorPolicy, SettingsManager } from "../src/core/settings-manager.ts";

describe("custom monitor policy", () => {
	it("uses the same authority ceiling for CLI and platform hosts", () => {
		const settings = SettingsManager.inMemory({
			customMonitor: {
				enabled: true,
				allowedOrigins: ["https://api.example.test/v1", "invalid", "http://localhost:8080/path"],
			},
		});
		expect(resolveCustomMonitorPolicy(settings, true)).toEqual({
			enabled: true,
			projectTrusted: true,
			allowedOrigins: ["https://api.example.test", "http://localhost:8080"],
		});
		expect(resolveCustomMonitorPolicy(settings, false)).toEqual({
			enabled: false,
			projectTrusted: false,
			allowedOrigins: ["https://api.example.test", "http://localhost:8080"],
		});
	});

	it("allows project settings to narrow but never widen the global Origin ceiling", () => {
		const settings = {
			getCustomMonitorSettings: () => ({
				global: {
					enabled: true,
					allowedOrigins: ["https://shared.example.test", "https://global-only.example.test"],
				},
				project: {
					enabled: true,
					allowedOrigins: ["https://shared.example.test/path", "https://project-only.example.test"],
				},
			}),
		};

		expect(resolveCustomMonitorPolicy(settings, true)).toEqual({
			enabled: true,
			projectTrusted: true,
			allowedOrigins: ["https://shared.example.test"],
		});
	});
});
