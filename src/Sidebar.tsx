import { useEffect, useState } from "react";
import type { ChatMessage, ProjectSeed, Session } from "./types";
import { askConfirm } from "./confirm";
import { caseKey, keyLabel } from "./data";

type GroupBy = "date" | "project" | "state" | "section" | "none";
type SortBy = "recency" | "name" | "created";
type StatusFilter = "active" | "archived" | "all";
type Activity = Record<string, "running" | "needs-you" | undefined>;
type RowState = "needs-you" | "running" | "unread" | "completed" | "idle";
type Submenu = "group" | "sort" | "status" | "days" | "move";
type Section = { id: string; name: string };
type SessionGroup = { id: string; label: string; items: Session[]; seed?: ProjectSeed; section?: Section };
interface SidebarView { groupBy: GroupBy; sortBy: SortBy; status: StatusFilter; days: number }

const viewKey = "grok-code.sidebar.v1";
const sectionsKey = "grok-code.sections.v1";
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_VIEW: SidebarView = { groupBy: "project", sortBy: "recency", status: "active", days: 0 };
const GROUP_LABEL: Record<GroupBy, string> = { date: "Date", project: "Project", state: "State", section: "Section", none: "None" };
const SORT_LABEL: Record<SortBy, string> = { recency: "Recency", name: "Name", created: "Created" };
const STATUS_LABEL: Record<StatusFilter, string> = { active: "Active", archived: "Archived", all: "All" };
const DAYS: [number, string][] = [[0, "Any time"], [1, "Last day"], [3, "Last 3 days"], [7, "Last 7 days"], [30, "Last 30 days"]];
const STATE_LABEL: Record<RowState, string> = { "needs-you": "Needs you", running: "Working", unread: "Unread", idle: "Idle", completed: "Completed" };
const STATE_ORDER: RowState[] = ["needs-you", "running", "unread", "idle", "completed"];

function readView(): SidebarView {
	try {
		const value = JSON.parse(localStorage.getItem(viewKey) ?? "null");
		return value && typeof value === "object" ? { ...DEFAULT_VIEW, ...value } : DEFAULT_VIEW;
	} catch {
		return DEFAULT_VIEW;
	}
}

function readSections(): Section[] {
	try {
		const value = JSON.parse(localStorage.getItem(sectionsKey) ?? "[]");
		return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string") : [];
	} catch {
		return [];
	}
}

function store(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// The sidebar layout stays in memory when storage is unavailable.
	}
}

function pathKey(folder: string) {
	return caseKey(folder.replace(/\//g, "\\").replace(/\\+$/, ""));
}

function stamp(session: Session) {
	return session.lastActivityAt ?? session.createdAt ?? 0;
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function ago(time: number, now = Date.now()): string {
	const minutes = Math.floor((now - time) / 60000);
	if (minutes < 1) { return "now"; }
	if (minutes < 60) { return `${minutes}m`; }
	if (minutes < 24 * 60) { return `${Math.floor(minutes / 60)}h`; }
	if (minutes < 7 * 24 * 60) { return weekday.format(time); }
	return monthDay.format(time);
}

function stateOf(session: Session, activity: Activity): RowState {
	const live = activity[session.id];
	if (live) { return live; }
	if (session.completed) { return "completed"; }
	return session.unread ? "unread" : "idle";
}

function dateBucket(session: Session) {
	const time = stamp(session);
	if (!time) { return "Older"; }
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const start = today.getTime();
	if (time >= start) { return "Today"; }
	if (time >= start - DAY) { return "Yesterday"; }
	if (time >= start - 7 * DAY) { return "Previous 7 days"; }
	if (time >= start - 30 * DAY) { return "Previous 30 days"; }
	return "Older";
}

function projectGroups(items: Session[], everyone: Session[]): SessionGroup[] {
	const keys: string[] = [];
	for (const session of everyone) {
		const key = pathKey(session.folder);
		if (!keys.includes(key)) { keys.push(key); }
	}
	const chosen = keys.map((key) => {
		const matches = everyone.filter((session) => pathKey(session.folder) === key);
		return matches.find((session) => session.branch === "main") ?? matches[0];
	});
	const nameCount = new Map<string, number>();
	for (const session of chosen) { nameCount.set(session.project, (nameCount.get(session.project) ?? 0) + 1); }
	return keys.map((key, index) => {
		const session = chosen[index];
		const shared = (nameCount.get(session.project) ?? 0) > 1;
		return {
			id: key,
			label: shared ? `${session.project} · ${session.folder}` : session.project,
			items: items.filter((item) => pathKey(item.folder) === key),
			seed: { project: session.project, folder: session.folder, branch: session.branch, worktree: session.worktree, environment: session.environment },
		};
	});
}

function groupSessions(list: Session[], everyone: Session[], view: SidebarView, activity: Activity, sections: Section[]): SessionGroup[] {
	if (view.groupBy === "none") { return [{ id: "all", label: "Sessions", items: list }]; }
	if (view.groupBy === "project") { return projectGroups(list, everyone); }
	if (view.groupBy === "state") {
		return STATE_ORDER.filter((state) => list.some((session) => stateOf(session, activity) === state)).map((state) => ({
			id: state,
			label: STATE_LABEL[state],
			items: list.filter((session) => stateOf(session, activity) === state),
		}));
	}
	if (view.groupBy === "section") {
		const known = new Set(sections.map((section) => section.id));
		const loose = list.filter((session) => !session.sectionId || !known.has(session.sectionId));
		return [
			...sections.map((section) => ({ id: section.id, label: section.name, section, items: list.filter((session) => session.sectionId === section.id) })),
			...(loose.length ? [{ id: "no-section", label: "No section", items: loose }] : []),
		];
	}
	const buckets = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
	return buckets.filter((label) => list.some((session) => dateBucket(session) === label)).map((label) => ({
		id: label,
		label,
		items: list.filter((session) => dateBucket(session) === label),
	}));
}

// Lowercased message text. Messages are replaced, never changed in place, so each object is its own cache key.
const lowered = new WeakMap<ChatMessage, string>();

// The first saved message containing needle, as a one-line excerpt around the match.
export function textHit(messages: ChatMessage[] | undefined, needle: string) {
	for (const message of messages ?? []) {
		let lower = lowered.get(message);
		if (lower === undefined) {
			lower = message.text.toLowerCase();
			lowered.set(message, lower);
		}
		const at = lower.indexOf(needle);
		if (at < 0) { continue; }
		const start = Math.max(0, at - 24);
		return `${start ? "…" : ""}${message.text.slice(start, at + needle.length + 80).replace(/\s+/g, " ").trim()}`;
	}
	return undefined;
}

export function Sidebar({
	sessions,
	chats,
	activeId,
	query,
	activity,
	onQuery,
	onSelect,
	onNew,
	onNewIn,
	onPin,
	onArchive,
	onRename,
	onDelete,
	onMarkUnread,
	onMarkCompleted,
	onMove,
	onOpenWindow,
	onCopySessionId,
	onSettings,
	onCollapse,
	onNotice,
	account,
	recentUsd,
	onShortcuts,
	onOpenUrl,
	onSignOut,
	update,
	onUpdate,
}: {
	sessions: Session[];
	chats: Record<string, ChatMessage[]>;
	activeId: string;
	query: string;
	activity: Activity;
	onQuery: (value: string) => void;
	onSelect: (id: string, find?: string) => void;
	onNew: () => void;
	onNewIn: (seed: ProjectSeed) => void;
	onPin: (id: string) => void;
	onArchive: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	onMarkUnread: (id: string, unread: boolean) => void;
	onMarkCompleted: (id: string, completed: boolean) => void;
	onMove: (id: string, sectionId: string | undefined) => void;
	onOpenWindow: (id: string) => void;
	onCopySessionId: (agentSessionId: string) => void;
	onSettings: () => void;
	onCollapse: () => void;
	onNotice: (text: string) => void;
	account: GrokAccount | null | undefined;
	recentUsd: number | null;
	onShortcuts: () => void;
	onOpenUrl: (url: string) => void;
	onSignOut: () => void;
	update: { latest: string } | null;
	onUpdate: () => void;
}) {
	const [view, setView] = useState<SidebarView>(readView);
	const [sections, setSections] = useState<Section[]>(readSections);
	const [searchOpen, setSearchOpen] = useState(() => query !== "");
	const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
	const [sub, setSub] = useState<{ kind: Submenu; top: number; left: number } | null>(null);
	const [rowMenu, setRowMenu] = useState<{ id: string; top: number; left: number } | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [sectionMenu, setSectionMenu] = useState<{ id: string; top: number; left: number } | null>(null);
	const [accountMenu, setAccountMenu] = useState<{ bottom: number; left: number } | null>(null);
	const [now, setNow] = useState(Date.now());

	useEffect(() => { store(viewKey, view); }, [view]);
	useEffect(() => { store(sectionsKey, sections); }, [sections]);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60000);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		function onStorage(event: StorageEvent) {
			if (event.key === sectionsKey) { setSections(readSections()); }
		}
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	useEffect(() => {
		if (!menu && !rowMenu && !sectionMenu && !accountMenu) { return; }
		function onKey(event: KeyboardEvent) {
			if (event.key !== "Escape") { return; }
			event.stopPropagation();
			closeAll();
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [menu, rowMenu, sectionMenu, accountMenu]);

	const needle = query.trim().toLowerCase();
	const cutoff = view.days ? Date.now() - view.days * DAY : 0;
	const excerpts = new Map<string, string>();

	function shown(session: Session) {
		if (view.status === "active" && session.archived) { return false; }
		if (view.status === "archived" && !session.archived) { return false; }
		if (cutoff && stamp(session) < cutoff) { return false; }
		if (!needle) { return true; }
		if (`${session.title} ${session.project} ${session.folder}`.toLowerCase().includes(needle)) { return true; }
		const excerpt = textHit(chats[session.id], needle);
		if (excerpt !== undefined) { excerpts.set(session.id, excerpt); }
		return excerpt !== undefined;
	}

	function sorted(list: Session[]) {
		if (view.sortBy === "name") { return [...list].sort((a, b) => a.title.localeCompare(b.title)); }
		if (view.sortBy === "created") { return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)); }
		return [...list].sort((a, b) => stamp(b) - stamp(a));
	}

	const visible = sessions.filter(shown);
	const pinned = view.status === "archived" ? [] : sorted(visible.filter((session) => session.pinned && !session.archived));
	const rest = sorted(visible.filter((session) => !pinned.includes(session)));
	const grouped = groupSessions(rest, visible, view, activity, sections);

	function closeAll() {
		setMenu(null);
		setSub(null);
		setRowMenu(null);
		setSectionMenu(null);
		setAccountMenu(null);
	}

	function place(event: React.MouseEvent, width: number, height: number) {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height) : rect.bottom + 4;
		return { top, left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8) };
	}

	function openMenu(event: React.MouseEvent) {
		closeAll();
		setMenu(place(event, 248, 260));
	}

	function openSub(kind: Submenu, event: React.MouseEvent) {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const width = 200;
		const left = rect.right + 6 + width > window.innerWidth ? rect.left - width - 6 : rect.right + 6;
		setSub({ kind, top: rect.top - 4, left });
	}

	function openRow(sessionId: string, event: React.MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		closeAll();
		setRowMenu({ id: sessionId, ...place(event, 230, 320) });
	}

	function pick(patch: Partial<SidebarView>) {
		setView((current) => ({ ...current, ...patch }));
		closeAll();
	}

	function addSection(moveId?: string) {
		const id = `sec-${Date.now()}`;
		setSections((current) => [...current, { id, name: "New section" }]);
		if (moveId) { onMove(moveId, id); }
		setView((current) => ({ ...current, groupBy: "section" }));
		setRenaming(`section:${id}`);
		closeAll();
	}

	function rowProps(session: Session) {
		return {
			session,
			now,
			excerpt: excerpts.get(session.id),
			state: stateOf(session, activity),
			active: session.id === activeId,
			menuOpen: rowMenu?.id === session.id,
			renaming: renaming === session.id,
			onSelect: (id: string, event: React.MouseEvent) => {
				if (event.ctrlKey || event.metaKey) { onOpenWindow(id); return; }
				onSelect(id, excerpts.has(id) ? query.trim() : undefined);
			},
			onOpenMenu: openRow,
			onRename: (title: string | null) => {
				if (title) { onRename(session.id, title); }
				setRenaming(null);
			},
			onStartRename: () => setRenaming(session.id),
		};
	}

	const rowSession = rowMenu ? sessions.find((session) => session.id === rowMenu.id) : undefined;
	const nothing = pinned.length === 0 && grouped.every((group) => group.items.length === 0);

	return (
		<aside className="sidebar">
			<div className="side-tools">
				<button className="new-btn" aria-label="New session" title={keyLabel("New session (Ctrl+N)")} onClick={onNew}>
					<PlusIcon /> New session
				</button>
				<span className="spacer" />
				<button className="side-icon" aria-label="Search sessions" title="Search sessions" onClick={() => setSearchOpen((value) => !value || !!query)}>
					<SearchIcon />
				</button>
				<button className="side-icon" aria-label="Filter and group" title="Filter and group" aria-expanded={menu !== null} onClick={openMenu}>
					<SlidersIcon />
				</button>
			</div>
			{searchOpen && (
				<div className="side-search">
					<input
						aria-label="Search sessions"
						placeholder="Search sessions"
						value={query}
						autoFocus
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onQuery(""); setSearchOpen(false); } }}
					/>
				</div>
			)}
			{(view.status !== "active" || view.days > 0) && (
				<div className="side-filter meta">
					{STATUS_LABEL[view.status]}{view.days ? ` · ${DAYS.find(([days]) => days === view.days)?.[1] ?? ""}` : ""}
					<button className="texty" onClick={() => setView((current) => ({ ...current, status: "active", days: 0 }))}>Clear</button>
				</div>
			)}
			<div className="session-scroll" onKeyDown={(event) => {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") { return; }
				const target = event.target as HTMLElement;
				if (!target.matches("button.session-hit")) { return; }
				const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".session-hit"));
				const index = rows.indexOf(target as HTMLButtonElement);
				if (index < 0) { return; }
				event.preventDefault();
				rows[Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1)].focus();
			}}>
				{pinned.length > 0 && <div className="group-label">Pinned</div>}
				{pinned.map((session) => <Row key={session.id} {...rowProps(session)} />)}
				{grouped.map((group) => (
					<div key={group.id}>
						{group.seed && <ProjectHead label={group.label} seed={group.seed} onNewIn={onNewIn} />}
						{group.section && (
							<div className="group-head">
								{renaming === `section:${group.section.id}` ? (
									<InlineName
										label="Section name"
										value={group.section.name}
										onDone={(name) => {
											const id = group.section?.id;
											if (name && id) { setSections((current) => current.map((item) => (item.id === id ? { ...item, name } : item))); }
											setRenaming(null);
										}}
									/>
								) : (
									<span className="group-label" onDoubleClick={() => setRenaming(`section:${group.section?.id}`)}>{group.label}</span>
								)}
								<button className="side-icon" aria-label={`Actions for section ${group.label}`} onClick={(event) => { const id = group.section?.id ?? ""; closeAll(); setSectionMenu({ id, ...place(event, 200, 100) }); }}>⋯</button>
							</div>
						)}
						{!group.seed && !group.section && <div className="group-label">{group.label}</div>}
						{group.items.map((session) => <Row key={session.id} {...rowProps(session)} />)}
					</div>
				))}
				{nothing && <p className="note">{needle ? "No sessions match." : view.status === "archived" ? "No archived sessions." : "No sessions yet."}</p>}
			</div>
			<div className="side-foot">
				<button
					className="account-btn"
					aria-label={update ? `Account and settings, version ${update.latest} available` : "Account and settings"}
					aria-expanded={accountMenu !== null}
					onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						closeAll();
						setAccountMenu({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
					}}
				>
					<span className="avatar">{(account?.email || "G").charAt(0).toUpperCase()}</span>
					<span className="who">{account?.email || (account === null ? "Signed out" : "Grok")}{account?.plan && <small>{account.plan}</small>}{update && <small className="update-flag">Update available · {update.latest}</small>}</span>
				</button>
				<button className="side-icon" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onCollapse}>«</button>
			</div>
			{(menu || rowMenu || sectionMenu || accountMenu) && (
				<button className="menu-back" aria-label="Close menu" onClick={closeAll} />
			)}
			{accountMenu && (
				<div className="row-pop account-menu" style={{ bottom: accountMenu.bottom, left: accountMenu.left }} role="menu" aria-label="Account">
					<div className="account-head">
						<b>{account ? account.email || "Signed in to Grok" : account === null ? "Signed out" : "Grok account"}</b>
						{account && <span>{[account.plan, account.team].filter(Boolean).join(" · ")}</span>}
						{account === undefined && <span>Your account shows once Grok starts. Send a message to start it.</span>}
						{account === null && <span>Grok asks you to sign in when you next send a message.</span>}
						{recentUsd !== null && <span>Grok on this computer, last 7 days: ${recentUsd.toFixed(2)}</span>}
					</div>
					<hr />
					{update && <button onClick={() => { closeAll(); onUpdate(); }}>Update to {update.latest}…</button>}
					<button onClick={() => { closeAll(); onSettings(); }}>Settings<small>{keyLabel("Ctrl+,")}</small></button>
					<button onClick={() => { closeAll(); onShortcuts(); }}>Keyboard shortcuts<small>{keyLabel("Ctrl+/")}</small></button>
					<button onClick={() => { closeAll(); onOpenUrl("https://console.x.ai"); }}>Get xAI API keys<small>↗</small></button>
					<hr />
					<button disabled={account === null} onClick={() => { closeAll(); onSignOut(); }}>Sign out</button>
					{account?.version && <div className="account-foot">Grok {account.version}</div>}
				</div>
			)}
			{menu && (
				<div className="row-pop side-menu" style={{ top: menu.top, left: menu.left }} role="menu" aria-label="Filter and group">
					<Cascade label="Group by" value={GROUP_LABEL[view.groupBy]} open={sub?.kind === "group"} onOpen={(event) => openSub("group", event)} />
					<Cascade label="Sort by" value={SORT_LABEL[view.sortBy]} open={sub?.kind === "sort"} onOpen={(event) => openSub("sort", event)} />
					<Cascade label="Status" value={STATUS_LABEL[view.status]} open={sub?.kind === "status"} onOpen={(event) => openSub("status", event)} />
					<Cascade label="Last activity" value={DAYS.find(([days]) => days === view.days)?.[1] ?? "Any time"} open={sub?.kind === "days"} onOpen={(event) => openSub("days", event)} />
					<hr />
					<button onMouseEnter={() => setSub(null)} onClick={() => addSection()}>New section</button>
					<hr />
					<button onMouseEnter={() => setSub(null)} onClick={() => pick(DEFAULT_VIEW)}>Reset to defaults</button>
				</div>
			)}
			{menu && sub?.kind === "group" && <Choices top={sub.top} left={sub.left} label="Group by" options={Object.entries(GROUP_LABEL) as [GroupBy, string][]} value={view.groupBy} onPick={(groupBy) => pick({ groupBy })} />}
			{menu && sub?.kind === "sort" && <Choices top={sub.top} left={sub.left} label="Sort by" options={Object.entries(SORT_LABEL) as [SortBy, string][]} value={view.sortBy} onPick={(sortBy) => pick({ sortBy })} />}
			{menu && sub?.kind === "status" && <Choices top={sub.top} left={sub.left} label="Status" options={Object.entries(STATUS_LABEL) as [StatusFilter, string][]} value={view.status} onPick={(status) => pick({ status })} />}
			{menu && sub?.kind === "days" && <Choices top={sub.top} left={sub.left} label="Last activity" options={DAYS} value={view.days} onPick={(days) => pick({ days })} />}
			{sectionMenu && (
				<div className="row-pop" style={{ top: sectionMenu.top, left: sectionMenu.left }} role="menu">
					<button onClick={() => { setRenaming(`section:${sectionMenu.id}`); closeAll(); }}>Rename section</button>
					<button
						onClick={() => {
							const id = sectionMenu.id;
							for (const session of sessions) {
								if (session.sectionId === id) { onMove(session.id, undefined); }
							}
							setSections((current) => current.filter((item) => item.id !== id));
							closeAll();
						}}
					>
						Delete section
					</button>
				</div>
			)}
			{rowMenu && rowSession && (
				<div className="row-pop" style={{ top: rowMenu.top, left: rowMenu.left }} role="menu">
					<button onMouseEnter={() => setSub(null)} onClick={() => { setRenaming(rowSession.id); closeAll(); }}>Rename</button>
					{!rowSession.archived && <button onMouseEnter={() => setSub(null)} onClick={() => { onPin(rowSession.id); closeAll(); }}>{rowSession.pinned ? "Unpin" : "Pin"}</button>}
					<button onMouseEnter={() => setSub(null)} onClick={() => { onMarkUnread(rowSession.id, !rowSession.unread); closeAll(); }}>{rowSession.unread ? "Mark as read" : "Mark as unread"}</button>
					<button onMouseEnter={() => setSub(null)} onClick={() => { onMarkCompleted(rowSession.id, !rowSession.completed); closeAll(); }}>{rowSession.completed ? "Mark as not completed" : "Mark as completed"}</button>
					<Cascade label="Move to section" value="" open={sub?.kind === "move"} onOpen={(event) => openSub("move", event)} />
					<button onMouseEnter={() => setSub(null)} onClick={() => { onOpenWindow(rowSession.id); closeAll(); }}>Open in a new window</button>
					{rowSession.agentSessionId && <button onMouseEnter={() => setSub(null)} onClick={() => { onCopySessionId(rowSession.agentSessionId!); closeAll(); }}>Copy Grok session ID</button>}
					<hr />
					<button onMouseEnter={() => setSub(null)} onClick={() => { onArchive(rowSession.id); closeAll(); }}>{rowSession.archived ? "Unarchive" : "Archive"}</button>
					<button
						className="danger"
						onMouseEnter={() => setSub(null)}
						onClick={() => {
							const id = rowSession.id;
							closeAll();
							if (activity[id]) { onNotice("Stop this session before deleting it."); return; }
							void askConfirm({ title: `Delete "${rowSession.title}"?`, body: "Its transcript is removed from this app and cannot be restored.", ok: "Delete", danger: true }).then((yes) => {
								if (yes) { onDelete(id); }
							});
						}}
					>
						Delete…
					</button>
				</div>
			)}
			{rowMenu && rowSession && sub?.kind === "move" && (
				<div className="row-pop" style={{ top: sub.top, left: sub.left }} role="menu" aria-label="Move to section">
					{sections.map((section) => (
						<button key={section.id} className={rowSession.sectionId === section.id ? "check-row on" : "check-row"} onClick={() => { onMove(rowSession.id, section.id); closeAll(); }}>
							<span>{section.name}</span>
							{rowSession.sectionId === section.id && <span className="check">✓</span>}
						</button>
					))}
					{sections.length > 0 && <hr />}
					<button onClick={() => addSection(rowSession.id)}>New section…</button>
					{rowSession.sectionId && <button onClick={() => { onMove(rowSession.id, undefined); closeAll(); }}>Remove from section</button>}
				</div>
			)}
		</aside>
	);
}

function Cascade({ label, value, open, onOpen }: { label: string; value: string; open: boolean; onOpen: (event: React.MouseEvent) => void }) {
	return (
		<button className={open ? "cascade on" : "cascade"} aria-haspopup="menu" aria-expanded={open} onMouseEnter={onOpen} onClick={onOpen}>
			<span>{label}</span>
			<span className="menu-value">{value} ›</span>
		</button>
	);
}

function Choices<T extends string | number>({ top, left, label, options, value, onPick }: { top: number; left: number; label: string; options: [T, string][]; value: T; onPick: (value: T) => void }) {
	return (
		<div className="row-pop" style={{ top, left }} role="menu" aria-label={label}>
			{options.map(([id, text]) => (
				<button key={String(id)} className={value === id ? "check-row on" : "check-row"} role="menuitemradio" aria-checked={value === id} onClick={() => onPick(id)}>
					<span>{text}</span>
					{value === id && <span className="check">✓</span>}
				</button>
			))}
		</div>
	);
}

function InlineName({ label, value, onDone }: { label: string; value: string; onDone: (name: string | null) => void }) {
	return (
		<input
			className="inline-name"
			aria-label={label}
			defaultValue={value}
			autoFocus
			onFocus={(event) => event.target.select()}
			onBlur={(event) => onDone(event.target.value.trim() || null)}
			onKeyDown={(event) => {
				if (event.key === "Enter") { (event.target as HTMLInputElement).blur(); }
				if (event.key === "Escape") { event.stopPropagation(); onDone(null); }
			}}
		/>
	);
}

function ProjectHead({ label, seed, onNewIn }: { label: string; seed: ProjectSeed; onNewIn: (seed: ProjectSeed) => void }) {
	return (
		<div className="group-head">
			<span className="group-label" title={seed.folder}>{label}</span>
			<button className="side-icon" aria-label={`New session in ${label}`} title={`New session in ${seed.folder}`} onClick={() => onNewIn(seed)}>
				<PlusIcon />
			</button>
		</div>
	);
}

function Row({
	session,
	now,
	excerpt,
	state,
	active,
	menuOpen,
	renaming,
	onSelect,
	onOpenMenu,
	onRename,
	onStartRename,
}: {
	session: Session;
	now: number;
	excerpt?: string;
	state: RowState;
	active: boolean;
	menuOpen: boolean;
	renaming: boolean;
	onSelect: (id: string, event: React.MouseEvent) => void;
	onOpenMenu: (id: string, event: React.MouseEvent) => void;
	onRename: (title: string | null) => void;
	onStartRename: () => void;
}) {
	const time = stamp(session);
	const meta = [session.worktreeFolder ? session.branch : "", time ? ago(time, now) : ""].filter(Boolean).join(" · ");
	return (
		<div className={`session${active ? " active" : ""}${menuOpen ? " menu-open" : ""}${state === "unread" ? " unread" : ""}`} onContextMenu={(event) => onOpenMenu(session.id, event)}>
			<span className={`dot ${state}`} title={STATE_LABEL[state]} aria-hidden="true" />
			{renaming ? (
				<InlineName label="Session title" value={session.title} onDone={onRename} />
			) : (
				<button className="session-hit" title={`${session.title}\n${session.folder}${time ? `\n${new Date(time).toLocaleString()}` : ""}`} onClick={(event) => onSelect(session.id, event)} onDoubleClick={onStartRename}>
					<b>{session.title}</b>
					{state === "needs-you" ? <small className="needs-you">Needs you</small> : excerpt !== undefined ? <small className="session-meta">{excerpt}</small> : meta && <small className="session-meta">{meta}</small>}
				</button>
			)}
			<button className="icon-btn" aria-label={`Actions for ${session.title}`} aria-expanded={menuOpen} onClick={(event) => onOpenMenu(session.id, event)}>⋯</button>
		</div>
	);
}

function SlidersIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M5 2.5v11M11 2.5v11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
			<circle cx="5" cy="6" r="1.7" fill="var(--sidebar)" stroke="currentColor" strokeWidth="1.4" />
			<circle cx="11" cy="10" r="1.7" fill="var(--sidebar)" stroke="currentColor" strokeWidth="1.4" />
		</svg>
	);
}

function PlusIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
		</svg>
	);
}

function SearchIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
			<path d="M10.2 10.2 13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
		</svg>
	);
}
