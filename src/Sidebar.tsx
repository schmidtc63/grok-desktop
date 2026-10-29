import { useEffect, useState } from "react";
import type { ProjectSeed, Session } from "./types";

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
	return folder.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function stamp(session: Session) {
	return session.lastActivityAt ?? session.createdAt ?? 0;
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

export function Sidebar({
	sessions,
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
	onSettings,
	onCollapse,
	onNotice,
}: {
	sessions: Session[];
	activeId: string;
	query: string;
	activity: Activity;
	onQuery: (value: string) => void;
	onSelect: (id: string) => void;
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
	onSettings: () => void;
	onCollapse: () => void;
	onNotice: (text: string) => void;
}) {
	const [view, setView] = useState<SidebarView>(readView);
	const [sections, setSections] = useState<Section[]>(readSections);
	const [searchOpen, setSearchOpen] = useState(false);
	const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
	const [sub, setSub] = useState<{ kind: Submenu; top: number; left: number } | null>(null);
	const [rowMenu, setRowMenu] = useState<{ id: string; top: number; left: number } | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [sectionMenu, setSectionMenu] = useState<{ id: string; top: number; left: number } | null>(null);

	useEffect(() => { store(viewKey, view); }, [view]);
	useEffect(() => { store(sectionsKey, sections); }, [sections]);

	useEffect(() => {
		if (!menu && !rowMenu && !sectionMenu) { return; }
		function onKey(event: KeyboardEvent) {
			if (event.key !== "Escape") { return; }
			event.stopPropagation();
			closeAll();
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [menu, rowMenu, sectionMenu]);

	const needle = query.trim().toLowerCase();
	const cutoff = view.days ? Date.now() - view.days * DAY : 0;

	function shown(session: Session) {
		if (view.status === "active" && session.archived) { return false; }
		if (view.status === "archived" && !session.archived) { return false; }
		if (cutoff && stamp(session) < cutoff) { return false; }
		if (!needle) { return true; }
		return `${session.title} ${session.project} ${session.folder}`.toLowerCase().includes(needle);
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
			state: stateOf(session, activity),
			active: session.id === activeId,
			menuOpen: rowMenu?.id === session.id,
			renaming: renaming === session.id,
			onSelect: (id: string, event: React.MouseEvent) => {
				if (event.ctrlKey || event.metaKey) { onOpenWindow(id); return; }
				onSelect(id);
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
				<button className="new-btn" aria-label="New session" title="New session (Ctrl+N)" onClick={onNew}>
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
			<div className="session-scroll">
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
				<button className="side-icon" aria-label="Settings" title="Settings (Ctrl+,)" onClick={onSettings}>
					<GearIcon />
				</button>
				<span className="spacer" />
				<button className="side-icon" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onCollapse}>«</button>
			</div>
			{(menu || rowMenu || sectionMenu) && (
				<button className="menu-back" aria-label="Close menu" onClick={closeAll} />
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
					<hr />
					<button onMouseEnter={() => setSub(null)} onClick={() => { onArchive(rowSession.id); closeAll(); }}>{rowSession.archived ? "Unarchive" : "Archive"}</button>
					<button
						className="danger"
						onMouseEnter={() => setSub(null)}
						onClick={() => {
							const id = rowSession.id;
							closeAll();
							if (activity[id]) { onNotice("Stop this session before deleting it."); return; }
							if (window.confirm(`Delete "${rowSession.title}"? Its transcript is removed from Grok Desktop and cannot be restored.`)) { onDelete(id); }
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
	state: RowState;
	active: boolean;
	menuOpen: boolean;
	renaming: boolean;
	onSelect: (id: string, event: React.MouseEvent) => void;
	onOpenMenu: (id: string, event: React.MouseEvent) => void;
	onRename: (title: string | null) => void;
	onStartRename: () => void;
}) {
	return (
		<div className={`session${active ? " active" : ""}${menuOpen ? " menu-open" : ""}${state === "unread" ? " unread" : ""}`} onContextMenu={(event) => onOpenMenu(session.id, event)}>
			<span className={`dot ${state}`} title={STATE_LABEL[state]} aria-hidden="true" />
			{renaming ? (
				<InlineName label="Session title" value={session.title} onDone={onRename} />
			) : (
				<button className="session-hit" title={`${session.title}\n${session.folder}`} onClick={(event) => onSelect(session.id, event)} onDoubleClick={onStartRename}>
					<b>{session.title}</b>
					{state === "needs-you" && <small>Needs you</small>}
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

function GearIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
			<path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
		</svg>
	);
}
