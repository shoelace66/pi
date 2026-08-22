import { Fragment, type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n.tsx";
import { PlusIcon, SendIcon, SparkleIcon, StopIcon } from "../icons.tsx";
import { cn } from "../utils.ts";

export interface SlashCommand {
	readonly id: string;
	readonly command: string;
	readonly title: string;
	readonly description: string;
	readonly section: string;
	readonly argumentHint?: string;
	readonly source?: "builtin" | "desktop" | "extension" | "prompt" | "skill";
}

function sourceLabel(source: SlashCommand["source"]): string | undefined {
	if (!source || source === "builtin" || source === "desktop") return undefined;
	return source;
}

export const slashCommands: SlashCommand[] = [
	{
		id: "settings",
		command: "/settings",
		title: "Settings",
		description: "Open settings menu",
		section: "Core",
	},
	{
		id: "mode",
		command: "/mode",
		title: "Execution mode",
		description: "Switch between Build and Plan mode",
		argumentHint: "<build|plan>",
		section: "Core",
	},
	{
		id: "model",
		command: "/model",
		title: "Select model",
		description: "Select model (opens selector UI)",
		argumentHint: "<provider/model>",
		section: "Core",
	},
	{
		id: "scoped-models",
		command: "/scoped-models",
		title: "Scoped models",
		description: "Enable/disable models for Ctrl+P cycling",
		section: "Core",
	},
	{
		id: "export",
		command: "/export",
		title: "Export session",
		description: "Export session (HTML default, or specify path: .html/.jsonl)",
		section: "Session",
	},
	{
		id: "import",
		command: "/import",
		title: "Import session",
		description: "Import and resume a session from a JSONL file",
		section: "Session",
	},
	{
		id: "share",
		command: "/share",
		title: "Share session",
		description: "Share session as a secret GitHub gist",
		section: "Session",
	},
	{
		id: "copy",
		command: "/copy",
		title: "Copy response",
		description: "Copy last agent message to clipboard",
		section: "Session",
	},
	{
		id: "name",
		command: "/name",
		title: "Name session",
		description: "Set the session display name",
		section: "Session",
	},
	{
		id: "session",
		command: "/session",
		title: "Session info",
		description: "Show session information and stats",
		section: "Session",
	},
	{
		id: "changelog",
		command: "/changelog",
		title: "Changelog",
		description: "Show changelog entries",
		section: "General",
	},
	{
		id: "hotkeys",
		command: "/hotkeys",
		title: "Keyboard shortcuts",
		description: "Show all keyboard shortcuts",
		section: "General",
	},
	{
		id: "new",
		command: "/new",
		title: "New session",
		description: "Start a new session",
		section: "General",
	},
	{
		id: "reload",
		command: "/reload",
		title: "Reload resources",
		description: "Reload keybindings, extensions, skills, prompts, themes, and context files",
		section: "General",
	},
	{
		id: "login",
		command: "/login",
		title: "Provider login",
		description: "Configure provider authentication",
		argumentHint: "<provider>",
		section: "Providers",
	},
	{
		id: "resume",
		command: "/resume",
		title: "Resume session",
		description: "Resume a different session",
		section: "Session",
	},
	{
		id: "logout",
		command: "/logout",
		title: "Provider logout",
		description: "Remove provider authentication",
		section: "Providers",
	},
	{
		id: "tree",
		command: "/tree",
		title: "Session tree",
		description: "Navigate session tree (switch branches)",
		section: "Session",
	},
	{
		id: "fork",
		command: "/fork",
		title: "Fork session",
		description: "Create a new fork from a previous user message",
		section: "Session",
	},
	{
		id: "clone",
		command: "/clone",
		title: "Clone session",
		description: "Duplicate this session at the current position",
		section: "Session",
	},
	{
		id: "trust",
		command: "/trust",
		title: "Project trust",
		description: "Save project trust decision for future sessions",
		section: "Workspace",
	},
	{
		id: "quit",
		command: "/quit",
		title: "Quit AutoPi",
		description: "Quit AutoPi",
		section: "General",
	},
	{
		id: "help",
		command: "/help",
		title: "Keyboard shortcuts",
		description: "Show available shortcuts",
		section: "General",
		source: "desktop",
	},
	{
		id: "sessions",
		command: "/sessions",
		title: "Search chats",
		description: "Focus chat search",
		section: "General",
		source: "desktop",
	},
	{
		id: "theme",
		command: "/theme",
		title: "Toggle theme",
		description: "Switch between AutoPi Dark and AutoPi Light",
		section: "Appearance",
		source: "desktop",
	},
	{
		id: "stop",
		command: "/stop",
		title: "Stop",
		description: "Stop the current response",
		section: "Chat",
		source: "desktop",
	},
];

export interface ComposerProps {
	readonly draft: string;
	readonly onDraftChange: (value: string) => void;
	readonly onSend: () => void;
	readonly onAbort: () => void;
	readonly isRunning: boolean;
	readonly disabled: boolean;
	readonly loading: boolean;
	readonly placeholder: string;
	readonly onSlashCommand: (command: SlashCommand) => void;
	readonly composerRef: RefObject<HTMLTextAreaElement | null>;
	readonly commands?: readonly SlashCommand[];
	readonly imagePaths: readonly string[];
	readonly onAttach: () => void;
	readonly onRemoveImage: (path: string) => void;
}

export function Composer(props: ComposerProps): React.JSX.Element {
	const { t } = useI18n();
	const {
		draft,
		onDraftChange,
		onSend,
		onAbort,
		isRunning,
		disabled,
		loading,
		placeholder,
		onSlashCommand,
		composerRef,
		commands,
		imagePaths,
		onAttach,
		onRemoveImage,
	} = props;
	const commandList = commands ?? slashCommands;
	const [showSlashMenu, setShowSlashMenu] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [charCount, setCharCount] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const isSlashDraft = draft.trimStart().startsWith("/");

	const filteredCommands = (() => {
		const query = draft.toLowerCase();
		if (!query.startsWith("/") || draft.includes("\n")) return [];
		const commandQuery = draft.slice(1).trim().toLowerCase();
		if (!commandQuery) return commandList;
		return commandList.filter(
			(c) =>
				c.command.slice(1).startsWith(commandQuery) ||
				c.title.toLowerCase().includes(commandQuery) ||
				c.description.toLowerCase().includes(commandQuery),
		);
	})();

	useEffect(() => {
		setShowSlashMenu(filteredCommands.length > 0 && draft.startsWith("/") && draft.length <= 64);
		setSlashIndex(0);
	}, [draft, filteredCommands.length]);

	useEffect(() => {
		setCharCount(draft.length);
	}, [draft]);

	useEffect(() => {
		const textarea = composerRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
	});

	useEffect(() => {
		if (!showSlashMenu) return;
		const handler = (e: MouseEvent): void => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setShowSlashMenu(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showSlashMenu]);

	function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
		if (showSlashMenu && filteredCommands.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashIndex((prev) => (prev + 1) % filteredCommands.length);
				return true;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
				return true;
			}
			if (e.key === "Home") {
				e.preventDefault();
				setSlashIndex(0);
				return true;
			}
			if (e.key === "End") {
				e.preventDefault();
				setSlashIndex(filteredCommands.length - 1);
				return true;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				e.preventDefault();
				const selected = filteredCommands[slashIndex];
				if (selected) {
					onSlashCommand(selected);
					setShowSlashMenu(false);
					return true;
				}
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setShowSlashMenu(false);
				return true;
			}
		}
		return false;
	}

	function handleKeyDownWrapper(e: KeyboardEvent<HTMLTextAreaElement>): void {
		if (handleKeyDown(e)) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!disabled && (draft.trim() || imagePaths.length > 0)) onSend();
		}
	}

	function selectCommand(command: SlashCommand): void {
		onSlashCommand(command);
		setShowSlashMenu(false);
	}

	return (
		<div className="composer-wrap" ref={containerRef}>
			<div className={cn("composer", showSlashMenu && "composer--menu-open")}>
				{showSlashMenu && (
					<div className="slash-menu">
						<div className="slash-menu-head">
							<span>Commands</span>
							<small>Local desktop actions · not sent to Pi</small>
						</div>
						{filteredCommands.map((command, index) => {
							const previous = filteredCommands[index - 1];
							const source = sourceLabel(command.source);
							return (
								<Fragment key={command.id}>
									{(index === 0 || previous?.section !== command.section) && (
										<div className="slash-menu-section">{command.section}</div>
									)}
									<button
										type="button"
										className={cn("slash-menu-item", index === slashIndex && "active")}
										onClick={() => selectCommand(command)}
										onMouseEnter={() => setSlashIndex(index)}
										aria-label={`${command.command} — ${command.description}`}
									>
										<span className="slash-menu-icon">
											<SparkleIcon width={13} height={13} />
										</span>
										<span className="slash-menu-content">
											<span className="slash-menu-line">
												<span className="slash-menu-command">{command.command}</span>
												{command.argumentHint && (
													<span className="slash-menu-args">{command.argumentHint}</span>
												)}
												<span className="slash-menu-desc">{command.description}</span>
											</span>
										</span>
										{source && <span className="slash-menu-source">{source}</span>}
									</button>
								</Fragment>
							);
						})}
					</div>
				)}
				{imagePaths.length > 0 && (
					<div className="composer-attachments">
						{imagePaths.map((path) => (
							<span key={path} title={path}>
								{path.split(/[\\/]/).at(-1)}
								<button type="button" onClick={() => onRemoveImage(path)} aria-label={t("Remove image")}>
									×
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					ref={composerRef}
					value={draft}
					onChange={(e) => onDraftChange(e.target.value)}
					onKeyDown={handleKeyDownWrapper}
					placeholder={placeholder}
					disabled={disabled}
					className="composer-textarea"
					rows={2}
				/>
				<div className="composer-bar">
					<span className="composer-hint">
						<button type="button" className="composer-attach" onClick={onAttach} title={t("Attach images")}>
							<PlusIcon width={12} height={12} /> {t("Image")}
						</button>
						<span className="composer-kbd">Enter</span> {t("Send")}{" "}
						<span className="composer-kbd">Shift+Enter</span> {t("New line")}{" "}
						<span className="composer-kbd">/</span> Commands
					</span>
					<span className="composer-right">
						{charCount > 0 && (
							<span className={cn("composer-count", charCount > 4000 && "warn")}>{charCount}</span>
						)}
						<button
							type="button"
							className="composer-send-btn"
							onClick={onSend}
							disabled={disabled || (!draft.trim() && imagePaths.length === 0) || loading}
							title={isRunning ? t("Steer the current response") : t("Send")}
						>
							<span>{isSlashDraft ? "Run command" : isRunning ? t("Steer") : t("Send")}</span>
							<SendIcon width={14} height={14} />
						</button>
						{isRunning && (
							<button type="button" className="composer-stop-btn" onClick={onAbort} title={t("Stop")}>
								<StopIcon width={14} height={14} />
								<span>{t("Stop")}</span>
							</button>
						)}
					</span>
				</div>
			</div>
		</div>
	);
}
