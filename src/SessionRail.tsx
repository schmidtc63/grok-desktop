import { useState, type ReactNode } from "react";
import type { Session } from "./types";

const CHECK_LABEL: Record<PrCheck["state"], string> = { pass: "passed", fail: "failed", run: "running", wait: "waiting", skip: "skipped" };

function tokens(value: number) {
	return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value);
}

// Claude Code's context rows, in its order and colors; Grok's own parts take stepped grays, so each shows in the bar.
const CONTEXT_ROWS: { key: keyof ContextParts | "messages"; label: string; color: string }[] = [
	{ key: "messages", label: "Messages", color: "var(--blue)" },
	{ key: "tools", label: "System tools", color: "var(--accent)" },
	{ key: "skills", label: "Skills", color: "var(--green)" },
	{ key: "systemPrompt", label: "System prompt", color: "var(--muted)" },
	{ key: "rules", label: "Rules and memory", color: "color-mix(in srgb, var(--muted) 67%, var(--faint))" },
	{ key: "mcp", label: "MCP servers", color: "color-mix(in srgb, var(--muted) 33%, var(--faint))" },
	{ key: "workflows", label: "Workflows", color: "var(--faint)" },
];

export interface ContextRow { label: string; color: string; tokens: number }

// The live total split into rows. Grok's file estimates are scaled down when they would pass the real total.
export function contextRows(usage: GrokUsage, breakdown: ContextBreakdown | undefined) {
	const used = Math.max(0, usage.contextTokens);
	const fixed = breakdown ? Object.values(breakdown.parts).reduce((sum, value) => sum + value, 0) : 0;
	const scale = fixed > used ? used / fixed : 1;
	const sizes: Record<string, number> = { messages: Math.round(used - fixed * scale) };
	for (const [key, value] of Object.entries(breakdown?.parts ?? {})) { sizes[key] = Math.round(value * scale); }
	const rows: ContextRow[] = CONTEXT_ROWS.filter((row) => row.key === "messages" || sizes[row.key] > 0).map((row) => ({ label: breakdown || row.key !== "messages" ? row.label : "In use", color: row.color, tokens: sizes[row.key] ?? 0 }));
	const threshold = (breakdown?.autoCompactPercent ?? 85) / 100;
	const buffer = Math.round(usage.contextWindow * (1 - threshold));
	return {
		rows,
		buffer,
		free: Math.max(0, usage.contextWindow - used - buffer),
		untilCompact: Math.max(0, Math.round(usage.contextWindow * threshold) - used),
	};
}

export function SessionRail({
	session,
	diff,
	branch,
	pr,
	usage,
	breakdown,
	recentUsd,
	onOpenDiff,
	onCompact,
	onOpenUrl,
	onCreatePr,
	onMergeWhenReady,
}: {
	session: Session;
	diff: DiffSnapshot | undefined;
	branch: BranchInfo | undefined;
	pr: PrStatus | undefined;
	usage: GrokUsage | undefined;
	breakdown: ContextBreakdown | undefined;
	recentUsd: number | null;
	onOpenDiff: (file?: string) => void;
	onCompact: () => void;
	onOpenUrl: (url: string) => void;
	onCreatePr: () => Promise<{ ok: boolean; error?: string; message?: string }>;
	onMergeWhenReady: () => Promise<{ ok: boolean; error?: string; message?: string }>;
}) {
	const [prMenu, setPrMenu] = useState(false);
	const [prNote, setPrNote] = useState("");
	const [working, setWorking] = useState(false);
	const files = diff?.files ?? [];
	const hasCounts = files.every((file) => file.additions !== undefined && file.deletions !== undefined);
	const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
	const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
	const open = pr?.ok ? pr.pr : null;
	const failed = open?.checks.filter((check) => check.state === "fail").length ?? 0;
	const running = open?.checks.filter((check) => check.state === "run" || check.state === "wait").length ?? 0;
	const passed = open?.checks.filter((check) => check.state === "pass").length ?? 0;
	const percent = usage ? Math.min(100, Math.round((usage.contextTokens / Math.max(1, usage.contextWindow)) * 100)) : null;

	function act(run: () => Promise<{ ok: boolean; error?: string; message?: string }>, done: string) {
		setWorking(true);
		setPrMenu(false);
		void run().then((result) => setPrNote(result.ok ? (result.message || done) : (result.error || "That did not work."))).finally(() => setWorking(false));
	}

	return (
		<aside className="session-rail" aria-label="Session details">
			<RailCard title="Changes" extra={files.length && hasCounts ? <span className="meta"><span className="add">+{additions}</span> <span className="del">−{deletions}</span></span> : null}>
				{!diff && <p className="meta">Reading the working tree…</p>}
				{diff && !diff.ok && <p className="note">{diff.error}</p>}
				{diff?.ok && diff.repo === false && <p className="note">This folder is not a git checkout.</p>}
				{diff?.ok && diff.repo !== false && files.length === 0 && <p className="meta">No uncommitted changes.</p>}
				{files.length > 0 && (
					<>
						<button className="rail-counts" onClick={() => onOpenDiff()}>
							{hasCounts && <span className="add">+{additions}</span>}
							{hasCounts && <span className="del">−{deletions}</span>}
							<span className="meta">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
						</button>
						{files.slice(0, 5).map((file) => (
							<button key={file.path} className="rail-file" title={file.path} onClick={() => onOpenDiff(file.path)}>
								<span>{file.path}</span>
								{file.additions !== undefined && file.deletions !== undefined && <span className="meta">+{file.additions} −{file.deletions}</span>}
							</button>
						))}
						{files.length > 5 && <button className="texty" onClick={() => onOpenDiff()}>{files.length - 5} more</button>}
					</>
				)}
				{open && (
					<div className="rail-pr">
						<div className="rail-pr-hd">
							<button className="texty" title={open.url} onClick={() => onOpenUrl(open.url)}>PR #{open.number}</button>
							<span className={`chip-tag ${open.state.toLowerCase()}`}>{open.isDraft ? "Draft" : open.state.toLowerCase()}</span>
							<span className="spacer" />
							<button className="icon-btn" aria-label="Pull request actions" aria-expanded={prMenu} onClick={() => setPrMenu((value) => !value)}>⋯</button>
						</div>
						<span className="rail-pr-title">{open.title}</span>
						{open.checks.length > 0 && (
							<span className={failed ? "meta del" : "meta"}>
								{failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : running ? `${running} check${running === 1 ? "" : "s"} running` : passed > 0 ? "Checks passed" : "Checks skipped"}
							</span>
						)}
						{open.checks.filter((check) => check.state === "fail").slice(0, 3).map((check) => (
							<button key={check.name} className="rail-file" title={check.url} onClick={() => { if (check.url) { onOpenUrl(check.url); } }}>
								<span>{check.name}</span>
								<span className="meta">{CHECK_LABEL[check.state]}</span>
							</button>
						))}
						{open.autoMerge && <span className="meta">Auto-merge on</span>}
						{prMenu && (
							<div className="rail-menu" role="menu">
								<button role="menuitem" onClick={() => { setPrMenu(false); onOpenUrl(open.url); }}>Open on GitHub</button>
								<button role="menuitem" disabled={open.autoMerge || working || open.state !== "OPEN"} onClick={() => act(onMergeWhenReady, "Auto-merge is on.")}>Merge when ready</button>
							</div>
						)}
					</div>
				)}
				{pr?.ok && !open && branch?.ok && branch.branch !== branch.base && (branch.ahead ?? 0) > 0 && (
					<button className="texty" disabled={working} onClick={() => act(onCreatePr, "Pull request opened.")}>{working ? "Creating…" : "Create PR"}</button>
				)}
				{pr && !pr.ok && pr.error && <p className="meta">{pr.error}</p>}
				{prNote && <p className="meta">{prNote}</p>}
			</RailCard>
			<RailCard title="Environment">
				<div className="rail-row">Local · This computer</div>
				<div className="rail-row" title={session.folder}>{session.folder}</div>
				{branch?.ok && branch.repo !== false && branch.branch ? (
					<div className="rail-row meta" title={branch.upstream ?? ""}>
						{branch.branch}
						{branch.base && branch.base !== branch.branch ? ` · ${branch.ahead ?? 0} ahead of ${branch.base}` : ""}
						{branch.behind ? ` · ${branch.behind} behind` : ""}
					</div>
				) : (
					<div className="rail-row meta">{session.branch}</div>
				)}
				{session.worktreeFolder && <div className="rail-row meta">Worktree session</div>}
			</RailCard>
			<RailCard title="Context" extra={percent !== null ? <span className="meta">{percent}%</span> : null}>
				{!usage && <p className="meta">Shown after Grok's first reply in this session.</p>}
				{usage && (() => {
					const split = contextRows(usage, breakdown);
					const share = (value: number) => `${((value / Math.max(1, usage.contextWindow)) * 100).toFixed(1)}%`;
					const all = [...split.rows, { label: "Autocompact buffer", color: "var(--line-strong)", tokens: split.buffer }, { label: "Free space", color: "var(--line)", tokens: split.free }];
					return (
						<>
							<div className="ctx-head"><span>{percent}% used</span><span className="meta">{tokens(usage.contextTokens)} / {tokens(usage.contextWindow)}</span></div>
							<div className="ctx-bar" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
								{all.map((row) => <span key={row.label} style={{ width: share(row.tokens), background: row.color }} />)}
							</div>
							<div className="ctx-rows" title={breakdown ? "Estimated from the files Grok keeps for this session" : undefined}>
								{all.map((row) => (
									<div className="ctx-row" key={row.label}>
										<span className="ctx-dot" style={{ background: row.color }} aria-hidden="true" />
										<span>{row.label}</span>
										<span>{tokens(row.tokens)}</span>
										<span>{share(row.tokens)}</span>
									</div>
								))}
							</div>
							<div className="rail-kv"><span>Model</span><span>{usage.model}</span></div>
							<div className="rail-kv"><span>Session cost</span><span>${(session.costUsd ?? 0).toFixed(2)}</span></div>
							{recentUsd !== null && <div className="rail-kv" title="Every Grok session on this computer, from Grok's own usage files"><span>Grok, last 7 days</span><span>${recentUsd.toFixed(2)}</span></div>}
							<div className="ctx-foot">
								<span className="meta">{tokens(split.untilCompact)} until auto-compact</span>
								<button className="texty" title="Ask Grok to summarize the conversation so far" onClick={onCompact}>Compact session</button>
							</div>
						</>
					);
				})()}
				{!usage && <button className="texty" disabled title="Available after Grok's first reply">Compact session</button>}
			</RailCard>
		</aside>
	);
}

function RailCard({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(true);
	return (
		<section className="rail-card">
			<button className="rail-hd" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span>{open ? "▾" : "▸"} {title}</span>
				{extra}
			</button>
			{open && <div className="rail-bd">{children}</div>}
		</section>
	);
}
