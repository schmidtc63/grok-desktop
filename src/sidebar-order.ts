import { caseKey } from "./data";
import type { ChatMessage, Session } from "./types";

// The sidebar's saved layout. Ctrl+Tab reads this at key time, including while the sidebar is collapsed.
export const SIDEBAR_VIEW_KEY = "grok-code.sidebar.v1";
export const SIDEBAR_SECTIONS_KEY = "grok-code.sections.v1";

type GroupBy = "date" | "project" | "state" | "section" | "none";
type SortBy = "recency" | "name" | "created";
type StatusFilter = "active" | "archived" | "all";
type RowState = "needs-you" | "failed" | "running" | "unread" | "completed" | "idle";
type Section = { id: string; name: string };
type Activity = Record<string, "running" | "needs-you" | undefined>;
type SessionGroup = { id: string; label: string; items: Session[]; seed?: { folder: string }; section?: Section };

interface SidebarView {
	groupBy: GroupBy;
	sortBy: SortBy;
	status: StatusFilter;
	days: number;
	collapsedProjects: string[];
	collapsedParents: string[];
	scheduledOpen: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_VIEW: SidebarView = { groupBy: "project", sortBy: "recency", status: "active", days: 0, collapsedProjects: [], collapsedParents: [], scheduledOpen: false };
const STATE_LABEL: Record<RowState, string> = { "needs-you": "Needs you", failed: "Failed", running: "Working", unread: "Unread", idle: "Idle", completed: "Completed" };
const STATE_ORDER: RowState[] = ["needs-you", "failed", "running", "unread", "idle", "completed"];

export function readSidebarView(): SidebarView {
	try {
		const value = JSON.parse(localStorage.getItem(SIDEBAR_VIEW_KEY) ?? "null");
		if (!value || typeof value !== "object") { return DEFAULT_VIEW; }
		const savedIds = (ids: unknown) => Array.isArray(ids) ? ids.filter((id: unknown) => typeof id === "string") : [];
		return { ...DEFAULT_VIEW, ...value, collapsedProjects: savedIds(value.collapsedProjects), collapsedParents: savedIds(value.collapsedParents) };
	} catch {
		return DEFAULT_VIEW;
	}
}

export function readSidebarSections(): Section[] {
	try {
		const value = JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string") : [];
	} catch {
		return [];
	}
}

function pathKey(folder: string) {
	return caseKey(folder.replace(/\//g, "\\").replace(/\\+$/, ""));
}

function stamp(session: Session) {
	return session.lastActivityAt ?? session.createdAt ?? 0;
}

function stateOf(session: Session, activity: Activity): RowState {
	const live = activity[session.id];
	if (live) { return live; }
	if (session.failed) { return "failed"; }
	if (session.unread) { return "unread"; }
	return session.completed ? "completed" : "idle";
}

function newestRuns(runs: Session[]) {
	const newest = new Map<Session["routineId"], Session>();
	for (const run of runs) {
		const kept = newest.get(run.routineId);
		if (!kept || stamp(run) > stamp(kept)) { newest.set(run.routineId, run); }
	}
	return new Set(newest.values());
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
	return keys.map((key, index) => {
		const session = chosen[index];
		return {
			id: key,
			label: session.project,
			items: items.filter((item) => pathKey(item.folder) === key),
			seed: { folder: session.folder },
		};
	});
}

function projectParents(sessions: Session[]) {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const parents = new Map<string, Session>();
	for (const child of sessions) {
		if (!child.parentId || child.routineId || (child.pinned && !child.archived)) { continue; }
		const parent = byId.get(child.parentId);
		if (parent && !parent.routineId && !parent.archived && parent.id !== child.id) { parents.set(child.id, parent); }
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

const lowered = new WeakMap<ChatMessage, string>();

function textHit(messages: ChatMessage[] | undefined, needle: string) {
	for (const message of messages ?? []) {
		let lower = lowered.get(message);
		if (lower === undefined) {
			lower = message.text.toLowerCase();
			lowered.set(message, lower);
		}
		if (lower.indexOf(needle) >= 0) { return message.text; }
	}
	return undefined;
}

// Session ids in the order the sidebar paints them. Hidden rows, including a collapsed Scheduled section, are omitted.
export function sidebarSessionIds(input: {
	sessions: Session[];
	chats: Record<string, ChatMessage[] | undefined>;
	query: string;
	view: SidebarView;
	sections: Section[];
	activity: Activity;
	activeId: string;
}): string[] {
	const { sessions, chats, view, sections, activity, activeId } = input;
	const needle = input.query.trim().toLowerCase();
	const cutoff = view.days ? Date.now() - view.days * DAY : 0;
	const available = sessions.filter((session) => {
		if (view.status === "active" && session.archived) { return false; }
		if (view.status === "archived" && !session.archived) { return false; }
		return !cutoff || stamp(session) >= cutoff;
	});
	function matchesSearch(session: Session) {
		if (`${session.title} ${session.project} ${session.folder}`.toLowerCase().includes(needle)) { return true; }
		return textHit(chats[session.id], needle) !== undefined;
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
	const topLevel = (list: Session[]) => list.filter((session) => !nested.has(session.id) && !session.routineId);
	const grouped = groupSessions(topLevel(rest), topLevel(visible), view, activity, sections);
	const runs = rest.filter((session) => session.routineId);
	const newest = !searching && view.status === "active" ? newestRuns(runs) : undefined;
	const scheduled = newest ? runs.filter((run) => newest.has(run) || run.id === activeId || activity[run.id]) : runs;
	const scheduledExpanded = searching || view.scheduledOpen;
	const ids: string[] = [];
	const addRow = (session: Session) => {
		ids.push(session.id);
		const childRows = children.get(session.id);
		if (!childRows) { return; }
		if (searching || !view.collapsedParents.includes(session.id)) {
			for (const child of childRows) { ids.push(child.id); }
		}
	};
	if (scheduled.length > 0 && scheduledExpanded) {
		for (const run of scheduled) { ids.push(run.id); }
	}
	for (const session of pinned) { addRow(session); }
	for (const group of grouped) {
		if (!group.seed || searching || !view.collapsedProjects.includes(group.id)) {
			for (const session of group.items) { addRow(session); }
		}
	}
	return ids;
}
