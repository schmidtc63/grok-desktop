import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { modKey } from "./data";
import { CodeEditorLoader as CodeEditor } from "./CodeEditorLoader";

export interface FilesPaneProps {
	files: { status: "loading" | "ready" | "error"; error?: string; files: string[]; truncated?: boolean } | undefined;
	file: string;
	docKey: string;
	fileTypes: Record<string, string>;
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
	onLink: (href: string, event: React.MouseEvent) => void;
	onClose: () => void;
}

type Spot = { top: number; left: number };

const AUTO_SAVE_MS = 800;

export function shouldAutoSave(state: { autoSave: boolean; dirty: boolean; conflict: boolean; readOnly: boolean; saving: boolean }): boolean {
	return state.autoSave && state.dirty && !state.conflict && !state.readOnly && !state.saving;
}

export function fromFile(file: string, href: string): string {
	if (/^([a-z][a-z0-9+-]*:|[#/\\])/i.test(href)) { return href; }
	const parts = file.replace(/\\/g, `/`).split(`/`).slice(0, -1);
	for (const part of href.replace(/\\/g, `/`).split(/[?#]/)[0].split(`/`)) {
		if (part === `..`) { parts.pop(); } else if (part && part !== `.`) { parts.push(part); }
	}
	return parts.join(`/`);
}

export function FilesPane(props: FilesPaneProps) {
	const { files, file, docKey, fileTypes, onSelectFile, line, lineTick, open, draft, readOnly, autoSave, onAutoSave, onEdit, onSave, onCancel, conflict, onOverride, onDiscard, onClearRecovery, onFileMenu, onLink, onClose } = props;
	const [menu, setMenu] = useState<Spot | null>(null);
	const [filter, setFilter] = useState(``);
	const [preview, setPreview] = useState(true);
	const [picked, setPicked] = useState<Record<string, string>>({});
	const [expanded, setExpanded] = useState(false);
	const paneRef = useRef<HTMLElement>(null);
	const saveRef = useRef(onSave);
	const target = useRef<{ tick: number; file: string } | null>(null);
	if (target.current?.tick !== lineTick) { target.current = { tick: lineTick, file }; }
	const reveal = line && target.current.file === file && open?.status === `ready` ? { line, tick: lineTick } : undefined;

	const listed = files?.files ?? [];
	const dirty = !!draft && draft.text !== draft.baseText;
	const saving = !!draft?.saving;
	const ready = open?.status === `ready` && !open.binary;
	const markdown = /\.(md|markdown)$/i.test(file);
	const showPreview = markdown && preview && ready;
	const editable = ready && !!draft;
	const showEditor = ready || dirty;
	const text = draft?.text ?? open?.text ?? ``;
	const autoState = { autoSave, dirty, conflict, readOnly, saving };
	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return needle ? listed.filter((name) => name.toLowerCase().includes(needle)) : listed;
	}, [listed, filter]);

	useEffect(() => {
		saveRef.current = onSave;
	});

	// Debounced auto save. `saving` is left out of the keys on purpose: a failed save must not retry in a loop;
	// the next edit or a successful save's updated base text re-arms the timer.
	useEffect(() => {
		if (!shouldAutoSave(autoState)) {
			return undefined;
		}
		const timer = window.setTimeout(() => saveRef.current(), AUTO_SAVE_MS);
		return () => window.clearTimeout(timer);
	}, [draft?.text, draft?.baseText, autoSave, dirty, conflict, readOnly]);

	useEffect(() => {
		setPreview(!line);
	}, [lineTick]);

	useEffect(() => {
		if (expanded) { paneRef.current?.focus(); }
	}, [expanded]);

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
		<>
		{expanded && <div className="fp-backdrop" aria-hidden="true" onClick={() => setExpanded(false)} />}
		<section
			ref={paneRef}
			className={expanded ? "pane fp-expanded" : "pane"}
			aria-label="Files"
			tabIndex={expanded ? -1 : undefined}
			onKeyDown={(event) => {
				if (event.key === `Escape` && menu) {
					setMenu(null);
					return;
				}
				if (event.key === `Escape` && expanded && !event.defaultPrevented) {
					setExpanded(false);
					return;
				}
				if (modKey(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === `s`) {
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
				{markdown && ready && <button className={`texty`} aria-pressed={!preview} onClick={() => setPreview((value) => !value)}>{preview ? `Edit` : `Preview`}</button>}
				{!autoSave && (
					<>
						<button className="texty" disabled={!dirty || saving || readOnly || conflict} onClick={onSave}>{saving ? `Saving` : `Save`}</button>
						<button className="texty" disabled={!dirty || saving} onClick={onCancel}>Cancel</button>
					</>
				)}
				<button className="icon-btn" aria-label={expanded ? `Return Files to the side` : `Pop out Files`} title={expanded ? `Return to the side (Esc)` : `Pop out`} aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? `⤡` : `⤢`}</button>
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
							{shown.slice(0, 500).map((name) => (
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
						{shown.length > 500 && <p className="meta">Showing 500 of {shown.length}. Type to filter.</p>}
					</>
				)}
				{readOnly && file && <p className="note">This file is view-only here.</p>}
				{files?.status !== `error` && open?.status === `loading` && <p className="meta">Reading {file}…</p>}
				{files?.status !== `error` && open?.status === `error` && <p className="note">{open.error}</p>}
				{open?.binary && <p className="note">This file is binary.</p>}
				{draft?.note && <p className="note">{draft.note}</p>}
				{showPreview && (
					<div className={`fp-preview`}>
						<Markdown text={text} onLink={(href, event) => { if (!href.startsWith(`#`)) { onLink(fromFile(file, href), event); } }} />
					</div>
				)}
				{showEditor && !showPreview && (
					<div className="fp-editor">
						<CodeEditor key={docKey} aria-label="File text" file={file} value={text} readOnly={readOnly || !editable} fileTypes={fileTypes} language={picked[docKey]} onLanguage={(name) => setPicked((current) => ({ ...current, [docKey]: name }))} reveal={reveal} onEdit={onEdit} />
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
		</>
	);
}
