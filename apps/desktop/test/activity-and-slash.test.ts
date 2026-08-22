import assert from "node:assert/strict";
import test from "node:test";
import {
	DESKTOP_ACTIVITY_PAGE_SIZE,
	desktopActivityWindow,
	desktopTimelineActivities,
	filterDesktopActivities,
	sortDesktopActivities,
	upsertDesktopActivity,
} from "../shared/activity.ts";
import { isSlashInput, parseShellInput, parseSlashInput } from "../shared/slash.ts";
import type { DesktopActivity, DesktopSlashCommand } from "../shared/view-models.ts";
import { translate } from "../renderer/src/i18n.tsx";

const commands: DesktopSlashCommand[] = [
	{
		id: "model",
		command: "/model",
		title: "Select model",
		description: "Select a model",
		section: "Pi",
		argumentHint: "<provider/model>",
		source: "builtin",
	},
	{
		id: "plugin:review",
		command: "/review",
		title: "Review",
		description: "Run the review plugin",
		section: "Extensions",
		argumentHint: "<scope>",
		source: "extension",
	},
];

test("parses known slash commands and keeps arguments out of the command name", () => {
	const parsed = parseSlashInput("/model deepseek/deepseek-chat", commands);
	assert.equal(parsed?.command.id, "model");
	assert.equal(parsed?.args, "deepseek/deepseek-chat");
	assert.equal(parseSlashInput("/unknown value", commands), undefined);
	assert.equal(isSlashInput("  /model"), true);
	assert.equal(isSlashInput("hello /model"), false);
});

test("parses shell commands and preserves context exclusion", () => {
	assert.deepEqual(parseShellInput("! npm test"), { command: "npm test", excludeFromContext: false });
	assert.deepEqual(parseShellInput("  !! git status  "), { command: "git status", excludeFromContext: true });
	assert.equal(parseShellInput("!  "), undefined);
	assert.equal(parseShellInput("plain text"), undefined);
});

test("translates desktop UI text while slash command metadata remains unchanged", () => {
	assert.equal(translate("zh-CN", "Settings"), "设置");
	assert.equal(translate("zh-CN", "{count} messages", { count: 3 }), "3 条消息");
	assert.equal(translate("en", "Settings"), "Settings");
	assert.equal(commands[0]?.command, "/model");
	assert.equal(commands[0]?.description, "Select a model");
});

test("sorts and replaces activities without duplicating tool updates", () => {
	const first: DesktopActivity = {
		kind: "status",
		id: "run",
		occurredAt: "2026-01-01T00:00:00.000Z",
		status: "run_started",
	};
	const tool: DesktopActivity = {
		kind: "tool",
		id: "tool-1",
		occurredAt: "2026-01-01T00:00:01.000Z",
		tool: {
			id: "tool-1",
			toolName: "read",
			status: "running",
			startedAt: "2026-01-01T00:00:01.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
		},
	};
	const completed: DesktopActivity = {
		...tool,
		occurredAt: "2026-01-01T00:00:02.000Z",
		tool: { ...tool.tool, status: "completed", updatedAt: "2026-01-01T00:00:02.000Z" },
	};
	assert.deepEqual(sortDesktopActivities([tool, first]).map((item) => item.id), ["run", "tool-1"]);
	assert.deepEqual(upsertDesktopActivity([first, tool], completed).map((item) => item.id), ["run", "tool-1"]);
	assert.equal((upsertDesktopActivity([first, tool], completed)[1] as Extract<DesktopActivity, { kind: "tool" }>).tool.status, "completed");
	const toolPhase: DesktopActivity = {
		...first,
		occurredAt: "2026-01-01T00:00:03.000Z",
		phase: "tool",
		message: "Running tool: write",
	};
	const updatedRun = upsertDesktopActivity([first, tool], toolPhase);
	assert.deepEqual(updatedRun.map((item) => item.id), ["tool-1", "run"]);
	assert.equal(updatedRun.length, 2);
});

test("opens long histories with a bounded activity window", () => {
	const activities: DesktopActivity[] = Array.from({ length: 175 }, (_, index) => ({
		kind: "status",
		id: `activity-${index}`,
		occurredAt: new Date(index).toISOString(),
		status: "run_completed",
	}));
	const initial = desktopActivityWindow(activities, DESKTOP_ACTIVITY_PAGE_SIZE);
	assert.equal(initial.hiddenCount, 125);
	assert.equal(initial.activities.length, 50);
	assert.equal(initial.activities[0]?.id, "activity-125");
	const expanded = desktopActivityWindow(activities, DESKTOP_ACTIVITY_PAGE_SIZE * 2);
	assert.equal(expanded.hiddenCount, 75);
	assert.equal(expanded.activities[0]?.id, "activity-75");
});

test("filters messages, tools, and failures without changing the source order", () => {
	const activities: DesktopActivity[] = [
		{
			kind: "message",
			id: "message-1",
			occurredAt: "2026-01-01T00:00:00.000Z",
			message: { id: "message-1", role: "user", text: "hello" },
		},
		{
			kind: "tool",
			id: "tool-1",
			occurredAt: "2026-01-01T00:00:01.000Z",
			tool: {
				id: "tool-1",
				toolName: "read",
				status: "error",
				startedAt: "2026-01-01T00:00:01.000Z",
				updatedAt: "2026-01-01T00:00:02.000Z",
			},
		},
		{
			kind: "status",
			id: "run-1",
			occurredAt: "2026-01-01T00:00:03.000Z",
			status: "run_error",
		},
	];
	assert.deepEqual(filterDesktopActivities(activities, "messages").map((item) => item.id), ["message-1"]);
	assert.deepEqual(filterDesktopActivities(activities, "tools").map((item) => item.id), ["tool-1"]);
	assert.deepEqual(filterDesktopActivities(activities, "errors").map((item) => item.id), ["tool-1", "run-1"]);
	assert.equal(filterDesktopActivities(activities, "all"), activities);
});

test("shows only the newest live run phase and keeps it at the end of the conversation", () => {
	const activities: DesktopActivity[] = [
		{
			kind: "message",
			id: "user-1",
			occurredAt: "2026-01-01T00:00:00.000Z",
			message: { id: "user-1", role: "user", text: "hello" },
		},
		{
			kind: "status",
			id: "stale-run-start",
			occurredAt: "2026-01-01T00:00:01.000Z",
			status: "run_started",
			message: "Pi is working…",
		},
		{
			kind: "status",
			id: "current-run",
			occurredAt: "2026-01-01T00:00:02.000Z",
			status: "run_started",
			phase: "tool",
			message: "Running tool: write",
		},
	];
	assert.deepEqual(desktopTimelineActivities(activities, true).map((activity) => activity.id), ["user-1", "current-run"]);
	assert.deepEqual(desktopTimelineActivities(activities, false).map((activity) => activity.id), ["user-1"]);
});
