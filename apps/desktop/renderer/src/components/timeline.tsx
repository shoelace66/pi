import { memo, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
	DESKTOP_ACTIVITY_PAGE_SIZE,
	type DesktopActivityFilter,
	desktopActivityWindow,
	desktopTimelineActivities,
	filterDesktopActivities,
} from "../../../shared/activity.ts";
import type {
	DesktopActivity,
	DesktopMessage,
	DesktopRunPhase,
	DesktopToolExecution,
} from "../../../shared/view-models.ts";
import { useI18n } from "../i18n.tsx";
import { AlertIcon, BotIcon, CheckIcon, CodeIcon, CopyIcon, SparkleIcon, UserIcon, WrenchIcon } from "../icons.tsx";
import { Markdown } from "../markdown.tsx";
import { cn, copyToClipboard, formatTime, safeText } from "../utils.ts";

export function Timeline({
	activities,
	isRunning,
	timelineRef,
	onRetry,
	onOpenSettings,
}: {
	readonly activities: readonly DesktopActivity[];
	readonly isRunning: boolean;
	readonly timelineRef: RefObject<HTMLDivElement | null>;
	readonly onRetry?: () => void;
	readonly onOpenSettings?: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const [visibleCount, setVisibleCount] = useState(DESKTOP_ACTIVITY_PAGE_SIZE);
	const [filter, setFilter] = useState<DesktopActivityFilter>("all");
	const [showThinking, setShowThinking] = useState(false);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);
	const stickToBottomRef = useRef(true);
	const displayActivities = useMemo(() => desktopTimelineActivities(activities, isRunning), [activities, isRunning]);
	const filtered = useMemo(() => filterDesktopActivities(displayActivities, filter), [displayActivities, filter]);
	const visible = useMemo(() => desktopActivityWindow(filtered, visibleCount), [filtered, visibleCount]);
	const counts = useMemo(
		() => ({
			messages: displayActivities.filter((activity) => activity.kind === "message").length,
			tools: displayActivities.filter((activity) => activity.kind === "tool").length,
			errors: filterDesktopActivities(displayActivities, "errors").length,
			thinking: displayActivities.filter(
				(activity) => activity.kind === "message" && Boolean(activity.message.thinking),
			).length,
		}),
		[displayActivities],
	);
	function scrollToLatest(): void {
		const element = timelineRef.current;
		if (!element) return;
		element.scrollTop = element.scrollHeight;
		stickToBottomRef.current = true;
		setShowJumpToLatest(false);
	}
	function selectFilter(next: DesktopActivityFilter): void {
		setFilter(next);
		setVisibleCount(DESKTOP_ACTIVITY_PAGE_SIZE);
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: New activities are the signal to scroll the existing container.
	useEffect(() => {
		const element = timelineRef.current;
		if (!element) return;
		if (stickToBottomRef.current) {
			element.scrollTop = element.scrollHeight;
			setShowJumpToLatest(false);
		} else {
			setShowJumpToLatest(true);
		}
	}, [activities, timelineRef]);
	return (
		<div
			className="timeline"
			ref={timelineRef}
			onScroll={(event) => {
				const element = event.currentTarget;
				const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
				stickToBottomRef.current = nearBottom;
				if (nearBottom) setShowJumpToLatest(false);
			}}
		>
			{activities.length === 0 && !isRunning && (
				<div className="chat-empty">
					<span className="empty-glyph">
						<SparkleIcon width={22} height={22} />
					</span>
					<h2>{t("Start a conversation")}</h2>
					<p>{t("Ask AutoPi to explore, explain, or work in this workspace.")}</p>
				</div>
			)}
			{displayActivities.length > 0 && (
				<div className="timeline-toolbar">
					<div className="timeline-filters">
						<FilterButton
							active={filter === "all"}
							onClick={() => selectFilter("all")}
							label={t("All")}
							count={displayActivities.length}
						/>
						<FilterButton
							active={filter === "messages"}
							onClick={() => selectFilter("messages")}
							label={t("Messages")}
							count={counts.messages}
						/>
						<FilterButton
							active={filter === "tools"}
							onClick={() => selectFilter("tools")}
							label={t("Tools")}
							count={counts.tools}
						/>
						<FilterButton
							active={filter === "errors"}
							onClick={() => selectFilter("errors")}
							label={t("Errors")}
							count={counts.errors}
						/>
					</div>
					<button
						type="button"
						className={cn("thinking-toggle", showThinking && "active")}
						onClick={() => setShowThinking((value) => !value)}
						disabled={counts.thinking === 0}
					>
						{t(showThinking ? "Reasoning shown" : "Reasoning hidden")} · {counts.thinking}
					</button>
				</div>
			)}
			<div className="activity-stream">
				{visible.hiddenCount > 0 && (
					<button
						type="button"
						className="show-earlier-activities"
						onClick={() => setVisibleCount((current) => current + DESKTOP_ACTIVITY_PAGE_SIZE)}
					>
						{t("Show earlier activity ({count} remaining)", { count: visible.hiddenCount })}
					</button>
				)}
				{visible.activities.map((activity) =>
					activity.kind === "message" ? (
						<Message key={activity.id} message={activity.message} thinkingExpanded={showThinking} />
					) : activity.kind === "tool" ? (
						<ToolCard key={activity.id} tool={activity.tool} />
					) : (
						<StatusCard key={activity.id} activity={activity} onRetry={onRetry} onOpenSettings={onOpenSettings} />
					),
				)}
				{displayActivities.length > 0 && filtered.length === 0 && (
					<div className="timeline-filter-empty">{t("No activity matches this filter.")}</div>
				)}
			</div>
			{showJumpToLatest && (
				<button type="button" className="jump-to-latest" onClick={scrollToLatest}>
					{t("Jump to latest")}
				</button>
			)}
		</div>
	);
}

function FilterButton({
	active,
	onClick,
	label,
	count,
}: {
	readonly active: boolean;
	readonly onClick: () => void;
	readonly label: string;
	readonly count: number;
}): React.JSX.Element {
	return (
		<button type="button" className={cn("timeline-filter", active && "active")} onClick={onClick}>
			{label} <span>{count}</span>
		</button>
	);
}

const StatusCard = memo(function StatusCard({
	activity,
	onRetry,
	onOpenSettings,
}: {
	readonly activity: Extract<DesktopActivity, { kind: "status" }>;
	readonly onRetry?: () => void;
	readonly onOpenSettings?: () => void;
}): React.JSX.Element | null {
	const { language, t } = useI18n();
	if (activity.status === "run_started") {
		return (
			<div className="run-status working">
				<span className="pulse-dot" />
				<div>
					<strong>{t(runPhaseLabel(activity.phase))}</strong>
					<span>{runPhaseDescription(activity.message, language, t)}</span>
				</div>
			</div>
		);
	}
	if (activity.status === "run_completed") {
		return (
			<div className="run-status completed">
				<CheckIcon width={13} height={13} /> {t(activity.message ?? "Response complete")}
			</div>
		);
	}
	return (
		<div className="run-status error">
			<div className="run-status-copy">
				<AlertIcon width={14} height={14} />
				<div>
					<strong>{t("Pi could not complete this response")}</strong>
					<span>{activity.message ?? t("The runtime returned an unknown error.")}</span>
				</div>
			</div>
			<div className="run-status-actions">
				{onRetry && (
					<button type="button" onClick={onRetry}>
						{t("Retry")}
					</button>
				)}
				{onOpenSettings && (
					<button type="button" onClick={onOpenSettings}>
						{t("Open Models & Providers")}
					</button>
				)}
			</div>
		</div>
	);
});

function runPhaseLabel(phase?: DesktopRunPhase): string {
	if (phase === "reasoning") return "Thinking";
	if (phase === "tool") return "Using tools";
	if (phase === "reviewing") return "Reviewing tool results";
	if (phase === "responding") return "Writing response";
	if (phase === "compacting") return "Compacting context";
	if (phase === "retrying") return "Retrying";
	if (phase === "finalizing") return "Finalizing";
	return "Preparing";
}

function runPhaseDescription(
	message: string | undefined,
	language: "en" | "zh-CN",
	t: (key: string, values?: Readonly<Record<string, string | number>>) => string,
): string {
	if (!message) return t("Preparing the model request…");
	if (language !== "zh-CN") return message;
	const waiting = /^Waiting for (.+) to produce the next step$/.exec(message);
	if (waiting?.[1]) return `正在等待 ${waiting[1]} 生成下一步`;
	const running = /^Running tools?: (.+)$/.exec(message);
	if (running?.[1]) return `正在运行工具：${running[1]}`;
	const reviewing = /^Reviewing the result from (.+)$/.exec(message);
	if (reviewing?.[1]) return `正在检查 ${reviewing[1]} 的执行结果`;
	if (message.startsWith("Summarizing older context")) return "正在总结较早的对话内容";
	if (message.startsWith("Context compacted")) return "上下文已压缩，正在继续模型请求";
	if (message.startsWith("Retrying after an API error"))
		return message.replace("Retrying after an API error", "API 出错后正在重试");
	if (message.startsWith("Retrying context summary"))
		return message.replace("Retrying context summary", "正在重试上下文总结");
	return t(message);
}

const Message = memo(function Message({
	message,
	thinkingExpanded,
}: {
	readonly message: DesktopMessage;
	readonly thinkingExpanded: boolean;
}): React.JSX.Element {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	const isUser = message.role === "user";
	const isAssistant = message.role === "assistant";
	const label = isUser
		? t("You")
		: isAssistant
			? "Pi"
			: message.role === "system"
				? t("System")
				: (message.customType ?? message.role);
	const Icon = isUser ? UserIcon : isAssistant ? BotIcon : SparkleIcon;
	return (
		<article className={cn("message", message.role)}>
			<header>
				<span className="message-avatar">
					<Icon width={13} height={13} />
				</span>
				<strong>{label}</strong>
				{message.timestamp && <time>{formatTime(new Date(message.timestamp))}</time>}
				{message.text && (
					<button
						type="button"
						className="message-copy"
						aria-label={t("Copy message")}
						onClick={() =>
							void copyToClipboard(message.text).then((ok) => {
								if (ok) {
									setCopied(true);
									window.setTimeout(() => setCopied(false), 1500);
								}
							})
						}
					>
						{copied ? <CheckIcon width={12} height={12} /> : <CopyIcon width={12} height={12} />}
					</button>
				)}
			</header>
			<div className="message-body">
				{message.thinking && <ThinkingBlock text={message.thinking} forceExpanded={thinkingExpanded} />}
				{message.text ? (
					isUser || isAssistant ? (
						<Markdown text={message.text} />
					) : (
						message.text
					)
				) : (
					<span className="muted">{t("No readable content")}</span>
				)}
			</div>
		</article>
	);
});

function ThinkingBlock({ text, forceExpanded }: { readonly text: string; readonly forceExpanded: boolean }) {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState(forceExpanded);
	useEffect(() => setExpanded(forceExpanded), [forceExpanded]);
	return (
		<details className="thinking-block" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
			<summary>{t("LLM reasoning · {count} characters", { count: text.length.toLocaleString() })}</summary>
			{expanded && <Markdown text={text} />}
		</details>
	);
}

const ToolCard = memo(function ToolCard({ tool }: { readonly tool: DesktopToolExecution }): React.JSX.Element {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState(tool.status !== "completed");
	const hasDetails = tool.args !== undefined || tool.result !== undefined || tool.partialResult !== undefined;
	const duration = Math.max(0, new Date(tool.updatedAt).getTime() - new Date(tool.startedAt).getTime());
	return (
		<article className={cn("tool-card", tool.status)}>
			<button
				type="button"
				className="tool-card-header"
				onClick={() => hasDetails && setExpanded((value) => !value)}
			>
				<span className="tool-state-icon">
					{tool.status === "running" ? (
						<span className="tool-spinner" />
					) : tool.status === "error" ? (
						<AlertIcon width={12} height={12} />
					) : (
						<CheckIcon width={12} height={12} />
					)}
				</span>
				<WrenchIcon width={13} height={13} />
				<strong>{tool.toolName}</strong>
				<span>
					{tool.status === "running" ? t("Running") : tool.status === "error" ? t("Failed") : t("Completed")}
					{tool.status !== "running" && ` · ${formatDuration(duration)}`}
				</span>
				{hasDetails && <CodeIcon width={12} height={12} className={cn("tool-chevron", expanded && "open")} />}
			</button>
			{expanded && hasDetails && (
				<div className="tool-details">
					{tool.args !== undefined && (
						<section>
							<span className="tool-detail-label">{t("Input")}</span>
							<ExpandablePayload value={tool.args} />
						</section>
					)}
					{(tool.result !== undefined || tool.partialResult !== undefined) && (
						<section>
							<span className="tool-detail-label">
								{tool.status === "running" ? t("Partial output") : t("Output")}
							</span>
							<ExpandablePayload value={tool.result ?? tool.partialResult} />
						</section>
					)}
				</div>
			)}
		</article>
	);
});

const PAYLOAD_PREVIEW_LIMIT = 6_000;

function ExpandablePayload({ value }: { readonly value: unknown }): React.JSX.Element {
	const { t } = useI18n();
	const [showAll, setShowAll] = useState(false);
	const content = useMemo(() => safeText(value), [value]);
	const truncated = content.length > PAYLOAD_PREVIEW_LIMIT;
	const visible = truncated && !showAll ? `${content.slice(0, PAYLOAD_PREVIEW_LIMIT)}\n…` : content;
	return (
		<div className="tool-payload">
			<pre>{visible}</pre>
			{truncated && (
				<button type="button" onClick={() => setShowAll((current) => !current)}>
					{showAll
						? t("Show preview")
						: t("Show all · {count} characters", { count: content.length.toLocaleString() })}
				</button>
			)}
		</div>
	);
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${durationMs} ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
	return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}
