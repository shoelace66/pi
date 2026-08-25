import hljs from "highlight.js/lib/core";
import type {} from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import type {
	HostToWebviewMessage,
	UiAutomation,
	UiCommand,
	UiMessage,
	UiRequest,
	ViewSnapshot,
	WebviewToHostMessage,
} from "../shared/protocol.ts";

declare function acquireVsCodeApi<T>(): {
	postMessage(message: WebviewToHostMessage): void;
	getState(): T | undefined;
	setState(value: T): void;
};

type WebviewState = {
	composer: string;
	includeEditorContext: boolean;
	commandIndex?: number;
	automationPanelOpen?: boolean;
	requestInputs?: Record<string, string>;
};

for (const [name, language] of Object.entries({
	bash,
	cpp,
	csharp,
	css,
	go,
	java,
	javascript,
	json,
	markdown,
	python,
	rust,
	sql,
	typescript,
	xml,
	yaml,
})) {
	hljs.registerLanguage(name, language);
}

const vscode = acquireVsCodeApi<WebviewState>();
const rootNode = document.querySelector<HTMLElement>("#app");
if (!rootNode) throw new Error("AutoPi webview root is missing");
const root: HTMLElement = rootNode;

let snapshot: ViewSnapshot = {
	trusted: false,
	workspaces: [],
	connection: "view_only",
	model: "默认模型",
	sessionName: "未打开工作区",
	messages: [],
	commands: [],
	activities: [],
	automations: [],
};
let state: WebviewState = vscode.getState() ?? { composer: "", includeEditorContext: true };
let timelineScrollTop = 0;
let timelineStickToBottom = true;

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
	if (event.data.type === "snapshot") {
		snapshot = event.data.snapshot;
		const activeRequestId = snapshot.pendingRequest?.id;
		if (state.requestInputs) {
			state.requestInputs = activeRequestId && Object.hasOwn(state.requestInputs, activeRequestId)
				? { [activeRequestId]: state.requestInputs[activeRequestId] }
				: undefined;
			persist();
		}
	} else state.composer = event.data.text;
	render();
});

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
	const node = element("button", className, label);
	node.type = "button";
	node.addEventListener("click", action);
	return node;
}

function persist(): void {
	vscode.setState(state);
}

function send(message: WebviewToHostMessage): void {
	vscode.postMessage(message);
}

function renderConnectionStatus(): HTMLElement {
	const statusText = statusLabel(snapshot.connection);
	const status = element("span", `status-pill ${snapshot.connection}`);
	status.setAttribute("role", "status");
	status.title = `当前状态：${statusText}`;
	status.append(element("span", "status-dot"), document.createTextNode(statusText));
	return status;
}

function renderWorkspaceBar(): HTMLElement {
	const section = element("section", "workspace-bar");
	const controls = element("div", "workspace-controls");
	const label = element("label", "sr-only", "工作区");
	label.htmlFor = "workspace-select";
	const select = element("select", "workspace-select");
	select.id = "workspace-select";
	select.setAttribute("aria-label", "AutoPi 工作区");
	if (snapshot.workspaces.length === 0) {
		const option = element("option", undefined, "请先打开项目文件夹");
		option.value = "";
		select.append(option);
		select.disabled = true;
	} else {
		for (const workspace of snapshot.workspaces) {
			const option = element("option", undefined, workspace.name);
			option.value = workspace.id;
			option.title = workspace.path;
			option.selected = workspace.id === snapshot.activeWorkspaceId;
			select.append(option);
		}
	}
	select.addEventListener("change", () => send({ type: "select_workspace", workspaceId: select.value }));
	const newSession = button("新会话", "quiet-button", () => send({ type: "new_session" }));
	newSession.title = "开始新的 AutoPi 会话";
	controls.append(label, select, newSession);
	const meta = element("div", "workspace-meta");
	const details = element("div", "workspace-details");
	const session = element("strong", "session-name", snapshot.sessionName);
	session.title = snapshot.sessionName;
	const divider = element("span", "meta-divider", "·");
	divider.setAttribute("aria-hidden", "true");
	const model = element("span", "model-name", snapshot.model);
	model.title = snapshot.model;
	details.append(session, divider, model);
	meta.append(details, renderConnectionStatus());
	section.append(controls, meta);
	return section;
}

function renderBanner(): HTMLElement | undefined {
	if (!snapshot.trusted) {
		const banner = element("section", "banner warning");
		banner.setAttribute("role", "status");
		banner.append(
			element("strong", undefined, "当前为只读模式"),
			element("p", undefined, "AutoPi 不会在未受信任工作区启动后端或执行命令。请通过 VS Code 管理工作区信任后再继续。"),
		);
		return banner;
	}
	if (snapshot.error) {
		const banner = element("section", "banner error");
		banner.setAttribute("role", "alert");
		banner.append(
			element("strong", undefined, "后端启动失败"),
			element("p", undefined, snapshot.error),
			renderSetupActions(true),
		);
		return banner;
	}
	if (snapshot.notice) {
		const banner = element("section", "banner info");
		banner.setAttribute("role", "status");
		banner.append(
			element("strong", undefined, "发现上次未完成的自动化"),
			element("p", undefined, "为避免重复执行，AutoPi 没有自动续跑。你可以查看会话与日志后重新下达指令。"),
		);
		return banner;
	}
	return undefined;
}

function renderSetupActions(includeRetry: boolean): HTMLElement {
	const actions = element("div", "setup-actions");
	actions.append(
		button("配置 API 密钥", "primary-button small", () => send({ type: "configure_api_key" })),
		button("打开设置", "quiet-button small", () => send({ type: "open_settings" })),
	);
	if (includeRetry) actions.append(button("重试", "quiet-button small", () => send({ type: "retry" })));
	return actions;
}

function renderTimeline(): HTMLElement {
	const timeline = element("main", "timeline");
	timeline.setAttribute("aria-label", "会话记录");
	if (snapshot.messages.length === 0 && snapshot.activities.length === 0 && snapshot.automations.length === 0) {
		const empty = element("section", "empty-state");
		const mark = element("div", "empty-mark");
		mark.setAttribute("aria-hidden", "true");
		const wordmark = element("img", "empty-wordmark");
		wordmark.src = document.body.dataset.emptyWordmark ?? "";
		wordmark.alt = "";
		mark.append(wordmark);
		empty.append(
			mark,
			element("h2", undefined, "开始一次连续任务"),
			element("p", undefined, "说明目标、完成条件和输出位置，AutoPi 会持续推进并汇报进度。"),
			element("p", "empty-example", "例如：运行测试集，并在 reports/eval.md 生成结果报告。"),
		);
		if (snapshot.workspaces.length > 0) empty.append(renderSetupActions(false));
		timeline.append(empty);
		return timeline;
	}
	for (const message of snapshot.messages) timeline.append(renderMessage(message));
	if (snapshot.activities.length > 0) {
		const activities = element("section", "activity-list");
		const heading = element("div", "section-heading");
		heading.append(
			element("strong", undefined, "执行记录"),
			element("span", undefined, `${snapshot.activities.length} 项`),
		);
		activities.append(heading);
		for (const activity of snapshot.activities) {
			const card = element("details", `activity-card ${activity.status}`);
			card.open = activity.status !== "succeeded";
			const summary = element("summary", "activity-head");
			summary.append(
				element("span", "activity-dot"),
				element("strong", undefined, activity.tool),
				element("span", "activity-status", activityStatusLabel(activity.status)),
			);
			card.append(summary, element("pre", undefined, activity.detail));
			activities.append(card);
		}
		timeline.append(activities);
	}
	const automations = renderAutomations();
	if (automations) timeline.append(automations);
	return timeline;
}

function renderMessage(message: UiMessage): HTMLElement {
	const article = element("article", `message ${message.role}`);
	const header = element("div", "message-head");
	header.append(
		element("span", "role-dot"),
		element("strong", undefined, message.role === "assistant" ? "AutoPi" : message.role === "user" ? "你" : "系统"),
	);
	const body = element("div", "message-body");
	if (message.thinking) {
		const thinking = element("details", "thinking-panel");
		thinking.open = message.streaming === true;
		thinking.append(
			element("summary", "thinking-summary", message.streaming ? "正在思考…" : "思考过程"),
			element("div", "thinking-body", message.thinking),
		);
		body.append(thinking);
	}
	if (message.text) body.append(renderMarkdown(message.text));
	article.append(header, body);
	if (message.artifacts.length > 0) {
		const artifacts = element("div", "artifacts");
		for (const artifact of message.artifacts) {
			const open = button(`打开 ${artifact.label}`, "artifact-button", () =>
				send({ type: "open_file", path: artifact.path }),
			);
			open.title = artifact.path;
			artifacts.append(open);
		}
		article.append(artifacts);
	}
	return article;
}

const markdownTags = new Set([
	"A",
	"BLOCKQUOTE",
	"BR",
	"CODE",
	"DEL",
	"EM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HR",
	"LI",
	"OL",
	"P",
	"PRE",
	"STRONG",
	"TABLE",
	"TBODY",
	"TD",
	"TH",
	"THEAD",
	"TR",
	"UL",
]);

function renderMarkdown(source: string): HTMLElement {
	const output = element("div", "answer-body markdown-body");
	const template = document.createElement("template");
	template.innerHTML = marked.parse(source, { async: false, breaks: true, gfm: true });
	sanitizeMarkdown(template.content);
	output.append(template.content);
	for (const link of Array.from(output.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
		link.addEventListener("click", (event: MouseEvent) => {
			event.preventDefault();
			send({ type: "open_external", url: link.href });
		});
	}
	for (const code of Array.from(output.querySelectorAll<HTMLElement>("pre > code"))) enhanceCodeBlock(code);
	return output;
}

function sanitizeMarkdown(parent: ParentNode): void {
	for (const node of Array.from(parent.childNodes)) {
		if (node.nodeType === 8) {
			node.remove();
			continue;
		}
		if (node.nodeType !== 1) continue;
		const elementNode = node as Element;
		if (!markdownTags.has(elementNode.tagName.toUpperCase())) {
			node.replaceWith(document.createTextNode(node.textContent ?? ""));
			continue;
		}
		const htmlNode = elementNode as HTMLElement;
		const href = htmlNode.tagName === "A" ? safeExternalUrl(htmlNode.getAttribute("href") ?? "") : undefined;
		const title = htmlNode.getAttribute("title");
		const language =
			htmlNode.tagName === "CODE" ? htmlNode.className.match(/(?:^|\s)language-([\w+-]+)/i)?.[1] : undefined;
		const listStart = htmlNode.tagName === "OL" ? htmlNode.getAttribute("start") : undefined;
		const alignment =
			htmlNode.tagName === "TH" || htmlNode.tagName === "TD" ? htmlNode.getAttribute("align") : undefined;
		for (const attribute of Array.from(htmlNode.attributes)) htmlNode.removeAttribute(attribute.name);
		if (href) {
			htmlNode.setAttribute("href", href);
			htmlNode.setAttribute("rel", "noreferrer");
			if (title) htmlNode.setAttribute("title", title);
		}
		if (language) htmlNode.className = `language-${language}`;
		if (listStart && /^\d+$/.test(listStart)) htmlNode.setAttribute("start", listStart);
		if (alignment && /^(left|center|right)$/i.test(alignment)) htmlNode.setAttribute("align", alignment.toLowerCase());
		sanitizeMarkdown(htmlNode);
	}
}

function safeExternalUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		return new Set(["http:", "https:", "mailto:"]).has(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function enhanceCodeBlock(code: HTMLElement): void {
	const source = code.textContent ?? "";
	const language = code.className.match(/language-([\w+-]+)/i)?.[1]?.toLowerCase();
	const highlighted = language && hljs.getLanguage(language)
		? hljs.highlight(source, { language, ignoreIllegals: true })
		: hljs.highlightAuto(source);
	code.innerHTML = highlighted.value;
	code.classList.add("hljs");
	const pre = code.parentElement;
	if (!pre) return;
	const wrapper = element("div", "code-block");
	const toolbar = element("div", "code-toolbar");
	const languageLabel = element("span", "code-language", language ?? "text");
	const copy = button("复制", "quiet-button small code-copy", () => {
		send({ type: "copy_text", text: source });
		copy.textContent = "已复制";
	});
	copy.setAttribute("aria-label", `复制${language ?? "代码"}代码块`);
	toolbar.append(languageLabel, copy);
	pre.replaceWith(wrapper);
	wrapper.append(toolbar, pre);
}

function renderAutomations(): HTMLElement | undefined {
	if (snapshot.automations.length === 0) return undefined;
	const section = element("details", "automation-panel");
	const hasActiveTask = snapshot.automations.some((automation) => automation.canCancel);
	section.open = state.automationPanelOpen ?? hasActiveTask;
	section.addEventListener("toggle", () => {
		state.automationPanelOpen = section.open;
		persist();
	});
	const summary = element("summary", "automation-summary");
	const heading = element("span", "automation-heading");
	heading.append(
		element("strong", undefined, "后台任务"),
		element("span", "count-badge", String(snapshot.automations.length)),
	);
	summary.append(heading);
	if (hasActiveTask) summary.append(element("span", "active-task-label", "正在运行"));
	const list = element("div", "automation-list");
	for (const automation of snapshot.automations) list.append(renderAutomation(automation));
	section.append(summary, list);
	return section;
}

function renderAutomation(automation: UiAutomation): HTMLElement {
	const item = element("article", `automation-item${automation.canCancel ? " active" : ""}`);
	const title = element("div", "automation-title");
	title.append(element("strong", undefined, automation.title), element("span", "automation-status", automation.status));
	item.append(title, element("p", undefined, automation.detail));
	const actions = element("div", "automation-actions");
	if (automation.logPath) {
		actions.append(button("打开日志", "quiet-button small", () => send({ type: "open_file", path: automation.logPath! })));
	}
	if (automation.canCancel) {
		actions.append(button("取消", "danger-button small", () => send({ type: "cancel_automation", automationId: automation.id })));
	}
	if (actions.childElementCount > 0) item.append(actions);
	return item;
}

function renderRequest(request: UiRequest): HTMLElement {
	const overlay = element("section", "approval-panel");
	overlay.setAttribute("aria-label", "需要你的确认");
	overlay.append(element("span", "approval-kicker", "需要你的确认"), element("h3", undefined, request.title));
	if (request.method === "confirm") {
		overlay.append(element("p", undefined, request.message));
		const actions = element("div", "approval-actions");
		actions.append(
			button("拒绝", "danger-button", () => respondToRequest({ type: "respond_ui", requestId: request.id, confirmed: false })),
			button("允许", "primary-button", () => respondToRequest({ type: "respond_ui", requestId: request.id, confirmed: true })),
		);
		overlay.append(actions);
		return overlay;
	}
	if (request.method === "select") {
		const options = element("div", "approval-options");
		for (const option of request.options) {
			options.append(
				button(option, "quiet-button", () => respondToRequest({ type: "respond_ui", requestId: request.id, value: option })),
			);
		}
		overlay.append(options);
		const actions = element("div", "approval-actions");
		actions.append(
			button("取消", "quiet-button", () => respondToRequest({ type: "respond_ui", requestId: request.id, cancelled: true })),
		);
		overlay.append(actions);
	} else {
		const input = element("textarea", "approval-input");
		input.value = state.requestInputs?.[request.id] ?? request.initialValue ?? "";
		input.rows = request.method === "editor" ? 6 : 2;
		input.setAttribute("aria-label", request.title);
		input.addEventListener("input", () => {
			state.requestInputs ??= {};
			state.requestInputs[request.id] = input.value;
			persist();
		});
		overlay.append(input);
		const actions = element("div", "approval-actions");
		actions.append(
			button("取消", "quiet-button", () => respondToRequest({ type: "respond_ui", requestId: request.id, cancelled: true })),
			button("提交", "primary-button", () =>
				respondToRequest({ type: "respond_ui", requestId: request.id, value: input.value }),
			),
		);
		overlay.append(actions);
	}
	return overlay;
}

function respondToRequest(message: Extract<WebviewToHostMessage, { type: "respond_ui" }>): void {
	if (state.requestInputs) {
		delete state.requestInputs[message.requestId];
		if (Object.keys(state.requestInputs).length === 0) state.requestInputs = undefined;
		persist();
	}
	send(message);
}

function renderComposer(): HTMLElement {
	const section = element("footer", "composer-wrap");
	const composer = element("div", "composer");
	const input = element("textarea", "composer-input");
	input.placeholder = !snapshot.trusted
		? "信任工作区后可使用 AutoPi"
		: snapshot.pendingRequest
			? "请先完成上方确认"
			: "输入任务，/ 查看命令，Enter 发送…";
	input.value = state.composer;
	input.disabled = !snapshot.trusted || snapshot.workspaces.length === 0 || snapshot.pendingRequest !== undefined;
	input.rows = 1;
	input.setAttribute("aria-label", "任务描述");
	input.setAttribute("aria-keyshortcuts", "Enter");
	const isRunning = snapshot.connection === "running";
	let actionButton: HTMLButtonElement;
	const submitCurrent = (): void => {
		if (isRunning) return;
		submit(input);
		actionButton.disabled = input.disabled || input.value.trim().length === 0;
	};
	input.addEventListener("input", () => {
		state.composer = input.value;
		state.commandIndex = 0;
		persist();
		resizeComposer(input);
		composer.querySelector<HTMLElement>(".command-list")?.replaceWith(renderCommandSuggestions(input));
		if (!isRunning) actionButton.disabled = input.disabled || input.value.trim().length === 0;
	});
	input.addEventListener("keydown", (event) => {
		const commands = matchingCommands(input.value);
		if (commands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			state.commandIndex = ((state.commandIndex ?? 0) + direction + commands.length) % commands.length;
			persist();
			render();
			return;
		}
		if (commands.length > 0 && event.key === "Tab") {
			event.preventDefault();
			selectCommand(commands[state.commandIndex ?? 0] ?? commands[0]!, input);
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			if (!isRunning) submitCurrent();
		}
	});
	const bar = element("div", "composer-bar");
	const context = element("label", "context-toggle");
	const checkbox = element("input");
	checkbox.type = "checkbox";
	checkbox.checked = state.includeEditorContext;
	checkbox.title = "附带当前打开文件或选区的上下文";
	checkbox.addEventListener("change", () => {
		state.includeEditorContext = checkbox.checked;
		persist();
	});
	context.append(checkbox, element("span", "context-label", "附带当前文件/选区"));
	bar.append(context);
	if (isRunning) {
		actionButton = button("停止", "danger-button", () => send({ type: "abort" }));
	} else {
		actionButton = button("发送", "primary-button", submitCurrent);
		actionButton.disabled = input.disabled || input.value.trim().length === 0;
	}
	bar.append(actionButton);
	composer.append(renderCommandSuggestions(input), input, bar);
	section.append(composer);
	return section;
}

function matchingCommands(value: string): UiCommand[] {
	const match = /^[\\/]([^\s]*)$/.exec(value);
	if (!match) return [];
	const query = (match[1] ?? "").toLowerCase();
	return snapshot.commands
		.filter((command) => command.name.toLowerCase().includes(query))
		.sort((left, right) => {
			const leftPrefix = left.name.toLowerCase().startsWith(query) ? 0 : 1;
			const rightPrefix = right.name.toLowerCase().startsWith(query) ? 0 : 1;
			return leftPrefix - rightPrefix || left.name.localeCompare(right.name);
		})
		.slice(0, 10);
}

function renderCommandSuggestions(input: HTMLTextAreaElement): HTMLElement {
	const list = element("div", "command-list");
	const commands = matchingCommands(input.value);
	if (commands.length === 0) {
		list.hidden = true;
		return list;
	}
	list.setAttribute("role", "listbox");
	commands.forEach((command, index) => {
		const option = button(`/${command.name}`, `command-option${index === (state.commandIndex ?? 0) ? " selected" : ""}`, () =>
			selectCommand(command, input),
		);
		option.setAttribute("role", "option");
		option.setAttribute("aria-selected", String(index === (state.commandIndex ?? 0)));
		const text = element("span", "command-copy");
		text.append(
			element("strong", undefined, `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`),
			element("small", undefined, command.description),
		);
		option.replaceChildren(text, element("span", "command-source", commandSourceLabel(command.source)));
		list.append(option);
	});
	return list;
}

function selectCommand(command: UiCommand, input: HTMLTextAreaElement): void {
	const value = `/${command.name}${command.argumentHint ? " " : ""}`;
	state.composer = value;
	state.commandIndex = 0;
	persist();
	input.value = value;
	input.focus();
	input.setSelectionRange(value.length, value.length);
	resizeComposer(input);
	render();
}

function commandSourceLabel(source: UiCommand["source"]): string {
	switch (source) {
		case "builtin":
			return "内置";
		case "extension":
			return "扩展";
		case "prompt":
			return "提示词";
		case "skill":
			return "技能";
	}
}

function submit(input: HTMLTextAreaElement): void {
	const text = input.value.trim();
	if (!text || input.disabled) return;
	send({ type: "prompt", text, includeEditorContext: state.includeEditorContext });
	state.composer = "";
	persist();
	input.value = "";
	resizeComposer(input);
}

function resizeComposer(input: HTMLTextAreaElement): void {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function statusLabel(connection: ViewSnapshot["connection"]): string {
	switch (connection) {
		case "view_only":
			return "只读";
		case "starting":
			return "启动中";
		case "ready":
			return "就绪";
		case "running":
			return "执行中";
		case "error":
			return "错误";
	}
}

function activityStatusLabel(status: "running" | "succeeded" | "failed"): string {
	switch (status) {
		case "running":
			return "执行中";
		case "succeeded":
			return "已完成";
		case "failed":
			return "失败";
	}
}

function render(): void {
	const activeElement = document.activeElement;
	const composerHadFocus = activeElement instanceof HTMLTextAreaElement && activeElement.classList.contains("composer-input");
	const selectionStart = composerHadFocus ? activeElement.selectionStart : null;
	const selectionEnd = composerHadFocus ? activeElement.selectionEnd : null;
	const shell = element("div", "app-shell");
	shell.setAttribute("aria-busy", String(snapshot.connection === "starting" || snapshot.connection === "running"));
	shell.append(renderWorkspaceBar());
	const banner = renderBanner();
	if (banner) shell.append(banner);
	shell.append(renderTimeline());
	if (snapshot.pendingRequest) shell.append(renderRequest(snapshot.pendingRequest));
	shell.append(renderComposer());
	root.replaceChildren(shell);
	requestAnimationFrame(() => {
		const timeline = root.querySelector<HTMLElement>(".timeline");
		if (timeline) {
			timeline.scrollTop = timelineStickToBottom
				? timeline.scrollHeight
				: Math.min(timelineScrollTop, Math.max(0, timeline.scrollHeight - timeline.clientHeight));
			timeline.addEventListener("scroll", () => {
				timelineScrollTop = timeline.scrollTop;
				timelineStickToBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
			});
		}
		root.querySelector<HTMLElement>(".command-option.selected")?.scrollIntoView({ block: "nearest" });
		const composer = root.querySelector<HTMLTextAreaElement>(".composer-input");
		if (!composer) return;
		resizeComposer(composer);
		if (composerHadFocus && !composer.disabled) {
			composer.focus();
			if (selectionStart !== null && selectionEnd !== null) composer.setSelectionRange(selectionStart, selectionEnd);
		}
	});
}

send({ type: "ready" });
render();
