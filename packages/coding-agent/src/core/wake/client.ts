import { createConnection } from "node:net";
import { parseWakeCapability, validateWakeEvent } from "./capability.ts";
import type { WakeCapabilityAddress, WakeEvent, WakeReceipt, WakeSource } from "./types.ts";
import { WakeClientError } from "./types.ts";
import {
	encodeWakeFrame,
	WAKE_WIRE_VERSION,
	WakeFrameDecoder,
	type WakeWireRequest,
	type WakeWireResponse,
} from "./wire.ts";

export type WakeClientOptions = { timeoutMs?: number };

function responseError(response: Extract<WakeWireResponse, { ok: false }>): WakeClientError {
	const knownCodes = new Set([
		"WAKE_INVALID_ADDRESS",
		"WAKE_INVALID_EVENT",
		"WAKE_UNAUTHORIZED",
		"WAKE_REVOKED",
		"WAKE_OFFLINE",
		"WAKE_BUSY",
		"WAKE_SESSION_NOT_PERSISTED",
		"WAKE_SESSION_OWNED",
		"WAKE_RUNTIME_STOPPED",
		"WAKE_INTERNAL",
	]);
	const code = knownCodes.has(response.error.code) ? response.error.code : "WAKE_INTERNAL";
	return new WakeClientError(code as WakeClientError["code"], response.error.message, {
		retryAfterMs: response.error.retryAfterMs,
	});
}

export class WakeClient {
	private readonly timeoutMs: number;

	constructor(options: WakeClientOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 5_000;
	}

	emit(address: WakeCapabilityAddress | string, event: WakeEvent): Promise<WakeReceipt> {
		return this.emitWithSource(address, event, undefined);
	}

	/** @internal Used by a bound WakeContext to attach low-trust source metadata. */
	async emitWithSource(
		address: WakeCapabilityAddress | string,
		event: WakeEvent,
		source: WakeSource | undefined,
	): Promise<WakeReceipt> {
		const capability = parseWakeCapability(address);
		const request: WakeWireRequest = {
			version: WAKE_WIRE_VERSION,
			resourceId: capability.resourceId,
			token: capability.token,
			event: validateWakeEvent(event),
			source,
		};
		return new Promise<WakeReceipt>((resolve, reject) => {
			const socket = createConnection(capability.endpoint);
			const decoder = new WakeFrameDecoder();
			let settled = false;
			const finish = (error?: unknown, receipt?: WakeReceipt): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve(receipt!);
			};
			const timer = setTimeout(
				() => finish(new WakeClientError("WAKE_OFFLINE", "Wake target did not respond before the timeout")),
				this.timeoutMs,
			);
			timer.unref();
			socket.once("connect", () => socket.write(encodeWakeFrame(request)));
			socket.on("data", (chunk) => {
				try {
					for (const value of decoder.push(chunk)) {
						const response = value as Partial<WakeWireResponse>;
						if (response.version !== WAKE_WIRE_VERSION || typeof response.ok !== "boolean") {
							throw new Error("Invalid Wake IPC response");
						}
						if (response.ok) finish(undefined, response.receipt);
						else finish(responseError(response as Extract<WakeWireResponse, { ok: false }>));
						return;
					}
				} catch (error) {
					finish(
						new WakeClientError("WAKE_INTERNAL", "Wake target returned an invalid response", { cause: error }),
					);
				}
			});
			socket.once("error", (error) => {
				finish(new WakeClientError("WAKE_OFFLINE", "Wake target is offline", { cause: error }));
			});
			socket.once("close", () => {
				if (!settled) finish(new WakeClientError("WAKE_OFFLINE", "Wake target closed the connection"));
			});
		});
	}
}
