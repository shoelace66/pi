import type { JsonValue, MonitorObservation } from "./types.ts";

export interface MonitorAdapter {
	readonly name: string;
	observe(source: Record<string, JsonValue>, signal?: AbortSignal): Promise<MonitorObservation>;
}

export class MonitorRegistry {
	private readonly adapters = new Map<string, MonitorAdapter>();

	register(adapter: MonitorAdapter): void {
		if (!/^[A-Za-z0-9_.-]+$/.test(adapter.name)) throw new Error("Monitor adapter name is invalid");
		if (this.adapters.has(adapter.name)) throw new Error(`Monitor adapter already registered: ${adapter.name}`);
		this.adapters.set(adapter.name, adapter);
	}

	get(name: string): MonitorAdapter | undefined {
		return this.adapters.get(name);
	}

	require(name: string): MonitorAdapter {
		const adapter = this.get(name);
		if (!adapter) throw new Error(`Unknown monitor adapter: ${name}`);
		return adapter;
	}

	list(): MonitorAdapter[] {
		return [...this.adapters.values()];
	}
}
