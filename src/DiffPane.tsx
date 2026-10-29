import { Fragment, useState } from "react";

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
	onAddComment: (comment: Omit<DiffComment, "id">) => void;
	onRemoveComment: (id: string) => void;
	onSendComments: () => void;
	branch: { branch: string; base: string; ahead: number } | undefined;
	pr: PrInfo | null | undefined;
	prError?: string;
	onCreatePr: () => Promise<{ ok: boolean; error?: string; url?: string }>;
	onMergeWhenReady: () => Promise<{ ok: boolean; error?: string }>;
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
			setNote(result.ok ? `Auto-merge is on. GitHub merges this pull request when its checks pass.` : (result.error || `Auto-merge could not be turned on.`));
		}, () => setNote(`Auto-merge could not be turned on.`)).finally(() => setMerging(false));
	}

	const createdNumber = created ? /\/pull\/(\d+)/.exec(created)?.[1] : undefined;
	const stateLabel = pr ? prStateLabel(pr) : ``;
	return (
		<div className="dp-pr" onKeyDown={(event) => { if (event.key === `Escape` && menu) { setMenu(null); } }}>
			{!pr && <span className="meta dp-branch" title={`${branch.branch} into ${branch.base}`}>{branch.branch} → {branch.base}{branch.ahead > 0 ? ` · ${branch.ahead} ahead` : ``}</span>}
			{pr === undefined && <span className="meta">Checking for a pull request…</span>}
			{pr === null && created === null && (
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
	const { snapshot, scope, onScope, commits, selectedFile, onSelectFile, onRefresh, onRevert, comments, onAddComment, onRemoveComment, onSendComments, onOpenFile, onFileMenu, onClose } = props;
	const [menu, setMenu] = useState<Spot | null>(null);
	const [note, setNote] = useState(``);
	const [reverting, setReverting] = useState(false);
	const [compose, setCompose] = useState<Compose | null>(null);
	const files = snapshot?.files ?? [];
	const selected = files.some((file) => file.path === selectedFile) ? selectedFile : files[0]?.path ?? ``;
	const current = files.find((file) => file.path === selected);

	function revert() {
		setMenu(null);
		if (!selected || !window.confirm(`Revert ${selected} to the last commit? This cannot be undone.`)) {
			return;
		}
		const file = selected;
		setReverting(true);
		setNote(``);
		void onRevert(file).then((result) => {
			setNote(result.ok ? `Restored ${file} to the last commit.` : (result.error || `That file could not be restored.`));
		}, () => setNote(`That file could not be restored.`)).finally(() => setReverting(false));
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
		if (event.ctrlKey && !text) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (text) {
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
		<section
			className="pane"
			aria-label="Changes"
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key === `Escape` && menu) {
					setMenu(null);
					return;
				}
				if (event.ctrlKey && event.key === `Enter` && comments.length > 0) {
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
				<button className="icon-btn" aria-label="Changes menu" aria-haspopup="menu" onClick={(event) => setMenu(menuSpot(event))}>⋮</button>
				<button className="pane-x" aria-label="Close pane" onClick={onClose}>×</button>
			</div>
			{menu && (
				<>
					<button className="menu-back" aria-label="Close menu" onClick={() => setMenu(null)} />
					<div className="row-pop" role="menu" aria-label="Changes menu" style={{ top: menu.top, left: menu.left }}>
						<button role="menuitem" onClick={() => { setMenu(null); onRefresh(); }}>Refresh</button>
						<button role="menuitem" disabled={!selected || reverting} onClick={revert}>{reverting ? `Restoring…` : `Revert file…`}</button>
					</div>
				</>
			)}
			<PrStrip branch={props.branch} pr={props.pr} prError={props.prError} onCreatePr={props.onCreatePr} onMergeWhenReady={props.onMergeWhenReady} />
			<div className="pane-bd">
				{!snapshot && <p className="meta">Reading the working tree…</p>}
				{snapshot && !snapshot.ok && <p className="note">{snapshot.error || `The changes could not be read.`}</p>}
				{snapshot?.ok && snapshot.repo === false && <p className="note">This folder is not a git checkout.</p>}
				{snapshot?.ok && snapshot.repo !== false && files.length === 0 && <p className="note">No changes.</p>}
				{snapshot?.truncated && <p className="note">The rest of the diff was left out.</p>}
				{note && <p className="note">{note}</p>}
				{files.length > 0 && (
					<div className="file-list">
						{files.map((file) => (
							<button
								key={file.path}
								className={file.path === selected ? `file-row on` : `file-row`}
								title={file.path}
								onClick={() => onSelectFile(file.path)}
								onDoubleClick={() => onOpenFile(file.path)}
								onContextMenu={(event) => { event.preventDefault(); onFileMenu(file.path, event); }}
							>
								<span>{file.path}</span>
								<span className="dp-stat"><span className="dp-adds">+{file.additions}</span> <span className="dp-dels">−{file.deletions}</span></span>
							</button>
						))}
					</div>
				)}
				{current?.hunks.map((hunk) => renderHunk(current.path, hunk))}
			</div>
			{comments.length > 0 && (
				<div className="dp-foot">
					<span className="meta">{comments.length === 1 ? `1 comment` : `${comments.length} comments`}</span>
					<button className="texty dp-send" onClick={onSendComments}>Send to Grok (Ctrl+Enter)</button>
				</div>
			)}
		</section>
	);
}
