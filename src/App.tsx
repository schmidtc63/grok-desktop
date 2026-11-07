import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent, type SetStateAction } from "react";
import { caseKey, FILE_MANAGER, keyLabel, modKey, PLATFORM, SHORTCUTS } from "./data";
import { addContextPick, CONTEXT_PICK_LIMIT, contextChoices, contextForGrok, contextPicksFrom, contextSnapshot, type ContextPick } from "./context-from-chat";
import { BrowserPane, type BrowserTab, type DevServer } from "./BrowserPane";
import { addProblem } from "./browserDiagnostics";
import { askConfirm, setConfirmHost, type PendingConfirm } from "./confirm";
import { DiffPane, type DiffComment, type PrInfo } from "./DiffPane";
import { FilesPane } from "./FilesPane";
import { PaneView, SideLog, type BackgroundTask, type EditorDraft, type FolderFiles, type OpenFile, type PaneModel } from "./Panes";
import { prAlertText, prFixPrompt, prWatchStep } from "./prWatch";
import { SessionRail } from "./SessionRail";
import { Setup } from "./Setup";
import { DEFAULT_SETTINGS, readSettings, settingsKey, SettingsPage, type AppSettings, type SettingsTab } from "./Settings";
import { Sidebar } from "./Sidebar";
import { SavedPromptPicker } from "./SavedPromptPicker";
import { insertSavedPrompt, MAX_PROMPT_TEXT, MAX_SAVED_PROMPTS, promptNameError } from "./saved-prompts";
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
type ConfirmItem = PendingConfirm & { id: number };
type Notice = { id: number; text: string };
type BackgroundWork = Record<string, { tasks: GrokBgTask[]; agents: GrokSubagent[] }>;

const historyKey = "grok-code.history.v1";
const PR_POLL_MS = 180000;
const commandsKey = "grok-code.commands.v1";
const accountKey = "grok-code.account.v1";
const SIDE_BUSY = "The side chat is still answering. Wait for it to finish.";
const VIEWS: TranscriptView[] = ["normal", "thinking", "verbose"];
const VIEW_LABEL: Record<TranscriptView, string> = { normal: "Normal", thinking: "Thinking", verbose: "Verbose" };
const PROTECTED = [/^\.mcp\.json$/i, /^\.claude\/settings(\.local)?\.json$/i, /^\.grok\/config\.toml$/i];
const TAKES_ARG = new Set(["rename", "theme"]);
const BUILT_INS: GrokCommand[] = [
	{ name: "btw", description: "Ask a side question that does not join this conversation", hint: "question" },
	{ name: "config", description: "Open Settings", hint: "" },
	{ name: "status", description: "Show the app's version, model, mode and folder", hint: "" },
	{ name: "usage", description: "Show Grok's usage limit and this session's context", hint: "" },
	{ name: "new", description: "Start a new session", hint: "" },
	{ name: "rename", description: "Rename this session", hint: "title" },
	{ name: "delete", description: "Delete this session", hint: "" },
	{ name: "fork", description: "Fork from the latest sent message", hint: "" },
	{ name: "rewind", description: "Rewind to before the latest sent message", hint: "" },
	{ name: "copy", description: "Copy the latest finished reply", hint: "" },
	{ name: "find", description: "Find in this conversation", hint: "" },
	{ name: "transcript", description: "Cycle the transcript view", hint: "" },
	{ name: "tasks", description: "Toggle Background tasks", hint: "" },
	{ name: "plan", description: "Switch to Plan mode", hint: "" },
	{ name: "view-plan", description: "Toggle the Plan pane", hint: "" },
	{ name: "auto", description: "Switch to Auto-review mode", hint: "" },
	{ name: "model", description: "Choose a model", hint: "" },
	{ name: "effort", description: "Choose the reasoning effort", hint: "" },
	{ name: "cd", description: "Choose a folder", hint: "" },
	{ name: "resume", description: "Pick a session in the sidebar", hint: "" },
	{ name: "help", description: "Show keyboard shortcuts", hint: "" },
	{ name: "theme", description: "Change the app's appearance", hint: "system, light or dark" },
	{ name: "mcps", description: "Open Settings on Connectors", hint: "" },
	{ name: "skills", description: "Open Settings on Skills", hint: "" },
	{ name: "marketplace", description: "Open Settings on Plugins", hint: "" },
	{ name: "doctor", description: "Check Grok setup", hint: "" },
	{ name: "login", description: "Open the sign-in setup check", hint: "" },
	{ name: "logout", description: "Sign out of Grok", hint: "" },
];

interface History {
	sessions: Session[];
	extraChats: Record<string, ChatMessage[]>;
	modes: Record<string, PermissionMode>;
	prePlan: Record<string, PermissionMode>;
	editorDrafts: Record<string, EditorDraft | undefined>;
	composerDrafts?: Record<string, string>;
	queued?: Record<string, Queued[]>;
	attachments?: Record<string, string[]>;
	backgroundWork?: BackgroundWork;
	newSessionDraft?: { session: Session; useWorktree: boolean; text: string };
	deleted: string[];
}

interface Queued {
	id: string;
	text: string;
	attachments: string[];
	contextFrom?: ContextPick[];
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
		const queued: Record<string, Queued[]> = {};
		for (const [id, items] of Object.entries(value.queued ?? {})) {
			if (!Array.isArray(items)) { continue; }
			const valid = items.filter((item: Queued) => item && typeof item.id === "string" && typeof item.text === "string" && item.text.trim() && Array.isArray(item.attachments) && item.attachments.every((file) => typeof file === "string"));
			if (valid.length) { queued[id] = valid; }
		}
		const attachments = Object.fromEntries(Object.entries(value.attachments ?? {}).filter(([, files]) => Array.isArray(files) && files.length && files.every((file) => typeof file === "string"))) as Record<string, string[]>;
		const backgroundWork: BackgroundWork = {};
		for (const [id, entry] of Object.entries(value.backgroundWork ?? {})) {
			const work = entry as BackgroundWork[string] | null;
			if (!work || !Array.isArray(work.tasks) || !Array.isArray(work.agents)) { continue; }
			const valid = (item: GrokBgTask | GrokSubagent) => item && typeof item.id === "string" && typeof item.status === "string" && item.status !== "running";
			backgroundWork[id] = { tasks: recentTasks(work.tasks.filter(valid)), agents: recentAgents(work.agents.filter(valid)) };
		}
		return { sessions: value.sessions, extraChats: value.extraChats ?? {}, modes, prePlan, editorDrafts: value.editorDrafts ?? {}, composerDrafts: value.composerDrafts ?? {}, queued, attachments, backgroundWork, newSessionDraft, deleted: Array.isArray(value.deleted) ? value.deleted : [] };
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

function sameRecords(previous: Record<string, unknown> | undefined, current: Record<string, unknown>) {
	return previous === current || Object.keys({ ...previous, ...current }).every((id) => previous?.[id] === current[id]);
}

function recentTasks(tasks: GrokBgTask[]) {
	return [...tasks.filter((task) => task.status === "running"), ...tasks.filter((task) => task.status !== "running").sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 20)];
}

function recentAgents(agents: GrokSubagent[]) {
	return [...agents.filter((agent) => agent.status === "running"), ...agents.filter((agent) => agent.status !== "running").sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 20)];
}

function mergeChats(saved: Record<string, ChatMessage[]>, current: Record<string, ChatMessage[]>, previous: Record<string, ChatMessage[]>) {
	const merged = { ...saved };
	for (const [id, messages] of Object.entries(current)) {
		if (messages === previous[id]) { continue; }
		const old = new Map((previous[id] ?? []).map((message) => [message.id, message]));
		const kept = new Set(messages.map((message) => message.id));
		const removed = new Set([...old.keys()].filter((key) => !kept.has(key)));
		const changed = new Map(messages.filter((message) => old.get(message.id) !== message).map((message) => [message.id, message]));
		const savedMessages = saved[id] ?? [];
		const savedIds = new Set(savedMessages.map((message) => message.id));
		merged[id] = [...savedMessages.filter((message) => !removed.has(message.id)).map((message) => changed.get(message.id) ?? message), ...messages.filter((message) => changed.has(message.id) && !savedIds.has(message.id))];
	}
	return merged;
}

function slimChats(store: Record<string, ChatMessage[]>) {
	const cut = (value: string | undefined, size: number) => (value && value.length > size ? `${value.slice(0, size)}…` : value);
	return Object.fromEntries(Object.entries(store).map(([id, messages]) => [id, messages.map((message) => {
		const slim = message.thought && message.thought.length > 20000 ? { ...message, thought: cut(message.thought, 20000) } : message;
		return slim.tools ? { ...slim, tools: slim.tools.map((tool) => ({ ...tool, output: undefined, input: undefined, command: cut(tool.command, 2000), plan: cut(tool.plan, 20000), diff: tool.diff && tool.diff.oldText.length + tool.diff.newText.length <= 8000 ? tool.diff : undefined })) } : slim;
	})]));
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

// The same grouping as permissionOf in electron/agent.cjs: a change between groups restarts Grok.
function permissionGroup(mode: PermissionMode) {
	return mode === "Always-approve" ? "yolo" : mode === "Auto-review" ? "auto" : "ask";
}

export function sideCap(windowWidth: number, sidebarCollapsed: boolean): number {
	return Math.max(320, windowWidth - (sidebarCollapsed ? 0 : 268) - 6 - (windowWidth < 1100 ? 320 : 400));
}

export function shouldCollapseSidebar(windowWidth: number, panesOpen: boolean): boolean {
	return windowWidth < 1100 && panesOpen;
}

function folderKey(folder: string) {
	return caseKey(folder.trim().replace(/\\/g, "/").replace(/\/+$/, ""));
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

type GrokLimit = { percent: number | null; period: string; resetsAt: string; tier: string };

// Grok's usage limit as one line, for /usage and the composer meter.
function limitLine(limit: GrokLimit) {
	return [
		[limit.tier, limit.period, "limit", limit.percent !== null ? `${limit.percent}% used` : ""].filter(Boolean).join(" "),
		limit.resetsAt ? `resets ${new Date(limit.resetsAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "",
	].filter(Boolean).join(" · ");
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
	// A window opened for one session shows that session and leaves the form to the others.
	const [restoredForm] = useState<Session | null>(() => (history?.newSessionDraft && !new URLSearchParams(window.location?.search ?? "").get("session") ? { ...history.newSessionDraft.session, id: `new-${crypto.randomUUID()}` } : null));
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
	const [attachments, setAttachmentsState] = useState<Record<string, string[]>>(() => Object.fromEntries(Object.entries(history?.attachments ?? {}).filter(([id]) => sessions.some((item) => item.id === id))));
	const [contextPicks, setContextPicks] = useState<Record<string, ContextPick[]>>({});
	const [queued, setQueuedState] = useState<Record<string, Queued[]>>(() => Object.fromEntries(Object.entries(history?.queued ?? {}).filter(([id]) => sessions.some((item) => item.id === id))));
	const [held, setHeld] = useState<Record<string, boolean>>(() => Object.fromEntries(Object.keys(queued).map((id) => [id, true])));
	const [grokTasks, setGrokTasks] = useState<Record<string, GrokBgTask[]>>(() => Object.fromEntries(Object.entries(history?.backgroundWork ?? {}).filter(([id]) => sessions.some((item) => item.id === (id.startsWith("side-") ? id.slice(5) : id))).map(([id, work]) => [id, work.tasks])));
	const [loops, setLoops] = useState<Record<string, GrokLoop[]>>({});
	const [subagents, setSubagents] = useState<Record<string, GrokSubagent[]>>(() => Object.fromEntries(Object.entries(history?.backgroundWork ?? {}).filter(([id]) => sessions.some((item) => item.id === (id.startsWith("side-") ? id.slice(5) : id))).map(([id, work]) => [id, work.agents])));
	const backgroundWorkRef = useRef<BackgroundWork>(history?.backgroundWork ?? {});
	const backgroundWork = useMemo(() => Object.fromEntries([...new Set([...Object.keys(grokTasks), ...Object.keys(subagents)])].map((id) => {
		const previous = backgroundWorkRef.current[id];
		const tasks = grokTasks[id] ?? [];
		const agents = subagents[id] ?? [];
		const sameTasks = previous && (previous.tasks === tasks || (!previous.tasks.length && !tasks.length));
		const sameAgents = previous && (previous.agents === agents || (!previous.agents.length && !agents.length));
		return [id, sameTasks && sameAgents ? previous : { tasks, agents }];
	})), [grokTasks, subagents]);
	backgroundWorkRef.current = backgroundWork;
	const [suggestions, setSuggestions] = useState<Record<string, string>>({});
	const suggestionGeneration = useRef<Record<string, number>>({});
	const [popIndex, setPopIndex] = useState(0);
	const popupList = useRef<HTMLDivElement>(null);
	const [popClosed, setPopClosed] = useState("");
	const [sideOpen, setSideOpen] = useState(false);
	const [promptLibrary, setPromptLibrary] = useState<{ mode: "save" | "insert"; sessionId: string; text: string; start: number; end: number } | null>(null);
	const [sideText, setSideText] = useState("");
	const [sideChats, setSideChats] = useState<Record<string, ChatMessage[]>>({});
	const [sideAgents, setSideAgents] = useState<Record<string, string>>({});
	const sideSeen = useRef<Record<string, string>>({});
	const [notices, setNotices] = useState<Notice[]>([]);
	const noticeId = useRef(0);
	const setNotice = useCallback((text: string, fade = false) => {
		if (!text) { return; }
		const id = ++noticeId.current;
		if (fade) {
			setTimeout(() => setNotices((list) => list.some((item) => item.id === id) ? list.filter((item) => item.id !== id) : list), 4000);
		}
		setNotices((list) => [...list.filter((item) => item.text !== text), { id, text }].slice(-3));
	}, []);
	const [update, setUpdate] = useState<{ current: string; latest: string; tag: string } | null>(null);
	const openUpdate = useCallback(async (info: { current: string; latest: string; tag: string } | null) => {
		const api = window.grokCode;
		if (!info || !api?.updatePrepare) { return; }
		try {
			const prepared = await api.updatePrepare(info.tag);
			if (prepared.ok && prepared.ready) {
				const yes = await askConfirm({ title: `Update to version ${info.latest}?`, body: [prepared.notes?.slice(0, 1500), "The app closes, updates and opens again by itself. This takes a minute or two, longer if Electron itself changed. Running Grok replies and terminals stop."].filter(Boolean).join("\n\n"), ok: "Update and restart" });
				if (yes && api.updateStart) {
					const result = await api.updateStart(info.tag);
					if (!result.ok) { setNotice(result.error || "The update could not start."); }
				}
			} else {
				// An installed copy updates by running its install command again; a source copy updates with git.
				const where = prepared.steps?.includes("install-windows.ps1") ? "PowerShell" : "Terminal";
				const how = prepared.steps ? `Quit the app, then run this in ${where}:\n${prepared.steps}` : "Quit the app, then in its folder run: git pull, npm install, npm run desktop";
				const yes = await askConfirm({ title: `Version ${info.latest} is available`, body: `${prepared.reason || "This copy couldn't be prepared for an update."}\n\n${how}`, ok: "Copy steps" });
				if (yes) {
					const result = await api.copyText(prepared.steps || "git pull\nnpm install\nnpm run desktop");
					setNotice(result.ok ? "Update steps copied." : result.error || "The steps could not be copied.", result.ok);
				}
			}
		} catch {
			setNotice("The update could not be prepared. Try again.");
		}
	}, [setNotice]);
	const [shortcuts, setShortcuts] = useState(false);
	const [rewindAsk, setRewindAsk] = useState<{ sessionId: string; message: ChatMessage; files: string[]; conflicts: string[] } | null>(null);
	const [branching, setBranching] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null);
	const [setup, setSetup] = useState<{ result?: GrokReadiness; open: boolean; checking: boolean; installing: "" | "grok" | "git" | "update" }>({ open: false, checking: false, installing: "" });
	const setupCheck = useRef(0);
	const [confirms, setConfirms] = useState<ConfirmItem[]>([]);
	const confirmQueue = useRef<ConfirmItem[]>([]);
	const confirmIds = useRef(0);
	const confirmReturn = useRef<HTMLElement | null>(null);
	const confirmShown = useRef(false);
	const answerRef = useRef<(yes: boolean) => void>(() => {});
	const [renaming, setRenaming] = useState<string | null>(null);
	const [extraChats, setChatState] = useState<Record<string, ChatMessage[]>>(() => restoredChats(history?.extraChats ?? {}));
	const urgentSave = useRef(false);
	const setExtraChats = useCallback((update: SetStateAction<Record<string, ChatMessage[]>>) => {
		urgentSave.current = true;
		setChatState(update);
	}, []);
	const [deleted, setDeleted] = useState<string[]>(history?.deleted ?? []);
	const [views, setViews] = useState<Record<string, TranscriptView>>({});
	const [findTick, setFindTick] = useState(0);
	const [findAt, setFindAt] = useState({ tick: 0, text: "" });
	const [commands, setCommands] = useState<GrokCommand[]>(readCommands);
	const [models, setModels] = useState<GrokModel[]>([]);
	const [servers, setServers] = useState<GrokMcpServer[]>([]);
	const [diffScope, setDiffScope] = useState<Record<string, string>>({});
	const [commits, setCommits] = useState<Record<string, { sha: string; short: string; subject: string }[]>>({});
	const [branches, setBranches] = useState<Record<string, BranchInfo | undefined>>({});
	const [prs, setPrs] = useState<Record<string, PrStatus | undefined>>({});
	const [comments, setComments] = useState<Record<string, DiffComment[]>>({});
	const [viewed, setViewed] = useState<Record<string, Record<string, string>>>({});
	const [diffFile, setDiffFile] = useState("");
	const [diffTick, setDiffTick] = useState(0);
	const [remoteTick, setRemoteTick] = useState(0);
	const [diffs, setDiffs] = useState<Record<string, DiffSnapshot | undefined>>({});
	const [folderLists, setFolderLists] = useState<Record<string, FolderFiles | undefined>>({});
	const [openFiles, setOpenFiles] = useState<Record<string, OpenFile | undefined>>({});
	const [editorDrafts, setEditorDrafts] = useState<History["editorDrafts"]>(() => Object.fromEntries(Object.entries(history?.editorDrafts ?? {}).map(([key, draft]) => [key, draft && { ...draft, saving: false }])));
	const [editorFile, setEditorFile] = useState("");
	const [editorLine, setEditorLine] = useState<{ line?: number; tick: number }>({ tick: 0 });
	const [fileTick, setFileTick] = useState(0);
	const [terminals, setTerminals] = useState<Record<string, TerminalTab[]>>({});
	const terminalsRef = useRef(terminals);
	terminalsRef.current = terminals;
	const terminalVisible = useRef(false);
	const terminalGeneration = useRef(0);
	const [activeTerminal, setActiveTerminal] = useState<Record<string, string>>({});
	const [terminalError, setTerminalError] = useState("");
	const [browserTabs, setBrowserTabs] = useState<Record<string, BrowserTab[]>>({});
	const [activeBrowser, setActiveBrowser] = useState<Record<string, string>>({});
	const [browserError, setBrowserError] = useState("");
	const [browserActivity, setBrowserActivity] = useState<Record<string, { text: string; running: boolean }>>({});
	const [browserStopped, setBrowserStopped] = useState<Record<string, boolean>>({});
	const browserActivityTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	useEffect(() => () => { for (const timer of Object.values(browserActivityTimers.current)) { clearTimeout(timer); } }, []);
	const [devScripts, setDevScripts] = useState<Record<string, { script: string; command: string }[]>>({});
	const [devTabs, setDevTabs] = useState<Record<string, string>>({});
	useEffect(() => {
		const visible = panes.includes("terminal");
		if (terminalVisible.current && !visible) {
			terminalGeneration.current += 1;
			for (const tab of Object.values(terminalsRef.current).flat()) { void window.grokCode?.terminalClose?.(tab.id); }
			setTerminals({});
			setActiveTerminal({});
			setDevTabs({});
		}
		terminalVisible.current = visible;
	}, [panes]);
	const [selectTick, setSelectTick] = useState(0);
	const [modes, setModes] = useState<Record<string, PermissionMode>>(history?.modes ?? {});
	const [prePlan, setPrePlan] = useState<Record<string, PermissionMode>>(history?.prePlan ?? {});
	const modesRef = useRef(modes);
	const sentModes = useRef<Record<string, PermissionMode>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	// shortcut: the warning is once per session, not once per later collision
	const [collisionSeen, setCollisionSeen] = useState<Record<string, true>>({});
	const [breakdown, setBreakdown] = useState<(ContextBreakdown & { id: string }) | null>(null);
	const [recentUsd, setRecentUsd] = useState<number | null>(null);
	const [limit, setLimit] = useState<GrokLimit | null>(null);
	const [account, setAccount] = useState<GrokAccount | null | undefined>(readAccount);
	const [addingFolder, setAddingFolder] = useState(false);
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth ?? 1400);
	const sideCol = useRef<HTMLDivElement | null>(null);
	const turnTargets = useRef<Record<string, TurnTarget>>({});
	const sessionsRef = useRef(sessions);
	const loopEpoch = useRef<Record<string, number>>({});
	const openingCli = useRef(new Map<string, string>());
	const activeIdRef = useRef(activeId);
	const pendingRef = useRef(pending);
	// The new-session form, kept with its text while another session is on screen; New session brings it back.
	const keptForm = useRef<{ session: Session; useWorktree: boolean } | null>(null);
	const draftsRef = useRef(drafts);
	const useWorktreeRef = useRef(useWorktree);
	const creatingWorktree = useRef(false);
	const autoArchiving = useRef(new Set<string>());
	const settingsRef = useRef(settings);
	const keyActions = useRef<Record<string, () => void>>({});
	const inboundAccept = useRef<(agentSessionId: string, text: string) => InboundResult>(() => ({ accepted: false }));
	const overlayOpen = useRef(false);
	const settingsShown = useRef(false);
	const editorDraftsRef = useRef(editorDrafts);
	const queuedRef = useRef(queued);
	const attachmentsRef = useRef(attachments);
	const promptRef = useRef<HTMLTextAreaElement | null>(null);
	const appVersion = useRef("");
	sessionsRef.current = sessions;
	overlayOpen.current = menu !== null || fileMenu !== null || shortcuts || settingsOpen !== null || rewindAsk !== null || setup.open || promptLibrary !== null;
	settingsShown.current = settingsOpen !== null;
	confirmShown.current = confirms.length > 0;
	pendingRef.current = pending;
	draftsRef.current = drafts;
	useWorktreeRef.current = useWorktree;
	settingsRef.current = settings;
	modesRef.current = modes;
	editorDraftsRef.current = editorDrafts;
	queuedRef.current = queued;
	attachmentsRef.current = attachments;
	const persistedDrafts = useRef(editorDrafts);
	const lastSaved = useRef<History | null>(history ? { sessions, extraChats, modes, prePlan, editorDrafts, composerDrafts: drafts, queued, attachments, backgroundWork, newSessionDraft: restoredForm ? history.newSessionDraft : undefined, deleted } : null);
	const saveHistory = useRef<() => boolean>(() => true);

	function answerConfirm(yes: boolean, id = confirmQueue.current[0]?.id) {
		const first = confirmQueue.current[0];
		if (!first || first.id !== id) { return; }
		const next = confirmQueue.current.slice(1);
		confirmQueue.current = next;
		confirmShown.current = next.length > 0;
		setConfirms(next);
		first.resolve(yes);
	}
	answerRef.current = answerConfirm;

	useEffect(() => setConfirmHost((pending) => {
		if (!confirmQueue.current.length && !confirmReturn.current) { confirmReturn.current = document.activeElement as HTMLElement | null; }
		const next = [...confirmQueue.current, { ...pending, id: ++confirmIds.current }];
		confirmQueue.current = next;
		confirmShown.current = true;
		setConfirms(next);
	}), []);

	useEffect(() => {
		if (confirms.length) { return; }
		const target = confirmReturn.current;
		confirmReturn.current = null;
		if (target && document.contains?.(target)) { target.focus?.(); }
	}, [confirms.length]);

	function setQueued(update: SetStateAction<Record<string, Queued[]>>) {
		queuedRef.current = typeof update === "function" ? update(queuedRef.current) : update;
		setQueuedState(queuedRef.current);
	}

	function setAttachments(update: SetStateAction<Record<string, string[]>>) {
		attachmentsRef.current = typeof update === "function" ? update(attachmentsRef.current) : update;
		setAttachmentsState(attachmentsRef.current);
	}

	function changeSettings(patch: Partial<AppSettings>) {
		settingsRef.current = { ...settingsRef.current, ...patch };
		if (patch.promptSuggestions === false) { clearSuggestions(); }
		setSettings((current) => ({ ...current, ...patch }));
	}

	function invalidateSuggestion(id: string) {
		suggestionGeneration.current[id] = (suggestionGeneration.current[id] ?? 0) + 1;
		setSuggestions((current) => (current[id] ? { ...current, [id]: "" } : current));
	}

	function clearSuggestions() {
		for (const id of Object.keys(suggestionGeneration.current)) { suggestionGeneration.current[id] += 1; }
		setSuggestions({});
	}

	useEffect(() => {
		if (!settings.promptSuggestions) { clearSuggestions(); }
	}, [settings.promptSuggestions]);

	function changeMode(id: string, next: PermissionMode) {
		const previous = knownMode(modesRef.current[id], settingsRef.current);
		if (next === "Plan" && previous !== "Plan") { setPrePlan((current) => ({ ...current, [id]: previous })); }
		modesRef.current = { ...modesRef.current, [id]: next };
		setModes(modesRef.current);
	}

	function restartStops(next: PermissionMode) {
		const sent = sentModes.current[session.id];
		if (!sent || permissionGroup(sent) === permissionGroup(next)) { return 0; }
		return (grokTasks[session.id] ?? []).filter((task) => task.status === "running").length + (subagents[session.id] ?? []).filter((agent) => agent.status === "running").length;
	}

	function checkSetup(open = true) {
		const api = window.grokCode;
		if (!api?.readiness) { return; }
		const check = ++setupCheck.current;
		setSetup((current) => ({ ...current, open: open || current.open, checking: true }));
		void api.readiness({ folder: session.folder, full: open }).then((result) => {
			if (check !== setupCheck.current) { return; }
			// The account menu keeps the version from the last Grok session start, and Grok may have updated itself since.
			const version = result.grok.ok ? result.grok.version : "";
			if (version) { setAccount((current) => (current && current.version !== version ? { ...current, version } : current)); }
			setSetup((current) => ({ ...current, result, open: current.open || !result.grok.ok || !result.grok.signedIn, checking: false }));
		}).catch(() => {
			if (check !== setupCheck.current) { return; }
			setSetup((current) => ({ ...current, checking: false }));
			setNotice("Setup could not be checked. Try again.");
		});
	}

	async function runInstall(kind: "grok" | "git" | "update") {
		const call = kind === "grok" ? window.grokCode?.installGrok : kind === "git" ? window.grokCode?.installGit : window.grokCode?.updateGrokCli;
		if (!call || setup.installing) { return; }
		setSetup((current) => ({ ...current, installing: kind }));
		try {
			const result = await call();
			if (result && !result.ok && result.error) { setNotice(result.error); }
		} catch {
			setNotice(kind === "grok" ? "Installing the Grok CLI failed." : kind === "git" ? "Installing Git failed." : "Updating Grok failed.");
		} finally {
			setSetup((current) => ({ ...current, installing: "" }));
		}
		checkSetup();
	}

	useEffect(() => { checkSetup(false); }, []);

	useEffect(() => { void window.grokCode?.inbound?.(settings.acceptLocalTurns).then((result) => { if (result && !result.ok) { setNotice(result.error || "Turns from local tools could not be switched."); } }); }, [settings.acceptLocalTurns]);

	useEffect(() => {
		const reload = (event: StorageEvent) => {
			if (event.key === settingsKey) { setSettings(readSettings()); }
			if (event.key === historyKey) {
				const saved = readHistory();
				const manual = new Map((saved?.sessions ?? []).filter((item) => item.titleAuto === false).map((item) => [item.id, item.title]));
				const previous = new Map((lastSaved.current?.sessions ?? []).map((item) => [item.id, item.title]));
				const changed = (item: Session) => manual.has(item.id) && (item.titleAuto === true || item.title === previous.get(item.id)) && (item.titleAuto !== false || item.title !== manual.get(item.id));
				setSessions((current) => current.some(changed)
					? current.map((item) => changed(item) ? { ...item, title: manual.get(item.id)!, titleAuto: false } : item)
					: current);
				const last = lastSaved.current;
				if (!last) { return; }
				const remoteSessions = new Map((saved?.sessions ?? []).map((item) => [item.id, item]));
				const watchPatches = new Map<string, Partial<Session>>();
				for (const item of sessionsRef.current) {
					const remote = remoteSessions.get(item.id);
					const old = last.sessions.find((entry) => entry.id === item.id);
					if (!remote && saved?.deleted.includes(item.id)) { watchPatches.set(item.id, { prWatch: undefined }); }
					if (!remote || (!item.prWatch && !remote.prWatch)) { continue; }
					const patch: Partial<Session> = {};
					if (item.prWatch === old?.prWatch && JSON.stringify(item.prWatch) !== JSON.stringify(remote.prWatch)) {
						patch.prWatch = remote.prWatch;
						if (item.unread === old?.unread) { patch.unread = remote.unread; }
					}
					if (item.archived === old?.archived && item.archived !== remote.archived) { patch.archived = remote.archived; }
					if (Object.keys(patch).length) { watchPatches.set(item.id, patch); }
				}
				const added = (saved?.sessions ?? []).filter((item) => item.prWatch && !sessionsRef.current.some((entry) => entry.id === item.id));
				if (watchPatches.size || added.length) { setSessions((current) => [...current.map((item) => watchPatches.has(item.id) ? { ...item, ...watchPatches.get(item.id) } : item), ...added.filter((item) => !current.some((entry) => entry.id === item.id))]); }
				if (added.length) {
					const chats = restoredChats(Object.fromEntries(added.map((item) => [item.id, saved?.extraChats[item.id] ?? []])));
					lastSaved.current = { ...lastSaved.current!, sessions: [...last.sessions, ...added], extraChats: { ...last.extraChats, ...chats } };
					setChatState((current) => ({ ...chats, ...current }));
				}
				const savedQueue = saved?.queued ?? {};
				const mine = queuedRef.current;
				const adopt = [...new Set([...Object.keys(mine), ...Object.keys(savedQueue)])].filter((id) => mine[id] === last.queued?.[id] && JSON.stringify(mine[id] ?? []) !== JSON.stringify(savedQueue[id] ?? []));
				if (adopt.length) {
					const next = { ...mine };
					for (const id of adopt) { if (savedQueue[id]) { next[id] = savedQueue[id]; } else { delete next[id]; } }
					lastSaved.current = { ...lastSaved.current!, queued: { ...last.queued, ...Object.fromEntries(adopt.map((id) => [id, next[id]])) } };
					setQueued(next);
					setHeld((current) => ({ ...current, ...Object.fromEntries(adopt.filter((id) => next[id]).map((id) => [id, true])) }));
				}
				const savedAttachments = saved?.attachments ?? {};
				const staged = attachmentsRef.current;
				const take = [...new Set([...Object.keys(staged), ...Object.keys(savedAttachments)])].filter((id) => staged[id] === last.attachments?.[id] && JSON.stringify(staged[id] ?? []) !== JSON.stringify(savedAttachments[id] ?? []));
				if (take.length) {
					const next = { ...staged };
					for (const id of take) { if (savedAttachments[id]) { next[id] = savedAttachments[id]; } else { delete next[id]; } }
					lastSaved.current = { ...lastSaved.current!, attachments: { ...last.attachments, ...Object.fromEntries(take.map((id) => [id, next[id]])) } };
					setAttachments(next);
				}
			}
		};
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
			const unsavedMessage = !saved && Object.entries(draftsRef.current).some(([id, text]) => text && (pendingRef.current?.id === id || keptForm.current?.session.id === id || sessionsRef.current.some((item) => item.id === id)));
			// Saved queued messages and attachments need a warning only when the save fails.
			if (unsavedMessage || (current !== persistedDrafts.current && Object.values(current).some((draft) => draft && (draft.text !== draft.baseText || draft.recoveryTexts?.length))) || (!saved && (Object.values(queuedRef.current).some((items) => items.length) || Object.values(attachmentsRef.current).some((files) => files.length)))) {
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
		const currentQueue = queuedRef.current;
		const currentAttachments = attachmentsRef.current;
		const currentWork = backgroundWorkRef.current;
		const form = pendingRef.current ? { session: pendingRef.current, useWorktree: useWorktreeRef.current } : keptForm.current;
		const newSessionDraft = form && currentDrafts[form.session.id] ? { ...form, text: currentDrafts[form.session.id] } : undefined;
		const sameForm = last?.newSessionDraft?.session === newSessionDraft?.session && last?.newSessionDraft?.useWorktree === newSessionDraft?.useWorktree && last?.newSessionDraft?.text === newSessionDraft?.text;
		if (last && last.sessions === sessions && last.extraChats === extraChats && last.modes === modes && last.prePlan === prePlan && last.editorDrafts === editorDrafts && last.composerDrafts === currentDrafts && sameRecords(last.queued, currentQueue) && sameRecords(last.attachments, currentAttachments) && sameRecords(last.backgroundWork, currentWork) && sameForm && last.deleted === deleted) { return true; }
		try {
			const saved = readHistory();
			const previous = saved ? last : null;
			const gone = new Set([...(saved?.deleted ?? []), ...deleted]);
			const oldSessions = new Map((previous?.sessions ?? []).map((item) => [item.id, item]));
			const currentSessions = new Map((saved?.sessions ?? []).map((item) => [item.id, item]));
			const savedIds = new Set(currentSessions.keys());
			for (const item of sessions) {
				const old = oldSessions.get(item.id);
				const remote = currentSessions.get(item.id);
				const changes = Object.fromEntries(Object.entries(item).filter(([key, value]) => value !== old?.[key as keyof Session] && !(item.titleAuto === true && remote?.titleAuto === false && (key === "title" || key === "titleAuto"))));
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
			const queue = { ...saved?.queued };
			for (const [id, items] of Object.entries(currentQueue)) {
				if (items === previous?.queued?.[id]) { continue; }
				if (items.length) { queue[id] = items; } else { delete queue[id]; }
			}
			const staged = { ...saved?.attachments };
			for (const [id, files] of Object.entries(currentAttachments)) {
				if (files === previous?.attachments?.[id]) { continue; }
				if (files.length) { staged[id] = files; } else { delete staged[id]; }
			}
			const work = { ...saved?.backgroundWork };
			for (const [id, entry] of Object.entries(currentWork)) {
				if (entry === previous?.backgroundWork?.[id]) { continue; }
				const tasks = entry.tasks.filter((task) => task.status !== "running");
				const agents = entry.agents.filter((agent) => agent.status !== "running").map((agent) => agent.output ? { ...agent, output: agent.output.slice(0, 2000) } : agent);
				if (tasks.length || agents.length) { work[id] = { tasks, agents }; } else { delete work[id]; }
			}
			for (const id of Object.keys(queue)) { if (!order.includes(id)) { delete queue[id]; } }
			for (const id of Object.keys(staged)) { if (!order.includes(id)) { delete staged[id]; } }
			for (const id of Object.keys(work)) { if (!order.includes(id.startsWith("side-") ? id.slice(5) : id)) { delete work[id]; } }
			localStorage.setItem(historyKey, JSON.stringify({
				sessions: order.map((id) => currentSessions.get(id)),
				extraChats: chats,
				modes: { ...saved?.modes, ...Object.fromEntries(Object.entries(modes).filter(([id, value]) => value !== previous?.modes[id])) },
				prePlan: { ...saved?.prePlan, ...Object.fromEntries(Object.entries(prePlan).filter(([id, value]) => value !== previous?.prePlan[id])) },
				editorDrafts: keptDrafts(mergeDrafts(saved?.editorDrafts ?? {}, editorDrafts, previous?.editorDrafts ?? {}), gone),
				composerDrafts,
				queued: queue,
				attachments: staged,
				backgroundWork: work,
				// ponytail: one stored form for all windows; a second window's unsent form replaces the first's here, though each window keeps its own until it closes.
				newSessionDraft: sameForm ? saved?.newSessionDraft : newSessionDraft,
				deleted: [...gone].slice(-500),
			}));
			persistedDrafts.current = editorDrafts;
			lastSaved.current = { sessions, extraChats, modes, prePlan, editorDrafts, composerDrafts: currentDrafts, queued: currentQueue, attachments: currentAttachments, backgroundWork: currentWork, newSessionDraft, deleted };
			setNotices((list) => list.some((item) => item.text === HISTORY_FULL || item.text === HISTORY_FAILED) ? list.filter((item) => item.text !== HISTORY_FULL && item.text !== HISTORY_FAILED) : list);
			return true;
		} catch (error) {
			setNotice(error instanceof DOMException && error.name === "QuotaExceededError" ? HISTORY_FULL : HISTORY_FAILED);
			return false;
		}
	};

	const streamSave = useRef<ReturnType<typeof setTimeout> | null>(null);
	function saveNow() {
		if (streamSave.current) { clearTimeout(streamSave.current); streamSave.current = null; }
		if (!navigator.locks) { setNotice("Chat history could not be saved on this computer."); return; }
		void navigator.locks.request(historyKey, () => saveHistory.current()).catch(() => setNotice("Chat history could not be saved on this computer."));
	}
	useEffect(() => {
		saveNow();
	}, [sessions, modes, prePlan, editorDrafts, queued, attachments, grokTasks, subagents, deleted, pending, useWorktree]);
	useEffect(() => {
		const urgent = urgentSave.current;
		urgentSave.current = false;
		if (urgent || !Object.keys(turnTargets.current).length) { saveNow(); return; }
		if (!streamSave.current) { streamSave.current = setTimeout(saveNow, 2000); }
	}, [extraChats, busy]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!navigator.locks) { setNotice(HISTORY_FAILED); return; }
			void navigator.locks.request(historyKey, () => saveHistory.current()).catch(() => setNotice(HISTORY_FAILED));
		}, 500);
		return () => clearTimeout(timer);
	}, [drafts]);

	const writeReply = useCallback((uiSessionId: string, recipe: (message: ChatMessage) => ChatMessage, streamed = false) => {
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
		if (target.where === "side") { setSideChats(apply); } else if (streamed) { setChatState(apply); } else { setExtraChats(apply); }
	}, []);

	function notify(kind: "permission" | "question" | "done" | "pr", sessionId: string, body: string) {
		const current = settingsRef.current;
		const level = kind === "permission" ? current.notifyPermission : kind === "question" ? current.notifyQuestion : kind === "pr" ? current.notifyPr : current.notifyDone;
		const away = typeof document === "undefined" || !document.hasFocus?.() || sessionId !== activeIdRef.current;
		if (!away) { return; }
		if (current.attention) { void window.grokCode?.attention?.(); }
		if (level !== "banner" || typeof Notification === "undefined") { return; }
		const title = sessionsRef.current.find((item) => item.id === sessionId)?.title ?? "Codewomplers Grok Desktop";
		try {
			const shown = new Notification(title, { body, silent: current.sound === "none" });
			shown.onclick = () => { window.focus(); setActiveId(sessionId); leaveForm(); };
		} catch {
			// Notifications can be blocked by the system.
		}
	}

	useEffect(() => {
		const api = window.grokCode;
		if (!api?.prStatus || !navigator.locks) { return; }
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let release: (() => void) | undefined;
		const poll = async () => {
			for (const item of sessionsRef.current) {
				if (controller.signal.aborted) { return; }
				if (!item.prWatch || item.archived) { continue; }
				try {
					const status = await api.prStatus!(item.folder, item.prWatch.number);
					const latest = sessionsRef.current.find((entry) => entry.id === item.id);
					if (controller.signal.aborted || !latest?.prWatch || latest.archived || latest.folder !== item.folder || latest.prWatch.number !== item.prWatch.number) { continue; }
					const step = prWatchStep(latest.prWatch, status);
					if (!step.stop && step.watch === latest.prWatch) { continue; }
					const away = item.id !== activeIdRef.current;
					setSessions((current) => current.map((entry) => entry.id === item.id && entry.prWatch === latest.prWatch ? { ...entry, prWatch: step.watch, unread: step.alert && away ? true : entry.unread } : entry));
					if (step.alert) { notify("pr", item.id, prAlertText(item.prWatch.number, step.alert)); }
				} catch { /* A failed background read leaves the watch for the next pass. */ }
			}
			if (!controller.signal.aborted) { timer = setTimeout(() => { void poll(); }, PR_POLL_MS); }
		};
		void navigator.locks.request("grok-code.pr-watch", { signal: controller.signal }, () => new Promise<void>((resolve) => {
			release = resolve;
			if (controller.signal.aborted) { resolve(); return; }
			timer = setTimeout(() => { void poll(); }, 10000);
		})).catch(() => {});
		return () => { controller.abort(); clearTimeout(timer); release?.(); };
	}, []);

	// A cold read must not replace a next run that arrived while it was in flight. Live notices bump the epoch.
	function readColdLoops(uiSessionId: string) {
		if (!uiSessionId || uiSessionId.startsWith("side-")) { return; }
		const item = sessionsRef.current.find((entry) => entry.id === uiSessionId);
		const agentSessionId = item?.agentSessionId;
		const read = window.grokCode?.sessionLoops;
		if (!agentSessionId || !read) { return; }
		const epoch = loopEpoch.current[uiSessionId] ?? 0;
		void read(uiSessionId, agentSessionId).then((result) => {
			if ((loopEpoch.current[uiSessionId] ?? 0) !== epoch) { return; }
			if (!result || result.ok === false || result.live) { return; }
			setLoops((current) => ({ ...current, [uiSessionId]: result.loops ?? [] }));
		}).catch(() => {});
	}

	useEffect(() => {
		const api = window.grokCode;
		if (!api) { return; }
		return api.onEvent((event) => {
			if (event.type === "inbound" && event.requestId) { void api.inboundResult?.(event.requestId, inboundAccept.current(event.agentSessionId ?? "", event.text ?? "")); return; }
			if (event.type === "browser-open") {
				if (!settingsRef.current.browserControl || event.uiSessionId !== activeIdRef.current || !event.url) { return; }
				let url: URL;
				try { url = new URL(event.url); } catch { return; }
				if (url.protocol !== "http:" && url.protocol !== "https:") { return; }
				const id = crypto.randomUUID();
				setBrowserTabs((current) => ({ ...current, [event.uiSessionId]: [...(current[event.uiSessionId] ?? []), { id, url: url.toString(), title: url.host }] }));
				setActiveBrowser((current) => ({ ...current, [event.uiSessionId]: id }));
				showPane("browser");
				return;
			}
			if (event.type === "browser-activity") {
				const id = event.uiSessionId;
				if (!sessionsRef.current.some((item) => item.id === id)) { return; }
				clearTimeout(browserActivityTimers.current[id]);
				if (typeof event.stopped === "boolean") { setBrowserStopped((current) => ({ ...current, [id]: event.stopped! })); }
				setBrowserActivity((current) => ({ ...current, [id]: { text: event.text || "Browser call finished.", running: event.running === true } }));
				if (event.running !== true) {
					browserActivityTimers.current[id] = setTimeout(() => {
						setBrowserActivity((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
						delete browserActivityTimers.current[id];
					}, 5000);
				}
				return;
			}
			if (event.type === "update-open" && event.current && event.latest && event.tag) {
				const info = { current: event.current, latest: event.latest, tag: event.tag };
				setUpdate(info);
				void openUpdate(info);
				return;
			}
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
				setTerminals((current) => Object.fromEntries(Object.entries(current).map(([sessionId, tabs]) => [sessionId, tabs.map((tab) => (tab.id === id ? { ...tab, output: `${tab.output}${data}`.slice(-200000), received: (tab.received ?? tab.output.length) + data.length } : tab))])));
				return;
			}
			if (event.type === "terminal-exit" && event.id) {
				const id = event.id;
				setTerminals((current) => Object.fromEntries(Object.entries(current).map(([sessionId, tabs]) => [sessionId, tabs.map((tab) => (tab.id === id ? { ...tab, running: false } : tab))])));
				setDevTabs((current) => Object.fromEntries(Object.entries(current).filter(([, tabId]) => tabId !== id)));
				return;
			}
			if (event.type === "loops" && event.uiSessionId) {
				const id = event.uiSessionId;
				loopEpoch.current[id] = (loopEpoch.current[id] ?? 0) + 1;
				setLoops((current) => ({ ...current, [id]: event.loops ?? [] }));
				if (event.reset) { readColdLoops(id); }
				return;
			}
			if (event.type === "bg-tasks" && event.uiSessionId) {
				const id = event.uiSessionId;
				const incoming = event.tasks ?? [];
				const now = Date.now();
				setGrokTasks((current) => {
					const tasks = new Map((current[id] ?? []).map((task) => [task.id, task.status === "running" && !incoming.some((item) => item.id === task.id) ? { ...task, status: "cancelled", endedAt: now } : task]));
					for (const task of incoming) { tasks.set(task.id, task); }
					return { ...current, [id]: recentTasks([...tasks.values()]) };
				});
				if (event.reset) { setSubagents((current) => ({ ...current, [id]: recentAgents((current[id] ?? []).map((agent) => agent.status === "running" ? { ...agent, status: "cancelled", endedAt: now } : agent)) })); }
				return;
			}
			if (event.type === "subagent" && event.uiSessionId && event.subagent) {
				const id = event.uiSessionId;
				const incoming = event.subagent;
				setSubagents((current) => {
					const list = current[id] ?? [];
					const previous = list.find((item) => item.id === incoming.id);
					const merged = { ...previous, ...incoming, label: incoming.label || previous?.label || "Subagent", agentType: incoming.agentType || previous?.agentType || "", model: incoming.model || previous?.model || "", childSessionId: incoming.childSessionId || previous?.childSessionId, output: incoming.output || previous?.output, durationMs: incoming.durationMs ?? previous?.durationMs, tokensUsed: incoming.tokensUsed ?? previous?.tokensUsed, toolCalls: incoming.toolCalls ?? previous?.toolCalls, endedAt: incoming.status === "running" ? incoming.endedAt : incoming.endedAt ?? previous?.endedAt ?? Date.now() };
					return { ...current, [id]: recentAgents([merged, ...list.filter((item) => item.id !== incoming.id)]) };
				});
				return;
			}
			if (event.type === "title" && event.uiSessionId && event.title) {
				const id = event.uiSessionId;
				const title = event.title;
				const manual = readHistory()?.sessions.find((item) => item.id === id && item.titleAuto === false);
				setSessions((current) => current.map((item) => (item.id === id && item.titleAuto === true ? manual ? { ...item, title: manual.title, titleAuto: false } : item.title !== title ? { ...item, title } : item : item)));
				return;
			}
			// Grok ran a steer that arrived after the turn ended as a turn of its own; it shows as a new message and reply.
			if (event.type === "turn-start" && event.uiSessionId && event.turnId) {
				const id = event.uiSessionId;
				if (turnTargets.current[id] || !sessionsRef.current.some((item) => item.id === id)) { return; }
				const stamp = Date.now();
				const replyId = `grok-${event.turnId}`;
				turnTargets.current[id] = { sessionId: id, replyId, turnId: event.turnId, where: "main" };
				const asked: ChatMessage[] = event.text ? [{ id: `user-${event.turnId}`, role: "user", text: event.text, at: stamp, live: true }] : [];
				setExtraChats((list) => ({ ...list, [id]: [...(list[id] ?? []), ...asked, { id: replyId, role: "grok", text: "", pending: true, streaming: true, live: true }] }));
				setSessions((list) => list.map((item) => (item.id === id ? { ...item, lastActivityAt: stamp, completed: false } : item)));
				setBusy((list) => ({ ...list, [id]: true }));
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
				setNotices((list) => list.some((item) => item.text === SIDE_BUSY) ? list.filter((item) => item.text !== SIDE_BUSY) : list);
				setDiffTick((value) => value + 1);
				setRemoteTick((value) => value + 1);
				setFileTick((value) => value + 1);
				if (target.where === "main") {
					const away = sessionId !== activeIdRef.current;
					setSessions((current) => current.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: Date.now(), unread: away || item.unread, completed: false, failed: event.type === "error" } : item)));
					notify("done", sessionId, event.type === "error" ? "Grok stopped with an error." : "Grok finished.");
				}
			}
			writeReply(uiId, (message) => {
				if (event.type === "steer" && event.text) {
					return { ...message, pending: false, parts: [...(message.parts ?? []), { kind: "steer", text: event.text }] };
				}
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
						return { ...message, at: Date.now(), pending: false, streaming: false, text: stoppedTurn ? "Stopped." : "No reply." };
					}
					return { ...message, at: Date.now(), pending: false, streaming: false };
				}
				if (event.type === "error" && event.message) {
					const prefix = message.text ? `${message.text}\n` : "";
					return { ...message, at: Date.now(), pending: false, streaming: false, text: `${prefix}${event.message}`, parts: [...(message.parts ?? []), { kind: "text", text: `${message.text ? "\n" : ""}${event.message}` }] };
				}
				return message;
			}, event.type === "chunk" || event.type === "thought");
			if (event.type === "done" || event.type === "error") {
				delete turnTargets.current[uiId];
				if (target.where === "main" && event.type === "done" && event.stopReason !== "cancelled" && settingsRef.current.promptSuggestions) {
					const generation = suggestionGeneration.current[sessionId] ?? 0;
					suggestionGeneration.current[sessionId] = generation;
					void api.suggestPrompt?.(sessionId).then((text) => {
						if (text && settingsRef.current.promptSuggestions && suggestionGeneration.current[sessionId] === generation && !draftsRef.current[sessionId] && !turnTargets.current[sessionId] && sessionsRef.current.some((item) => item.id === sessionId)) {
							setSuggestions((current) => ({ ...current, [sessionId]: text }));
						}
					}).catch(() => {});
				}
			}
		});
	}, [writeReply, openUpdate]);

	const visible = pending ?? sessions.find((item) => item.id === activeId) ?? sessions.find((item) => !item.archived) ?? sessions[0];
	const session = visible;
	useEffect(() => {
		if (!panes.includes("browser")) {
			void window.grokCode?.browserTabs?.({ uiSessionId: session.id, enabled: settings.browserControl, visible: false, activeId: "", tabs: [] }).catch(() => {});
		}
	}, [session.id, settings.browserControl, panes]);
	useEffect(() => { setRewindAsk(null); }, [session.id]);
	// The session on screen, which is the first one before any is picked; a new-session page is none.
	activeIdRef.current = pending ? "" : session.id;
	useEffect(() => { if (!pending) { readColdLoops(session.id); } }, [pending, session.id, session.agentSessionId]);
	const mode = knownMode(modes[session.id] ?? settings.defaultMode, settings);
	const view = views[session.id] ?? settings.defaultView;
	const prompt = drafts[session.id] ?? "";
	const setPrompt = (next: string | ((current: string) => string)) => {
		const sessionId = session.id;
		const current = draftsRef.current;
		const value = typeof next === "function" ? next(current[sessionId] ?? "") : next;
		if (value !== (current[sessionId] ?? "")) { invalidateSuggestion(sessionId); }
		draftsRef.current = { ...current, [sessionId]: value };
		setDrafts(draftsRef.current);
	};
	const messages = extraChats[session.id] ?? [];
	const scope = diffScope[session.id] ?? "uncommitted";
	const diffOpen = panes.includes("diff");
	const railOpen = settings.railOpen;
	const sidebarCollapsed = settings.sidebarCollapsed || shouldCollapseSidebar(windowWidth, panes.length > 0);
	const paneWidth = Math.min(settings.sideWidth, sideCap(windowWidth, sidebarCollapsed));
	// Like Claude's rail, it steps aside when the chat column would get too narrow.
	const railShown = railOpen && windowWidth - (sidebarCollapsed ? 0 : 260) - (panes.length ? paneWidth : 0) - 280 >= 560;
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
		return () => { cancel = true; };
	}, [diffOpen, railShown, session.id, session.folder, diffTick, scope]);

	useEffect(() => {
		if (!diffOpen && !railShown) { return; }
		const id = session.id;
		const folder = session.folder;
		const api = window.grokCode;
		let cancel = false;
		void api?.prStatus?.(folder).then((result) => {
			if (cancel) { return; }
			setPrs((current) => ({ ...current, [id]: result }));
			const pr = result.ok && result.pr;
			if (pr && pr.state === "OPEN") {
				const feedback = (pr.feedback ?? []).map((item) => item.at).sort();
				const watch = { number: pr.number, failing: pr.checks.filter((check) => check.state === "fail").map((check) => check.name), seenAt: feedback.at(-1) || new Date().toISOString() };
				setSessions((current) => current.map((item) => item.id === id && !item.prWatch ? { ...item, prWatch: watch } : item));
			}
		}).catch(() => {});
		if (diffOpen) {
			void api?.listCommits?.(folder).then((result) => { if (!cancel && result.ok) { setCommits((current) => ({ ...current, [id]: result.commits ?? [] })); } }).catch(() => {});
		}
		return () => { cancel = true; };
	}, [diffOpen, railShown, session.id, session.folder, remoteTick]);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const resize = () => {
			clearTimeout(timer);
			timer = setTimeout(() => setWindowWidth(window.innerWidth), 100);
		};
		window.addEventListener("resize", resize);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("resize", resize);
		};
	}, []);

	useEffect(() => {
		// Before Grok starts the host has no account, so the remembered one stays.
		void window.grokCode?.account?.().then((value) => { if (value !== undefined) { setAccount(value); } }).catch(() => {});
		const load = window.grokCode?.appInfo;
		if (!load) { return; }
		void load().then((info) => { if (info?.version) { appVersion.current = info.version; } }).catch(() => {});
	}, []);

	useEffect(() => {
		const check = window.grokCode?.updateCheck;
		if (!check) { return; }
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const read = async () => {
			try {
				const result = await check();
				if (!cancelled && result.ok) {
					setUpdate(result.available && result.current && result.latest && result.tag ? { current: result.current, latest: result.latest, tag: result.tag } : null);
				}
			} catch { /* Background checks stay quiet when the origin is unavailable. */ }
			if (!cancelled) { timer = setTimeout(() => { void read(); }, 6 * 60 * 60 * 1000); }
		};
		timer = setTimeout(() => { void read(); }, 15000);
		return () => { cancelled = true; clearTimeout(timer); };
	}, []);

	useEffect(() => {
		void window.grokCode?.updateResult?.().then((result) => { if (result?.message) { setNotice(result.message, result.ok); } }).catch(() => {});
	}, [setNotice]);

	function createPr() {
		const api = window.grokCode;
		if (!api?.prCreate) { return Promise.resolve({ ok: false, error: "Reopen this window to create a pull request." }); }
		return api.prCreate(session.folder, branches[session.id]?.branch).then((result) => {
			const number = result.ok && /\/pull\/(\d+)/.exec(result.url ?? "")?.[1];
			if (number) { updateSession(session.id, { prWatch: { number: Number(number), failing: [], seenAt: new Date().toISOString() } }); }
			setDiffTick((value) => value + 1);
			setRemoteTick((value) => value + 1);
			return result;
		});
	}

	function dismissPrAlert() {
		setSessions((current) => current.map((item) => item.id === session.id && item.prWatch ? { ...item, prWatch: { ...item.prWatch, alert: undefined } } : item));
	}

	function askGrokToFix() {
		const watch = session.prWatch;
		if (watch?.alert && send(prFixPrompt(watch.number, watch.alert), false, session.id)) { dismissPrAlert(); }
	}

	function mergeWhenReady() {
		const api = window.grokCode;
		if (!api?.prMergeWhenReady) { return Promise.resolve({ ok: false, error: "Reopen this window to merge." }); }
		return api.prMergeWhenReady(session.folder, prs[session.id]?.pr?.number ?? 0).then((result) => { setDiffTick((value) => value + 1); setRemoteTick((value) => value + 1); return result; });
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
	const draftKey = dirtyDraftFiles.join("\n");
	const listed = folderFiles?.files;
	const knownFiles = useMemo(() => (listed && draftKey ? [...new Set([...listed, ...dirtyDraftFiles])] : listed), [listed, draftKey]);
	const paneFiles = folderFiles && knownFiles ? { ...folderFiles, files: knownFiles } : undefined;

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
			setFolderLists((current) => {
				const previous = current[id]?.files;
				const same = !!previous && previous.length === files.length && previous.every((file, index) => file === files[index]);
				return { ...current, [id]: { status: "ready", files: same ? previous : files, truncated: result.truncated } };
			});
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
			if (!item.worktreeFolder || !api?.removeWorktree || sharesFolder(item)) {
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

	// The form on screen when it has text that would be lost with it; the first-launch form is already in the list.
	function formWithText() {
		const form = pendingRef.current;
		return form && draftsRef.current[form.id] && !sessionsRef.current.some((item) => item.id === form.id) ? { session: form, useWorktree: useWorktreeRef.current } : null;
	}

	// A form with text is kept rather than dropped, so looking at another session never loses it.
	function leaveForm() {
		const form = formWithText();
		if (form) { keptForm.current = form; }
		setPending(null);
	}

	function selectSession(id: string, find?: string) {
		flushEditor();
		leaveForm();
		setActiveId(id);
		setMenu(null);
		if (find) { setFindAt((current) => ({ tick: current.tick + 1, text: find })); }
		setSessions((current) => (current.some((item) => item.id === id && item.unread) ? current.map((item) => (item.id === id ? { ...item, unread: false } : item)) : current));
		readColdLoops(id);
	}

	function createSession(seed?: Partial<ProjectSeed>) {
		flushEditor();
		const base = seed?.folder ? seed : { folder: session.folder, project: session.project, branch: session.branch, worktree: session.project, environment: "Local" as Environment };
		// A form with text, on screen or kept, comes back with it; a folder picked in the sidebar still applies.
		const kept = formWithText() ?? keptForm.current;
		keptForm.current = null;
		const reopen = kept && !seed?.folder;
		const created = reopen ? kept.session : { ...newSession(base), ...(kept ? { id: kept.session.id } : {}) };
		setPending(created);
		setUseWorktree(reopen ? kept.useWorktree : false);
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

	function sharesFolder(item: Session) {
		return sessionsRef.current.some((other) => other.id !== item.id && !other.archived && folderKey(other.folder) === folderKey(item.folder));
	}

	function folderBusy(item: Session) {
		return sessionsRef.current.some((other) => other.id !== item.id && !other.archived && folderKey(other.folder) === folderKey(item.folder) && (busy[other.id] || busy[`side-${other.id}`]));
	}

	function noteFolderClash(item: Session) {
		if (collisionSeen[item.id] || !folderBusy(item)) { return; }
		setCollisionSeen((current) => (current[item.id] ? current : { ...current, [item.id]: true }));
	}

	inboundAccept.current = (agentSessionId, text) => {
		const target = sessions.find((item) => item.agentSessionId === agentSessionId && !item.archived);
		if (!target) { return { accepted: false }; }
		// Modes, archive state and folders are not synced between windows, so check this window against the saved history.
		const saved = readHistory();
		const stored = saved?.sessions.find((item) => item.id === target.id);
		const modeHere = knownMode(modes[target.id] ?? settings.defaultMode, settings);
		const modeSaved = knownMode(saved?.modes?.[target.id] ?? settings.defaultMode, settings);
		if (!stored || stored.archived || stored.folder !== target.folder || stored.agentSessionId !== agentSessionId || modeSaved !== modeHere) { return { accepted: false, stale: true }; }
		const waiting = (queuedRef.current[target.id] ?? []).length > 0;
		const status = held[target.id] ? "held" : (busy[target.id] || turnTargets.current[target.id] || waiting ? "queued" : "sent");
		setQueued((list) => ({ ...list, [target.id]: [...(list[target.id] ?? []), { id: crypto.randomUUID(), text: `[Sent by a local tool, not typed in Grok Code]\n\n${text}`, attachments: [] }] }));
		return { accepted: true, status };
	};

	function openPromptLibrary(mode: "save" | "insert") {
		const field = promptRef.current;
		setMenu(null);
		setPromptLibrary({ mode, sessionId: session.id, text: prompt, start: field?.selectionStart ?? prompt.length, end: field?.selectionEnd ?? prompt.length });
	}

	function closePromptLibrary() {
		setPromptLibrary(null);
		setTimeout(() => promptRef.current?.focus?.(), 0);
	}

	function savePrompt(name: string, text: string): string {
		const saved = settingsRef.current.savedPrompts;
		const error = promptNameError(saved, name);
		if (error) { return error; }
		if (!text.trim()) { return "Write a prompt before saving it."; }
		if (text.length > MAX_PROMPT_TEXT) { return `Use at most ${MAX_PROMPT_TEXT.toLocaleString()} characters.`; }
		if (saved.length >= MAX_SAVED_PROMPTS) { return `You can save up to ${MAX_SAVED_PROMPTS} prompts.`; }
		changeSettings({ savedPrompts: [...saved, { id: crypto.randomUUID(), name: name.trim(), text }] });
		return "";
	}

	function insertPrompt(text: string) {
		if (!promptLibrary) { return; }
		if (session.id !== promptLibrary.sessionId || prompt !== promptLibrary.text) {
			setNotice("The draft changed. Open saved prompts again to insert here.");
			return;
		}
		const inserted = insertSavedPrompt(prompt, text, promptLibrary.start, promptLibrary.end);
		setPrompt(inserted.text);
		setTimeout(() => {
			const field = promptRef.current;
			if ((pendingRef.current?.id ?? activeIdRef.current) === promptLibrary.sessionId && field?.value === inserted.text) {
				field.focus();
				field.setSelectionRange(inserted.cursor, inserted.cursor);
			}
		}, 0);
	}

	keyActions.current = {
		newSession: () => createSession(),
		next: () => stepSession(1),
		previous: () => stepSession(-1),
		stop: () => { if (busy[session.id]) { stop(session.id); } },
		cycleView: () => setViews((current) => ({ ...current, [session.id]: VIEWS[(VIEWS.indexOf(current[session.id] ?? settingsRef.current.defaultView) + 1) % VIEWS.length] })),
		find: () => setFindTick((value) => value + 1),
		side: () => setSideOpen((value) => !value),
		savedPrompts: () => openPromptLibrary("insert"),
		terminal: () => togglePane("terminal"),
		diff: () => togglePane("diff"),
		browser: () => togglePane("browser"),
		select: () => { showPane("browser"); setSelectTick((value) => value + 1); },
		closePane: () => { const target = focusedPane && panes.includes(focusedPane) ? focusedPane : panes[panes.length - 1]; if (target) { closePane(target); } },
	};

	const slashActions: Record<string, (arg: string) => void | Promise<void>> = {
		usage: () => showUsage("/usage"),
		cost: () => showUsage("/cost"),
		new: () => keyActions.current.newSession?.(),
		rename: (arg) => { if (arg) { renameSession(session.id, arg); } else { setRenaming(session.id); } },
		delete: async () => {
			if (activity[session.id]) { setNotice("Stop this session before deleting it."); return; }
			if (await askConfirm({ title: `Delete "${session.title}"?`, body: "Its transcript is removed from this app and cannot be restored.", ok: "Delete", danger: true })) { deleteSession(session.id); }
		},
		fork: async () => {
			if (busy[session.id]) { setNotice("Wait for Grok to finish, then try again."); return; }
			const latest = [...messages].reverse().find((item) => item.role === "user" && item.point && item.point.agentSessionId === session.agentSessionId);
			if (!latest) { setNotice("No sent message to fork from yet."); return; }
			await forkAt(latest);
		},
		rewind: async () => {
			if (busy[session.id]) { setNotice("Wait for Grok to finish, then try again."); return; }
			const latest = [...messages].reverse().find((item) => item.role === "user" && item.point && item.point.agentSessionId === session.agentSessionId);
			if (!latest) { setNotice("No sent message to rewind to yet."); return; }
			await startRewind(latest);
		},
		copy: () => {
			const latest = [...messages].reverse().find((item) => item.role === "grok" && !item.pending && !item.streaming && item.text);
			if (latest) { copyText(latest.text); }
		},
		find: () => keyActions.current.find?.(),
		transcript: () => keyActions.current.cycleView?.(),
		expand: () => keyActions.current.cycleView?.(),
		tasks: () => togglePane("tasks"),
		"view-plan": () => togglePane("plan"),
		plan: () => changeMode(session.id, "Plan"),
		auto: () => changeMode(session.id, "Auto-review"),
		model: () => setMenu("model"),
		effort: () => setMenu("effort"),
		cd: () => setMenu("folder"),
		resume: () => { changeSettings({ sidebarCollapsed: false }); setNotice("Pick a session in the sidebar, or search for one."); },
		help: () => setShortcuts(true),
		theme: (arg) => {
			if (!arg) { setSettingsOpen("general"); }
			else if (arg === "system" || arg === "light" || arg === "dark") { changeSettings({ appearance: arg }); }
			else { setNotice("Use /theme system, light or dark."); }
		},
		mcps: () => setSettingsOpen("connectors"),
		skills: () => setSettingsOpen("skills"),
		marketplace: () => setSettingsOpen("plugins"),
		doctor: () => checkSetup(),
		login: () => checkSetup(),
		logout: () => signOut(),
	};

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (document.querySelector?.("[data-commit-dialog]") || document.querySelector?.("[data-saved-prompts-dialog]")) { return; }
			// An open confirm owns the keyboard: Escape cancels it without acting underneath it.
			if (confirmShown.current) {
				if (event.key === "Escape") { event.preventDefault(); answerRef.current(false); }
				return;
			}
			// The Files editor handled this key; the app's shortcut must not run too.
			if (event.defaultPrevented && (event.target as Element | null)?.closest?.(".cm-editor")) { return; }
			if ((event.target as Element | null)?.closest?.(".xterm")) { return; }
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
					setPromptLibrary(null);
					setRewindAsk(null);
					setSettingsOpen(null);
					setSetup((current) => ({ ...current, open: false }));
				} else {
					keyActions.current.stop?.();
				}
				return;
			}
			if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && document.querySelector(".pop")) {
				const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".pop button:not(:disabled)"));
				const item = items[Number(event.key) - 1];
				if (item) { event.preventDefault(); item.click(); }
				return;
			}
			if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !overlayOpen.current) {
				const target = event.target as HTMLElement | null;
				const typing = !(target === promptRef.current && !promptRef.current?.value) && !!target?.closest?.("input, textarea, select, [contenteditable='true']");
				const own = typing ? null : target?.closest?.(".tool-question:has(.tool-choices)");
				const blocks = Array.from(document.querySelectorAll(".chat .tool-question:has(.tool-choices)"));
				const block = typing ? null : own ?? blocks.find((item) => !item.querySelector(".tool-choices .on, .tool-other.on")) ?? blocks[0];
				const choice = block?.querySelectorAll<HTMLButtonElement>(".tool-choices button:not(:disabled)")[Number(event.key) - 1];
				if (choice) { event.preventDefault(); choice.click(); return; }
			}
			if (!modKey(event)) { return; }
			// Settings covers the sessions, so its shortcuts must not change them unseen.
			if (settingsShown.current) { return; }
			if (event.key === "Tab") { run(event.shiftKey ? "previous" : "next"); return; }
			if (event.shiftKey && (event.code === "BracketRight" || event.key === "}")) { run("next"); return; }
			if (event.shiftKey && (event.code === "BracketLeft" || event.key === "{")) { run("previous"); return; }
			if (event.shiftKey && key === "b") { run("browser"); return; }
			if (event.shiftKey && key === "d") { run("diff"); return; }
			if (event.shiftKey && key === "s") { run("select"); return; }
			if (event.shiftKey && key === "p") { run("savedPrompts"); return; }
			if (event.shiftKey && key === "m") { event.preventDefault(); setMenu("mode"); return; }
			if (event.shiftKey && key === "i") { event.preventDefault(); setMenu("model"); return; }
			if (event.shiftKey && key === "e") { event.preventDefault(); setMenu("effort"); return; }
			if (event.shiftKey) { return; }
			if (event.altKey) {
				if (event.key === "1") { run("newSession"); }
				return;
			}
			if (key === "f") { run("find"); return; }
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

	// `steer` is set for what the user types: during a turn it goes into that turn. Everything else waits in the queue.
	function send(text: string, side: boolean, targetId = session.id, files: string[] = [], steer = false, contextFrom: ContextPick[] = []) {
		const body = text.trim();
		const target = sessionsRef.current.find((item) => item.id === targetId);
		if (!body || !target) { return false; }
		const sessionId = target.id;
		const picks = side ? [] : contextPicksFrom(contextFrom, sessionId);
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
		if (!side) { noteFolderClash(target); }
		if (!side) { invalidateSuggestion(sessionId); }
		if (turnTargets.current[uiId] || (!side && branching === sessionId)) {
			if (side) {
				setNotice(SIDE_BUSY);
				return false;
			}
			const item = { id: crypto.randomUUID(), text: body, attachments: files, ...(picks.length ? { contextFrom: picks } : {}) };
			setHeld((list) => ({ ...list, [sessionId]: false }));
			// Attachments, earlier-chat context and commands cannot go into a running turn, so they wait; a steer Grok refuses joins the queue.
			if (steer && turnTargets.current[uiId] && window.grokCode?.steer && !files.length && !picks.length && !body.startsWith("/")) {
				void steerQueued(item, sessionId, true);
				return true;
			}
			setQueued((list) => ({ ...list, [sessionId]: [...(list[sessionId] ?? []), item] }));
			return true;
		}
		if (!target.model) { updateSession(sessionId, { model: chosenModel, effort: chosenEffort }); }
		if (!side) {
			setHeld((list) => ({ ...list, [sessionId]: false }));
			if (!modes[sessionId]) { changeMode(sessionId, chosenMode); }
		}
		if (!side && target.title === "New session" && target.titleAuto !== false) {
			const title = body.replace(/\s+/g, " ").slice(0, 48);
			setSessions((list) => list.map((item) => (item.id === sessionId && item.title === "New session" ? { ...item, title, titleAuto: true, detail: "Live", when: "now" } : item)));
		}
		const stamp = Date.now();
		const replyId = `${side ? "side-grok" : "grok"}-${stamp}`;
		const turnId = crypto.randomUUID();
		turnTargets.current[uiId] = { sessionId, replyId, turnId, where: side ? "side" : "main" };
		const userMessage: ChatMessage = { id: `${side ? "side-user" : "user"}-${stamp}`, role: "user", text: body, at: stamp, live: true, ...(files.length ? { attachments: files } : {}), ...(picks.length ? { contextFrom: picks } : {}) };
		const replyMessage: ChatMessage = { id: replyId, role: "grok", text: "", pending: true, streaming: true, live: true };
		const store = side ? setSideChats : setExtraChats;
		store((list) => ({ ...list, [sessionId]: [...(list[sessionId] ?? []), userMessage, replyMessage] }));
		if (!side) { setSessions((list) => list.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: stamp, completed: false } : item))); }
		const api = window.grokCode;
		if (!api) {
			writeReply(uiId, (message) => ({ ...message, at: Date.now(), pending: false, streaming: false, text: "Open this window from the desktop app to talk to Grok." }));
			delete turnTargets.current[uiId];
			return true;
		}
		setBusy((list) => ({ ...list, [uiId]: true }));
		const sideAgent = sideAgents[sessionId];
		// A side question carries the main-chat messages it has not seen yet; a reply still streaming waits for the next one.
		const main = (extraChats[sessionId] ?? []).filter((message) => !message.streaming);
		const seen = sideAgent ? main.findIndex((message) => message.id === sideSeen.current[sessionId]) : -1;
		const blocks = picks.map((pick) => contextSnapshot(pick.title, extraChats[pick.id] ?? []));
		const outgoing = side ? `${sideContext(main.slice(seen + 1))}${body}` : contextForGrok(blocks, body);
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
			browser: !side && settings.browserControl,
			...(files.length ? { attachments: files } : {}),
		}).then((result) => {
			if (!side && result.ok) { sentModes.current[sessionId] = chosenMode; }
			if (result.agentSessionId) {
				const agentId = result.agentSessionId;
				// A reply that lands after Choose a folder must not bring the old folder's side conversation back.
				const now = sessionsRef.current.find((item) => item.id === sessionId) ?? (pendingRef.current?.id === sessionId ? pendingRef.current : undefined);
				if (side) { if (now?.folder === folder) { setSideAgents((list) => ({ ...list, [sessionId]: agentId })); } } else { setSessions((list) => list.map((item) => (item.id === sessionId && item.folder === folder ? { ...item, agentSessionId: agentId } : item))); }
			}
			if (!side && result.ok && result.agentSessionId && Number.isInteger(result.promptIndex)) {
				const point = { agentSessionId: result.agentSessionId, index: result.promptIndex as number };
				setExtraChats((list) => ({ ...list, [sessionId]: (list[sessionId] ?? []).map((message) => (message.id === userMessage.id ? { ...message, point } : message)) }));
			}
			if (result.lostSession && side) {
				setSideAgents((list) => Object.fromEntries(Object.entries(list).filter(([id]) => id !== sessionId)));
				delete sideSeen.current[sessionId];
			} else if (result.lostSession) {
				setSessions((list) => list.map((item) => (item.id === sessionId && item.folder === folder ? { ...item, agentSessionId: undefined } : item)));
			}
			if (result.ok) { return; }
			setBusy((list) => ({ ...list, [uiId]: false }));
			writeReply(uiId, (message) => ({ ...message, at: Date.now(), pending: false, streaming: false, text: `${message.text ? `${message.text}\n` : ""}${result.error || "Grok could not start."}` }));
			if (turnTargets.current[uiId]?.turnId === turnId) { delete turnTargets.current[uiId]; }
		}).catch(() => {
			setBusy((list) => ({ ...list, [uiId]: false }));
			writeReply(uiId, (message) => ({ ...message, at: Date.now(), pending: false, streaming: false, text: message.text || "Grok could not start." }));
			if (turnTargets.current[uiId]?.turnId === turnId) { delete turnTargets.current[uiId]; }
		});
		return true;
	}

	useEffect(() => {
		for (const [sessionId, items] of Object.entries(queued)) {
			if (!items.length || queuedRef.current[sessionId] !== items || held[sessionId] || busy[sessionId] || turnTargets.current[sessionId] || branching === sessionId) { continue; }
			setQueued((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((item) => item.id !== items[0].id) }));
			send(items[0].text, false, sessionId, items[0].attachments, false, items[0].contextFrom ?? []);
		}
	}, [queued, held, busy, branching]);

	function sendNow(sessionId: string, itemId: string) {
		setQueued((current) => {
			const items = current[sessionId] ?? [];
			const item = items.find((entry) => entry.id === itemId);
			return item ? { ...current, [sessionId]: [item, ...items.filter((entry) => entry !== item)] } : current;
		});
		setHeld((current) => ({ ...current, [sessionId]: false }));
		if (turnTargets.current[sessionId]) { void window.grokCode?.cancel(sessionId); }
	}

	function editQueued(item: Queued) {
		const latest = queuedRef.current[session.id]?.find((entry) => entry.id === item.id);
		if (!latest) { return; }
		setQueued((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((entry) => entry.id !== latest.id) }));
		setPrompt((current) => (current.trim() ? `${current}\n\n${latest.text}` : latest.text));
		if (latest.attachments.length) { setAttachments((current) => ({ ...current, [session.id]: [...new Set([...(current[session.id] ?? []), ...latest.attachments])] })); }
		if (latest.contextFrom?.length) {
			const carried = latest.contextFrom;
			setContextPicks((current) => ({ ...current, [session.id]: carried.reduce(addContextPick, current[session.id] ?? []) }));
		}
		promptRef.current?.focus?.();
	}

	// A queued row, or with `typed` a message not queued yet, goes into the running turn; if Grok refuses it, it waits in the queue.
	async function steerQueued(item: Queued, sessionId = session.id, typed = false) {
		const api = window.grokCode;
		if (!api?.steer || !turnTargets.current[sessionId] || item.attachments.length || item.contextFrom?.length) { return; }
		const at = typed ? Infinity : (queuedRef.current[sessionId] ?? []).findIndex((entry) => entry.id === item.id);
		if (at < 0) { return; }
		if (!typed) { setQueued((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((entry) => entry.id !== item.id) })); }
		const result = await api.steer(sessionId, item.text);
		if (!result.ok) {
			setQueued((current) => {
				const items = [...(current[sessionId] ?? [])];
				items.splice(Math.min(at, items.length), 0, item);
				return { ...current, [sessionId]: items };
			});
			setNotice(`${result.error || "Grok did not take the message."} It stays queued.`);
		}
	}

	function branchRequest(message: ChatMessage): GrokBranchRequest {
		const current = settingsRef.current;
		return { uiSessionId: session.id, cwd: session.folder, model: session.model ?? current.model, effort: session.effort ?? current.effort, mode: knownMode(modes[session.id] ?? current.defaultMode, current), agentSessionId: message.point!.agentSessionId, index: message.point!.index, text: message.text };
	}

	async function startRewind(message: ChatMessage) {
		const api = window.grokCode;
		const sessionId = session.id;
		if (!api?.rewind || !message.point || busy[sessionId] || branching) { return; }
		setBranching(sessionId);
		const preview = await api.rewind({ ...branchRequest(message), rewindMode: "all", force: false }).finally(() => setBranching(null));
		if (activeIdRef.current !== sessionId) { return; }
		if (!preview.ok || (preview.error && !preview.conflicts?.length)) { setNotice(preview.error || "Grok could not rewind."); return; }
		setRewindAsk({ sessionId, message, files: [...(preview.cleanFiles ?? []), ...(preview.conflicts ?? [])], conflicts: preview.conflicts ?? [] });
	}

	async function finishRewind(rewindMode: "all" | "conversation_only" | "files_only") {
		const ask = rewindAsk;
		const api = window.grokCode;
		setRewindAsk(null);
		if (!ask || !api?.rewind || branching) { return; }
		if (ask.sessionId !== session.id || ask.message.point?.agentSessionId !== session.agentSessionId) { setNotice("This session changed since you opened the dialog, so nothing was rewound."); return; }
		if (busy[ask.sessionId]) { setNotice("Grok started answering, so nothing was rewound. Rewind again when it finishes."); return; }
		setBranching(ask.sessionId);
		const result = await api.rewind({ ...branchRequest(ask.message), rewindMode, force: true, seen: ask.conflicts }).finally(() => setBranching(null));
		setDiffTick((value) => value + 1);
		setFileTick((value) => value + 1);
		if (!result.ok || !result.done) {
			const partial = result.revertedFiles?.length ?? 0;
			setNotice(`${result.error || "Grok did not rewind."}${partial ? ` ${partial} file${partial === 1 ? " was" : "s were"} restored before it stopped.` : ""}`);
			return;
		}
		if (rewindMode !== "files_only") {
			setExtraChats((list) => {
				const messages = list[ask.sessionId] ?? [];
				const at = messages.findIndex((item) => item.id === ask.message.id);
				return at < 0 ? list : { ...list, [ask.sessionId]: messages.slice(0, at) };
			});
			const text = ask.message.text;
			setPrompt((current) => (current.trim() ? `${current}\n\n${text}` : text));
			const files = ask.message.attachments ?? [];
			if (files.length) { setAttachments((current) => ({ ...current, [ask.sessionId]: [...new Set([...(current[ask.sessionId] ?? []), ...files])] })); }
		}
		invalidateSuggestion(ask.sessionId);
		const count = result.revertedFiles?.length ?? 0;
		setNotice(rewindMode === "conversation_only" ? "Rewound the conversation. Files were left as they are." : `Rewound${rewindMode === "files_only" ? " the files" : ""}. ${count} file${count === 1 ? "" : "s"} restored.`, true);
	}

	async function forkAt(message: ChatMessage) {
		const api = window.grokCode;
		const source = session;
		const point = message.point;
		if (!api?.fork || !point || busy[source.id] || branching) { return; }
		setBranching(source.id);
		const result = await api.fork(branchRequest(message)).finally(() => setBranching(null));
		if (!result.ok || !result.agentSessionId) { setNotice(result.error || "Grok could not fork this session."); return; }
		const agentSessionId = result.agentSessionId;
		const messages = extraChats[source.id] ?? [];
		const at = messages.findIndex((item) => item.id === message.id);
		const next = messages.findIndex((item, index) => index > at && item.role === "user");
		const copied = (next < 0 ? messages : messages.slice(0, next)).map((item) => (!item.point ? item : item.point.agentSessionId === point.agentSessionId ? { ...item, point: { ...item.point, agentSessionId } } : { ...item, point: undefined }));
		const forked: Session = { ...newSession({ folder: source.folder, project: source.project, branch: source.branch, worktree: source.worktree, environment: source.environment }), title: `${source.title} (fork)`, titleAuto: false, detail: "Fork", agentSessionId, model: source.model, effort: source.effort, allowedFolders: source.allowedFolders, worktreeFolder: source.worktreeFolder };
		setSessions((current) => [forked, ...current]);
		setExtraChats((list) => ({ ...list, [forked.id]: copied }));
		if (modes[source.id]) { changeMode(forked.id, modes[source.id]); }
		if (prePlan[source.id]) { setPrePlan((current) => ({ ...current, [forked.id]: prePlan[source.id] })); }
		selectSession(forked.id);
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
			setNotices((list) => list.some((item) => item.text === "Creating the worktree…") ? list.filter((item) => item.text !== "Creating the worktree…") : list);
			if (!result.ok || !result.folder) {
				setNotice(result.error || "The worktree could not be created.");
				return null;
			}
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

	function startWorktreeFromHere() {
		const source = session;
		let target = pendingRef.current;
		if (!target) {
			if (keptForm.current && draftsRef.current[keptForm.current.session.id]) {
				setNotice("Finish or clear the unsent New session draft before starting another worktree.");
				return;
			}
			flushEditor();
			target = { ...newSession({ folder: source.folder, project: source.project, branch: source.branch, worktree: source.worktree, environment: source.environment }), ...(source.model ? { model: source.model } : {}), ...(source.effort ? { effort: source.effort } : {}) };
			const nextDrafts = { ...draftsRef.current, [source.id]: "", [target.id]: draftsRef.current[source.id] ?? "" };
			draftsRef.current = nextDrafts;
			setDrafts(nextDrafts);
			keptForm.current = null;
			pendingRef.current = target;
			setPending(target);
		}
		useWorktreeRef.current = true;
		setUseWorktree(true);
		const targetId = target.id;
		setCollisionSeen((current) => ({ ...current, [source.id]: true, [targetId]: true }));
		setMenu(null);
		setSideOpen(false);
		setTimeout(() => promptRef.current?.focus?.(), 0);
	}

	function startFreshSession() {
		const source = session;
		const created: Session = { ...newSession({ folder: source.folder, project: source.project, branch: source.branch, worktree: source.worktree, environment: source.environment }), ...(source.model ? { model: source.model } : {}), ...(source.effort ? { effort: source.effort } : {}) };
		sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
		setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
		selectSession(created.id);
	}

	// A command picked in Settings, such as /create-skill, goes to this session and leaves its draft alone.
	async function runFromSettings(text: string) {
		setSettingsOpen(null);
		const target = await commitPending();
		if (target) { send(text, false, target.id); }
	}

	function postLocal(text: string, lines: string[]) {
		const sessionId = session.id;
		const stamp = crypto.randomUUID();
		const at = Date.now();
		setExtraChats((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { id: `user-${stamp}`, role: "user", text, at, live: true }, { id: `grok-${stamp}`, role: "grok", text: lines.join("\n"), at, live: true }] }));
		setNotice(lines.join(" · "));
	}

	async function showUsage(text: string) {
		const result = await window.grokCode?.billing?.().catch(() => ({ ok: false as const, error: "Grok did not return usage." }));
		if (result?.ok) { setLimit(result); }
		const lines = result?.ok ? [limitLine(result)] : [result?.error || "Grok did not return usage."];
		const percent = session.usage?.contextWindow ? Math.min(100, Math.round((session.usage.contextTokens / Math.max(1, session.usage.contextWindow)) * 100)) : null;
		if (percent !== null) { lines.push(`Context ${percent}% · $${(session.costUsd ?? 0).toFixed(2)}`); }
		postLocal(text, lines);
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
			const percent = session.usage?.contextWindow ? Math.min(100, Math.round((session.usage.contextTokens / Math.max(1, session.usage.contextWindow)) * 100)) : null;
			const lines = [
				appVersion.current ? `Codewomplers Grok Desktop ${appVersion.current}` : "Codewomplers Grok Desktop",
				`${model} · ${effort} · ${mode}`,
				session.folder,
				...(percent != null ? [`Context ${percent}% · $${(session.costUsd ?? 0).toFixed(2)}`] : []),
			];
			postLocal(text, lines);
			setPrompt("");
			return;
		}
		const local = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text);
		const action = local ? slashActions[local[1]] : undefined;
		if (local && action) {
			const arg = (local[2] ?? "").trim();
			if (arg && !TAKES_ARG.has(local[1])) { setNotice(`/${local[1]} takes no argument.`); return; }
			if (pending && ["rename", "delete", "fork", "rewind", "copy"].includes(local[1])) { setNotice("Send a first message to start this session."); return; }
			setPrompt("");
			await action(arg);
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
		const picks = contextPicks[session.id] ?? [];
		if (send(text, false, target.id, files, true, picks)) {
			setDrafts((current) => ((current[target.id] ?? "") === prompt ? { ...current, [session.id]: "", [target.id]: "" } : current));
			setAttachments((current) => ({ ...current, [session.id]: [], [target.id]: [] }));
			setContextPicks((current) => ({ ...current, [session.id]: [], [target.id]: [] }));
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
		const request = api.signOut;
		void askConfirm({ title: "Sign out of Grok?", body: "This signs Grok out on this computer, in a terminal too. Grok's background commands will stop.", ok: "Sign out", danger: true }).then((yes) => {
			if (!yes) { return; }
			void request().then((result) => setNotice(result.ok ? "Signed out. Grok asks you to sign in when you next send a message." : result.error || "Grok could not sign out."));
		});
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

	function browserAccess(stopped: boolean) {
		const id = session.id;
		const action = stopped ? window.grokCode?.browserStop : window.grokCode?.browserResume;
		if (!action) { setNotice("Reopen this window to change browser access."); return; }
		void action(id).then((result) => {
			if (!result.ok) { setNotice(result.error || "Browser access could not be changed."); return; }
			setBrowserStopped((current) => ({ ...current, [id]: stopped }));
		}).catch(() => setNotice("Browser access could not be changed."));
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
			const href = url.toString();
			void askConfirm({ title: "Where should chat links open?", body: "You can change this in Settings.", ok: "Browser pane", cancel: "Default browser" }).then((inside) => {
				changeSettings({ linkAsked: true, linksInBuiltIn: inside });
				settingsRef.current = { ...settingsRef.current, linkAsked: true, linksInBuiltIn: inside };
				openUrl(href, external);
			});
			return;
		}
		openUrl(url.toString(), external);
	}

	function copyText(text: string, label = "Copied.") {
		const api = window.grokCode;
		if (!api?.copyText) {
			setNotice("Reopen this window to copy.");
			return;
		}
		void api.copyText(text).then((result) => setNotice(result.ok ? label : (result.error || "That could not be copied."), result.ok));
	}

	function exportMarkdown(agentSessionId: string, title: string) {
		const api = window.grokCode;
		if (!api?.exportMarkdown) {
			setNotice("Reopen this window to export.");
			return;
		}
		void api.exportMarkdown({ agentSessionId, title }).then((result) => {
			if (!result || result.cancelled) { return; }
			setNotice(result.ok && result.path ? `Saved ${result.path}` : (result.error || "That session could not be exported."), Boolean(result.ok && result.path));
		}).catch(() => setNotice("That session could not be exported."));
	}

	function knownCliIds() {
		const ids = new Set<string>();
		for (const item of [...sessionsRef.current, ...(readHistory()?.sessions ?? [])]) {
			if (item.agentSessionId) { ids.add(item.agentSessionId); }
		}
		return [...ids];
	}

	function listCliSessions() {
		const api = window.grokCode;
		if (!api?.listCliSessions) { return Promise.resolve({ ok: false, error: "Reopen this window to open a CLI session." }); }
		return api.listCliSessions(knownCliIds());
	}

	function showExistingCli(item: Session) {
		openingCli.current.delete(item.agentSessionId?.toLowerCase() ?? "");
		if (!sessionsRef.current.some((entry) => entry.id === item.id)) {
			setSessions((list) => (list.some((entry) => entry.id === item.id) ? list : [{ ...item, archived: false }, ...list]));
			const messages = readHistory()?.extraChats[item.id];
			if (messages) { setExtraChats((list) => (list[item.id] ? list : { ...list, [item.id]: messages })); }
		} else if (item.archived) {
			updateSession(item.id, { archived: false, pinned: false, lastActivityAt: Date.now() });
		}
		selectSession(item.id);
	}

	function openCliSession(agentSessionId: string) {
		const key = agentSessionId.toLowerCase();
		const existing = sessionsRef.current.find((item) => item.agentSessionId?.toLowerCase() === key) ?? readHistory()?.sessions.find((item) => item.agentSessionId?.toLowerCase() === key);
		if (existing) { showExistingCli(existing); return; }
		const pendingId = openingCli.current.get(key);
		if (pendingId !== undefined) { if (pendingId) { selectSession(pendingId); } return; }
		const api = window.grokCode;
		if (!api?.openCliSession) { setNotice("Reopen this window to open a CLI session."); return; }
		openingCli.current.set(key, "");
		void api.openCliSession(agentSessionId).then((result) => {
			const again = sessionsRef.current.find((item) => item.agentSessionId?.toLowerCase() === key) ?? readHistory()?.sessions.find((item) => item.agentSessionId?.toLowerCase() === key);
			if (again) { showExistingCli(again); return; }
			if (!result?.ok || !result.session?.folder) {
				openingCli.current.delete(key);
				setNotice(result?.error || "That session could not be opened.");
				return;
			}
			const folder = result.session.folder;
			const project = shortPath(folder);
			const created = newSession({ folder, project, branch: result.session.branch || "main", worktree: project, environment: "Local" });
			const opened: Session = {
				...created,
				title: result.session.title || "CLI session",
				titleAuto: false,
				detail: "CLI",
				agentSessionId: result.session.id || agentSessionId,
				...(result.session.model ? { model: result.session.model } : {}),
				...(result.session.effort ? { effort: result.session.effort } : {}),
				lastActivityAt: result.session.lastActive || created.lastActivityAt,
			};
			openingCli.current.set(key, opened.id);
			const messages: ChatMessage[] = (result.messages ?? []).filter((message) => message && (message.role === "user" || message.role === "grok") && typeof message.text === "string").map((message, index) => ({
				id: `cli-${opened.id}-${index}`,
				role: message.role,
				text: message.text,
			}));
			setSessions((list) => (list.some((item) => item.agentSessionId?.toLowerCase() === key || item.id === opened.id) ? list : [opened, ...list]));
			setExtraChats((list) => ({ ...list, [opened.id]: messages }));
			selectSession(opened.id);
			if (result.truncated) { setNotice("Older messages were left out. The next message still continues this Grok session.", true); }
		}).catch(() => {
			openingCli.current.delete(key);
			setNotice("That session could not be opened.");
		});
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
		const generation = terminalGeneration.current;
		const result = await api.terminalOpen({ cwd: folder });
		if (!result.ok || !result.id) {
			setTerminalError(result.error || "The terminal could not start.");
			return "";
		}
		const id = result.id;
		if (generation !== terminalGeneration.current) { void api.terminalClose?.(id); return ""; }
		setTerminalError("");
		setTerminals((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { id, title: title || `Terminal ${(current[sessionId]?.length ?? 0) + 1}`, cwd: folder, running: true, output: "", received: 0, backend: result.backend }] }));
		setActiveTerminal((current) => ({ ...current, [sessionId]: id }));
		return id;
	}

	async function runInTerminal(code: string) {
		showPane("terminal");
		const tabs = (terminals[session.id] ?? []).filter((tab) => tab.backend !== "pty" && tab.running && folderKey(tab.cwd) === folderKey(session.folder) && !Object.values(devTabs).includes(tab.id));
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
	const grokRows = (uiId: string, where: string): BackgroundTask[] => {
		const prefix = where ? `${where} · ` : "";
		const word = (status: string) => ({ running: "Running", completed: "Finished", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[status] ?? status;
		const agents: BackgroundTask[] = (subagents[uiId] ?? []).map((item) => ({ id: `agent-${uiId}-${item.id}`, label: item.label, detail: `${prefix}${["Subagent", item.agentType, item.model, word(item.status)].filter(Boolean).join(" · ")}`, running: item.status === "running", info: { kind: "agent", subagent: item } }));
		const tasks = grokTasks[uiId] ?? [];
		const finished = tasks.filter((task) => task.status !== "running").sort((a, b) => b.endedAt - a.endedAt).slice(0, 20);
		const commands: BackgroundTask[] = [...tasks.filter((task) => task.status === "running"), ...finished].map((task) => ({ id: `task-${uiId}-${task.id}`, label: task.label, detail: `${prefix}${task.kind === "monitor" ? "Monitor" : "Command"} · ${word(task.status)}${task.exitCode !== null && task.status !== "running" ? ` · exit ${task.exitCode}` : ""}`, running: task.status === "running", tooltip: task.command,
			info: { kind: "command", command: task.command, outputFile: task.outputFile || "", exitCode: task.exitCode, startedAt: task.startedAt, endedAt: task.endedAt, status: task.status },
			onStop: task.status === "running" ? () => { void window.grokCode?.killTask?.(uiId, task.id).then((result) => { if (!result.ok) { setNotice(result.error || "Grok could not stop that command."); } }).catch(() => setNotice("Grok could not stop that command.")); } : undefined,
		}));
		return [...agents.filter((row) => row.running), ...commands.filter((row) => row.running), ...agents.filter((row) => !row.running), ...commands.filter((row) => !row.running)];
	};
	const backgroundTasks: BackgroundTask[] = [
		...(busy[session.id] ? [{ id: "turn", label: "Grok is working", detail: "Replying in this session", running: true, onStop: () => stop(session.id) }] : []),
		...(busy[sideId] ? [{ id: "side", label: "Side chat", detail: "Answering a side question", running: true, onStop: () => stop(sideId) }] : []),
		...grokRows(session.id, ""),
		...grokRows(sideId, "Side chat"),
		...(queued[session.id] ?? []).map((item) => ({ id: item.id, label: "Queued message", detail: item.text, running: false })),
		...sessionTerminals.map((tab) => ({ id: tab.id, label: tab.title, detail: tab.cwd, running: tab.running, onStop: () => stopTerminal(tab.id), onOpen: () => { setActiveTerminal((current) => ({ ...current, [session.id]: tab.id })); showPane("terminal"); } })),
	];

	function paneModel(uiId: string, list: ChatMessage[]): PaneModel {
		return {
			session,
			messages: list,
			view,
			findTick,
			findAt: uiId === session.id ? findAt : undefined,
			todos,
			plan: planText,
			tasks: backgroundTasks,
			taskOutput: (file) => window.grokCode?.taskOutput?.(file) ?? Promise.resolve({ ok: false, error: "Reopen this window to read task output." }),
			subagentTranscript: (id) => window.grokCode?.subagentTranscript?.(id) ?? Promise.resolve({ ok: false, error: "Reopen this window to read task output." }),
			busy: !!busy[uiId],
			decide: (toolId, decision) => {
				writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: decision === "deny" ? "Denied" : "Allowed" } : tool)) }));
				void window.grokCode?.decide({ uiSessionId: uiId, toolId, decision }).then((result) => {
					if (result.ok) {
						if (result.warning) { setNotice(result.warning); }
						return;
					}
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
			folderFiles: paneFiles,
			openFile,
			fileMenu: (file, event) => setFileMenu({ file, x: event.clientX, y: event.clientY }),
			openLink,
			copyText: (text) => copyText(text),
			quote: (text) => {
				const quoted = text.trim().split("\n").map((line) => `> ${line}`).join("\n");
				setPrompt((current) => `${current}${current && !current.endsWith("\n") ? "\n\n" : ""}${quoted}\n\n`);
				promptRef.current?.focus?.();
			},
			rewind: (message) => { void startRewind(message); },
			fork: (message) => { void forkAt(message); },
			openImage,
			runInTerminal: (code) => { void runInTerminal(code); },
			closePane: (id) => closePane(id),
			diffView: settings.diffView === "split" ? "split" : "unified",
			setDiffView: (diffView) => changeSettings({ diffView }),
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
	const taskbarState = useMemo(() => {
		const states = Object.values(activity);
		return states.includes("needs-you") ? "needs-you" : states.includes("running") ? "running" : "idle";
	}, [activity]);
	useEffect(() => { void window.grokCode?.taskbar?.(taskbarState); }, [taskbarState]);

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

	function renameSession(id: string, title: string) {
		if (sessionsRef.current.find((item) => item.id === id)?.title !== title) { updateSession(id, { title, titleAuto: false }); }
	}

	function deleteSession(id: string) {
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
		setGrokTasks((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id && key !== `side-${id}`)));
		setSubagents((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id && key !== `side-${id}`)));
		setLoops((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id && key !== `side-${id}`)));
	}

	// Archives, or unarchives, a session. Archiving stops its Grok; the sidebar asks first when that would stop work.
	function archiveSession(id: string, target: Session | undefined) {
		if (target && !target.archived && target.worktreeFolder && window.grokCode?.removeWorktree && !sharesFolder(target)) {
			setHeld((current) => ({ ...current, [id]: true }));
			void window.grokCode.removeWorktree(target.folder, target.worktreeFolder, { force: false }).then(async (result) => {
				if (result.ok) { updateSession(id, { archived: true, pinned: false }); return; }
				if (result.dirty && await askConfirm({ title: "Archive this session?", body: result.ignored?.length ? `This worktree has files git ignores that removal would delete: ${result.ignored.join(", ")}. The worktree stays on disk.` : "This session's worktree has uncommitted changes. The worktree stays on disk.", ok: "Archive anyway", danger: true })) { updateSession(id, { archived: true, pinned: false }); return; }
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
	}

	const usage = session.usage;
	// The context split and the week's spend are read from Grok's files, and the usage limit from Grok (a one-shot Grok when none is running), when a turn ends or the session changes.
	const agentId = session.agentSessionId ?? "";
	const idle = !busy[session.id];
	useEffect(() => {
		if (!idle) { return; }
		const api = window.grokCode;
		void api?.recentSpend?.().then((result) => { if (result.ok && result.usd != null) { setRecentUsd(result.usd); } });
		// A failed read keeps the last limit shown; before any Grok runs there is none.
		void api?.billing?.().then((result) => { if (result.ok) { setLimit(result); } }).catch(() => {});
		if (!agentId) { return; }
		void api?.contextBreakdown?.(agentId).then((result) => {
			if (result.ok && result.parts) { setBreakdown({ id: agentId, parts: result.parts, autoCompactPercent: result.autoCompactPercent ?? 85 }); }
		});
	}, [agentId, idle]);
	const queue = queued[session.id] ?? [];
	const files = attachments[session.id] ?? [];
	const chatChoices = contextChoices(sessions, session.id);
	const chosenChats = contextPicks[session.id] ?? [];
	const isBusy = !!busy[session.id];
	const suggestion = settings.promptSuggestions && !prompt && !isBusy && !pending ? suggestions[session.id] ?? "" : "";
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
					onRefresh={() => { setDiffTick((value) => value + 1); setRemoteTick((value) => value + 1); }}
					busy={isBusy}
					onCommit={async (input) => {
						const commit = window.grokCode?.gitCommit;
						const result: WriteResult & { message?: string; committed?: boolean; sha?: string } = commit ? await commit(session.folder, { ...input, expected: branches[session.id]?.branch }).catch(() => ({ ok: false, error: "The commit could not be checked. Refresh to see what happened." })) : { ok: false, error: "Reopen this window to commit." };
						setNotice(result.ok ? result.message || "Committed." : result.error || "The commit could not be checked. Refresh to see what happened.", result.ok);
						return result;
					}}
					onRevert={(file) => {
						const api = window.grokCode;
						if (!api?.revertFile) { return Promise.resolve({ ok: false, error: "Reopen this window to restore this file." }); }
						return api.revertFile(session.folder, file).then((result) => {
							if (result.ok) { setDiffTick((value) => value + 1); setFileTick((value) => value + 1); }
							return result;
						}).catch(() => ({ ok: false, error: "That file could not be restored." }));
					}}
					onRevertHunk={(file, hunk) => {
						const api = window.grokCode;
						if (!api?.revertHunk) { return Promise.resolve({ ok: false, error: "Reopen this window to revert this change." }); }
						return api.revertHunk(session.folder, file, hunk).then((result) => {
							if (result.ok) { setFileTick((value) => value + 1); }
							return result;
						}).catch(() => ({ ok: false, error: "That change could not be reverted." }));
					}}
					comments={diffComments}
					viewed={viewed[session.id] ?? {}}
					onViewed={(file, fingerprint) => setViewed((current) => {
						const mine = { ...(current[session.id] ?? {}) };
						if (fingerprint) { mine[file] = fingerprint; } else { delete mine[file]; }
						return { ...current, [session.id]: mine };
					})}
					onAddComment={(comment) => setComments((current) => ({ ...current, [session.id]: [...(current[session.id] ?? []), { ...comment, id: crypto.randomUUID() }] }))}
					onRemoveComment={(commentId) => setComments((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((item) => item.id !== commentId) }))}
					onSendComments={() => {
						if (!diffComments.length) { return; }
						const text = `Comments on the diff:\n\n${diffComments.map((item) => `- ${item.file}:${item.line}${item.side === "old" ? " (old side, before the change)" : ""} — ${item.text}`).join("\n")}`;
						if (send(text, false)) { setComments((current) => ({ ...current, [session.id]: [] })); }
					}}
					onAskGrok={(text) => { if (send(text, false)) { setNotice("Asked Grok to commit.", true); } }}
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
					docKey={editorKey}
					fileTypes={settings.editorFileTypes}
					files={modelForPanes.folderFiles}
					file={editorFile}
					onSelectFile={(file) => openFile(file)}
					onLink={openLink}
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
						const api = window.grokCode;
						const send = sessionTerminals.find((tab) => tab.id === tabId)?.backend === "pty" ? api?.terminalInput : api?.terminalWrite;
						void send?.(tabId, text).then((result) => { if (!result.ok) { setTerminalError(result.error || "That input could not be sent."); } });
					}}
					onResize={(tabId, cols, rows) => {
						void window.grokCode?.terminalResize?.(tabId, cols, rows).then((result) => { if (!result.ok) { setTerminalError(result.error || "The terminal could not resize."); } });
					}}
					onInterrupt={(tabId) => {
						void window.grokCode?.terminalInterrupt?.(tabId).then((result) => {
							if (!result.ok) { setTerminalError(result.error || "The running command could not be stopped."); return; }
							if (!result.stopped) { setNotice(`Nothing to stop. A ${PLATFORM === "win32" ? "PowerShell" : "bash"} command that starts no program stops only when you close the tab.`); }
						});
					}}
					onClose={() => closePane("terminal")}
				/>
			);
		} else if (id === "browser") {
			body = (
				<BrowserPane
					key={session.id}
					uiSessionId={session.id}
					controlEnabled={settings.browserControl}
					controlStopped={browserStopped[session.id] ?? false}
					controlActivity={browserActivity[session.id]}
					onStopControl={() => browserAccess(true)}
					onResumeControl={() => browserAccess(false)}
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
					onClearData={() => { void Promise.all(["persist:grok-code", "temp:grok-code"].map((partition) => window.grokCode?.clearBrowsingData?.(partition))).then((results) => { const failed = results.find((result) => result && !result.ok); setNotice(failed ? (failed.error || "Browsing data could not be cleared.") : "Browsing data cleared.", !failed); }); }}
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
					onProblem={(tabId, problem) => setBrowserTabs((current) => ({ ...current, [session.id]: (current[session.id] ?? []).map((tab) => tab.id === tabId ? { ...tab, problems: addProblem(tab.problems ?? [], problem) } : tab) }))}
					onClearProblems={(tabId) => setBrowserTabs((current) => ({ ...current, [session.id]: (current[session.id] ?? []).map((tab) => tab.id === tabId ? { ...tab, problems: [] } : tab) }))}
					onDiagnostics={(text) => {
						setPrompt((current) => `${current}${current ? "\n\n" : ""}${text}`);
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
		const startWidth = paneWidth;
		let width = startWidth;
		const move = (moveEvent: globalThis.MouseEvent) => {
			width = Math.min(Math.max(startWidth - (moveEvent.clientX - startX), 320), sideCap(window.innerWidth, settings.sidebarCollapsed || shouldCollapseSidebar(window.innerWidth, panes.length > 0)));
			if (sideCol.current) { sideCol.current.style.width = `${width}px`; }
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			if (width !== startWidth) { changeSettings({ sideWidth: width }); }
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	const contextPercent = usage ? Math.min(100, Math.round((usage.contextTokens / Math.max(1, usage.contextWindow)) * 100)) : null;
	const limitLeft = limit && limit.percent !== null ? Math.max(0, Math.round(100 - limit.percent)) : null;
	const limitName = limit?.period ? `${limit.period[0].toUpperCase()}${limit.period.slice(1)}` : "Limit";
	const limitTitle = limit ? limitLine(limit) : "Grok's usage limit isn't available.";
	const showFolderWarn = !collisionSeen[session.id] && folderBusy(session);
	// shortcut: the disconnect choice is the main chat only; a side-chat exit keeps its error text
	const lastGrok = [...messages].reverse().find((message) => message.role === "grok" && !message.pending);
	const showDisconnect = !pending && session.failed === true && !busy[session.id] && !!lastGrok?.text.split("\n").some((line) => line.startsWith("Grok exited."));

	return (
		<div className={sidebarCollapsed ? "app collapsed" : "app"}>
			{(menu || fileMenu) && <button className="backdrop" aria-label="Close menu" onClick={() => { setMenu(null); setFileMenu(null); }} />}
			{!sidebarCollapsed && (
				<Sidebar
					sessions={sessions}
					chats={extraChats}
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
						const working = busy[id] || busy[`side-${id}`] || [...(grokTasks[id] ?? []), ...(grokTasks[`side-${id}`] ?? [])].some((task) => task.status === "running") || [...(subagents[id] ?? []), ...(subagents[`side-${id}`] ?? [])].some((agent) => agent.status === "running");
						if (target && !target.archived && working) {
							void askConfirm({ title: "Archive this session?", body: "Grok is still working in this session. Archiving stops the turn and any background commands.", ok: "Archive and stop", danger: true }).then((yes) => { if (yes) { archiveSession(id, target); } });
							return;
						}
						archiveSession(id, target);
					}}
					onRename={renameSession}
					onDelete={deleteSession}
					onMarkUnread={(id, unread) => updateSession(id, { unread })}
					onMarkCompleted={(id, completed) => updateSession(id, { completed })}
					onMove={(id, sectionId) => updateSession(id, { sectionId })}
					onOpenWindow={openSessionWindow}
					onCopySessionId={(id) => copyText(id, "Grok session ID copied.")}
					onExportMarkdown={exportMarkdown}
					onListCliSessions={listCliSessions}
					onOpenCliSession={openCliSession}
					loopCounts={Object.fromEntries(sessions.map((item) => [item.id, (loops[item.id]?.length ?? 0) + (loops[`side-${item.id}`]?.length ?? 0)]))}
					onSettings={() => setSettingsOpen("general")}
					onCollapse={() => changeSettings({ sidebarCollapsed: true })}
					onNotice={setNotice}
					account={account}
					signIn={setup.result?.grok.ok ? setup.result.grok.signIn : undefined}
					recentUsd={recentUsd}
					onShortcuts={() => setShortcuts(true)}
					onOpenUrl={(url) => openUrl(url, true)}
					onSignOut={signOut}
					update={update}
					onUpdate={() => { void openUpdate(update); }}
				/>
			)}
			<main className="workspace">
				<header className="topbar">
					{sidebarCollapsed && <button className="icon-btn" aria-label="Show sidebar" title={shouldCollapseSidebar(windowWidth, panes.length > 0) ? "Show sidebar and return to chat" : "Show sidebar"} onClick={() => {
						if (shouldCollapseSidebar(windowWidth, panes.length > 0)) {
							if (panes.includes("editor")) { flushEditor(); }
							setPanes([]);
							setFocusedPane(null);
						}
						if (settings.sidebarCollapsed) { changeSettings({ sidebarCollapsed: false }); }
					}}>☰</button>}
					<div className="session-title">
						{renaming === session.id ? (
							<input
								className="title-input"
								aria-label="Session title"
								autoFocus
								defaultValue={session.title}
								onBlur={(event) => { const title = event.target.value.trim(); if (title && !pending) { renameSession(session.id, title); } setRenaming(null); }}
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
							<button type="button" className="item" onClick={() => openIn("explorer")}>{FILE_MANAGER}</button>
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
							<button type="button" className="item" onClick={() => { setShortcuts(true); setMenu(null); }}>Keyboard shortcuts<small>{keyLabel("Ctrl+/")}</small></button>
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
								{session.prWatch?.alert && <div className="queue pr-alert">
									<span>{prAlertText(session.prWatch.number, session.prWatch.alert)}</span>
									<button className="texty" onClick={askGrokToFix}>Ask Grok to fix</button>
										<button className="texty" aria-label="Dismiss pull request alert" onClick={dismissPrAlert}>×</button>
									</div>}
								{queue.length > 0 && (
									<div className="queue">
										{held[session.id] && <p className="note">Held until you press Send now or send a new message.</p>}
										{queue.map((item) => (
											<div className="queued" key={item.id}>
												<span>{item.text}{item.contextFrom?.length ? ` · ${item.contextFrom.map((pick) => pick.title).join(", ")}` : ""}</span>
												{busy[session.id] && !held[session.id] && !item.attachments.length && !item.contextFrom?.length && !item.text.trim().startsWith("/") && <button className="texty" onClick={() => void steerQueued(item)}>Steer</button>}
												<button className="texty" onClick={() => sendNow(session.id, item.id)}>Send now</button>
												<button className="texty" onClick={() => editQueued(item)}>Edit</button>
												<button className="texty" aria-label="Remove queued message" onClick={() => setQueued((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((entry) => entry.id !== item.id) }))}>×</button>
											</div>
										))}
									</div>
								)}
								{(contextPicks[session.id] ?? []).length > 0 && (
									<div className="attach-list">
										{(contextPicks[session.id] ?? []).map((pick) => (
											<span className="attach-chip" key={pick.id} title={`Earlier context from ${pick.title}`}>
												{pick.title}
												<button type="button" aria-label={`Remove context from ${pick.title}`} onClick={() => setContextPicks((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((item) => item.id !== pick.id) }))}>×</button>
											</span>
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
								{showFolderWarn && (
									<div className="folder-warn">
										<p>Another session is working in this folder, so edits can collide.</p>
										<button type="button" className="texty" onClick={startWorktreeFromHere}>Start a worktree</button>
									</div>
								)}
								{showDisconnect && (
									<div className="disconnect-choice">
										<p>Grok disconnected. The next message continues this conversation. New session starts fresh in this folder.</p>
										<button type="button" className="texty" onClick={() => promptRef.current?.focus?.()}>Resume</button>
										<button type="button" className="texty" onClick={startFreshSession}>New session</button>
									</div>
								)}
								{(loops[session.id] ?? []).map((loop) => {
									const at = Date.parse(loop.nextFireAt);
									const when = loop.nextFireAt && Number.isFinite(at) ? new Date(at).toLocaleString() : "";
									return <p className="loop-line" key={loop.id}>{loop.prompt} · {loop.schedule || "interval unknown"} · {when ? `next ${when}` : "next run unknown"}</p>;
								})}
								<textarea
									ref={promptRef}
									aria-label="Prompt"
									rows={2}
									placeholder={suggestion ? `${suggestion}   (Tab to use)` : isBusy ? "Steer Grok while it works" : pending ? "Describe a task to start a new session" : "Reply to Grok, or type / for commands and @ to mention files"}
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
										if (suggestion && event.key === "Tab" && !event.shiftKey) { event.preventDefault(); setPrompt(suggestion); return; }
										if (event.key === "Escape") {
											invalidateSuggestion(session.id);
											if (suggestion) { event.preventDefault(); event.stopPropagation(); return; }
										}
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
									<MenuButton label={mode} title={keyLabel("Permission mode (Ctrl+Shift+M)")} open={menu === "mode"} onClick={() => setMenu(menu === "mode" ? null : "mode")} />
									<span className="spacer" />
									<span className={`limit-meter${limitLeft === null ? "" : limitLeft <= 10 ? " high" : limitLeft <= 25 ? " warn" : ""}`} title={limitTitle} aria-label={limitTitle}>{limitLeft === null ? "Limit" : `${limitName} - ${limitLeft}% left`}</span>
									{contextPercent !== null && <span className="usage-ring" title={`Context about ${contextPercent}% used · session cost $${(session.costUsd ?? 0).toFixed(2)}${recentUsd !== null ? `\nGrok, last 7 days on this computer: $${recentUsd.toFixed(2)}` : ""}`} style={{ ["--pct" as string]: `${contextPercent}` }} aria-label={`Context ${contextPercent}% used`} />}
									<MenuButton label={`${baseModel}${fastOn ? " · fast" : ""} · ${effort}`} title={keyLabel("Model (Ctrl+Shift+I) and effort (Ctrl+Shift+E)")} open={menu === "model" || menu === "effort"} onClick={() => setMenu(menu === "model" ? null : "model")} />
									<button
										type="button"
										className={sendLabel === "Stop" ? "send-btn stop" : "send-btn"}
										aria-label={sendLabel}
										title={sendLabel === "Stop" ? "Stop (Esc)" : isBusy ? (prompt.trim().startsWith("/") || files.length || chosenChats.length ? "Queue (Enter)" : "Steer (Enter)") : "Send (Enter)"}
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
										<button type="button" className="item" onClick={() => openPromptLibrary("insert")}>Saved prompts<small>{keyLabel("Search and insert without sending (Ctrl+Shift+P)")}</small></button>
										<button type="button" className="item" disabled={!prompt.trim()} onClick={() => openPromptLibrary("save")}>Save current prompt</button>
										<button type="button" className="item" onClick={() => setMenu("context")}>Context from another chat<small>Up to three earlier chats, labelled as context.</small></button>
										<button type="button" className="item" onClick={() => { setSettingsOpen("skills"); setMenu(null); }}>Skills and tools<small>{servers.length ? `${servers.length} MCP servers from Grok` : "Managed in Grok's configuration"}</small></button>
										{!!session.allowedFolders?.length && <div className="menu-label">Added folders</div>}
										{session.allowedFolders?.map((folder) => <div className="item" key={folder}>{folder}</div>)}
									</div>
								)}
								{menu === "context" && (
									<div className="pop up" role="menu" aria-label="Earlier chats">
										{chatChoices.length === 0 && <div className="item">No other chats yet.</div>}
										{chatChoices.map((item) => {
											const added = chosenChats.some((pick) => pick.id === item.id);
											return (
												<button key={item.id} type="button" className="item" disabled={added || chosenChats.length >= CONTEXT_PICK_LIMIT} onClick={() => { setContextPicks((current) => ({ ...current, [session.id]: addContextPick(current[session.id] ?? [], item) })); setMenu(null); }}>
													{item.title}
													{item.archived && <small>Archived</small>}
													{added && <small>Added</small>}
												</button>
											);
										})}
										{chosenChats.length >= CONTEXT_PICK_LIMIT && <div className="item">Three chats is the limit.</div>}
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
										<button type="button" className="item" onClick={() => openIn("explorer")}>Open in {FILE_MANAGER}</button>
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
													const update = (item: Session) => (item.id === sessionId ? { ...item, folder: picked, project: name, worktree: name, agentSessionId: undefined, allowedFolders: undefined, prWatch: undefined } : item);
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
													setMenu(null);
												}}
											>
												{item.id}
												<small>{item.detail}</small>
												{restartStops(item.id) > 0 && <small className="mode-warn">Restarts Grok and stops {restartStops(item.id)} running background {restartStops(item.id) === 1 ? "task" : "tasks"}.</small>}
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
							{notices.map((item) => <div key={item.id} className="note composer-note" role="status">{item.text}<button type="button" className="texty" aria-label="Dismiss" onClick={() => setNotices((list) => list.filter((entry) => entry.id !== item.id))}>×</button></div>)}
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
							<div className="side-col" ref={sideCol} style={{ width: paneWidth }}>
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
					<button type="button" role="menuitem" onClick={() => { void window.grokCode?.reveal(session.folder, fileMenu.file).then((result) => { if (!result.ok) { setNotice(result.error || "That file is not in this folder."); } }); setFileMenu(null); }}>Show in {FILE_MANAGER}</button>
					<div className="menu-label">Copy</div>
					<button type="button" role="menuitem" onClick={() => { copyText(PLATFORM === "win32" ? `${session.folder.replace(/[\\/]+$/, "")}\\${fileMenu.file.replace(/\//g, "\\")}` : `${session.folder.replace(/\/+$/, "")}/${fileMenu.file}`, "Copied the absolute path."); setFileMenu(null); }}>Absolute path</button>
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
								<li key={`${key}-${label}`}><span>{label}</span><kbd>{keyLabel(key)}</kbd></li>
							))}
						</ul>
						<button className="texty" onClick={() => setShortcuts(false)}>Close</button>
					</div>
				</div>
			)}
			{rewindAsk && (
				<div className="overlay" onClick={() => setRewindAsk(null)}>
					<div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Rewind to before this message?">
						<h2>Rewind to before this message?</h2>
						<p>Rewinding the conversation removes this message and everything after it, and puts this prompt back in the prompt box.</p>
						<p>Restoring files undoes files Grok changed. Files only keeps the conversation as it is.</p>
						<div style={{ maxHeight: "50vh", overflow: "auto", overflowWrap: "anywhere" }}>
							{rewindAsk.files.length > 0 ? <><p>Files Grok would restore:</p><ul>{rewindAsk.files.map((file) => {
								const base = folderKey(session.folder);
								const label = folderKey(file).startsWith(`${base}/`) ? file.replace(/\\/g, "/").slice(base.length + 1) : file;
								return <li key={file}><code>{label}</code></li>;
							})}</ul></> : <p>No files would be restored.</p>}
							{rewindAsk.conflicts.length > 0 && <div style={{ color: "var(--amber)" }}><p>These files changed outside Grok. Restoring files overwrites those edits:</p><ul>{rewindAsk.conflicts.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>}
						</div>
						<div className="actions" style={{ flexWrap: "wrap", marginTop: 16 }}>
							{rewindAsk.files.length > 0 ? <>
								<button type="button" className="yes" onClick={() => void finishRewind("all")}>Rewind conversation and files</button>
								<button type="button" className="texty" onClick={() => void finishRewind("conversation_only")}>Conversation only</button>
								<button type="button" className="texty" onClick={() => void finishRewind("files_only")}>Files only</button>
							</> : <button type="button" className="yes" onClick={() => void finishRewind("conversation_only")}>Rewind conversation</button>}
							<button type="button" className="texty" autoFocus onClick={() => setRewindAsk(null)}>Cancel</button>
						</div>
					</div>
				</div>
			)}
			{promptLibrary && <SavedPromptPicker prompts={settings.savedPrompts} draft={promptLibrary.text} mode={promptLibrary.mode} onSave={savePrompt} onInsert={insertPrompt} onClose={closePromptLibrary} />}
			{settingsOpen && <SettingsPage settings={settings} onChange={changeSettings} onClose={() => setSettingsOpen(null)} onCheckSetup={() => { setSettingsOpen(null); checkSetup(); }} servers={servers} folder={session.folder} onRun={(text) => void runFromSettings(text)} initialTab={settingsOpen} />}
			{setup.open && <Setup result={setup.result} checking={setup.checking} installing={setup.installing} onInstallGrok={() => void runInstall("grok")} onInstallGit={() => void runInstall("git")} onUpdateGrok={() => void runInstall("update")} onCheck={() => checkSetup()} onCopy={(text) => void copyText(text)} onClose={() => setSetup((current) => ({ ...current, open: false }))} />}
			{confirms[0] && (
				<div key={confirms[0].id} className="overlay confirm-overlay">
					<div className="sheet" role="alertdialog" aria-modal="true" aria-label={confirms[0].title}>
						<h2>{confirms[0].title}</h2>
						{confirms[0].body && <p className="confirm-body">{confirms[0].body}</p>}
						<div className="actions" style={{ marginTop: 16 }}>
							<button type="button" className="yes" autoFocus={!confirms[0].danger} onClick={() => answerConfirm(true, confirms[0].id)}>{confirms[0].ok}</button>
							<button type="button" className="texty" autoFocus={!!confirms[0].danger} onClick={() => answerConfirm(false, confirms[0].id)}>{confirms[0].cancel ?? "Cancel"}</button>
						</div>
					</div>
				</div>
			)}
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
