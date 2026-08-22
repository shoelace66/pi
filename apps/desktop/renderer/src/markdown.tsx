// biome-ignore-all lint/suspicious/noArrayIndexKey: Parsed Markdown blocks are immutable for each render and have no intrinsic IDs.

import type { ReactNode } from "react";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface InlineSegment {
	readonly type: "text" | "code" | "bold" | "italic" | "link" | "strikethrough";
	readonly content: string;
	readonly href?: string;
}

function parseInline(text: string): InlineSegment[] {
	const segments: InlineSegment[] = [];
	const codePattern = /`([^`]+)`/y;
	const boldPattern = /\*\*([^*]+)\*\*/y;
	const strikethroughPattern = /~~([^~]+)~~/y;
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/y;
	const italicPattern = /\*([^*]+)\*/y;
	const specialPattern = /[`*~[]/g;
	let cursor = 0;

	while (cursor < text.length) {
		codePattern.lastIndex = cursor;
		const codeMatch = codePattern.exec(text);
		if (codeMatch) {
			segments.push({ type: "code", content: codeMatch[1] });
			cursor = codePattern.lastIndex;
			continue;
		}

		boldPattern.lastIndex = cursor;
		const boldMatch = boldPattern.exec(text);
		if (boldMatch) {
			segments.push({ type: "bold", content: boldMatch[1] });
			cursor = boldPattern.lastIndex;
			continue;
		}

		strikethroughPattern.lastIndex = cursor;
		const strikethroughMatch = strikethroughPattern.exec(text);
		if (strikethroughMatch) {
			segments.push({ type: "strikethrough", content: strikethroughMatch[1] });
			cursor = strikethroughPattern.lastIndex;
			continue;
		}

		linkPattern.lastIndex = cursor;
		const linkMatch = linkPattern.exec(text);
		if (linkMatch) {
			segments.push({ type: "link", content: linkMatch[1], href: linkMatch[2] });
			cursor = linkPattern.lastIndex;
			continue;
		}

		italicPattern.lastIndex = cursor;
		const italicMatch = italicPattern.exec(text);
		if (italicMatch) {
			segments.push({ type: "italic", content: italicMatch[1] });
			cursor = italicPattern.lastIndex;
			continue;
		}

		specialPattern.lastIndex = cursor + 1;
		const nextSpecial = specialPattern.exec(text);
		const end = nextSpecial?.index ?? text.length;
		segments.push({ type: "text", content: text.slice(cursor, end) });
		cursor = end;
	}

	return segments;
}

function renderInline(segments: InlineSegment[], keyPrefix: string): ReactNode[] {
	return segments.map((segment, index) => {
		const key = `${keyPrefix}-${index}`;
		switch (segment.type) {
			case "code":
				return (
					<code key={key} className="md-inline-code">
						{segment.content}
					</code>
				);
			case "bold":
				return <strong key={key}>{segment.content}</strong>;
			case "italic":
				return <em key={key}>{segment.content}</em>;
			case "strikethrough":
				return <s key={key}>{segment.content}</s>;
			case "link":
				return (
					<a key={key} href={segment.href} rel="noreferrer" target="_blank">
						{segment.content}
					</a>
				);
			default:
				return <span key={key}>{segment.content}</span>;
		}
	});
}

interface Block {
	readonly type: "heading" | "paragraph" | "code-block" | "list" | "ordered-list" | "blockquote" | "hr" | "table";
	readonly level?: number;
	readonly text?: string;
	readonly items?: string[];
	readonly lang?: string;
	readonly rows?: string[][];
	readonly headers?: string[];
}

function parseBlocks(markdown: string): Block[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i++;
			continue;
		}

		const trimmed = line.trim();
		if (trimmed === "") {
			i++;
			continue;
		}

		const hrMatch = /^(-{3,}|\*{3,}|_{3,})$/.exec(trimmed);
		if (hrMatch) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}

		const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
		if (headingMatch) {
			blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2] });
			i++;
			continue;
		}

		const codeFenceMatch = /^```(\w*)/.exec(trimmed);
		if (codeFenceMatch) {
			const lang = codeFenceMatch[1] ?? "";
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && lines[i] !== undefined && !/^```\s*$/.test(lines[i]!.trim())) {
				codeLines.push(lines[i]!);
				i++;
			}
			i++;
			blocks.push({ type: "code-block", lang, text: codeLines.join("\n") });
			continue;
		}

		const blockquoteMatch = /^>\s?(.*)/.exec(trimmed);
		if (blockquoteMatch) {
			const quoteLines: string[] = [];
			while (i < lines.length && lines[i] !== undefined && /^>\s?/.test(lines[i]!.trim())) {
				const m = /^>\s?(.*)/.exec(lines[i]!.trim());
				quoteLines.push(m ? m[1] : "");
				i++;
			}
			blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
			continue;
		}

		const listItemMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
		if (listItemMatch) {
			const items: string[] = [];
			while (i < lines.length && lines[i] !== undefined && /^[-*+]\s+/.test(lines[i]!.trim())) {
				const m = /^[-*+]\s+(.+)$/.exec(lines[i]!.trim());
				items.push(m ? m[1] : "");
				i++;
			}
			blocks.push({ type: "list", items });
			continue;
		}

		const orderedItemMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
		if (orderedItemMatch) {
			const items: string[] = [];
			while (i < lines.length && lines[i] !== undefined && /^\d+\.\s+/.test(lines[i]!.trim())) {
				const m = /^\d+\.\s+(.+)$/.exec(lines[i]!.trim());
				items.push(m ? m[1] : "");
				i++;
			}
			blocks.push({ type: "ordered-list", items });
			continue;
		}

		const tableMatch = /^\|(.+)\|$/.exec(trimmed);
		if (tableMatch && i + 1 < lines.length && /^\|[-:\s|]+\|$/.test((lines[i + 1] ?? "").trim())) {
			const headers = tableMatch[1].split("|").map((h) => h.trim());
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i] !== undefined && /^\|.+\|$/.test(lines[i]!.trim())) {
				const rowMatch = /^\|(.+)\|$/.exec(lines[i]!.trim());
				if (rowMatch) rows.push(rowMatch[1].split("|").map((c) => c.trim()));
				i++;
			}
			blocks.push({ type: "table", headers, rows });
			continue;
		}

		const paraLines: string[] = [];
		while (
			i < lines.length &&
			lines[i] !== undefined &&
			lines[i]!.trim() !== "" &&
			!/^(#{1,6}\s|```|>\s|[-*+]\s|\d+\.\s|(-{3,}|\*{3,}))/.test(lines[i]!.trim())
		) {
			paraLines.push(lines[i]!);
			i++;
		}
		if (paraLines.length > 0) {
			blocks.push({ type: "paragraph", text: paraLines.join(" ") });
		} else {
			// Malformed or unsupported Markdown must still make progress. Without
			// this fallback, a delimiter-looking line can keep the renderer loop
			// pinned forever.
			blocks.push({ type: "paragraph", text: line });
			i++;
		}
	}

	return blocks;
}

export function Markdown({ text }: { readonly text: string }): React.JSX.Element {
	const blocks = parseBlocks(text);
	return (
		<div className="md-body">
			{blocks.map((block, index) => {
				const key = `block-${index}`;
				switch (block.type) {
					case "heading": {
						const level = block.level ?? 1;
						const className = `md-heading md-heading-${level}`;
						const content = renderInline(parseInline(block.text ?? ""), key);
						if (level <= 2)
							return (
								<h2 key={key} className={className}>
									{content}
								</h2>
							);
						if (level === 3)
							return (
								<h3 key={key} className={className}>
									{content}
								</h3>
							);
						if (level === 4)
							return (
								<h4 key={key} className={className}>
									{content}
								</h4>
							);
						return (
							<h5 key={key} className={className}>
								{content}
							</h5>
						);
					}
					case "code-block":
						return (
							<pre key={key} className="md-code-block" data-lang={block.lang || undefined}>
								{block.lang ? <span className="md-code-lang">{block.lang}</span> : null}
								<code>{block.text}</code>
							</pre>
						);
					case "list":
						return (
							<ul key={key} className="md-list">
								{(block.items ?? []).map((item, itemIndex) => (
									<li key={`${key}-${itemIndex}`}>{renderInline(parseInline(item), `${key}-${itemIndex}`)}</li>
								))}
							</ul>
						);
					case "ordered-list":
						return (
							<ol key={key} className="md-list md-list-ordered">
								{(block.items ?? []).map((item, itemIndex) => (
									<li key={`${key}-${itemIndex}`}>{renderInline(parseInline(item), `${key}-${itemIndex}`)}</li>
								))}
							</ol>
						);
					case "blockquote":
						return (
							<blockquote key={key} className="md-blockquote">
								{renderInline(parseInline(block.text ?? ""), key)}
							</blockquote>
						);
					case "hr":
						return <hr key={key} className="md-hr" />;
					case "table":
						return (
							<div key={key} className="md-table-wrap">
								<table className="md-table">
									<thead>
										<tr>
											{(block.headers ?? []).map((h, hIndex) => (
												<th key={hIndex}>{renderInline(parseInline(h), `${key}-th-${hIndex}`)}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{(block.rows ?? []).map((row, rowIndex) => (
											<tr key={`${key}-tr-${rowIndex}`}>
												{row.map((cell, cellIndex) => (
													<td key={cellIndex}>
														{renderInline(parseInline(cell), `${key}-td-${rowIndex}-${cellIndex}`)}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					default:
						return (
							<p key={key} className="md-paragraph">
								{renderInline(parseInline(block.text ?? ""), key)}
							</p>
						);
				}
			})}
		</div>
	);
}

export { escapeHtml };
