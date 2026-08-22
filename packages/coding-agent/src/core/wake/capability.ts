import { createHash, randomBytes } from "node:crypto";
import type { WakeCapabilityAddress, WakeEvent } from "./types.ts";
import { WakeClientError } from "./types.ts";

const ADDRESS_PREFIX = "pi-wake:v1:";
export const MAX_WAKE_EVENT_BYTES = 64 * 1024;

type AddressPayload = {
	endpoint: string;
	resourceId: string;
	kind: "registration" | "inbox";
};

export type ParsedWakeCapability = AddressPayload & { token: string };

export function createCapabilityToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashCapabilityToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function encodeWakeCapability(payload: AddressPayload, token: string): WakeCapabilityAddress {
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${ADDRESS_PREFIX}${encoded}.${token}` as WakeCapabilityAddress;
}

export function parseWakeCapability(address: WakeCapabilityAddress | string): ParsedWakeCapability {
	if (!address.startsWith(ADDRESS_PREFIX)) {
		throw new WakeClientError("WAKE_INVALID_ADDRESS", "Wake capability address has an unsupported format");
	}
	const encodedAndToken = address.slice(ADDRESS_PREFIX.length);
	const separator = encodedAndToken.lastIndexOf(".");
	if (separator <= 0 || separator === encodedAndToken.length - 1) {
		throw new WakeClientError("WAKE_INVALID_ADDRESS", "Wake capability address is incomplete");
	}
	try {
		const payload = JSON.parse(Buffer.from(encodedAndToken.slice(0, separator), "base64url").toString("utf8")) as
			| Partial<AddressPayload>
			| undefined;
		const token = encodedAndToken.slice(separator + 1);
		if (
			!payload ||
			typeof payload.endpoint !== "string" ||
			payload.endpoint.length === 0 ||
			typeof payload.resourceId !== "string" ||
			!/^wake_[A-Za-z0-9_-]+$/.test(payload.resourceId) ||
			(payload.kind !== "registration" && payload.kind !== "inbox") ||
			!/^[A-Za-z0-9_-]{32,}$/.test(token)
		) {
			throw new Error("invalid payload");
		}
		return { endpoint: payload.endpoint, resourceId: payload.resourceId, kind: payload.kind, token };
	} catch (error) {
		if (error instanceof WakeClientError) throw error;
		throw new WakeClientError("WAKE_INVALID_ADDRESS", "Wake capability address is invalid", { cause: error });
	}
}

export function validateWakeEvent(event: WakeEvent): WakeEvent {
	if (!event || typeof event !== "object") {
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake event must be an object");
	}
	const keys = Object.keys(event);
	if (keys.some((key) => key !== "eventId" && key !== "message" && key !== "data")) {
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake event contains unsupported fields");
	}
	if (typeof event.eventId !== "string" || event.eventId.trim().length === 0 || event.eventId.length > 256) {
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake eventId must contain 1 to 256 characters");
	}
	if (typeof event.message !== "string" || event.message.trim().length === 0 || event.message.length > 16_384) {
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake message must contain 1 to 16384 characters");
	}
	if ("data" in event && event.data !== undefined && !isJsonValue(event.data, new Set())) {
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake data must be a finite JSON value");
	}
	let encoded: string;
	try {
		encoded = JSON.stringify(event);
	} catch (error) {
		throw new WakeClientError("WAKE_INVALID_EVENT", "Wake event must contain JSON-compatible data", { cause: error });
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_WAKE_EVENT_BYTES) {
		throw new WakeClientError("WAKE_INVALID_EVENT", `Wake event exceeds ${MAX_WAKE_EVENT_BYTES} encoded bytes`);
	}
	return JSON.parse(encoded) as WakeEvent;
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	if (Array.isArray(value)) {
		const valid = value.every((item) => isJsonValue(item, ancestors));
		ancestors.delete(value);
		return valid;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		ancestors.delete(value);
		return false;
	}
	const valid = Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}
