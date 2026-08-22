#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WakeClient } from "./core/wake/client.ts";
import { type JsonValue, WakeClientError } from "./core/wake/types.ts";

type Arguments = {
	command?: string;
	addressFile?: string;
	eventId?: string;
	message?: string;
	dataFile?: string;
	data?: string;
	help: boolean;
};

function usage(): string {
	return [
		"Usage: pi-wake emit --event-id <id> --message <text> [--data <json> | --data-file <path>] [--address-file <path>]",
		"",
		"The capability is read from PI_WAKE_ADDRESS unless --address-file is provided.",
		"Receipts are written as one JSON object to stdout.",
	].join("\n");
}

function parseArguments(argv: string[]): Arguments {
	const result: Arguments = { help: false };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index]!;
		if (!result.command && !value.startsWith("-")) {
			result.command = value;
			continue;
		}
		if (value === "--help" || value === "-h") {
			result.help = true;
			continue;
		}
		const next = argv[++index];
		if (!next) throw new Error(`${value} requires a value`);
		if (value === "--address-file") result.addressFile = next;
		else if (value === "--event-id") result.eventId = next;
		else if (value === "--message") result.message = next;
		else if (value === "--data-file") result.dataFile = next;
		else if (value === "--data") result.data = next;
		else throw new Error(`Unknown option: ${value}`);
	}
	return result;
}

async function resolveAddress(args: Arguments): Promise<string> {
	const sources = [args.addressFile !== undefined, process.env.PI_WAKE_ADDRESS !== undefined].filter(Boolean).length;
	if (sources === 0) throw new Error("Wake capability is required via PI_WAKE_ADDRESS or --address-file");
	if (sources > 1) throw new Error("Provide exactly one Wake capability source");
	if (args.addressFile) return (await readFile(args.addressFile, "utf8")).trim();
	return process.env.PI_WAKE_ADDRESS!.trim();
}

async function readData(args: Arguments): Promise<JsonValue | undefined> {
	if (args.data !== undefined && args.dataFile !== undefined)
		throw new Error("Provide only one of --data or --data-file");
	if (args.data !== undefined) return JSON.parse(args.data) as JsonValue;
	if (args.dataFile !== undefined) return JSON.parse(await readFile(args.dataFile, "utf8")) as JsonValue;
	return undefined;
}

export async function runWakeCli(argv = process.argv.slice(2)): Promise<number> {
	try {
		const args = parseArguments(argv);
		if (args.help) {
			process.stdout.write(`${usage()}\n`);
			return 0;
		}
		if (args.command !== "emit") throw new Error("The only supported command is emit");
		if (!args.eventId) throw new Error("--event-id is required");
		if (!args.message) throw new Error("--message is required");
		const receipt = await new WakeClient().emit(await resolveAddress(args), {
			eventId: args.eventId,
			message: args.message,
			data: await readData(args),
		});
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		return 0;
	} catch (error) {
		const wakeError = error instanceof WakeClientError ? error : undefined;
		process.stderr.write(
			`${JSON.stringify({
				code: wakeError?.code ?? "WAKE_CLI_USAGE",
				message: error instanceof Error ? error.message : String(error),
				retryAfterMs: wakeError?.retryAfterMs,
			})}\n`,
		);
		if (wakeError?.code === "WAKE_BUSY") return 3;
		if (wakeError?.code === "WAKE_OFFLINE" || wakeError?.code === "WAKE_UNAUTHORIZED") return 4;
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runWakeCli();
}
