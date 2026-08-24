import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});

	it("sends automation list and cancel RPC commands", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data:
				command.type === "list_automations"
					? { automations: [] }
					: {
							automation: {
								kind: "background_task",
								id: "task-1",
								sessionId: "session-1",
								status: "cancelled",
								task: {},
							},
						},
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		expect(await client.listAutomations()).toEqual([]);
		expect((await client.cancelAutomation("task-1")).status).toBe("cancelled");
		expect(send).toHaveBeenNthCalledWith(1, { type: "list_automations", includeTerminal: false });
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "cancel_automation",
			automationId: "task-1",
			note: undefined,
		});
	});
});
