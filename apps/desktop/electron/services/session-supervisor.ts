import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type MonitorRegistry,
	type OuterLoopRuntime,
	SessionManager,
	type Theme,
	type WakeRuntime,
	type WakeStore,
} from "@earendil-works/pi-coding-agent";

/** Serializable description of an extension dialog request (select/confirm/input). */
export type ExtensionDialogRequest =
	| { kind: "select"; title: string; options: string[] }
	| { kind: "confirm"; title: string; message: string }
	| { kind: "input"; title: string; placeholder?: string };

/** User answer for an ExtensionDialogRequest. "cancelled" maps to the dialog default value. */
export type ExtensionDialogResponse =
	| { outcome: "selected" | "entered"; value: string }
	| { outcome: "confirmed"; value: boolean }
	| { outcome: "cancelled" };

// A desktop dialog must never leave an extension command waiting forever when
// the renderer is hidden, the window loses focus, or a plugin forgets to pass
// its own timeout. Explicit extension timeouts still win; `0` preserves the
// runtime's no-timeout behavior for extensions that deliberately request it.
const DEFAULT_DESKTOP_DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

// Print-mode extensions still receive a Theme object. Keep it terminal-free so
// extensions such as plan-mode can format status text without emitting ANSI
// escape sequences into the renderer.
const DESKTOP_EXTENSION_THEME: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: (_color: string) => "",
	getBgAnsi: (_color: string) => "",
	getColorMode: () => "256color",
	getThinkingBorderColor: () => (text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

export type SessionSupervisorOptions = {
	wakeStore?: WakeStore;
	monitorRegistry?: MonitorRegistry;
	wakeRuntime?: WakeRuntime;
	outerLoopRuntime?: OuterLoopRuntime;
	onExtensionNotification?: (sessionFile: string, message: string, type: "info" | "warning" | "error") => void;
	onExtensionError?: (
		sessionFile: string,
		error: { extensionPath: string; event: string; error: string; stack?: string },
	) => void;
	/**
	 * Show an extension dialog in the desktop UI. The returned promise must settle
	 * with the user's answer, or with "cancelled" when the request can no longer be
	 * served. `options.signal` aborts when the dialog times out, the extension
	 * aborts, or the owning runtime is replaced/disposed; `options.timeout` is the
	 * raw dialog timeout for countdown display.
	 */
	onExtensionUIDialog?: (
		sessionFile: string,
		request: ExtensionDialogRequest,
		options: { signal: AbortSignal; timeout?: number },
	) => Promise<ExtensionDialogResponse>;
	onSessionReplaced?: (sessionFile: string, nextSessionFile: string, cwd: string, sessionId: string) => void;
};

export type SessionRuntime = {
	session: AgentSession;
	file?: string;
	cwd: string;
	refs: number;
	unsubscribe: () => void;
	onEvent: (event: AgentSessionEvent) => void;
};

export class SessionSupervisor {
	private readonly runtimes = new Map<string, SessionRuntime>();
	private readonly options: SessionSupervisorOptions;
	private readonly queues = new Map<string, Promise<void>>();
	private readonly opening = new Map<string, Promise<SessionRuntime>>();
	private readonly pendingDialogs = new Map<string, Set<AbortController>>();

	constructor(options: SessionSupervisorOptions = {}) {
		this.options = options;
	}

	/**
	 * Bind the same command/runtime hooks that Pi exposes in its other hosts.
	 *
	 * The desktop host intentionally keeps `mode: "print"`: extensions can run
	 * commands and use notifications, while terminal-only widgets and raw input
	 * remain unavailable instead of being emulated with fake state.
	 */
	private async bindDesktopExtensions(session: AgentSession, sessionFile: string): Promise<void> {
		const uiContext: ExtensionUIContext = {
			select: async (title, options, opts) => {
				const response = await this.requestDialog(sessionFile, { kind: "select", title, options }, opts);
				return response.outcome === "selected" ? response.value : undefined;
			},
			confirm: async (title, message, opts) => {
				const response = await this.requestDialog(sessionFile, { kind: "confirm", title, message }, opts);
				return response.outcome === "confirmed" ? response.value : false;
			},
			input: async (title, placeholder, opts) => {
				const response = await this.requestDialog(sessionFile, { kind: "input", title, placeholder }, opts);
				return response.outcome === "entered" ? response.value : undefined;
			},
			notify: (message, type = "info") => this.options.onExtensionNotification?.(sessionFile, message, type),
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return DESKTOP_EXTENSION_THEME;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};

		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => session.waitForIdle(),
			newSession: async (options) => {
				const current = this.runtimes.get(sessionFile);
				if (!current) return { cancelled: true };
				const sessionDir = session.sessionManager.getSessionDir();
				const nextManager = SessionManager.create(session.sessionManager.getCwd(), sessionDir, {
					parentSession: options?.parentSession,
				});
				const nextFile = nextManager.getSessionFile();
				if (!nextFile) return { cancelled: true };
				const next = await this.replaceRuntime(current, nextFile, session.sessionManager.getCwd());
				if (options?.withSession) await options.withSession(next.session.createReplacedSessionContext());
				return { cancelled: false };
			},
			fork: async (entryId, options) => {
				const current = this.runtimes.get(sessionFile);
				if (!current) return { cancelled: true };
				const entry = session.sessionManager.getEntry(entryId);
				if (!entry) throw new Error("Invalid entry ID for forking");
				const targetId = options?.position === "at" ? entry.id : entry.parentId;
				let nextFile: string | undefined;
				if (targetId) nextFile = session.sessionManager.createBranchedSession(targetId);
				else {
					const nextManager = SessionManager.create(
						session.sessionManager.getCwd(),
						session.sessionManager.getSessionDir(),
						{
							parentSession: session.sessionFile,
						},
					);
					nextFile = nextManager.getSessionFile();
				}
				if (!nextFile) throw new Error("Failed to create forked session");
				const next = await this.replaceRuntime(current, nextFile, session.sessionManager.getCwd());
				if (options?.withSession) await options.withSession(next.session.createReplacedSessionContext());
				return { cancelled: false };
			},
			navigateTree: (targetId, options) => session.navigateTree(targetId, options),
			switchSession: async (targetPath, options) => {
				const current = this.runtimes.get(sessionFile);
				const nextPath = resolve(targetPath);
				if (!current || !existsSync(nextPath)) throw new Error(`Session file not found: ${nextPath}`);
				if (nextPath === sessionFile) return { cancelled: false };
				const nextManager = SessionManager.open(nextPath);
				const next = await this.replaceRuntime(current, nextPath, nextManager.getCwd());
				if (options?.withSession) await options.withSession(next.session.createReplacedSessionContext());
				return { cancelled: false };
			},
			reload: () => session.reload(),
		};

		await session.bindExtensions({
			uiContext,
			mode: "print",
			commandContextActions,
			abortHandler: () => {
				void session.abort();
			},
			shutdownHandler: () => {},
			onError: (error) => this.options.onExtensionError?.(sessionFile, error),
		});
	}

	/**
	 * Forward an extension dialog to the desktop UI bridge with full lifecycle
	 * handling: the extension's abort signal, the dialog timeout, and runtime
	 * replacement/dispose. Every path resolves (never rejects) so extension
	 * commands cannot leave a session stuck waiting on the UI.
	 */
	private async requestDialog(
		sessionFile: string,
		request: ExtensionDialogRequest,
		opts: ExtensionUIDialogOptions | undefined,
	): Promise<ExtensionDialogResponse> {
		const bridge = this.options.onExtensionUIDialog;
		if (!bridge || opts?.signal?.aborted) return { outcome: "cancelled" };
		return new Promise((resolve) => {
			let settled = false;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeout = opts?.timeout === undefined ? DEFAULT_DESKTOP_DIALOG_TIMEOUT_MS : opts.timeout;
			const controller = new AbortController();
			const pending = this.pendingDialogs.get(sessionFile) ?? new Set<AbortController>();
			pending.add(controller);
			this.pendingDialogs.set(sessionFile, pending);
			const finish = (response: ExtensionDialogResponse): void => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onExtensionAbort);
				if (pending.delete(controller) && pending.size === 0) this.pendingDialogs.delete(sessionFile);
				resolve(response);
			};
			const onExtensionAbort = (): void => finish({ outcome: "cancelled" });
			opts?.signal?.addEventListener("abort", onExtensionAbort, { once: true });
			if (timeout > 0) timeoutId = setTimeout(onExtensionAbort, timeout);
			// Runtime replacement or dispose must not leave this dialog pending.
			controller.signal.addEventListener("abort", onExtensionAbort, { once: true });
			bridge(sessionFile, request, { signal: controller.signal, timeout: timeout > 0 ? timeout : undefined }).then(
				finish,
				onExtensionAbort,
			);
		});
	}

	/** Settle every pending extension dialog for a session file as cancelled. */
	private cancelPendingDialogs(sessionFile: string): void {
		const pending = this.pendingDialogs.get(sessionFile);
		if (!pending) return;
		this.pendingDialogs.delete(sessionFile);
		for (const controller of pending) controller.abort();
	}

	private async replaceRuntime(current: SessionRuntime, nextFile: string, cwd: string): Promise<SessionRuntime> {
		if (current.file === nextFile) return current;
		this.cancelPendingDialogs(current.file!);
		await current.session.abort();
		this.options.outerLoopRuntime?.unbindSession(current.file);
		current.unsubscribe();
		current.session.dispose();
		this.runtimes.delete(current.file!);
		const next = await this.createRuntime(nextFile, cwd, current.onEvent);
		next.refs = current.refs;
		this.options.onSessionReplaced?.(current.file!, nextFile, cwd, next.session.sessionId);
		return next;
	}

	async forkSession(
		sessionFile: string,
		entryId: string,
		position: "before" | "at" = "before",
	): Promise<SessionRuntime> {
		const current = this.runtimes.get(sessionFile);
		if (!current) throw new Error(`Unknown session: ${sessionFile}`);
		const entry = current.session.sessionManager.getEntry(entryId);
		if (!entry) throw new Error("Invalid entry ID for forking");
		const targetId = position === "at" ? entry.id : entry.parentId;
		let nextFile: string | undefined;
		if (targetId) nextFile = current.session.sessionManager.createBranchedSession(targetId);
		else {
			const nextManager = SessionManager.create(current.cwd, current.session.sessionManager.getSessionDir(), {
				parentSession: current.file,
			});
			nextFile = nextManager.getSessionFile();
		}
		if (!nextFile) throw new Error("Failed to create forked session");
		return this.replaceRuntime(current, nextFile, current.cwd);
	}

	async cloneSession(sessionFile: string): Promise<SessionRuntime> {
		const current = this.runtimes.get(sessionFile);
		if (!current) throw new Error(`Unknown session: ${sessionFile}`);
		const leafId = current.session.sessionManager.getLeafId();
		if (!leafId) throw new Error("Nothing to clone yet");
		return this.forkSession(sessionFile, leafId, "at");
	}

	async importSession(sessionFile: string, inputPath: string, cwdOverride?: string): Promise<SessionRuntime> {
		const current = this.runtimes.get(sessionFile);
		if (!current) throw new Error(`Unknown session: ${sessionFile}`);
		const sourcePath = resolve(inputPath);
		if (!existsSync(sourcePath)) throw new Error(`Session file not found: ${sourcePath}`);
		const sessionDir = current.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		const destination = join(sessionDir, basename(sourcePath));
		if (resolve(destination) !== sourcePath) copyFileSync(sourcePath, destination);
		const nextManager = SessionManager.open(destination, sessionDir, cwdOverride ?? current.cwd);
		return this.replaceRuntime(current, destination, nextManager.getCwd());
	}

	async switchSession(sessionFile: string, targetPath: string): Promise<SessionRuntime> {
		const current = this.runtimes.get(sessionFile);
		const nextPath = resolve(targetPath);
		if (!current || !existsSync(nextPath)) throw new Error(`Session file not found: ${nextPath}`);
		if (nextPath === sessionFile) return current;
		const nextManager = SessionManager.open(nextPath);
		return this.replaceRuntime(current, nextPath, nextManager.getCwd());
	}

	private async createRuntime(
		sessionFile: string,
		cwd: string,
		onEvent: (event: AgentSessionEvent) => void,
	): Promise<SessionRuntime> {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.open(sessionFile, undefined, cwd),
			cwd,
			wakeRuntime: this.options.wakeRuntime,
			customTools: this.options.outerLoopRuntime?.createTools(cwd),
		});
		this.options.outerLoopRuntime?.bindSession(session);
		await this.bindDesktopExtensions(session, sessionFile);
		const unsubscribe = session.subscribe(onEvent);
		const runtime: SessionRuntime = { session, file: sessionFile, cwd, refs: 1, unsubscribe, onEvent };
		this.runtimes.set(sessionFile, runtime);
		return runtime;
	}

	async open(sessionFile: string, cwd: string, onEvent: (event: AgentSessionEvent) => void): Promise<SessionRuntime> {
		const existing = this.runtimes.get(sessionFile);
		if (existing) {
			existing.refs++;
			return existing;
		}
		const pending = this.opening.get(sessionFile);
		if (pending) {
			const runtime = await pending;
			runtime.refs++;
			return runtime;
		}
		const creation = this.createRuntime(sessionFile, cwd, onEvent);
		this.opening.set(sessionFile, creation);
		try {
			return await creation;
		} finally {
			if (this.opening.get(sessionFile) === creation) this.opening.delete(sessionFile);
		}
	}

	/** Open for a UI read without taking another lifecycle reference. */
	async ensureOpen(
		sessionFile: string,
		cwd: string,
		onEvent: (event: AgentSessionEvent) => void,
	): Promise<SessionRuntime> {
		const existing = this.runtimes.get(sessionFile);
		if (existing) return existing;
		const pending = this.opening.get(sessionFile);
		if (pending) return pending;
		const creation = this.createRuntime(sessionFile, cwd, onEvent);
		this.opening.set(sessionFile, creation);
		try {
			return await creation;
		} finally {
			if (this.opening.get(sessionFile) === creation) this.opening.delete(sessionFile);
		}
	}

	async create(cwd: string, onEvent: (event: AgentSessionEvent) => void): Promise<SessionRuntime> {
		const { session } = await createAgentSession({
			cwd,
			sessionManager: SessionManager.create(cwd),
			wakeRuntime: this.options.wakeRuntime,
			customTools: this.options.outerLoopRuntime?.createTools(cwd),
		});
		this.options.outerLoopRuntime?.bindSession(session);
		const file = session.sessionFile;
		if (!file) throw new Error("GUI sessions must be persisted");
		await this.bindDesktopExtensions(session, file);
		const unsubscribe = session.subscribe(onEvent);
		const runtime: SessionRuntime = { session, file, cwd, refs: 1, unsubscribe, onEvent };
		this.runtimes.set(file, runtime);
		return runtime;
	}

	get(sessionFile: string): SessionRuntime | undefined {
		return this.runtimes.get(sessionFile);
	}

	/** Serialize all work that can mutate one AgentSession's conversation. */
	async runExclusive<T>(sessionFile: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(sessionFile) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = previous.then(() => gate);
		this.queues.set(sessionFile, current);
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.queues.get(sessionFile) === current) this.queues.delete(sessionFile);
		}
	}

	async release(sessionFile: string): Promise<void> {
		const runtime = this.runtimes.get(sessionFile);
		if (!runtime) return;
		runtime.refs--;
		if (runtime.refs > 0 || runtime.session.isStreaming) return;
		this.cancelPendingDialogs(sessionFile);
		this.options.outerLoopRuntime?.unbindSession(sessionFile);
		runtime.unsubscribe();
		runtime.session.dispose();
		this.runtimes.delete(sessionFile);
	}

	async close(sessionFile: string): Promise<void> {
		const runtime = this.runtimes.get(sessionFile);
		if (!runtime) return;
		if (runtime.session.isStreaming) throw new Error("Cannot close a session while it is running");
		this.cancelPendingDialogs(sessionFile);
		this.options.outerLoopRuntime?.unbindSession(sessionFile);
		runtime.unsubscribe();
		runtime.session.dispose();
		this.runtimes.delete(sessionFile);
		this.queues.delete(sessionFile);
	}

	async dispose(): Promise<void> {
		for (const [file, runtime] of this.runtimes) {
			this.cancelPendingDialogs(file);
			this.options.outerLoopRuntime?.unbindSession(file);
			runtime.unsubscribe();
			runtime.session.dispose();
			this.runtimes.delete(file);
		}
	}
}
