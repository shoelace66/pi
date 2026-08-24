import { createHash } from "node:crypto";

function normalizeProvider(provider: string | undefined): string {
	return provider?.trim().toLowerCase() || "default";
}

/**
 * SecretStorage is extension-wide, so derive an opaque key for each
 * workspace/provider pair instead of sharing one credential across all hosts.
 */
export function apiKeySecretKey(workspaceId: string, provider: string | undefined): string {
	const scope = JSON.stringify([workspaceId, normalizeProvider(provider)]);
	const digest = createHash("sha256").update(scope).digest("hex");
	return `autopi.apiKey.v2.${digest}`;
}

export function apiKeyProviderLabel(provider: string | undefined): string {
	return normalizeProvider(provider);
}
