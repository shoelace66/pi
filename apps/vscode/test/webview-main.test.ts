import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostToWebviewMessage, ViewSnapshot, WebviewToHostMessage } from "../shared/protocol.ts";

const messages: WebviewToHostMessage[] = [];
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
	pretendToBeVisual: true,
});

function createSnapshot(
	connection: ViewSnapshot["connection"],
	overrides: Partial<ViewSnapshot> = {},
): ViewSnapshot {
	return {
		trusted: true,
		workspaces: [{ id: "workspace", name: "Workspace", path: "D:\\workspace" }],
		activeWorkspaceId: "workspace",
		connection,
		model: "provider/model",
		sessionName: "Test session",
		messages: [],
		commands: [
			{ name: "resume", description: "恢复历史会话", source: "builtin" },
			{ name: "model", description: "切换模型", source: "builtin" },
		],
		activities: [],
		automations: [],
		...overrides,
	};
}

function publishSnapshot(connection: ViewSnapshot["connection"], overrides: Partial<ViewSnapshot> = {}): void {
	const data: HostToWebviewMessage = { type: "snapshot", snapshot: createSnapshot(connection, overrides) };
	dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
}

function composer(): HTMLTextAreaElement {
	const input = dom.window.document.querySelector<HTMLTextAreaElement>(".composer-input");
	if (!input) throw new Error("Composer was not rendered");
	return input;
}

beforeAll(async () => {
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.window.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
	vi.stubGlobal("acquireVsCodeApi", () => ({
		postMessage(message: WebviewToHostMessage): void {
			messages.push(message);
		},
		getState: () => undefined,
		setState: vi.fn(),
	}));
	await import("../webview/main.ts");
});

afterAll(() => {
	vi.unstubAllGlobals();
	dom.window.close();
});

describe("VS Code Webview composer interactions", () => {
	it("shows matching command suggestions immediately on input", () => {
		publishSnapshot("ready");
		const input = composer();
		input.value = "/res";
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

		const options = Array.from(dom.window.document.querySelectorAll<HTMLElement>(".command-option"));
		expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining("/resume")]);
	});

	it("does not submit another prompt when Enter is pressed while running", () => {
		publishSnapshot("running");
		messages.splice(0);
		const input = composer();
		input.value = "下一条任务";
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

		expect(messages).not.toContainEqual(expect.objectContaining({ type: "prompt" }));
		expect(input.value).toBe("下一条任务");
	});

	it("renders sanitized Markdown with highlighting, links and code copy", () => {
		publishSnapshot("ready", {
			messages: [
				{
					id: "assistant-1",
					role: "assistant",
					text: '# 结果\n\n```ts\nconst answer = 42;\n```\n\n[项目](https://example.com/project)\n\n<img src=x onerror="alert(1)"><svg onload="alert(2)"></svg>',
					artifacts: [],
				},
			],
		});
		messages.splice(0);

		expect(dom.window.document.querySelector(".markdown-body h1")?.textContent).toBe("结果");
		expect(dom.window.document.querySelector("pre code.hljs .hljs-keyword")?.textContent).toBe("const");
		expect(dom.window.document.querySelector(".markdown-body img")).toBeNull();
		expect(dom.window.document.querySelector(".markdown-body svg")).toBeNull();
		dom.window.document.querySelector<HTMLButtonElement>(".code-copy")?.click();
		dom.window.document.querySelector<HTMLAnchorElement>(".markdown-body a")?.click();

		expect(messages).toContainEqual({ type: "copy_text", text: "const answer = 42;\n" });
		expect(messages).toContainEqual({ type: "open_external", url: "https://example.com/project" });
	});

	it("preserves approval drafts across snapshots and disables normal prompts", () => {
		const pendingRequest = { id: "approval-1", method: "editor" as const, title: "补充说明", initialValue: "初始值" };
		publishSnapshot("running", { pendingRequest });
		const approval = dom.window.document.querySelector<HTMLTextAreaElement>(".approval-input");
		expect(approval).not.toBeNull();
		approval!.value = "已经填写但尚未提交";
		approval!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

		publishSnapshot("running", { pendingRequest, activities: [] });

		expect(dom.window.document.querySelector<HTMLTextAreaElement>(".approval-input")?.value).toBe("已经填写但尚未提交");
		expect(composer().disabled).toBe(true);
	});

	it("offers setup actions on the first-use screen and startup errors", () => {
		publishSnapshot("ready");
		messages.splice(0);
		const configure = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".setup-actions button")).find(
			(candidate) => candidate.textContent === "配置 API 密钥",
		);
		configure?.click();
		expect(messages).toContainEqual({ type: "configure_api_key" });

		publishSnapshot("error", { error: "missing API key" });
		const actions = Array.from(
			dom.window.document.querySelectorAll<HTMLButtonElement>(".banner.error .setup-actions button"),
		);
		expect(actions.map((candidate) => candidate.textContent)).toEqual(["配置 API 密钥", "打开设置", "重试"]);
	});
});
