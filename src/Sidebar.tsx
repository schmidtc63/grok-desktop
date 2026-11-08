import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ProjectSeed, Session } from "./types";
import { askConfirm } from "./confirm";
import { caseKey, keyLabel } from "./data";
import { Icon } from "./Icon";
import { PopupMenu } from "./PopupMenu";

type GroupBy = "date" | "project" | "state" | "section" | "none";
type SortBy = "recency" | "name" | "created";
type StatusFilter = "active" | "archived" | "all";
type Activity = Record<string, "running" | "needs-you" | undefined>;
type RowState = "needs-you" | "failed" | "running" | "unread" | "completed" | "idle";
type Submenu = "group" | "sort" | "status" | "days" | "move";
type Section = { id: string; name: string };
type SessionGroup = { id: string; label: string; items: Session[]; seed?: ProjectSeed; section?: Section };
type CliPick = { id: string; title: string; folder: string; lastActive: number };
type MenuAnchor = { top: number; left: number; opener: HTMLElement };
type SubmenuAnchor = MenuAnchor & { kind: Submenu; focusOnOpen: boolean };
type CliList = MenuAnchor & { token: object; loading: boolean; error: string; sessions: CliPick[] };
interface SidebarView { groupBy: GroupBy; sortBy: SortBy; status: StatusFilter; days: number; collapsedProjects: string[]; collapsedParents: string[] }

const viewKey = "grok-code.sidebar.v1";
const sectionsKey = "grok-code.sections.v1";
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_VIEW: SidebarView = { groupBy: "project", sortBy: "recency", status: "active", days: 0, collapsedProjects: [], collapsedParents: [] };
const GROUP_LABEL: Record<GroupBy, string> = { date: "Date", project: "Project", state: "State", section: "Section", none: "None" };
const SORT_LABEL: Record<SortBy, string> = { recency: "Recency", name: "Name", created: "Created" };
const STATUS_LABEL: Record<StatusFilter, string> = { active: "Active", archived: "Archived", all: "All" };
const DAYS: [number, string][] = [[0, "Any time"], [1, "Last day"], [3, "Last 3 days"], [7, "Last 7 days"], [30, "Last 30 days"]];
const STATE_LABEL: Record<RowState, string> = { "needs-you": "Needs you", failed: "Failed", running: "Working", unread: "Unread", idle: "Idle", completed: "Completed" };
const STATE_ORDER: RowState[] = ["needs-you", "failed", "running", "unread", "idle", "completed"];

function readView(): SidebarView {
	try {
		const value = JSON.parse(localStorage.getItem(viewKey) ?? "null");
		if (!value || typeof value !== "object") { return DEFAULT_VIEW; }
		const savedIds = (ids: unknown) => Array.isArray(ids) ? ids.filter((id: unknown) => typeof id === "string") : [];
		return { ...DEFAULT_VIEW, ...value, collapsedProjects: savedIds(value.collapsedProjects), collapsedParents: savedIds(value.collapsedParents) };
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
	if (session.failed) { return "failed"; }
	return session.unread ? "unread" : "idle";
}

function hiddenActivity(items: Session[], activity: Activity): Activity[string] {
	let running = false;
	for (const item of items) {
		const status = activity[item.id];
		if (status === "needs-you") { return status; }
		if (status === "running") { running = true; }
	}
	return running ? "running" : undefined;
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

function projectParents(sessions: Session[]) {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const parents = new Map<string, Session>();
	for (const child of sessions) {
		if (!child.parentId || (child.pinned && !child.archived)) { continue; }
		const parent = byId.get(child.parentId);
		if (parent && !parent.archived && parent.id !== child.id) { parents.set(child.id, parent); }
	}
	return new Map([...parents].filter(([, parent]) => !parents.has(parent.id)));
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

function accountName(account: GrokAccount | null | undefined, signIn: "saved" | "key" | "none" | undefined, keySource: "app" | "env", menu: boolean) {
	if (signIn === "key") { return keySource === "app" ? "API key (saved in this app)" : "API key (XAI_API_KEY)"; }
	if (account?.email) { return account.email; }
	if (signIn === "saved") { return "Saved sign-in"; }
	if (account) { return menu ? "Signed in to Grok" : "Grok"; }
	if (account === null || signIn === "none") { return "Signed out"; }
	return menu ? "Grok account" : "Grok";
}

export function Sidebar({
	inert,
	sessions,
	chats,
	activeId,
	revealActiveOnMount,
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
	onExportMarkdown,
	onListCliSessions,
	onOpenCliSession,
	loopCounts,
	onSettings,
	onCollapse,
	onNotice,
	account,
	signIn,
	signInMode,
	keySource,
	keyIgnored,
	keyUnreadable,
	keyRejected,
	recentUsd,
	onShortcuts,
	onOpenUrl,
	onSignOut,
	update,
	onUpdate,
}: {
	inert?: boolean;
	sessions: Session[];
	chats: Record<string, ChatMessage[]>;
	activeId: string;
	revealActiveOnMount?: boolean;
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
	onExportMarkdown: (agentSessionId: string, title: string) => void;
	onListCliSessions: () => Promise<{ ok: boolean; error?: string; sessions?: CliPick[] }>;
	onOpenCliSession: (agentSessionId: string) => void;
	loopCounts?: Record<string, number>;
	onSettings: () => void;
	onCollapse: () => void;
	onNotice: (text: string) => void;
	account: GrokAccount | null | undefined;
	signIn?: "saved" | "key" | "none";
	signInMode?: "grok" | "key";
	keySource?: "app" | "env";
	keyIgnored?: boolean;
	keyUnreadable?: boolean;
	keyRejected?: boolean;
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
	const previousActive = useRef(revealActiveOnMount ? undefined : activeId);
	const searchButton = useRef<HTMLButtonElement>(null);
	const accountButton = useRef<HTMLButtonElement>(null);
	const [menu, setMenu] = useState<MenuAnchor | null>(null);
	const [sub, setSub] = useState<SubmenuAnchor | null>(null);
	const [rowMenu, setRowMenu] = useState<(MenuAnchor & { id: string }) | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [sectionMenu, setSectionMenu] = useState<(MenuAnchor & { id: string }) | null>(null);
	const [accountMenu, setAccountMenu] = useState<{ bottom: number; left: number } | null>(null);
	const [cli, setCli] = useState<CliList | null>(null);
	const [now, setNow] = useState(Date.now());
	const keyMode = signInMode === "key";
	const source = keySource ?? (keyMode ? "app" : "env");
	const removeAppKey = keyMode && (source === "app" || keyUnreadable === true);
	const envKeyOnly = signIn !== "saved" && source === "env" && (signIn === "key" || keySource === "env");
	const signOutReason = removeAppKey ? "" : envKeyOnly ? "Set by XAI_API_KEY." : account === null && signIn !== "saved" ? "You're signed out." : "";

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

	const needle = query.trim().toLowerCase();
	const cutoff = view.days ? Date.now() - view.days * DAY : 0;
	const excerpts = new Map<string, string>();

	const available = sessions.filter((session) => {
		if (view.status === "active" && session.archived) { return false; }
		if (view.status === "archived" && !session.archived) { return false; }
		return !cutoff || stamp(session) >= cutoff;
	});
	function matchesSearch(session: Session) {
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

	const searching = needle !== "";
	const visible = searching ? available.filter(matchesSearch) : available;
	const pinned = view.status === "archived" ? [] : sorted(visible.filter((session) => session.pinned && !session.archived));
	const rest = sorted(visible.filter((session) => !pinned.includes(session)));
	const parents = view.groupBy === "project" && available.some((session) => session.parentId) ? projectParents(available) : undefined;
	const children = new Map<string, Session[]>();
	const nested = new Set<string>();
	if (parents?.size) {
		const visibleIds = new Set(visible.map((session) => session.id));
		for (const session of rest) {
			const parent = parents.get(session.id);
			if (!parent || !visibleIds.has(parent.id)) { continue; }
			const siblings = children.get(parent.id) ?? [];
			siblings.push(session);
			children.set(parent.id, siblings);
			nested.add(session.id);
		}
	}
	const topLevel = (list: Session[]) => nested.size ? list.filter((session) => !nested.has(session.id)) : list;
	const grouped = groupSessions(topLevel(rest), topLevel(visible), view, activity, sections);
	const activeParent = parents?.get(activeId);
	const activeSession = activeParent ?? sessions.find((session) => session.id === activeId);
	const activeProject = activeSession && pathKey(activeSession.folder);
	const activeParentId = activeParent?.id;
	useEffect(() => {
		if (previousActive.current === activeId) { return; }
		previousActive.current = activeId;
		setView((current) => {
			const revealProject = activeProject !== undefined && current.collapsedProjects.includes(activeProject);
			const revealParent = activeParentId !== undefined && current.collapsedParents.includes(activeParentId);
			if (!revealProject && !revealParent) { return current; }
			return {
				...current,
				collapsedProjects: revealProject ? current.collapsedProjects.filter((key) => key !== activeProject) : current.collapsedProjects,
				collapsedParents: revealParent ? current.collapsedParents.filter((id) => id !== activeParentId) : current.collapsedParents,
			};
		});
	}, [activeId, activeProject, activeParentId]);

	function closeAll() {
		setMenu(null);
		setSub(null);
		setRowMenu(null);
		setSectionMenu(null);
		setAccountMenu(null);
		setCli(null);
	}

	async function toggleCli(event: React.MouseEvent) {
		if (cli) { setCli(null); return; }
		const token = {};
		closeAll();
		setCli({ ...place(event, 360, 280), token, loading: true, sessions: [], error: "" });
		let result: { ok: boolean; error?: string; sessions?: CliPick[] };
		try {
			result = await onListCliSessions();
		} catch {
			result = { ok: false, error: "Grok's sessions could not be read." };
		}
		setCli((current) => (current && current.token === token ? { ...current, loading: false, error: result.ok ? "" : (result.error || "Grok's sessions could not be read."), sessions: result.sessions ?? [] } : current));
	}

	function place(event: React.MouseEvent, width: number, height: number) {
		const opener = event.currentTarget as HTMLElement;
		const rect = opener.getBoundingClientRect();
		const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height) : rect.bottom + 4;
		return { top, left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), opener };
	}

	function openMenu(event: React.MouseEvent) {
		closeAll();
		setMenu(place(event, 248, 260));
	}

	function openSub(kind: Submenu, opener: HTMLElement, focusOnOpen: boolean) {
		const rect = opener.getBoundingClientRect();
		const width = 200;
		const left = rect.right + 6 + width > window.innerWidth ? rect.left - width - 6 : rect.right + 6;
		setSub({ kind, top: rect.top - 4, left, opener, focusOnOpen });
	}

	function openRow(sessionId: string, event: React.MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		closeAll();
		const anchor = place(event, 230, 320);
		const opener = anchor.opener.querySelector<HTMLElement>(".session-hit, .icon-btn") ?? anchor.opener;
		setRowMenu({ id: sessionId, ...anchor, opener });
	}

	function pick(patch: Partial<SidebarView>) {
		setView((current) => ({ ...current, ...patch }));
		closeAll();
	}

	function toggleDisclosure(field: "collapsedProjects" | "collapsedParents", key: string) {
		if (searching) { return; }
		setView((current) => ({ ...current, [field]: current[field].includes(key)
			? current[field].filter((item) => item !== key)
			: [...current[field], key] }));
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
			loops: loopCounts?.[session.id] || 0,
		};
	}

	function renderRow(session: Session) {
		const childRows = children.get(session.id);
		if (!childRows) { return <Row key={session.id} {...rowProps(session)} />; }
		const expanded = searching || !view.collapsedParents.includes(session.id);
		const disclosure = {
			expanded,
			searching,
			status: expanded ? undefined : hiddenActivity(childRows, activity),
			onToggle: () => toggleDisclosure("collapsedParents", session.id),
		};
		return (
			<div key={session.id}>
				<Row {...rowProps(session)} disclosure={disclosure} />
				{expanded && <div className="session-children">{childRows.map((child) => <Row key={child.id} {...rowProps(child)} />)}</div>}
			</div>
		);
	}

	const rowSession = rowMenu ? sessions.find((session) => session.id === rowMenu.id) : undefined;
	const nothing = pinned.length === 0 && grouped.every((group) => group.items.length === 0);

	return (
		<aside className="sidebar" inert={inert}>
			<div className="side-tools">
				<button className="new-btn" aria-label="New session" title={keyLabel("New session (Ctrl+N)")} onClick={onNew}>
					<Icon name="plus" /> New session
				</button>
				<button className="new-btn cli-launch" aria-label="Open CLI session" title="Open a session started in the Grok CLI" aria-haspopup="menu" aria-expanded={cli !== null} onClick={(event) => { void toggleCli(event); }}>
					<span className="cli-label-full">Open CLI session…</span>
					<span className="cli-label-short">CLI…</span>
				</button>
				<span className="spacer" />
				<button ref={searchButton} className="side-icon" aria-label="Search sessions" title="Search sessions" onClick={() => setSearchOpen((value) => !value || !!query)}>
					<Icon name="search" />
				</button>
				<button className="side-icon" aria-label="Filter and group" title="Filter and group" aria-haspopup="menu" aria-expanded={menu !== null} onClick={openMenu}>
					<Icon name="sliders" />
				</button>
			</div>
			{cli && (
				<>
					<button className="menu-back" aria-label="Close CLI sessions" tabIndex={-1} onClick={() => setCli(null)} />
					<PopupMenu className="row-pop cli-sessions" aria-label="CLI sessions" style={{ top: cli.top, left: cli.left }} opener={cli.opener} onDismiss={() => setCli(null)}>
						{cli.loading && <div className="meta">Looking…</div>}
						{!cli.loading && cli.error && <div className="meta">{cli.error}</div>}
						{!cli.loading && !cli.error && cli.sessions.length === 0 && <div className="meta">No other CLI sessions.</div>}
						{!cli.loading && cli.sessions.map((item) => (
							<button key={item.id} role="menuitem" title={item.folder} onClick={() => { setCli(null); onOpenCliSession(item.id); }}>
								{item.title}
								<small>{item.folder}{item.lastActive ? ` · ${ago(item.lastActive, now)}` : ""}</small>
							</button>
						))}
					</PopupMenu>
				</>
			)}
			{searchOpen && (
				<div className="side-search">
					<input
						aria-label="Search sessions"
						placeholder="Search sessions"
						value={query}
						autoFocus
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onQuery(""); setSearchOpen(false); searchButton.current?.focus(); } }}
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
				{pinned.map(renderRow)}
				{grouped.map((group) => {
					const expanded = !group.seed || searching || !view.collapsedProjects.includes(group.id);
					const status = expanded ? undefined : hiddenActivity(group.items.flatMap((session) => [session, ...(children.get(session.id) ?? [])]), activity);
					return (
						<div key={group.id}>
							{group.seed && <ProjectHead label={group.label} seed={group.seed} onNewIn={onNewIn} expanded={expanded} searching={searching} status={status} onToggle={() => toggleDisclosure("collapsedProjects", group.id)} />}
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
									<button className="side-icon" aria-label={`Actions for section ${group.label}`} aria-haspopup="menu" aria-expanded={sectionMenu?.id === group.section.id} onClick={(event) => { const id = group.section?.id ?? ""; closeAll(); setSectionMenu({ id, ...place(event, 200, 100) }); }}><Icon name="more-horizontal" /></button>
								</div>
							)}
							{!group.seed && !group.section && <div className="group-label">{group.label}</div>}
							{expanded && group.items.map(renderRow)}
						</div>
					);
				})}
				{nothing && <p className="note">{needle ? "No sessions match." : view.status === "archived" ? "No archived sessions." : "No sessions yet."}</p>}
			</div>
			<div className="side-foot">
				<button
					ref={accountButton}
					className="account-btn"
					aria-label={update ? `Account and settings, version ${update.latest} available` : "Account and settings"}
					aria-haspopup="menu"
					aria-expanded={accountMenu !== null}
					onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						closeAll();
						setAccountMenu({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
					}}
				>
					<span className="avatar">{(account?.email || "G").charAt(0).toUpperCase()}</span>
					<span className="who">{accountName(account, signIn, source, false)}{account?.plan && <small>{account.plan}</small>}{update && <small className="update-flag">Update available · {update.latest}</small>}</span>
				</button>
				<button className="side-icon" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onCollapse}><Icon name="sidebar-collapse" /></button>
			</div>
			{(menu || rowMenu || sectionMenu || accountMenu) && (
				<button className="menu-back" aria-label="Close menu" tabIndex={-1} onClick={closeAll} />
			)}
			{accountMenu && (
				<PopupMenu className="row-pop account-menu" style={{ bottom: accountMenu.bottom, left: accountMenu.left }} aria-label="Account" opener={accountButton.current} onDismiss={closeAll}>
					<div className="account-head">
						<b>{accountName(account, signIn, source, true)}</b>
						{account && <span>{[account.plan, account.team].filter(Boolean).join(" · ")}</span>}
						{envKeyOnly && <span>Remove XAI_API_KEY from your environment to stop using it.</span>}
						{keyIgnored && <span>The API key isn't used while a Grok sign-in is saved.</span>}
						{keyUnreadable && <span>The saved API key can't be read. Enter it again in Settings.</span>}
						{keyRejected && <span>Grok rejected the API key, or couldn't reach xAI to check it.</span>}
						{signIn === "saved" && !account?.email && <span>A saved sign-in is on this computer. Your account shows once Grok starts.</span>}
						{!keyMode && !envKeyOnly && account === undefined && signIn === undefined && <span>Your account shows once Grok starts. Send a message to start it.</span>}
						{!keyMode && !envKeyOnly && (account === null || signIn === "none") && signIn !== "key" && signIn !== "saved" && <span>Grok asks you to sign in when you next send a message.</span>}
						{recentUsd !== null && <span>Grok on this computer, last 7 days: ${recentUsd.toFixed(2)}</span>}
					</div>
					<hr />
					{update && <button role="menuitem" onClick={() => { closeAll(); onUpdate(); }}>Update to {update.latest}…</button>}
					<button role="menuitem" onClick={() => { accountButton.current?.focus(); closeAll(); onSettings(); }}>Settings<small>{keyLabel("Ctrl+,")}</small></button>
					<button role="menuitem" onClick={() => { accountButton.current?.focus(); closeAll(); onShortcuts(); }}>Keyboard shortcuts<small>{keyLabel("Ctrl+/")}</small></button>
					<button role="menuitem" onClick={() => { closeAll(); onOpenUrl("https://console.x.ai"); }}>Get xAI API keys<Icon name="external" /></button>
					<hr />
					<button role="menuitem" disabled={!!signOutReason} onClick={() => { accountButton.current?.focus(); closeAll(); onSignOut(); }}>
						{removeAppKey ? "Remove the API key" : "Sign out"}
						{signOutReason && <small className="menu-reason">{signOutReason}</small>}
					</button>
					{account?.version && <div className="account-foot">Grok {account.version}</div>}
				</PopupMenu>
			)}
			{menu && (
				<PopupMenu className="row-pop side-menu" style={{ top: menu.top, left: menu.left }} aria-label="Filter and group" opener={menu.opener} onDismiss={closeAll}>
					<Cascade label="Group by" value={GROUP_LABEL[view.groupBy]} open={sub?.kind === "group"} onOpen={(opener, focus) => openSub("group", opener, focus)} />
					{sub?.kind === "group" && <Choices anchor={sub} label="Group by" options={Object.entries(GROUP_LABEL) as [GroupBy, string][]} value={view.groupBy} onDismiss={() => setSub(null)} onPick={(groupBy) => pick({ groupBy })} />}
					<Cascade label="Sort by" value={SORT_LABEL[view.sortBy]} open={sub?.kind === "sort"} onOpen={(opener, focus) => openSub("sort", opener, focus)} />
					{sub?.kind === "sort" && <Choices anchor={sub} label="Sort by" options={Object.entries(SORT_LABEL) as [SortBy, string][]} value={view.sortBy} onDismiss={() => setSub(null)} onPick={(sortBy) => pick({ sortBy })} />}
					<Cascade label="Status" value={STATUS_LABEL[view.status]} open={sub?.kind === "status"} onOpen={(opener, focus) => openSub("status", opener, focus)} />
					{sub?.kind === "status" && <Choices anchor={sub} label="Status" options={Object.entries(STATUS_LABEL) as [StatusFilter, string][]} value={view.status} onDismiss={() => setSub(null)} onPick={(status) => pick({ status })} />}
					<Cascade label="Last activity" value={DAYS.find(([days]) => days === view.days)?.[1] ?? "Any time"} open={sub?.kind === "days"} onOpen={(opener, focus) => openSub("days", opener, focus)} />
					{sub?.kind === "days" && <Choices anchor={sub} label="Last activity" options={DAYS} value={view.days} onDismiss={() => setSub(null)} onPick={(days) => pick({ days })} />}
					<hr />
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => addSection()}>New section</button>
					<hr />
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => pick(DEFAULT_VIEW)}>Reset to defaults</button>
				</PopupMenu>
			)}
			{sectionMenu && (
				<PopupMenu className="row-pop" style={{ top: sectionMenu.top, left: sectionMenu.left }} aria-label="Section actions" opener={sectionMenu.opener} onDismiss={closeAll}>
					<button role="menuitem" onClick={() => { setRenaming(`section:${sectionMenu.id}`); closeAll(); }}>Rename section</button>
					<button
						role="menuitem"
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
				</PopupMenu>
			)}
			{rowMenu && rowSession && (
				<PopupMenu className="row-pop" style={{ top: rowMenu.top, left: rowMenu.left }} aria-label="Session actions" opener={rowMenu.opener} onDismiss={closeAll}>
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { setRenaming(rowSession.id); closeAll(); }}>Rename</button>
					{!rowSession.archived && <button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onPin(rowSession.id); closeAll(); }}>{rowSession.pinned ? "Unpin" : "Pin"}</button>}
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onMarkUnread(rowSession.id, !rowSession.unread); closeAll(); }}>{rowSession.unread ? "Mark as read" : "Mark as unread"}</button>
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onMarkCompleted(rowSession.id, !rowSession.completed); closeAll(); }}>{rowSession.completed ? "Mark as not completed" : "Mark as completed"}</button>
					<Cascade label="Move to section" value="" open={sub?.kind === "move"} onOpen={(opener, focus) => openSub("move", opener, focus)} />
					{sub?.kind === "move" && (
						<PopupMenu className="row-pop" style={{ top: sub.top, left: sub.left }} aria-label="Move to section" opener={sub.opener} focusOnOpen={sub.focusOnOpen} onDismiss={() => setSub(null)} onBack={() => setSub(null)}>
							{sections.map((section) => (
								<button key={section.id} role="menuitemradio" aria-checked={rowSession.sectionId === section.id} onClick={() => { onMove(rowSession.id, section.id); closeAll(); }}>
									<span>{section.name}</span>
									{rowSession.sectionId === section.id && <Icon name="check" className="menu-check" />}
								</button>
							))}
							{sections.length > 0 && <hr />}
							<button role="menuitem" onClick={() => addSection(rowSession.id)}>New section…</button>
							{rowSession.sectionId && <button role="menuitem" onClick={() => { onMove(rowSession.id, undefined); closeAll(); }}>Remove from section</button>}
						</PopupMenu>
					)}
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onOpenWindow(rowSession.id); closeAll(); }}>Open in a new window</button>
					{rowSession.agentSessionId && <button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onCopySessionId(rowSession.agentSessionId!); closeAll(); }}>Copy Grok session ID</button>}
					{rowSession.agentSessionId && <button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onExportMarkdown(rowSession.agentSessionId!, rowSession.title); closeAll(); }}>Export as Markdown…</button>}
					<hr />
					<button role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => { onArchive(rowSession.id); closeAll(); }}>{rowSession.archived ? "Unarchive" : "Archive"}</button>
					<button
						role="menuitem"
						className="danger"
						disabled={!!activity[rowSession.id]}
						onMouseEnter={() => setSub(null)}
						onClick={() => {
							const id = rowSession.id;
							closeAll();
							if (activity[id]) { onNotice("Stop this session before deleting it."); return; }
							rowMenu.opener.focus();
							void askConfirm({ title: `Delete "${rowSession.title}"?`, body: "Its transcript is removed from this app and cannot be restored.", ok: "Delete", danger: true }).then((yes) => {
								if (yes) { onDelete(id); }
							});
						}}
					>
						Delete…
						{activity[rowSession.id] && <small className="menu-reason">Stop this session before deleting it.</small>}
					</button>
				</PopupMenu>
			)}
		</aside>
	);
}

function Cascade({ label, value, open, onOpen }: { label: string; value: string; open: boolean; onOpen: (opener: HTMLElement, focusOnOpen: boolean) => void }) {
	return (
		<button
			role="menuitem"
			className={open ? "cascade on" : "cascade"}
			aria-haspopup="menu"
			aria-expanded={open}
			onMouseEnter={(event) => onOpen(event.currentTarget, false)}
			onClick={(event) => onOpen(event.currentTarget, true)}
			onKeyDown={(event) => {
				if (event.key === "ArrowRight") {
					event.preventDefault();
					event.stopPropagation();
					onOpen(event.currentTarget, true);
				}
			}}
		>
			<span>{label}</span>
			<span className="menu-value">{value}<Icon name="chevron-right" /></span>
		</button>
	);
}

function Choices<T extends string | number>({ anchor, label, options, value, onDismiss, onPick }: { anchor: SubmenuAnchor; label: string; options: [T, string][]; value: T; onDismiss: () => void; onPick: (value: T) => void }) {
	return (
		<PopupMenu className="row-pop" style={{ top: anchor.top, left: anchor.left }} aria-label={label} opener={anchor.opener} focusOnOpen={anchor.focusOnOpen} onDismiss={onDismiss} onBack={onDismiss}>
			{options.map(([id, text]) => (
				<button key={String(id)} role="menuitemradio" aria-checked={value === id} onClick={() => onPick(id)}>
					<span>{text}</span>
					{value === id && <Icon name="check" className="menu-check" />}
				</button>
			))}
		</PopupMenu>
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

function ProjectHead({ label, seed, onNewIn, expanded, searching, status, onToggle }: {
	label: string;
	seed: ProjectSeed;
	onNewIn: (seed: ProjectSeed) => void;
	expanded: boolean;
	searching: boolean;
	status?: Activity[string];
	onToggle: () => void;
}) {
	return (
		<div className="group-head">
			<button type="button" className="project-toggle" title={seed.folder} aria-expanded={expanded} aria-disabled={searching || undefined} onClick={onToggle}>
				<span className="group-label">{label}</span>
				<Icon name={expanded ? "chevron-down" : "chevron-right"} />
				{status && <span className={`dot ${status}`} role="img" aria-label={STATE_LABEL[status]} title={STATE_LABEL[status]} />}
			</button>
			<button className="side-icon project-add" aria-label={`New session in ${label}`} title={`New session in ${seed.folder}`} onClick={() => onNewIn(seed)}>
				<Icon name="plus" />
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
	disclosure,
	loops = 0,
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
	disclosure?: { expanded: boolean; searching: boolean; status: Activity[string]; onToggle: () => void };
	loops?: number;
}) {
	const time = stamp(session);
	const meta = [session.worktreeFolder ? session.branch : "", time ? ago(time, now) : ""].filter(Boolean).join(" · ");
	return (
		<div className={`session${active ? " active" : ""}${menuOpen ? " menu-open" : ""}${state === "unread" ? " unread" : ""}`} onContextMenu={(event) => onOpenMenu(session.id, event)}>
			{disclosure && (
				<button
					type="button"
					className="child-toggle"
					aria-label={`Child sessions of ${session.title}${disclosure.status ? ` · ${STATE_LABEL[disclosure.status]}` : ""}`}
					aria-expanded={disclosure.expanded}
					aria-disabled={disclosure.searching || undefined}
					onClick={disclosure.onToggle}
				>
					<Icon name={disclosure.expanded ? "chevron-down" : "chevron-right"} />
					{disclosure.status && <span className={`dot ${disclosure.status}`} title={STATE_LABEL[disclosure.status]} aria-hidden="true" />}
				</button>
			)}
			<span className={`dot ${state}`} title={STATE_LABEL[state]} aria-hidden="true" />
			{renaming ? (
				<InlineName label="Session title" value={session.title} onDone={onRename} />
			) : (
				<button className="session-hit" title={`${session.title}\n${session.folder}${time ? `\n${new Date(time).toLocaleString()}` : ""}`} onClick={(event) => onSelect(session.id, event)} onDoubleClick={onStartRename}>
					<b>{session.title}</b>
					{state === "needs-you" ? <small className="needs-you">Needs you</small> : state === "failed" ? <small className="failed">Stopped with an error</small> : excerpt !== undefined ? <small className="session-meta">{excerpt}</small> : meta && <small className="session-meta">{meta}</small>}
				</button>
			)}
			{loops > 0 && <small className="loop-count" title={loops === 1 ? "1 scheduled loop" : `${loops} scheduled loops`} aria-label={loops === 1 ? "1 scheduled loop" : `${loops} scheduled loops`}>{String(loops)}</small>}
			<button className="icon-btn" aria-label={`Actions for ${session.title}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => onOpenMenu(session.id, event)}><Icon name="more-horizontal" /></button>
		</div>
	);
}
