import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Markdown } from "./Markdown";
import { type NumberedLine } from "./DiffPane";
import { imageSrc, type ChatMessage, type Session, type ToolCard, type ToolDiff, type TranscriptView } from "./types";

export interface FolderFiles {
  status: "loading" | "ready" | "error";
  error?: string;
  files: string[];
  truncated?: boolean;
}

export interface OpenFile {
  status: "loading" | "ready" | "error";
  error?: string;
  text?: string;
  binary?: boolean;
	version?: string;
}

export interface EditorDraft {
	text: string;
	baseText: string;
	version: string;
	note?: string;
	saving?: boolean;
	recoveryTexts?: string[];
}

export interface BackgroundTask {
	id: string;
	label: string;
	detail: string;
	running: boolean;
	tooltip?: string;
	onStop?: () => void;
	onOpen?: () => void;
	info?: { kind: "command"; command: string; outputFile: string; exitCode: number | null; startedAt: number; endedAt: number; status: string } | { kind: "agent"; subagent: GrokSubagent };
}

export interface PaneModel {
  session: Session;
  messages: ChatMessage[];
	view: TranscriptView;
	findTick: number;
	// Opens Find with this text at its first match; the main chat gets it when a sidebar search matched message text.
	findAt?: { tick: number; text: string };
	todos: GrokTodo[];
	plan: string;
	tasks: BackgroundTask[];
	taskOutput: NonNullable<GrokCodeApi["taskOutput"]>;
	subagentTranscript: NonNullable<GrokCodeApi["subagentTranscript"]>;
	busy: boolean;
	decide: (toolId: string, decision: "allow" | "deny" | "always") => void;
	answerQuestion: (toolId: string, answers: Record<string, string> | null) => Promise<GrokSendResult>;
	answerPlan: (toolId: string, choice: { outcome: "approved" | "feedback" | "abandoned"; feedback?: string; mode?: "Normal" | "Auto-review" | "Always-approve" }) => Promise<GrokSendResult>;
	resumeMode: "Normal" | "Auto-review" | "Always-approve";
  folderFiles: FolderFiles | undefined;
	openFile: (file: string, line?: number) => void;
	fileMenu: (file: string, event: MouseEvent) => void;
	openLink: (href: string, event: MouseEvent) => void;
	copyText: (text: string) => void;
	quote: (text: string) => void;
	rewind: (message: ChatMessage) => void;
	fork: (message: ChatMessage) => void;
	openImage: (file: string) => void;
	runInTerminal: (code: string) => void;
	closePane: (id: "plan" | "tasks") => void;
}

interface FileHit {
  file: string;
  range: { start: number; end: number } | null;
	occurrences: { start: number; end: number }[];
}

function escapeReg(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineRange(detail: string) {
  const match = /(\d+)\s*[–-]\s*(\d+)/.exec(detail);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!start || !end || end < start || end - start > 80) return null;
  return { start, end };
}

// Built once per file list; the list keeps its identity until its contents change.
const knownIndexes = new WeakMap<string[], { byLower: Map<string, string>; names: { file: string; base: string }[] }>();

function knownIndex(known: string[]) {
	let index = knownIndexes.get(known);
	if (!index) {
		const byLower = new Map<string, string>();
		const names = known.map((file) => {
			const lower = file.toLowerCase();
			if (!byLower.has(lower)) { byLower.set(lower, file); }
			return { file, base: lower.slice(lower.lastIndexOf("/") + 1) };
		});
		index = { byLower, names };
		knownIndexes.set(known, index);
	}
	return index;
}

function toRelative(raw: string, folder: string, known: string[]) {
  let text = raw.trim().replace(/^[@`]+|[`]+$/g, "").replace(/^"+|"+$/g, "");
	if (!text || text.length > 300 || /[\0\r\n]/.test(text)) { return ""; }
  const folderKey = folder.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  let slash = text.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (/^[a-z]:/i.test(slash) || slash.startsWith("/")) {
    if (!slash.toLowerCase().startsWith(`${folderKey}/`)) return "";
    slash = slash.slice(folderKey.length + 1);
  }
  if (!slash || slash.split("/").some((part) => part === ".." || part === ".")) return "";
  const knownHit = knownIndex(known).byLower.get(slash.toLowerCase());
  if (knownHit) return knownHit;
	if (/\s/.test(slash)) { return ""; }
	if (/^[\w.@][\w.@/-]*\.[A-Za-z0-9]{1,8}$/.test(slash) && (slash.includes("/") || /\.(?:[cm]?[jt]sx?|json|md|txt|css|s[ac]ss|html?|xml|ya?ml|toml|ini|sql|asp|inc|vbs|asa|py|rb|go|rs|[ch]|cpp|hpp|sh|ps1|png|jpe?g|gif|svg|webp)$/i.test(slash))) { return slash; }
  return "";
}

export function mentionedFiles(text: string, tools: ToolCard[] | undefined, folder: string, known: string[]): FileHit[] {
	const found = new Map<string, FileHit>();
	const index = knownIndex(known);
	const lowerText = text.toLowerCase();
	function add(raw: string, range: { start: number; end: number } | null, occurrence?: { start: number; end: number }) {
    const file = toRelative(raw, folder, known);
		if (!file) { return; }
		let hit = found.get(file);
		if (!hit) { hit = { file, range, occurrences: [] }; found.set(file, hit); }
		if (occurrence) { hit.occurrences.push(occurrence); }
  }
  for (const tool of tools ?? []) {
    const range = lineRange(tool.detail);
    add(tool.title, range);
    if (tool.summary && tool.summary !== tool.title) add(tool.summary, null);
  }
	const spans: { start: number; end: number }[] = [];
	const partialPathAt = (index: number) => /[^\s]+\/[^.\s]*\s+$/.test(text.slice(0, index).replace(/\\/g, "/"));
	const files = [...index.names.filter(({ base }) => lowerText.includes(base)).map(({ file }) => file), ...[...found.keys()].filter((file) => !index.byLower.has(file.toLowerCase()))];
	for (const file of [...new Set(files)].sort((left, right) => right.length - left.length)) {
		const root = folder.replace(/\\/g, "/").replace(/\/+$/, "");
		const candidates = [`${root}/${file}`, `${root}/${file}`.replace(/\//g, "\\"), file];
		const pattern = new RegExp(`(?:^|[^\\w./\\\\:-])(${candidates.map(escapeReg).join("|")})(?=$|[^\\w./\\\\-])`, "gi");
		for (const match of text.matchAll(pattern)) {
			const start = (match.index ?? 0) + match[0].length - match[1].length;
			if (spans.some((span) => start >= span.start && start < span.end) || (!file.includes("/") && partialPathAt(start))) { continue; }
			const span = { start, end: start + match[1].length };
			spans.push(span);
			add(file, null, span);
		}
	}
	// Windows paths count too: `src\foo.ts`, `.\src\foo.ts` and `C:\...\foo.ts`.
	for (const match of text.matchAll(/[@`]?(?:[A-Za-z]:)?[\w.@/\\-]+\.[A-Za-z0-9]{1,8}/g)) {
		const start = match.index ?? 0;
		if (spans.some((span) => start >= span.start && start < span.end) || (!/[\\/]/.test(match[0]) && partialPathAt(start))) { continue; }
		const prefix = match[0].match(/^[@`]+/)?.[0].length ?? 0;
		add(match[0], null, { start: start + prefix, end: start + match[0].length });
	}
	return [...found.values()];
}

function FileButton({ file, label, line, onOpen, onMenu }: { file: string; label?: string; line?: number; onOpen: (file: string, line?: number) => void; onMenu: (file: string, event: MouseEvent) => void }) {
  return (
    <button
      type="button"
      className="file-link"
			title={line ? `${file}:${line}` : file}
			onClick={() => onOpen(file, line)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(file, event);
      }}
    >
			{label ?? file}
    </button>
  );
}

// Turns file paths inside one run of text into buttons; a ":12" suffix opens that line.
function linkedText(text: string, hits: FileHit[], onOpen: (file: string, line?: number) => void, onMenu: (file: string, event: MouseEvent) => void, keyPrefix: string): ReactNode {
	const occurrences = hits.flatMap((hit) => hit.occurrences.map((span) => ({ ...span, file: hit.file }))).sort((left, right) => left.start - right.start || right.end - left.end);
	if (!text || occurrences.length === 0) { return text; }
  const parts: ReactNode[] = [];
  let cursor = 0;
	for (const occurrence of occurrences) {
		if (occurrence.start < cursor) { continue; }
		if (occurrence.start > cursor) { parts.push(text.slice(cursor, occurrence.start)); }
		const suffix = /^:(\d{1,7})/.exec(text.slice(occurrence.end));
		const end = occurrence.end + (suffix ? suffix[0].length : 0);
		parts.push(<FileButton key={`${keyPrefix}-${occurrence.file}-${occurrence.start}`} file={occurrence.file} label={text.slice(occurrence.start, end)} line={suffix ? Number(suffix[1]) : undefined} onOpen={onOpen} onMenu={onMenu} />);
		cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

const TOOL_LABELS: Record<string, string> = {
	execute: "Run Command",
	command: "Run Command",
	read: "Read",
	edit: "Edit",
	search: "Search",
	fetch: "Fetch",
	network: "Fetch",
	question: "Question",
	plan: "Plan",
	todos: "Update tasks",
};

const TOOL_GLYPHS: Record<string, string> = {
	execute: "$",
	command: "$",
	read: "≡",
	edit: "✎",
	search: "⌕",
	fetch: "↓",
	network: "↓",
	question: "?",
	plan: "☰",
	todos: "☑",
};

function shownPath(target: string, folder: string) {
	const full = target.replace(/\\/g, "/");
	const root = folder.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!root || full.slice(0, root.length).toLowerCase() !== root.toLowerCase() || (full.length > root.length && full[root.length] !== "/")) { return target; }
	return full.slice(root.length + 1).replace(/^\/+/, "") || ".";
}

function plainTitle(title: string) {
	return title.replace(/`[\s\S]*`/, "").replace(/`[\s\S]*$/, "").replace(/\s+/g, " ").trim();
}

export function editRows(diff: ToolDiff): NumberedLine[] {
	const lines = (text: string) => {
		const trimmed = text.replace(/\n$/, "");
		return trimmed ? trimmed.split("\n") : [];
	};
	const before = lines(diff.oldText);
	const after = lines(diff.newText);
	const shared = Math.min(before.length, after.length);
	let head = 0;
	while (head < shared && before[head] === after[head]) { head++; }
	let tail = 0;
	while (tail < shared - head && before[before.length - tail - 1] === after[after.length - tail - 1]) { tail++; }
	const rows: NumberedLine[] = [];
	const oldNumber = (index: number) => diff.oldLine === undefined ? {} : { oldLine: diff.oldLine + index };
	const newNumber = (index: number) => diff.newLine === undefined ? {} : { newLine: diff.newLine + index };
	for (let index = head - Math.min(head, 3); index < head; index++) {
		rows.push({ kind: "context", text: before[index], ...oldNumber(index), ...newNumber(index) });
	}
	for (let index = head; index < before.length - tail; index++) {
		rows.push({ kind: "del", text: before[index], ...oldNumber(index) });
	}
	for (let index = head; index < after.length - tail; index++) {
		rows.push({ kind: "add", text: after[index], ...newNumber(index) });
	}
	for (let index = 0; index < Math.min(tail, 3); index++) {
		const oldIndex = before.length - tail + index;
		const newIndex = after.length - tail + index;
		rows.push({ kind: "context", text: before[oldIndex], ...oldNumber(oldIndex), ...newNumber(newIndex) });
	}
	return rows;
}

export function EditDiff({ diff, all = false }: { diff: ToolDiff; all?: boolean }) {
	const rows = editRows(diff);
	return (
		<>
			{diff.whole && <p className="note">Writes the whole file. If the file exists, all of its current text is replaced.</p>}
			{diff.replaceAll && <p className="note">Replaces every match in the file, not only this one.</p>}
			{rows.length > 0 && (
				<div className="edit-diff">
					{(all ? rows : rows.slice(0, 200)).map((row, index) => (
						<div className={`dp-line dp-${row.kind}`} key={index}>
							<span className="dp-num">{row.oldLine ?? ""}</span>
							<span className="dp-num">{row.newLine ?? ""}</span>
							<span className="dp-text">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}{row.text}</span>
						</div>
					))}
				</div>
			)}
			{!all && rows.length > 200 && <p className="note">{rows.length - 200} more lines not shown.</p>}
			{diff.clipped && <p className="note">Grok's edit was longer; this shows the start.</p>}
		</>
	);
}

export function ToolRow({ tool, m }: { tool: ToolCard; m: PaneModel }) {
	const [open, setOpen] = useState(m.view === "verbose");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [picks, setPicks] = useState<Record<number, { picked: string[]; other: string; typed: boolean }>>({});
	const [feedback, setFeedback] = useState<string | null>(null);
	useEffect(() => { setOpen(m.view === "verbose"); }, [m.view]);
	const questions = tool.questions;
	const plan = questions === undefined ? tool.plan : undefined;
	const kind = questions !== undefined ? "question" : plan !== undefined ? "plan" : tool.todos ? "todos" : tool.kind.toLowerCase();
	const label = (kind === "todos" ? TOOL_LABELS.todos : tool.label) || TOOL_LABELS[kind] || "Tool";
	const found = kind === "todos" ? `${tool.todos?.filter((item) => item.status === "completed").length ?? 0} of ${tool.todos?.length ?? 0} done` : tool.description || (tool.path ? shownPath(tool.path, m.session.folder) : "") || plainTitle(tool.title);
	const text = found.toLowerCase() === label.toLowerCase() ? "" : found;
	const waiting = tool.waiting === true;
	const toolId = waiting ? tool.id : undefined;
	const command = tool.command || (tool.path ? undefined : tool.summary);
	const expandable = !!(questions?.length || plan || command || tool.output || tool.path || tool.diff);
	const failed = /^(Failed|Denied|Not run)/.test(tool.detail);
	const diffCounts = useMemo(() => {
		if (!tool.diff || tool.diff.clipped || failed) { return undefined; }
		const rows = editRows(tool.diff);
		return { additions: rows.filter((row) => row.kind === "add").length, deletions: rows.filter((row) => row.kind === "del").length };
	}, [tool.diff, failed]);
	const additions = diffCounts?.additions ?? tool.additions;
	const deletions = diffCounts?.deletions ?? tool.deletions;
	const tone = waiting ? " wait" : failed ? " bad" : "";
	const questionTexts = questions?.map((item, index) => <div className="tool-question" key={index}>{item.header && <span className="chip-tag">{item.header}</span>}{item.question}</div>);
	function answerOf(item: GrokQuestion, index: number) {
		const state = picks[index];
		if (!state) { return ""; }
		return state.typed ? state.other.trim() : item.options.filter((option) => state.picked.includes(option.label)).map((option) => option.label).join(", ");
	}
	function choose(index: number, multi: boolean, value: string) {
		setPicks((current) => {
			const picked = current[index]?.typed ? [] : current[index]?.picked ?? [];
			const next = !multi ? [value] : picked.includes(value) ? picked.filter((item) => item !== value) : [...picked, value];
			return { ...current, [index]: { picked: next, other: current[index]?.other ?? "", typed: false } };
		});
	}
	function run(call: Promise<GrokSendResult>) {
		setBusy(true);
		setError("");
		void call.then((result) => {
			if (result.ok || result.closed) { return; }
			setError(result.error || "Grok did not accept that answer.");
			setBusy(false);
		});
	}
	let body: ReactNode = null;
	if (waiting && questions !== undefined) {
		body = toolId ? (
			<>
				{questions.map((item, index) => (
					<div className="tool-question" key={index}>
						<div>{item.header && <span className="chip-tag">{item.header}</span>}{item.question}</div>
						<div className="tool-choices">
							{item.options.map((option, optionIndex) => {
								const on = !picks[index]?.typed && !!picks[index]?.picked.includes(option.label);
								return (
									<button type="button" key={optionIndex} className={on ? "on" : undefined} aria-pressed={on} disabled={busy} onClick={() => choose(index, item.multiSelect, option.label)}>
										<span>{optionIndex < 9 && <kbd className="opt-key">{optionIndex + 1}</kbd>}{option.label}</span>
										{option.description && <small>{option.description}</small>}
									</button>
								);
							})}
						</div>
						<input
							className={picks[index]?.typed ? "tool-other on" : "tool-other"}
							aria-label={`Other answer: ${item.question}`}
							placeholder="Other"
							maxLength={4000}
							value={picks[index]?.other ?? ""}
							onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); } }}
							onChange={(event) => {
								const value = event.target.value;
								setPicks((current) => ({ ...current, [index]: { picked: [], other: value, typed: true } }));
							}}
						/>
					</div>
				))}
				<div className="actions">
					<button type="button" disabled={busy} onClick={() => run(m.answerQuestion(toolId, null))}>Skip</button>
					<button
						type="button"
						className="yes"
						disabled={busy || !questions.every((item, index) => answerOf(item, index) !== "")}
						onClick={() => run(m.answerQuestion(toolId, Object.fromEntries(questions.map((item, index) => [item.question, answerOf(item, index)]))))}
					>
						Submit
					</button>
				</div>
			</>
		) : questionTexts;
	} else if (waiting && plan !== undefined) {
		body = (
			<>
				{plan ? <div className="tool-plan"><Markdown text={plan} onLink={m.openLink} onCopy={m.copyText} /></div> : <p className="note">Grok sent no plan text.</p>}
				{toolId && (
					<>
						<div className="actions">
							<button type="button" className="yes" disabled={busy} onClick={() => run(m.answerPlan(toolId, { outcome: "approved", mode: m.resumeMode }))}>Approve</button>
							<button type="button" disabled={busy} aria-expanded={feedback !== null} onClick={() => setFeedback((value) => (value === null ? "" : null))}>Keep planning</button>
							<button type="button" disabled={busy} onClick={() => run(m.answerPlan(toolId, { outcome: "abandoned", mode: m.resumeMode }))}>Abandon</button>
						</div>
						<p className="note">Approve or Abandon switches this session to {m.resumeMode}.</p>
						{feedback !== null && (
							<div className="tool-feedback">
								<textarea aria-label="What should change in the plan" rows={3} maxLength={8000} value={feedback} onChange={(event) => setFeedback(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); } }} />
								<div className="actions">
									<button type="button" disabled={busy || !feedback.trim()} onClick={() => run(m.answerPlan(toolId, { outcome: "feedback", feedback }))}>Send</button>
								</div>
							</div>
						)}
					</>
				)}
			</>
		);
	} else if (waiting) {
		const approval = tool.command || tool.input || tool.path || tool.summary;
		body = (
			<>
				{tool.diff ? (
					<>
						<div className="tool-path">{tool.path ?? tool.summary}</div>
						{tool.diff.clipped ? (
							<>
								{tool.diff.whole && <p className="note">Writes the whole file. If the file exists, all of its current text is replaced.</p>}
								{tool.diff.replaceAll && <p className="note">Replaces every match in the file, not only this one.</p>}
								{approval && <pre className="tool-code">{approval}</pre>}
							</>
						) : <EditDiff diff={tool.diff} all />}
					</>
				) : approval && <pre className="tool-code">{approval}</pre>}
				{toolId && (
					<div className="actions">
						<button type="button" onClick={() => m.decide(toolId, "deny")}>Deny</button>
						{!toolId.startsWith("native-permission:") && tool.always && <button type="button" title={tool.always === "folder" ? "Allow this exact command in this folder from now on, in every session. Settings lists the commands you allowed." : "Allow this tool for the rest of this conversation"} onClick={() => m.decide(toolId, "always")}>{tool.always === "folder" ? "Always allow in this folder" : "Allow for this conversation"}</button>}
						<button type="button" className="yes" onClick={() => m.decide(toolId, "allow")}>Allow</button>
					</div>
				)}
			</>
		);
	} else if (open && expandable) {
		body = (
			<>
				{questionTexts}
				{plan && <div className="tool-plan"><Markdown text={plan} onLink={m.openLink} onCopy={m.copyText} /></div>}
				{command && <pre className="tool-code">{command}</pre>}
				{tool.output && <pre className="tool-code">{tool.output}</pre>}
				{tool.path && <div className="tool-path">{tool.path}</div>}
				{tool.diff && !failed && <EditDiff diff={tool.diff} />}
			</>
		);
	}
	const head = (
		<>
			<span className="tool-glyph" aria-hidden="true">{TOOL_GLYPHS[kind] ?? "•"}</span>
			<span className="tool-label">{label}</span>
			{text && <span className="tool-text" title={text}>{text}</span>}
			{(additions !== undefined || deletions !== undefined) && (
				<span className="tool-count"><span className="add">{`+${additions ?? 0}`}</span> <span className="del">{`−${deletions ?? 0}`}</span></span>
			)}
			<span className={`tool-status${tone}`}>{tool.detail}</span>
		</>
	);
	return (
		<div className={waiting ? "tool-row live" : "tool-row"}>
			{!waiting && expandable ? (
				<button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{head}</button>
			) : (
				<div className="tool-head">{head}</div>
			)}
			{body && (
				<div className="tool-body">
					{body}
					{waiting && error && <p className="tool-error">{error}</p>}
				</div>
			)}
		</div>
	);
}

function groupWords(tool: ToolCard): [string, string, string] {
	const kind = tool.kind.toLowerCase();
	if (/^list/i.test(tool.label ?? "")) { return ["Listed", "folder", "folders"]; }
	if (kind === "read") { return ["Read", "file", "files"]; }
	if (kind === "search") { return ["Searched", "time", "times"]; }
	if (kind === "edit" || kind === "delete" || kind === "move") { return ["Edited", "file", "files"]; }
	if (kind === "execute" || kind === "command") { return ["Ran", "command", "commands"]; }
	if (kind === "fetch" || kind === "network") { return ["Fetched", "page", "pages"]; }
	return ["Used", "tool", "tools"];
}

// One summary row for a run of tool calls, like "Read 5 files, searched 9 times"; it opens to the rows themselves.
export function ToolGroup({ tools, m }: { tools: ToolCard[]; m: PaneModel }) {
	const [open, setOpen] = useState(m.view === "verbose");
	useEffect(() => { setOpen(m.view === "verbose"); }, [m.view]);
	const counts = new Map<string, { words: [string, string, string]; count: number }>();
	for (const tool of tools) {
		const words = groupWords(tool);
		const entry = counts.get(words[0]) ?? { words, count: 0 };
		entry.count += 1;
		counts.set(words[0], entry);
	}
	const summary = [...counts.values()].map(({ words, count }, index) => `${index ? words[0].toLowerCase() : words[0]} ${count} ${count === 1 ? words[1] : words[2]}`).join(", ");
	const failed = tools.filter((tool) => /^(Failed|Denied)/.test(tool.detail)).length;
	return (
		<div className="tool-group">
			<button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span className="tool-glyph" aria-hidden="true">{open ? "▾" : "▸"}</span>
				<span className="tool-text">{summary}</span>
				{failed > 0 && <span className="tool-status bad">{failed} failed</span>}
			</button>
			{open && <div className="tool-group-body">{tools.map((tool, index) => <ToolRow key={tool.id ?? `${tool.title}-${index}`} tool={tool} m={m} />)}</div>}
		</div>
	);
}

function Thought({ text, view }: { text: string; view: TranscriptView }) {
	const [open, setOpen] = useState(true);
	if (view === "normal") { return null; }
	return (
		<div className="thought">
			<button type="button" className="thought-hd" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "▾" : "▸"} Thinking</button>
			{open && <div className="thought-bd">{text}</div>}
		</div>
	);
}

function MessageBody({ message, m, readOnly = false }: { message: ChatMessage; m: PaneModel; readOnly?: boolean }) {
	const known = m.folderFiles?.files;
	const hits = useMemo(() => readOnly ? [] : mentionedFiles(message.text, message.tools, m.session.folder, known ?? []), [readOnly, message.text, message.tools, m.session.folder, known]);
	const hitFiles = useMemo(() => hits.map((hit) => hit.file), [hits]);
	const renderText = (text: string, key: string) => (!readOnly && hitFiles.length ? linkedText(text, mentionedFiles(text, undefined, m.session.folder, hitFiles), m.openFile, m.fileMenu, key) : text);
	const renderCode = (code: string, key: string) => {
		if (readOnly) { return null; }
		const match = /^(.+?)(?::(\d{1,7}))?$/.exec(code.trim());
		const file = match ? toRelative(match[1], m.session.folder, hitFiles.length ? hitFiles : known ?? []) : "";
		if (!file || !(hitFiles.includes(file) || (known ?? []).includes(file))) { return null; }
		return <code key={key}><FileButton file={file} label={code} line={match?.[2] ? Number(match[2]) : undefined} onOpen={m.openFile} onMenu={m.fileMenu} /></code>;
	};
	const openLink = (href: string, event: MouseEvent) => {
		if (readOnly) {
			try {
				const url = new URL(href);
				if (url.protocol !== "http:" && url.protocol !== "https:") { return; }
			} catch { return; }
		}
		m.openLink(href, event);
	};
	const markdown = (text: string, key: string) => <Markdown key={key} text={text} renderText={renderText} renderCode={renderCode} onLink={openLink} onCopy={m.copyText} onRun={readOnly || message.streaming ? undefined : m.runInTerminal} />;
	if (message.role === "user") {
		const files = message.attachments ?? [];
		const others = files.filter((file) => !imageSrc(file));
		return (
			<>
				{files.filter((file) => imageSrc(file)).map((file) => (
					<button type="button" className="msg-image" key={file} title={file} aria-label={`View ${file.split(/[\\/]/).pop()}`} onClick={() => m.openImage(file)}>
						<img src={imageSrc(file)} alt={file.split(/[\\/]/).pop()} />
					</button>
				))}
				<div className="user-bubble">
					<div className="message-text">{message.text}</div>
					{!!others.length && (
						<div className="attach-list">
							{others.map((file) => <span className="attach-chip" key={file} title={file}>{file.split(/[\\/]/).pop()}</span>)}
						</div>
					)}
				</div>
			</>
		);
	}
	const tools = message.tools ?? [];
	const placed = new Set<string>();
	const ordered: ReactNode[] = [];
	// Tool calls with no text between them fold into one group; approvals, questions, plans and task lists stay out.
	let run: ToolCard[] = [];
	const flush = () => {
		if (run.length > 1) { ordered.push(<ToolGroup key={`g${run[0].id ?? ordered.length}`} tools={run} m={m} />); }
		if (run.length === 1) { ordered.push(<ToolRow key={run[0].id ?? `r${ordered.length}`} tool={run[0]} m={m} />); }
		run = [];
	};
	const addTool = (tool: ToolCard) => {
		if (tool.waiting || tool.questions !== undefined || tool.plan !== undefined || tool.todos) {
			flush();
			ordered.push(<ToolRow key={tool.id ?? `r${ordered.length}`} tool={tool} m={m} />);
			return;
		}
		run.push(tool);
	};
	if (message.parts?.length) {
		message.parts.forEach((part, index) => {
			if (part.kind === "text") {
				if (part.text.trim()) { flush(); ordered.push(markdown(part.text, `t${index}`)); }
				return;
			}
			if (part.kind === "steer") {
				flush();
				ordered.push(<div className="steer-note" key={`s${index}`}><small>You, while Grok worked</small><div className="message-text">{part.text}</div></div>);
				return;
			}
			const tool = tools.find((item) => item.id === part.id);
			if (tool) {
				placed.add(part.id);
				addTool(tool);
			}
		});
	} else if (message.text) {
		ordered.push(markdown(message.text, "text"));
	}
	tools.forEach((tool) => {
		if (!tool.id || !placed.has(tool.id)) { addTool(tool); }
	});
	flush();
  return (
    <>
			{message.thought && <Thought text={message.thought} view={m.view} />}
			{message.pending && !message.text && !tools.length ? <div className="working"><span className="spinner" aria-hidden="true" />Working…</div> : ordered}
			{message.streaming && !message.pending && <div className="working small"><span className="spinner" aria-hidden="true" /></div>}
    </>
  );
}

export function TaskList({ todos }: { todos: GrokTodo[] }) {
	const [open, setOpen] = useState(true);
	if (!todos.length) { return null; }
	const done = todos.filter((item) => item.status === "completed").length;
	return (
		<div className="task-list" aria-label="Task list">
			<button type="button" className="task-list-hd" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				{open ? "▾" : "▸"} Tasks <span className="meta">{done} of {todos.length}</span>
			</button>
			{open && (
				<ul>
					{todos.map((item, index) => (
						<li key={index} className={`task-item ${item.status}`}>
							<span className="task-mark" aria-hidden="true">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}</span>
							<span>{item.text}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function messageTime(message: ChatMessage) {
	if (message.pending || message.streaming) { return null; }
	const at = message.at ?? (message.role === "user" ? Number(/-(\d{13})$/.exec(message.id)?.[1] ?? NaN) : NaN);
	if (!Number.isFinite(at)) { return null; }
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) { return null; }
	return { at, full: fullTime.format(date) };
}

// Where each session was being read in this window; following the newest message needs no entry.
const readingAt = new Map<string, number>();

function Chat({ m }: { m: PaneModel }) {
  const scroller = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const [away, setAway] = useState(false);
	const sessionId = useRef("");
	const [find, setFind] = useState<string | null>(null);
	const [hit, setHit] = useState(0);
	const [hits, setHits] = useState(0);
	const [contentTick, setContentTick] = useState(0);
	const findBox = useRef<HTMLInputElement>(null);
	// true jumps on the next highlight pass; a string waits for the pass that searches that text.
	const jump = useRef<boolean | string>(false);
  const signature = m.messages.map((message) => {
		const tools = message.tools?.map((tool) => `${tool.id}:${tool.detail}:${tool.waiting}:${tool.output ?? ""}:${tool.diff ? 1 : 0}`).join(",") ?? "";
    return `${message.id}:${message.text}:${message.thought ?? ""}:${message.pending}:${tools}`;
  }).join("|");
  useEffect(() => {
    const node = scroller.current;
		if (sessionId.current !== m.session.id) {
			sessionId.current = m.session.id;
			const saved = readingAt.get(m.session.id);
			follow.current = saved === undefined;
			setAway(saved !== undefined);
			if (node && saved !== undefined) { node.scrollTop = saved; }
		}
		if (node && follow.current) { node.scrollTop = node.scrollHeight; }
	}, [signature, m.session.id, m.todos.length]);
	useEffect(() => {
		if (!m.findTick) { return; }
		setFind((current) => current ?? "");
		findBox.current?.focus();
		findBox.current?.select();
	}, [m.findTick]);
	useEffect(() => {
		if (!m.findAt?.tick) { return; }
		jump.current = m.findAt.text.toLowerCase();
		setHit(0);
		setFind(m.findAt.text);
	}, [m.findAt?.tick]);
	useEffect(() => () => {
		if (typeof CSS !== "undefined") {
			CSS.highlights?.delete("grok-find");
			CSS.highlights?.delete("grok-find-current");
		}
	}, []);
	useEffect(() => {
		const column = scroller.current?.querySelector(".chat-col");
		if (find === null || !column || typeof MutationObserver === "undefined") { return; }
		const observer = new MutationObserver(() => setContentTick((value) => value + 1));
		observer.observe(column, { childList: true, subtree: true, characterData: true });
		return () => observer.disconnect();
	}, [find !== null, m.session.id]);
	useEffect(() => {
		const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
		if (!registry) { return; }
		const needle = (find ?? "").toLowerCase();
		const column = scroller.current?.querySelector(".chat-col");
		const ranges: Range[] = [];
		if (needle && column) {
			const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.parentElement?.closest(".msg-foot") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
			// ponytail: cap highlights at 5000; type more to narrow a larger conversation.
			for (let node = walker.nextNode(); node && ranges.length < 5000; node = walker.nextNode()) {
				const length = node.nodeValue?.length ?? 0;
				const text = (node.nodeValue ?? "").toLowerCase();
				for (let at = text.indexOf(needle); at >= 0 && at < length && ranges.length < 5000; at = text.indexOf(needle, at + needle.length)) {
					const range = document.createRange();
					range.setStart(node, at);
					range.setEnd(node, Math.min(at + needle.length, length));
					ranges.push(range);
				}
			}
		}
		setHits(ranges.length);
		const current = ranges.length ? ranges[((hit % ranges.length) + ranges.length) % ranges.length] : undefined;
		if (ranges.length) { registry.set("grok-find", new Highlight(...ranges)); } else { registry.delete("grok-find"); }
		if (current) { registry.set("grok-find-current", new Highlight(current)); } else { registry.delete("grok-find-current"); }
		const wanted = jump.current === true || jump.current === needle;
		if (current && wanted) { current.startContainer.parentElement?.scrollIntoView({ block: "center" }); }
		if (wanted) { jump.current = false; }
	}, [find, hit, signature, m.session.id, m.view, contentTick]);
  return (
		<section className="chat" aria-label="Chat">
			{find !== null && (
				<div className="find-bar" role="search" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setFind(null); setHit(0); } }}>
					<input
						ref={findBox}
						autoFocus
						aria-label="Find in conversation"
						placeholder="Find in conversation"
						value={find}
						onChange={(event) => { jump.current = true; setHit(0); setFind(event.target.value); }}
						onKeyDown={(event) => {
							if (event.key === "Enter") { event.preventDefault(); jump.current = true; setHit((value) => value + (event.shiftKey ? -1 : 1)); }
						}}
					/>
					<span className="find-count">{hits ? `${(((hit % hits) + hits) % hits) + 1} of ${hits}` : find ? "No results" : ""}</span>
					<button type="button" className="texty" aria-label="Previous match" disabled={!hits} onClick={() => { jump.current = true; setHit((value) => value - 1); }}>↑</button>
					<button type="button" className="texty" aria-label="Next match" disabled={!hits} onClick={() => { jump.current = true; setHit((value) => value + 1); }}>↓</button>
					<button type="button" className="texty" aria-label="Close find" onClick={() => { setFind(null); setHit(0); }}>×</button>
				</div>
			)}
			<div className="chat-scroll" ref={scroller} onScroll={(event) => {
				if (sessionId.current !== m.session.id) { return; }
				const node = event.currentTarget;
				follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
				if (follow.current) { readingAt.delete(m.session.id); } else { readingAt.set(m.session.id, node.scrollTop); }
				setAway(!follow.current);
			}}>
				<div className="chat-col">
					{m.messages.length === 0 && <p className="chat-empty">What should Grok work on in {m.session.project}?</p>}
					{m.messages.map((message) => {
						const time = messageTime(message);
						return (
							<article className={message.role === "user" ? "msg user" : "msg grok"} key={message.id} tabIndex={time ? 0 : undefined}>
								<MessageBody message={message} m={m} />
								<div className="msg-foot">
									{time && <time className="msg-time" dateTime={new Date(time.at).toISOString()} title={time.full}>{time.full}</time>}
									{!message.pending && !message.streaming && message.text.trim() && (
										<span className="msg-actions">
											<button type="button" className="texty" onClick={() => m.copyText(message.text)}>Copy</button>
											<button type="button" className="texty" onClick={() => m.quote(message.text)}>Quote</button>
											{message.role === "user" && message.point && message.point.agentSessionId === m.session.agentSessionId && !m.busy && <>
												<button type="button" className="texty" onClick={() => m.rewind(message)}>Rewind</button>
												<button type="button" className="texty" onClick={() => m.fork(message)}>Fork</button>
											</>}
										</span>
									)}
								</div>
							</article>
						);
					})}
					<TaskList todos={m.todos} />
				</div>
      </div>
			{away && <button type="button" className="to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })}>↓</button>}
    </section>
  );
}

function PaneClose({ onClose }: { onClose: () => void }) {
	return <button type="button" className="pane-x" aria-label="Close pane" onClick={onClose}>×</button>;
}

function Plan({ m }: { m: PaneModel }) {
  return (
    <section className="pane" aria-label="Plan">
			<div className="pane-hd"><b>Plan</b><span className="spacer" /><PaneClose onClose={() => m.closePane("plan")} /></div>
      <div className="pane-bd">
				{!m.plan && !m.todos.length && <p className="note">Grok has not written a plan in this session yet.</p>}
				{m.plan && <Markdown text={m.plan} onLink={m.openLink} onCopy={m.copyText} />}
				<TaskList todos={m.todos} />
      </div>
    </section>
  );
}

function Tasks({ m }: { m: PaneModel }) {
	const [openId, setOpenId] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [output, setOutput] = useState<{ id: string; result?: Awaited<ReturnType<PaneModel["taskOutput"]>> }>({ id: "" });
	const [transcriptRequest, setTranscriptRequest] = useState({ id: "", version: 0 });
	const [transcript, setTranscript] = useState<{ id: string; result?: Awaited<ReturnType<PaneModel["subagentTranscript"]>> }>({ id: "" });
	const info = m.tasks.find((task) => task.id === openId)?.info;
	const command = info?.kind === "command" ? info : undefined;
	const childId = info?.kind === "agent" ? info.subagent.childSessionId : undefined;
	useEffect(() => {
		if (!command) { return; }
		let cancelled = false;
		setOutput({ id: openId });
		void m.taskOutput(command.outputFile).then((result) => { if (!cancelled) { setOutput({ id: openId, result }); } }).catch(() => {
			if (!cancelled) { setOutput({ id: openId, result: { ok: false, error: "Task output could not be read." } }); }
		});
		return () => { cancelled = true; };
	}, [openId, command?.outputFile, command?.status, refresh]);
	useEffect(() => {
		if (!childId || transcriptRequest.id !== openId) { return; }
		let cancelled = false;
		setTranscript({ id: openId });
		void m.subagentTranscript(childId).then((result) => { if (!cancelled) { setTranscript({ id: openId, result }); } }).catch(() => {
			if (!cancelled) { setTranscript({ id: openId, result: { ok: false, error: "This subagent's transcript could not be read." } }); }
		});
		return () => { cancelled = true; };
	}, [openId, childId, transcriptRequest]);
	const log = output.id === openId ? output.result : undefined;
	const conversation = transcript.id === openId ? transcript.result : undefined;
  return (
    <section className="pane" aria-label="Background tasks">
			<div className="pane-hd"><b>Background tasks</b><span className="spacer" /><PaneClose onClose={() => m.closePane("tasks")} /></div>
			<div className="pane-bd">
				{m.tasks.length === 0 && <p className="note">Nothing is running in the background.</p>}
				{m.tasks.map((task) => (
					<div key={task.id}>
						<div className="bg-task">
							<span className={task.running ? "dot run" : "dot"} aria-hidden="true" />
							<button type="button" className="bg-task-main" disabled={!task.onOpen && !task.info} aria-expanded={task.info ? openId === task.id : undefined} onClick={() => { if (task.onOpen) { task.onOpen(); } else if (task.info) { setOpenId((current) => current === task.id ? "" : task.id); } }} title={task.tooltip}>
								<b>{task.label}</b>
								{task.detail && <small>{task.detail}</small>}
							</button>
							{task.onStop && task.running && <button type="button" className="texty" onClick={task.onStop}>Stop</button>}
						</div>
					{openId === task.id && task.info?.kind === "command" && (
						<div className="task-details">
							<code className="task-command">{task.info.command}</code>
							<p className="meta">{task.info.status}{task.info.exitCode !== null ? ` · exit ${task.info.exitCode}` : ""}{task.info.startedAt ? ` · ${(Math.max(0, (task.info.endedAt || Date.now()) - task.info.startedAt) / 1000).toFixed(1)} s` : ""}</p>
							{!log && <p className="note">Loading output...</p>}
							{log && !log.ok && <p className="note">{log.error || "Task output is not available."}</p>}
							{log?.ok && <pre className="task-output">{log.text || "No output yet."}</pre>}
							{log?.truncated && <p className="note">Showing the last 200 KB.</p>}
							{task.running && <button type="button" className="texty" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>}
						</div>
					)}
					{openId === task.id && task.info?.kind === "agent" && (
						<div className="task-details">
							<p className="meta">{[task.info.subagent.agentType, task.info.subagent.model, task.info.subagent.status, task.info.subagent.durationMs != null ? `${(task.info.subagent.durationMs / 1000).toFixed(1)} s` : "", task.info.subagent.toolCalls != null ? `${task.info.subagent.toolCalls} tool calls` : "", task.info.subagent.tokensUsed != null ? `${task.info.subagent.tokensUsed} tokens` : ""].filter(Boolean).join(" · ")}</p>
							{task.info.subagent.output ? <MessageBody readOnly message={{ id: `subagent-result-${task.id}`, role: "grok", text: task.info.subagent.output }} m={m} /> : <p className="note">{task.running ? "Still working." : "No result was recorded."}</p>}
							{task.info.subagent.childSessionId && <button type="button" className="texty" onClick={() => setTranscriptRequest((current) => ({ id: task.id, version: current.version + 1 }))}>Show transcript</button>}
							{transcriptRequest.id === task.id && !conversation && <p className="note">Loading transcript...</p>}
							{transcriptRequest.id === task.id && conversation && !conversation.ok && <p className="note">{conversation.error || "The transcript is not available."}</p>}
							{conversation?.ok && <div className="task-transcript">{conversation.truncated && <p className="note">The start of this transcript was left out.</p>}{conversation.messages?.map((message) => <div className={`msg ${message.role}`} key={message.id}><MessageBody readOnly message={message} m={m} /></div>)}</div>}
						</div>
					)}
					</div>
				))}
      </div>
    </section>
  );
}

export function SideLog({ messages, model }: { messages: ChatMessage[]; model: PaneModel }) {
	const box = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	useEffect(() => {
		const node = box.current;
		if (node && follow.current) { node.scrollTop = node.scrollHeight; }
	});
  if (messages.length === 0) return null;
  return (
    <div className="side-log" ref={box} onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
			{messages.map((message) => {
				const time = messageTime(message);
				return (
					<div key={message.id} className={message.role === "user" ? "msg user" : "msg grok"} tabIndex={time ? 0 : undefined}>
						<MessageBody message={message} m={model} />
						{time && <time className="msg-time" dateTime={new Date(time.at).toISOString()} title={time.full}>{time.full}</time>}
					</div>
				);
			})}
    </div>
  );
}

export function PaneView({ id, model }: { id: "chat" | "plan" | "tasks"; model: PaneModel }) {
	if (id === "plan") { return <Plan m={model} />; }
	if (id === "tasks") { return <Tasks m={model} />; }
	return <Chat m={model} />;
}
