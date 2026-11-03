import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PLATFORM } from "./data";

export interface TerminalTab { id: string; title: string; cwd: string; running: boolean; output: string }

export interface TerminalPaneProps {
	tabs: TerminalTab[];
	activeId: string;
	error?: string;
	onActivate: (id: string) => void;
	onNew: () => void;
	onCloseTab: (id: string) => void;
	onInput: (id: string, text: string) => void;
	onInterrupt: (tabId: string) => void;
	onClose: () => void;
}

interface LineState { history: string[]; index: number; draft: string; saved?: string }

const FRESH_LINE: LineState = { history: [], index: 0, draft: "" };

// OSC (window title, ended by BEL or ST), CSI (colors, erase, cursor modes), charset picks, then any other two-byte escape.
const ANSI = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[()#][0-9A-Za-z]|\x1b[@-Z\\-_=>78]?/g;

export function stripAnsi(text: string): string {
	return text
		.replace(ANSI, "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			// A trailing \r only parks the cursor, so "50%\r" still shows "50%" until the next write lands.
			const kept = line.replace(/\r+$/, "");
			return kept.slice(kept.lastIndexOf("\r") + 1);
		})
		.join("\n");
}

export function historyStep(history: string[], index: number, direction: -1 | 1): { index: number; value: string } {
	const next = Math.min(history.length, Math.max(0, index + direction));
	return { index: next, value: next === history.length ? "" : history[next] };
}

export function TerminalPane({ tabs, activeId, error, onActivate, onNew, onCloseTab, onInput, onInterrupt, onClose }: TerminalPaneProps) {
	const [lines, setLines] = useState<Record<string, LineState>>({});
	const outRef = useRef<HTMLPreElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const stick = useRef(true);
	const shownId = useRef(activeId);
	const active = tabs.find((tab) => tab.id === activeId);
	const output = active?.output ?? "";
	// ponytail: re-strips the whole buffer per chunk; cap output in the orchestrator if it grows past a few MB.
	const text = useMemo(() => stripAnsi(output), [output]);
	const line = lines[activeId] ?? FRESH_LINE;

	useLayoutEffect(() => {
		if (shownId.current !== activeId) {
			shownId.current = activeId;
			stick.current = true;
			inputRef.current?.focus();
		}
	}, [activeId]);

	useLayoutEffect(() => {
		const out = outRef.current;
		if (out && stick.current) {
			out.scrollTop = out.scrollHeight;
		}
	}, [text, activeId]);

	function setLine(next: LineState) {
		setLines((current) => ({ ...current, [activeId]: next }));
	}

	return (
		<section className="pane tp-pane" aria-label="Terminal">
			<div className="pane-hd">
				<b>Terminal</b>
				<div className="tp-tabs">
					{tabs.map((tab) => (
						<div className={tab.id === activeId ? "tp-tab on" : "tp-tab"} key={tab.id}>
							<button
								className="tp-tab-name"
								title={tab.cwd}
								aria-current={tab.id === activeId ? "true" : undefined}
								onClick={() => onActivate(tab.id)}
							>
								{tab.running && <span className="tp-dot" role="img" aria-label="Running" />}
								{tab.title}
							</button>
							<button className="tp-tab-x" aria-label="Close terminal tab" onClick={() => onCloseTab(tab.id)}>×</button>
						</div>
					))}
				</div>
				<button className="tp-new" aria-label="New terminal tab" onClick={onNew}>+</button>
				<span className="spacer" />
				{active?.running && <button className="texty" title="Stop the running command (Ctrl+C). The terminal stays open." onClick={() => onInterrupt(active.id)}>Stop</button>}
				<button className="pane-x" aria-label="Close pane" onClick={onClose}>×</button>
			</div>
			{!active && (
				<div className="pane-bd">
					<p className="note">No terminal open.</p>
					<button className="texty" onClick={onNew}>New terminal</button>
					{error && <p className="note">{error}</p>}
				</div>
			)}
			{active && (
				<>
					<pre
						className="tp-out"
						ref={outRef}
						onScroll={(event) => {
							const out = event.currentTarget;
							stick.current = out.scrollHeight - out.scrollTop - out.clientHeight <= 48;
						}}
					>
						{text}
					</pre>
					{(error || !active.running) && (
						<div className="tp-notes">
							{error && <p className="note">{error}</p>}
							{!active.running && <p className="note">This terminal has exited.</p>}
						</div>
					)}
					<form
						className="tp-row"
						onSubmit={(event) => {
							event.preventDefault();
							if (!active.running) {
								return;
							}
							const command = line.draft;
							const last = line.history[line.history.length - 1];
							const history = command.trim() && command !== last ? [...line.history, command] : line.history;
							setLine({ history, index: history.length, draft: "" });
							onInput(active.id, command);
						}}
					>
						<input
							ref={inputRef}
							aria-label="Terminal input"
							placeholder={PLATFORM === "win32" ? `PS ${active.cwd}>` : `${active.cwd} $`}
							value={line.draft}
							disabled={!active.running}
							spellCheck={false}
							autoComplete="off"
							onChange={(event) => setLine({ ...line, draft: event.target.value })}
							onKeyDown={(event) => {
								// Ctrl+C with no selection stops the running command; with a selection it copies as usual.
								if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c" && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
									event.preventDefault();
									onInterrupt(active.id);
									return;
								}
								if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
									return;
								}
								event.preventDefault();
								const step = historyStep(line.history, line.index, event.key === "ArrowUp" ? -1 : 1);
								if (step.index === line.index) { return; }
								// The unsent line is kept while browsing history and comes back below the newest entry.
								const saved = line.index === line.history.length ? line.draft : (line.saved ?? "");
								setLine({ history: line.history, index: step.index, draft: step.index === line.history.length ? saved : step.value, saved });
							}}
						/>
					</form>
				</>
			)}
		</section>
	);
}
