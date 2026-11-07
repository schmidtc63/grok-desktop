import { createElement, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { lexer, type Token, type Tokens } from "marked";
import { PLATFORM } from "./data";
import { MATH_MARK, mathHtml, stashMath, type StashedMath } from "./markdown-math";
import { diagramTheme, drawDiagram, fenceClosed, isMermaid, type DiagramResult } from "./markdown-diagram";

export interface MarkdownProps {
	text: string;
	// Plain text runs go through this so file paths can become links.
	renderText?: (text: string, key: string) => ReactNode;
	// Inline code; return null to show it as plain code.
	renderCode?: (code: string, key: string) => ReactNode;
	onLink?: (href: string, event: MouseEvent) => void;
	onCopy?: (code: string) => void;
	onRun?: (code: string) => void;
}

// Run sends a block to the Terminal pane, so only the language that pane runs gets the button.
const SHELLS = new Set(PLATFORM === "win32" ? ["powershell", "pwsh", "ps1", "ps"] : ["bash", "sh", "shell", "zsh", "console"]);

export function isShell(lang: string | undefined) {
	return SHELLS.has(String(lang || "").trim().split(/\s+/)[0].toLowerCase());
}

export function Markdown(props: MarkdownProps) {
	const stashed = stashMath(props.text);
	let tokens: Token[];
	try {
		tokens = lexer(stashed.text, { gfm: true, breaks: true });
	} catch {
		return <div className="md"><p>{props.text}</p></div>;
	}
	return <div className="md">{blocks(tokens, props, stashed.math, "b")}</div>;
}

function blocks(tokens: Token[], props: MarkdownProps, math: StashedMath[], prefix: string): ReactNode[] {
	return tokens.map((token, index) => block(token, props, math, `${prefix}${index}`));
}

function codeBlock(code: { lang?: string; text: string }, props: Pick<MarkdownProps, "onCopy" | "onRun">, key: string) {
	const lang = (code.lang || "").trim();
	return (
		<div className="md-code" key={key}>
			<div className="md-code-hd">
				<span>{lang || "text"}</span>
				<span className="spacer" />
				{props.onCopy && <button type="button" className="texty" onClick={() => props.onCopy?.(code.text)}>Copy</button>}
				{props.onRun && isShell(lang) && <button type="button" className="texty" onClick={() => props.onRun?.(code.text)}>Run</button>}
			</div>
			<pre><code>{code.text}</code></pre>
		</div>
	);
}

export function MermaidDiagram({ text, raw, onCopy }: { text: string; raw: string; onCopy?: (code: string) => void }) {
	const closed = fenceClosed(raw);
	const [theme, setTheme] = useState(diagramTheme);
	const [showCode, setShowCode] = useState(false);
	const [result, setResult] = useState<DiagramResult | null>(null);
	useEffect(() => {
		const update = () => setTheme(diagramTheme());
		update();
		const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
		media?.addEventListener?.("change", update);
		let observer: MutationObserver | undefined;
		if (typeof MutationObserver === "function" && document.documentElement) {
			observer = new MutationObserver(update);
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		}
		return () => {
			media?.removeEventListener?.("change", update);
			observer?.disconnect();
		};
	}, []);
	useEffect(() => {
		if (!closed) { return; }
		let live = true;
		void drawDiagram(text, theme).then((next) => { if (live) { setResult(next); } });
		return () => { live = false; };
	}, [closed, text, theme]);
	if (!closed) { return codeBlock({ lang: "mermaid", text }, { onCopy }, "open"); }
	const svg = result !== null && result.ok ? result.svg : "";
	return (
		<div className="md-code md-diagram">
			<div className="md-code-hd">
				<span>mermaid</span>
				<span className="spacer" />
				{svg !== "" && <button type="button" className="texty" onClick={() => setShowCode((value) => !value)}>{showCode ? "Diagram" : "Code"}</button>}
				{onCopy && <button type="button" className="texty" onClick={() => onCopy(text)}>Copy</button>}
			</div>
			{result?.ok === false && <p className="note">This diagram could not be drawn.</p>}
			{svg !== "" && !showCode ? <div className="md-diagram-body" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre><code>{text}</code></pre>}
		</div>
	);
}

function block(token: Token, props: MarkdownProps, math: StashedMath[], key: string): ReactNode {
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "paragraph":
			return <p key={key}>{inline((token as Tokens.Paragraph).tokens, props, math, key)}</p>;
		case "heading": {
			const heading = token as Tokens.Heading;
			return createElement(`h${Math.min(Math.max(heading.depth, 1), 6)}`, { key }, inline(heading.tokens, props, math, key));
		}
		case "code": {
			const code = token as Tokens.Code;
			if (isMermaid(code.lang)) { return <MermaidDiagram key={key} text={code.text} raw={code.raw} onCopy={props.onCopy} />; }
			return codeBlock(code, props, key);
		}
		case "blockquote":
			return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, props, math, key)}</blockquote>;
		case "list": {
			const list = token as Tokens.List;
			const items = list.items.map((item, index) => (
				<li key={`${key}-${index}`} className={item.task ? "md-task" : undefined}>
					{item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled aria-label={item.checked ? "Done" : "Not done"} />}
					{blocks(item.tokens, props, math, `${key}-${index}-`)}
				</li>
			));
			return list.ordered ? <ol key={key} start={typeof list.start === "number" ? list.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>;
		}
		case "table": {
			const table = token as Tokens.Table;
			return (
				<div className="md-table" key={key}>
					<table>
						<thead><tr>{table.header.map((cell, index) => <th key={index} style={cell.align ? { textAlign: cell.align } : undefined}>{inline(cell.tokens, props, math, `${key}h${index}`)}</th>)}</tr></thead>
						<tbody>
							{table.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={cell.align ? { textAlign: cell.align } : undefined}>{inline(cell.tokens, props, math, `${key}r${rowIndex}c${index}`)}</td>)}</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
		case "hr":
			return <hr key={key} />;
		case "text": {
			const text = token as Tokens.Text;
			return <span key={key}>{text.tokens ? inline(text.tokens, props, math, key) : plain(text.text, props, math, key)}</span>;
		}
		case "html":
			return <p key={key}>{plain((token as Tokens.HTML).raw, props, math, key)}</p>;
		default:
			return "raw" in token && typeof token.raw === "string" ? <p key={key}>{plain(token.raw, props, math, key)}</p> : null;
	}
}

function plain(text: string, props: MarkdownProps, math: StashedMath[], key: string): ReactNode {
	if (!text.includes(MATH_MARK)) { return props.renderText ? props.renderText(text, key) : text; }
	const pieces = text.split(new RegExp(`${MATH_MARK}(\\d+)${MATH_MARK}`));
	return pieces.map((piece, index) => {
		if (index % 2 === 1) {
			const item = math[Number(piece)];
			if (!item) { return piece; }
			return <span key={`${key}m${index}`} className={item.display ? "md-math md-math-display" : "md-math"} dangerouslySetInnerHTML={{ __html: mathHtml(item.tex, item.display) }} />;
		}
		if (piece === "") { return null; }
		return <span key={`${key}t${index}`}>{props.renderText ? props.renderText(piece, `${key}t${index}`) : piece}</span>;
	});
}

function inline(tokens: Token[] | undefined, props: MarkdownProps, math: StashedMath[], prefix: string): ReactNode[] {
	return (tokens ?? []).map((token, index) => {
		const key = `${prefix}.${index}`;
		switch (token.type) {
			case "text": {
				const text = token as Tokens.Text;
				return text.tokens ? <span key={key}>{inline(text.tokens, props, math, key)}</span> : <span key={key}>{plain(text.text, props, math, key)}</span>;
			}
			case "escape":
				return <span key={key}>{(token as Tokens.Escape).text}</span>;
			case "strong":
				return <strong key={key}>{inline((token as Tokens.Strong).tokens, props, math, key)}</strong>;
			case "em":
				return <em key={key}>{inline((token as Tokens.Em).tokens, props, math, key)}</em>;
			case "del":
				return <del key={key}>{inline((token as Tokens.Del).tokens, props, math, key)}</del>;
			case "codespan": {
				const code = (token as Tokens.Codespan).text;
				return props.renderCode?.(code, key) ?? <code key={key}>{code}</code>;
			}
			case "br":
				return <br key={key} />;
			case "link": {
				const link = token as Tokens.Link;
				return (
					<a key={key} href={link.href} title={link.href} onClick={(event) => { event.preventDefault(); props.onLink?.(link.href, event); }}>
						{inline(link.tokens, props, math, key)}
					</a>
				);
			}
			case "image": {
				const image = token as Tokens.Image;
				return <a key={key} href={image.href} title={image.href} onClick={(event) => { event.preventDefault(); props.onLink?.(image.href, event); }}>{`[image: ${image.text || image.href}]`}</a>;
			}
			case "html":
				return <span key={key}>{(token as Tokens.HTML).raw}</span>;
			default:
				return "raw" in token && typeof token.raw === "string" ? <span key={key}>{token.raw}</span> : null;
		}
	});
}
