import { lexer, type Token, type Tokens } from "marked";
import { renderToString } from "katex";
import "katex/dist/katex.min.css";

// Private-use marker. Marked leaves it inside one text token, and chat text does not contain it.
export const MATH_MARK = "\uE000";

export interface StashedMath {
	display: boolean;
	tex: string;
}

interface MathHit {
	end: number;
	display: boolean;
	tex: string;
}

function codeRanges(source: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const cursor = { at: 0 };
	const visit = (token: Token) => {
		if (token.type === "code" || token.type === "codespan") {
			const raw = token.raw;
			const at = source.indexOf(raw, cursor.at);
			if (at !== -1) {
				ranges.push([at, at + raw.length]);
				cursor.at = at + raw.length;
			}
			return;
		}
		if (token.type === "table") {
			const table = token as Tokens.Table;
			for (const cell of [...table.header, ...table.rows.flat()]) {
				for (const child of cell.tokens ?? []) { visit(child); }
			}
			return;
		}
		const nested = token as Token & { tokens?: Token[]; items?: Array<{ tokens?: Token[] }> };
		for (const child of nested.tokens ?? []) { visit(child); }
		for (const item of nested.items ?? []) {
			for (const child of item.tokens ?? []) { visit(child); }
		}
	};
	for (const token of lexer(source, { gfm: true, breaks: true })) { visit(token); }
	return ranges;
}

function skipped(ranges: Array<[number, number]>, index: number): number {
	for (const [start, end] of ranges) {
		if (index >= start && index < end) { return end; }
	}
	return -1;
}

function overlaps(ranges: Array<[number, number]>, start: number, end: number): boolean {
	return ranges.some(([from, to]) => start < to && end > from);
}

function escaped(source: string, index: number): boolean {
	let count = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) { count += 1; }
	return count % 2 === 1;
}

function closer(source: string, from: number, marker: string): number {
	for (let index = from; index <= source.length - marker.length; index += 1) {
		if (source.startsWith(marker, index) && !escaped(source, index)) { return index; }
	}
	return -1;
}

// $...$ is math only with no space after the opener, no space before the closer, and no digit after the closer.
function readDollar(source: string, index: number): MathHit | null {
	if (source[index] !== "$" || source[index + 1] === "$" || source[index - 1] === "$" || escaped(source, index)) { return null; }
	const next = source[index + 1];
	if (next === undefined || /\s/.test(next)) { return null; }
	for (let cursor = index + 1; cursor < source.length; cursor += 1) {
		if (source[cursor] === "\\") { cursor += 1; continue; }
		if (source[cursor] === "\n") { return null; }
		if (source[cursor] !== "$") { continue; }
		if (cursor === index + 1 || /\s/.test(source[cursor - 1]) || /\d/.test(source[cursor + 1] ?? "")) { return null; }
		return { end: cursor + 1, display: false, tex: source.slice(index + 1, cursor) };
	}
	return null;
}

function readPair(source: string, index: number, open: string, close: string, display: boolean): MathHit | null {
	if (!source.startsWith(open, index) || escaped(source, index)) { return null; }
	const at = closer(source, index + open.length, close);
	if (at === -1 || at === index + open.length) { return null; }
	return { end: at + close.length, display, tex: source.slice(index + open.length, at) };
}

function readMath(source: string, index: number): MathHit | null {
	return readPair(source, index, "$$", "$$", true)
		?? readPair(source, index, "\\[", "\\]", true)
		?? readPair(source, index, "\\(", "\\)", false)
		?? readDollar(source, index);
}

// Pull closed math out before Marked runs, so line breaks cannot split $$ and code stays code.
export function stashMath(source: string): { text: string; math: StashedMath[] } {
	let ranges: Array<[number, number]> = [];
	try {
		ranges = codeRanges(source);
	} catch {
		return { text: source, math: [] };
	}
	const math: StashedMath[] = [];
	let text = "";
	let index = 0;
	while (index < source.length) {
		const jump = skipped(ranges, index);
		if (jump !== -1) {
			text += source.slice(index, jump);
			index = jump;
			continue;
		}
		const found = readMath(source, index);
		if (found && !overlaps(ranges, index, found.end)) {
			text += `${MATH_MARK}${math.length}${MATH_MARK}`;
			math.push({ display: found.display, tex: found.tex });
			index = found.end;
			continue;
		}
		text += source[index];
		index += 1;
	}
	return { text, math };
}

export function mathHtml(tex: string, display: boolean): string {
	return renderToString(tex, { throwOnError: false, trust: false, displayMode: display });
}
