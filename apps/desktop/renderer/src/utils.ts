export function cn(...classes: (string | false | undefined | null)[]): string {
	return classes.filter(Boolean).join(" ");
}

export function formatRelativeTime(date: Date | string, language: AppLanguage = "en"): string {
	const d = typeof date === "string" ? new Date(date) : date;
	const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
	if (seconds < 5) return translate(language, "Just now");
	if (seconds < 60) return translate(language, "{count}s ago", { count: seconds });
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return translate(language, "{count}m ago", { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return translate(language, "{count}h ago", { count: hours });
	const days = Math.floor(hours / 24);
	if (days < 7) return translate(language, "{count}d ago", { count: days });
	if (days < 30) return translate(language, "{count}w ago", { count: Math.floor(days / 7) });
	return d.toLocaleDateString(language);
}

export function formatTime(date: Date | string): string {
	const d = typeof date === "string" ? new Date(date) : date;
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(date: Date | string): string {
	const d = typeof date === "string" ? new Date(date) : date;
	return d.toLocaleString([], {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}…`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const textarea = document.createElement("textarea");
			textarea.value = text;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand("copy");
			document.body.removeChild(textarea);
			return true;
		} catch {
			return false;
		}
	}
}

export function loadJSON<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		if (raw) return JSON.parse(raw) as T;
	} catch {
		/* ignore */
	}
	return fallback;
}

export function saveJSON<T>(key: string, value: T): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* ignore */
	}
}

export function localDateTimeValue(date: Date): string {
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

export function safeText(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

export function statusLabel(status: string, language: AppLanguage = "en"): string {
	const label =
		{
			running: "Running",
			sleeping: "Scheduled",
			wake_ready: "Ready",
			retry_wait: "Retrying",
			blocked: "Blocked",
			idle: "Idle",
			error: "Error",
		}[status] ?? status;
	return translate(language, label);
}

export function wakeStatusLabel(status: string, language: AppLanguage = "en"): string {
	const label =
		{
			armed: "Scheduled",
			ready: "Ready",
			running: "Running",
			run_retry_wait: "Retrying",
			blocked: "Needs attention",
			cancel_requested: "Cancelling",
			completed: "Completed",
			cancelled: "Cancelled",
			expired: "Expired",
			dead_letter: "Failed",
		}[status] ?? status;
	return translate(language, label);
}

export function workspaceName(path: string): string {
	const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts.at(-1) || path;
}

import { type AppLanguage, translate } from "./i18n.tsx";
