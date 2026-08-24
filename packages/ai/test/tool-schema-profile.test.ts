import { describe, expect, it } from "vitest";
import { convertToolSchema, ToolSchemaProfileError } from "../src/utils/tool-schema.ts";

function convertMfjsToolSchema(schema: unknown, toolName: string): Record<string, unknown> {
	return convertToolSchema(schema, toolName, "mfjs");
}

describe("MFJS tool schema profile", () => {
	it("flattens a root object union into MFJS-required object parameters", () => {
		const input = {
			type: "object",
			anyOf: [
				{ allOf: [{ type: "object", properties: { path: { type: "string" } } }, { required: ["path"] }] },
				{ type: "object", properties: { url: { type: "string" } }, required: ["url"] },
			],
		};

		const output = convertMfjsToolSchema(input, "outer_loop");
		expect(output).toMatchObject({ type: "object" });
		expect(output).not.toHaveProperty("anyOf");
		expect(output.properties).toEqual({
			path: { type: "string" },
			url: { type: "string" },
		});
	});

	it("distributes shared object constraints and drops empty required arrays", () => {
		const output = convertMfjsToolSchema(
			{
				type: "object",
				properties: {
					config: {
						type: "object",
						properties: { route: { type: "string" }, file: { type: "string" } },
						required: [],
						anyOf: [{ required: ["route"] }, { required: ["file"] }],
					},
				},
			},
			"mcp_tool",
		) as { properties: { config: { anyOf: Array<Record<string, unknown>> } } };

		expect(output.properties.config.anyOf).toEqual([
			{
				type: "object",
				properties: { route: { type: "string" }, file: { type: "string" } },
				required: ["route"],
			},
			{
				type: "object",
				properties: { route: { type: "string" }, file: { type: "string" } },
				required: ["file"],
			},
		]);
	});

	it("normalizes nested unions and array items", () => {
		const output = convertMfjsToolSchema(
			{
				type: "object",
				properties: {
					size: {
						anyOf: [{ type: "string" }, { type: "array", items: true }],
					},
				},
			},
			"mcp_layout",
		);

		expect(output).toEqual({
			type: "object",
			properties: {
				size: {
					anyOf: [{ type: "string" }, { type: "array", items: { type: "object", additionalProperties: true } }],
				},
			},
		});
	});

	it("gives unconstrained anyOf branches an explicit MFJS object type", () => {
		expect(convertMfjsToolSchema({ anyOf: [{}] }, "unconstrained_union")).toMatchObject({
			type: "object",
			additionalProperties: true,
		});
	});

	it("adds object and array types when standard schemas omit them", () => {
		expect(
			convertMfjsToolSchema(
				{ properties: { value: { enum: ["a", "b"] }, list: { type: "array" } } },
				"missing_types",
			),
		).toEqual({
			type: "object",
			properties: {
				value: { enum: ["a", "b"], type: "string" },
				list: { type: "array", items: { type: "object", additionalProperties: true } },
			},
		});
	});

	it("does not mutate the source schema", () => {
		const input = { type: "object", properties: { value: { type: "string" } } };
		const before = JSON.parse(JSON.stringify(input));
		convertMfjsToolSchema(input, "immutable");
		expect(input).toEqual(before);
	});

	it("rejects boolean false and unsafe oneOf with tool/path diagnostics", () => {
		expect(() => convertMfjsToolSchema({ type: "object", properties: { value: false } }, "bad_tool")).toThrow(
			'MFJS tool schema for "bad_tool" at $root.properties.value',
		);
		expect(() => convertMfjsToolSchema({ oneOf: [{ type: "string" }, { type: "number" }] }, "bad_union")).toThrow(
			'MFJS tool schema for "bad_union" at $root.oneOf',
		);
	});

	it("preserves supported defaults and reports dropped keywords", () => {
		const output = convertMfjsToolSchema(
			{
				type: "object",
				properties: { date: { type: "string", format: "date-time", title: "Date", default: "2026-01-01" } },
			},
			"metadata",
		) as { properties: { date: Record<string, unknown> } };
		expect(output.properties.date).toEqual({
			type: "string",
			default: "2026-01-01",
			description: expect.stringContaining("format, title"),
		});
	});

	it("converts string constants to MFJS enums and validates internal definitions", () => {
		expect(
			convertMfjsToolSchema({ type: "object", properties: { action: { const: "list" } } }, "const_tool"),
		).toEqual({ type: "object", properties: { action: { enum: ["list"], type: "string" } } });
		expect(
			convertMfjsToolSchema(
				{
					type: "object",
					properties: { node: { $ref: "#/$defs/node" } },
					$defs: { node: { type: "string" } },
				},
				"defs_tool",
			),
		).toMatchObject({ $defs: { node: { type: "string" } } });
	});

	it("rejects non-MFJS enum values and external or nested references", () => {
		expect(() =>
			convertMfjsToolSchema({ type: "object", properties: { value: { enum: [true, false] } } }, "enum_tool"),
		).toThrow(/\.enum/);
		expect(() =>
			convertMfjsToolSchema(
				{ type: "object", properties: { value: { $ref: "https://example.com/schema" } } },
				"ref_tool",
			),
		).toThrow(/\.\$ref/);
		expect(() =>
			convertMfjsToolSchema(
				{ type: "object", properties: { value: { $defs: { nested: { type: "string" } } } } },
				"nested_defs",
			),
		).toThrow(/\.\$defs/);
	});

	it("uses the typed error class", () => {
		try {
			convertMfjsToolSchema(false, "typed_error");
			throw new Error("expected sanitizer to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolSchemaProfileError);
		}
	});
});
