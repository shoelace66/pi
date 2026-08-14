import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue, WakeSource } from "./types.ts";

export type WakeJournalKind =
	| "accepted"
	| "queued"
	| "dispatching"
	| "completed"
	| "retryable"
	| "blocked"
	| "cancelled"
	| "rejected"
	| "recovery_notice_delivered";

export type WakeJournalEvent = {
	kind: WakeJournalKind;
	wakeId?: string;
	requestId?: string;
	source?: WakeSource;
	target?: JsonValue;
	content?: JsonValue;
	error?: JsonValue;
	data?: JsonValue;
	at?: string;
};

export type WakeJournalEnvelope = WakeJournalEvent & { seq: number; at: string };

export interface WakeJournal {
	append(event: WakeJournalEvent): Promise<number>;
	read(): Promise<WakeJournalEnvelope[]>;
	/** Human-readable path for recovery notices; memory journals have none. */
	readonly path?: string;
}

export class InMemoryWakeJournal implements WakeJournal {
	private seq = 0;
	private readonly events: WakeJournalEnvelope[] = [];

	async append(event: WakeJournalEvent): Promise<number> {
		const envelope = { ...event, seq: ++this.seq, at: event.at ?? new Date().toISOString() };
		this.events.push(envelope);
		return envelope.seq;
	}

	async read(): Promise<WakeJournalEnvelope[]> {
		return this.events.map((event) => ({ ...event }));
	}
}

const CLOSED_KINDS = new Set<WakeJournalKind>(["completed", "cancelled", "rejected"]);

export type WakeRecoveryNotice = {
	wakeId: string;
	lastKind: WakeJournalKind;
	journalPath?: string;
};

/** Find wake records that were still open when the process stopped. */
export function findUnclosedWakeEvents(
	events: WakeJournalEnvelope[],
	sessionId?: string,
	journalPath?: string,
): WakeRecoveryNotice[] {
	const targets = new Map<string, string | undefined>();
	const latest = new Map<string, WakeJournalKind>();
	for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
		if (!event.wakeId) continue;
		if (event.kind === "accepted") {
			const target = event.target as { id?: unknown; session?: { id?: unknown } } | undefined;
			targets.set(
				event.wakeId,
				typeof target?.session?.id === "string"
					? target.session.id
					: typeof target?.id === "string"
						? target.id
						: undefined,
			);
		}
		latest.set(event.wakeId, event.kind);
	}
	return [...latest.entries()]
		.filter(([wakeId, kind]) => {
			if (CLOSED_KINDS.has(kind)) return false;
			const target = targets.get(wakeId);
			return sessionId === undefined || target === sessionId;
		})
		.map(([wakeId, lastKind]) => ({ wakeId, lastKind, journalPath }));
}

export type JsonlWakeJournalOptions = { agentDir?: string; filePath?: string };

export class JsonlWakeJournal implements WakeJournal {
	readonly path: string;
	private tail: Promise<void> = Promise.resolve();
	private sequence?: number;

	constructor(options: JsonlWakeJournalOptions = {}) {
		this.path = options.filePath ?? join(options.agentDir ?? ".pi/agent", "logs", "wake-events.jsonl");
	}

	async append(event: WakeJournalEvent): Promise<number> {
		let sequence = 0;
		const operation = this.tail.then(async () => {
			if (this.sequence === undefined) this.sequence = (await this.read()).at(-1)?.seq ?? 0;
			sequence = ++this.sequence;
			await mkdir(dirname(this.path), { recursive: true });
			await appendFile(
				this.path,
				`${JSON.stringify({ ...event, seq: sequence, at: event.at ?? new Date().toISOString() })}\n`,
				"utf8",
			);
		});
		this.tail = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
		return sequence;
	}

	async read(): Promise<WakeJournalEnvelope[]> {
		try {
			const text = await readFile(this.path, "utf8");
			return text
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as WakeJournalEnvelope)
				.filter((event) => Number.isSafeInteger(event.seq));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
}
