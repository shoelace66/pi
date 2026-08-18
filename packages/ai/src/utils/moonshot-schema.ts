/**
 * Convert ordinary JSON Schema into the restricted schema dialect accepted by
 * Moonshot tool calling (MFJS).
 *
 * This function is deliberately provider-boundary code. Callers keep the
 * original tool schema for validation and execution; the returned value is a
 * detached wire representation only.
 */

type SchemaObject = Record<string, unknown>;

const DROPPED_KEYWORDS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$comment",
	"title",
	"format",
	"prefixItems",
	"unevaluatedItems",
	"unevaluatedProperties",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minContains",
	"maxContains",
	"contains",
	"dependentRequired",
	"dependentSchemas",
	"patternProperties",
	"propertyNames",
	"minProperties",
	"maxProperties",
	"minLength",
	"maxLength",
	"uniqueItems",
]);

const ANNOTATION_KEYS = new Set(["description", "default", "examples", "$defs"]);

export class MoonshotSchemaError extends Error {
	readonly toolName: string;
	readonly path: string;

	constructor(toolName: string, path: string, message: string) {
		super(`Moonshot schema for tool "${toolName}" at ${path}: ${message}`);
		this.name = "MoonshotSchemaError";
		this.toolName = toolName;
		this.path = path;
	}
}

function isSchemaObject(value: unknown): value is SchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(path: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function schemaType(value: unknown): string | undefined {
	if (typeof value === "string") return "string";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return undefined;
}

function enumType(values: unknown[]): "string" | "integer" | "number" | undefined {
	if (values.length === 0 || values.some((value) => typeof value !== "string" && typeof value !== "number")) {
		return undefined;
	}
	if (values.every((value) => typeof value === "string")) return "string";
	return values.every((value) => typeof value === "number" && Number.isInteger(value)) ? "integer" : "number";
}

function appendNote(description: unknown, note: string): string {
	const prefix = typeof description === "string" && description.length > 0 ? `${description} ` : "";
	return `${prefix}[Moonshot compatibility: ${note}]`;
}

function copyWithout(source: SchemaObject, keys: Set<string>): SchemaObject {
	const result: SchemaObject = {};
	for (const [key, value] of Object.entries(source)) {
		if (!keys.has(key)) result[key] = value;
	}
	return result;
}

function mergeRequired(left: unknown, right: unknown): string[] | undefined {
	const values = new Set<string>();
	for (const source of [left, right]) {
		if (source === undefined) continue;
		if (!Array.isArray(source) || source.some((item) => typeof item !== "string")) return undefined;
		for (const item of source) values.add(item);
	}
	return values.size > 0 ? [...values] : undefined;
}

function mergeObjectSchemas(left: SchemaObject, right: SchemaObject, toolName: string, path: string): SchemaObject {
	const leftType = left.type;
	const rightType = right.type;
	if (leftType !== undefined && leftType !== "object") {
		throw new MoonshotSchemaError(toolName, path, "cannot merge a non-object schema");
	}
	if (rightType !== undefined && rightType !== "object") {
		throw new MoonshotSchemaError(toolName, path, "cannot merge a non-object schema");
	}

	const result: SchemaObject = { ...left, ...right, type: "object" };
	const properties: SchemaObject = {};
	for (const source of [left.properties, right.properties]) {
		if (source === undefined) continue;
		if (!isSchemaObject(source)) throw new MoonshotSchemaError(toolName, path, "object properties must be an object");
		Object.assign(properties, source);
	}
	if (Object.keys(properties).length > 0) result.properties = properties;

	const required = mergeRequired(left.required, right.required);
	if (required) result.required = required;
	else delete result.required;

	if (left.additionalProperties !== undefined && right.additionalProperties !== undefined) {
		const a = JSON.stringify(left.additionalProperties);
		const b = JSON.stringify(right.additionalProperties);
		if (a !== b) {
			throw new MoonshotSchemaError(toolName, path, "conflicting additionalProperties constraints");
		}
	}

	return result;
}

function sanitizeBooleanSchema(value: boolean, toolName: string, path: string): SchemaObject {
	if (value) return { type: "object", additionalProperties: true };
	throw new MoonshotSchemaError(toolName, path, "boolean false schemas cannot be represented safely");
}

function sanitizeTypeArray(types: unknown[], toolName: string, path: string): SchemaObject {
	if (types.length === 0 || types.some((type) => typeof type !== "string")) {
		throw new MoonshotSchemaError(toolName, path, "type arrays must contain non-empty strings");
	}
	return {
		anyOf: types.map((type) => ({ type })),
	};
}

function sanitizeAnyOf(source: SchemaObject, toolName: string, path: string): SchemaObject {
	const rawBranches = source.anyOf;
	if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
		throw new MoonshotSchemaError(toolName, `${path}.anyOf`, "anyOf must contain at least one schema");
	}
	const branches: SchemaObject[] = rawBranches.flatMap<SchemaObject>((branch, index) => {
		const branchPath = `${path}.anyOf[${index}]`;
		const sanitized = sanitizeNode(branch, toolName, branchPath);
		if (sanitized.type !== undefined || "$ref" in sanitized) return sanitized;
		if (Array.isArray(sanitized.anyOf)) {
			return sanitized.anyOf.map((nested, nestedIndex) => {
				if (!isSchemaObject(nested) || (nested.type === undefined && !("$ref" in nested))) {
					throw new MoonshotSchemaError(
						toolName,
						`${branchPath}.anyOf[${nestedIndex}]`,
						"nested anyOf branches must declare an explicit type",
					);
				}
				return nested;
			});
		}
		if (Object.keys(sanitized).length === 0) return { type: "object", additionalProperties: true };
		throw new MoonshotSchemaError(toolName, branchPath, "anyOf branches must declare an explicit type");
	});

	const siblingKeys = new Set(Object.keys(source).filter((key) => key !== "anyOf" && !ANNOTATION_KEYS.has(key)));
	const siblings = copyWithout(source, new Set(["anyOf", ...ANNOTATION_KEYS]));
	if (siblingKeys.size === 0) {
		const result: SchemaObject = { anyOf: branches };
		if (typeof source.description === "string") result.description = source.description;
		if (source.default !== undefined) result.default = source.default;
		return result;
	}

	const hasObjectConstraints = ["properties", "required", "additionalProperties", "type"].some(
		(key) => key in siblings,
	);
	if (!hasObjectConstraints) {
		throw new MoonshotSchemaError(
			toolName,
			path,
			`unsupported sibling keywords next to anyOf: ${[...siblingKeys].join(", ")}`,
		);
	}
	const sanitizedSiblings = sanitizeNode(siblings, toolName, path);

	const distributed = branches.map((branch, index) => {
		const branchPath = `${path}.anyOf[${index}]`;
		const branchType = branch.type;
		const parentType = sanitizedSiblings.type;
		if (parentType !== undefined && parentType !== "object") {
			if (branchType !== parentType) {
				throw new MoonshotSchemaError(toolName, branchPath, "parent type conflicts with an anyOf branch");
			}
			return branch;
		}
		return mergeObjectSchemas(sanitizedSiblings, branch, toolName, branchPath);
	});

	const result: SchemaObject = { anyOf: distributed };
	if (typeof source.description === "string") result.description = source.description;
	if (source.default !== undefined) result.default = source.default;
	return result;
}

function sanitizeAllOf(source: SchemaObject, toolName: string, path: string): SchemaObject {
	const rawBranches = source.allOf;
	if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
		throw new MoonshotSchemaError(toolName, `${path}.allOf`, "allOf must contain at least one schema");
	}
	let merged: SchemaObject = { type: "object" };
	let union: SchemaObject[] | undefined;
	const siblings = copyWithout(source, new Set(["allOf"]));
	if (Object.keys(siblings).length > 0) {
		merged = mergeObjectSchemas(merged, sanitizeNode(siblings, toolName, path), toolName, path);
	}
	for (const [index, branch] of rawBranches.entries()) {
		const sanitized = sanitizeNode(branch, toolName, `${path}.allOf[${index}]`);
		if (Array.isArray(sanitized.anyOf)) {
			const variants = sanitized.anyOf.filter(isSchemaObject);
			if (variants.length !== sanitized.anyOf.length || variants.some((variant) => variant.type !== "object")) {
				throw new MoonshotSchemaError(
					toolName,
					`${path}.allOf[${index}].anyOf`,
					"allOf can only distribute object anyOf branches",
				);
			}
			union = (union ?? [merged]).flatMap((base) =>
				variants.map((variant, variantIndex) =>
					mergeObjectSchemas(base, variant, toolName, `${path}.allOf[${index}].anyOf[${variantIndex}]`),
				),
			);
		} else if (union) {
			union = union.map((variant) => mergeObjectSchemas(variant, sanitized, toolName, `${path}.allOf[${index}]`));
		} else {
			merged = mergeObjectSchemas(merged, sanitized, toolName, `${path}.allOf[${index}]`);
		}
	}
	return union ? { anyOf: union } : merged;
}

function sanitizeNode(value: unknown, toolName: string, path: string): SchemaObject {
	if (typeof value === "boolean") return sanitizeBooleanSchema(value, toolName, path);
	if (!isSchemaObject(value)) throw new MoonshotSchemaError(toolName, path, "schema nodes must be objects");

	if ("oneOf" in value) {
		throw new MoonshotSchemaError(toolName, `${path}.oneOf`, "oneOf is not safely representable in MFJS");
	}
	if ("allOf" in value) return sanitizeAllOf(value, toolName, path);
	if ("anyOf" in value) return sanitizeAnyOf(value, toolName, path);

	if (Array.isArray(value.type)) {
		const typeUnion = sanitizeTypeArray(value.type, toolName, `${path}.type`);
		const withoutType = copyWithout(value, new Set(["type"]));
		return sanitizeAnyOf({ anyOf: typeUnion.anyOf, ...withoutType }, toolName, path);
	}

	const result: SchemaObject = {};
	const dropped: string[] = [];
	for (const [key, raw] of Object.entries(value)) {
		if (DROPPED_KEYWORDS.has(key)) {
			dropped.push(key);
			continue;
		}
		if (key === "properties") {
			if (!isSchemaObject(raw)) throw new MoonshotSchemaError(toolName, `${path}.properties`, "must be an object");
			const properties: SchemaObject = {};
			for (const [name, schema] of Object.entries(raw)) {
				properties[name] = sanitizeNode(schema, toolName, pathKey(`${path}.properties`, name));
			}
			result.properties = properties;
			continue;
		}
		if (key === "$defs" || key === "definitions") {
			if (!isSchemaObject(raw)) throw new MoonshotSchemaError(toolName, `${path}.${key}`, "must be an object");
			const definitions: SchemaObject = {};
			for (const [name, schema] of Object.entries(raw)) {
				definitions[name] = sanitizeNode(schema, toolName, pathKey(`${path}.${key}`, name));
			}
			if (result.$defs && key === "definitions") {
				throw new MoonshotSchemaError(toolName, path, "both definitions and $defs are present");
			}
			result.$defs = definitions;
			continue;
		}
		if (key === "items") {
			if (Array.isArray(raw))
				throw new MoonshotSchemaError(toolName, `${path}.items`, "tuple items are unsupported");
			result.items = sanitizeNode(raw ?? true, toolName, `${path}.items`);
			continue;
		}
		if (key === "additionalProperties") {
			result.additionalProperties =
				typeof raw === "boolean" ? raw : sanitizeNode(raw, toolName, `${path}.additionalProperties`);
			continue;
		}
		if (key === "enum") {
			if (!Array.isArray(raw) || enumType(raw) === undefined) {
				throw new MoonshotSchemaError(toolName, `${path}.enum`, "must contain primitive values");
			}
			result.enum = [...raw];
			continue;
		}
		if (key === "const") {
			const type = enumType([raw]);
			if (type === undefined) {
				throw new MoonshotSchemaError(toolName, `${path}.const`, "const must be converted from a string or number");
			}
			result.enum = [raw];
			continue;
		}
		result[key] = raw;
	}

	if (result.type === undefined) {
		if (
			result.properties !== undefined ||
			result.required !== undefined ||
			result.additionalProperties !== undefined
		) {
			result.type = "object";
		} else if (result.items !== undefined) {
			result.type = "array";
		} else if (result.enum !== undefined && Array.isArray(result.enum) && result.enum.length > 0) {
			result.type = enumType(result.enum);
		} else if (result.const !== undefined) {
			result.type = schemaType(result.const);
		}
	}

	if (result.type === "array" && result.items === undefined)
		result.items = { type: "object", additionalProperties: true };
	if (result.required !== undefined) {
		if (!Array.isArray(result.required) || result.required.some((item) => typeof item !== "string")) {
			throw new MoonshotSchemaError(toolName, `${path}.required`, "must be an array of strings");
		}
		if (result.required.length === 0) delete result.required;
	}
	if (dropped.length > 0)
		result.description = appendNote(result.description, `omitted unsupported keywords: ${dropped.join(", ")}`);
	return result;
}

function validateMoonshotReferences(
	schema: SchemaObject,
	toolName: string,
	path: string,
	rootDefs?: SchemaObject,
	root = false,
): void {
	if (schema.$defs !== undefined) {
		if (!root || !isSchemaObject(schema.$defs)) {
			throw new MoonshotSchemaError(toolName, `${path}.$defs`, "$defs must be an object at the schema root");
		}
		for (const [name, definition] of Object.entries(schema.$defs)) {
			if (!isSchemaObject(definition)) {
				throw new MoonshotSchemaError(toolName, pathKey(`${path}.$defs`, name), "must be an object schema");
			}
			validateMoonshotReferences(definition, toolName, pathKey(`${path}.$defs`, name), schema.$defs, false);
		}
	}
	if (schema.$ref !== undefined) {
		if (typeof schema.$ref !== "string") {
			throw new MoonshotSchemaError(toolName, `${path}.$ref`, "must be an internal string reference");
		}
		const reference = schema.$ref;
		if (reference !== "#" && (!reference.startsWith("#/$defs/") || !rootDefs?.[reference.slice("#/$defs/".length)])) {
			throw new MoonshotSchemaError(toolName, `${path}.$ref`, "must reference # or a definition in the root $defs");
		}
	}
	if (isSchemaObject(schema.properties)) {
		for (const [name, child] of Object.entries(schema.properties)) {
			if (isSchemaObject(child))
				validateMoonshotReferences(child, toolName, pathKey(`${path}.properties`, name), rootDefs, false);
		}
	}
	if (isSchemaObject(schema.items))
		validateMoonshotReferences(schema.items, toolName, `${path}.items`, rootDefs, false);
	if (isSchemaObject(schema.additionalProperties))
		validateMoonshotReferences(
			schema.additionalProperties,
			toolName,
			`${path}.additionalProperties`,
			rootDefs,
			false,
		);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (Array.isArray(schema[key])) {
			for (const [index, child] of schema[key].entries()) {
				if (isSchemaObject(child))
					validateMoonshotReferences(child, toolName, `${path}.${key}[${index}]`, rootDefs, false);
			}
		}
	}
}

function mergeRootObjectUnion(schema: SchemaObject, toolName: string): SchemaObject {
	const branches = schema.anyOf;
	if (!Array.isArray(branches) || branches.length === 0) {
		throw new MoonshotSchemaError(toolName, "$root", "tool parameters must be an object schema");
	}
	if (branches.some((branch) => !isSchemaObject(branch) || branch.type !== "object" || "$ref" in branch)) {
		throw new MoonshotSchemaError(
			toolName,
			"$root.anyOf",
			"root anyOf must contain only object branches; primitive parameter unions are not supported by Moonshot",
		);
	}

	const properties: SchemaObject = {};
	const propertyVariants = new Map<string, SchemaObject[]>();
	for (const branch of branches) {
		if (branch.properties !== undefined) {
			if (!isSchemaObject(branch.properties)) {
				throw new MoonshotSchemaError(toolName, "$root.anyOf.properties", "must be an object");
			}
			for (const [name, property] of Object.entries(branch.properties)) {
				if (!isSchemaObject(property)) {
					throw new MoonshotSchemaError(
						toolName,
						pathKey("$root.anyOf.properties", name),
						"must be an object schema",
					);
				}
				const variants = propertyVariants.get(name) ?? [];
				variants.push(property);
				propertyVariants.set(name, variants);
			}
		}
	}

	for (const [name, variants] of propertyVariants) {
		const unique = variants.filter(
			(variant, index) =>
				variants.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(variant)) === index,
		);
		properties[name] = unique.length === 1 ? unique[0] : { anyOf: unique };
	}

	const additionalProperties = branches.map((branch) => branch.additionalProperties);
	const hasAdditionalProperties = additionalProperties.some((value) => value !== undefined);
	const result: SchemaObject = { type: "object" };
	if (Object.keys(properties).length > 0) result.properties = properties;
	if (
		hasAdditionalProperties &&
		additionalProperties.every((value) => JSON.stringify(value) === JSON.stringify(additionalProperties[0]))
	) {
		result.additionalProperties = additionalProperties[0];
	}
	if (typeof schema.description === "string") result.description = schema.description;
	if (schema.default !== undefined) result.default = schema.default;
	result.description = appendNote(
		result.description,
		"root object union flattened for Moonshot; canonical runtime validation remains authoritative",
	);
	return result;
}

export function sanitizeMoonshotToolSchema(schema: unknown, toolName = "tool"): Record<string, unknown> {
	if (isSchemaObject(schema) && Array.isArray(schema.anyOf) && schema.$defs !== undefined) {
		throw new MoonshotSchemaError(toolName, "$root.$defs", "root $defs cannot be combined with a root anyOf union");
	}
	const sanitized = sanitizeNode(schema, toolName, "$root");
	const result =
		sanitized.type === "object"
			? sanitized
			: "anyOf" in sanitized
				? mergeRootObjectUnion(sanitized, toolName)
				: Object.keys(sanitized).length === 0
					? { type: "object" }
					: (() => {
							throw new MoonshotSchemaError(toolName, "$root", "tool parameters must have type object");
						})();
	validateMoonshotReferences(result, toolName, "$root", isSchemaObject(result.$defs) ? result.$defs : undefined, true);
	return result;
}
