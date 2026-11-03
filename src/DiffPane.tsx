import { Fragment, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import { keyLabel, modKey } from "./data";

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
	snapshot: DiffSnapshot | undefined;
	scope: string;
	onScope: (scope: string) => void;
	commits: { sha: string; short: string; subject: string }[];
	selectedFile: string;
	onSelectFile: (file: string) => void;
	onRefresh: () => void;
	onRevert: (file: string) => Promise<{ ok: boolean; error?: string }>;
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
type Spot = { top: number; left: number };
type Compose = { file: string; side: "old" | "new"; line: number; text: string };

// Staged hunks carry a "Staged " label before the @@ header.
const HUNK_HEAD = /^(?:\w+ )?@@ -(\d+)(?:,\d+)? \+(\d+)/;
const CHECK_LABEL: Record<CheckState, string> = { pass: "passed", run: "running", wait: "waiting", fail: "failed", skip: "skipped" };

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
	return file.hunks.map((hunk) => hunk.id).join(`\n`);
}

export function canMarkViewed(file: DiffFile): boolean {
	return file.hunks.some((hunk) => hunk.reviewable !== false);
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
	return { top: rect.bottom + 4, left: Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8) };
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
	return (
		<div className="dp-pr" onKeyDown={(event) => { if (event.key === `Escape` && menu) { setMenu(null); } }}>
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
					<button className="icon-btn" aria-label="Pull request menu" aria-haspopup="menu" onClick={(event) => setMenu(menuSpot(event))}>⋮</button>
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
					<button className="menu-back" aria-label="Close menu" onClick={() => setMenu(null)} />
					<div className="row-pop" role="menu" aria-label="Pull request menu" style={{ top: menu.top, left: menu.left }}>
						<button role="menuitem" disabled={pr.autoMerge || merging} onClick={merge}>{pr.autoMerge ? `Auto-merge on` : merging ? `Turning on auto-merge…` : `Merge when ready`}</button>
					</div>
				</>
			)}
			{note && <p className="note">{note}</p>}
			{prError && <p className="note">{prError}</p>}
		</div>
	);
}

export function DiffPane(props: DiffPaneProps) {
	const { snapshot, scope, onScope, commits, selectedFile, onSelectFile, onRefresh, onRevert, comments, onAddComment, onRemoveComment, onSendComments, onAskGrok, onOpenFile, onFileMenu, onClose } = props;
	const [menu, setMenu] = useState<Spot | null>(null);
	const [note, setNote] = useState(``);
	const [reverting, setReverting] = useState(false);
	const [compose, setCompose] = useState<Compose | null>(null);
	const sendAfterAdd = useRef(false);
	useEffect(() => {
		if (sendAfterAdd.current) {
			sendAfterAdd.current = false;
			onSendComments();
		}
	}, [comments]);
	const files = snapshot?.files ?? [];
	const selected = files.some((file) => file.path === selectedFile) ? selectedFile : files[0]?.path ?? ``;
	const current = files.find((file) => file.path === selected);
	const [review, setReview] = useState(false);
	// Unchecked paths are kept, so a file that appears later is included; a path no longer in the list counts for nothing.
	const [excluded, setExcluded] = useState<string[]>([]);
	const paneRef = useRef<HTMLElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const index = files.findIndex((file) => file.path === selected);
	const isViewed = (file: DiffFile) => props.viewed[file.path] === fileFingerprint(file);
	const viewedCount = files.filter(isViewed).length;
	const canCommit = snapshot?.ok && snapshot.repo !== false && scope === `uncommitted` && files.length > 0;
	const picked = files.filter((file) => !excluded.includes(file.path));
	const none = picked.length === 0;
	useEffect(() => { if (review) { paneRef.current?.focus(); } }, [review]);
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
		setExcluded((list) => list.includes(file) ? list.filter((item) => item !== file) : [...list, file]);
	}

	function commit(push: boolean) {
		const some = picked.length < files.length;
		const count = `${picked.length} of ${files.length} files`;
		// A renamed file also names its old path, or the commit would leave the old one behind.
		const names = picked.flatMap((file) => file.from ? [file.from, file.path] : [file.path]).map((name) => `\`${name}\``).join(`, `);
		const only = `Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: ${names}.`;
		const ask = push
			? { title: some ? `Commit ${count} and push?` : `Commit and push?`, body: some ? `Grok commits only the checked files and pushes the branch to its remote.` : `Grok commits all uncommitted changes and pushes the branch to its remote.`, ok: `Commit and push`, danger: true }
			: { title: some ? `Commit ${count}?` : `Commit all uncommitted changes?`, body: some ? `Grok writes the commit message and commits only the checked files. Nothing is pushed.` : `Grok writes the commit message and commits. Nothing is pushed.`, ok: `Commit` };
		const request = push
			? (some ? `${only} Then push the branch.` : `Commit the current uncommitted changes in this repository with a clear commit message, then push the branch.`)
			: (some ? `${only} Don't push.` : `Commit the current uncommitted changes in this repository with a clear commit message. Don't push.`);
		// The files left out stay uncommitted, so they start checked for the next commit.
		void askConfirm(ask).then((yes) => {
			if (yes) {
				onAskGrok(request);
				setExcluded([]);
			}
		});
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
										<button className="dp-plus" aria-label={`Comment on line ${at}`} onClick={() => setCompose({ file, side, line: at, text: `` })}>+</button>
									)}
								</span>
								<span className="dp-text">{row.kind === `add` ? `+` : row.kind === `del` ? `-` : ` `}{row.text}</span>
							</div>
							{notes.map((comment) => (
								<div className="dp-note" key={comment.id}>
									<span>{comment.text}</span>
									<button aria-label="Remove comment" onClick={() => onRemoveComment(comment.id)}>×</button>
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
		{review && <div className="fp-backdrop" aria-hidden="true" onClick={() => setReview(false)} />}
		<section
			ref={paneRef}
			className={review ? `pane fp-expanded dp-review` : `pane`}
			aria-label="Changes"
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key === `Escape` && menu) {
					setMenu(null);
					return;
				}
				const typing = (event.target as HTMLElement).tagName === `TEXTAREA` || (event.target as HTMLElement).tagName === `SELECT`;
				if (event.key === `Escape` && review && !event.defaultPrevented) {
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
				<span className="spacer" />
				<button className="icon-btn" aria-label={review ? `Return Changes to the side` : `Review in a large view`} title={review ? `Return to the side (Esc)` : `Review`} aria-pressed={review} onClick={() => setReview((value) => !value)}>{review ? `⤡` : `⤢`}</button>
				<button className="icon-btn" aria-label="Changes menu" aria-haspopup="menu" onClick={(event) => setMenu(menuSpot(event))}>⋮</button>
				<button className="pane-x" aria-label="Close pane" onClick={onClose}>×</button>
			</div>
			{menu && (
				<>
					<button className="menu-back" aria-label="Close menu" onClick={() => setMenu(null)} />
					<div className="row-pop" role="menu" aria-label="Changes menu" style={{ top: menu.top, left: menu.left }}>
						<button role="menuitem" onClick={() => { setMenu(null); onRefresh(); }}>Refresh</button>
						<button role="menuitem" disabled={!selected || reverting || scope !== `uncommitted`} title={scope !== `uncommitted` ? `Switch to Uncommitted changes to revert a file` : undefined} onClick={revert}>{reverting ? `Restoring…` : `Revert file…`}</button>
					</div>
				</>
			)}
			<PrStrip branch={props.branch} pr={props.pr} prError={props.prError} onCreatePr={props.onCreatePr} onMergeWhenReady={props.onMergeWhenReady} />
			<div className={review ? `pane-bd` : `pane-bd dp-side`}>
				{!snapshot && <p className="meta">Reading the working tree…</p>}
				{snapshot && !snapshot.ok && <p className="note">{snapshot.error || `The changes could not be read.`}</p>}
				{snapshot?.ok && snapshot.repo === false && <p className="note">This folder is not a git checkout.</p>}
				{snapshot?.ok && snapshot.repo !== false && files.length === 0 && <p className="note">No changes.</p>}
				{snapshot?.truncated && <p className="note">The rest of the diff was left out.</p>}
				{note && <p className="note">{note}</p>}
				{canCommit && (
					<div className="dp-commit">
						<button className="texty" disabled={none} title={none ? `Check at least one file.` : undefined} onClick={() => commit(false)}>Commit</button>
						<button className="texty" disabled={none} title={none ? `Check at least one file.` : undefined} onClick={() => commit(true)}>Commit and push</button>
					</div>
				)}
				{files.length > 0 && (
					<div className="dp-split">
						<div className="dp-files">
							<p className="meta dp-progress">{viewedCount} of {files.length} viewed{snapshot?.truncated ? ` · more files were left out` : ``}</p>
							<div className="file-list">
								{files.map((file) => (
									<div className="dp-file" key={file.path}>
										{canCommit && <input type="checkbox" className="dp-pick" aria-label={`Include ${file.path} in the commit`} checked={!excluded.includes(file.path)} onChange={() => togglePick(file.path)} />}
										<button
											className={file.path === selected ? `file-row on` : `file-row`}
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
									<button className="texty" disabled={index <= 0} onClick={() => go(-1)} title="Previous file (Alt+Up)">‹ Previous</button>
									<button className="texty" disabled={index < 0 || index >= files.length - 1} onClick={() => go(1)} title="Next file (Alt+Down)">Next ›</button>
									<span className="dp-nav-path" title={current.path}>{current.path}</span>
									<label className="dp-viewed-toggle" title={canMarkViewed(current) ? undefined : `This entry has no content to review`}>
										<input type="checkbox" checked={isViewed(current)} disabled={!canMarkViewed(current)} onChange={() => toggleViewed(current)} /> Viewed
									</label>
								</div>
							)}
							{current?.hunks.map((hunk) => renderHunk(current.path, hunk))}
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
		</>
	);
}
