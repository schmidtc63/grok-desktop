import { useEffect, useMemo, useRef, useState } from "react";

export interface FilesPaneProps {
	files: { status: "loading" | "ready" | "error"; error?: string; files: string[]; truncated?: boolean } | undefined;
	file: string;
	onSelectFile: (file: string) => void;
	line?: number;
	lineTick: number;
	open: { status: "loading" | "ready" | "error"; error?: string; text?: string; binary?: boolean; version?: string } | undefined;
	draft: { text: string; baseText: string; version: string; note?: string; saving?: boolean; recoveryTexts?: string[] } | undefined;
	readOnly: boolean;
	autoSave: boolean;
	onAutoSave: (on: boolean) => void;
	onEdit: (text: string) => void;
	onSave: () => void;
	onCancel: () => void;
	conflict: boolean;
	onOverride: () => void;
	onDiscard: () => void;
	onClearRecovery: () => void;
	onFileMenu: (file: string, event: React.MouseEvent) => void;
	onClose: () => void;
}

type Spot = { top: number; left: number };

const AUTO_SAVE_MS = 800;

export function shouldAutoSave(state: { autoSave: boolean; dirty: boolean; conflict: boolean; readOnly: boolean; saving: boolean }): boolean {
	return state.autoSave && state.dirty && !state.conflict && !state.readOnly && !state.saving;
}

export function lineOffsets(text: string, line: number): { start: number; end: number } {
	let start = 0;
	for (let at = 1; at < line; at++) {
		const next = text.indexOf(`\n`, start);
		if (next === -1) {
			break;
		}
		start = next + 1;
	}
	let end = text.indexOf(`\n`, start);
	if (end === -1) {
		end = text.length;
	}
	if (end > start && text[end - 1] === `\r`) {
		end--;
	}
	return { start, end };
}

function countLines(text: string): number {
	let count = 1;
	for (let at = text.indexOf(`\n`); at !== -1; at = text.indexOf(`\n`, at + 1)) {
		count++;
	}
	return count;
}

function lineHeightOf(node: HTMLElement): number {
	const style = getComputedStyle(node);
	const value = parseFloat(style.lineHeight);
	if (style.lineHeight.endsWith(`px`) && value > 0) {
		return value;
	}
	const font = parseFloat(style.fontSize) || 12;
	return value > 0 ? value * font : font * 1.2;
}

export function FilesPane(props: FilesPaneProps) {
	const { files, file, onSelectFile, line, lineTick, open, draft, readOnly, autoSave, onAutoSave, onEdit, onSave, onCancel, conflict, onOverride, onDiscard, onClearRecovery, onFileMenu, onClose } = props;
	const [menu, setMenu] = useState<Spot | null>(null);
	const [filter, setFilter] = useState(``);
	const box = useRef<HTMLTextAreaElement>(null);
	const gutter = useRef<HTMLPreElement>(null);
	const saveRef = useRef(onSave);
	const target = useRef<{ tick: number; file: string } | null>(null);
	const revealed = useRef<{ tick: number; node: HTMLTextAreaElement | null }>({ tick: NaN, node: null });

	const listed = files?.files ?? [];
	const dirty = !!draft && draft.text !== draft.baseText;
	const saving = !!draft?.saving;
	const ready = open?.status === `ready` && !open.binary;
	const editable = ready && !!draft;
	const showEditor = ready || dirty;
	const text = draft?.text ?? open?.text ?? ``;
	const autoState = { autoSave, dirty, conflict, readOnly, saving };
	const lineCount = useMemo(() => countLines(text), [text]);
	const numbers = useMemo(() => Array.from({ length: lineCount }, (_, index) => index + 1).join(`\n`), [lineCount]);
	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return needle ? listed.filter((name) => name.toLowerCase().includes(needle)) : listed;
	}, [listed, filter]);

	useEffect(() => {
		saveRef.current = onSave;
	});

	// Debounced auto save. `saving` is left out of the keys on purpose: a failed save must not retry in a loop;
	// the next edit re-arms the timer. The textarea is read-only while saving, so no edit can land mid-save.
	useEffect(() => {
		if (!shouldAutoSave(autoState)) {
			return undefined;
		}
		const timer = window.setTimeout(() => saveRef.current(), AUTO_SAVE_MS);
		return () => window.clearTimeout(timer);
	}, [draft?.text, autoSave, dirty, conflict, readOnly]);

	useEffect(() => {
		target.current = { tick: lineTick, file };
	}, [lineTick]);

	// Reveal `line` once per lineTick, and again only if the textarea remounts for the same file (a reload).
	useEffect(() => {
		const node = box.current;
		const want = target.current;
		if (!node || !line || !want || want.file !== file || open?.status !== `ready`) {
			return;
		}
		if (revealed.current.tick === want.tick && revealed.current.node === node) {
			return;
		}
		revealed.current = { tick: want.tick, node };
		const { start, end } = lineOffsets(node.value, line);
		node.focus({ preventScroll: true });
		node.setSelectionRange(start, end);
		node.scrollTop = (line - 1) * lineHeightOf(node);
		if (gutter.current) {
			gutter.current.scrollTop = node.scrollTop;
		}
	});

	// Flush a pending auto save before the pane loses this file, so the last edits are not dropped with the timer.
	function flush() {
		if (shouldAutoSave(autoState)) {
			onSave();
		}
	}

	function pick(name: string) {
		if (name !== file) {
			flush();
		}
		onSelectFile(name);
	}

	return (
		<section
			className="pane"
			aria-label="Files"
			onKeyDown={(event) => {
				if (event.key === `Escape` && menu) {
					setMenu(null);
					return;
				}
				if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === `s`) {
					event.preventDefault();
					if (dirty && !saving && !readOnly && !conflict) {
						onSave();
					}
				}
			}}
		>
			<div className="pane-hd">
				<b>Files</b>
				{file && <span className="fp-name" title={file}>{file}</span>}
				<span className="spacer" />
				{autoSave && saving && <span className="meta">Saving…</span>}
				{!autoSave && (
					<>
						<button className="texty" disabled={!dirty || saving || readOnly || conflict} onClick={onSave}>{saving ? `Saving` : `Save`}</button>
						<button className="texty" disabled={!dirty || saving} onClick={onCancel}>Cancel</button>
					</>
				)}
				<button className="icon-btn" aria-label="Files menu" aria-haspopup="menu" onClick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					setMenu({ top: rect.bottom + 4, left: Math.min(Math.max(8, rect.right - 200), window.innerWidth - 208) });
				}}>⋮</button>
				<button className="pane-x" aria-label="Close pane" onClick={() => { flush(); onClose(); }}>×</button>
			</div>
			{menu && (
				<>
					<button className="menu-back" aria-label="Close menu" onClick={() => setMenu(null)} />
					<div className="row-pop" role="menu" aria-label="Files menu" style={{ top: menu.top, left: menu.left }}>
						<button className={autoSave ? `check-row on` : `check-row`} role="menuitemcheckbox" aria-checked={autoSave} onClick={() => { setMenu(null); onAutoSave(!autoSave); }}>
							<span>Auto save</span>
							{autoSave && <span className="fp-check">✓</span>}
						</button>
					</div>
				</>
			)}
			<div className="pane-bd fp-body">
				{conflict && (
					<div className="fp-conflict" role="alert">
						<span>This file changed on disk.</span>
						<button className="texty" title="Keep your edits and write them over the disk version" onClick={onOverride}>Override</button>
						<button className="texty" title="Drop your edits and load the disk version" onClick={onDiscard}>Discard</button>
					</div>
				)}
				{(!files || (files.status === `loading` && listed.length === 0)) && <p className="meta">Reading this folder…</p>}
				{files?.status === `error` && <p className="note">{files.error}</p>}
				{files?.truncated && <p className="note">Some files were left out.</p>}
				{files?.status === `ready` && listed.length === 0 && <p className="note">This folder has no files to show.</p>}
				{listed.length > 0 && (
					<>
						<input className="fp-filter" aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(event) => setFilter(event.target.value)} />
						<div className="fp-list">
							{shown.map((name) => (
								<button
									key={name}
									className={name === file ? `fp-row on` : `fp-row`}
									title={name}
									onClick={() => pick(name)}
									onContextMenu={(event) => { event.preventDefault(); onFileMenu(name, event); }}
								>
									{name}
								</button>
							))}
							{shown.length === 0 && <p className="meta fp-none">No files match.</p>}
						</div>
					</>
				)}
				{readOnly && file && <p className="note">This file is view-only here.</p>}
				{files?.status !== `error` && open?.status === `loading` && <p className="meta">Reading {file}…</p>}
				{files?.status !== `error` && open?.status === `error` && <p className="note">{open.error}</p>}
				{open?.binary && <p className="note">This file is binary.</p>}
				{draft?.note && <p className="note">{draft.note}</p>}
				{showEditor && (
					<div className="fp-editor">
						<pre className="fp-gutter" ref={gutter} aria-hidden="true">{numbers}</pre>
						<textarea
							ref={box}
							className="fp-text"
							aria-label="File text"
							wrap="off"
							spellCheck={false}
							value={text}
							readOnly={readOnly || saving || !editable}
							onChange={(event) => onEdit(event.target.value)}
							onScroll={(event) => {
								if (gutter.current) {
									gutter.current.scrollTop = event.currentTarget.scrollTop;
								}
							}}
						/>
					</div>
				)}
				{dirty && !editable && <p className="note">Unsaved draft retained. You can select and copy its text.</p>}
				{draft?.recoveryTexts?.map((retained, index) => (
					<div key={index}>
						<p className="note">Retained draft {index + 1}. Copy changes into the editor to reconcile with disk.</p>
						<textarea className="editor-box" aria-label={`Retained draft ${index + 1}`} value={retained} readOnly spellCheck={false} />
					</div>
				))}
				{!!draft?.recoveryTexts?.length && <button className="texty" onClick={onClearRecovery}>Discard retained text</button>}
			</div>
		</section>
	);
}
