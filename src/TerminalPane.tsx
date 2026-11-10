import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { PLATFORM } from "./data";
import { Icon } from "./Icon";
import { PaneActions, type PaneLayoutControls } from "./PaneActions";

export interface TerminalTab { id: string; title: string; cwd: string; running: boolean; output: string; backend?: "pty" | "pipe"; received?: number }

export interface TerminalPaneProps {
	layout?: PaneLayoutControls;
	tabs: TerminalTab[];
	activeId: string;
	terminalScreenReader: boolean;
	error?: string;
	onActivate: (id: string) => void;
	onNew: () => void;
	onCloseTab: (id: string) => void;
	onInput: (id: string, text: string) => void;
	onResize: (id: string, cols: number, rows: number) => void;
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

export function terminalOptions(element: HTMLElement) {
	const style = window.getComputedStyle(element);
	const property = (name: string) => style.getPropertyValue(name).trim();
	const fontSize = parseFloat(property("--terminal-font-size")) || 13 * (parseFloat(property("--mono-scale")) || 1);
	const linePx = parseFloat(property("--terminal-line-height"));
	const fontFamily = property("--terminal-font") || property("--mono-font") || 'Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace';
	return { fontFamily, fontSize, lineHeight: linePx ? Math.max(1, linePx / fontSize) : 1.45 };
}

function terminalTheme(element: HTMLElement): ITheme {
	const style = window.getComputedStyle(element);
	const color = (name: string) => style.getPropertyValue(name).trim();
	return {
		background: color("--code"), foreground: color("--code-text"), cursor: color("--code-text"), cursorAccent: color("--code"),
		selectionBackground: color("--line-strong"),
		black: color("--code"), red: color("--red"), green: color("--green"), yellow: color("--warning-text"), blue: color("--blue"), magenta: color("--accent"), cyan: color("--blue"), white: color("--code-text"),
		brightBlack: color("--muted"), brightRed: color("--red"), brightGreen: color("--green"), brightYellow: color("--warning-text"), brightBlue: color("--blue"), brightMagenta: color("--accent"), brightCyan: color("--blue"), brightWhite: color("--code-text"),
	};
}

function NativeTerminal({ tab, onInput, onResize, onClose, screenReaderMode }: { tab: TerminalTab; onInput: TerminalPaneProps["onInput"]; onResize: TerminalPaneProps["onResize"]; onClose: TerminalPaneProps["onClose"]; screenReaderMode: boolean }) {
	const container = useRef<HTMLDivElement>(null);
	const terminal = useRef<Terminal | null>(null);
	const written = useRef(0);
	const latest = useRef({ tab, onInput, onResize, onClose, screenReaderMode });
	useLayoutEffect(() => { latest.current = { tab, onInput, onResize, onClose, screenReaderMode }; });
	useLayoutEffect(() => {
		const element = container.current;
		if (!element) { return; }
		const term = new Terminal({ scrollback: 5000, ...terminalOptions(element), theme: terminalTheme(element), disableStdin: !latest.current.tab.running, screenReaderMode: latest.current.screenReaderMode });
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(element);
		term.textarea?.setAttribute("aria-description", "Press Shift+F6 to move focus to the terminal tab.");
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown" || event.altKey || event.metaKey) { return true; }
			const close = event.ctrlKey && !event.shiftKey && (event.code === "Backquote" || event.key === "`");
			const exit = !event.ctrlKey && event.shiftKey && event.key === "F6";
			if (!close && !exit) { return true; }
			event.preventDefault();
			event.stopPropagation();
			if (close) {
				if (!event.repeat) { latest.current.onClose(); }
			} else {
				element.closest(".tp-pane")?.querySelector<HTMLButtonElement>(".tp-tab-name[aria-current='true']")?.focus();
			}
			return false;
		});
		terminal.current = term;
		const initial = latest.current.tab;
		written.current = initial.received ?? initial.output.length;
		if (initial.output) { term.write(initial.output); }
		const input = term.onData((text) => { if (latest.current.tab.running) { latest.current.onInput(tab.id, text); } });
		let cols = 0;
		let rows = 0;
		const refit = () => {
			if (element.clientWidth === 0 || element.clientHeight === 0) { return; }
			fit.fit();
			if (term.cols !== cols || term.rows !== rows) {
				cols = term.cols;
				rows = term.rows;
				latest.current.onResize(tab.id, cols, rows);
			}
		};
		const resize = new ResizeObserver(refit);
		resize.observe(element);
		const theme = () => {
			term.options.theme = terminalTheme(element);
			Object.assign(term.options, terminalOptions(element));
			refit();
		};
		const appearance = new MutationObserver(theme);
		appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style", "data-ui-config"] });
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		scheme.addEventListener("change", theme);
		refit();
		term.focus();
		return () => {
			resize.disconnect();
			appearance.disconnect();
			scheme.removeEventListener("change", theme);
			input.dispose();
			term.dispose();
			terminal.current = null;
		};
	}, [tab.id]);
	useLayoutEffect(() => {
		if (terminal.current) { terminal.current.options.screenReaderMode = screenReaderMode; }
	}, [screenReaderMode]);
	useLayoutEffect(() => {
		const term = terminal.current;
		if (!term) { return; }
		term.options.disableStdin = !tab.running;
		const received = tab.received ?? tab.output.length;
		const added = received - written.current;
		if (added > 0) { term.write(tab.output.slice(-Math.min(added, tab.output.length))); }
		if (added < 0) { term.reset(); term.write(tab.output); }
		written.current = received;
	}, [tab.output, tab.received, tab.running]);
	return <div className="tp-native" ref={container} aria-label="Interactive terminal" onKeyDown={(event) => event.stopPropagation()} />;
}

export function TerminalPane({ layout, tabs, activeId, terminalScreenReader, error, onActivate, onNew, onCloseTab, onInput, onResize, onInterrupt, onClose }: TerminalPaneProps) {
	const [lines, setLines] = useState<Record<string, LineState>>({});
	const [detected, setDetected] = useState<boolean>();
	const outRef = useRef<HTMLPreElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const stick = useRef(true);
	const shownId = useRef(activeId);
	const active = tabs.find((tab) => tab.id === activeId);
	const native = active?.backend === "pty";
	const waitingForDetection = native && detected === undefined && !!window.grokCode?.accessibilitySupport;
	const output = active?.output ?? "";
	// ponytail: re-strips the whole buffer per chunk; cap output in the orchestrator if it grows past a few MB.
	const text = useMemo(() => native ? "" : stripAnsi(output), [native, output]);
	const line = lines[activeId] ?? FRESH_LINE;

	useEffect(() => {
		const api = window.grokCode;
		if (!api?.accessibilitySupport) { return; }
		let awaitingSnapshot = true;
		const off = api.onEvent((event) => {
			if (event.type !== "accessibility-support-changed") { return; }
			awaitingSnapshot = false;
			setDetected(event.active === true);
		});
		const applySnapshot = (enabled: boolean) => {
			if (awaitingSnapshot) { setDetected(enabled); }
		};
		void api.accessibilitySupport().then(applySnapshot, () => applySnapshot(false));
		return () => { awaitingSnapshot = false; off(); };
	}, []);

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
							<button className="tp-tab-x" aria-label="Close terminal tab" onClick={() => onCloseTab(tab.id)}><Icon name="close" /></button>
						</div>
					))}
				</div>
				<button className="tp-new" aria-label="New terminal tab" onClick={onNew}><Icon name="plus" /></button>
				{active?.running && <button className="texty" title="Stop the running command (Ctrl+C). The terminal stays open." onClick={() => onInterrupt(active.id)}>Stop</button>}
				<PaneActions name="Terminal" layout={layout} onClose={onClose} />
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
					{native ? !waitingForDetection && <NativeTerminal key={active.id} tab={active} onInput={onInput} onResize={onResize} onClose={onClose} screenReaderMode={terminalScreenReader || detected === true} /> : <pre
						className="tp-out"
						ref={outRef}
						onScroll={(event) => {
							const out = event.currentTarget;
							stick.current = out.scrollHeight - out.scrollTop - out.clientHeight <= 48;
						}}
					>
						{text}
					</pre>}
					<div className="tp-notes">
						<p className="note">{native ? "Press Shift+F6 to move focus to the terminal tab." : "Basic terminal fallback: interactive programs and terminal resizing are unavailable."}</p>
						{error && <p className="note">{error}</p>}
						{!active.running && <p className="note">This terminal has exited.</p>}
					</div>
					{!native && <form
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
					</form>}
				</>
			)}
		</section>
	);
}
