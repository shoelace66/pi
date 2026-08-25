export type WorkspaceOption = {
	id: string;
	name: string;
	path: string;
};

export type UiArtifact = {
	label: string;
	path: string;
};

export type UiCommand = {
	name: string;
	description: string;
	argumentHint?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
};

export type UiMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	thinking?: string;
	streaming?: boolean;
	artifacts: UiArtifact[];
};

export type UiActivity = {
	id: string;
	tool: string;
	detail: string;
	status: "running" | "succeeded" | "failed";
};

export type UiAutomation = {
	id: string;
	kind: "background_task" | "wake";
	title: string;
	detail: string;
	status: string;
	logPath?: string;
	canCancel: boolean;
};

export type UiRequest =
	| { id: string; method: "confirm"; title: string; message: string }
	| { id: string; method: "select"; title: string; options: string[] }
	| { id: string; method: "input" | "editor"; title: string; initialValue?: string };

export type ViewSnapshot = {
	trusted: boolean;
	workspaces: WorkspaceOption[];
	activeWorkspaceId?: string;
	connection: "view_only" | "starting" | "ready" | "running" | "error";
	model: string;
	sessionName: string;
	messages: UiMessage[];
	commands: UiCommand[];
	activities: UiActivity[];
	automations: UiAutomation[];
	pendingRequest?: UiRequest;
	notice?: string;
	error?: string;
};

export type HostToWebviewMessage =
	| { type: "snapshot"; snapshot: ViewSnapshot }
	| { type: "set_composer"; text: string };

export type WebviewToHostMessage =
	| { type: "ready" }
	| { type: "select_workspace"; workspaceId: string }
	| { type: "prompt"; text: string; includeEditorContext: boolean }
	| { type: "abort" }
	| { type: "new_session" }
	| { type: "refresh" }
	| { type: "retry" }
	| { type: "configure_api_key" }
	| { type: "open_settings" }
	| { type: "copy_text"; text: string }
	| { type: "open_external"; url: string }
	| { type: "cancel_automation"; automationId: string }
	| { type: "open_file"; path: string }
	| { type: "respond_ui"; requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean };

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
	if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
		return false;
	}
	const record = value as Record<string, unknown>;
	switch (record.type) {
		case "ready":
		case "abort":
		case "new_session":
		case "refresh":
		case "retry":
		case "configure_api_key":
		case "open_settings":
			return true;
		case "select_workspace":
			return typeof record.workspaceId === "string";
		case "prompt":
			return typeof record.text === "string" && typeof record.includeEditorContext === "boolean";
		case "cancel_automation":
			return typeof record.automationId === "string";
		case "open_file":
			return typeof record.path === "string";
		case "copy_text":
			return typeof record.text === "string";
		case "open_external":
			return typeof record.url === "string";
		case "respond_ui":
			return typeof record.requestId === "string";
		default:
			return false;
	}
}
