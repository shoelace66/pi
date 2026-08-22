import { useMemo, useState } from "react";
import type { SessionListItem } from "../../../shared/view-models.ts";
import { autoPiSymbolDarkUrl, autoPiSymbolLightUrl } from "../brand.ts";
import { useI18n } from "../i18n.tsx";
import { FolderIcon, PinIcon, PlusIcon, SearchIcon, SettingsIcon, TrashIcon } from "../icons.tsx";
import { cn, formatRelativeTime, statusLabel, workspaceName } from "../utils.ts";

export interface SidebarProps {
	readonly workspacePath: string;
	readonly workspaces: readonly string[];
	readonly sessions: readonly SessionListItem[];
	readonly selectedId?: string;
	readonly pinnedIds: ReadonlySet<string>;
	readonly loading: boolean;
	readonly collapsed: boolean;
	readonly onToggleCollapsed: () => void;
	readonly onSwitchWorkspace: (path: string) => void;
	readonly onOpenWorkspace: () => void;
	readonly onSelect: (id: string) => void;
	readonly onCreate: () => void;
	readonly onOpenSettings: () => void;
	readonly onTogglePin: (id: string) => void;
	readonly onDelete: (item: SessionListItem) => void;
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
	const { t } = useI18n();
	const [search, setSearch] = useState("");
	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return query
			? props.sessions.filter((item) =>
					[item.name, item.preview, item.cwd].some((value) => value?.toLowerCase().includes(query)),
				)
			: props.sessions;
	}, [props.sessions, search]);

	if (props.collapsed) {
		return (
			<aside className="sidebar collapsed">
				<button
					type="button"
					className="brand-mark sidebar-rail-button"
					onClick={props.onToggleCollapsed}
					title={t("Expand sidebar")}
				>
					<img className="brand-symbol theme-dark-asset" src={autoPiSymbolDarkUrl} alt="AutoPi" />
					<img className="brand-symbol theme-light-asset" src={autoPiSymbolLightUrl} alt="AutoPi" />
				</button>
				<button
					type="button"
					className="sidebar-rail-button"
					onClick={props.onOpenWorkspace}
					title={t("Open folder")}
				>
					<FolderIcon width={17} height={17} />
				</button>
				<button type="button" className="sidebar-rail-button" onClick={props.onCreate} title={t("New chat")}>
					<PlusIcon width={17} height={17} />
				</button>
				<span className="sidebar-rail-spacer" />
				<button type="button" className="sidebar-rail-button" onClick={props.onOpenSettings} title={t("Settings")}>
					<SettingsIcon width={17} height={17} />
				</button>
			</aside>
		);
	}

	const pinned = filtered.filter((item) => props.pinnedIds.has(item.id));
	const regular = filtered.filter((item) => !props.pinnedIds.has(item.id));
	return (
		<aside className="sidebar">
			<div className="sidebar-brand-row">
				<div className="brand">
					<img className="brand-symbol theme-dark-asset" src={autoPiSymbolDarkUrl} alt="" />
					<img className="brand-symbol theme-light-asset" src={autoPiSymbolLightUrl} alt="" />
					<span>AutoPi</span>
				</div>
				<button
					type="button"
					className="icon-button"
					onClick={props.onToggleCollapsed}
					title={t("Collapse sidebar")}
				>
					‹
				</button>
			</div>
			<div className="workspace-switcher">
				<label htmlFor="workspace-select">{t("Workspace")}</label>
				<div className="workspace-select-row">
					<FolderIcon width={14} height={14} />
					<select
						id="workspace-select"
						value={props.workspacePath}
						onChange={(event) => props.onSwitchWorkspace(event.target.value)}
						title={props.workspacePath}
					>
						{props.workspaces.map((path) => (
							<option key={path} value={path}>
								{workspaceName(path)}
							</option>
						))}
					</select>
				</div>
				<button type="button" className="quiet-button full-width" onClick={props.onOpenWorkspace}>
					<FolderIcon width={14} height={14} /> {t("Open Folder…")}
				</button>
			</div>
			<div className="sidebar-actions">
				<div className="sidebar-search">
					<SearchIcon width={14} height={14} />
					<input
						className="sidebar-search-input"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t("Search chats")}
					/>
				</div>
				<button
					type="button"
					className="primary-button full-width"
					onClick={props.onCreate}
					disabled={props.loading}
				>
					<PlusIcon width={14} height={14} /> {t("New Chat")}
				</button>
			</div>
			<div className="sidebar-section-label">{t("Chats")}</div>
			<div className="session-list">
				<SessionGroup label={t("Pinned")} items={pinned} {...props} />
				<SessionGroup items={regular} {...props} />
				{filtered.length === 0 && (
					<div className="sidebar-empty">{search ? t("No matching chats") : t("No chats in this workspace")}</div>
				)}
			</div>
			<div className="sidebar-footer">
				<button type="button" className="sidebar-footer-button" onClick={props.onOpenSettings}>
					<SettingsIcon width={15} height={15} /> {t("Settings")}
				</button>
			</div>
		</aside>
	);
}

function SessionGroup({
	label,
	items,
	selectedId,
	pinnedIds,
	onSelect,
	onTogglePin,
	onDelete,
}: {
	readonly label?: string;
	readonly items: readonly SessionListItem[];
	readonly selectedId?: string;
	readonly pinnedIds: ReadonlySet<string>;
	readonly onSelect: (id: string) => void;
	readonly onTogglePin: (id: string) => void;
	readonly onDelete: (item: SessionListItem) => void;
}): React.JSX.Element | null {
	if (items.length === 0) return null;
	return (
		<div className="session-group">
			{label && <div className="session-group-label">{label}</div>}
			{items.map((item) => (
				<SessionRow
					key={item.id}
					item={item}
					selected={item.id === selectedId}
					pinned={pinnedIds.has(item.id)}
					onSelect={() => onSelect(item.id)}
					onPin={() => onTogglePin(item.id)}
					onDelete={() => onDelete(item)}
				/>
			))}
		</div>
	);
}

function SessionRow({
	item,
	selected,
	pinned,
	onSelect,
	onPin,
	onDelete,
}: {
	readonly item: SessionListItem;
	readonly selected: boolean;
	readonly pinned: boolean;
	readonly onSelect: () => void;
	readonly onPin: () => void;
	readonly onDelete: () => void;
}): React.JSX.Element {
	const { language, t } = useI18n();
	return (
		<div className={cn("session-item", selected && "selected")}>
			<button type="button" className="session-select" onClick={onSelect}>
				<span className={cn("status-dot", item.status)} />
				<span className="session-copy">
					<strong>{item.name || t("Untitled chat")}</strong>
					{item.preview && <span className="session-preview">{item.preview}</span>}
					<small>
						{statusLabel(item.status, language)} · {t("{count} messages", { count: item.messageCount })} ·{" "}
						{formatRelativeTime(item.updatedAt, language)}
					</small>
				</span>
			</button>
			<div className="session-actions">
				<SessionActionButton label={pinned ? t("Unpin chat") : t("Pin chat")} active={pinned} onClick={onPin}>
					<PinIcon />
				</SessionActionButton>
				<SessionActionButton label={t("Delete chat")} destructive onClick={onDelete}>
					<TrashIcon />
				</SessionActionButton>
			</div>
		</div>
	);
}

function SessionActionButton({
	label,
	active = false,
	destructive = false,
	onClick,
	children,
}: {
	readonly label: string;
	readonly active?: boolean;
	readonly destructive?: boolean;
	readonly onClick: () => void;
	readonly children: React.ReactNode;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className={cn("session-action", active && "active", destructive && "destructive")}
			onClick={onClick}
			title={label}
			aria-label={label}
		>
			{children}
		</button>
	);
}
