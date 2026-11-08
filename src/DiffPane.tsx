import { Fragment, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import { keyLabel, modKey } from "./data";
import { Icon } from "./Icon";
import { paneCloseButton, paneExpandButton, paneMenuButton, paneMoveItems, type PaneLayoutControls } from "./PaneActions";
import { PopupMenu } from "./PopupMenu";

export interface DiffComment { id: string; file: string; line: number; side: "old" | "new"; text: string }

export interface PrInfo {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	autoMerge: boolean;
	checks: { name: string; state: "pass" | "fail" | "run" | "wait" | "skip"; url?: string }[];
}

export interface DiffPaneProps {
	layout?: PaneLayoutControls;
	snapshot: DiffSnapshot | undefined;
	progressive?: boolean;
	loadingFiles?: boolean;
	loadingFile?: boolean;
	fileError?: string;
	fullLimitReached?: boolean;
	onLoadFull?: () => void;
	onStopLoad?: () => void;
	scope: string;
	onScope: (scope: string) => void;
	commits: { sha: string; short: string; subject: string }[];
	selectedFile: string;
	onSelectFile: (file: string) => void;
	onRefresh: () => void;
	onRevert: (file: string) => Promise<{ ok: boolean; error?: string }>;
	onRevertHunk: (file: string, hunk: DiffHunk) => Promise<WriteResult>;
	onCommit: (input: { paths: string[]; message: string; push: boolean }) => Promise<{ ok: boolean; error?: string; message?: string; committed?: boolean; sha?: string }>;
	busy: boolean;
	comments: DiffComment[];
	viewed: Record<string, string>;
	onViewed: (file: string, fingerprint: string | null) => void;
	onAddComment: (comment: Omit<DiffComment, "id">) => void;
	onRemoveComment: (id: string) => void;
	onSendComments: () => void;
	onAskGrok: (text: string) => void;
	branch: { branch: string; base: string; ahead: number } | undefined;
	pr: PrInfo | null | undefined;
	prError?: string;
	onCreatePr: () => Promise<{ ok: boolean; error?: string; url?: string; message?: string }>;
	onMergeWhenReady: () => Promise<{ ok: boolean; error?: string; message?: string }>;
	onOpenFile: (file: string, line?: number) => void;
	onFileMenu: (file: string, event: React.MouseEvent) => void;
	onClose: () => void;
}

export interface NumberedLine { oldLine?: number; newLine?: number; kind: DiffLine["kind"]; text: string }

type CheckState = PrInfo["checks"][number]["state"];
type Spot = { top: number; left: number; opener: HTMLElement };
type Compose = { file: string; side: "old" | "new"; line: number; text: string };

// Staged hunks carry a "Staged " label before the @@ header.
const HUNK_HEAD = /^(?:\w+ )?@@ -(\d+)(?:,\d+)? \+(\d+)/;
const CHECK_LABEL: Record<CheckState, string> = { pass: "passed", run: "running", wait: "waiting", fail: "failed", skip: "skipped" };
const FILE_PAGE_SIZE = 40;

export function numberLines(hunk: DiffHunk): NumberedLine[] {
	const head = HUNK_HEAD.exec(hunk.loc);
	if (!head) {
		return hunk.lines.map((line) => ({ kind: line.kind, text: line.text }));
	}
	let oldLine = Number(head[1]);
	let newLine = Number(head[2]);
	return hunk.lines.map((line) => {
		if (line.kind === "add") {
			return { newLine: newLine++, kind: line.kind, text: line.text };
		}
		if (line.kind === "del") {
			return { oldLine: oldLine++, kind: line.kind, text: line.text };
		}
		return { oldLine: oldLine++, newLine: newLine++, kind: line.kind, text: line.text };
	});
}

export function checksSummary(checks: PrInfo["checks"]): string {
	const parts = (Object.keys(CHECK_LABEL) as CheckState[]).map((state) => {
		const count = checks.filter((check) => check.state === state).length;
		return count > 0 ? `${count} ${CHECK_LABEL[state]}` : ``;
	}).filter((part) => part !== ``);
	return parts.length > 0 ? parts.join(` · `) : `No checks`;
}

export function fileFingerprint(file: DiffFile): string {
	return file.patchLoaded !== true && file.patchFingerprint !== undefined ? file.patchFingerprint : file.hunks.map((hunk) => hunk.id).join(`\n`);
}

export function canMarkViewed(file: DiffFile): boolean {
	return !file.truncated && file.hunks.length > 0 && file.hunks.every((hunk) => hunk.reviewable !== false);
}

function prStateLabel(pr: PrInfo): string {
	const state = pr.state.toLowerCase();
	if (state === `merged`) {
		return `Merged`;
	}
	if (state === `closed`) {
		return `Closed`;
	}
	return pr.isDraft ? `Draft` : `Open`;
}

function menuSpot(event: React.MouseEvent<HTMLElement>): Spot {
	const rect = event.currentTarget.getBoundingClientRect();
	const width = 200;
	return { top: rect.bottom + 4, left: Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8), opener: event.currentTarget };
}

function PrStrip({ branch, pr, prError, onCreatePr, onMergeWhenReady }: Pick<DiffPaneProps, "branch" | "pr" | "prError" | "onCreatePr" | "onMergeWhenReady">) {
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<string | null>(null);
	const [merging, setMerging] = useState(false);
	const [note, setNote] = useState(``);
	const [expanded, setExpanded] = useState(false);
	const [menu, setMenu] = useState<Spot | null>(null);
	if (!branch || branch.branch === branch.base) {
		return null;
	}

	function create() {
		setCreating(true);
		setNote(``);
		void onCreatePr().then((result) => {
			if (result.ok) {
				setCreated(result.url ?? ``);
				setNote(result.message || ``);
			} else {
				setNote(result.error || `The pull request could not be created.`);
			}
		}, () => setNote(`The pull request could not be created.`)).finally(() => setCreating(false));
	}

	function merge() {
		setMenu(null);
		setMerging(true);
		setNote(``);
		void onMergeWhenReady().then((result) => {
			setNote(result.ok ? (result.message || `Auto-merge is on. GitHub merges this pull request when its checks pass.`) : (result.error || `Auto-merge could not be turned on.`));
		}, () => setNote(`Auto-merge could not be turned on.`)).finally(() => setMerging(false));
	}

	const createdNumber = created ? /\/pull\/(\d+)/.exec(created)?.[1] : undefined;
	const stateLabel = pr ? prStateLabel(pr) : ``;
	const mergeReason = pr?.autoMerge ? `Auto-merge is already on` : merging ? `Turning on auto-merge…` : pr?.state !== `OPEN` ? `The pull request is not open` : ``;
	return (
		<div className="dp-pr">
			{!pr && <span className="meta dp-branch" title={`${branch.branch} into ${branch.base}`}>{branch.branch} → {branch.base}{branch.ahead > 0 ? ` · ${branch.ahead} ahead` : ``}</span>}
			{pr === undefined && <span className="meta">Checking for a pull request…</span>}
			{pr === null && created === null && branch.ahead > 0 && (
				<button className="texty" disabled={creating} onClick={create}>{creating ? `Creating…` : `Create PR`}</button>
			)}
			{pr === null && created !== null && <span className="dp-link" title={created}>{createdNumber ? `Opened #${createdNumber}` : `Opened the pull request`}</span>}
			{pr && (
				<>
					<span className="dp-pr-title" title={pr.url}>PR #{pr.number} {pr.title}</span>
					<span className={`dp-badge dp-${stateLabel.toLowerCase()}`}>{stateLabel}</span>
					<button className="texty dp-checks-btn" aria-expanded={expanded} disabled={pr.checks.length === 0} onClick={() => setExpanded(!expanded)}>{checksSummary(pr.checks)}</button>
					<button className="icon-btn" aria-label="Pull request menu" aria-haspopup="menu" aria-expanded={!!menu} onClick={(event) => setMenu(menu ? null : menuSpot(event))}><Icon name="more" /></button>
				</>
			)}
			{pr && expanded && pr.checks.length > 0 && (
				<ul className="dp-checks" aria-label="Checks">
					{pr.checks.map((check, index) => (
						<li key={`${check.name}:${index}`} title={check.url}>
							<span className={`dp-${check.state}`}>{CHECK_LABEL[check.state]}</span>
							<span>{check.name}</span>
						</li>
					))}
				</ul>
			)}
			{menu && pr && (
				<>
					<button className="menu-back" aria-label="Close menu" tabIndex={-1} onClick={() => setMenu(null)} />
					<PopupMenu className="row-pop" aria-label="Pull request menu" style={{ top: menu.top, left: menu.left }} opener={menu.opener} onDismiss={() => setMenu(null)}>
						<button role="menuitem" disabled={!!mergeReason} onClick={merge}>Merge when ready{mergeReason && <small className="menu-reason">{mergeReason}</small>}</button>
					</PopupMenu>
				</>
			)}
			{note && <p className="note">{note}</p>}
			{prError && <p className="note">{prError}</p>}
		</div>
	);
}

export function DiffPane(props: DiffPaneProps) {
	const { snapshot, scope, onScope, commits, selectedFile, onSelectFile, onRefresh, onRevert, comments, onAddComment, onRemoveComment, onSendComments, onAskGrok, onOpenFile, onFileMenu, onClose } = props;
	const { layout, progressive, loadingFiles, loadingFile, fileError, fullLimitReached, onLoadFull, onStopLoad } = props;
	const [menu, setMenu] = useState<Spot | null>(null);
	const [note, setNote] = useState(``);
	const [reverting, setReverting] = useState(false);
	const [compose, setCompose] = useState<Compose | null>(null);
	const [commitDialog, setCommitDialog] = useState<{ paths: string[]; request: string; count: number; push: boolean; message: string; error?: string } | null>(null);
	const [committing, setCommitting] = useState(false);
	const sendAfterAdd = useRef(false);
	useEffect(() => {
		if (sendAfterAdd.current) {
			sendAfterAdd.current = false;
			onSendComments();
		}
	}, [comments]);
	const allFiles = snapshot?.files ?? [];
	const [page, setPage] = useState({ scope, count: FILE_PAGE_SIZE });
	const focusRevealed = useRef<string | null>(null);
	const requestedIndex = allFiles.findIndex((file) => file.path === selectedFile);
	const pageCount = Math.max(page.scope === scope ? page.count : FILE_PAGE_SIZE, Math.ceil((requestedIndex + 1) / FILE_PAGE_SIZE) * FILE_PAGE_SIZE);
	const files = progressive ? allFiles.slice(0, pageCount) : allFiles;
	const selected = requestedIndex >= 0 ? selectedFile : files[0]?.path ?? ``;
	useEffect(() => {
		if (progressive && (page.scope !== scope || page.count !== pageCount)) { setPage({ scope, count: pageCount }); }
	}, [progressive, scope, page, pageCount]);
	const revertReason = scope !== `uncommitted` ? `Switch to Uncommitted changes to revert a file` : loadingFiles ? `Wait for the changed files to finish loading` : reverting ? `Restoring a file…` : !selected ? `Select a changed file first` : ``;
	const current = files.find((file) => file.path === selected);
	const currentLoaded = !progressive || current?.patchLoaded === true;
	const [localReview, setReview] = useState(false);
	const review = layout?.expanded ?? localReview;
	// Older snapshot readers include new files by default. Progressive lists require explicit inclusion beyond the initial page.
	const [excluded, setExcluded] = useState<string[]>([]);
	const [included, setIncluded] = useState<Set<string> | null>(null);
	const paneRef = useRef<HTMLElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const index = files.findIndex((file) => file.path === selected);
	const isViewed = (file: DiffFile) => {
		const fingerprint = fileFingerprint(file);
		const known = file.patchLoaded !== true && file.patchFingerprint !== undefined;
		return !!fingerprint && (known || canMarkViewed(file)) && props.viewed[file.path] === fingerprint;
	};
	const currentViewed = !!current && isViewed(current);
	const canViewCurrent = !!current && currentLoaded && canMarkViewed(current);
	const viewedCount = files.filter(isViewed).length;
	const uncommittedList = snapshot?.ok && snapshot.repo !== false && scope === `uncommitted`;
	const canCommit = uncommittedList && files.length > 0;
	const initialPicks = () => new Set(allFiles.slice(0, FILE_PAGE_SIZE).map((file) => file.path));
	const currentPicks = progressive ? included ?? initialPicks() : null;
	const isPicked = (file: DiffFile) => currentPicks ? currentPicks.has(file.path) : !excluded.includes(file.path);
	const picked = files.filter(isPicked);
	const none = picked.length === 0;
	const commitBlock = loadingFiles ? `Wait for the changed files to finish loading.` : none ? `Check at least one file.` : undefined;
	const allPicked = files.length > 0 && picked.length === files.length;
	useEffect(() => {
		if (!progressive || !uncommittedList || !snapshot || loadingFiles) { return; }
		setIncluded((previous) => {
			if (!previous) { return initialPicks(); }
			const remaining = new Set(allFiles.filter((file) => previous.has(file.path)).map((file) => file.path));
			return remaining.size === previous.size ? previous : remaining;
		});
	}, [progressive, uncommittedList, snapshot, loadingFiles]);
	useEffect(() => { if (review && !layout) { paneRef.current?.focus(); } }, [review]);
	useEffect(() => {
		bodyRef.current?.scrollTo?.({ top: 0 });
		// In the side pane the list sits above the diff: a reader below the Previous / Next bar goes back up to it, one still at the list stays there.
		const scroller = paneRef.current?.querySelector<HTMLDivElement>(`.pane-bd`);
		const bar = bodyRef.current?.getBoundingClientRect?.().top;
		if (scroller && bar !== undefined) {
			const top = scroller.scrollTop + bar - scroller.getBoundingClientRect().top;
			if (scroller.scrollTop > top) { scroller.scrollTop = top; }
		}
	}, [selected]);

	function go(step: 1 | -1) {
		const next = files[index + step];
		if (next) { onSelectFile(next.path); }
	}

	function toggleViewed(file: DiffFile) {
		props.onViewed(file.path, isViewed(file) ? null : fileFingerprint(file));
	}

	function togglePick(file: string) {
		if (progressive) {
			setIncluded((previous) => {
				const next = new Set(previous ?? initialPicks());
				if (next.has(file)) { next.delete(file); } else { next.add(file); }
				return next;
			});
			return;
		}
		setExcluded((list) => list.includes(file) ? list.filter((item) => item !== file) : [...list, file]);
	}

	function toggleAll() {
		if (progressive) {
			setIncluded((previous) => {
				const next = new Set(previous ?? initialPicks());
				for (const file of files) {
					if (allPicked) { next.delete(file.path); } else { next.add(file.path); }
				}
				return next;
			});
			return;
		}
		setExcluded((previous) => {
			const listed = new Set(files.map((file) => file.path));
			const next = previous.filter((file) => !listed.has(file));
			return allPicked ? [...next, ...listed] : next;
		});
	}

	function showMore() {
		focusRevealed.current = allFiles[files.length]?.path ?? null;
		setPage({ scope, count: pageCount + FILE_PAGE_SIZE });
	}

	function commit(push: boolean) {
		if (commitBlock) { return; }
		// A renamed file also names its old path, or the commit would leave the old one behind.
		const paths = picked.flatMap((file) => file.from ? [file.from, file.path] : [file.path]);
		const names = paths.map((name) => `\`${name}\``).join(`, `);
		// Always name the files, even when all are checked: the list can be cut short, or cover only this folder of a larger repository.
		const request = `Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: ${names}. ${push ? `Then push the branch.` : `Don't push.`}`;
		setMenu(null);
		setCommitDialog({ paths, request, count: picked.length, push, message: `` });
	}

	async function runCommit() {
		if (!commitDialog || committing || props.busy || loadingFiles || !commitDialog.message.trim()) { return; }
		setCommitting(true);
		setCommitDialog({ ...commitDialog, error: undefined });
		try {
			const result = await props.onCommit({ paths: commitDialog.paths, message: commitDialog.message.trim(), push: commitDialog.push });
			if (result.committed) {
				setExcluded([]);
				setCommitDialog(null);
			} else {
				setCommitDialog({ ...commitDialog, error: result.error || `The commit could not be completed.` });
			}
		} catch {
			setCommitDialog({ ...commitDialog, error: `The commit could not be checked. Refresh to see what happened.` });
		} finally {
			setCommitting(false);
			onRefresh();
		}
	}

	function revert() {
		setMenu(null);
		const file = selected;
		if (!file) {
			return;
		}
		void askConfirm({ title: `Revert ${file}?`, body: `This puts the file back as it was at the last commit. This cannot be undone.`, ok: `Revert`, danger: true }).then((yes) => {
			if (!yes) { return; }
			setReverting(true);
			setNote(``);
			void onRevert(file).then((result) => {
				setNote(result.ok ? `Restored ${file} to the last commit.` : (result.error || `That file could not be restored.`));
			}, () => setNote(`That file could not be restored.`)).finally(() => setReverting(false));
		});
	}

	function revertHunk(file: string, hunk: DiffHunk) {
		const range = /\+(\d+)(?:,(\d+))? @@/.exec(hunk.loc);
		if (!range) { return; }
		const start = Number(range[1]);
		const count = range[2] === undefined ? 1 : Number(range[2]);
		const deletion = count === 0 ? (start === 0 ? ` The deleted lines are restored before the first line.` : ` The deleted lines are restored after line ${start}.`) : ``;
		void askConfirm({ title: `Revert this change?`, body: `Lines ${start}-${Math.max(start, start + count - 1)} of ${file} go back to how they are in the index. The app can't undo this.${deletion}`, ok: `Revert`, danger: true }).then((yes) => {
			if (!yes) { return; }
			setReverting(true);
			setNote(``);
			void props.onRevertHunk(file, hunk).then((result) => {
				setNote(result.ok ? `Restored this change in ${file} to its indexed version.` : (result.error || `That change could not be restored.`));
			}, () => setNote(`That change could not be restored.`)).finally(() => { setReverting(false); onRefresh(); });
		});
	}

	function composeKeys(event: React.KeyboardEvent<HTMLTextAreaElement>, draft: Compose) {
		if (event.nativeEvent.isComposing) {
			return;
		}
		if (event.key === `Escape`) {
			event.preventDefault();
			event.stopPropagation();
			setCompose(null);
			return;
		}
		if (event.key !== `Enter` || event.shiftKey) {
			return;
		}
		const text = draft.text.trim();
		if (modKey(event) && !text) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (text) {
			if (modKey(event)) { sendAfterAdd.current = true; }
			onAddComment({ file: draft.file, line: draft.line, side: draft.side, text });
			setCompose(null);
		}
	}

	function renderHunk(file: string, hunk: DiffHunk) {
		const rows = numberLines(hunk);
		const firstLine = rows.find((row) => row.newLine !== undefined)?.newLine;
		return (
			<div className="dp-hunk" key={hunk.id}>
				<div className="dp-hunk-hd">
					<span>{hunk.loc}</span>
					{firstLine !== undefined && (
						<button className="dp-goto" aria-label={`Open ${file} at line ${firstLine}`} onClick={() => onOpenFile(file, firstLine)}>Open</button>
					)}
					{scope === `uncommitted` && hunk.revertible === true && <button className="texty" disabled={reverting} onClick={() => revertHunk(file, hunk)}>Revert this change</button>}
				</div>
				{rows.map((row, index) => {
					const side = row.kind === `del` ? `old` : `new`;
					const at = side === `old` ? row.oldLine : row.newLine;
					const notes = at === undefined ? [] : comments.filter((comment) => comment.file === file && comment.side === side && comment.line === at);
					const draft = compose && at !== undefined && compose.file === file && compose.side === side && compose.line === at ? compose : null;
					return (
						<Fragment key={index}>
							<div className={`dp-line dp-${row.kind}`}>
								<span className="dp-num">{row.oldLine ?? ``}</span>
								<span className="dp-num">{row.newLine ?? ``}</span>
								<span className="dp-act">
									{at !== undefined && (
										<button className="dp-plus" aria-label={`Comment on line ${at}`} onClick={() => setCompose({ file, side, line: at, text: `` })}><Icon name="plus" /></button>
									)}
								</span>
								{row.kind === `context` ? <span className="dp-marker" /> : (
									<span className="dp-marker" role="img" aria-label={row.kind === `add` ? `Added line` : `Deleted line`}>{row.kind === `add` ? `+` : `−`}</span>
								)}
								<span className="dp-text">{row.text}</span>
							</div>
							{notes.map((comment) => (
								<div className="dp-note" key={comment.id}>
									<span>{comment.text}</span>
									<button aria-label="Remove comment" onClick={() => onRemoveComment(comment.id)}><Icon name="close" /></button>
								</div>
							))}
							{draft && (
								<div className="dp-compose">
									<textarea
										autoFocus
										aria-label={`Comment text for line ${draft.line}`}
										placeholder="Enter adds the comment. Shift+Enter starts a new line. Esc cancels."
										value={draft.text}
										onChange={(event) => setCompose({ ...draft, text: event.target.value })}
										onKeyDown={(event) => composeKeys(event, draft)}
									/>
								</div>
							)}
						</Fragment>
					);
				})}
				{hunk.reviewable === false && <p className="note dp-hunk-note">Content review is unavailable for this entry.</p>}
			</div>
		);
	}

	return (
		<>
		{review && !layout && <div className="fp-backdrop" aria-hidden="true" onClick={() => setReview(false)} />}
		<section
			ref={paneRef}
			className={review ? (layout ? `pane dp-review` : `pane fp-expanded dp-review`) : `pane`}
			aria-label="Changes"
			tabIndex={-1}
			onKeyDown={(event) => {
				if (commitDialog) { event.stopPropagation(); return; }
				if (event.key === `Escape` && menu) {
					event.preventDefault();
					event.stopPropagation();
					setMenu(null);
					return;
				}
				const typing = (event.target as HTMLElement).tagName === `TEXTAREA` || (event.target as HTMLElement).tagName === `SELECT`;
				if (!layout && event.key === `Escape` && review && !event.defaultPrevented) {
					setReview(false);
					return;
				}
				if (!typing && event.altKey && (event.key === `ArrowDown` || event.key === `ArrowUp`)) {
					event.preventDefault();
					go(event.key === `ArrowDown` ? 1 : -1);
					return;
				}
				if (modKey(event) && event.key === `Enter` && comments.length > 0) {
					event.preventDefault();
					onSendComments();
				}
			}}
		>
			<div className="pane-hd">
				<b>Changes</b>
				<select className="dp-scope" aria-label="Diff scope" value={scope} onChange={(event) => onScope(event.target.value)}>
					<option value="branch">All branch changes</option>
					<option value="uncommitted">Uncommitted changes</option>
					{commits.map((commit) => (
						<option key={commit.sha} value={commit.sha}>{commit.short} {commit.subject}</option>
					))}
				</select>
				<div className="pane-actions">
					{paneMenuButton("Changes", !!menu, (event) => setMenu(menu ? null : menuSpot(event)))}
					{paneExpandButton("Changes", review, layout?.onToggleExpand ?? (() => setReview((value) => !value)), layout ? undefined : "Review in a large view")}
					{paneCloseButton(onClose)}
				</div>
			</div>
			{menu && (
				<>
					<button className="menu-back" aria-label="Close menu" tabIndex={-1} onClick={() => setMenu(null)} />
					<PopupMenu className="row-pop" aria-label="Changes menu" style={{ top: menu.top, left: menu.left }} opener={menu.opener} onDismiss={() => setMenu(null)}>
						<button role="menuitem" onClick={() => { setMenu(null); onRefresh(); }}>Refresh</button>
						<button role="menuitem" disabled={!!revertReason} onClick={revert}>Revert file…{revertReason && <small className="menu-reason">{revertReason}</small>}</button>
						{layout && <><hr />{paneMoveItems(layout, () => setMenu(null))}</>}
					</PopupMenu>
				</>
			)}
			<PrStrip branch={props.branch} pr={props.pr} prError={props.prError} onCreatePr={props.onCreatePr} onMergeWhenReady={props.onMergeWhenReady} />
			<div className={review ? `pane-bd` : `pane-bd dp-side`}>
				{!progressive && !snapshot && <p className="meta">Reading the working tree…</p>}
				{progressive && loadingFiles && <div className="dp-load"><span role="status">Reading changed files…</span>{onStopLoad && <button className="texty" onClick={onStopLoad}>Stop loading</button>}</div>}
				{progressive && !loadingFiles && !snapshot && <div className="dp-load"><span>File list not loaded.</span><button className="texty" onClick={onRefresh}>Retry file list</button></div>}
				{snapshot && !snapshot.ok && <div className="dp-load"><p className="note" role="alert">{snapshot.error || `The changes could not be read.`}</p>{progressive && !loadingFiles && <button className="texty" onClick={onRefresh}>Retry file list</button>}</div>}
				{snapshot?.ok && snapshot.repo === false && <p className="note">This folder is not a git checkout.</p>}
				{!loadingFiles && snapshot?.ok && snapshot.repo !== false && files.length === 0 && <p className="note">No changes.</p>}
				{!progressive && snapshot?.truncated && <p className="note">The rest of the diff was left out.</p>}
				{note && <p className="note">{note}</p>}
				{canCommit && (
					<div className="dp-commit">
						<button className="texty" disabled={!!commitBlock} title={commitBlock} onClick={() => commit(false)}>Commit</button>
						<button className="texty" disabled={!!commitBlock} title={commitBlock} onClick={() => commit(true)}>Commit and push</button>
					</div>
				)}
				{files.length > 0 && (
					<div className="dp-split">
						<div className="dp-files">
							{progressive && <div className="dp-load dp-file-page">
								<span role="status">Showing {files.length} of {allFiles.length} changed {allFiles.length === 1 ? `file` : `files`}.</span>
								{files.length < allFiles.length && <button className="texty" onClick={showMore}>Show more files</button>}
							</div>}
							<p className="meta dp-progress">{viewedCount} of {files.length} viewed{!progressive && snapshot?.truncated ? ` · more files were left out` : ``}</p>
							{canCommit && <label className="dp-include-all">
								<input type="checkbox" className="dp-pick" checked={allPicked} ref={(input) => { if (input) { input.indeterminate = !none && !allPicked; } }} onChange={toggleAll} />
								Include all {files.length} listed {files.length === 1 ? `file` : `files`}
							</label>}
							<div className="file-list">
								{files.map((file) => (
									<div className="dp-file" key={file.path}>
										{canCommit && <input type="checkbox" className="dp-pick" aria-label={`Include ${file.path} in the commit`} checked={isPicked(file)} onChange={() => togglePick(file.path)} />}
										<button
											className={file.path === selected ? `file-row on` : `file-row`}
											ref={(button) => {
												if (button && focusRevealed.current === file.path) { focusRevealed.current = null; button.focus(); }
											}}
											title={file.path}
											onClick={() => onSelectFile(file.path)}
											onDoubleClick={() => onOpenFile(file.path)}
											onContextMenu={(event) => { event.preventDefault(); onFileMenu(file.path, event); }}
										>
											<span>{isViewed(file) && <span className="dp-viewed" aria-label="Viewed">✓ </span>}{file.path}</span>
											{file.additions !== undefined && file.deletions !== undefined && <span className="dp-stat"><span className="dp-adds">+{file.additions}</span> <span className="dp-dels">−{file.deletions}</span></span>}
										</button>
									</div>
								))}
							</div>
						</div>
						<div className="dp-body" ref={bodyRef}>
							{current && (
								<div className="dp-nav">
									<button className="texty" disabled={index <= 0} onClick={() => go(-1)} title="Previous file (Alt+Up)"><Icon name="chevron-left" /> Previous</button>
									<button className="texty" disabled={index < 0 || index >= files.length - 1} onClick={() => go(1)} title="Next file (Alt+Down)">Next <Icon name="chevron-right" /></button>
									<span className="dp-nav-path" title={current.path}>{current.path}</span>
									<button className="texty dp-viewed-toggle" aria-pressed={currentViewed} disabled={!canViewCurrent} onClick={() => toggleViewed(current)} title={canViewCurrent ? (currentViewed ? `Undo viewed` : undefined) : `A complete, reviewable diff is required`}>
										{currentViewed && <Icon name="check" />}{currentViewed ? `Viewed` : `Mark viewed`}
									</button>
								</div>
							)}
							{progressive && current && !loadingFiles && loadingFile && <div className="dp-load"><span role="status">Loading diff…</span>{onStopLoad && <button className="texty" onClick={onStopLoad}>Stop loading</button>}</div>}
							{progressive && current && !loadingFiles && !loadingFile && <>
								{fileError && <p className="note" role="alert">{fileError}</p>}
								{currentLoaded && current.truncated && <div className="dp-load">
									<span>{fullLimitReached ? `This diff exceeds the display limit.` : `Showing a preview of this diff.`}</span>
									{!fullLimitReached && onLoadFull && <button className="texty" onClick={onLoadFull}>Load full diff for this file</button>}
								</div>}
								{!currentLoaded && onLoadFull && <div className="dp-load">{!fileError && <span>Diff not loaded.</span>}<button className="texty" onClick={onLoadFull}>Retry diff</button></div>}
								{currentLoaded && !current.truncated && current.hunks.length === 0 && <p className="meta">No line changes to show for this file.</p>}
							</>}
							{current && currentLoaded && current.hunks.map((hunk) => renderHunk(current.path, hunk))}
						</div>
					</div>
				)}
			</div>
			{comments.length > 0 && (
				<div className="dp-foot">
					<span className="meta">{comments.length === 1 ? `1 comment` : `${comments.length} comments`}</span>
					<button className="texty dp-send" onClick={onSendComments}>{keyLabel("Send to Grok (Ctrl+Enter)")}</button>
				</div>
			)}
		</section>
		{commitDialog && (
			<div className="overlay confirm-overlay" data-commit-dialog onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === `Escape`) {
					event.preventDefault();
					if (!committing) { setCommitDialog(null); }
				} else if (modKey(event) && event.key === `Enter` && !event.nativeEvent.isComposing) {
					event.preventDefault();
					void runCommit();
				}
			}}>
				<div className="sheet" role="dialog" aria-modal="true" aria-label={`Commit ${commitDialog.count} file${commitDialog.count === 1 ? `` : `s`}${commitDialog.push ? ` and push` : ``}?`}>
					<h2>{`Commit ${commitDialog.count} file${commitDialog.count === 1 ? `` : `s`}${commitDialog.push ? ` and push` : ``}?`}</h2>
					<p className="confirm-body">Only the checked files listed in the pane will be committed. Other changes stay uncommitted.</p>
					<label>Commit message<textarea className="tool-other" aria-label="Commit message" autoFocus rows={3} value={commitDialog.message} disabled={committing} placeholder="The first line is the summary." onChange={(event) => setCommitDialog({ ...commitDialog, message: event.target.value, error: undefined })} /></label>
					{props.busy && <p className="note">Grok is still working. Wait for the turn to end, or ask Grok to commit.</p>}
					{loadingFiles && <p className="note" role="status">Wait for the changed files to finish loading.</p>}
					{commitDialog.error && <p className="note" role="alert">{commitDialog.error}</p>}
					<div className="actions" style={{ marginTop: 16 }}>
						<button type="button" className="texty" disabled={committing} onClick={() => setCommitDialog(null)}>Cancel</button>
						<button type="button" className="texty" disabled={committing || !!loadingFiles} onClick={() => { onAskGrok(commitDialog.request); setExcluded([]); setCommitDialog(null); }}>Ask Grok to commit</button>
						<button type="button" className={commitDialog.push ? `yes danger` : `yes`} disabled={committing || props.busy || loadingFiles || !commitDialog.message.trim()} onClick={() => void runCommit()}>{committing ? (commitDialog.push ? `Pushing…` : `Committing…`) : commitDialog.push ? `Commit and push` : `Commit`}</button>
					</div>
				</div>
			</div>
		)}
		</>
	);
}
