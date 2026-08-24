import type {
	HostToWebviewMessage,
	UiAutomation,
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
	automationPanelOpen?: boolean;
};

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
	activities: [],
	automations: [],
};
let state: WebviewState = vscode.getState() ?? { composer: "", includeEditorContext: true };

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
	if (event.data.type === "snapshot") snapshot = event.data.snapshot;
	else state.composer = event.data.text;
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
		banner.append(element("strong", undefined, "后端启动失败"), element("p", undefined, snapshot.error));
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
	body.textContent = message.text;
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
			button("拒绝", "danger-button", () => send({ type: "respond_ui", requestId: request.id, confirmed: false })),
			button("允许", "primary-button", () => send({ type: "respond_ui", requestId: request.id, confirmed: true })),
		);
		overlay.append(actions);
		return overlay;
	}
	if (request.method === "select") {
		const options = element("div", "approval-options");
		for (const option of request.options) {
			options.append(button(option, "quiet-button", () => send({ type: "respond_ui", requestId: request.id, value: option })));
		}
		overlay.append(options);
		const actions = element("div", "approval-actions");
		actions.append(button("取消", "quiet-button", () => send({ type: "respond_ui", requestId: request.id, cancelled: true })));
		overlay.append(actions);
	} else {
		const input = element("textarea", "approval-input");
		input.value = request.initialValue ?? "";
		input.rows = request.method === "editor" ? 6 : 2;
		input.setAttribute("aria-label", request.title);
		overlay.append(input);
		const actions = element("div", "approval-actions");
		actions.append(
			button("取消", "quiet-button", () => send({ type: "respond_ui", requestId: request.id, cancelled: true })),
			button("提交", "primary-button", () =>
				send({ type: "respond_ui", requestId: request.id, value: input.value }),
			),
		);
		overlay.append(actions);
	}
	return overlay;
}

function renderComposer(): HTMLElement {
	const section = element("footer", "composer-wrap");
	const composer = element("div", "composer");
	const input = element("textarea", "composer-input");
	input.placeholder = snapshot.trusted ? "输入任务，Enter 发送…" : "信任工作区后可使用 AutoPi";
	input.value = state.composer;
	input.disabled = !snapshot.trusted || snapshot.workspaces.length === 0;
	input.rows = 1;
	input.setAttribute("aria-label", "任务描述");
	input.setAttribute("aria-keyshortcuts", "Enter");
	const isRunning = snapshot.connection === "running";
	let actionButton: HTMLButtonElement;
	const submitCurrent = (): void => {
		submit(input);
		if (!isRunning) actionButton.disabled = input.disabled || input.value.trim().length === 0;
	};
	input.addEventListener("input", () => {
		state.composer = input.value;
		persist();
		resizeComposer(input);
		if (!isRunning) actionButton.disabled = input.disabled || input.value.trim().length === 0;
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submitCurrent();
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
	composer.append(input, bar);
	section.append(composer);
	return section;
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
	const previousTimeline = root.querySelector<HTMLElement>(".timeline");
	const previousScrollTop = previousTimeline?.scrollTop ?? 0;
	const shouldStickToBottom =
		!previousTimeline || previousTimeline.scrollHeight - previousTimeline.scrollTop - previousTimeline.clientHeight < 48;
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
			timeline.scrollTop = shouldStickToBottom ? timeline.scrollHeight : previousScrollTop;
		}
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
