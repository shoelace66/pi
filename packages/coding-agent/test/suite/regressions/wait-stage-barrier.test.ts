import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function tools(executed: string[], failWait = false): AgentTool[] {
	return [
		{
			name: "background_task",
			label: "Background task",
			description: "Start a background task",
			parameters: Type.Object({ action: Type.String() }),
			executionMode: "sequential",
			execute: async () => {
				executed.push("background_task");
				return textResult("started");
			},
		},
		{
			name: "outer_loop",
			label: "Outer loop",
			description: "Wait for a background task",
			parameters: Type.Object({ action: Type.String() }),
			executionMode: "sequential",
			execute: async () => {
				executed.push("outer_loop");
				if (failWait) throw new Error("wait registration failed");
				return textResult("armed");
			},
		},
		{
			name: "bash",
			label: "Bash",
			description: "Run a dependent command",
			parameters: Type.Object({ command: Type.String() }),
			executionMode: "sequential",
			execute: async () => {
				executed.push("bash");
				return textResult("ran");
			},
		},
	];
}

describe("outer_loop wait stage barrier", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("blocks tools after a successful wait and terminates the turn", async () => {
		const executed: string[] = [];
		const harness = await createHarness({ tools: tools(executed) });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("background_task", { action: "start" }),
					fauxToolCall("outer_loop", { action: "wait_task" }),
					fauxToolCall("bash", { command: "dependent" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("must not continue before wake"),
		]);

		await harness.session.prompt("run pipeline");

		expect(executed).toEqual(["background_task", "outer_loop"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("must not continue before wake");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(3);
		expect(results[2]).toMatchObject({ isError: true });
		expect(harness.eventsOfType("tool_execution_end").map((event) => event.result.terminate)).toEqual([
			true,
			true,
			true,
		]);
	});

	it("blocks the preplanned dependent tool but lets the model recover after wait registration fails", async () => {
		const executed: string[] = [];
		const harness = await createHarness({ tools: tools(executed, true) });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("background_task", { action: "start" }),
					fauxToolCall("outer_loop", { action: "wait_task" }),
					fauxToolCall("bash", { command: "dependent" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("diagnosed registration failure"),
		]);

		await harness.session.prompt("run pipeline");

		expect(executed).toEqual(["background_task", "outer_loop"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(harness)).toContain("diagnosed registration failure");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results[1]).toMatchObject({ isError: true });
		expect(results[2]).toMatchObject({ isError: true });
		expect(harness.eventsOfType("tool_execution_end").map((event) => event.result.terminate)).toEqual([
			true,
			undefined,
			true,
		]);
	});
});
