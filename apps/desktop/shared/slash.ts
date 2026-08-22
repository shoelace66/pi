export type ParsedSlashCommand<T extends { command: string }> = { command: T; args: string };

export function parseSlashInput<T extends { command: string }>(
	text: string,
	commands: readonly T[],
): ParsedSlashCommand<T> | undefined {
	const match = text.trim().match(/^\/([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i);
	if (!match) return undefined;
	const name = match[1].toLowerCase();
	const command = commands.find((item) => item.command.slice(1).toLowerCase() === name);
	return command ? { command, args: match[2]?.trim() ?? "" } : undefined;
}

export function isSlashInput(text: string): boolean {
	return text.trimStart().startsWith("/");
}

export function parseShellInput(text: string): { command: string; excludeFromContext: boolean } | undefined {
	const normalized = text.trim();
	if (!normalized.startsWith("!")) return undefined;
	const excludeFromContext = normalized.startsWith("!!");
	const command = normalized.slice(excludeFromContext ? 2 : 1).trim();
	return command ? { command, excludeFromContext } : undefined;
}
