import { Lexer, Marked, Tokenizer, type Token } from "marked";
import { renderToString } from "katex";
import "katex/dist/katex.min.css";

// Private-use marker. Marked leaves it inside one text token, and chat text does not contain it.
export const MATH_MARK = "\uE000";

export interface StashedMath {
	display: boolean;
	tex: string;
	raw: string;
}

interface MathHit {
	end: number;
	display: boolean;
	tex: string;
}

const MARKDOWN_OPTIONS = { gfm: true, breaks: true };

const markdown = new Marked({
	...MARKDOWN_OPTIONS,
	extensions: [{
		name: "displayMath",
		level: "block",
		tokenizer(source) {
			const start = /^ {1,3}/.exec(source)?.[0].length ?? 0;
			const found = readPair(source, start, "$$", "$$", true) ?? readPair(source, start, "\\[", "\\]", true);
			if (!found || !/^[ \t]*(?:\n|$)/.test(source.slice(found.end))) { return; }
			const text = source.slice(start, found.end);
			const tokens = Lexer.lex(text, { ...MARKDOWN_OPTIONS });
			if (tokens.length === 1) { return; }
			let hasCode = false;
			markdown.walkTokens(tokens, (token) => {
				if (token.type === "code" || token.type === "codespan") { hasCode = true; }
			});
			if (hasCode) { return; }
			return { type: "paragraph", raw: source.slice(0, found.end), text, tokens: this.lexer.inline(text) };
		},
	}],
});

function codeRanges(source: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const visit = (tokens: Token[], from: number, to: number) => {
		let cursor = from;
		for (const token of tokens) {
			const start = source.indexOf(token.raw, cursor);
			const end = start + token.raw.length;
			if (start === -1 || end > to) {
				ranges.push([from, to]);
				return;
			}
			if (token.type === "codespan") {
				ranges.push([start, end]);
			} else if ("tokens" in token && token.tokens) {
				visit(token.tokens, start, end);
			}
			cursor = end;
		}
	};
	if (source.includes("`")) {
		visit(Lexer.lexInline(source, { ...MARKDOWN_OPTIONS }), 0, source.length);
	}
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

function stashMath(source: string, math: StashedMath[]): string {
	if (!/[$\\]/.test(source)) { return source; }
	const ranges = codeRanges(source);
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
			math.push({ display: found.display, tex: found.tex, raw: source.slice(index, found.end) });
			index = found.end;
			continue;
		}
		text += source[index];
		index += 1;
	}
	return text;
}

class MathTokenizer extends Tokenizer {
	override table(source: string) {
		const raw = this.rules.block.table.exec(source)?.[0];
		if (raw === undefined) { return; }
		const math = (this.lexer as MathLexer).math;
		const count = math.length;
		const text = raw.split("\n").map((line) => stashMath(line, math)).join("\n");
		const table = super.table(text);
		if (table) {
			table.raw = raw;
		} else {
			math.length = count;
		}
		return table;
	}
}

class MathLexer extends Lexer {
	readonly math: StashedMath[] = [];

	// Marked resolves fences and container prefixes before it lexes inline text.
	override inlineTokens(source: string, tokens?: Token[]): Token[] {
		return super.inlineTokens(stashMath(source, this.math), tokens);
	}
}

export function lexMarkdown(source: string): { tokens: Token[]; math: StashedMath[] } {
	const lexer = new MathLexer({ ...markdown.defaults, tokenizer: new MathTokenizer() });
	return { tokens: lexer.lex(source), math: lexer.math };
}

export function mathHtml(tex: string, display: boolean): string | null {
	try {
		return renderToString(tex, { throwOnError: false, trust: false, displayMode: display });
	} catch {
		return null;
	}
}
