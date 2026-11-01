import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent } from "react";
import { SHORTCUTS } from "./data";
import { BrowserPane, type BrowserTab, type DevServer } from "./BrowserPane";
import { DiffPane, type DiffComment, type PrInfo } from "./DiffPane";
import { FilesPane } from "./FilesPane";
import { PaneView, SideLog, type BackgroundTask, type EditorDraft, type FolderFiles, type OpenFile, type PaneModel } from "./Panes";
import { SessionRail } from "./SessionRail";
import { DEFAULT_SETTINGS, readSettings, settingsKey, SettingsPage, type AppSettings, type SettingsTab } from "./Settings";
import { Sidebar } from "./Sidebar";
import { TerminalPane, type TerminalTab } from "./TerminalPane";
import {
	EFFORT_DETAIL,
	EFFORTS,
	FAST_MODEL,
	imageSrc,
	MENU_PANES,
	MODES,
	MODELS,
	PANES,
	type ChatMessage,
	type Environment,
	mapMode,
	type PermissionMode,
	type ProjectSeed,
	type Session,
	type SidePaneId,
	type TranscriptView,
} from "./types";

type Menu = string | null;

const historyKey = "grok-code.history.v1";
const commandsKey = "grok-code.commands.v1";
const accountKey = "grok-code.account.v1";
const SIDE_BUSY = "The side chat is still answering. Wait for it to finish.";
const VIEWS: TranscriptView[] = ["normal", "thinking", "verbose"];
const VIEW_LABEL: Record<TranscriptView, string> = { normal: "Normal", thinking: "Thinking", verbose: "Verbose" };
const PROTECTED = [/^\.mcp\.json$/i, /^\.claude\/settings(\.local)?\.json$/i, /^\.grok\/config\.toml$/i];
const BUILT_INS: GrokCommand[] = [
	{ name: "btw", description: "Ask a side question that does not join this conversation", hint: "question" },
	{ name: "config", description: "Open Settings", hint: "" },
	{ name: "status", description: "Show the app's version, model, mode and folder", hint: "" },
];

interface History {
	sessions: Session[];
	extraChats: Record<string, ChatMessage[]>;
	modes: Record<string, PermissionMode>;
	prePlan: Record<string, PermissionMode>;
	editorDrafts: Record<string, EditorDraft | undefined>;
	composerDrafts?: Record<string, string>;
	newSessionDraft?: { session: Session; useWorktree: boolean; text: string };
	deleted: string[];
}

interface Queued {
	id: string;
	text: string;
	attachments: string[];
}

interface TurnTarget {
	sessionId: string;
	replyId: string;
	turnId: string;
	where: "main" | "side";
}

function readHistory(): History | null {
	try {
		const value = JSON.parse(localStorage.getItem(historyKey) ?? "null");
		if (!value || !Array.isArray(value.sessions)) { return null; }
		if (value.sessions.some((item: Session) => !item || typeof item.id !== "string" || typeof item.folder !== "string")) { return null; }
		const draft = value.newSessionDraft;
		const newSessionDraft = draft && typeof draft.text === "string" && draft.text && typeof draft.session?.id === "string" && typeof draft.session?.folder === "string" ? draft : undefined;
		if (!value.sessions.length && !newSessionDraft) { return null; }
		const modes = Object.fromEntries(Object.entries(value.modes ?? {}).map(([id, mode]) => [id, mapMode(String(mode)) ?? "Always-approve"]));
		const prePlan = Object.fromEntries(Object.entries(value.prePlan ?? {}).map(([id, mode]) => [id, mapMode(String(mode)) ?? "Normal"]).filter(([, mode]) => mode !== "Plan"));
		return { sessions: value.sessions, extraChats: value.extraChats ?? {}, modes, prePlan, editorDrafts: value.editorDrafts ?? {}, composerDrafts: value.composerDrafts ?? {}, newSessionDraft, deleted: Array.isArray(value.deleted) ? value.deleted : [] };
	} catch {
		return null;
	}
}

function restoredChats(store: Record<string, ChatMessage[]>) {
	return Object.fromEntries(Object.entries(store).map(([id, messages]) => [id, messages.map((message) => ({
		...message,
		pending: false,
		streaming: false,
		text: message.pending || message.streaming ? `${message.text}${message.text ? "\n" : ""}Interrupted when this window closed.` : message.text,
		parts: message.pending || message.streaming ? undefined : message.parts,
		tools: message.tools?.map((tool) => tool.waiting ? { ...tool, waiting: false, detail: "Approval closed with the previous window." } : tool),
	}))]));
}

function mergeChats(saved: Record<string, ChatMessage[]>, current: Record<string, ChatMessage[]>, previous: Record<string, ChatMessage[]>) {
	const merged = { ...saved };
	for (const [id, messages] of Object.entries(current)) {
		if (messages === previous[id]) { continue; }
		const old = new Map((previous[id] ?? []).map((message) => [message.id, message]));
		const changed = new Map(messages.filter((message) => old.get(message.id) !== message).map((message) => [message.id, message]));
		const savedMessages = saved[id] ?? [];
		const savedIds = new Set(savedMessages.map((message) => message.id));
		merged[id] = [...savedMessages.map((message) => changed.get(message.id) ?? message), ...messages.filter((message) => changed.has(message.id) && !savedIds.has(message.id))];
	}
	return merged;
}

function slimChats(store: Record<string, ChatMessage[]>) {
	const cut = (value: string | undefined, size: number) => (value && value.length > size ? `${value.slice(0, size)}…` : value);
	return Object.fromEntries(Object.entries(store).map(([id, messages]) => [id, messages.map((message) => (message.tools
		? { ...message, tools: message.tools.map((tool) => ({ ...tool, output: undefined, input: undefined, command: cut(tool.command, 2000), plan: cut(tool.plan, 20000) })) }
		: message))]));
}

function mergeDrafts(saved: History["editorDrafts"], current: History["editorDrafts"], previous: History["editorDrafts"]) {
	const merged = { ...saved };
	for (const [key, draft] of Object.entries(current)) {
		if (!draft || draft === previous[key]) { continue; }
		const remote = saved[key];
		const old = previous[key];
		const recoveryTexts = new Set(draft.recoveryTexts ?? []);
		if (JSON.stringify(remote?.recoveryTexts) !== JSON.stringify(old?.recoveryTexts)) {
			for (const text of remote?.recoveryTexts ?? []) { recoveryTexts.add(text); }
		}
		if (remote && remote.text !== remote.baseText && remote.text !== draft.text && remote.text !== old?.text) { recoveryTexts.add(remote.text); }
		merged[key] = { ...draft, saving: false, recoveryTexts: [...recoveryTexts] };
	}
	return merged;
}

// Only drafts that hold the user's own text are saved, and never a deleted session's.
function keptDrafts(store: History["editorDrafts"], gone: Set<string>) {
	return Object.fromEntries(Object.entries(store).filter(([key, draft]) => {
		if (!draft || (draft.text === draft.baseText && !draft.recoveryTexts?.length)) { return false; }
		let id = "";
		try { id = String(JSON.parse(key)[0]); } catch { return true; }
		return !gone.has(id);
	}));
}

// Named so a save that works again can clear them.
const HISTORY_FULL = "Chat history is full and is not being saved. Delete old sessions to free space.";
const HISTORY_FAILED = "Chat history could not be saved on this computer.";

function newSession(seed?: Partial<ProjectSeed>): Session {
	const folder = seed?.folder ?? window.grokCode?.homeDir ?? "";
	const project = seed?.project ?? shortPath(folder);
	const now = Date.now();
	return {
		id: `new-${crypto.randomUUID()}`, title: "New session", project,
		folder,
		branch: seed?.branch ?? "main", worktree: seed?.worktree ?? project,
		environment: seed?.environment ?? "Local", status: "idle", detail: "Empty", when: "now",
		pinned: false, archived: false, source: "desktop", createdAt: now, lastActivityAt: now,
	};
}

function fileKey(session: Session, file: string) {
	return JSON.stringify([session.id, session.folder, file]);
}

function knownMode(mode: string | undefined, settings: AppSettings): PermissionMode {
	return mapMode(mode) ?? mapMode(settings.defaultMode) ?? "Always-approve";
}

function folderKey(folder: string) {
	return folder.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function shortPath(folder: string) {
	const parts = folder.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? folder;
}

function latestTool<T>(messages: ChatMessage[], pick: (tool: NonNullable<ChatMessage["tools"]>[number]) => T | undefined): T | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const tools = messages[index].tools ?? [];
		for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
			const value = pick(tools[toolIndex]);
			if (value !== undefined) { return value; }
		}
	}
	return undefined;
}

function sideContext(messages: ChatMessage[]) {
	const recent = messages.filter((message) => message.text.trim()).slice(-12);
	const lines = recent.map((message) => `${message.role === "user" ? "User" : "Grok"}: ${message.text.length > 1500 ? `${message.text.slice(0, 1500)}…` : message.text}`);
	return lines.length ? `Read-only context from the main conversation. Do not change files; answer the side question only.\n\n${lines.join("\n\n")}\n\nSide question: ` : "";
}

function readCommands(): GrokCommand[] {
	try {
		const value = JSON.parse(localStorage.getItem(commandsKey) ?? "[]");
		return Array.isArray(value) ? value.filter((item) => item && typeof item.name === "string") : [];
	} catch {
		return [];
	}
}

// The account Grok last reported, shown at launch until Grok starts and reports again.
function readAccount(): GrokAccount | null | undefined {
	try {
		const saved = localStorage.getItem(accountKey);
		if (saved === null) { return undefined; }
		const value = JSON.parse(saved);
		return value === null || typeof value?.email === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function App() {
	const [history] = useState(readHistory);
	const [settings, setSettings] = useState<AppSettings>(readSettings);
	const [sessions, setSessions] = useState<Session[]>(() => history?.sessions.map((item) => ({ ...item, status: "idle" })) ?? [newSession()]);
	const [activeId, setActiveId] = useState(() => {
		const requested = new URLSearchParams(window.location?.search ?? "").get("session");
		return history?.sessions.find((item) => item.id === requested)?.id ?? history?.sessions.find((item) => !item.archived)?.id ?? "";
	});
	// A fresh id each time, so two windows that both restore the form cannot send into one session.
	const [restoredForm] = useState<Session | null>(() => (history?.newSessionDraft ? { ...history.newSessionDraft.session, id: `new-${crypto.randomUUID()}` } : null));
	const [pending, setPending] = useState<Session | null>(() => restoredForm ?? (history ? null : sessions[0]));
	const [useWorktree, setUseWorktree] = useState(history?.newSessionDraft?.useWorktree ?? false);
	const [panes, setPanes] = useState<SidePaneId[]>([]);
	const [focusedPane, setFocusedPane] = useState<SidePaneId | null>(null);
	const [menu, setMenu] = useState<Menu>(null);
	const [fileMenu, setFileMenu] = useState<{ file: string; x: number; y: number } | null>(null);
	const [query, setQuery] = useState("");
	const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
		...Object.fromEntries(Object.entries(history?.composerDrafts ?? {}).filter(([id, text]) => typeof text === "string" && sessions.some((item) => item.id === id))),
		...(restoredForm && history?.newSessionDraft ? { [restoredForm.id]: history.newSessionDraft.text } : {}),
	}));
	const [attachments, setAttachments] = useState<Record<string, string[]>>({});
	const [queued, setQueued] = useState<Record<string, Queued[]>>({});
	const [held, setHeld] = useState<Record<string, boolean>>({});
	const [popIndex, setPopIndex] = useState(0);
	const popupList = useRef<HTMLDivElement>(null);
	const [popClosed, setPopClosed] = useState("");
	const [sideOpen, setSideOpen] = useState(false);
	const [sideText, setSideText] = useState("");
	const [sideChats, setSideChats] = useState<Record<string, ChatMessage[]>>({});
	const [sideAgents, setSideAgents] = useState<Record<string, string>>({});
	const sideSeen = useRef<Record<string, string>>({});
	const [notice, setNotice] = useState("");
	const [shortcuts, setShortcuts] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [extraChats, setExtraChats] = useState<Record<string, ChatMessage[]>>(() => restoredChats(history?.extraChats ?? {}));
	const [deleted, setDeleted] = useState<string[]>(history?.deleted ?? []);
	const [views, setViews] = useState<Record<string, TranscriptView>>({});
	const [commands, setCommands] = useState<GrokCommand[]>(readCommands);
	const [models, setModels] = useState<GrokModel[]>([]);
	const [servers, setServers] = useState<GrokMcpServer[]>([]);
	const [diffScope, setDiffScope] = useState<Record<string, string>>({});
	const [commits, setCommits] = useState<Record<string, { sha: string; short: string; subject: string }[]>>({});
	const [branches, setBranches] = useState<Record<string, BranchInfo | undefined>>({});
	const [prs, setPrs] = useState<Record<string, PrStatus | undefined>>({});
	const [comments, setComments] = useState<Record<string, DiffComment[]>>({});
	const [diffFile, setDiffFile] = useState("");
	const [diffTick, setDiffTick] = useState(0);
	const [diffs, setDiffs] = useState<Record<string, DiffSnapshot | undefined>>({});
	const [folderLists, setFolderLists] = useState<Record<string, FolderFiles | undefined>>({});
	const [openFiles, setOpenFiles] = useState<Record<string, OpenFile | undefined>>({});
	const [editorDrafts, setEditorDrafts] = useState<History["editorDrafts"]>(() => Object.fromEntries(Object.entries(history?.editorDrafts ?? {}).map(([key, draft]) => [key, draft && { ...draft, saving: false }])));
	const [editorFile, setEditorFile] = useState("");
	const [editorLine, setEditorLine] = useState<{ line?: number; tick: number }>({ tick: 0 });
	const [fileTick, setFileTick] = useState(0);
	const [terminals, setTerminals] = useState<Record<string, TerminalTab[]>>({});
	const [activeTerminal, setActiveTerminal] = useState<Record<string, string>>({});
	const [terminalError, setTerminalError] = useState("");
	const [browserTabs, setBrowserTabs] = useState<Record<string, BrowserTab[]>>({});
	const [activeBrowser, setActiveBrowser] = useState<Record<string, string>>({});
	const [browserError, setBrowserError] = useState("");
	const [devScripts, setDevScripts] = useState<Record<string, { script: string; command: string }[]>>({});
	const [devTabs, setDevTabs] = useState<Record<string, string>>({});
	const [selectTick, setSelectTick] = useState(0);
	const [modes, setModes] = useState<Record<string, PermissionMode>>(history?.modes ?? {});
	const [prePlan, setPrePlan] = useState<Record<string, PermissionMode>>(history?.prePlan ?? {});
	const modesRef = useRef(modes);
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [breakdown, setBreakdown] = useState<(ContextBreakdown & { id: string }) | null>(null);
	const [recentUsd, setRecentUsd] = useState<number | null>(null);
	const [account, setAccount] = useState<GrokAccount | null | undefined>(readAccount);
	const [addingFolder, setAddingFolder] = useState(false);
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth ?? 1400);
	const turnTargets = useRef<Record<string, TurnTarget>>({});
	const sessionsRef = useRef(sessions);
	const activeIdRef = useRef(activeId);
	const pendingRef = useRef(pending);
	const draftsRef = useRef(drafts);
	const useWorktreeRef = useRef(useWorktree);
	const creatingWorktree = useRef(false);
	const autoArchiving = useRef(new Set<string>());
	const settingsRef = useRef(settings);
	const keyActions = useRef<Record<string, () => void>>({});
	const overlayOpen = useRef(false);
	const settingsShown = useRef(false);
	const editorDraftsRef = useRef(editorDrafts);
	const queuedRef = useRef(queued);
	const promptRef = useRef<HTMLTextAreaElement | null>(null);
	const appVersion = useRef("");
	sessionsRef.current = sessions;
	overlayOpen.current = menu !== null || fileMenu !== null || shortcuts || settingsOpen !== null;
	settingsShown.current = settingsOpen !== null;
	pendingRef.current = pending;
	draftsRef.current = drafts;
	useWorktreeRef.current = useWorktree;
	settingsRef.current = settings;
	modesRef.current = modes;
	editorDraftsRef.current = editorDrafts;
	queuedRef.current = queued;
	const persistedDrafts = useRef(editorDrafts);
	const lastSaved = useRef<History | null>(history ? { sessions, extraChats, modes, prePlan, editorDrafts, composerDrafts: drafts, newSessionDraft: history.newSessionDraft, deleted } : null);
	const saveHistory = useRef<() => boolean>(() => true);

	function changeSettings(patch: Partial<AppSettings>) {
		setSettings((current) => ({ ...current, ...patch }));
	}

	function changeMode(id: string, next: PermissionMode) {
		const previous = knownMode(modesRef.current[id], settingsRef.current);
		if (next === "Plan" && previous !== "Plan") { setPrePlan((current) => ({ ...current, [id]: previous })); }
		modesRef.current = { ...modesRef.current, [id]: next };
		setModes(modesRef.current);
	}

	useEffect(() => {
		const reload = (event: StorageEvent) => { if (event.key === settingsKey) { setSettings(readSettings()); } };
		window.addEventListener("storage", reload);
		return () => window.removeEventListener("storage", reload);
	}, []);

	useEffect(() => {
		try {
			localStorage.setItem(settingsKey, JSON.stringify(settings));
		} catch {
			setNotice("Settings could not be saved. Changes last until the app closes.");
		}
	}, [settings]);

	useEffect(() => {
		const root = typeof document === "undefined" ? undefined : document.documentElement;
		if (!root) { return; }
		if (settings.appearance === "system") { root.removeAttribute("data-theme"); } else { root.setAttribute("data-theme", settings.appearance); }
	}, [settings.appearance]);

	useEffect(() => {
		const guard = (event: BeforeUnloadEvent) => {
			// ponytail: saved here without the lock, so a write from another window in the same instant can lose its last change.
			const saved = saveHistory.current();
			const current = editorDraftsRef.current;
			const unsavedMessage = !saved && Object.entries(draftsRef.current).some(([id, text]) => text && (pendingRef.current?.id === id || sessionsRef.current.some((item) => item.id === id)));
			// The queue is never saved, so a close or reload would drop a queued message.
			if (unsavedMessage || (current !== persistedDrafts.current && Object.values(current).some((draft) => draft && (draft.text !== draft.baseText || draft.recoveryTexts?.length))) || Object.values(queuedRef.current).some((items) => items.length)) {
				event.preventDefault();
				event.returnValue = false;
			}
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, []);

	// Set on every render, so a close saves what is on screen even before the effect below runs.
	saveHistory.current = () => {
		const last = lastSaved.current;
		const currentDrafts = draftsRef.current;
		const form = pendingRef.current;
		const newSessionDraft = form && currentDrafts[form.id] ? { session: form, useWorktree: useWorktreeRef.current, text: currentDrafts[form.id] } : undefined;
		const sameForm = last?.newSessionDraft?.session === newSessionDraft?.session && last?.newSessionDraft?.useWorktree === newSessionDraft?.useWorktree && last?.newSessionDraft?.text === newSessionDraft?.text;
		if (last && last.sessions === sessions && last.extraChats === extraChats && last.modes === modes && last.prePlan === prePlan && last.editorDrafts === editorDrafts && last.composerDrafts === currentDrafts && sameForm && last.deleted === deleted) { return true; }
		try {
			const saved = readHistory();
			const previous = saved ? last : null;
			const gone = new Set([...(saved?.deleted ?? []), ...deleted]);
			const oldSessions = new Map((previous?.sessions ?? []).map((item) => [item.id, item]));
			const currentSessions = new Map((saved?.sessions ?? []).map((item) => [item.id, item]));
			const savedIds = new Set(currentSessions.keys());
			for (const item of sessions) {
				const old = oldSessions.get(item.id);
				const changes = Object.fromEntries(Object.entries(item).filter(([key, value]) => value !== old?.[key as keyof Session]));
				currentSessions.set(item.id, currentSessions.has(item.id) ? { ...currentSessions.get(item.id), ...changes } as Session : item);
			}
			const order = [...sessions.filter((item) => !savedIds.has(item.id)).map((item) => item.id), ...savedIds].filter((id) => !gone.has(id) && id !== newSessionDraft?.session.id);
			const chats = slimChats(mergeChats(saved?.extraChats ?? {}, extraChats, previous?.extraChats ?? {}));
			for (const id of gone) { delete chats[id]; }
			const composerDrafts = { ...saved?.composerDrafts };
			for (const [id, text] of Object.entries(currentDrafts)) {
				if (text === previous?.composerDrafts?.[id]) { continue; }
				if (text) { composerDrafts[id] = text; } else { delete composerDrafts[id]; }
			}
			for (const id of Object.keys(composerDrafts)) { if (!order.includes(id)) { delete composerDrafts[id]; } }
			localStorage.setItem(historyKey, JSON.stringify({
				sessions: order.map((id) => currentSessions.get(id)),
				extraChats: chats,
				modes: { ...saved?.modes, ...Object.fromEntries(Object.entries(modes).filter(([id, value]) => value !== previous?.modes[id])) },
				prePlan: { ...saved?.prePlan, ...Object.fromEntries(Object.entries(prePlan).filter(([id, value]) => value !== previous?.prePlan[id])) },
				editorDrafts: keptDrafts(mergeDrafts(saved?.editorDrafts ?? {}, editorDrafts, previous?.editorDrafts ?? {}), gone),
				composerDrafts,
				newSessionDraft,
				deleted: [...gone].slice(-500),
			}));
			persistedDrafts.current = editorDrafts;
			lastSaved.current = { sessions, extraChats, modes, prePlan, editorDrafts, composerDrafts: currentDrafts, newSessionDraft, deleted };
			setNotice((current) => (current === HISTORY_FULL || current === HISTORY_FAILED ? "" : current));
			return true;
		} catch (error) {
			setNotice(error instanceof DOMException && error.name === "QuotaExceededError" ? HISTORY_FULL : HISTORY_FAILED);
			return false;
		}
	};

	useEffect(() => {
		if (!navigator.locks) { setNotice("Chat history could not be saved on this computer."); return; }
		void navigator.locks.request(historyKey, () => saveHistory.current()).catch(() => setNotice("Chat history could not be saved on this computer."));
	}, [sessions, extraChats, modes, prePlan, editorDrafts, deleted, pending, useWorktree]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!navigator.locks) { setNotice(HISTORY_FAILED); return; }
			void navigator.locks.request(historyKey, () => saveHistory.current()).catch(() => setNotice(HISTORY_FAILED));
		}, 500);
		return () => clearTimeout(timer);
	}, [drafts]);

	const writeReply = useCallback((uiSessionId: string, recipe: (message: ChatMessage) => ChatMessage) => {
		const target = turnTargets.current[uiSessionId];
		if (!target) { return; }
		const apply = (current: Record<string, ChatMessage[]>) => {
			const list = current[target.sessionId] ?? [];
			const index = list.findIndex((item) => item.id === target.replyId);
			if (index < 0) { return current; }
			const copy = list.slice();
			copy[index] = recipe(copy[index]);
			return { ...current, [target.sessionId]: copy };
		};
		if (target.where === "side") { setSideChats(apply); } else { setExtraChats(apply); }
	}, []);

	function notify(kind: "permission" | "question" | "done", sessionId: string, body: string) {
		const current = settingsRef.current;
		const level = kind === "permission" ? current.notifyPermission : kind === "question" ? current.notifyQuestion : current.notifyDone;
		const away = typeof document === "undefined" || !document.hasFocus?.() || sessionId !== activeIdRef.current;
		if (!away) { return; }
		if (current.attention) { void window.grokCode?.attention?.(); }
		if (level !== "banner" || typeof Notification === "undefined") { return; }
		const title = sessionsRef.current.find((item) => item.id === sessionId)?.title ?? "Codewomplers Grok Desktop";
		try {
			const shown = new Notification(title, { body, silent: current.sound === "none" });
			shown.onclick = () => { window.focus(); setActiveId(sessionId); setPending(null); };
		} catch {
			// Notifications can be blocked by the system.
		}
	}

	useEffect(() => {
		const api = window.grokCode;
		if (!api) { return; }
		return api.onEvent((event) => {
			if (event.type === "commands" && event.commands) {
				const list = event.commands;
				setCommands(list);
				try { localStorage.setItem(commandsKey, JSON.stringify(list)); } catch { /* cache only */ }
				return;
			}
			if (event.type === "models" && event.models) { setModels(event.models); return; }
			if (event.type === "account") {
				const value = event.account ?? null;
				setAccount(value);
				try { localStorage.setItem(accountKey, JSON.stringify(value)); } catch { /* cache only */ }
				return;
			}
			if (event.type === "mcp" && event.servers) { setServers(event.servers); return; }
			if (event.type === "mcp-status" && event.name) {
				const name = event.name;
				setServers((current) => current.map((item) => (item.name === name ? { ...item, status: event.status ?? "" } : item)));
				return;
			}
			if (event.type === "terminal-data" && event.id) {
				const id = event.id;
				const data = event.data ?? "";
				setTerminals((current) => Object.fromEntries(Object.entries(current).map(([sessionId, tabs]) => [sessionId, tabs.map((tab) => (tab.id === id ? { ...tab, output: `${tab.output}${data}`.slice(-200000) } : tab))])));
				return;
			}
			if (event.type === "terminal-exit" && event.id) {
				const id = event.id;
				setTerminals((current) => Object.fromEntries(Object.entries(current).map(([sessionId, tabs]) => [sessionId, tabs.map((tab) => (tab.id === id ? { ...tab, running: false } : tab))])));
				setDevTabs((current) => Object.fromEntries(Object.entries(current).filter(([, tabId]) => tabId !== id)));
				return;
			}
			const uiId = event.uiSessionId;
			const target = uiId ? turnTargets.current[uiId] : undefined;
			if (!uiId || !target || event.turnId !== target.turnId) { return; }
			const sessionId = target.sessionId;
			if (event.type === "mode") {
				const nextMode = event.mode;
				if (nextMode && target.where === "main") { changeMode(sessionId, nextMode); }
				return;
			}
			if (event.type === "usage" && event.usage) {
				const usage = event.usage;
				if (target.where === "main") {
					setSessions((current) => current.map((item) => (item.id === sessionId ? { ...item, usage, costUsd: (item.costUsd ?? 0) + usage.costUsd } : item)));
				}
				return;
			}
			if (event.type === "context" && event.contextTokens != null) {
				const live = { contextTokens: event.contextTokens, contextWindow: event.contextWindow || 256000 };
				if (target.where === "main") {
					setSessions((current) => current.map((item) => (item.id === sessionId ? { ...item, usage: { ...(item.usage ?? { model, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, reasoningTokens: 0, modelCalls: 0, costUsd: 0 }), ...live } } : item)));
				}
				return;
			}
			if (event.type === "tool" && event.tool?.waiting && target.where === "main") {
				notify(event.tool.questions ? "question" : "permission", sessionId, event.tool.questions ? "Grok has a question." : "Grok needs your approval.");
			}
			if (event.type === "done" || event.type === "error") {
				setBusy((current) => ({ ...current, [uiId]: false }));
				setNotice((current) => (current === SIDE_BUSY ? "" : current));
				setDiffTick((value) => value + 1);
				setFileTick((value) => value + 1);
				if (target.where === "main") {
					const away = sessionId !== activeIdRef.current;
					setSessions((current) => current.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: Date.now(), unread: away || item.unread, completed: false } : item)));
					notify("done", sessionId, event.type === "error" ? "Grok stopped with an error." : "Grok finished.");
				}
			}
			writeReply(uiId, (message) => {
				if (event.type === "chunk" && event.text) {
					const base = message.pending ? "" : message.text;
					const parts = [...(message.parts ?? [])];
					const last = parts[parts.length - 1];
					if (last && last.kind === "text") { parts[parts.length - 1] = { kind: "text", text: last.text + event.text }; } else { parts.push({ kind: "text", text: event.text }); }
					return { ...message, pending: false, text: base + event.text, parts };
				}
				if (event.type === "thought" && event.text) {
					return { ...message, thought: (message.thought ?? "") + event.text };
				}
				if (event.type === "tool" && event.tool) {
					const tools = message.tools ? [...message.tools] : [];
					const toolIndex = tools.findIndex((tool) => tool.id && tool.id === event.tool?.id);
					let parts = message.parts;
					if (toolIndex >= 0) {
						const previous = tools[toolIndex];
						const incoming = event.tool;
						tools[toolIndex] = {
							...previous,
							...incoming,
							kind: incoming.kind || previous.kind,
							title: incoming.title || previous.title,
							detail: incoming.detail || previous.detail,
							summary: incoming.summary ?? previous.summary,
							waiting: incoming.waiting ?? previous.waiting,
						};
					} else {
						tools.push({
							...event.tool,
							kind: event.tool.kind || "tool",
							title: event.tool.title || "Tool",
							detail: event.tool.detail || "Not run",
						});
						if (event.tool.id) { parts = [...(message.parts ?? []), { kind: "tool", id: event.tool.id }]; }
					}
					return { ...message, pending: false, tools, parts };
				}
				if (event.type === "done") {
					const stoppedTurn = event.stopReason === "cancelled";
					if (message.pending && !message.text) {
						return { ...message, pending: false, streaming: false, text: stoppedTurn ? "Stopped." : "No reply." };
					}
					return { ...message, pending: false, streaming: false };
				}
				if (event.type === "error" && event.message) {
					const prefix = message.text ? `${message.text}\n` : "";
					return { ...message, pending: false, streaming: false, text: `${prefix}${event.message}`, parts: [...(message.parts ?? []), { kind: "text", text: `${message.text ? "\n" : ""}${event.message}` }] };
				}
				return message;
			});
			if (event.type === "done" || event.type === "error") { delete turnTargets.current[uiId]; }
		});
	}, [writeReply]);

	const visible = pending ?? sessions.find((item) => item.id === activeId) ?? sessions.find((item) => !item.archived) ?? sessions[0];
	const session = visible;
	// The session on screen, which is the first one before any is picked; a new-session page is none.
	activeIdRef.current = pending ? "" : session.id;
	const mode = knownMode(modes[session.id] ?? settings.defaultMode, settings);
	const view = views[session.id] ?? "normal";
	const prompt = drafts[session.id] ?? "";
	const setPrompt = (next: string | ((current: string) => string)) => {
		const sessionId = session.id;
		const current = draftsRef.current;
		draftsRef.current = { ...current, [sessionId]: typeof next === "function" ? next(current[sessionId] ?? "") : next };
		setDrafts(draftsRef.current);
	};
	const messages = extraChats[session.id] ?? [];
	const scope = diffScope[session.id] ?? "uncommitted";
	const diffOpen = panes.includes("diff");
	const railOpen = settings.railOpen;
	// Like Claude's rail, it steps aside when the chat column would get too narrow.
	const railShown = railOpen && windowWidth - (settings.sidebarCollapsed ? 0 : 260) - (panes.length ? settings.sideWidth : 0) - 280 >= 560;
	const model = session.model ?? settings.model;
	const effort = session.effort ?? settings.effort;
	const modelInfo = models.find((item) => item.id === model);
	const efforts = modelInfo?.efforts.length ? modelInfo.efforts : EFFORTS.filter((item) => model !== "grok-4.5" || item !== "xhigh");
	const modelList = models.length ? models.map((item) => item.id).filter((id) => !Object.values(FAST_MODEL).includes(id)) : MODELS.filter((id) => !Object.values(FAST_MODEL).includes(id));
	const fastBase = Object.entries(FAST_MODEL).find(([, fast]) => fast === model)?.[0];
	const baseModel = fastBase ?? model;
	const fastOn = !!fastBase;

	useEffect(() => {
		if (!diffOpen && !railShown) { return; }
		const id = session.id;
		const folder = session.folder;
		const api = window.grokCode;
		if (!api?.diff) {
			setDiffs((current) => ({ ...current, [id]: { ok: false, error: "Reopen this window to read the working tree." } }));
			return;
		}
		let cancel = false;
		const read = scope !== "uncommitted" && api.scopedDiff ? api.scopedDiff(folder, scope) : api.diff(folder);
		void read.then((result) => {
			if (!cancel) { setDiffs((current) => ({ ...current, [id]: result })); }
		}).catch(() => {
			if (!cancel) { setDiffs((current) => ({ ...current, [id]: { ok: false, error: "The diff could not be read." } })); }
		});
		void api.branchInfo?.(folder).then((result) => { if (!cancel) { setBranches((current) => ({ ...current, [id]: result })); } }).catch(() => {});
		void api.prStatus?.(folder).then((result) => { if (!cancel) { setPrs((current) => ({ ...current, [id]: result })); } }).catch(() => {});
		if (diffOpen) {
			void api.listCommits?.(folder).then((result) => { if (!cancel && result.ok) { setCommits((current) => ({ ...current, [id]: result.commits ?? [] })); } }).catch(() => {});
		}
		return () => { cancel = true; };
	}, [diffOpen, railShown, session.id, session.folder, diffTick, scope]);

	useEffect(() => {
		const resize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);

	useEffect(() => {
		// Before Grok starts the host has no account, so the remembered one stays.
		void window.grokCode?.account?.().then((value) => { if (value !== undefined) { setAccount(value); } }).catch(() => {});
		const load = window.grokCode?.appInfo;
		if (!load) { return; }
		void load().then((info) => { if (info?.version) { appVersion.current = info.version; } }).catch(() => {});
	}, []);

	function createPr() {
		const api = window.grokCode;
		if (!api?.prCreate) { return Promise.resolve({ ok: false, error: "Reopen this window to create a pull request." }); }
		return api.prCreate(session.folder, branches[session.id]?.branch).then((result) => { setDiffTick((value) => value + 1); return result; });
	}

	function mergeWhenReady() {
		const api = window.grokCode;
		if (!api?.prMergeWhenReady) { return Promise.resolve({ ok: false, error: "Reopen this window to merge." }); }
		return api.prMergeWhenReady(session.folder, prs[session.id]?.pr?.number ?? 0).then((result) => { setDiffTick((value) => value + 1); return result; });
	}

	const popup = useMemo(() => {
		if (popClosed === prompt) { return null; }
		const slash = /^\/([\w:.-]*)$/.exec(prompt);
		if (slash) {
			const needle = slash[1].toLowerCase();
			const names = new Set<string>();
			const list = [...BUILT_INS, ...commands].filter((item) => {
				if (names.has(item.name) || !item.name.toLowerCase().includes(needle)) { return false; }
				names.add(item.name);
				return true;
			});
			return { kind: "slash" as const, needle, items: list.map((item) => ({ value: `/${item.name} `, label: `/${item.name}`, detail: item.description, hint: item.hint })) };
		}
		const mention = /(?:^|\s)@([\w./-]*)$/.exec(prompt);
		if (mention) {
			const needle = mention[1].toLowerCase();
			const files = (folderLists[session.id]?.files ?? []).filter((file) => file.toLowerCase().includes(needle)).slice(0, 12);
			return { kind: "mention" as const, needle, items: files.map((file) => ({ value: file, label: file, detail: "", hint: "" })) };
		}
		return null;
	}, [prompt, popClosed, commands, folderLists, session.id]);

	useEffect(() => { setPopIndex(0); }, [popup?.kind, popup?.needle]);
	useEffect(() => {
		popupList.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
	}, [popIndex, popup?.kind, popup?.needle]);

	// Opening a session reads it; "Mark as unread" on the open session stays until you leave it.
	useEffect(() => {
		if (pending || !session.unread) { return; }
		const id = session.id;
		setSessions((current) => current.map((item) => (item.id === id ? { ...item, unread: false } : item)));
	}, [session.id, !!pending]);

	function pickPopup(index: number) {
		if (!popup) { return; }
		const item = popup.items[index];
		if (!item) { return; }
		if (popup.kind === "slash") {
			// A command with no hint is complete; leaving it in the box looks like it did nothing.
			if (!item.hint) { void submit(item.value); return; }
			setPrompt(item.value);
		} else { setPrompt((current) => current.replace(/@([\w./-]*)$/, `@${item.value} `)); }
	}

	const folderFiles = folderLists[session.id];
	const dirtyDraftFiles = Object.entries(editorDrafts).flatMap(([key, draft]) => {
		if (!draft || (draft.text === draft.baseText && !draft.recoveryTexts?.length)) { return []; }
		const [id, folder, file] = JSON.parse(key) as string[];
		return id === session.id && folder === session.folder ? [file] : [];
	});

	useEffect(() => {
		const id = session.id;
		const folder = session.folder;
		const api = window.grokCode;
		if (!api?.files) {
			setFolderLists((current) => ({ ...current, [id]: { status: "error", error: "Reopen this window to read this folder.", files: [] } }));
			return;
		}
		let cancel = false;
		setFolderLists((current) => ({ ...current, [id]: { status: "loading", files: current[id]?.files ?? [] } }));
		void api.files(folder).then((result) => {
			if (cancel) { return; }
			if (!result.ok) {
				setFolderLists((current) => ({ ...current, [id]: { status: "error", error: result.error, files: [] } }));
				return;
			}
			const files = result.files ?? [];
			setFolderLists((current) => ({ ...current, [id]: { status: "ready", files, truncated: result.truncated } }));
			setEditorFile((current) => {
				const draft = editorDraftsRef.current[fileKey(session, current)];
				return files.includes(current) || (draft && draft.text !== draft.baseText) ? current : files[0] ?? "";
			});
		}).catch(() => {
			if (!cancel) { setFolderLists((current) => ({ ...current, [id]: { status: "error", error: "The file list could not be read.", files: [] } })); }
		});
		return () => { cancel = true; };
	}, [session.id, session.folder, fileTick]);

	useEffect(() => {
		const folder = session.folder;
		const file = editorFile;
		const key = fileKey(session, file);
		if (!file) { return; }
		const api = window.grokCode;
		if (!api?.readFile) {
			setOpenFiles((current) => ({ ...current, [key]: { status: "error", error: "Reopen this window to read this file." } }));
			return;
		}
		let cancel = false;
		setOpenFiles((current) => ({ ...current, [key]: { status: current[key]?.status === "ready" ? "ready" : "loading", text: current[key]?.text, version: current[key]?.version } }));
		void api.readFile(folder, file).then((result) => {
			if (cancel) { return; }
			if (!result.ok) {
				setOpenFiles((current) => ({ ...current, [key]: { status: "error", error: result.error } }));
				return;
			}
			setOpenFiles((current) => ({ ...current, [key]: { status: "ready", text: result.text ?? "", binary: result.binary, version: result.version } }));
			if (!result.binary && result.version) {
				const text = result.text ?? "";
				const version = result.version;
				setEditorDrafts((current) => {
					const draft = current[key];
					if (draft && draft.text !== draft.baseText) { return current; }
					return { ...current, [key]: { text, baseText: text, version, recoveryTexts: draft?.recoveryTexts } };
				});
			}
		}).catch(() => {
			if (!cancel) { setOpenFiles((current) => ({ ...current, [key]: { status: "error", error: "That file could not be read." } })); }
		});
		return () => { cancel = true; };
	}, [session.id, session.folder, editorFile, fileTick]);

	useEffect(() => {
		if (!settings.keepAwake) {
			void window.grokCode?.keepAwake?.({ working: false, onBattery: true });
			return;
		}
		void window.grokCode?.keepAwake?.({ working: Object.values(busy).some(Boolean), onBattery: settings.keepAwakeOnBattery });
	}, [busy, settings.keepAwake, settings.keepAwakeOnBattery]);

	// Runs at launch and when the setting changes, not on every session change, so Unarchive is not undone at once.
	useEffect(() => {
		const days = settings.autoArchiveDays;
		if (!days) { return; }
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		for (const item of sessions) {
			if (item.archived || item.pinned || busy[item.id] || (item.lastActivityAt ?? Date.now()) >= cutoff || autoArchiving.current.has(item.id)) { continue; }
			const api = window.grokCode;
			if (!item.worktreeFolder || !api?.removeWorktree) {
				updateSession(item.id, { archived: true });
				continue;
			}
			autoArchiving.current.add(item.id);
			void api.removeWorktree(item.folder, item.worktreeFolder, { force: false }).catch(() => {}).finally(() => {
				updateSession(item.id, { archived: true });
				autoArchiving.current.delete(item.id);
			});
		}
	}, [settings.autoArchiveDays]);

	useEffect(() => {
		if (!panes.includes("browser")) { return; }
		const id = session.id;
		void window.grokCode?.devScripts?.(session.folder).then((result) => setDevScripts((current) => ({ ...current, [id]: result.scripts ?? [] }))).catch(() => {});
	}, [panes, session.id, session.folder]);

	function togglePane(id: SidePaneId) {
		if (id === "editor" && panes.includes("editor")) { flushEditor(); }
		setPanes((current) => (current.includes(id) ? current.filter((pane) => pane !== id) : [...current, id]));
		setFocusedPane(id);
		setMenu(null);
	}

	function showPane(id: SidePaneId) {
		setPanes((current) => (current.includes(id) ? current : [...current, id]));
		setFocusedPane(id);
	}

	function closePane(id: SidePaneId) {
		if (id === "editor") { flushEditor(); }
		setPanes((current) => current.filter((pane) => pane !== id));
		setFocusedPane((current) => (current === id ? null : current));
	}

	function selectSession(id: string) {
		flushEditor();
		setPending(null);
		setActiveId(id);
		setMenu(null);
		setSessions((current) => (current.some((item) => item.id === id && item.unread) ? current.map((item) => (item.id === id ? { ...item, unread: false } : item)) : current));
	}

	function createSession(seed?: Partial<ProjectSeed>) {
		flushEditor();
		const base = seed?.folder ? seed : { folder: session.folder, project: session.project, branch: session.branch, worktree: session.project, environment: "Local" as Environment };
		const created = newSession(base);
		setPending(created);
		setUseWorktree(false);
		setMenu(null);
		setSideOpen(false);
		setTimeout(() => promptRef.current?.focus?.(), 0);
	}

	function stepSession(step: number) {
		const list = sessionsRef.current.filter((item) => !item.archived);
		if (!list.length) { return; }
		const found = list.findIndex((item) => item.id === (pendingRef.current ? "" : activeIdRef.current));
		const index = found < 0 ? (step < 0 ? 0 : -1) : found;
		selectSession(list[(index + step + list.length) % list.length].id);
	}

	function stop(uiId: string) {
		setHeld((current) => ({ ...current, [uiId]: true }));
		void window.grokCode?.cancel(uiId);
	}

	keyActions.current = {
		newSession: () => createSession(),
		next: () => stepSession(1),
		previous: () => stepSession(-1),
		stop: () => { if (busy[session.id]) { stop(session.id); } },
		cycleView: () => setViews((current) => ({ ...current, [session.id]: VIEWS[(VIEWS.indexOf(current[session.id] ?? "normal") + 1) % VIEWS.length] })),
		side: () => setSideOpen((value) => !value),
		terminal: () => togglePane("terminal"),
		diff: () => togglePane("diff"),
		browser: () => togglePane("browser"),
		select: () => { showPane("browser"); setSelectTick((value) => value + 1); },
		closePane: () => { const target = focusedPane && panes.includes(focusedPane) ? focusedPane : panes[panes.length - 1]; if (target) { closePane(target); } },
	};

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			const run = (name: string) => { event.preventDefault(); keyActions.current[name]?.(); };
			const key = event.key.toLowerCase();
			if (event.key === "Escape") {
				// Esc closes whatever is open; only with nothing open does it stop Grok.
				const target = event.target as Element | null;
				if (target?.closest?.(".side-q")) { setSideOpen(false); return; }
				if (target?.closest?.(".side-col, .session-rail")) { return; }
				if (overlayOpen.current) {
					setMenu(null);
					setFileMenu(null);
					setShortcuts(false);
					setSettingsOpen(null);
				} else {
					keyActions.current.stop?.();
				}
				return;
			}
			if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && document.querySelector(".pop")) {
				const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".pop button:not(:disabled)"));
				const item = items[Number(event.key) - 1];
				if (item) { event.preventDefault(); item.click(); }
				return;
			}
			if (!event.ctrlKey) { return; }
			// Settings covers the sessions, so its shortcuts must not change them unseen.
			if (settingsShown.current) { return; }
			if (event.key === "Tab") { run(event.shiftKey ? "previous" : "next"); return; }
			if (event.shiftKey && (event.code === "BracketRight" || event.key === "}")) { run("next"); return; }
			if (event.shiftKey && (event.code === "BracketLeft" || event.key === "{")) { run("previous"); return; }
			if (event.shiftKey && key === "b") { run("browser"); return; }
			if (event.shiftKey && key === "d") { run("diff"); return; }
			if (event.shiftKey && key === "s") { run("select"); return; }
			if (event.shiftKey && key === "m") { event.preventDefault(); setMenu("mode"); return; }
			if (event.shiftKey && key === "i") { event.preventDefault(); setMenu("model"); return; }
			if (event.shiftKey && key === "e") { event.preventDefault(); setMenu("effort"); return; }
			if (event.shiftKey) { return; }
			if (event.altKey) {
				if (event.key === "1") { run("newSession"); }
				return;
			}
			if (key === "n") { run("newSession"); return; }
			if (key === "o") { run("cycleView"); return; }
			if (key === "/") { event.preventDefault(); setShortcuts(true); return; }
			if (key === ",") { event.preventDefault(); setSettingsOpen("general"); return; }
			if (key === ";") { run("side"); return; }
			if (event.code === "Backquote" || key === "`") { run("terminal"); return; }
			if (key === "\\") { run("closePane"); }
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	async function addFolder() {
		if (addingFolder) { return; }
		const api = window.grokCode;
		if (!api?.pickFolder || !api.setAllowedFolders) {
			setNotice("Reopen this window to add an allowed folder.");
			return;
		}
		const sessionId = session.id;
		const folder = session.folder;
		setAddingFolder(true);
		try {
			const picked = await api.pickFolder();
			if (!picked) { return; }
			const current = sessionsRef.current.find((item) => item.id === sessionId) ?? (pendingRef.current?.id === sessionId ? pendingRef.current : undefined);
			if (!current || current.folder !== folder) {
				setNotice("The session folder changed. Add the allowed folder again.");
				return;
			}
			const existing = current.allowedFolders ?? [];
			if ([folder, ...existing].some((item) => folderKey(item) === folderKey(picked))) {
				setNotice("That folder is already allowed for this session.");
				return;
			}
			const result = await api.setAllowedFolders({ uiSessionId: sessionId, allowedFolders: [...existing, picked] });
			if (!result.ok) {
				setNotice(result.error || "That allowed folder could not be added.");
				return;
			}
			const update = (item: Session) => (item.id === sessionId && item.folder === folder
				? { ...item, allowedFolders: [...(item.allowedFolders ?? []).filter((value) => folderKey(value) !== folderKey(picked)), picked] }
				: item);
			setSessions((items) => items.map(update));
			setPending((item) => (item ? update(item) : item));
			setMenu(null);
		} catch {
			setNotice("That allowed folder could not be added.");
		} finally {
			setAddingFolder(false);
		}
	}

	function send(text: string, side: boolean, targetId = session.id, files: string[] = []) {
		const body = text.trim();
		const target = sessionsRef.current.find((item) => item.id === targetId);
		if (!body || !target) { return false; }
		const sessionId = target.id;
		const uiId = side ? `side-${sessionId}` : sessionId;
		const folder = target.folder;
		const current = settingsRef.current;
		const chosenModel = target.model ?? current.model;
		const chosenEffort = target.effort ?? current.effort;
		const chosenMode = side ? "Normal" : knownMode(modes[sessionId] ?? current.defaultMode, current);
		if (target.environment !== "Local") {
			setNotice("SSH and Cloud execution are not available. Choose Local before sending.");
			return false;
		}
		if (turnTargets.current[uiId]) {
			if (side) {
				setNotice(SIDE_BUSY);
				return false;
			}
			setQueued((list) => ({ ...list, [sessionId]: [...(list[sessionId] ?? []), { id: crypto.randomUUID(), text: body, attachments: files }] }));
			setHeld((list) => ({ ...list, [sessionId]: false }));
			return true;
		}
		if (!target.model) { updateSession(sessionId, { model: chosenModel, effort: chosenEffort }); }
		if (!side) {
			setHeld((list) => ({ ...list, [sessionId]: false }));
			if (!modes[sessionId]) { changeMode(sessionId, chosenMode); }
		}
		if (!side && target.title === "New session") {
			const title = body.replace(/\s+/g, " ").slice(0, 48);
			setSessions((list) => list.map((item) => (item.id === sessionId && item.title === "New session" ? { ...item, title, detail: "Live", when: "now" } : item)));
		}
		const stamp = Date.now();
		const replyId = `${side ? "side-grok" : "grok"}-${stamp}`;
		const turnId = crypto.randomUUID();
		turnTargets.current[uiId] = { sessionId, replyId, turnId, where: side ? "side" : "main" };
		const userMessage: ChatMessage = { id: `${side ? "side-user" : "user"}-${stamp}`, role: "user", text: body, live: true, ...(files.length ? { attachments: files } : {}) };
		const replyMessage: ChatMessage = { id: replyId, role: "grok", text: "", pending: true, streaming: true, live: true };
		const store = side ? setSideChats : setExtraChats;
		store((list) => ({ ...list, [sessionId]: [...(list[sessionId] ?? []), userMessage, replyMessage] }));
		if (!side) { setSessions((list) => list.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: stamp, completed: false } : item))); }
		const api = window.grokCode;
		if (!api) {
			writeReply(uiId, (message) => ({ ...message, pending: false, streaming: false, text: "Open this window from the desktop app to talk to Grok." }));
			delete turnTargets.current[uiId];
			return true;
		}
		setBusy((list) => ({ ...list, [uiId]: true }));
		const sideAgent = sideAgents[sessionId];
		// A side question carries the main-chat messages it has not seen yet; a reply still streaming waits for the next one.
		const main = (extraChats[sessionId] ?? []).filter((message) => !message.streaming);
		const seen = sideAgent ? main.findIndex((message) => message.id === sideSeen.current[sessionId]) : -1;
		const outgoing = side ? `${sideContext(main.slice(seen + 1))}${body}` : body;
		if (side && main.length) { sideSeen.current[sessionId] = main[main.length - 1].id; }
		void api.send({
			uiSessionId: uiId,
			turnId,
			cwd: folder,
			text: outgoing,
			model: chosenModel,
			effort: chosenEffort,
			mode: chosenMode,
			agentSessionId: side ? sideAgent : target.agentSessionId,
			allowedFolders: target.allowedFolders ?? [],
			...(files.length ? { attachments: files } : {}),
		}).then((result) => {
			if (result.agentSessionId) {
				const agentId = result.agentSessionId;
				// A reply that lands after Choose a folder must not bring the old folder's side conversation back.
				const now = sessionsRef.current.find((item) => item.id === sessionId) ?? (pendingRef.current?.id === sessionId ? pendingRef.current : undefined);
				if (side) { if (now?.folder === folder) { setSideAgents((list) => ({ ...list, [sessionId]: agentId })); } } else { setSessions((list) => list.map((item) => (item.id === sessionId && item.folder === folder ? { ...item, agentSessionId: agentId } : item))); }
			}
			if (result.lostSession && side) {
				setSideAgents((list) => Object.fromEntries(Object.entries(list).filter(([id]) => id !== sessionId)));
				delete sideSeen.current[sessionId];
			} else if (result.lostSession) {
				setSessions((list) => list.map((item) => (item.id === sessionId && item.folder === folder ? { ...item, agentSessionId: undefined } : item)));
			}
			if (result.ok) { return; }
			setBusy((list) => ({ ...list, [uiId]: false }));
			writeReply(uiId, (message) => ({ ...message, pending: false, streaming: false, text: `${message.text ? `${message.text}\n` : ""}${result.error || "Grok could not start."}` }));
			if (turnTargets.current[uiId]?.turnId === turnId) { delete turnTargets.current[uiId]; }
		}).catch(() => {
			setBusy((list) => ({ ...list, [uiId]: false }));
			writeReply(uiId, (message) => ({ ...message, pending: false, streaming: false, text: message.text || "Grok could not start." }));
			if (turnTargets.current[uiId]?.turnId === turnId) { delete turnTargets.current[uiId]; }
		});
		return true;
	}

	useEffect(() => {
		for (const [sessionId, items] of Object.entries(queued)) {
			if (!items.length || held[sessionId] || busy[sessionId] || turnTargets.current[sessionId]) { continue; }
			setQueued((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((item) => item.id !== items[0].id) }));
			send(items[0].text, false, sessionId, items[0].attachments);
		}
	}, [queued, held, busy]);

	function sendNow(sessionId: string, itemId: string) {
		setQueued((current) => {
			const items = current[sessionId] ?? [];
			const item = items.find((entry) => entry.id === itemId);
			return item ? { ...current, [sessionId]: [item, ...items.filter((entry) => entry !== item)] } : current;
		});
		setHeld((current) => ({ ...current, [sessionId]: false }));
		if (turnTargets.current[sessionId]) { void window.grokCode?.cancel(sessionId); }
	}

	async function commitPending(): Promise<Session | null> {
		const draft = pendingRef.current;
		if (!draft) { return session; }
		let created = draft;
		if (useWorktree) {
			const api = window.grokCode;
			if (!api?.addWorktree) {
				setNotice("Reopen this window to create a worktree.");
				return null;
			}
			// A second Enter while the worktree is being made would make another one and send twice.
			if (creatingWorktree.current) { return null; }
			const name = `${(prompt.toLowerCase().match(/[a-z0-9]+/g) ?? ["session"]).slice(0, 4).join("-").slice(0, 28)}-${Math.random().toString(36).slice(2, 6)}`;
			creatingWorktree.current = true;
			setNotice("Creating the worktree…");
			const result = await api.addWorktree(draft.folder, { name, prefix: settingsRef.current.branchPrefix }).finally(() => { creatingWorktree.current = false; });
			if (!result.ok || !result.folder) {
				setNotice(result.error || "The worktree could not be created.");
				return null;
			}
			setNotice((current) => current === "Creating the worktree…" ? "" : current);
			created = { ...draft, folder: result.folder, branch: result.branch ?? draft.branch, worktree: shortPath(result.folder), worktreeFolder: result.folder };
			setDrafts((current) => ({ ...current, [created.id]: current[draft.id] ?? "" }));
		}
		sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
		setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
		setActiveId(created.id);
		pendingRef.current = null;
		setPending(null);
		return created;
	}

	// A command picked in Settings, such as /create-skill, goes to this session and leaves its draft alone.
	async function runFromSettings(text: string) {
		setSettingsOpen(null);
		const target = await commitPending();
		if (target) { send(text, false, target.id); }
	}

	async function submit(value = prompt) {
		const text = value.trim();
		if (!text) { return; }
		if (text === "/config") { setSettingsOpen("general"); setPrompt(""); return; }
		if (text.startsWith("!") && text.length > 1 && pending) { setNotice("Send a first message to start this session, then run terminal commands with !."); return; }
		if (text.startsWith("!") && text.length > 1 && !pending) {
			setPrompt("");
			await runInTerminal(text.slice(1).trim());
			return;
		}
		if (text === "/status" || text === "/info") {
			const sessionId = session.id;
			const percent = session.usage?.contextWindow ? Math.min(100, Math.round((session.usage.contextTokens / Math.max(1, session.usage.contextWindow)) * 100)) : null;
			const lines = [
				appVersion.current ? `Codewomplers Grok Desktop ${appVersion.current}` : "Codewomplers Grok Desktop",
				`${model} · ${effort} · ${mode}`,
				session.folder,
				...(percent != null ? [`Context ${percent}% · $${(session.costUsd ?? 0).toFixed(2)}`] : []),
			];
			const stamp = crypto.randomUUID();
			setExtraChats((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { id: `user-${stamp}`, role: "user", text, live: true }, { id: `grok-${stamp}`, role: "grok", text: lines.join("\n"), live: true }] }));
			setNotice(lines.join(" · "));
			setPrompt("");
			return;
		}
		if (text.startsWith("/btw ")) {
			setSideOpen(true);
			if (send(text.slice(5), true)) { setPrompt(""); }
			return;
		}
		const target = await commitPending();
		if (!target) { return; }
		const files = attachments[session.id] ?? [];
		if (send(text, false, target.id, files)) {
			setDrafts((current) => ((current[target.id] ?? "") === prompt ? { ...current, [session.id]: "", [target.id]: "" } : current));
			setAttachments((current) => ({ ...current, [session.id]: [], [target.id]: [] }));
		}
	}

	function addAttachments(paths: string[]) {
		const sessionId = session.id;
		const clean = paths.filter(Boolean);
		if (!clean.length) { return; }
		setAttachments((current) => ({ ...current, [sessionId]: [...new Set([...(current[sessionId] ?? []), ...clean])].slice(0, 20) }));
	}

	function onDrop(event: DragEvent) {
		const api = window.grokCode;
		if (!api?.pathForFile || !event.dataTransfer?.files?.length) { return; }
		event.preventDefault();
		addAttachments(Array.from(event.dataTransfer.files).map((file) => api.pathForFile(file)));
	}

	function onPaste(event: ClipboardEvent) {
		const api = window.grokCode;
		const image = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith("image/"));
		const blob = image?.getAsFile();
		if (!api?.saveImage || !blob) { return; }
		event.preventDefault();
		const reader = new FileReader();
		reader.onload = () => {
			const base64 = String(reader.result ?? "").split(",")[1] ?? "";
			void api.saveImage(base64).then((result) => {
				if (result.ok && result.path) { addAttachments([result.path]); } else { setNotice(result.error || "That image could not be attached."); }
			});
		};
		reader.readAsDataURL(blob);
	}

	function answerTool(uiId: string, toolId: string, request: (api: GrokCodeApi, uiSessionId: string) => Promise<GrokSendResult>, onAnswered?: () => void): Promise<GrokSendResult> {
		const api = window.grokCode;
		if (!api?.answerQuestion || !api.answerPlan) { return Promise.resolve({ ok: false, error: "Reopen this window to answer Grok." }); }
		return request(api, uiId).then((result) => {
			if (result.ok) { onAnswered?.(); }
			if (!result.ok && result.closed) {
				writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: result.error || "That request already closed." } : tool)) }));
			}
			return result;
		}).catch(() => ({ ok: false, error: "That answer could not be sent." }));
	}

	function openFile(file: string, line?: number) {
		if (file !== editorFile) { flushEditor(); }
		setEditorFile(file);
		setEditorLine((current) => ({ line, tick: current.tick + 1 }));
		showPane("editor");
		setFileMenu(null);
	}

	function signOut() {
		const api = window.grokCode;
		if (!api?.signOut) { return; }
		if (!window.confirm("Sign out of Grok on this computer? Grok in a terminal signs out too. Grok's background commands will stop.")) { return; }
		void api.signOut().then((result) => setNotice(result.ok ? "Signed out. Grok asks you to sign in when you next send a message." : result.error || "Grok could not sign out."));
	}

	function openUrl(url: string, external: boolean) {
		const api = window.grokCode;
		if (external || !settingsRef.current.linksInBuiltIn) {
			void api?.openExternal?.(url).then((result) => { if (!result.ok) { setNotice(result.error || "That link could not open."); } });
			return;
		}
		const sessionId = session.id;
		const id = crypto.randomUUID();
		setBrowserTabs((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { id, url, title: url }] }));
		setActiveBrowser((current) => ({ ...current, [sessionId]: id }));
		showPane("browser");
	}

	function openLink(href: string, event: MouseEvent) {
		let url: URL | null = null;
		try { url = new URL(href); } catch { url = null; }
		// `C:/project/foo.ts` parses as a URL with a `c:` scheme; it is a file path.
		if (url && (/^[a-z]:$/i.test(url.protocol) || url.protocol.includes("."))) { url = null; }
		if (!url) {
			const match = /^(.+?)(?::(\d+))?$/.exec(href);
			if (!match) { return; }
			const file = match[1].replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			const root = `${session.folder.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
			openFile(file.toLowerCase().startsWith(root.toLowerCase()) ? file.slice(root.length) : file, match[2] ? Number(match[2]) : undefined);
			return;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			setNotice("Only http and https links open from the chat.");
			return;
		}
		const external = event.ctrlKey || event.metaKey;
		if (!settingsRef.current.linkAsked && !external) {
			const inside = window.confirm("Open chat links in the Browser pane? Choose Cancel to open them in your default browser. You can change this in Settings.");
			changeSettings({ linkAsked: true, linksInBuiltIn: inside });
			settingsRef.current = { ...settingsRef.current, linkAsked: true, linksInBuiltIn: inside };
		}
		openUrl(url.toString(), external);
	}

	function copyText(text: string, label = "Copied.") {
		const api = window.grokCode;
		if (!api?.copyText) {
			setNotice("Reopen this window to copy.");
			return;
		}
		void api.copyText(text).then((result) => setNotice(result.ok ? label : (result.error || "That could not be copied.")));
	}

	function openImage(file: string) {
		const api = window.grokCode;
		if (!api?.openImage) {
			setNotice("Reopen this window to view images.");
			return;
		}
		void api.openImage(file).then((result) => { if (!result.ok) { setNotice(result.error || "That image could not open."); } });
	}

	async function openTerminal(sessionId = session.id, folder = session.folder, title = "") {
		const api = window.grokCode;
		if (!api?.terminalOpen) {
			setTerminalError("Reopen this window to open a terminal.");
			return "";
		}
		const result = await api.terminalOpen({ cwd: folder });
		if (!result.ok || !result.id) {
			setTerminalError(result.error || "The terminal could not start.");
			return "";
		}
		const id = result.id;
		setTerminalError("");
		setTerminals((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { id, title: title || `Terminal ${(current[sessionId]?.length ?? 0) + 1}`, cwd: folder, running: true, output: "" }] }));
		setActiveTerminal((current) => ({ ...current, [sessionId]: id }));
		return id;
	}

	async function runInTerminal(code: string) {
		showPane("terminal");
		const tabs = (terminals[session.id] ?? []).filter((tab) => tab.running && folderKey(tab.cwd) === folderKey(session.folder) && !Object.values(devTabs).includes(tab.id));
		const id = tabs.find((tab) => tab.id === activeTerminal[session.id])?.id ?? tabs[0]?.id ?? await openTerminal();
		if (!id) { return; }
		setActiveTerminal((current) => ({ ...current, [session.id]: id }));
		const result = await window.grokCode?.terminalWrite?.(id, code);
		if (result && !result.ok) { setTerminalError(result.error || "That command could not run."); }
	}

	async function startServer(script: string) {
		const key = `${session.id}:${script}`;
		const id = await openTerminal(session.id, session.folder, `dev: ${script}`);
		if (!id) { return; }
		setDevTabs((current) => ({ ...current, [key]: id }));
		await window.grokCode?.terminalWrite?.(id, `npm run ${script}`);
	}

	function stopTerminal(id: string) {
		void window.grokCode?.terminalClose?.(id);
	}

	const sideId = `side-${session.id}`;
	const todos = latestTool(messages, (tool) => tool.todos) ?? [];
	const planText = latestTool(messages, (tool) => (tool.plan ? tool.plan : undefined)) ?? "";
	const sessionTerminals = terminals[session.id] ?? [];
	const backgroundTasks: BackgroundTask[] = [
		...(busy[session.id] ? [{ id: "turn", label: "Grok is working", detail: session.title, running: true, onStop: () => stop(session.id) }] : []),
		...(busy[sideId] ? [{ id: "side", label: "Side chat", detail: "Answering a side question", running: true, onStop: () => stop(sideId) }] : []),
		...(queued[session.id] ?? []).map((item) => ({ id: item.id, label: "Queued message", detail: item.text, running: false })),
		...sessionTerminals.map((tab) => ({ id: tab.id, label: tab.title, detail: tab.cwd, running: tab.running, onStop: () => stopTerminal(tab.id), onOpen: () => { setActiveTerminal((current) => ({ ...current, [session.id]: tab.id })); showPane("terminal"); } })),
	];

	function paneModel(uiId: string, list: ChatMessage[]): PaneModel {
		return {
			session,
			messages: list,
			view,
			todos,
			plan: planText,
			tasks: backgroundTasks,
			busy: !!busy[uiId],
			decide: (toolId, decision) => {
				writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: decision === "deny" ? "Denied" : "Allowed" } : tool)) }));
				void window.grokCode?.decide({ uiSessionId: uiId, toolId, decision }).then((result) => {
					if (result.ok) { return; }
					writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: result.error || "That approval already closed." } : tool)) }));
				});
			},
			answerQuestion: (toolId, answers) => answerTool(uiId, toolId, (api, uiSessionId) => api.answerQuestion({ uiSessionId, toolId, answers })),
			resumeMode: (prePlan[session.id] ?? "Normal") as "Normal" | "Auto-review" | "Always-approve",
			answerPlan: (toolId, choice) => answerTool(uiId, toolId, (api, uiSessionId) => api.answerPlan({ uiSessionId, toolId, ...choice }), () => {
				const resume = prePlan[session.id] ?? "Normal";
				const next = choice.outcome === "approved" || choice.outcome === "abandoned" ? (choice.mode ?? (resume === "Plan" ? "Normal" : resume)) : undefined;
				if (next && uiId === session.id) { setModes((current) => ({ ...current, [session.id]: next })); }
			}),
			folderFiles: folderFiles ? { ...folderFiles, files: [...new Set([...folderFiles.files, ...dirtyDraftFiles])] } : undefined,
			openFile,
			fileMenu: (file, event) => setFileMenu({ file, x: event.clientX, y: event.clientY }),
			openLink,
			copyText: (text) => copyText(text),
			openImage,
			runInTerminal: (code) => { void runInTerminal(code); },
			closePane: (id) => closePane(id),
		};
	}
	const modelForPanes = paneModel(session.id, messages);
	const sideModel = paneModel(sideId, sideChats[session.id] ?? []);

	const editorKey = fileKey(session, editorFile);
	const editorDraft = editorDrafts[editorKey];
	const editorOpen = openFiles[editorKey];
	const editorDirty = !!editorDraft && editorDraft.text !== editorDraft.baseText;
	const editorConflict = editorDirty && editorOpen?.status === "ready" && !!editorOpen.version && editorOpen.version !== editorDraft?.version;
	const editorReadOnly = PROTECTED.some((pattern) => pattern.test(editorFile.replace(/\\/g, "/")));

	function saveEditor(expected?: string) {
		const api = window.grokCode;
		const file = editorFile;
		const folder = session.folder;
		const key = fileKey(session, file);
		const draft = editorDraftsRef.current[key];
		if (!api?.writeFile || !draft || draft.saving || editorReadOnly) { return; }
		// A second save in the same event, such as the Files pane's flush and then flushEditor, must see this one before React renders.
		editorDraftsRef.current = { ...editorDraftsRef.current, [key]: { ...draft, saving: true } };
		const original = draft.baseText;
		const savedText = /\r\n/.test(original) && !/(?<!\r)\n/.test(original) ? draft.text.replace(/\r?\n/g, "\r\n") : draft.text;
		setEditorDrafts((current) => (current[key] ? { ...current, [key]: { ...current[key]!, saving: true, note: "Saving…" } } : current));
		void api.writeFile(folder, file, savedText, expected ?? draft.version).then((result) => {
			if (result.ok) {
				setOpenFiles((current) => ({ ...current, [key]: { status: "ready", text: savedText, binary: false, version: result.version } }));
				setEditorDrafts((current) => {
					const latest = current[key];
					const typedSince = latest && latest.text !== draft.text;
					return { ...current, [key]: { text: typedSince ? latest.text : savedText, baseText: savedText, version: result.version ?? draft.version, recoveryTexts: latest?.recoveryTexts, note: "" } };
				});
				setDiffTick((value) => value + 1);
			} else {
				setEditorDrafts((current) => (current[key] ? { ...current, [key]: { ...current[key]!, saving: false, note: result.error || "That file could not be saved." } } : current));
				setFileTick((value) => value + 1);
			}
		}).catch(() => {
			setEditorDrafts((current) => (current[key] ? { ...current, [key]: { ...current[key]!, saving: false, note: "That file could not be saved." } } : current));
		});
	}

	// The Files pane flushes its own pending save; changes made from here would drop it with the debounce timer.
	function flushEditor() {
		if (settings.autoSave && editorDirty && !editorConflict && !editorReadOnly && !editorDraft?.saving) {
			saveEditor();
		}
	}

	// Loads the disk version; the dropped draft stays under "Retained draft" until the user discards it.
	async function reloadEditor() {
		const file = editorFile;
		const folder = session.folder;
		const key = fileKey(session, file);
		try {
			const result = await window.grokCode?.readFile(folder, file);
			if (!result?.ok || result.binary || !result.version) { throw new Error(result?.error || "The disk file is not editable UTF-8. Your draft is retained."); }
			const text = result.text ?? "";
			const version = result.version;
			setOpenFiles((current) => ({ ...current, [key]: { status: "ready", text, binary: false, version } }));
			setEditorDrafts((current) => {
				const draft = current[key];
				const recoveryTexts = [...new Set([...(draft?.recoveryTexts ?? []), ...(draft && draft.text !== draft.baseText ? [draft.text] : [])])];
				return { ...current, [key]: { text, baseText: text, version, recoveryTexts, note: recoveryTexts.length ? "Disk version loaded. Your edits are kept below until you discard them." : "" } };
			});
		} catch (error) {
			setEditorDrafts((current) => (current[key] ? { ...current, [key]: { ...current[key]!, note: error instanceof Error ? error.message : "The file could not be reloaded. Your draft is retained." } } : current));
		}
	}

	const activity = useMemo(() => {
		const map: Record<string, "running" | "needs-you"> = {};
		for (const [id, list] of Object.entries(extraChats)) {
			if (list.some((message) => message.tools?.some((tool) => tool.waiting))) { map[id] = "needs-you"; }
		}
		for (const [id, isBusy] of Object.entries(busy)) {
			if (isBusy && !id.startsWith("side-") && !map[id]) { map[id] = "running"; }
		}
		return map;
	}, [extraChats, busy]);

	function openSessionWindow(id: string) {
		const api = window.grokCode;
		if (!api?.newWindow) {
			setNotice("Reopen this window to open another.");
			return Promise.resolve();
		}
		return (async () => {
			try {
				const saved = await navigator.locks.request(historyKey, () => readHistory()?.sessions.some((item) => item.id === id));
				if (!saved) { setNotice("This chat could not be saved. Keep this window open before opening it elsewhere."); return; }
				const result = await api.newWindow(id);
				if (!result.ok) { setNotice(result.error || "That chat could not open in a new window."); }
			} catch {
				setNotice("That chat could not open in a new window.");
			}
		})();
	}

	function openIn(target: "explorer" | "vscode", file?: string, line?: number) {
		const api = window.grokCode;
		if (!api?.openIn) {
			setNotice("Reopen this window to open it.");
			return;
		}
		void api.openIn({ target, cwd: session.folder, ...(file ? { file } : {}), ...(line ? { line } : {}) }).then((result) => { if (!result.ok) { setNotice(result.error || "That could not open."); } });
		setMenu(null);
		setFileMenu(null);
	}

	function updateSession(id: string, patch: Partial<Session>) {
		setSessions((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	}

	const usage = session.usage;
	// The context split and the week's spend are read from Grok's files when a turn ends or the session changes.
	const agentId = session.agentSessionId ?? "";
	const idle = !busy[session.id];
	useEffect(() => {
		if (!idle) { return; }
		const api = window.grokCode;
		void api?.recentSpend?.().then((result) => { if (result.ok && result.usd != null) { setRecentUsd(result.usd); } });
		if (!agentId) { return; }
		void api?.contextBreakdown?.(agentId).then((result) => {
			if (result.ok && result.parts) { setBreakdown({ id: agentId, parts: result.parts, autoCompactPercent: result.autoCompactPercent ?? 85 }); }
		});
	}, [agentId, idle]);
	const queue = queued[session.id] ?? [];
	const files = attachments[session.id] ?? [];
	const isBusy = !!busy[session.id];
	const sendLabel = isBusy && !prompt.trim() ? "Stop" : "Send";
	const recentFolders = [...new Map(sessions.map((item) => [folderKey(item.folder), item.folder])).values()].slice(0, 8);
	const browserList = browserTabs[session.id] ?? [];
	const servers2: DevServer[] = (devScripts[session.id] ?? []).map((item) => ({ ...item, running: !!devTabs[`${session.id}:${item.script}`] }));
	const diffComments = comments[session.id] ?? [];
	const prInfo = prs[session.id];
	const branch = branches[session.id];

	function sidePane(id: SidePaneId) {
		const focus = () => setFocusedPane(id);
		let body = null;
		if (id === "diff") {
			body = (
				<DiffPane
					key={session.id}
					snapshot={diffs[session.id]}
					scope={scope}
					onScope={(value) => setDiffScope((current) => ({ ...current, [session.id]: value }))}
					commits={commits[session.id] ?? []}
					selectedFile={diffFile}
					onSelectFile={setDiffFile}
					onRefresh={() => setDiffTick((value) => value + 1)}
					onRevert={(file) => {
						const api = window.grokCode;
						if (!api?.revertFile) { return Promise.resolve({ ok: false, error: "Reopen this window to restore this file." }); }
						return api.revertFile(session.folder, file).then((result) => {
							if (result.ok) { setDiffTick((value) => value + 1); setFileTick((value) => value + 1); }
							return result;
						}).catch(() => ({ ok: false, error: "That file could not be restored." }));
					}}
					comments={diffComments}
					onAddComment={(comment) => setComments((current) => ({ ...current, [session.id]: [...(current[session.id] ?? []), { ...comment, id: crypto.randomUUID() }] }))}
					onRemoveComment={(commentId) => setComments((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((item) => item.id !== commentId) }))}
					onSendComments={() => {
						if (!diffComments.length) { return; }
						const text = `Comments on the diff:\n\n${diffComments.map((item) => `- ${item.file}:${item.line}${item.side === "old" ? " (old side, before the change)" : ""} — ${item.text}`).join("\n")}`;
						if (send(text, false)) { setComments((current) => ({ ...current, [session.id]: [] })); }
					}}
					branch={branch?.ok && branch.repo !== false && branch.branch ? { branch: branch.branch, base: branch.base ?? "main", ahead: branch.ahead ?? 0 } : undefined}
					pr={prInfo?.ok ? (prInfo.pr as PrInfo | null) : prInfo ? null : undefined}
					prError={prInfo && !prInfo.ok ? prInfo.error : undefined}
					onCreatePr={createPr}
					onMergeWhenReady={mergeWhenReady}
					onOpenFile={openFile}
					onFileMenu={(file, event) => setFileMenu({ file, x: event.clientX, y: event.clientY })}
					onClose={() => closePane("diff")}
				/>
			);
		} else if (id === "editor") {
			body = (
				<FilesPane
					files={modelForPanes.folderFiles}
					file={editorFile}
					onSelectFile={(file) => openFile(file)}
					line={editorLine.line}
					lineTick={editorLine.tick}
					open={editorOpen}
					draft={editorDraft}
					readOnly={editorReadOnly}
					autoSave={settings.autoSave}
					onAutoSave={(on) => changeSettings({ autoSave: on })}
					onEdit={(text) => setEditorDrafts((current) => (current[editorKey] ? { ...current, [editorKey]: { ...current[editorKey]!, text, note: "" } } : current))}
					onSave={() => saveEditor()}
					onCancel={() => setEditorDrafts((current) => (current[editorKey] ? { ...current, [editorKey]: { ...current[editorKey]!, text: current[editorKey]!.baseText, note: "" } } : current))}
					conflict={editorConflict}
					onOverride={() => saveEditor(editorOpen?.version)}
					onDiscard={() => { void reloadEditor(); }}
					onClearRecovery={() => setEditorDrafts((current) => (current[editorKey] ? { ...current, [editorKey]: { ...current[editorKey]!, recoveryTexts: [] } } : current))}
					onFileMenu={(file, event) => setFileMenu({ file, x: event.clientX, y: event.clientY })}
					onClose={() => closePane("editor")}
				/>
			);
		} else if (id === "terminal") {
			body = (
				<TerminalPane
					tabs={sessionTerminals}
					activeId={sessionTerminals.find((tab) => tab.id === activeTerminal[session.id])?.id ?? sessionTerminals[0]?.id ?? ""}
					error={terminalError}
					onActivate={(tabId) => setActiveTerminal((current) => ({ ...current, [session.id]: tabId }))}
					onNew={() => { void openTerminal(); }}
					onCloseTab={(tabId) => {
						stopTerminal(tabId);
						setTerminals((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((tab) => tab.id !== tabId) }));
					}}
					onInput={(tabId, text) => {
						void window.grokCode?.terminalWrite?.(tabId, text).then((result) => { if (!result.ok) { setTerminalError(result.error || "That line could not be sent."); } });
					}}
					onClose={() => closePane("terminal")}
				/>
			);
		} else if (id === "browser") {
			body = (
				<BrowserPane
					tabs={browserList}
					activeId={browserList.find((tab) => tab.id === activeBrowser[session.id])?.id ?? browserList[0]?.id ?? ""}
					onActivate={(tabId) => setActiveBrowser((current) => ({ ...current, [session.id]: tabId }))}
					onNewTab={() => {
						const tabId = crypto.randomUUID();
						setBrowserTabs((current) => ({ ...current, [session.id]: [...(current[session.id] ?? []), { id: tabId, url: "", title: "New tab" }] }));
						setActiveBrowser((current) => ({ ...current, [session.id]: tabId }));
					}}
					onCloseTab={(tabId) => setBrowserTabs((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((tab) => tab.id !== tabId) }))}
					onNavigate={(tabId, raw) => {
						let url: URL;
						try { url = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`); } catch { setBrowserError("Type an http or https address."); return; }
						if (url.protocol !== "http:" && url.protocol !== "https:") { setBrowserError("Only http and https addresses open here."); return; }
						setBrowserError("");
						setBrowserTabs((current) => ({ ...current, [session.id]: (current[session.id] ?? []).map((tab) => (tab.id === tabId ? { ...tab, url: url.toString(), title: url.host } : tab)) }));
					}}
					onPageChanged={(tabId, url, title) => setBrowserTabs((current) => ({ ...current, [session.id]: (current[session.id] ?? []).map((tab) => (tab.id === tabId ? { ...tab, url: url || tab.url, title: title || tab.title } : tab)) }))}
					error={browserError}
					keepCookies={settings.keepCookies}
					onKeepCookies={(on) => changeSettings({ keepCookies: on })}
					onClearData={() => { void Promise.all(["persist:grok-code", "temp:grok-code"].map((partition) => window.grokCode?.clearBrowsingData?.(partition))).then((results) => { const failed = results.find((result) => result && !result.ok); setNotice(failed ? (failed.error || "Browsing data could not be cleared.") : "Browsing data cleared."); }); }}
					linksInBuiltIn={settings.linksInBuiltIn}
					onLinksInBuiltIn={(on) => changeSettings({ linksInBuiltIn: on, linkAsked: true })}
					devServers={servers2}
					onStartServer={(script) => { void startServer(script); }}
					onStopServer={(script) => { const tabId = devTabs[`${session.id}:${script}`]; if (tabId) { stopTerminal(tabId); } }}
					onStopAll={() => Object.entries(devTabs).filter(([key]) => key.startsWith(`${session.id}:`)).forEach(([, tabId]) => stopTerminal(tabId))}
					selectTick={selectTick}
					onPicked={(pick) => {
						setPrompt((current) => `${current}${current ? "\n\n" : ""}Selected element on ${pick.url}: \`${pick.selector}\`\n\`\`\`html\n${pick.html}\n\`\`\``);
						promptRef.current?.focus?.();
					}}
					onClose={() => closePane("browser")}
				/>
			);
		} else {
			body = <PaneView id={id} model={modelForPanes} />;
		}
		return <div key={id} className={focusedPane === id ? "side-slot focused" : "side-slot"} onMouseDownCapture={focus} onFocusCapture={focus}>{body}</div>;
	}

	function startResize(event: MouseEvent) {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = settings.sideWidth;
		const move = (moveEvent: globalThis.MouseEvent) => changeSettings({ sideWidth: Math.min(Math.max(startWidth - (moveEvent.clientX - startX), 320), Math.max(360, window.innerWidth - 640)) });
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	const contextPercent = usage ? Math.min(100, Math.round((usage.contextTokens / Math.max(1, usage.contextWindow)) * 100)) : null;

	return (
		<div className={settings.sidebarCollapsed ? "app collapsed" : "app"}>
			{(menu || fileMenu) && <button className="backdrop" aria-label="Close menu" onClick={() => { setMenu(null); setFileMenu(null); }} />}
			{!settings.sidebarCollapsed && (
				<Sidebar
					sessions={sessions}
					activeId={pending ? "" : session.id}
					query={query}
					activity={activity}
					onQuery={setQuery}
					onSelect={selectSession}
					onNew={() => createSession()}
					onNewIn={(seed) => createSession(seed)}
					onPin={(id) => setSessions((current) => current.map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item)))}
					onArchive={(id) => {
						const target = sessions.find((item) => item.id === id);
						if (target && !target.archived && target.worktreeFolder && window.grokCode?.removeWorktree) {
							setHeld((current) => ({ ...current, [id]: true }));
							void window.grokCode.removeWorktree(target.folder, target.worktreeFolder, { force: false }).then((result) => {
								if (result.ok) { updateSession(id, { archived: true, pinned: false }); return; }
								if (result.dirty && window.confirm(result.ignored?.length ? `This worktree has files git ignores that removal would delete: ${result.ignored.join(", ")}. Archive anyway? The worktree stays on disk.` : "This session's worktree has uncommitted changes. Archive anyway? The worktree stays on disk.")) { updateSession(id, { archived: true, pinned: false }); return; }
								if (result.dirty === false) { updateSession(id, { archived: true, pinned: false }); setNotice(`Archived, but the worktree folder could not be removed: ${result.error || "unknown error"}. Close any terminal open in it and delete the folder.`); return; }
								if (!result.dirty) { updateSession(id, { archived: true, pinned: false }); setNotice(`Archived. The worktree could not be checked, so it stays on disk: ${result.error || "unknown error"}`); }
							});
							return;
						}
						if (target?.archived && target.worktreeFolder) {
							if (!window.grokCode?.restoreWorktree) { setNotice("Reopen this window to restore the worktree."); return; }
							void window.grokCode.restoreWorktree(target.worktreeFolder, target.branch).then((result) => {
								if (result.ok) { updateSession(id, { archived: false, pinned: false, lastActivityAt: Date.now() }); } else { setNotice(result.error || "The worktree could not be restored."); }
							}).catch(() => setNotice("The worktree could not be restored."));
							return;
						}
						if (target && !target.archived) { setHeld((current) => ({ ...current, [id]: true })); void window.grokCode?.stopSession?.(id); }
						// Unarchive counts as activity, so automatic archiving does not archive it again at the next launch.
						setSessions((current) => current.map((item) => (item.id === id ? { ...item, archived: !item.archived, pinned: false, ...(item.archived ? { lastActivityAt: Date.now() } : {}) } : item)));
					}}
					onRename={(id, title) => updateSession(id, { title })}
					onDelete={(id) => {
						void window.grokCode?.stopSession?.(id);
						setDeleted((current) => [...current, id]);
						// The window always has an unarchived session, so deleting the last one leaves a new one in the same folder.
						setSessions((current) => {
							const rest = current.filter((item) => item.id !== id);
							const gone = current.find((item) => item.id === id);
							return rest.some((item) => !item.archived) ? rest : [newSession(gone ? { folder: gone.folder, project: gone.project } : undefined), ...rest];
						});
						setExtraChats((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
						// A queue that Stop held would stay unsent forever and make every close warn about it.
						setQueued((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
					}}
					onMarkUnread={(id, unread) => updateSession(id, { unread })}
					onMarkCompleted={(id, completed) => updateSession(id, { completed })}
					onMove={(id, sectionId) => updateSession(id, { sectionId })}
					onOpenWindow={openSessionWindow}
					onSettings={() => setSettingsOpen("general")}
					onCollapse={() => changeSettings({ sidebarCollapsed: true })}
					onNotice={setNotice}
					account={account}
					recentUsd={recentUsd}
					onShortcuts={() => setShortcuts(true)}
					onOpenUrl={(url) => openUrl(url, true)}
					onSignOut={signOut}
				/>
			)}
			<main className="workspace">
				<header className="topbar">
					{settings.sidebarCollapsed && <button className="icon-btn" aria-label="Show sidebar" title="Show sidebar" onClick={() => changeSettings({ sidebarCollapsed: false })}>☰</button>}
					<div className="session-title">
						{renaming === session.id ? (
							<input
								className="title-input"
								aria-label="Session title"
								autoFocus
								defaultValue={session.title}
								onBlur={(event) => { const title = event.target.value.trim(); if (title && !pending) { updateSession(session.id, { title }); } setRenaming(null); }}
								onKeyDown={(event) => {
									if (event.key === "Enter") { (event.target as HTMLInputElement).blur(); }
									if (event.key === "Escape") { event.stopPropagation(); setRenaming(null); }
								}}
							/>
						) : (
							<button type="button" className="title-btn" title="Rename" onClick={() => { if (!pending) { setRenaming(session.id); } }}>{pending ? "New session" : session.title}</button>
						)}
						<button type="button" className="icon-btn caret" aria-label="Session menu" aria-expanded={menu === "session"} onClick={() => setMenu(menu === "session" ? null : "session")}>⌄</button>
						<span className="meta">{session.project} · {session.branch}{isBusy ? " · working" : ""}</span>
					</div>
					<span className="spacer" />
					<div className="pane-switch" role="toolbar" aria-label="Panes">
						{PANES.map((pane) => (
							<button key={pane.id} type="button" className={panes.includes(pane.id) ? "pane-tab on" : "pane-tab"} aria-pressed={panes.includes(pane.id)} aria-label={pane.label} title={pane.label} onClick={() => togglePane(pane.id)}>
								<PaneIcon id={pane.id} />
							</button>
						))}
						<button type="button" className="pane-tab" aria-label="More" title="More" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>⋮</button>
					</div>
					{menu === "session" && (
						<div className="pop down session-menu">
							<div className="menu-label">Transcript view</div>
							{VIEWS.map((item) => (
								<button key={item} type="button" className={view === item ? "item on" : "item"} onClick={() => { setViews((current) => ({ ...current, [session.id]: item })); setMenu(null); }}>{VIEW_LABEL[item]}{view === item && <span className="check">✓</span>}</button>
							))}
							<div className="menu-label">Open in</div>
							<button type="button" className="item" disabled={!!pending} onClick={() => { openSessionWindow(session.id); setMenu(null); }}>New window</button>
							<button type="button" className="item" onClick={() => openIn("explorer")}>File Explorer</button>
							<button type="button" className="item" onClick={() => openIn("vscode")}>VS Code</button>
							<hr />
							<button type="button" className="item" disabled={railOpen && !railShown} onClick={() => { changeSettings({ railOpen: !railOpen }); setMenu(null); }}>{railOpen && !railShown ? "Session rail (window too narrow)" : railShown ? "Hide session rail" : "Show session rail"}</button>
							<button type="button" className="item" disabled={!!pending} onClick={() => { setRenaming(session.id); setMenu(null); }}>Rename</button>
						</div>
					)}
					{menu === "more" && (
						<div className="pop down more-menu">
							{MENU_PANES.map((pane) => (
								<button key={pane.id} type="button" className={panes.includes(pane.id) ? "item on" : "item"} onClick={() => togglePane(pane.id)}>
									{pane.label}
									<small>{pane.id === "plan" ? (planText || todos.length ? "Grok's current plan" : "No plan yet") : `${backgroundTasks.filter((task) => task.running).length} running`}</small>
								</button>
							))}
							<hr />
							<button type="button" className="item" disabled={railOpen && !railShown} onClick={() => { changeSettings({ railOpen: !railOpen }); setMenu(null); }}>{railOpen && !railShown ? "Session rail (window too narrow)" : railShown ? "Hide session rail" : "Show session rail"}</button>
							<button type="button" className="item" onClick={() => { setShortcuts(true); setMenu(null); }}>Keyboard shortcuts<small>Ctrl+/</small></button>
							<button type="button" className="item" onClick={() => { setSettingsOpen("general"); setMenu(null); }}>Settings</button>
						</div>
					)}
				</header>
				<div className="stage">
					<div className="stage-main">
						{pending && (
							<div className="new-page">
								<h1>New session</h1>
								<div className="new-row">
									<label className="field">
										<span>Environment</span>
										<select aria-label="Environment" value="Local" onChange={() => {}}>
											<option value="Local">Local · this computer</option>
											<option value="SSH" disabled>SSH · not available</option>
											<option value="Cloud" disabled>Cloud · not available</option>
										</select>
									</label>
									<label className="field">
										<span>Folder</span>
										<select
											aria-label="Folder"
											value={folderKey(pending.folder)}
											onChange={(event) => {
												if (event.target.value === "__pick") {
													void window.grokCode?.pickFolder().then((picked) => { if (picked) { setPending((item) => (item ? { ...item, folder: picked, project: shortPath(picked), worktree: shortPath(picked) } : item)); } });
													return;
												}
												const folder = recentFolders.find((item) => folderKey(item) === event.target.value);
												if (folder) { setPending((item) => (item ? { ...item, folder, project: shortPath(folder), worktree: shortPath(folder) } : item)); }
											}}
										>
											{[...new Map([[folderKey(pending.folder), pending.folder], ...recentFolders.map((item) => [folderKey(item), item] as [string, string])]).entries()].map(([value, folder]) => <option key={value} value={value}>{folder}</option>)}
											<option value="__pick">Choose a folder…</option>
										</select>
									</label>
									<label className="toggle field-toggle" title="Work on a new branch in its own git worktree">
										<input type="checkbox" checked={useWorktree} onChange={(event) => setUseWorktree(event.target.checked)} /> Worktree
									</label>
								</div>
							</div>
						)}
						<div className="chat-row">
							<PaneView id="chat" model={modelForPanes} />
						</div>
						<div className="dock" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
							{sideOpen && (
								<div className="side-q" role="dialog" aria-label="Side chat">
									<div className="side-q-hd"><b>Side chat</b><span className="meta">Reads this session; nothing goes back into it. It is not added to this chat's history; Grok keeps its own copy in ~/.grok/sessions.</span><span className="spacer" /><button type="button" className="pane-x" aria-label="Close side chat" onClick={() => setSideOpen(false)}>×</button></div>
									<SideLog messages={sideChats[session.id] ?? []} model={sideModel} />
									<textarea
										aria-label="Side question"
										rows={2}
										value={sideText}
										placeholder="Ask a side question"
										onChange={(event) => setSideText(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && !event.shiftKey) {
												event.preventDefault();
												if (send(sideText, true)) { setSideText(""); }
											}
										}}
									/>
								</div>
							)}
							<div className="composer">
								{queue.length > 0 && (
									<div className="queue">
										{queue.map((item) => (
											<div className="queued" key={item.id}>
												<span>{item.text}</span>
												<button className="texty" onClick={() => sendNow(session.id, item.id)}>Send now</button>
												<button className="texty" aria-label="Remove queued message" onClick={() => setQueued((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((entry) => entry.id !== item.id) }))}>×</button>
											</div>
										))}
									</div>
								)}
								{files.length > 0 && (
									<div className="attach-list">
										{files.map((file) => (
											<span className="attach-chip" key={file} title={file}>
												{imageSrc(file) ? <button type="button" className="thumb" aria-label={`View ${file.split(/[\\/]/).pop()}`} onClick={() => openImage(file)}><img src={imageSrc(file)} alt={file.split(/[\\/]/).pop()} /></button> : file.split(/[\\/]/).pop()}
												<button type="button" aria-label={`Remove ${file.split(/[\\/]/).pop()}`} onClick={() => setAttachments((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((item) => item !== file) }))}>×</button>
											</span>
										))}
									</div>
								)}
								{popup && (
									<div className="mention pop-list" role="listbox" ref={popupList} aria-label={popup.kind === "slash" ? "Commands" : "Files"}>
										{popup.kind === "mention" && folderFiles?.status === "loading" && <div className="item">Reading this folder…</div>}
										{popup.kind === "mention" && folderFiles?.status === "error" && <div className="item">{folderFiles.error}</div>}
										{popup.items.map((item, index) => (
											<button key={item.value} type="button" role="option" aria-selected={index === popIndex} className={index === popIndex ? "item on" : "item"} onMouseEnter={() => setPopIndex(index)} onClick={() => pickPopup(index)}>
												{item.label}
												{item.detail && <small>{item.detail}</small>}
											</button>
										))}
										{popup.items.length === 0 && <div className="item">{popup.kind === "slash" ? "No commands match." : folderFiles?.status === "ready" ? "No files match." : ""}</div>}
									</div>
								)}
								<textarea
									ref={promptRef}
									aria-label="Prompt"
									rows={2}
									placeholder={isBusy ? "Queue a message for when Grok finishes" : pending ? "Describe a task to start a new session" : "Reply to Grok, or type / for commands and @ to mention files"}
									value={prompt}
									onChange={(event) => setPrompt(event.target.value)}
									onPaste={onPaste}
									onKeyDown={(event) => {
										if (popup && popup.items.length) {
											if (event.key === "ArrowDown") { event.preventDefault(); setPopIndex((index) => (index + 1) % popup.items.length); return; }
											if (event.key === "ArrowUp") { event.preventDefault(); setPopIndex((index) => (index - 1 + popup.items.length) % popup.items.length); return; }
											if (event.key === "Enter" && !event.shiftKey && popup.kind === "slash" && !popup.items[popIndex]?.hint) { event.preventDefault(); void submit(popup.items[popIndex].value); return; }
											if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { event.preventDefault(); pickPopup(popIndex); return; }
										}
										if (popup && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPopClosed(prompt); return; }
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											void submit();
										}
									}}
								/>
								<div className="composer-row">
									<MenuButton label="+" title="Add files, folders and commands" open={menu === "plus"} onClick={() => setMenu(menu === "plus" ? null : "plus")} />
									<MenuButton label={session.environment} title="Environment" open={menu === "env"} onClick={() => setMenu(menu === "env" ? null : "env")} />
									<MenuButton label={shortPath(session.folder)} title={session.folder} open={menu === "folder"} onClick={() => setMenu(menu === "folder" ? null : "folder")} />
									<MenuButton label={mode} title="Permission mode (Ctrl+Shift+M)" open={menu === "mode"} onClick={() => setMenu(menu === "mode" ? null : "mode")} />
									<span className="spacer" />
									{contextPercent !== null && <span className="usage-ring" title={`Context about ${contextPercent}% used · session cost $${(session.costUsd ?? 0).toFixed(2)}${recentUsd !== null ? `\nGrok, last 7 days on this computer: $${recentUsd.toFixed(2)}` : ""}`} style={{ ["--pct" as string]: `${contextPercent}` }} aria-label={`Context ${contextPercent}% used`} />}
									<MenuButton label={`${baseModel}${fastOn ? " · fast" : ""} · ${effort}`} title="Model (Ctrl+Shift+I) and effort (Ctrl+Shift+E)" open={menu === "model" || menu === "effort"} onClick={() => setMenu(menu === "model" ? null : "model")} />
									<button
										type="button"
										className={sendLabel === "Stop" ? "send-btn stop" : "send-btn"}
										aria-label={sendLabel}
										title={sendLabel === "Stop" ? "Stop (Esc)" : isBusy ? "Queue (Enter)" : "Send (Enter)"}
										disabled={sendLabel === "Send" && !prompt.trim()}
										onClick={() => { if (sendLabel === "Stop") { stop(session.id); } else { void submit(); } }}
									>
										{sendLabel === "Stop" ? "■" : "↑"}
									</button>
								</div>
								{menu === "plus" && (
									<div className="pop up">
										<button
											type="button"
											className="item"
											onClick={() => {
												const api = window.grokCode;
												if (!api?.pickFiles) {
													setNotice("Reopen this window to add files.");
													return;
												}
												void api.pickFiles().then((paths) => {
													addAttachments(paths);
													setMenu(null);
												});
											}}
										>
											Add files or photos
										</button>
										<button type="button" className="item" disabled={addingFolder} onClick={() => void addFolder()}>{addingFolder ? "Adding folder…" : "Add folder"}<small>Grok can also work in this folder.</small></button>
										<button type="button" className="item" onClick={() => { setPrompt("/"); setPopClosed(""); setMenu(null); promptRef.current?.focus?.(); }}>Slash commands</button>
										<button type="button" className="item" onClick={() => { setSettingsOpen("skills"); setMenu(null); }}>Connectors and skills<small>{servers.length ? `${servers.length} MCP servers from Grok` : "Managed in Grok's configuration"}</small></button>
										{!!session.allowedFolders?.length && <div className="menu-label">Added folders</div>}
										{session.allowedFolders?.map((folder) => <div className="item" key={folder}>{folder}</div>)}
									</div>
								)}
								{menu === "env" && (
									<div className="pop up">
										{(["Local", "SSH", "Cloud"] as Environment[]).map((environment) => (
											<button key={environment} type="button" className={session.environment === environment ? "item on" : "item"} disabled={environment !== "Local"} onClick={() => setMenu(null)}>
												{environment}
												<small>{environment === "Local" ? "This computer" : "Not available yet"}</small>
											</button>
										))}
									</div>
								)}
								{menu === "folder" && (
									<div className="pop up">
										<div className="item">{session.folder}</div>
										<button type="button" className="item" onClick={() => openIn("explorer")}>Open in File Explorer</button>
										<button
											type="button"
											className="item"
											disabled={!!busy[session.id]}
											onClick={() => {
												const api = window.grokCode;
												if (!api) {
													setNotice("Choose the folder from the desktop window.");
													return;
												}
												const sessionId = session.id;
												void api.pickFolder().then((picked) => {
													if (!picked) { return; }
													const name = shortPath(picked);
													const update = (item: Session) => (item.id === sessionId ? { ...item, folder: picked, project: name, worktree: name, agentSessionId: undefined, allowedFolders: undefined } : item);
													setSessions((current) => current.map(update));
													setPending((item) => (item ? update(item) : item));
													// The side chat's Grok conversation keeps the old folder's approvals, so it starts over with the main chat.
													setSideAgents((list) => Object.fromEntries(Object.entries(list).filter(([id]) => id !== sessionId)));
													delete sideSeen.current[sessionId];
													// Without this, a return to the old folder would reload the old conversation and its Always allow rules.
													void api.forgetSession?.(sessionId);
													setMenu(null);
												});
											}}
										>
											Choose a folder
											<small>The next message starts a new Grok conversation in that folder.</small>
										</button>
									</div>
								)}
								{menu === "mode" && (
									<div className="pop up">
										{isBusy && <div className="menu-label">Stop or finish this turn before changing mode.</div>}
										{MODES.map((item) => (
											<button
												key={item.id}
												type="button"
												className={mode === item.id ? "mode-row on" : "mode-row"}
												disabled={isBusy}
												onClick={() => {
													if (turnTargets.current[session.id]) { return; }
													changeMode(session.id, item.id);
													if (item.id !== "Plan") { changeSettings({ modeByFolder: { ...settings.modeByFolder, [folderKey(session.folder)]: item.id } }); }
													setMenu(null);
												}}
											>
												{item.id}
												<small>{item.detail}</small>
											</button>
										))}
									</div>
								)}
								{(menu === "model" || menu === "effort") && (
									<div className="pop up right">
										{menu === "model" && (
											<>
												<div className="menu-label">Model</div>
												{modelList.map((item) => (
													<button key={item} type="button" className={baseModel === item ? "item on" : "item"} onClick={() => {
														const next = fastOn && FAST_MODEL[item] ? FAST_MODEL[item] : item;
														const allowed = models.find((entry) => entry.id === next)?.efforts;
														const choice = { model: next, effort: allowed?.length && !allowed.includes(effort) ? allowed[allowed.length > 1 ? 1 : 0] : (next === "grok-4.5" && effort === "xhigh" ? "high" : effort) };
														changeSettings(choice);
														if (pending) { setPending((current) => current ? { ...current, ...choice } : current); } else { updateSession(session.id, choice); }
													}}>
														{models.find((entry) => entry.id === item)?.name ?? item}
														<small>{models.find((entry) => entry.id === item)?.description ?? ""}</small>
													</button>
												))}
												{FAST_MODEL[baseModel] && (
													<label className="item toggle">
														<input type="checkbox" checked={fastOn} onChange={(event) => {
															const choice = { model: event.target.checked ? FAST_MODEL[baseModel] : baseModel, effort };
															changeSettings(choice);
															if (pending) { setPending((current) => current ? { ...current, ...choice } : current); } else { updateSession(session.id, choice); }
														}} /> Fast mode
														<small>Grok's faster build of this model</small>
													</label>
												)}
											</>
										)}
										<div className="menu-label">Effort</div>
										{efforts.map((item) => (
											<button key={item} type="button" className={effort === item ? "mode-row on" : "mode-row"} onClick={() => {
												const choice = { model, effort: item };
												changeSettings(choice);
												if (pending) { setPending((current) => current ? { ...current, ...choice } : current); } else { updateSession(session.id, choice); }
												setMenu(null);
											}}>{item}<small>{EFFORT_DETAIL[item] ?? ""}</small></button>
										))}
									</div>
								)}
							</div>
							{notice && <div className="note composer-note" role="status">{notice}<button type="button" className="texty" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}
						</div>
					</div>
					{railShown && (
						<SessionRail
							key={session.id}
							session={session}
							diff={diffs[session.id]}
							branch={branch}
							pr={prInfo}
							usage={usage}
							breakdown={breakdown && breakdown.id === agentId ? breakdown : undefined}
							recentUsd={recentUsd}
							onOpenDiff={(file) => { if (file) { setDiffFile(file); } showPane("diff"); }}
							onCompact={() => { send("/compact", false); }}
							onOpenUrl={(url) => openUrl(url, true)}
							onCreatePr={createPr}
							onMergeWhenReady={mergeWhenReady}
						/>
					)}
					{panes.length > 0 && (
						<>
							<div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panes" onMouseDown={startResize} />
							<div className="side-col" style={{ width: settings.sideWidth }}>
								{panes.map((id) => sidePane(id))}
							</div>
						</>
					)}
				</div>
			</main>
			{fileMenu && (
				<div className="file-menu" style={{ top: Math.min(fileMenu.y, window.innerHeight - 260), left: Math.min(fileMenu.x, window.innerWidth - 220) }} role="menu">
					<button type="button" role="menuitem" onClick={() => openFile(fileMenu.file)}>Open</button>
					<button type="button" role="menuitem" onClick={() => { setPrompt((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${fileMenu.file} `); setFileMenu(null); promptRef.current?.focus?.(); }}>Attach as context</button>
					<button type="button" role="menuitem" onClick={() => openIn("vscode", fileMenu.file)}>Open in VS Code</button>
					<button type="button" role="menuitem" onClick={() => { void window.grokCode?.reveal(session.folder, fileMenu.file).then((result) => { if (!result.ok) { setNotice(result.error || "That file is not in this folder."); } }); setFileMenu(null); }}>Show in File Explorer</button>
					<div className="menu-label">Copy</div>
					<button type="button" role="menuitem" onClick={() => { copyText(`${session.folder.replace(/[\\/]+$/, "")}\\${fileMenu.file.replace(/\//g, "\\")}`, "Copied the absolute path."); setFileMenu(null); }}>Absolute path</button>
					<button type="button" role="menuitem" onClick={() => { copyText(fileMenu.file, "Copied the relative path."); setFileMenu(null); }}>Relative path</button>
					<button type="button" role="menuitem" onClick={() => { copyText(fileMenu.file.split(/[\\/]/).pop() ?? fileMenu.file, "Copied the filename."); setFileMenu(null); }}>Filename</button>
				</div>
			)}
			{shortcuts && (
				<div className="overlay" onClick={() => setShortcuts(false)}>
					<div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
						<h2>Keyboard shortcuts</h2>
						<ul>
							{SHORTCUTS.map(([key, label]) => (
								<li key={`${key}-${label}`}><span>{label}</span><kbd>{key}</kbd></li>
							))}
						</ul>
						<button className="texty" onClick={() => setShortcuts(false)}>Close</button>
					</div>
				</div>
			)}
			{settingsOpen && <SettingsPage settings={settings} onChange={changeSettings} onClose={() => setSettingsOpen(null)} servers={servers} folder={session.folder} onRun={(text) => void runFromSettings(text)} initialTab={settingsOpen} />}
		</div>
	);
}

function PaneIcon({ id }: { id: SidePaneId }) {
	const paths: Record<string, string> = {
		terminal: "M3 4.5h10v7H3zM5 7l1.5 1.2L5 9.4M8 9.5h2.5",
		diff: "M5 3v6M2 6h6M8 12.5h6M11 3.5v0",
		browser: "M2.5 4h11v8h-11zM2.5 6h11",
		editor: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
	};
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d={paths[id] ?? ""} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function MenuButton({ label, title, open, onClick }: { label: string; title?: string; open: boolean; onClick: () => void }) {
	return (
		<button type="button" className={open ? "chip hot" : "chip"} title={title} onClick={onClick} aria-expanded={open}>
			{label}
		</button>
	);
}

export const __defaults = DEFAULT_SETTINGS;
