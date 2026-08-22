import type { WakeEvent, WakeReceipt, WakeSource } from "./types.ts";

export const WAKE_WIRE_VERSION = 1;
export const MAX_WAKE_FRAME_BYTES = 128 * 1024;

export type WakeWireRequest = {
	version: 1;
	resourceId: string;
	token: string;
	event: WakeEvent;
	source?: WakeSource;
};

export type WakeWireResponse =
	| { version: 1; ok: true; receipt: WakeReceipt }
	| {
			version: 1;
			ok: false;
			error: { code: string; message: string; retryAfterMs?: number };
	  };

export function encodeWakeFrame(value: WakeWireRequest | WakeWireResponse): Buffer {
	const payload = Buffer.from(JSON.stringify(value), "utf8");
	if (payload.byteLength > MAX_WAKE_FRAME_BYTES) throw new Error("Wake IPC frame is too large");
	const frame = Buffer.allocUnsafe(payload.byteLength + 4);
	frame.writeUInt32BE(payload.byteLength, 0);
	payload.copy(frame, 4);
	return frame;
}

export class WakeFrameDecoder {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
		const values: unknown[] = [];
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32BE(0);
			if (length <= 0 || length > MAX_WAKE_FRAME_BYTES) throw new Error("Invalid Wake IPC frame length");
			if (this.buffer.length < length + 4) break;
			values.push(JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")) as unknown);
			this.buffer = this.buffer.subarray(length + 4);
		}
		return values;
	}
}
