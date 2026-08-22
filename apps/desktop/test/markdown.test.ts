import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../renderer/src/markdown.tsx";

Object.assign(globalThis, { React });

test("renders indented list items without stalling", { timeout: 2_000 }, () => {
	const source = [
		"Plan:",
		"1. First step",
		"2. Second step",
		"   - Nested detail",
		"   - Another detail",
		"3. Final step",
	].join("\n");
	const html = renderToStaticMarkup(createElement(Markdown, { text: source }));
	assert.match(html, /Nested detail/);
	assert.match(html, /Another detail/);
});

test("renders long inline-heavy content in bounded time", { timeout: 2_000 }, () => {
	const source = Array.from({ length: 1_000 }, (_, index) => `plain [${index}] \`value-${index}\``).join(" ");
	const started = performance.now();
	const html = renderToStaticMarkup(createElement(Markdown, { text: source }));
	assert.match(html, /value-999/);
	assert.ok(performance.now() - started < 1_000);
});
