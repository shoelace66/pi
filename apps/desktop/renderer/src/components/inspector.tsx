import { useState } from "react";
import type { CreateWakeRequest } from "../../../shared/ipc-contract.ts";
import type {
	DeferredMessageView,
	DesktopFileListing,
	DesktopSessionSnapshot,
	DesktopWorkspaceChanges,
	WakeJobView,
} from "../../../shared/view-models.ts";
import { useI18n } from "../i18n.tsx";
import { AlertIcon, BellIcon, CloseIcon, CodeIcon, FolderIcon, PlusIcon, SparkleIcon } from "../icons.tsx";
import { cn, localDateTimeValue, statusLabel, wakeStatusLabel } from "../utils.ts";

export type InspectorTab = "runtime" | "files" | "changes" | "automations";

export function Inspector({
	tab,
	jobs,
	inbox,
	canCreate,
	onTabChange,
	onClose,
	onCreate,
	onInbox,
	onCancel,
	files,
	changes,
	loading,
	error,
	session,
	onRefresh,
}: {
	readonly tab: InspectorTab;
	readonly jobs: readonly WakeJobView[];
	readonly inbox: Readonly<Record<string, DeferredMessageView[]>>;
	readonly canCreate: boolean;
	readonly onTabChange: (tab: InspectorTab) => void;
	readonly onClose: () => void;
	readonly onCreate: () => void;
	readonly onInbox: (job: WakeJobView) => void;
	readonly onCancel: (job: WakeJobView) => void;
	readonly files?: DesktopFileListing;
	readonly changes?: DesktopWorkspaceChanges;
	readonly loading: boolean;
	readonly error?: string;
	readonly session?: DesktopSessionSnapshot;
	readonly onRefresh: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<aside className="inspector">
			<header className="inspector-header">
				<div className="inspector-tabs">
					<button
						type="button"
						className={cn(tab === "runtime" && "active")}
						onClick={() => onTabChange("runtime")}
						title={t("Runtime")}
					>
						<SparkleIcon width={15} height={15} />
					</button>
					<button
						type="button"
						className={cn(tab === "files" && "active")}
						onClick={() => onTabChange("files")}
						title={t("Files")}
					>
						<FolderIcon width={15} height={15} />
					</button>
					<button
						type="button"
						className={cn(tab === "changes" && "active")}
						onClick={() => onTabChange("changes")}
						title={t("Changes")}
					>
						<CodeIcon width={15} height={15} />
					</button>
					<button
						type="button"
						className={cn(tab === "automations" && "active")}
						onClick={() => onTabChange("automations")}
						title={t("Automations")}
					>
						<BellIcon width={15} height={15} />
					</button>
				</div>
				<button type="button" className="icon-button" onClick={onClose} aria-label={t("Close inspector")}>
					<CloseIcon width={15} height={15} />
				</button>
			</header>
			{tab === "runtime" ? (
				<RuntimePanel session={session} />
			) : tab === "automations" ? (
				<AutomationList
					jobs={jobs}
					inbox={inbox}
					canCreate={canCreate}
					onCreate={onCreate}
					onInbox={onInbox}
					onCancel={onCancel}
				/>
			) : tab === "files" ? (
				<FilesPanel files={files} loading={loading} error={error} onRefresh={onRefresh} />
			) : (
				<ChangesPanel changes={changes} loading={loading} error={error} onRefresh={onRefresh} />
			)}
		</aside>
	);
}

function RuntimePanel({ session }: { readonly session?: DesktopSessionSnapshot }): React.JSX.Element {
	const { language, t } = useI18n();
	if (!session) {
		return (
			<div className="inspector-placeholder">
				<span>
					<SparkleIcon width={20} height={20} />
				</span>
				<h3>{t("No active runtime")}</h3>
				<p>{t("Open a chat to inspect its execution mode, tools, resources, and Outer Loop registration.")}</p>
			</div>
		);
	}
	const activeWakeCount = session.wakeJobs.filter((job) =>
		["armed", "ready", "running", "run_retry_wait", "blocked", "cancel_requested"].includes(job.status),
	).length;
	const contextLabel = session.contextUsage
		? `${session.contextUsage.tokens?.toLocaleString() ?? t("Unknown")} / ${session.contextUsage.contextWindow.toLocaleString()} (${session.contextUsage.percent?.toFixed(1) ?? "?"}%)`
		: t("Unavailable");
	return (
		<div className="runtime-panel">
			<div className="inspector-title-row">
				<div>
					<h2>{t("Runtime")}</h2>
					<p>{t("Live capabilities registered for this chat.")}</p>
				</div>
				<span className={cn("runtime-mode-badge", session.mode)}>
					{session.mode === "plan" ? t("Plan") : t("Build")}
				</span>
			</div>
			<div className="runtime-facts">
				<div>
					<span>{t("Status")}</span>
					<strong>{statusLabel(session.status, language)}</strong>
				</div>
				<div>
					<span>{t("Model")}</span>
					<strong>{session.model ? `${session.model.provider}/${session.model.id}` : t("Not selected")}</strong>
				</div>
				<div>
					<span>{t("Thinking")}</span>
					<strong>{t(session.thinkingLevel[0].toUpperCase() + session.thinkingLevel.slice(1))}</strong>
				</div>
				<div>
					<span>{t("Context")}</span>
					<strong>{contextLabel}</strong>
				</div>
				<div>
					<span>{t("Project trust")}</span>
					<strong>{session.projectTrusted ? t("Trusted") : t("Restricted")}</strong>
				</div>
				<div>
					<span>{t("Outer Loop")}</span>
					<strong>{session.runtime.outerLoopEnabled ? t("Enabled") : t("Disabled")}</strong>
				</div>
				<div>
					<span>{t("Scheduler")}</span>
					<strong>{session.runtime.scheduler === "running" ? t("Running") : session.runtime.scheduler}</strong>
				</div>
				<div>
					<span>{t("Active automations")}</span>
					<strong>{activeWakeCount}</strong>
				</div>
				<div>
					<span>{t("Queued messages")}</span>
					<strong>{session.queue.steering.length + session.queue.followUp.length}</strong>
				</div>
				<div>
					<span>{t("Messages")}</span>
					<strong>{session.messages.length}</strong>
				</div>
			</div>
			<section className="runtime-identity">
				<span>{t("Session ID")}</span>
				<code title={session.id}>{session.id}</code>
				<span>{t("Session file")}</span>
				<code title={session.sessionFile}>{session.sessionFile}</code>
			</section>
			<RuntimeList title={t("Active tools")} items={session.runtime.activeTools} emphasized="outer_loop" />
			<RuntimeList title={t("Monitor adapters")} items={session.runtime.monitorAdapters} />
			<RuntimeList
				title={t("Extension commands")}
				items={session.runtime.extensionCommands.map((item) => `/${item}`)}
			/>
			<RuntimeList title={t("Prompt templates")} items={session.runtime.promptTemplates.map((item) => `/${item}`)} />
			<RuntimeList title={t("Skills")} items={session.runtime.skills} />
			<RuntimeList title={t("Steering queue")} items={session.queue.steering} />
			<RuntimeList title={t("Follow-up queue")} items={session.queue.followUp} />
			{session.mode === "plan" && (
				<div className="inline-note">
					{t("Plan mode is active. Editing tools such as edit and write are intentionally unavailable.")}
				</div>
			)}
		</div>
	);
}

function RuntimeList({
	title,
	items,
	emphasized,
}: {
	readonly title: string;
	readonly items: readonly string[];
	readonly emphasized?: string;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<section className="runtime-list">
			<h3>
				{title}
				<span>{items.length}</span>
			</h3>
			{items.length === 0 ? (
				<p className="group-empty">{t("None registered")}</p>
			) : (
				<div className="runtime-chips">
					{items.map((item) => (
						<code className={cn(item === emphasized && "emphasized")} key={item}>
							{item}
						</code>
					))}
				</div>
			)}
		</section>
	);
}

function FilesPanel({
	files,
	loading,
	error,
	onRefresh,
}: {
	readonly files?: DesktopFileListing;
	readonly loading: boolean;
	readonly error?: string;
	readonly onRefresh: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="inspector-data-panel">
			<div className="inspector-title-row">
				<div>
					<h2>{t("Files")}</h2>
					<p>{t("Workspace files available for reference. Git metadata and dependency folders are excluded.")}</p>
				</div>
				<button type="button" className="quiet-button" onClick={onRefresh} disabled={loading}>
					{t("Refresh")}
				</button>
			</div>
			{error ? (
				<div className="error-banner">{error}</div>
			) : loading ? (
				<p className="group-empty">{t("Loading files…")}</p>
			) : !files || files.entries.length === 0 ? (
				<p className="group-empty">{t("No files found in this workspace.")}</p>
			) : (
				<>
					{(files.truncated || files.unreadableCount > 0) && (
						<p className="capability-note">
							{files.truncated && t("Showing the first {count} entries.", { count: files.limit })}
							{files.truncated && files.unreadableCount > 0 ? " " : ""}
							{files.unreadableCount > 0 &&
								t("{count} paths could not be read.", { count: files.unreadableCount })}
						</p>
					)}
					<div className="file-list">
						{files.entries.map((file) => (
							<div className="file-row" key={file.path}>
								<span>
									{file.kind === "directory" ? (
										<FolderIcon width={13} height={13} />
									) : (
										<CodeIcon width={13} height={13} />
									)}
								</span>
								<code title={file.path}>{file.path}</code>
								{file.size !== undefined && <small>{formatBytes(file.size)}</small>}
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function ChangesPanel({
	changes,
	loading,
	error,
	onRefresh,
}: {
	readonly changes?: DesktopWorkspaceChanges;
	readonly loading: boolean;
	readonly error?: string;
	readonly onRefresh: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	return (
		<div className="inspector-data-panel">
			<div className="inspector-title-row">
				<div>
					<h2>{t("Changes")}</h2>
					<p>{t("Git working tree status for this workspace.")}</p>
				</div>
				<button type="button" className="quiet-button" onClick={onRefresh} disabled={loading}>
					{t("Refresh")}
				</button>
			</div>
			{error ? (
				<div className="error-banner">{error}</div>
			) : loading ? (
				<p className="group-empty">{t("Checking changes…")}</p>
			) : changes?.error ? (
				<div className="error-banner">{changes.error}</div>
			) : !changes?.repository ? (
				<div className="inspector-placeholder">
					<span>
						<CodeIcon width={20} height={20} />
					</span>
					<h3>{t("Not a Git repository")}</h3>
					<p>{t("Changes will appear here after this workspace is initialized as a Git repository.")}</p>
				</div>
			) : changes.entries.length === 0 ? (
				<p className="group-empty">{t("Working tree clean.")}</p>
			) : (
				<div className="change-list">
					{changes.entries.map((entry) => (
						<div className="change-row" key={`${entry.status}:${entry.path}`}>
							<strong>{entry.status}</strong>
							<code title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
								{entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
							</code>
							<small>
								{entry.staged && entry.unstaged
									? t("Staged + working tree")
									: entry.staged
										? t("Staged")
										: entry.status === "??"
											? t("Untracked")
											: t("Working tree")}
							</small>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const activeStatuses = new Set(["armed", "ready", "running", "run_retry_wait", "blocked", "cancel_requested"]);

function AutomationList({
	jobs,
	inbox,
	canCreate,
	onCreate,
	onInbox,
	onCancel,
}: {
	readonly jobs: readonly WakeJobView[];
	readonly inbox: Readonly<Record<string, DeferredMessageView[]>>;
	readonly canCreate: boolean;
	readonly onCreate: () => void;
	readonly onInbox: (job: WakeJobView) => void;
	readonly onCancel: (job: WakeJobView) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const active = jobs.filter((job) => activeStatuses.has(job.status));
	const history = jobs.filter((job) => !activeStatuses.has(job.status));
	return (
		<div className="automation-panel">
			<div className="inspector-title-row">
				<div>
					<h2>{t("Automations")}</h2>
					<p>{t("Background tasks for this chat.")}</p>
				</div>
				<button
					type="button"
					className="primary-icon-button"
					onClick={onCreate}
					disabled={!canCreate}
					aria-label={t("New automation")}
				>
					<PlusIcon width={14} height={14} />
				</button>
			</div>
			{!canCreate && <div className="inline-note">{t("Open or create a chat to add an automation.")}</div>}
			<AutomationGroup title={t("Active")} jobs={active} inbox={inbox} onInbox={onInbox} onCancel={onCancel} />
			<AutomationGroup title={t("History")} jobs={history} inbox={inbox} onInbox={onInbox} onCancel={onCancel} />
		</div>
	);
}

function AutomationGroup({
	title,
	jobs,
	inbox,
	onInbox,
	onCancel,
}: {
	readonly title: string;
	readonly jobs: readonly WakeJobView[];
	readonly inbox: Readonly<Record<string, DeferredMessageView[]>>;
	readonly onInbox: (job: WakeJobView) => void;
	readonly onCancel: (job: WakeJobView) => void;
}): React.JSX.Element {
	const { language, t } = useI18n();
	return (
		<section className="automation-group">
			<h3>
				{title}
				<span>{jobs.length}</span>
			</h3>
			{jobs.length === 0 ? (
				<p className="group-empty">{t("No {group} automations", { group: title.toLowerCase() })}</p>
			) : (
				jobs.map((job) => (
					<div className={cn("automation-card", job.status)} key={job.id}>
						<header>
							<span>{wakeStatusLabel(job.status, language)}</span>
							{activeStatuses.has(job.status) && (
								<button
									type="button"
									className="icon-button"
									onClick={() => onCancel(job)}
									aria-label={t("Cancel automation")}
								>
									<CloseIcon width={12} height={12} />
								</button>
							)}
						</header>
						<strong>{job.reason}</strong>
						<p>{job.triggerLabel}</p>
						{job.dueAt && (
							<small>{t("Runs {time}", { time: new Date(job.dueAt).toLocaleString(language) })}</small>
						)}
						{job.pendingInboxCount > 0 && (
							<button type="button" className="inbox-button" onClick={() => onInbox(job)}>
								{t("Inbox")} · {job.pendingInboxCount}
							</button>
						)}
						{inbox[job.id]?.map((message) => (
							<div className="inbox-message" key={message.id}>
								{message.content}
							</div>
						))}
						{job.error && (
							<div className="wake-error">
								<AlertIcon width={12} height={12} /> {job.error.message}
							</div>
						)}
					</div>
				))
			)}
		</section>
	);
}

export function AutomationDialog({
	adapters,
	defaultCwd,
	onClose,
	onCreated,
}: {
	readonly adapters: readonly string[];
	readonly defaultCwd: string;
	readonly onClose: () => void;
	readonly onCreated: (request: CreateWakeRequest) => Promise<void>;
}): React.JSX.Element {
	const { t } = useI18n();
	const [kind, setKind] = useState<"time" | "monitor">("time");
	const [name, setName] = useState(() => t("Continue this task"));
	const [instructions, setInstructions] = useState(() =>
		t("Check the current state and continue the unfinished work."),
	);
	const [dueAt, setDueAt] = useState(localDateTimeValue(new Date(Date.now() + 5 * 60_000)));
	const [path, setPath] = useState(defaultCwd);
	const [advanced, setAdvanced] = useState(false);
	const [adapter, setAdapter] = useState(adapters[0] ?? "file_state");
	const [checkFirst, setCheckFirst] = useState(() => t("Check the task status"));
	const [field, setField] = useState("exists");
	const [operator, setOperator] = useState("eq");
	const [expected, setExpected] = useState("true");
	const [activation, setActivation] = useState<"level" | "transition">("transition");
	const [intervalMs, setIntervalMs] = useState("30000");
	const [timeoutAt, setTimeoutAt] = useState(localDateTimeValue(new Date(Date.now() + 60 * 60_000)));
	const [saving, setSaving] = useState(false);

	function expectedValue(): unknown {
		if (operator === "exists") return undefined;
		if (expected === "true") return true;
		if (expected === "false") return false;
		if (["gt", "gte", "lt", "lte"].includes(operator)) return Number(expected);
		try {
			return JSON.parse(expected);
		} catch {
			return expected;
		}
	}
	async function submit(): Promise<void> {
		setSaving(true);
		try {
			const checks = checkFirst
				.split("\n")
				.map((item) => item.trim())
				.filter(Boolean);
			const request: CreateWakeRequest =
				kind === "time"
					? {
							reason: name,
							objective: instructions,
							checkFirst: checks,
							trigger: { type: "time", dueAt: new Date(dueAt).toISOString() },
						}
					: {
							reason: name,
							objective: instructions,
							checkFirst: checks,
							trigger: {
								type: "monitor",
								adapter,
								source: { path, includeHash: false },
								condition: {
									field,
									operator: operator as
										| "eq"
										| "ne"
										| "gt"
										| "gte"
										| "lt"
										| "lte"
										| "in"
										| "contains"
										| "exists",
									expected: expectedValue() as never,
									activation,
									consecutiveMatches: 1,
								},
								delivery: { mode: "poll", intervalMs: Math.max(30_000, Number(intervalMs) || 30_000) },
								timeout: { at: new Date(timeoutAt).toISOString(), action: "wake" },
							},
						};
			await onCreated(request);
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="modal-backdrop">
			<div className="modal automation-modal" role="dialog" aria-modal="true" aria-labelledby="automation-title">
				<header className="modal-header">
					<div>
						<h2 id="automation-title">{t("New automation")}</h2>
						<p>{t("Schedule Pi to continue this chat later or when a file condition changes.")}</p>
					</div>
					<button
						type="button"
						className="icon-button"
						onClick={onClose}
						aria-label={t("Close automation dialog")}
					>
						<CloseIcon width={17} height={17} />
					</button>
				</header>
				<div className="form-grid">
					<label>
						{t("Task name")}
						<input value={name} onChange={(event) => setName(event.target.value)} />
					</label>
					<label>
						{t("Trigger")}
						<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
							<option value="time">{t("At a specific time")}</option>
							<option value="monitor">{t("When a file condition matches")}</option>
						</select>
					</label>
					<label className="wide">
						{t("Instructions")}
						<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} />
					</label>
					{kind === "time" ? (
						<label>
							{t("Run at")}
							<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
						</label>
					) : (
						<label className="wide">
							{t("File or folder path")}
							<input
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder={t("Absolute path")}
							/>
						</label>
					)}
				</div>
				<button type="button" className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>
					{advanced ? t("Hide advanced options") : t("Show advanced options")}
				</button>
				{advanced && (
					<div className="form-grid advanced-form">
						<label className="wide">
							{t("Pre-checks, one per line")}
							<textarea value={checkFirst} onChange={(event) => setCheckFirst(event.target.value)} />
						</label>
						{kind === "monitor" && (
							<>
								<label>
									{t("Adapter")}
									<select value={adapter} onChange={(event) => setAdapter(event.target.value)}>
										{(adapters.length > 0 ? adapters : ["file_state"]).map((item) => (
											<option key={item} value={item}>
												{item}
											</option>
										))}
									</select>
								</label>
								<label>
									{t("Field")}
									<input value={field} onChange={(event) => setField(event.target.value)} />
								</label>
								<label>
									{t("Operator")}
									<select value={operator} onChange={(event) => setOperator(event.target.value)}>
										<option value="eq">{t("Equals")}</option>
										<option value="ne">{t("Does not equal")}</option>
										<option value="gt">{t("Greater than")}</option>
										<option value="gte">{t("Greater than or equal")}</option>
										<option value="lt">{t("Less than")}</option>
										<option value="lte">{t("Less than or equal")}</option>
										<option value="exists">{t("Exists")}</option>
									</select>
								</label>
								{operator !== "exists" && (
									<label>
										{t("Expected value")}
										<input value={expected} onChange={(event) => setExpected(event.target.value)} />
									</label>
								)}
								<label>
									{t("Check interval (ms)")}
									<input
										type="number"
										min="30000"
										value={intervalMs}
										onChange={(event) => setIntervalMs(event.target.value)}
									/>
								</label>
								<label>
									{t("Timeout")}
									<input
										type="datetime-local"
										value={timeoutAt}
										onChange={(event) => setTimeoutAt(event.target.value)}
									/>
								</label>
								<label>
									{t("Activation")}
									<select
										value={activation}
										onChange={(event) => setActivation(event.target.value as typeof activation)}
									>
										<option value="transition">{t("On change")}</option>
										<option value="level">{t("While matching")}</option>
									</select>
								</label>
							</>
						)}
					</div>
				)}
				<footer className="modal-actions">
					<button type="button" className="quiet-button" onClick={onClose}>
						{t("Cancel")}
					</button>
					<button
						type="button"
						className="primary-button"
						onClick={() => void submit()}
						disabled={saving || !name.trim() || !instructions.trim()}
					>
						{saving ? t("Creating…") : t("Create automation")}
					</button>
				</footer>
			</div>
		</div>
	);
}
