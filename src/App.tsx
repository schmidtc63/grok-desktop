import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type SetStateAction } from "react";
import { caseKey, FILE_MANAGER, keyLabel, modKey, PLATFORM, SHORTCUTS } from "./data";
import { addContextPick, CONTEXT_PICK_LIMIT, contextChoices, contextForGrok, contextPicksFrom, contextSnapshot, type ContextPick } from "./context-from-chat";
import { BrowserPane, type BrowserTab, type DevServer } from "./BrowserPane";
import { addProblem } from "./browserDiagnostics";
import { chooseVariant, defaultVariant, sameCloudParams } from "./cloud-models";
import { askConfirm, setConfirmHost, type PendingConfirm } from "./confirm";
import { DiffPane, type DiffComment, type PrInfo } from "./DiffPane";
import { FilesPane } from "./FilesPane";
import { GrokBotView } from "./GrokBotView";
import { GrokBotWindow } from "./GrokBotWindow";
import { useGrokBot } from "./grok-bot";
import { Icon, type IconName } from "./Icon";
import type { PaneLayoutControls } from "./PaneActions";
import { AppNote, PaneView, SideLog, type BackgroundTask, type EditorDraft, type FolderFiles, type OpenFile, type PaneModel } from "./Panes";
import { PopupMenu } from "./PopupMenu";
import { prAlertText, prFixPrompt, prWatchStep } from "./prWatch";
import { redactKeys } from "./redact";
import { SessionRail } from "./SessionRail";
import { Setup } from "./Setup";
import { sandboxActive, sandboxChanging, sandboxChipLabel, sandboxFor, sandboxProfileChanging, sandboxWanted } from "./sandbox";
import { SandboxSettings } from "./SandboxSettings";
import { RoutinesPage } from "./Routines";
import { DEFAULT_SETTINGS, normalizeCursorMachines, readSettings, settingsKey, SettingsPage, WORKTREE_ARCHIVE_NOTE, type AppSettings, type SettingsTab } from "./Settings";
import { Sidebar } from "./Sidebar";
import { readSidebarSections, readSidebarView, sidebarSessionIds } from "./sidebar-order";
import { SavedPromptPicker } from "./SavedPromptPicker";
import { insertSavedPrompt, MAX_PROMPT_TEXT, MAX_SAVED_PROMPTS, promptNameError } from "./saved-prompts";
import { TerminalPane, type TerminalTab } from "./TerminalPane";
import { applyUiConfig, uiConfigCss, type UiTheme } from "./ui-config";
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
	type CursorModel,
	type CursorVariant,
	type Environment,
	mapMode,
	type PermissionMode,
	type ProjectSeed,
	type Session,
	type SidePaneId,
	type TranscriptView,
	validMachineName,
} from "./types";

type Menu = string | null;
type ColumnWidth = "sidebarWidth" | "railWidth" | "sideWidth";
type ConfirmItem = PendingConfirm & { id: number };
type Notice = { id: number; text: string };
type BackgroundWork = Record<string, { tasks: GrokBgTask[]; agents: GrokSubagent[] }>;
type ChangeRead = { id: string; key: string; patch: boolean };
type ChangePatch = { key: string; loading: boolean; file?: DiffFile; error?: string; full?: boolean };

const historyKey = "grok-code.history.v1";
const PR_POLL_MS = 180000;
const ESCAPE_STOP_GRACE_MS = 500;
const SIDEBAR_MIN = 200;
const RAIL_MIN = 240;
const COLUMN_MAX = 420;
const PANE_MIN = 320;
const PANE_SPLITTER_WIDTH = 6;
const PANE_ORDER = [...PANES, ...MENU_PANES].map((pane) => pane.id);
const PANE_SPLIT_MIN = 25;
const PANE_SPLIT_MAX = 75;
const RAIL_CHAT_MIN = 560;
const commandsKey = "grok-code.commands.v1";
const COMMAND_GROUPS = ["App", "Grok", "Skills"] as const;
type CommandGroup = typeof COMMAND_GROUPS[number];
const accountKey = "grok-code.account.v1";
const SIDE_BUSY = "The side chat is still answering. Wait for it to finish.";
const CLOUD_ATTACHMENTS = "Cloud sessions can't take attachments yet.";
const WINDOWS_SANDBOX_WORKTREE = "Worktree sessions can't run in a sandbox on Windows yet. Turn Sandbox off to use one.";
const WINDOWS_WORKTREE_SANDBOX = "Worktree sessions can't run in a sandbox on Windows yet. Turn Worktree off to use one.";
const MACHINE_REF_ERROR = "A machine session can't use this branch name. Switch the folder to a branch whose name has only letters, digits, dots, dashes, underscores and slashes.";
const CLOUD_APP_COMMANDS = new Set(["config", "status", "info", "new", "rename", "delete", "copy", "find", "transcript", "expand", "model", "cd", "resume", "help", "theme"]);
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
	newSessionDraft?: { session: Session; useWorktree: boolean; text: string; attachments?: string[] };
	deleted: string[];
	allDeleted?: string[];
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
	background?: boolean;
	finished?: boolean;
	toolIds?: Set<string>;
	awaitingReplay?: boolean;
	hasReply?: boolean;
	announcedWaiting?: Set<string>;
}

function maskDisplay<T extends object>(value: T, ...fields: (keyof T)[]): T {
	let result = value;
	for (const field of fields) {
		const text = value[field];
		if (typeof text !== "string") { continue; }
		const masked = redactKeys(text);
		if (masked !== text) { result = { ...result, [field]: masked }; }
	}
	return result;
}

function maskChat(message: ChatMessage): ChatMessage {
	return {
		...maskDisplay(message, "text", "thought", "appNote"),
		contextFrom: message.contextFrom?.map((pick) => maskDisplay(pick, "title")),
		parts: message.parts?.map((part) => part.kind === "tool" ? part : maskDisplay(part, "text")),
		tools: message.tools?.map((tool) => ({
			...maskDisplay(tool, "title", "detail", "summary", "label", "description", "command", "input", "output", "plan", "commandPrefix"),
			diff: tool.diff && maskDisplay(tool.diff, "oldText", "newText"),
			questions: tool.questions?.map((question) => ({ ...maskDisplay(question, "header", "question"), options: question.options.map((option) => maskDisplay(option, "label", "description")) })),
			todos: tool.todos?.map((todo) => maskDisplay(todo, "text")),
		})),
	};
}

function deletionIds(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function readHistory(onInvalid?: (raw: string) => void, includeEmpty = false): History | null {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(historyKey);
		if (raw === null) { return null; }
		const value = JSON.parse(raw);
		if (!value || !Array.isArray(value.sessions) || value.sessions.some((item: Session) => !item || typeof item.id !== "string" || typeof item.folder !== "string")) { throw new Error("Invalid chat history."); }
		const draft = value.newSessionDraft;
		const draftAttachments = Array.isArray(draft?.attachments) ? draft.attachments.filter((file: unknown) => typeof file === "string") : [];
		const newSessionDraft = draft && typeof draft.text === "string" && (draft.text || draftAttachments.length) && typeof draft.session?.id === "string" && typeof draft.session?.folder === "string" ? { ...draft, attachments: draftAttachments.length ? draftAttachments : undefined } : undefined;
		if (!includeEmpty && !value.sessions.length && !newSessionDraft) { return null; }
		const modes = Object.fromEntries(Object.entries(value.modes ?? {}).map(([id, mode]) => [id, mapMode(String(mode)) ?? "Normal"]));
		const prePlan = Object.fromEntries(Object.entries(value.prePlan ?? {}).map(([id, mode]) => [id, mapMode(String(mode)) ?? "Normal"]).filter(([, mode]) => mode !== "Plan"));
		const queued: Record<string, Queued[]> = {};
		for (const [id, items] of Object.entries(value.queued ?? {})) {
			if (!Array.isArray(items)) { continue; }
			const valid: Queued[] = items.filter((item: Queued) => item && typeof item.id === "string" && typeof item.text === "string" && item.text.trim() && Array.isArray(item.attachments) && item.attachments.every((file) => typeof file === "string"));
			if (valid.length) { queued[id] = valid.map((item) => item.contextFrom?.length ? { ...item, contextFrom: item.contextFrom.map((pick) => maskDisplay(pick, "title")) } : item); }
		}
		const attachments = Object.fromEntries(Object.entries(value.attachments ?? {}).filter(([, files]) => Array.isArray(files) && files.length && files.every((file) => typeof file === "string"))) as Record<string, string[]>;
		const backgroundWork: BackgroundWork = {};
		for (const [id, entry] of Object.entries(value.backgroundWork ?? {})) {
			const work = entry as BackgroundWork[string] | null;
			if (!work || !Array.isArray(work.tasks) || !Array.isArray(work.agents)) { continue; }
			const valid = (item: GrokBgTask | GrokSubagent) => item && typeof item.id === "string" && typeof item.status === "string" && item.status !== "running";
			backgroundWork[id] = {
				tasks: recentTasks(work.tasks.filter(valid)).map((task) => maskDisplay(task, "label", "command")),
				agents: recentAgents(work.agents.filter(valid)).map((agent) => maskDisplay(agent, "label", "output")),
			};
		}
		const extraChats = Object.fromEntries(Object.entries<ChatMessage[]>(value.extraChats ?? {}).map(([id, messages]) => [id, messages.map(maskChat)]));
		const sessions = (value.sessions as Session[]).map((session) => maskDisplay(session, "title", "detail"));
		return { sessions, extraChats, modes, prePlan, editorDrafts: value.editorDrafts ?? {}, composerDrafts: value.composerDrafts ?? {}, queued, attachments, backgroundWork, newSessionDraft, deleted: deletionIds(value.deleted), allDeleted: deletionIds(value.allDeleted) };
	} catch {
		if (raw !== null) { onInvalid?.(raw); }
		return null;
	}
}

const INTERRUPTED_NOTE = "Interrupted when this window closed.";

function missingFolderError(error?: string) {
	return !!error && /^(That folder is not on this computer:|That path is not a folder:|Choose a folder for this session\.$)/.test(error);
}

function replyWithNote(message: ChatMessage, note: string, separator = "\n"): ChatMessage {
	const appNote = redactKeys(note);
	return { ...message, pending: false, streaming: false, text: `${message.text}${message.text ? separator : ""}${appNote}`, appNote };
}

function withTool(message: ChatMessage, incoming: GrokToolEvent): ChatMessage {
	const tools = message.tools ? [...message.tools] : [];
	const toolIndex = tools.findIndex((tool) => tool.id && tool.id === incoming.id);
	let parts = message.parts;
	if (toolIndex >= 0) {
		const previous = tools[toolIndex];
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
			...incoming,
			kind: incoming.kind || "tool",
			title: incoming.title || "Tool",
			detail: incoming.detail || "Not run",
		});
		if (incoming.id) { parts = [...(message.parts ?? []), { kind: "tool", id: incoming.id }]; }
	}
	return { ...message, pending: false, tools, parts };
}

function restoredChats(store: Record<string, ChatMessage[]>, sessions: Session[] = []) {
	const byId = new Map(sessions.map((item) => [item.id, item]));
	return Object.fromEntries(Object.entries(store).map(([id, messages]) => [id, messages.map((message): ChatMessage => {
		const legacyNote = message.role === "grok" ? /(?:^|\n)((?:That folder is not on this computer:|That path is not a folder:|Grok exited\.|Interrupted when this window closed\.)[^\n]*)$/.exec(message.text)?.[1] : undefined;
		const appNote = typeof message.appNote === "string" ? message.appNote : legacyNote;
		const lastPart = message.parts?.at(-1);
		const parts = legacyNote && !message.appNote && lastPart?.kind === "text" && lastPart.text.trim() === legacyNote ? message.parts?.slice(0, -1) : message.parts;
		const restored = { ...message, appNote, parts, pending: false, streaming: false };
		const interrupted = message.pending || message.streaming;
		const session = byId.get(id);
		if (session?.environment === "Cloud") {
			const active = session.cloud?.active && message.id === `grok-${session.cloud.turnId}`;
			if (!interrupted || active || message.role !== "grok") { return restored; }
			const warning = "Interrupted when this window closed. The Cloud agent may have started; check [Cursor agents](https://cursor.com/agents) before sending again.";
			return replyWithNote(restored, warning, "\n\n");
		}
		return {
			...(interrupted ? replyWithNote(restored, INTERRUPTED_NOTE) : restored),
			tools: message.tools?.map((tool) => {
				const legacyBackground = (tool.kind === "command" || tool.kind === "execute") && /^\[bg\]\s/.test(tool.title);
				if (session?.environment === "Local" && tool.detail === "Running" && (tool.backgroundTask || legacyBackground)) {
					return { ...tool, detail: "Stopped", waiting: false };
				}
				return tool.waiting ? { ...tool, waiting: false, detail: "Approval closed with the previous window." } : tool;
			}),
		};
	})]));
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
	return Object.fromEntries(Object.entries(store).map(([id, messages]) => [id, messages.map((raw) => {
		const message = maskChat(raw);
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
const HISTORY_UNREADABLE = "Saved chat history could not be read. The damaged copy was kept.";
const COLD_CHAT_UNREADABLE = "An older chat could not be read and looks empty. Close and reopen the app before continuing it.";
// A save blocks the window for about 11 ms per million characters, and at 52.4M localStorage refuses it and no chat saves.
const HISTORY_MOVE_ABOVE = 10_000_000;
const HISTORY_MOVE_TO = 5_000_000;

// A chat moved out of the history value has its own file. undefined means no file, null means a file that can't be read.
function coldChat(id: string): ChatMessage[] | null | undefined {
	const text = window.grokCode?.readColdChat?.(id);
	if (text === undefined || text === null) { return undefined; }
	try {
		const messages: unknown = text === false ? null : JSON.parse(text);
		return Array.isArray(messages) ? messages.map(maskChat) : null;
	} catch {
		return null;
	}
}

// Moves chats to their own files, in the order given, until enough has left the value. A chat whose file can't be written stays.
function moveChats(chats: Record<string, ChatMessage[]>, ids: string[], excess: number) {
	const write = window.grokCode?.writeColdChat;
	if (!write) { return false; }
	let left = excess;
	let moved = false;
	for (const id of ids) {
		if (left <= 0) { break; }
		const text = JSON.stringify(chats[id]);
		if (write(id, text)) {
			delete chats[id];
			left -= text.length;
			moved = true;
		}
	}
	return moved;
}

// The session to show when none is chosen. A routine's run comes last: its row is tucked away in the sidebar, and opening it would clear its unread dot.
function firstOpen(list: Session[]) {
	return list.find((item) => !item.archived && !item.routineId) ?? list.find((item) => !item.archived);
}

function sandboxGitSession(session: Session) {
	return session.environment === "Local" && (sandboxWanted(session) || !!session.sandbox);
}

function newSession(seed?: Partial<ProjectSeed>, parentId?: string): Session {
	const folder = seed?.folder ?? window.grokCode?.homeDir ?? "";
	const project = seed?.project ?? shortPath(folder);
	const now = Date.now();
	return {
		id: `new-${crypto.randomUUID()}`, title: "New session", project,
		...(parentId ? { parentId } : {}),
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

function chatMin(windowWidth: number): number {
	return windowWidth < 1100 ? 320 : 400;
}

export function sideCap(windowWidth: number, sidebarWidth: number): number {
	return Math.max(PANE_MIN, windowWidth - sidebarWidth - PANE_SPLITTER_WIDTH - chatMin(windowWidth));
}

export function shouldCollapseSidebar(windowWidth: number, panesOpen: boolean): boolean {
	return windowWidth < 1100 && panesOpen;
}

function folderKey(folder: string) {
	return caseKey(folder.trim().replace(/\\/g, "/").replace(/\/+$/, ""));
}

function cursorRepoSlug(url?: string) {
	return /^https:\/\/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)$/.exec(url ?? "")?.[1] ?? "";
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

function formatLimitReset(resetsAt?: string) {
	return resetsAt ? new Date(resetsAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

// Grok's usage limit as one line, for /usage and the composer meter.
function limitLine(limit: GrokLimit) {
	return [
		[limit.tier, limit.period, "limit", limit.percent !== null ? `${limit.percent}% used` : ""].filter(Boolean).join(" "),
		limit.resetsAt ? `resets ${formatLimitReset(limit.resetsAt)}` : "",
	].filter(Boolean).join(" · ");
}

export function App() {
	const [pasteHistory] = useState(() => {
		try { return { raw: localStorage.getItem(historyKey), backup: localStorage.getItem("grok-code.history.bad") }; } catch { return undefined; }
	});
	const [history] = useState(readHistory);
	const [settings, setSettings] = useState<AppSettings>(readSettings);
	const [uiPreviewTheme, setUiPreviewTheme] = useState<UiTheme | null>(null);
	const [sessions, setSessions] = useState<Session[]>(() => history?.sessions.map((item) => ({ ...item, status: "idle" })) ?? [newSession({ folder: "" })]);
	const firstSessionId = useRef(history ? null : sessions[0].id);
	const [activeId, setActiveId] = useState(() => {
		const requested = new URLSearchParams(window.location?.search ?? "").get("session");
		return history?.sessions.find((item) => item.id === requested)?.id ?? firstOpen(history?.sessions ?? [])?.id ?? "";
	});
	// A fresh id each time, so two windows that both restore the form cannot send into one session.
	// A window opened for one session shows that session and leaves the form to the others.
	const [restoredForm] = useState<Session | null>(() => (history?.newSessionDraft && !new URLSearchParams(window.location?.search ?? "").get("session") ? { ...history.newSessionDraft.session, id: `new-${crypto.randomUUID()}` } : null));
	const [pending, setPending] = useState<Session | null>(() => restoredForm ?? (history ? null : sessions[0]));
	const [useWorktree, setUseWorktree] = useState(history?.newSessionDraft?.useWorktree ?? false);
	const [sandboxPicker, setSandboxPicker] = useState("");
	const [cliProjectFolders, setCliProjectFolders] = useState<string[]>([]);
	const [panes, setPanes] = useState<SidePaneId[]>([]);
	const [focusedPane, setFocusedPane] = useState<SidePaneId | null>(null);
	const [expandedPane, setExpandedPane] = useState<SidePaneId | null>(null);
	const [paneSplit, setPaneSplit] = useState(50);
	const paneDrag = useRef<{ id: number; y: number; height: number; start: number } | null>(null);
	const [menu, setMenu] = useState<Menu>(null);
	const [fileMenu, setFileMenu] = useState<{ file: string; x: number; y: number; opener: HTMLElement } | null>(null);
	const [query, setQuery] = useState("");
	const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
		...Object.fromEntries(Object.entries(history?.composerDrafts ?? {}).filter(([id, text]) => typeof text === "string" && sessions.some((item) => item.id === id))),
		...(restoredForm && history?.newSessionDraft ? { [restoredForm.id]: history.newSessionDraft.text } : {}),
	}));
	const [attachments, setAttachmentsState] = useState<Record<string, string[]>>(() => ({
		...Object.fromEntries(Object.entries(history?.attachments ?? {}).filter(([id]) => sessions.some((item) => item.id === id))),
		...(restoredForm && history?.newSessionDraft?.attachments?.length ? { [restoredForm.id]: history.newSessionDraft.attachments } : {}),
	}));
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
	const [popValue, setPopValue] = useState<string | null>(null);
	const popupList = useRef<HTMLDivElement>(null);
	const [skillCommands, setSkillCommands] = useState<{ folder: string; names: Set<string> } | null>(null);
	const skillRequest = useRef<{ folder: string; commands: GrokCommand[] } | null>(null);
	const [popClosed, setPopClosed] = useState("");
	const [sideOpen, setSideOpen] = useState(false);
	const [promptLibrary, setPromptLibrary] = useState<{ mode: "save" | "insert"; sessionId: string; text: string; start: number; end: number } | null>(null);
	const [sideTexts, setSideTexts] = useState<Record<string, string>>({});
	const [sideChats, setSideChats] = useState<Record<string, ChatMessage[]>>({});
	const [sideAgents, setSideAgents] = useState<Record<string, { agentSessionId: string; sandbox?: GrokSandboxChoice }>>({});
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
			setNotice("Preparing the update. You can keep working.", true);
			const prepared = await api.updatePrepare(info.tag);
			if (prepared.busy) {
				setNotice("The update is still being prepared.", true);
				return;
			}
			if (prepared.ok && prepared.ready) {
				// Cancel takes the focus: this dialog can appear while the user is typing, and Enter must not close the app.
				const yes = await askConfirm({ title: `Update to version ${info.latest}?`, body: [prepared.notes?.slice(0, 1500), "The app closes to update and usually reopens when the update finishes. This can take a few minutes, especially if Electron changed. Running Grok replies and terminals stop.", prepared.asksPassword ? "Linux asks for your password after the app closes." : ""].filter(Boolean).join("\n\n"), ok: "Update and restart", danger: true });
				if (yes && api.updateStart) {
					const result = await api.updateStart(info.tag);
					if (!result.ok) { setNotice(result.error || "The update could not start."); }
				}
			} else {
				// An installed copy that can't update itself runs its install command again, or on Linux gets the release page; a source copy updates with git.
				const where = prepared.steps?.includes("install-windows.ps1") ? "PowerShell" : "Terminal";
				const command = prepared.steps ? `Quit the app, then run this in ${where}:\n${prepared.steps}` : "Quit the app, then in its folder run: git pull, npm install, npm run desktop";
				const how = prepared.steps?.startsWith("https://") ? `Quit the app, then install the new package from the release page:\n${prepared.steps}` : command;
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
	const focusShortcuts = useCallback((sheet: HTMLDivElement | null) => { sheet?.focus({ preventScroll: true }); }, []);
	const [rewindAsk, setRewindAsk] = useState<{ sessionId: string; message: ChatMessage; files: string[]; conflicts: string[] } | null>(null);
	const [branching, setBranching] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null);
	const [grokBotOpen, setGrokBotOpen] = useState(false);
	const [routinesOpen, setRoutinesOpen] = useState(false);
	const grokBot = useGrokBot();
	const grokBotShown = useRef(false);
	const [setup, setSetup] = useState<{ result?: GrokReadiness; open: boolean; checking: boolean; installing: "" | "grok" | "git" | "update" }>({ open: false, checking: false, installing: "" });
	const setupCheck = useRef(0);
	const setupFromAbout = useRef(false);
	// Back and Forward walk what this window has shown, like a browser's history: sessions, Routines, Settings and Grok Bot.
	const place = routinesOpen ? "page:routines" : settingsOpen || (setup.open && setupFromAbout.current) ? "page:settings" : grokBotOpen ? "page:grok-bot" : activeId;
	const [trail, setTrail] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
	const trailFrom = useRef(place);
	const travelTo = useRef<string | null>(null);
	useEffect(() => {
		const previous = trailFrom.current;
		trailFrom.current = place;
		if (previous === place) { return; }
		const travelled = travelTo.current === place;
		travelTo.current = null;
		if (travelled || !previous) { return; }
		setTrail((current) => ({ back: [...current.back, previous].slice(-50), forward: [] }));
	}, [place]);
	const [confirms, setConfirms] = useState<ConfirmItem[]>([]);
	const confirmQueue = useRef<ConfirmItem[]>([]);
	const confirmIds = useRef(0);
	const confirmReturn = useRef<HTMLElement | null>(null);
	const confirmShown = useRef(false);
	const answerRef = useRef<(yes: boolean) => void>(() => {});
	const [renaming, setRenaming] = useState<string | null>(null);
	const coldChatUnreadable = useRef(false);
	// ponytail: every chat loads at startup, which search and fork rely on; load on demand once startup or memory hurts.
	const [extraChats, setChatState] = useState<Record<string, ChatMessage[]>>(() => {
		const chats = { ...history?.extraChats };
		for (const { id } of history?.sessions ?? []) {
			if (chats[id]) { continue; }
			const cold = coldChat(id);
			if (cold) { chats[id] = cold; } else if (cold === null) { coldChatUnreadable.current = true; }
		}
		return restoredChats(chats, history?.sessions);
	});
	useEffect(() => {
		if (coldChatUnreadable.current) { setNotice(COLD_CHAT_UNREADABLE); }
		try {
			if (pasteHistory !== undefined) { window.grokCode?.prunePastedImages?.(pasteHistory.raw, pasteHistory.backup); }
		} catch {}
		// Covers a file left behind by a window that closed first or a delete that failed.
		if (history?.deleted.length) { void window.grokCode?.removeColdChats?.(history.deleted); }
	}, []);
	const urgentSave = useRef(false);
	const setExtraChats = useCallback((update: SetStateAction<Record<string, ChatMessage[]>>) => {
		urgentSave.current = true;
		setChatState(update);
	}, []);
	const [deleted, setDeleted] = useState<string[]>(history?.deleted ?? []);
	const deletedRef = useRef(deleted);
	deletedRef.current = deleted;
	const remotelyDeleted = useRef(new Set<string>());
	const [views, setViews] = useState<Record<string, TranscriptView>>({});
	const [findTick, setFindTick] = useState(0);
	const [findAt, setFindAt] = useState({ tick: 0, text: "" });
	const [commands, setCommands] = useState<GrokCommand[]>(readCommands);
	const [models, setModels] = useState<GrokModel[]>([]);
	const [servers, setServers] = useState<GrokMcpServer[]>([]);
	const [diffScope, setDiffScope] = useState<Record<string, string>>({});
	const [commits, setCommits] = useState<Record<string, { sha: string; short: string; subject: string }[]>>({});
	const [branches, setBranches] = useState<Record<string, { folder: string; info: BranchInfo } | undefined>>({});
	const [missingFolders, setMissingFolders] = useState<Record<string, string>>({});
	const [prs, setPrs] = useState<Record<string, PrStatus | undefined>>({});
	const [comments, setComments] = useState<Record<string, DiffComment[]>>({});
	const [viewed, setViewed] = useState<Record<string, Record<string, string>>>({});
	const [diffFile, setDiffFile] = useState("");
	const [diffTick, setDiffTick] = useState(0);
	const [remoteTick, setRemoteTick] = useState(0);
	const [diffs, setDiffs] = useState<Record<string, DiffSnapshot | undefined>>({});
	const [changeList, setChangeList] = useState<{ key: string; context: string; revision: string; snapshot: DiffSnapshot }>();
	const [changePatch, setChangePatch] = useState<ChangePatch>();
	const [changeMarks, setChangeMarks] = useState<{ key: string; values: Map<string, string> }>();
	const changeRead = useRef<ChangeRead | null>(null);
	const [folderLists, setFolderLists] = useState<Record<string, FolderFiles | undefined>>({});
	const [openFiles, setOpenFiles] = useState<Record<string, OpenFile | undefined>>({});
	const [editorDrafts, setEditorDrafts] = useState<History["editorDrafts"]>(() => Object.fromEntries(Object.entries(history?.editorDrafts ?? {}).map(([key, draft]) => [key, draft && { ...draft, saving: false }])));
	const [editorFile, setEditorFile] = useState("");
	const [editorLine, setEditorLine] = useState<{ line?: number; tick: number }>({ tick: 0 });
	const [fileTick, setFileTick] = useState(0);
	const [terminals, setTerminals] = useState<Record<string, TerminalTab[]>>({});
	const terminalsRef = useRef(terminals);
	terminalsRef.current = terminals;
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
	const [selectTick, setSelectTick] = useState(0);
	const [modes, setModes] = useState<Record<string, PermissionMode>>(history?.modes ?? {});
	const [prePlan, setPrePlan] = useState<Record<string, PermissionMode>>(history?.prePlan ?? {});
	const modesRef = useRef(modes);
	const modeRequest = useRef<Record<string, number>>({});
	const sentModes = useRef<Record<string, PermissionMode>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	// shortcut: the warning is once per session, not once per later collision
	const [collisionSeen, setCollisionSeen] = useState<Record<string, true>>({});
	const [breakdown, setBreakdown] = useState<(ContextBreakdown & { id: string }) | null>(null);
	const [recentUsd, setRecentUsd] = useState<number | null>(null);
	const [limit, setLimit] = useState<GrokLimit | null>(null);
	const [limitStale, setLimitStale] = useState(false);
	const limitRead = useRef(0);
	const [signInStatus, setSignInStatus] = useState<GrokSignInStatus>();
	const signInEpoch = useRef(0);
	const [cloudKeyStatus, setCloudKeyStatus] = useState<CursorKeyStatus>();
	const cloudKeyEpoch = useRef(0);
	const cloudKeyAvailable = !!cloudKeyStatus?.hasKey && cloudKeyStatus.keyReadable;
	const [cloudSetup, setCloudSetup] = useState<{ id: string; folder: string; result?: CursorSetupResult } | null>(null);
	const cloudSetupEpoch = useRef(0);
	const [cursorModels, setCursorModels] = useState<CursorModel[]>([]);
	const keyMode = setup.result?.grok.signIn === "key" || (!setup.result?.grok.keyIgnored && (signInStatus?.mode ?? setup.result?.grok.signInMode) === "key");
	const [account, setAccount] = useState<GrokAccount | null | undefined>(readAccount);
	const [addingFolder, setAddingFolder] = useState(false);
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth ?? 1400);
	const [resizePreview, setResizePreview] = useState<{ key: ColumnWidth; width: number } | null>(null);
	const resizeCleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => resizeCleanup.current?.(), []);
	const turnTargets = useRef<Record<string, TurnTarget>>({});
	// Each prompt keeps its reply when a late steer runs beside a newer prompt.
	const replyTargets = useRef<Record<string, Record<string, TurnTarget>>>({});
	const replyChats = useRef({ main: extraChats, side: sideChats });
	replyChats.current = { main: extraChats, side: sideChats };
	const [turnAnnouncements, setTurnAnnouncements] = useState<Notice[]>([]);
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
	const savedSandboxProfile = useRef(settings.sandboxProfile);
	const keyActions = useRef<Record<string, () => void> & { restorePane?: () => boolean }>({});
	const inboundAccept = useRef<(agentSessionId: string, text: string) => InboundResult>(() => ({ accepted: false }));
	const routineFire = useRef<(event: GrokEvent) => void>(() => {});
	const routineOpen = useRef<(event: GrokEvent) => void>(() => {});
	const overlayOpen = useRef(false);
	const overlayOpener = useRef<HTMLElement | null>(null);
	const escapeStopAfter = useRef(0);
	const settingsShown = useRef(false);
	const editorDraftsRef = useRef(editorDrafts);
	const queuedRef = useRef(queued);
	const attachmentsRef = useRef(attachments);
	const promptRef = useRef<HTMLTextAreaElement | null>(null);
	const appVersion = useRef("");
	sessionsRef.current = sessions;
	const hasOverlay = menu !== null || fileMenu !== null || shortcuts || settingsOpen !== null || routinesOpen || rewindAsk !== null || setup.open || promptLibrary !== null;
	const settingsCover = settingsOpen !== null || routinesOpen || (setup.open && setupFromAbout.current);
	if (hasOverlay && !overlayOpen.current && !promptLibrary) {
		overlayOpener.current = document.activeElement as HTMLElement | null;
	}
	overlayOpen.current = hasOverlay;
	useLayoutEffect(() => {
		if (!hasOverlay) { return; }
		return () => { escapeStopAfter.current = Date.now() + ESCAPE_STOP_GRACE_MS; };
	}, [hasOverlay]);
	useEffect(() => {
		if (hasOverlay) { return; }
		const opener = overlayOpener.current;
		overlayOpener.current = null;
		if (opener?.isConnected && document.activeElement === document.body) { opener.focus(); }
	}, [hasOverlay]);
	settingsShown.current = settingsCover;
	grokBotShown.current = grokBotOpen;
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
	const closeDraftConflict = useRef<{ draft: History["newSessionDraft"] } | null>(null);
	const saveHistory = useRef<(closing?: boolean) => boolean>(() => true);

	useEffect(() => {
		const orphaned = new Set(Object.keys(terminalsRef.current).filter((id) => !terminalOwner(id)));
		if (!orphaned.size) { return; }
		const closed = new Set<string>();
		for (const id of orphaned) {
			for (const tab of terminalsRef.current[id] ?? []) {
				closed.add(tab.id);
				stopTerminal(tab.id);
			}
		}
		setTerminals((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !orphaned.has(id))));
		setActiveTerminal((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !orphaned.has(id))));
		setDevTabs((current) => Object.fromEntries(Object.entries(current).filter(([, id]) => !closed.has(id))));
	}, [sessions, pending, deleted]);

	function answerConfirm(yes: boolean, id = confirmQueue.current[0]?.id) {
		const first = confirmQueue.current[0];
		if (!first || first.id !== id) { return; }
		const next = confirmQueue.current.slice(1);
		confirmQueue.current = next;
		confirmShown.current = next.length > 0;
		if (!next.length) { escapeStopAfter.current = Date.now() + ESCAPE_STOP_GRACE_MS; }
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

	const persistSettings = useCallback((next: AppSettings) => {
		try {
			localStorage.setItem(settingsKey, JSON.stringify(next));
			savedSandboxProfile.current = next.sandboxProfile;
			return true;
		} catch {
			setNotice("Settings could not be saved. Changes last until the app closes.");
			return false;
		}
	}, [setNotice]);

	function refreshSandboxProfile() {
		const current = settingsRef.current;
		if (PLATFORM === "win32" || current.sandboxProfile !== savedSandboxProfile.current) { return; }
		const sandboxProfile = readSettings().sandboxProfile;
		if (sandboxProfile === current.sandboxProfile) { return; }
		savedSandboxProfile.current = sandboxProfile;
		settingsRef.current = { ...current, sandboxProfile };
		setSettings(settingsRef.current);
	}

	function changeSettings(patch: Partial<AppSettings>) {
		const next = { ...settingsRef.current, ...patch };
		settingsRef.current = next;
		if (patch.promptSuggestions === false) { clearSuggestions(); }
		setSettings(next);
		return persistSettings(next);
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

	// The chip, /plan and /auto all wait for the host. A refusal, including a change during a reply, leaves the chip as it was.
	// Two clicks before the first reply returns: only the later click may move the chip.
	function requestMode(id: string, next: PermissionMode) {
		const ticket = (modeRequest.current[id] ?? 0) + 1;
		modeRequest.current[id] = ticket;
		const api = window.grokCode;
		if (!api?.setMode) {
			if (turnTargets.current[id]) { setNotice("Stop or finish this turn before changing mode."); return; }
			changeMode(id, next);
			return;
		}
		void api.setMode(id, next).then((result) => {
			if (modeRequest.current[id] !== ticket) { return; }
			if (!result?.ok) { setNotice(result?.error || "Grok did not change mode."); return; }
			changeMode(id, next);
		}).catch(() => {
			if (modeRequest.current[id] !== ticket) { return; }
			setNotice("Grok did not change mode.");
		});
	}

	function restartStops(next: PermissionMode) {
		const sent = sentModes.current[session.id];
		if (!sent || permissionGroup(sent) === permissionGroup(next)) { return 0; }
		return (grokTasks[session.id] ?? []).filter((task) => task.status === "running").length + (subagents[session.id] ?? []).filter((agent) => agent.status === "running").length;
	}

	function checkSetup(open = true, openOnFailure = true) {
		const api = window.grokCode;
		if (!api?.readiness) { return; }
		const check = ++setupCheck.current;
		setSetup((current) => ({ ...current, open: open || current.open, checking: true }));
		void api.readiness({ folder: session.folder || api.homeDir || "", full: open }).then((result) => {
			if (check !== setupCheck.current) { return; }
			// The account menu keeps the version from the last Grok session start, and Grok may have updated itself since.
			const version = result.grok.ok ? result.grok.version : "";
			if (version) { setAccount((current) => (current && current.version !== version ? { ...current, version } : current)); }
			setSetup((current) => ({ ...current, result, open: current.open || (openOnFailure && (!result.grok.ok || !result.grok.signedIn)), checking: false }));
		}).catch(() => {
			if (check !== setupCheck.current) { return; }
			setSetup((current) => ({ ...current, checking: false }));
			setNotice("Setup could not be checked. Try again.");
		});
	}

	function openSetupFromAbout() {
		if (!window.grokCode?.readiness) { return; }
		setupFromAbout.current = true;
		setSettingsOpen(null);
		checkSetup();
	}

	function closeSetup() {
		if (setupFromAbout.current) { setSettingsOpen("about"); }
		setupFromAbout.current = false;
		setSetup((current) => ({ ...current, open: false }));
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

	function loadSignInStatus() {
		const epoch = signInEpoch.current;
		void window.grokCode?.signInStatus?.().then((result) => {
			if (epoch === signInEpoch.current) { setSignInStatus(result); }
		}).catch(() => {});
	}

	function loadCloudKeyStatus() {
		const epoch = cloudKeyEpoch.current;
		void window.grokCode?.cloudKeyStatus?.().then((result) => {
			if (epoch === cloudKeyEpoch.current) { setCloudKeyStatus(result); }
		}).catch(() => {});
	}

	useEffect(() => { loadSignInStatus(); loadCloudKeyStatus(); checkSetup(false, !firstRun); }, []);

	useEffect(() => { void window.grokCode?.inbound?.(settings.acceptLocalTurns).then((result) => { if (result && !result.ok) { setNotice(result.error || "Turns from local tools could not be switched."); } }); }, [settings.acceptLocalTurns]);

	function showDeletedChat(id: string) {
		const title = sessionsRef.current.find((item) => item.id === id)?.title;
		const chat = title ? `The chat “${redactKeys(title)}”` : "This chat";
		setNotice(`${chat} was deleted in another window. Copy any text you want to keep before closing.`);
	}

	function observeRemoteDeletes(saved: Pick<History, "deleted" | "allDeleted"> | null) {
		const tombstones = new Set([...deletionIds(saved?.deleted), ...deletionIds(saved?.allDeleted)]);
		if (!tombstones.size) { return; }
		for (const { id } of sessionsRef.current) {
			if (!tombstones.has(id) || remotelyDeleted.current.has(id) || deletedRef.current.includes(id)) { continue; }
			remotelyDeleted.current.add(id);
			if (id === activeIdRef.current && !settingsShown.current) { showDeletedChat(id); }
		}
	}

	function refuseDeletedChat(id: string, saved?: History) {
		if (!remotelyDeleted.current.has(id)) {
			try { observeRemoteDeletes(saved ?? JSON.parse(localStorage.getItem(historyKey) ?? "null")); } catch { /* Damaged history is handled on save. */ }
		}
		if (!remotelyDeleted.current.has(id) && !deletedRef.current.includes(id)) { return false; }
		showDeletedChat(id);
		return true;
	}

	async function saveLocalSendSettings(id: string, patch: Partial<Session>, expectedFolder?: string) {
		try {
			return await navigator.locks.request(historyKey, () => {
				const saved = JSON.parse(localStorage.getItem(historyKey) ?? "null") as History | null;
				if (refuseDeletedChat(id, saved ?? undefined)) { return false; }
				const remote = saved?.sessions.find((item) => item.id === id);
				const local = sessionsRef.current.find((item) => item.id === id);
				if (!local) { return false; }
				if (expectedFolder !== undefined && (remote ?? local).folder !== expectedFolder) {
					setNotice("The session folder changed in another window. Choose it again.");
					return false;
				}
				const apply = (item: Session) => item.id === id ? { ...item, ...patch } : item;
				if (saved && remote) {
					localStorage.setItem(historyKey, JSON.stringify({ ...saved, sessions: saved.sessions.map(apply) }));
					const last = lastSaved.current;
					if (last) { lastSaved.current = { ...last, sessions: last.sessions.map(apply) }; }
				}
				sessionsRef.current = sessionsRef.current.map(apply);
				setSessions((current) => current.map(apply));
				return true;
			});
		} catch {
			setNotice("The session settings could not be saved.");
			return false;
		}
	}

	function adoptLocalSendSettings(saved: History, targetId?: string) {
		const last = lastSaved.current;
		if (!last) { return; }
		const stored = new Map(saved.sessions.map((item) => [item.id, item]));
		const previous = new Map(last.sessions.map((item) => [item.id, item]));
		const patches = new Map<string, Partial<Session>>();
		const modePatches: Record<string, PermissionMode> = {};
		const prePlanPatches: Record<string, PermissionMode> = {};
		const resetSide = new Set<string>();
		const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
		for (const item of sessionsRef.current) {
			const { id } = item;
			const remote = stored.get(id);
			const old = previous.get(id);
			if (item.environment !== "Local" || (targetId && id !== targetId) || !remote || !old || remotelyDeleted.current.has(id)) { continue; }
			const patch: Partial<Session> = {};
			if (item.folder === old.folder && item.folder !== remote.folder) {
				const { folder, project, worktree, worktreeFolder, allowedFolders, sandbox, agentSessionId, sandboxContextPending } = remote;
				Object.assign(patch, { folder, project, worktree, worktreeFolder, allowedFolders, sandbox, agentSessionId, sandboxContextPending });
				resetSide.add(id);
			} else if (item.folder === remote.folder && !turnTargets.current[id] && item.agentSessionId === old.agentSessionId && same(item.sandbox, old.sandbox)) {
				const runtimeChanged = item.agentSessionId !== remote.agentSessionId || !same(item.sandbox, remote.sandbox);
				if (item.agentSessionId !== remote.agentSessionId) { patch.agentSessionId = remote.agentSessionId; }
				if (!same(item.sandbox, remote.sandbox)) { patch.sandbox = remote.sandbox; resetSide.add(id); }
				if ((runtimeChanged || item.sandboxContextPending === old.sandboxContextPending) && item.sandboxContextPending !== remote.sandboxContextPending) {
					patch.sandboxContextPending = remote.sandboxContextPending;
				}
			}
			if (item.sandboxOn === old.sandboxOn && item.sandboxOn !== remote.sandboxOn) { patch.sandboxOn = remote.sandboxOn; }
			if (same(item.sandboxChoice, old.sandboxChoice) && !same(item.sandboxChoice, remote.sandboxChoice)) { patch.sandboxChoice = remote.sandboxChoice; }
			if (Object.keys(patch).length) { patches.set(id, patch); }
			const savedMode = saved.modes[id];
			if (savedMode && modesRef.current[id] === last.modes[id] && savedMode !== last.modes[id]) {
				modePatches[id] = savedMode;
				if (saved.prePlan[id]) { prePlanPatches[id] = saved.prePlan[id]; }
			}
		}
		if (patches.size) {
			const adopt = (item: Session) => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item;
			lastSaved.current = { ...last, sessions: last.sessions.map(adopt) };
			sessionsRef.current = sessionsRef.current.map(adopt);
			setSessions((current) => current.map(adopt));
		}
		if (resetSide.size) {
			for (const id of resetSide) { delete sideSeen.current[id]; }
			setSideAgents((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !resetSide.has(id))));
		}
		if (Object.keys(modePatches).length) {
			lastSaved.current = { ...lastSaved.current!, modes: { ...last.modes, ...modePatches }, prePlan: { ...last.prePlan, ...prePlanPatches } };
			modesRef.current = { ...modesRef.current, ...modePatches };
			setModes(modesRef.current);
			setPrePlan((current) => ({ ...current, ...prePlanPatches }));
		}
	}

	useEffect(() => {
		const reload = (event: StorageEvent) => {
			if (event.key === settingsKey) {
				const localProfile = settingsRef.current.sandboxProfile;
				const keepProfile = PLATFORM !== "win32" && localProfile !== savedSandboxProfile.current;
				settingsRef.current = readSettings();
				savedSandboxProfile.current = settingsRef.current.sandboxProfile;
				if (keepProfile) { settingsRef.current.sandboxProfile = localProfile; }
				setSettings(settingsRef.current);
			}
			if (event.key === historyKey) {
				const saved = readHistory(undefined, true);
				observeRemoteDeletes(saved);
				if (saved) { adoptLocalSendSettings(saved); }
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
				const cloudPatches = new Map<string, Pick<Session, "cloud" | "cloudModelLabel">>();
				for (const item of sessionsRef.current) {
					const remote = remoteSessions.get(item.id);
					const old = last.sessions.find((entry) => entry.id === item.id);
					if (item.environment === "Cloud" && !turnTargets.current[item.id] && remote?.cloud && item.cloud === old?.cloud && JSON.stringify(item.cloud) !== JSON.stringify(remote.cloud)) {
						cloudPatches.set(item.id, { cloud: remote.cloud, cloudModelLabel: item.cloudModelLabel === old?.cloudModelLabel ? remote.cloudModelLabel : item.cloudModelLabel });
					}
					if (item.prWatch && remotelyDeleted.current.has(item.id)) { watchPatches.set(item.id, { prWatch: undefined }); }
					if (!remote || (!item.prWatch && !remote.prWatch)) { continue; }
					const patch: Partial<Session> = {};
					if (item.prWatch === old?.prWatch && JSON.stringify(item.prWatch) !== JSON.stringify(remote.prWatch)) {
						patch.prWatch = remote.prWatch;
						if (item.unread === old?.unread) { patch.unread = remote.unread; }
					}
					if (item.archived === old?.archived && item.archived !== remote.archived) { patch.archived = remote.archived; }
					if (Object.keys(patch).length) { watchPatches.set(item.id, patch); }
				}
				if (cloudPatches.size) {
					const adoptCloud = (item: Session) => cloudPatches.has(item.id) ? { ...item, ...cloudPatches.get(item.id) } : item;
					lastSaved.current = { ...last, sessions: last.sessions.map(adoptCloud) };
					sessionsRef.current = sessionsRef.current.map(adoptCloud);
					setSessions((current) => current.map(adoptCloud));
				}
				const added = (saved?.sessions ?? []).filter((item) => item.prWatch && !sessionsRef.current.some((entry) => entry.id === item.id));
				if (watchPatches.size || added.length) { setSessions((current) => [...current.map((item) => watchPatches.has(item.id) ? { ...item, ...watchPatches.get(item.id) } : item), ...added.filter((item) => !current.some((entry) => entry.id === item.id))]); }
				if (added.length) {
					const chats = restoredChats(Object.fromEntries(added.map((item) => [item.id, saved?.extraChats[item.id] ?? coldChat(item.id) ?? []])));
					lastSaved.current = { ...lastSaved.current!, sessions: [...last.sessions, ...added], extraChats: { ...last.extraChats, ...chats } };
					setChatState((current) => ({ ...chats, ...current }));
				}
				const savedQueue = saved?.queued ?? {};
				const mine = queuedRef.current;
				const adopt = [...new Set([...Object.keys(mine), ...Object.keys(savedQueue)])].filter((id) => !remotelyDeleted.current.has(id) && mine[id] === last.queued?.[id] && JSON.stringify(mine[id] ?? []) !== JSON.stringify(savedQueue[id] ?? []));
				if (adopt.length) {
					const next = { ...mine };
					for (const id of adopt) { if (savedQueue[id]) { next[id] = savedQueue[id]; } else { delete next[id]; } }
					lastSaved.current = { ...lastSaved.current!, queued: { ...last.queued, ...Object.fromEntries(adopt.map((id) => [id, next[id]])) } };
					setQueued(next);
					setHeld((current) => ({ ...current, ...Object.fromEntries(adopt.filter((id) => next[id]).map((id) => [id, true])) }));
				}
				const savedAttachments = saved?.attachments ?? {};
				const staged = attachmentsRef.current;
				const take = [...new Set([...Object.keys(staged), ...Object.keys(savedAttachments)])].filter((id) => !remotelyDeleted.current.has(id) && staged[id] === last.attachments?.[id] && JSON.stringify(staged[id] ?? []) !== JSON.stringify(savedAttachments[id] ?? []));
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

	useEffect(() => { persistSettings(settingsRef.current); }, [persistSettings]);

	const shownTheme = uiPreviewTheme ?? settings.appearance;
	useLayoutEffect(() => {
		const root = typeof document === "undefined" ? undefined : document.documentElement;
		if (!root) { return; }
		if (shownTheme === "system") { root.removeAttribute("data-theme"); } else { root.setAttribute("data-theme", shownTheme); }
	}, [shownTheme]);
	const activeUiConfig = settings.uiConfigs.find(({ id }) => id === settings.activeUiConfig);
	useLayoutEffect(() => { applyUiConfig(uiConfigCss(activeUiConfig?.values ?? {})); }, [activeUiConfig]);

	useLayoutEffect(() => {
		const desktop = window as Window & { grokPrepareUnload?: () => Promise<void> };
		let releaseHistoryLock: (() => void) | undefined;
		// Electron resumes the unload once this lock is held, so the guard can save the latest state synchronously.
		desktop.grokPrepareUnload = () => new Promise<void>((ready) => {
			if (releaseHistoryLock || !navigator.locks) { ready(); return; }
			void navigator.locks.request(historyKey, () => new Promise<void>((release) => {
				const timeout = setTimeout(() => releaseHistoryLock?.(), 5000);
				releaseHistoryLock = () => {
					clearTimeout(timeout);
					releaseHistoryLock = undefined;
					release();
				};
				ready();
			})).catch(() => { setNotice(HISTORY_FAILED); ready(); });
		});
		const guard = (event: BeforeUnloadEvent) => {
			let saved = false;
			const release = releaseHistoryLock;
			if (release) {
				try { saved = saveHistory.current(true); } finally { release(); }
			}
			const current = editorDraftsRef.current;
			const onlyInWindow = (id: string) => remotelyDeleted.current.has(id) && !deletedRef.current.includes(id);
			const unsavedMessage = Object.entries(draftsRef.current).some(([id, text]) => text && (onlyInWindow(id) || (!saved && (pendingRef.current?.id === id || keptForm.current?.session.id === id || sessionsRef.current.some((item) => item.id === id)))));
			const unsavedItems = [queuedRef.current, attachmentsRef.current].some((items) => Object.entries(items).some(([id, values]) => values.length && (!saved || onlyInWindow(id))));
			if ((!saved && window.grokCode) || unsavedMessage || unsavedItems || (current !== persistedDrafts.current && Object.values(current).some((draft) => draft && (draft.text !== draft.baseText || draft.recoveryTexts?.length)))) {
				event.preventDefault();
				event.returnValue = false;
			}
		};
		window.addEventListener("beforeunload", guard);
		return () => {
			window.removeEventListener("beforeunload", guard);
			delete desktop.grokPrepareUnload;
			releaseHistoryLock?.();
		};
	}, []);

	// Set on every render, so a close saves what is on screen even before the effect below runs.
	saveHistory.current = (closing = false) => {
		const last = lastSaved.current;
		const currentDrafts = draftsRef.current;
		const currentQueue = queuedRef.current;
		const currentAttachments = attachmentsRef.current;
		const currentWork = backgroundWorkRef.current;
		const form = pendingRef.current ? { session: pendingRef.current, useWorktree: useWorktreeRef.current } : keptForm.current;
		const formAttachments = form ? currentAttachments[form.session.id] : undefined;
		const newSessionDraft = form && (currentDrafts[form.session.id] || formAttachments?.length) ? { ...form, text: currentDrafts[form.session.id] ?? "", ...(formAttachments?.length ? { attachments: formAttachments } : {}) } : undefined;
		const sameDraft = (a: History["newSessionDraft"], b: History["newSessionDraft"]) => a?.session.id === b?.session.id && a?.text === b?.text && JSON.stringify(a?.attachments ?? []) === JSON.stringify(b?.attachments ?? []);
		const retryingCloseSave = closeDraftConflict.current && sameDraft(closeDraftConflict.current.draft, newSessionDraft);
		if (!retryingCloseSave) { closeDraftConflict.current = null; }
		const sameForm = last?.newSessionDraft?.session === newSessionDraft?.session && last?.newSessionDraft?.useWorktree === newSessionDraft?.useWorktree && last?.newSessionDraft?.text === newSessionDraft?.text && last?.newSessionDraft?.attachments === newSessionDraft?.attachments;
		const unchanged = last && last.sessions === sessions && last.extraChats === extraChats && last.modes === modes && last.prePlan === prePlan && last.editorDrafts === editorDrafts && last.composerDrafts === currentDrafts && sameRecords(last.queued, currentQueue) && sameRecords(last.attachments, currentAttachments) && sameRecords(last.backgroundWork, currentWork) && sameForm && last.deleted === deleted;
		if (!closing && unchanged) { return true; }
		try {
			let invalidHistory: string | undefined;
			const saved = readHistory((raw) => { invalidHistory = raw; }, true);
			observeRemoteDeletes(saved);
			const savedForm = saved?.newSessionDraft;
			const sameStoredForm = sameDraft(savedForm, newSessionDraft);
			const keepOtherDraft = (closing || retryingCloseSave) && !!savedForm && !sameStoredForm && !sameDraft(savedForm, last?.newSessionDraft);
			if (closing && keepOtherDraft) { closeDraftConflict.current = { draft: newSessionDraft }; }
			const draftSaved = !keepOtherDraft || !newSessionDraft;
			if (unchanged && (sameStoredForm || keepOtherDraft) && invalidHistory === undefined) { return draftSaved; }
			const previous = saved && (saved.sessions.length || saved.newSessionDraft) ? last : null;
			const priorDeletes = new Set(saved?.allDeleted);
			const tombstones = new Set([...(saved?.deleted ?? []), ...deletedRef.current.filter((id) => !priorDeletes.has(id))]);
			const gone = new Set([...priorDeletes, ...tombstones, ...remotelyDeleted.current]);
			const oldSessions = new Map((previous?.sessions ?? []).map((item) => [item.id, item]));
			const currentSessions = new Map((saved?.sessions ?? []).map((item) => [item.id, item]));
			const savedIds = new Set(currentSessions.keys());
			for (const item of sessions) {
				const old = oldSessions.get(item.id);
				const remote = currentSessions.get(item.id);
				const changes = Object.fromEntries(Object.entries(item).filter(([key, value]) => value !== old?.[key as keyof Session] && !(item.titleAuto === true && remote?.titleAuto === false && (key === "title" || key === "titleAuto"))));
				currentSessions.set(item.id, currentSessions.has(item.id) ? { ...currentSessions.get(item.id), ...changes } as Session : item);
			}
			const order = [...sessions.filter((item) => !savedIds.has(item.id)).map((item) => item.id), ...savedIds].filter((id) => !gone.has(id) && id !== newSessionDraft?.session.id && (id !== firstSessionId.current || currentSessions.get(id)?.folder));
			// A changed chat that is not in the value has moved to its file, so it starts from there and returns whole. The value wins over the file from then on.
			const chatBase = { ...saved?.extraChats };
			if (previous) {
				for (const [id, messages] of Object.entries(extraChats)) {
					if (!chatBase[id] && messages !== previous.extraChats[id]) { chatBase[id] = coldChat(id) ?? previous.extraChats[id] ?? []; }
				}
			}
			const chats = slimChats(mergeChats(chatBase, extraChats, previous?.extraChats ?? {}));
			for (const id of gone) { delete chats[id]; }
			const composerDrafts = { ...saved?.composerDrafts };
			for (const [id, text] of Object.entries(currentDrafts)) {
				// Committing a form moves its text out of newSessionDraft. The in-memory draft is unchanged, so copy it into the session's composer entry once.
				const promoted = saved?.newSessionDraft?.session.id === id && saved.newSessionDraft.text === text && newSessionDraft?.session.id !== id;
				if (text === previous?.composerDrafts?.[id] && !promoted) { continue; }
				if (text) { composerDrafts[id] = text; } else { delete composerDrafts[id]; }
			}
			for (const id of Object.keys(composerDrafts)) { if (!order.includes(id)) { delete composerDrafts[id]; } }
			const queue = { ...saved?.queued };
			for (const [id, items] of Object.entries(currentQueue)) {
				if (items === previous?.queued?.[id]) { continue; }
				if (items.length) { queue[id] = items.map((item) => item.contextFrom?.length ? { ...item, contextFrom: item.contextFrom.map((pick) => maskDisplay(pick, "title")) } : item); } else { delete queue[id]; }
			}
			const staged = { ...saved?.attachments };
			for (const [id, files] of Object.entries(currentAttachments)) {
				if (files === previous?.attachments?.[id]) { continue; }
				if (files.length) { staged[id] = files; } else { delete staged[id]; }
			}
			const work = { ...saved?.backgroundWork };
			for (const [id, entry] of Object.entries(currentWork)) {
				if (entry === previous?.backgroundWork?.[id]) { continue; }
				const tasks = entry.tasks.filter((task) => task.status !== "running").map((task) => maskDisplay(task, "label", "command"));
				const agents = entry.agents.filter((agent) => agent.status !== "running").map((raw) => {
					const agent = maskDisplay(raw, "label", "output");
					return agent.output ? { ...agent, output: agent.output.slice(0, 2000) } : agent;
				});
				if (tasks.length || agents.length) { work[id] = { tasks, agents }; } else { delete work[id]; }
			}
			for (const id of Object.keys(queue)) { if (!order.includes(id)) { delete queue[id]; } }
			for (const id of Object.keys(staged)) { if (!order.includes(id)) { delete staged[id]; } }
			for (const id of Object.keys(work)) { if (!order.includes(id.startsWith("side-") ? id.slice(5) : id)) { delete work[id]; } }
			const record = {
				sessions: order.map((id) => maskDisplay(currentSessions.get(id)!, "title", "detail")),
				extraChats: chats,
				modes: { ...saved?.modes, ...Object.fromEntries(Object.entries(modes).filter(([id, value]) => value !== previous?.modes[id])) },
				prePlan: { ...saved?.prePlan, ...Object.fromEntries(Object.entries(prePlan).filter(([id, value]) => value !== previous?.prePlan[id])) },
				editorDrafts: keptDrafts(mergeDrafts(saved?.editorDrafts ?? {}, editorDrafts, previous?.editorDrafts ?? {}), gone),
				composerDrafts,
				queued: queue,
				attachments: staged,
				backgroundWork: work,
				// ponytail: one stored form for all windows; a second window's unsent form replaces the first's here, though each window keeps its own until it closes.
				newSessionDraft: keepOtherDraft || (!closing && sameForm) ? savedForm : newSessionDraft,
				deleted: [...tombstones].slice(-500),
				allDeleted: gone.size ? [...gone] : undefined,
			};
			let stored = JSON.stringify(record);
			if (stored.length > HISTORY_MOVE_ABOVE) {
				// Least recently active first. A running chat is about to change, so it stays.
				const lastActive = (id: string) => currentSessions.get(id)?.lastActivityAt ?? 0;
				const idle = order.filter((id) => chats[id]?.length && !turnTargets.current[id] && !currentSessions.get(id)?.cloud?.active).sort((a, b) => lastActive(a) - lastActive(b));
				if (moveChats(chats, idle, stored.length - HISTORY_MOVE_TO)) { stored = JSON.stringify(record); }
			}
			if (invalidHistory !== undefined) {
				try {
					localStorage.setItem("grok-code.history.bad", invalidHistory);
					setNotice(HISTORY_UNREADABLE);
				} catch {
					setNotice("The damaged chat history could not be backed up.");
				}
			}
			localStorage.setItem(historyKey, stored);
			persistedDrafts.current = editorDrafts;
			lastSaved.current = { sessions, extraChats, modes, prePlan, editorDrafts, composerDrafts: currentDrafts, queued: currentQueue, attachments: currentAttachments, backgroundWork: currentWork, newSessionDraft, deleted };
			setNotices((list) => list.some((item) => item.text === HISTORY_FULL || item.text === HISTORY_FAILED) ? list.filter((item) => item.text !== HISTORY_FULL && item.text !== HISTORY_FAILED) : list);
			return draftSaved;
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

	function rememberReply(uiSessionId: string, target: TurnTarget) {
		(replyTargets.current[uiSessionId] ??= {})[target.turnId] = target;
		if (!target.background) { turnTargets.current[uiSessionId] = target; }
	}

	function finishReply(uiSessionId: string, target: TurnTarget) {
		target.finished = true;
		if (turnTargets.current[uiSessionId] === target) {
			const next = Object.values(replyTargets.current[uiSessionId] ?? {}).filter((item) => !item.finished && !item.background).at(-1);
			if (next) { turnTargets.current[uiSessionId] = next; } else { delete turnTargets.current[uiSessionId]; }
		}
		setBusy((current) => ({ ...current, [uiSessionId]: !!turnTargets.current[uiSessionId] }));
	}

	function toolReplyTarget(uiSessionId: string, toolId: string) {
		return Object.values(replyTargets.current[uiSessionId] ?? {}).find((target) => target.toolIds?.has(toolId));
	}

	const writeReply = useCallback((uiSessionId: string, recipe: (message: ChatMessage) => ChatMessage, streamed = false, replyTarget?: TurnTarget) => {
		const target = replyTarget ?? turnTargets.current[uiSessionId];
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

	function announceTurn(text: string, title?: string) {
		const message = title ? `In ${redactKeys(title)}, ${text}` : text;
		setTurnAnnouncements((current) => [...current.slice(-7), { id: (current.at(-1)?.id ?? 0) + 1, text: message }]);
	}

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
			shown.onclick = () => { window.focus(); setGrokBotOpen(false); setActiveId(sessionId); leaveForm(); };
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
		if (item?.environment === "Cloud") { return; }
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
		const handleEvent = (event: GrokEvent): void => {
			if (event.type.startsWith("grokbot-")) { grokBot.onEvent(event); return; }
			if (event.type === "inbound" && event.requestId) { void api.inboundResult?.(event.requestId, inboundAccept.current(event.agentSessionId ?? "", event.text ?? "")); return; }
			if (event.type === "routine-fire") { routineFire.current(event); return; }
			if (event.type === "routine-open") { routineOpen.current(event); return; }
			if (event.type === "browser-open") {
				if (!settingsRef.current.browserControl || event.uiSessionId !== activeIdRef.current || !event.url || sessionsRef.current.some((item) => item.id === event.uiSessionId && item.environment === "Cloud")) { return; }
				let url: URL;
				try { url = new URL(event.url); } catch { return; }
				if (url.protocol !== "http:" && url.protocol !== "https:") { return; }
				const id = crypto.randomUUID();
				setBrowserTabs((current) => ({ ...current, [event.uiSessionId]: [...(current[event.uiSessionId] ?? []), { id, url: url.toString(), title: url.host }] }));
				setActiveBrowser((current) => ({ ...current, [event.uiSessionId]: id }));
				openPane("browser");
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
			if (event.type === "ui-default") { changeSettings({ activeUiConfig: "" }); return; }
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
			if (event.type === "sign-in-changed") {
				signInEpoch.current++;
				setLimit(null);
				setLimitStale(false);
				loadSignInStatus();
				checkSetup(false, false);
				return;
			}
			if (event.type === "cloud-key-changed") {
				cloudKeyEpoch.current++;
				cloudSetupEpoch.current++;
				setCloudKeyStatus(undefined);
				setCloudSetup(null);
				setCursorModels([]);
				loadCloudKeyStatus();
				return;
			}
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
			if (event.type === "cloud-state" && event.uiSessionId && event.turnId && typeof event.active === "boolean") {
				const { uiSessionId, turnId, agentId, runId, active, branch, prUrl } = event;
				const merge = (item: Session): Session => item.id === uiSessionId && item.environment === "Cloud" && item.cloud ? {
					...item,
					cloud: { ...item.cloud, turnId, active, ...(agentId ? { agentId } : {}), ...(runId ? { runId } : {}), ...(branch ? { branch } : {}), prUrl: prUrl || (branch && branch !== item.cloud.branch ? undefined : item.cloud.prUrl) },
				} : item;
				sessionsRef.current = sessionsRef.current.map(merge);
				setSessions((current) => current.map(merge));
				const item = sessionsRef.current.find((entry) => entry.id === uiSessionId);
				if (active && item?.cloud && !turnTargets.current[uiSessionId]) { void resumeCloud(item); }
				return;
			}
			// A late steer or a background command report gets its own reply.
			if (event.type === "turn-start" && event.uiSessionId && event.turnId) {
				const id = event.uiSessionId;
				const background = event.background === true;
				const side = background && id.startsWith("side-");
				const sessionId = side ? id.slice(5) : id;
				const where = side ? "side" : "main";
				const item = sessionsRef.current.find((entry) => entry.id === sessionId);
				const known = replyTargets.current[id]?.[event.turnId];
				if (!item || (!background && !event.parallel && !event.resume && turnTargets.current[id])) { return; }
				if (known && (background || event.parallel || !event.resume)) {
					if (!known.finished && !known.background) { turnTargets.current[id] = known; }
					return;
				}
				const stamp = Date.now();
				const replyId = `grok-${event.turnId}`;
				const saved = background && replyChats.current[where][sessionId]?.some((message) => message.id === replyId);
				rememberReply(id, { sessionId, replyId, turnId: event.turnId, where, ...(background ? { background: true, finished: !!saved } : {}) });
				if (saved) { return; }
				const reply: ChatMessage = { id: replyId, role: "grok", text: "", pending: true, streaming: true, live: true };
				const asked: ChatMessage[] = !background && !event.resume && event.text ? [{ id: `user-${event.turnId}`, role: "user", text: event.text, at: stamp, live: true }] : [];
				const store = side ? setSideChats : setExtraChats;
				store((list) => {
					const messages = list[sessionId] ?? [];
					if (background && messages.some((message) => message.id === replyId)) { return list; }
					const replay = event.resume && messages.some((message) => message.id === replyId);
					return { ...list, [sessionId]: replay ? messages.map((message) => message.id === replyId ? reply : message) : [...messages, ...asked, reply] };
				});
				if (!background) {
					setSessions((list) => list.map((item) => (item.id === id ? { ...item, lastActivityAt: stamp, completed: false } : item)));
					setBusy((list) => ({ ...list, [id]: true }));
				}
				return;
			}
			const uiId = event.uiSessionId;
			const target = uiId ? replyTargets.current[uiId]?.[event.turnId] : undefined;
			if (!uiId || !target) { return; }
			if (event.type === "tool" && event.tool) { (target.toolIds ??= new Set()).add(event.tool.id); }
			if (target.finished && event.type === "tool" && event.tool) {
				writeReply(uiId, (message) => withTool(message, event.tool as GrokToolEvent), false, target);
				return;
			}
			if (target.finished && event.type !== "steer") { return; }
			const sessionId = target.sessionId;
			const targetSession = sessionsRef.current.find((item) => item.id === sessionId);
			const cloud = targetSession?.environment === "Cloud";
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
			if (event.type === "chunk" && event.text?.trim()) { target.hasReply = true; }
			if (event.type === "tool" && event.tool) {
				const { id, waiting, questions } = event.tool;
				if (waiting === false) { target.announcedWaiting?.delete(id); }
				if (waiting) {
					const message = questions ? "Grok has a question." : "Grok needs your approval.";
					if (!target.announcedWaiting?.has(id)) {
						(target.announcedWaiting ??= new Set()).add(id);
						announceTurn(message, targetSession?.title);
					}
					if (target.where === "main") {
						if (grokBotShown.current) { setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, unread: true } : item)); }
						notify(questions ? "question" : "permission", sessionId, message);
					}
				}
			}
			if (target.background && (event.type === "done" || event.type === "error")) {
				target.finished = true;
				if (!target.hasReply && !target.toolIds?.size) {
					const store = target.where === "side" ? setSideChats : setExtraChats;
					store((list) => list[sessionId] ? { ...list, [sessionId]: list[sessionId].filter((message) => message.id !== target.replyId) } : list);
					return;
				}
				if (target.where === "main") {
					setSessions((current) => current.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: Date.now(), unread: sessionId !== activeIdRef.current || item.unread } : item)));
				}
			}
			if (!target.background && (event.type === "done" || event.type === "error")) {
				finishReply(uiId, target);
				const agent = cloud ? "Cursor" : "Grok";
				const away = sessionId !== activeIdRef.current;
				if (!target.awaitingReplay || event.type !== "error") {
					const message = event.type === "error" ? `${agent} stopped with an error.`
						: event.stopReason === "cancelled" ? `${agent} stopped.`
						: target.hasReply ? `${agent}'s reply is ready.` : `${agent}'s turn ended.`;
					announceTurn(message, away || settingsShown.current || target.where === "side" ? targetSession?.title : undefined);
				}
				if (cloud && event.type === "done" && validMachineName(event.machine)) {
					const repo = cursorRepoSlug(targetSession.cloud?.repoUrl).toLowerCase();
					if (repo) { changeSettings({ cursorMachines: normalizeCursorMachines([{ name: event.machine, repo }, ...settingsRef.current.cursorMachines]) }); }
				}
				if (cloud && event.type === "error") { setHeld((current) => ({ ...current, [sessionId]: true })); }
				setNotices((list) => list.some((item) => item.text === SIDE_BUSY) ? list.filter((item) => item.text !== SIDE_BUSY) : list);
				if (!cloud) {
					setDiffTick((value) => value + 1);
					setRemoteTick((value) => value + 1);
					setFileTick((value) => value + 1);
				}
				if (target.where === "main") {
					setSessions((current) => current.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: Date.now(), unread: away || item.unread, completed: false, failed: event.type === "error" } : item)));
					notify("done", sessionId, event.type === "error" ? `${agent} stopped with an error.` : `${agent} finished.`);
				}
			}
			if (target.awaitingReplay && event.type === "error") {
				if (event.message) { setNotice(event.message); }
				return;
			}
			writeReply(uiId, (message) => {
				if (event.type === "steer" && event.text) {
					return { ...message, pending: false, parts: [...(message.parts ?? []), { kind: "steer", text: event.text }] };
				}
				if (event.type === "chunk" && event.text) {
					const base = message.pending ? "" : message.text;
					const parts = [...(message.parts ?? [])];
					const last = parts[parts.length - 1];
					const separator = target.background && last?.kind === "tool" && base && !base.endsWith("\n") && !event.text.startsWith("\n") ? "\n" : "";
					if (last && last.kind === "text") { parts[parts.length - 1] = { kind: "text", text: redactKeys(last.text + event.text) }; } else { parts.push({ kind: "text", text: redactKeys(event.text) }); }
					return { ...message, pending: false, text: redactKeys(base + separator + event.text), parts };
				}
				if (event.type === "thought" && event.text) {
					return { ...message, thought: redactKeys((message.thought ?? "") + event.text) };
				}
				if (event.type === "tool" && event.tool) { return withTool(message, event.tool); }
				if (event.type === "done") {
					const stoppedTurn = event.stopReason === "cancelled";
					if (message.pending && !message.text) {
						return replyWithNote({ ...message, at: Date.now() }, stoppedTurn ? "Stopped." : "No reply.");
					}
					return { ...message, at: Date.now(), pending: false, streaming: false };
				}
				if (event.type === "error") {
					return event.message ? replyWithNote({ ...message, at: Date.now() }, event.message) : { ...message, at: Date.now(), pending: false, streaming: false };
				}
				return message;
			}, event.type === "chunk" || event.type === "thought", target);
			if (event.type === "done" || event.type === "error") {
				if (!target.background && !cloud && target.where === "main" && !turnTargets.current[uiId] && event.type === "done" && event.stopReason !== "cancelled" && settingsRef.current.promptSuggestions && !sessionsRef.current.find((item) => item.id === sessionId)?.routineId) {
					const generation = suggestionGeneration.current[sessionId] ?? 0;
					suggestionGeneration.current[sessionId] = generation;
					void api.suggestPrompt?.(sessionId).then((text) => {
						if (text && settingsRef.current.promptSuggestions && suggestionGeneration.current[sessionId] === generation && !draftsRef.current[sessionId] && !turnTargets.current[sessionId] && sessionsRef.current.some((item) => item.id === sessionId)) {
							setSuggestions((current) => ({ ...current, [sessionId]: text }));
						}
					}).catch(() => {});
				}
			}
		};
		const stopEvents = api.onEvent(handleEvent);
		void api.routinesReady?.();
		return stopEvents;
	}, [writeReply, openUpdate]);
	useEffect(() => {
		for (const item of sessionsRef.current) {
			if (item.environment === "Cloud" && item.cloud?.active) { void resumeCloud(item); }
		}
	}, []);

	const visible = pending ?? sessions.find((item) => item.id === activeId) ?? firstOpen(sessions) ?? sessions[0];
	const session = visible;
	const isCloud = session.environment === "Cloud";
	const firstRun = !!pending && !history?.sessions.length && !sessions.some((item) => item.agentSessionId || (item.id !== pending.id && item.folder));
	useEffect(() => {
		if (!firstRun) { return; }
		let cancelled = false;
		void window.grokCode?.listCliProjectFolders?.().then((folders) => {
			if (!cancelled) { setCliProjectFolders(folders); }
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [firstRun]);
	const visiblePanes = isCloud ? panes.filter((pane) => pane === "editor") : panes;
	const fullPane = expandedPane && visiblePanes.includes(expandedPane) ? expandedPane : null;
	const shownPaneIds = fullPane ? [fullPane] : visiblePanes;
	const browserVisible = shownPaneIds.includes("browser");
	const cloudSetupResult = cloudSetup?.id === session.id && cloudSetup.folder === session.folder ? cloudSetup.result : undefined;
	const cloudCatalog = pending ? cloudSetupResult?.models ?? [] : cursorModels;
	const cloudChoice = isCloud ? session.cloud?.model ?? defaultVariant(cloudCatalog) : undefined;
	const cloudModel = cloudCatalog.find((item) => item.id === cloudChoice?.id);
	const cloudVariant = cloudChoice && cloudModel?.variants.find((item) => sameCloudParams(item.params, cloudChoice.params));
	const machineDraft = pending?.cloudMachineDraft;
	const machineMode = typeof machineDraft === "string";
	const machineName = machineMode ? machineDraft.trim() : "";
	const machineRef = cloudSetupResult?.ref ?? "";
	const machineRefValid = /^[A-Za-z0-9._\/-]+$/.test(machineRef);
	const machineReady = validMachineName(machineName) && machineRefValid;
	const machineRepo = cursorRepoSlug(cloudSetupResult?.repoUrl);
	const cloneName = `${machineRepo.split("/").at(-1)}-cursor-${machineName}`;
	const clonePath = cloneName.startsWith("-") ? `./${cloneName}` : cloneName;
	const machineCommands = machineMode && machineReady && machineRepo ? [
		`git clone ${cloudSetupResult?.repoUrl}.git ${clonePath}`,
		`cursor-agent worker start --name ${machineName} --worker-dir ${clonePath}`,
	] : [];
	const cloudReady = cloudKeyAvailable && cloudSetupResult?.ok && cloudSetupResult.reachable !== false && !!cloudSetupResult.repoUrl && !!cloudSetupResult.ref && !cloudSetupResult.modelsError && !!cloudVariant && (!machineMode || machineReady);
	const cloudModelLabel = cloudModel && cloudVariant
		? `${cloudModel.displayName}${cloudVariant.isMaxMode ? " · Max" : ""}`
		: session.cloudModelLabel || cloudChoice?.id || "Cursor model";
	const cloudModelLocked = !!session.cloud?.agentId || !!busy[session.id] || !!session.cloud?.active;

	async function checkCloudSetup(item: Session) {
		const epoch = ++cloudSetupEpoch.current;
		const { id, folder } = item;
		setCloudSetup({ id, folder });
		let result: CursorSetupResult;
		try {
			const setup = window.grokCode?.cloudSetup;
			result = setup ? await setup(folder) : { ok: false, error: "Reopen this window to check Cloud setup." };
		} catch {
			result = { ok: false, error: "Cloud setup could not be checked. Try again." };
		}
		if (epoch !== cloudSetupEpoch.current) { return; }
		setCloudSetup({ id, folder, result });
		if (result.models?.length) { setCursorModels(result.models); }
	}

	useEffect(() => {
		if (!pending?.folder || !isCloud || !cloudKeyAvailable) { return; }
		void checkCloudSetup(pending);
		return () => { cloudSetupEpoch.current++; };
	}, [pending?.id, pending?.folder, isCloud, cloudKeyAvailable, cloudKeyStatus]);

	function changeCloudChoice(model: CursorModel, variant: CursorVariant, autoCreatePR?: boolean) {
		const update = (item: Session): Session => {
			if (item.id !== session.id || item.environment !== "Cloud" || item.cloud?.agentId || turnTargets.current[item.id]) { return item; }
			return {
				...item,
				cloudModelLabel: `${model.displayName}${variant.isMaxMode ? " · Max" : ""}`,
				cloud: {
					...item.cloud,
					repoUrl: item.cloud?.repoUrl ?? cloudSetupResult?.repoUrl ?? "",
					ref: item.cloud?.ref ?? cloudSetupResult?.ref ?? "",
					model: { id: model.id, params: variant.params },
					autoCreatePR: autoCreatePR ?? item.cloud?.autoCreatePR ?? false,
				},
			};
		};
		if (pending) { setPending((item) => item ? update(item) : item); }
		else { setSessions((items) => items.map(update)); }
	}

	const browserPaneIds = [...new Set([
		...Object.keys(browserTabs).filter((id) => id === session.id || keptForm.current?.session.id === id || sessions.some((item) => item.id === id && !item.archived)),
		...(browserVisible ? [session.id] : []),
	])];
	const currentBrowserMounted = browserPaneIds.includes(session.id);
	useLayoutEffect(() => {
		if (!currentBrowserMounted) {
			void window.grokCode?.browserTabs?.({ uiSessionId: session.id, enabled: !isCloud && settings.browserControl, visible: false, activeId: "", tabs: [] }).catch(() => {});
		}
	}, [session.id, isCloud, settings.browserControl, currentBrowserMounted]);
	useEffect(() => { setRewindAsk(null); }, [session.id]);
	// The session on screen, which is the first one before any is picked; a new-session page is none.
	activeIdRef.current = pending || grokBotOpen ? "" : session.id;
	const visibleChatId = settingsCover ? "" : activeIdRef.current;
	useEffect(() => {
		if (visibleChatId && remotelyDeleted.current.has(visibleChatId)) { showDeletedChat(visibleChatId); }
	}, [visibleChatId]);
	useEffect(() => { setGrokBotOpen(false); }, [session.id]);
	const botWindow = PLATFORM === "win32" && settings.grokBotWindow;
	useEffect(() => { if (!grokBot.status.signedIn && !botWindow) { setGrokBotOpen(false); } }, [grokBot.status.signedIn, botWindow]);
	useEffect(() => { if (!botWindow) { void window.grokCode?.grokBotWindowRelease?.(); } }, [botWindow]);
	const botWasOpen = useRef(false);
	useEffect(() => {
		if (botWasOpen.current && !grokBotOpen) { promptRef.current?.focus(); }
		botWasOpen.current = grokBotOpen;
	}, [grokBotOpen]);
	useEffect(() => { if (!pending) { readColdLoops(session.id); } }, [pending, session.id, session.agentSessionId]);
	const mode = knownMode(modes[session.id] ?? settings.defaultMode, settings);
	const view = views[session.id] ?? settings.defaultView;
	const prompt = drafts[session.id] ?? "";
	const sideText = sideTexts[session.id] ?? "";
	const setSideText = (text: string) => setSideTexts((current) => ({ ...current, [session.id]: text }));
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
	const diffOpen = visiblePanes.includes("diff");
	const railOpen = settings.railOpen;
	const panesOpen = visiblePanes.length > 0;
	const sidebarCollapsed = settings.sidebarCollapsed || shouldCollapseSidebar(windowWidth, panesOpen);
	const sidebarActiveId = pending ? "" : session.id;
	const previousSidebarId = useRef(sidebarActiveId);
	const revealSidebarProject = useRef(false);
	useLayoutEffect(() => {
		if (!sidebarCollapsed) { revealSidebarProject.current = false; }
		else if (sidebarActiveId && previousSidebarId.current !== sidebarActiveId) { revealSidebarProject.current = true; }
		previousSidebarId.current = sidebarActiveId;
	}, [sidebarActiveId, sidebarCollapsed]);
	const preferredWidth = (key: ColumnWidth) => resizePreview?.key === key ? resizePreview.width : settings[key];
	const sidebarCap = Math.min(COLUMN_MAX, windowWidth - chatMin(windowWidth) - (panesOpen ? PANE_MIN + PANE_SPLITTER_WIDTH : 0));
	const sidebarWidth = sidebarCollapsed ? 0 : Math.min(Math.max(SIDEBAR_MIN, preferredWidth("sidebarWidth")), sidebarCap);
	const paneCap = sideCap(windowWidth, sidebarWidth);
	const twoColumnMin = PANE_MIN * 2 + PANE_SPLITTER_WIDTH * 3;
	const paneColumns = shownPaneIds.length >= 3 && paneCap >= twoColumnMin ? 2 : 1;
	const paneMin = paneColumns === 2 ? twoColumnMin : PANE_MIN;
	const paneWidth = Math.min(Math.max(paneMin, preferredWidth("sideWidth")), paneCap);
	const firstPaneColumn = Math.ceil(shownPaneIds.length / paneColumns);
	const paneRows = Math.max(1, firstPaneColumn);
	const railWidth = Math.min(Math.max(RAIL_MIN, preferredWidth("railWidth")), COLUMN_MAX);
	// Like Claude's rail, it steps aside when the chat column would get too narrow.
	const railCap = Math.min(COLUMN_MAX, windowWidth - sidebarWidth - (panesOpen ? paneWidth + PANE_SPLITTER_WIDTH : 0) - RAIL_CHAT_MIN);
	const railShown = !isCloud && railOpen && railWidth <= railCap;
	const model = session.model ?? settings.model;
	const effort = session.effort ?? settings.effort;
	const effortsFor = (id: string): string[] => {
		const info = models.find((item) => item.id === id);
		return info?.efforts.length ? info.efforts : EFFORTS.filter((item) => id !== "grok-4.5" || item !== "xhigh");
	};
	const efforts = effortsFor(model);
	const modelList = models.length ? models.map((item) => item.id).filter((id) => !Object.values(FAST_MODEL).includes(id)) : MODELS.filter((id) => !Object.values(FAST_MODEL).includes(id));
	const fastBase = Object.entries(FAST_MODEL).find(([, fast]) => fast === model)?.[0];
	const baseModel = fastBase ?? model;
	const fastOn = !!fastBase;
	const branchRead = branches[session.id];
	const branch = branchRead?.folder === session.folder ? branchRead.info : undefined;
	function folderUnavailable(item: Session) {
		if (item.environment !== "Local") { return false; }
		const read = branches[item.id];
		return missingFolders[item.id] === item.folder || (read?.folder === item.folder && missingFolderError(read.info.error));
	}
	const folderMissing = !pending && folderUnavailable(session);
	const titleBranch = isCloud ? session.cloud?.branch ?? session.branch : branch?.ok && branch.repo !== false ? branch.branch : undefined;
	const worktreeReason = !session.folder ? "Choose a project folder first."
		: sandboxWanted(session) && PLATFORM === "win32" ? WINDOWS_SANDBOX_WORKTREE
		: setup.result?.git.ok === false ? "Git is not installed."
		: !window.grokCode?.branchInfo || !window.grokCode.addWorktree ? "Reopen this window to use worktrees."
		: !branch ? "Checking the folder for Git…"
		: !branch.ok ? branch.error || "The folder could not be checked for Git."
		: branch.repo === false ? "This folder is not a Git checkout."
		: "";
	const sandboxBlocked = PLATFORM === "win32" && (pending ? useWorktree : !!session.worktreeFolder);
	function setSessionSandbox(patch: Pick<Session, "sandboxOn" | "sandboxChoice">) {
		if (pending) { setPending((current) => current ? { ...current, ...patch } : current); } else { void saveLocalSendSettings(session.id, patch); }
	}

	useEffect(() => {
		const api = window.grokCode;
		if (session.environment !== "Local" || !session.folder || !api?.branchInfo) { return; }
		const { id, folder } = session;
		let cancel = false;
		void api.branchInfo(folder).catch(() => ({ ok: false })).then((info) => {
			if (!cancel) { setBranches((current) => ({ ...current, [id]: { folder, info } })); }
		});
		return () => { cancel = true; };
	}, [session.id, session.folder, session.environment, diffTick]);

	const progressiveChanges = !!window.grokCode?.readChanges && !!window.grokCode?.stopChanges;
	const wantsChangeList = progressiveChanges && (diffOpen || railShown) && !!session.folder;
	const changesContext = JSON.stringify([session.id, session.folder, scope]);
	const changesKey = JSON.stringify([changesContext, diffTick, diffOpen]);
	const inventory = changeList?.key === changesKey ? changeList.snapshot : undefined;
	const shownInventory = inventory ?? (changeList?.context === changesContext && changeList.snapshot.ok ? changeList.snapshot : undefined);
	const patchTarget = inventory?.files?.find((file) => file.path === diffFile) ?? inventory?.files?.[0];
	const patchKey = diffOpen && patchTarget ? JSON.stringify([changeList?.revision, patchTarget.path]) : "";
	const activePatch = changePatch?.key === patchKey ? changePatch : undefined;
	const knownMarks = changeMarks?.key === changesKey ? changeMarks.values : undefined;
	const paneChanges = useMemo(() => {
		if (!shownInventory?.files || (!activePatch?.file && !knownMarks?.size)) { return shownInventory; }
		return { ...shownInventory, files: shownInventory.files.map((file) => {
			const patch = activePatch?.file;
			if (patch?.path === file.path) { return { ...file, ...patch, additions: file.additions ?? patch.additions, deletions: file.deletions ?? patch.deletions, patchLoaded: true }; }
			const patchFingerprint = knownMarks?.get(file.path);
			return patchFingerprint ? { ...file, patchFingerprint } : file;
		}) };
	}, [shownInventory, activePatch?.file, knownMarks]);

	function cancelChangeRead(read: ChangeRead) {
		if (changeRead.current !== read) { return; }
		changeRead.current = null;
		void window.grokCode?.stopChanges?.(read.id).catch(() => {});
	}

	function readChanges(key: string, input: Omit<ChangesRequest, "id">, onResult: (snapshot: DiffSnapshot) => void): ChangeRead {
		if (changeRead.current) { cancelChangeRead(changeRead.current); }
		const read = { id: crypto.randomUUID(), key, patch: input.file !== undefined };
		changeRead.current = read;
		const finish = (result: DiffSnapshot) => {
			if (changeRead.current !== read) { return; }
			changeRead.current = null;
			onResult(result);
		};
		void window.grokCode?.readChanges?.({ ...input, id: read.id }).then(finish).catch(() => finish({ ok: false, error: read.patch ? "The file diff could not be read." : "The changed files could not be read." }));
		return read;
	}

	useEffect(() => {
		setChangeMarks(undefined);
		if (!wantsChangeList) { setChangeList(undefined); return; }
		setChangeList((current) => current?.key === changesKey ? { ...current, key: "" } : current);
		const read = readChanges(changesKey, { cwd: session.folder, scope }, (snapshot) => setChangeList({ key: changesKey, context: changesContext, revision: read.id, snapshot }));
		return () => cancelChangeRead(read);
	}, [wantsChangeList, changesKey]);

	function rememberChangeMark(file: string, fingerprint: string | null) {
		setChangeMarks((current) => {
			const existing = current?.key === changesKey ? current.values : undefined;
			if (!fingerprint && !existing?.has(file)) { return current; }
			const values = new Map(existing);
			if (fingerprint) { values.set(file, fingerprint); } else { values.delete(file); }
			return { key: changesKey, values };
		});
	}

	function loadChangePatch(full = false) {
		if (!patchKey || !patchTarget) { return; }
		const { path: file, from } = patchTarget;
		setChangePatch((current) => ({ key: patchKey, file: full && current?.key === patchKey ? current.file : undefined, loading: true }));
		readChanges(patchKey, { cwd: session.folder, scope, file, ...(from ? { from } : {}), full }, (snapshot) => {
			const result = snapshot.ok ? snapshot.files?.find((entry) => entry.path === file) : undefined;
			if (!result) {
				setChangePatch((current) => ({ ...current, key: patchKey, loading: false, error: snapshot.error || "This file is no longer in the changes. Refresh the list." }));
				return;
			}
			setChangePatch({ key: patchKey, file: result, loading: false, full });
			const mark = viewed[session.id]?.[file];
			if (mark) {
				const matches = !result.truncated && result.hunks.length > 0 && result.hunks.every((hunk) => hunk.reviewable !== false) && result.hunks.map((hunk) => hunk.id).join("\n") === mark;
				rememberChangeMark(file, matches ? mark : null);
			}
		});
	}

	useEffect(() => {
		if (!patchKey) { setChangePatch(undefined); return; }
		if (changeRead.current && !changeRead.current.patch) { return; }
		loadChangePatch();
		return () => {
			const read = changeRead.current;
			if (read?.patch && read.key === patchKey) { cancelChangeRead(read); }
		};
	}, [patchKey]);

	function stopChangeLoad() {
		const read = changeRead.current;
		if (!read) { return; }
		cancelChangeRead(read);
		if (read.patch) {
			setChangePatch((current) => ({ key: read.key, file: current?.key === read.key ? current.file : undefined, loading: false, error: "Diff loading stopped." }));
		} else {
			setChangeList({ key: read.key, context: changesContext, revision: read.id, snapshot: { ok: false, error: "Stopped reading changed files." } });
		}
	}

	useEffect(() => {
		if (progressiveChanges || (!diffOpen && !railShown) || !session.folder) { return; }
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
		return () => { cancel = true; };
	}, [progressiveChanges, diffOpen, railShown, session.id, session.folder, diffTick, scope]);

	useEffect(() => {
		if ((!diffOpen && !railShown) || !session.folder) { return; }
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
		const id = session.id;
		const folder = session.folder;
		const request = sandboxGitSession(session) ? api.prCreate(folder, branch?.branch, { sandbox: true }) : api.prCreate(folder, branch?.branch);
		return request.then((result) => {
			const number = result.ok && /\/pull\/(\d+)/.exec(result.url ?? "")?.[1];
			if (number) {
				setSessions((current) => current.map((item) => item.id === id && folderKey(item.folder) === folderKey(folder) ? { ...item, prWatch: { number: Number(number), failing: [], seenAt: new Date().toISOString() } } : item));
			}
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
			const skills = skillCommands?.folder === session.folder ? skillCommands.names : undefined;
			const groups: Record<CommandGroup, GrokCommand[]> = {
				App: isCloud ? BUILT_INS.filter((item) => CLOUD_APP_COMMANDS.has(item.name)) : BUILT_INS,
				Grok: isCloud ? [] : commands.filter((item) => !skills?.has(item.name)),
				Skills: isCloud ? [] : commands.filter((item) => skills?.has(item.name)),
			};
			const items = COMMAND_GROUPS.flatMap((group) => groups[group].flatMap((item) => {
				if (names.has(item.name) || !item.name.toLowerCase().includes(needle)) { return []; }
				names.add(item.name);
				return [{ group, value: `/${item.name} `, label: `/${item.name}`, detail: item.description, hint: item.hint }];
			}));
			return { kind: "slash" as const, needle, items };
		}
		const mention = /(?:^|\s)@([\w./-]*)$/.exec(prompt);
		if (mention && !isCloud) {
			const needle = mention[1].toLowerCase();
			const files = (folderLists[session.id]?.files ?? []).filter((file) => file.toLowerCase().includes(needle)).slice(0, 12);
			return { kind: "mention" as const, needle, items: files.map((file) => ({ value: file, label: file, detail: "", hint: "" })) };
		}
		return null;
	}, [prompt, popClosed, commands, skillCommands, folderLists, session.id, session.folder, isCloud]);

	const slashFolder = popup?.kind === "slash" && !isCloud && commands.length ? session.folder : "";
	useEffect(() => {
		const api = window.grokCode;
		if (!slashFolder || !api?.customize || (skillRequest.current?.folder === slashFolder && skillRequest.current.commands === commands)) { return; }
		const request = { folder: slashFolder, commands };
		skillRequest.current = request;
		const fail = () => {
			if (skillRequest.current === request) { skillRequest.current = null; setSkillCommands(null); }
		};
		void api.customize(slashFolder, true).then((result) => {
			if (skillRequest.current !== request) { return; }
			if (!result.ok) { fail(); return; }
			setSkillCommands({ folder: slashFolder, names: new Set(result.skills?.filter((skill) => !skill.disabled && skill.command).map((skill) => skill.command.replace(/^\//, ""))) });
		}).catch(fail);
	}, [slashFolder, commands]);

	const popIndex = Math.max(0, popup?.items.findIndex((item) => item.value === popValue) ?? 0);
	const activePopValue = popup?.items[popIndex]?.value;
	useEffect(() => { setPopValue(null); }, [popup?.kind, popup?.needle]);
	useEffect(() => {
		popupList.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
	}, [activePopValue, popIndex, popup?.kind, popup?.needle]);

	// Opening a session reads it; "Mark as unread" on the open session stays until you leave it.
	useEffect(() => {
		if (pending || grokBotOpen || !session.unread) { return; }
		const id = session.id;
		setSessions((current) => current.map((item) => (item.id === id ? { ...item, unread: false } : item)));
	}, [session.id, !!pending, grokBotOpen]);

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

	function renderPopupItem(item: NonNullable<typeof popup>["items"][number], index: number) {
		return <button key={item.value} type="button" role="option" aria-selected={index === popIndex} className={index === popIndex ? "item on" : "item"} onMouseEnter={() => setPopValue(item.value)} onClick={() => pickPopup(index)}>
			{item.label}
			{item.detail && <small>{item.detail}</small>}
		</button>;
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
			if (item.archived || item.pinned || turnTargets.current[item.id] || turnTargets.current[`side-${item.id}`] || item.cloud?.active || (item.lastActivityAt ?? Date.now()) >= cutoff || autoArchiving.current.has(item.id)) { continue; }
			const api = window.grokCode;
			if (!item.worktreeFolder || !api?.removeWorktree || sharesFolder(item)) {
				updateSession(item.id, { archived: true });
				continue;
			}
			autoArchiving.current.add(item.id);
			void api.removeWorktree(item.folder, item.worktreeFolder, { force: false, branch: item.branch, autoArchive: true }).catch(() => null).then((result) => {
				if (result?.skipped) { return; }
				if (result && !result.ok && result.dirty) { setNotice(`Archived ${item.title}. ${result.error || "This worktree is not clean."} The worktree stays on disk.`); }
				updateSession(item.id, { archived: true });
			}).finally(() => {
				autoArchiving.current.delete(item.id);
			});
		}
	}, [settings.autoArchiveDays]);

	useEffect(() => {
		if (isCloud || !panes.includes("browser")) { return; }
		const id = session.id;
		void window.grokCode?.devScripts?.(session.folder).then((result) => setDevScripts((current) => ({ ...current, [id]: result.scripts ?? [] }))).catch(() => {});
	}, [panes, isCloud, session.id, session.folder]);

	function togglePane(id: SidePaneId) {
		if (isCloud && id !== "editor") { return; }
		if (id === "editor" && panes.includes("editor")) { flushEditor(); }
		setExpandedPane(null);
		setPanes((current) => (current.includes(id) ? current.filter((pane) => pane !== id) : [...current, id]));
		setFocusedPane(id);
		setMenu(null);
	}

	function showPane(id: SidePaneId) {
		if (isCloud && id !== "editor") { return; }
		openPane(id);
	}

	function openPane(id: SidePaneId) {
		setExpandedPane((current) => current === id ? current : null);
		setPanes((current) => (current.includes(id) ? current : [...current, id]));
		setFocusedPane(id);
	}

	function closePane(id: SidePaneId) {
		if (id === "editor") { flushEditor(); }
		setExpandedPane((current) => current === id ? null : current);
		setPanes((current) => current.filter((pane) => pane !== id));
		setFocusedPane((current) => (current === id ? null : current));
	}

	function movePane(id: SidePaneId, step: -1 | 1) {
		setPanes((current) => {
			const index = current.indexOf(id);
			const next = index + step;
			if (index < 0 || next < 0 || next >= current.length) { return current; }
			const reordered = [...current];
			[reordered[index], reordered[next]] = [reordered[next], reordered[index]];
			return reordered;
		});
		setExpandedPane(null);
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

	function selectSession(id: string, find?: string, saved?: History | null) {
		if (!modesRef.current[id]) {
			const stored = saved === undefined ? readHistory() : saved;
			const savedMode = stored?.modes[id];
			if (savedMode) {
				modesRef.current = { ...modesRef.current, [id]: savedMode };
				setModes(modesRef.current);
			}
			const savedPrePlan = stored?.prePlan[id];
			if (savedPrePlan) { setPrePlan((current) => current[id] ? current : { ...current, [id]: savedPrePlan }); }
		}
		flushEditor();
		leaveForm();
		setExpandedPane(null);
		setActiveId(id);
		setMenu(null);
		if (find) { setFindAt((current) => ({ tick: current.tick + 1, text: find })); }
		setSessions((current) => (current.some((item) => item.id === id && item.unread) ? current.map((item) => (item.id === id ? { ...item, unread: false } : item)) : current));
		readColdLoops(id);
	}

	// The newest entry that can still be shown and isn't on screen now.
	function trailStop(stack: string[]) {
		for (let index = stack.length - 1; index >= 0; index--) {
			const entry = stack[index];
			const showable = entry === "page:grok-bot" ? !!(grokBot.status.signedIn || botWindow) : entry.startsWith("page:") || sessions.some((item) => item.id === entry);
			if (entry !== place && showable) { return index; }
		}
		return -1;
	}

	// Back from a new-session form returns to the session shown before it, and keeps the form's text.
	const formOver = place === activeId && !!pending && pending.id !== activeId && sessions.some((item) => item.id === activeId);

	function travel(back: boolean) {
		if (back && formOver) {
			selectSession(activeId);
			return;
		}
		const stack = back ? trail.back : trail.forward;
		const index = trailStop(stack);
		if (index < 0) { return; }
		const target = stack[index];
		const rest = stack.slice(0, index);
		setTrail(back ? { back: rest, forward: [...trail.forward, place] } : { back: [...trail.back, place], forward: rest });
		travelTo.current = target;
		setRoutinesOpen(target === "page:routines");
		setSettingsOpen(target === "page:settings" ? "general" : null);
		setGrokBotOpen(target === "page:grok-bot");
		if (!target.startsWith("page:") && target !== activeId) { selectSession(target); }
	}

	function createSession(seed?: Partial<ProjectSeed>) {
		flushEditor();
		setExpandedPane(null);
		const base = seed?.folder ? seed : { folder: session.folder, project: session.project, branch: session.branch, worktree: session.project, environment: "Local" as Environment };
		// A form with text, on screen or kept, comes back with it; a folder picked in the sidebar still applies.
		const kept = formWithText() ?? keptForm.current;
		keptForm.current = null;
		const reopen = kept && !seed?.folder;
		const created = reopen ? kept.session : { ...newSession(base, kept?.session.parentId), ...(kept ? { id: kept.session.id } : {}) };
		setPending(created);
		setUseWorktree(reopen ? kept.useWorktree : false);
		setMenu(null);
		setSideOpen(false);
		setTimeout(() => promptRef.current?.focus?.(), 0);
	}

	function choosePendingFolder(folder: string, draftId = pendingRef.current?.id) {
		const draft = pendingRef.current;
		if (!draft || draft.id !== draftId || !folder) { return; }
		const changed = folderKey(draft.folder) !== folderKey(folder);
		const project = shortPath(folder);
		const next = { ...draft, folder, project, worktree: project };
		pendingRef.current = next;
		setPending(next);
		if (draft.id === firstSessionId.current) {
			const apply = (items: Session[]) => items.map((item) => item.id === draft.id ? { ...item, folder, project, worktree: project } : item);
			sessionsRef.current = apply(sessionsRef.current);
			setSessions(apply);
		}
		if (changed) { setUseWorktree(false); }
		setMenu(null);
	}

	function pickPendingFolder() {
		const draft = pendingRef.current;
		const api = window.grokCode;
		if (!draft || !api?.pickFolder) { return; }
		void api.pickFolder().then((folder) => {
			if (folder && pendingRef.current?.folder === draft.folder) { choosePendingFolder(folder, draft.id); }
		}).catch(() => setNotice("The folder picker could not open."));
	}

	function choosePendingEnvironment(environment: Environment) {
		if (!pending || environment === pending.environment || environment === "SSH" || (environment === "Cloud" && !cloudKeyAvailable)) { setMenu(null); return; }
		setCloudSetup(null);
		setMenu(null);
		setUseWorktree(false);
		setPending((item) => item?.id === pending.id ? { ...item, environment, cloud: undefined, cloudModelLabel: undefined, cloudMachineDraft: undefined } : item);
	}

	function stepSession(step: number) {
		const currentId = pendingRef.current ? "" : activeIdRef.current;
		const shownActivity: Record<string, "running" | "needs-you"> = {};
		for (const [id, list] of Object.entries(extraChats)) {
			if (list.some((message) => message.tools?.some((tool) => tool.waiting))) { shownActivity[id] = "needs-you"; }
		}
		for (const [id, isBusy] of Object.entries(busy)) {
			if (isBusy && !id.startsWith("side-") && !shownActivity[id]) { shownActivity[id] = "running"; }
		}
		const list = sidebarSessionIds({
			sessions: sessionsRef.current.filter((item) => item.id !== firstSessionId.current || item.folder),
			chats: extraChats,
			query,
			view: readSidebarView(),
			sections: readSidebarSections(),
			activity: shownActivity,
			activeId: currentId,
		});
		if (!list.length) { return; }
		const found = list.findIndex((id) => id === currentId);
		const index = found < 0 ? (step < 0 ? 0 : -1) : found;
		selectSession(list[(index + step + list.length) % list.length]);
	}

	async function resumeCloud(item: Session) {
		const resume = window.grokCode?.cloudResume;
		const { cloud, id } = item;
		const turnId = cloud?.turnId;
		if (turnTargets.current[id]) { return true; }
		if (!resume || !cloud || !turnId) {
			setHeld((current) => ({ ...current, [id]: true }));
			setNotice("This Cursor run could not be resumed.");
			return false;
		}
		const target: TurnTarget = { sessionId: id, replyId: `grok-${turnId}`, turnId, where: "main", awaitingReplay: true };
		rememberReply(id, target);
		setBusy((current) => ({ ...current, [id]: true }));
		const fallback = "This Cursor run could not be resumed.";
		const result = await resume({ uiSessionId: id, turnId, cloud }).catch(() => ({ ok: false, error: fallback }));
		if (result.ok) { return true; }
		const currentTarget = replyTargets.current[id]?.[turnId];
		if (currentTarget && !currentTarget.finished) {
			finishReply(id, currentTarget);
			setHeld((current) => ({ ...current, [id]: true }));
			setNotice(result.error || fallback);
		}
		return false;
	}

	function stop(uiId: string) {
		setHeld((current) => ({ ...current, [uiId]: true }));
		const item = sessionsRef.current.find((entry) => entry.id === uiId);
		if (item?.environment === "Cloud") {
			const cancel = window.grokCode?.cloudCancel;
			const fallback = "Cursor could not stop this run. Check https://cursor.com/agents.";
			if (!cancel) { setNotice(fallback); return; }
			void (async () => {
				if (!turnTargets.current[uiId] && item.cloud?.active && !await resumeCloud(item)) { return; }
				if (!turnTargets.current[uiId]) { return; }
				const result = await cancel(uiId).catch(() => ({ ok: false, error: fallback }));
				if (!result.ok) { setNotice(result.error || fallback); }
			})();
			return;
		}
		void window.grokCode?.cancel(uiId);
	}

	function sharesFolder(item: Session) {
		return sessionsRef.current.some((other) => other.id !== item.id && !other.archived && folderKey(other.folder) === folderKey(item.folder));
	}

	function folderBusy(item: Session) {
		return item.environment !== "Cloud" && sessionsRef.current.some((other) => other.id !== item.id && other.environment !== "Cloud" && !other.archived && folderKey(other.folder) === folderKey(item.folder) && (busy[other.id] || busy[`side-${other.id}`]));
	}

	function noteFolderClash(item: Session) {
		if (collisionSeen[item.id] || !folderBusy(item)) { return; }
		setCollisionSeen((current) => (current[item.id] ? current : { ...current, [item.id]: true }));
	}

	async function chooseSessionFolder() {
		const api = window.grokCode;
		if (!api?.pickFolder) { setNotice("Choose the folder from the desktop window."); return; }
		const { id, folder } = session;
		try {
			const picked = await api.pickFolder();
			if (!picked || turnTargets.current[id] || !sessionsRef.current.some((item) => item.id === id && item.folder === folder)) { return; }
			// Grok's previous folder and its Always allow rules cannot follow the new folder.
			await api.forgetSession?.(id);
			const name = shortPath(picked);
			const worktreeFolder = folderKey(picked) === folderKey(folder) ? session.worktreeFolder : undefined;
			if (!await saveLocalSendSettings(id, { folder: picked, project: name, worktree: name, worktreeFolder, agentSessionId: undefined, sandbox: undefined, sandboxContextPending: undefined, allowedFolders: undefined, prWatch: undefined }, folder)) { return; }
			setMissingFolders((current) => ({ ...current, [id]: "" }));
			setBranches((current) => ({ ...current, [id]: undefined }));
			setDiffTick((value) => value + 1);
			setSideAgents((list) => Object.fromEntries(Object.entries(list).filter(([sessionId]) => sessionId !== id)));
			delete sideSeen.current[id];
			if (activeIdRef.current === id && !pendingRef.current) { setMenu(null); promptRef.current?.focus?.(); }
		} catch {
			setNotice("The session folder could not be changed.");
		}
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

	routineFire.current = ({ runId, routineId, sessionId, title, project, folder, model, effort, mode, text }) => {
		if (!runId || !sessionId || !mode || sessionsRef.current.some((item) => item.id === sessionId)) { return; }
		// `visible` falls back to the first open session when activeId matches nothing, so this new first session would take over the screen.
		if (!pendingRef.current && !sessionsRef.current.some((item) => item.id === activeId)) { setActiveId(session.id); }
		const created: Session = { ...newSession({ folder, project, worktree: project, environment: "Local" }), id: sessionId, title: title ?? "Routine", titleAuto: false, model, effort, routineId };
		sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
		setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
		changeMode(sessionId, mode);
		// Only Auto-review: in Normal, cards are how a routine somebody supervises gets its approvals, and Always-approve never asks.
		if (!send(text ?? "", false, sessionId, [], false, [], { runId, unattended: mode === "Auto-review" })) {
			updateSession(sessionId, { failed: true, unread: true });
			void window.grokCode?.routineResult?.(runId, { ok: false, error: "This window could not start the run." });
		}
	};

	routineOpen.current = ({ sessionId, agentSessionId }) => {
		// A notification's click already brought this window forward, and a half-written routine stays.
		if (document.querySelector?.("[data-routine-form]")) { return; }
		setSettingsOpen(null);
		setGrokBotOpen(false);
		setRoutinesOpen(false);
		const existing = sessionId ? sessionsRef.current.find((item) => item.id === sessionId) ?? readHistory()?.sessions.find((item) => item.id === sessionId) : undefined;
		if (existing) { showExistingCli(existing); return; }
		if (agentSessionId) { openCliSession(agentSessionId); return; }
		setRoutinesOpen(true);
		if (sessionId) { setNotice("That run's chat is no longer in this window."); }
	};

	function openPromptLibrary(mode: "save" | "insert") {
		const field = promptRef.current;
		overlayOpener.current = null;
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
		stop: () => { if (busy[session.id] || session.cloud?.active) { stop(session.id); } },
		cycleView: () => setViews((current) => ({ ...current, [session.id]: VIEWS[(VIEWS.indexOf(current[session.id] ?? settingsRef.current.defaultView) + 1) % VIEWS.length] })),
		find: () => setFindTick((value) => value + 1),
		side: () => { if (!isCloud) { setSideOpen((value) => !value); } },
		savedPrompts: () => openPromptLibrary("insert"),
		terminal: () => togglePane("terminal"),
		diff: () => togglePane("diff"),
		browser: () => togglePane("browser"),
		select: () => { if (!isCloud) { showPane("browser"); setSelectTick((value) => value + 1); } },
		mode: () => { if (!isCloud) { setMenu("mode"); } },
		model: () => { if (!isCloud || !cloudModelLocked) { setMenu("model"); } },
		effort: () => { if (!isCloud) { setMenu("effort"); } },
		closePane: () => { const target = focusedPane && shownPaneIds.includes(focusedPane) ? focusedPane : shownPaneIds[shownPaneIds.length - 1]; if (target) { closePane(target); } },
		restorePane: () => { if (!fullPane) { return false; } setExpandedPane(null); return true; },
	};

	const slashActions: Record<string, (arg: string) => void | Promise<void>> = {
		usage: () => showUsage("/usage"),
		cost: () => showUsage("/cost"),
		new: () => keyActions.current.newSession?.(),
		rename: (arg) => { if (arg) { renameSession(session.id, arg); } else { setRenaming(session.id); } },
		delete: async () => {
			if (isCloud && (turnTargets.current[session.id] || session.cloud?.active)) { setNotice("Stop this session first."); return; }
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
		plan: () => requestMode(session.id, "Plan"),
		auto: () => requestMode(session.id, "Auto-review"),
		model: () => keyActions.current.model?.(),
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
			if (event.isComposing) { return; }
			if (document.querySelector?.("[data-commit-dialog]") || document.querySelector?.("[data-saved-prompts-dialog]")) { return; }
			// An open confirm owns the keyboard: Escape cancels it without acting underneath it.
			if (confirmShown.current) {
				if (event.key === "Escape") { event.preventDefault(); answerRef.current(false); }
				return;
			}
			// So does a running sandbox setup job, wherever focus is: leaving its panel stops the job, and Escape must not stop the turn behind it.
			if (document.querySelector?.("[data-sandbox-job]")) { return; }
			// The Files editor handled this key; the app's shortcut must not run too.
			if (event.defaultPrevented && (event.target as Element | null)?.closest?.(".cm-editor")) { return; }
			if ((event.target as Element | null)?.closest?.(".xterm")) { return; }
			const run = (name: string) => { event.preventDefault(); keyActions.current[name]?.(); };
			const key = event.key.toLowerCase();
			if (event.key === "Escape") {
				// Esc closes whatever is open; only with nothing open does it stop Grok.
				const target = event.target as Element | null;
				if (setupFromAbout.current) { closeSetup(); return; }
				if (overlayOpen.current) {
					setMenu(null);
					setFileMenu(null);
					setShortcuts(false);
					setPromptLibrary(null);
					setRewindAsk(null);
					setSettingsOpen(null);
					// Wherever focus is, Escape never throws away a half-written routine. Only Save or Cancel leaves the form.
					if (!document.querySelector?.("[data-routine-form]")) { setRoutinesOpen(false); }
					setSetup((current) => ({ ...current, open: false }));
					return;
				}
				if (grokBotShown.current) { event.preventDefault(); escapeStopAfter.current = Date.now() + ESCAPE_STOP_GRACE_MS; setGrokBotOpen(false); return; }
				if (target?.closest?.(".side-q")) { setSideOpen(false); return; }
				if (keyActions.current.restorePane?.()) { event.preventDefault(); return; }
				if (target?.closest?.(".side-col, .session-rail")) { return; }
				if (Date.now() < escapeStopAfter.current) { return; }
				keyActions.current.stop?.();
				return;
			}
			if (setupFromAbout.current || grokBotShown.current) { return; }
			if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !settingsShown.current && document.querySelector(".pop")) {
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
			if (event.shiftKey && key === "m") { run("mode"); return; }
			if (event.shiftKey && key === "i") { run("model"); return; }
			if (event.shiftKey && key === "e") { run("effort"); return; }
			if (!event.altKey && !event.getModifierState?.("AltGraph")) {
				if (key === "/" || (!event.shiftKey && event.code === "Slash")) { event.preventDefault(); setShortcuts(true); return; }
				if (key === ";" || (!event.shiftKey && event.code === "Semicolon")) { run("side"); return; }
				if (key === "\\" || (!event.shiftKey && event.code === "Backslash")) { run("closePane"); return; }
			}
			if (event.shiftKey) { return; }
			if (event.altKey) {
				if (event.key === "1") { run("newSession"); }
				return;
			}
			if (key === "f") { run("find"); return; }
			if (key === "n") { run("newSession"); return; }
			if (key === "o") { run("cycleView"); return; }
			if (key === ",") { event.preventDefault(); setSettingsOpen("general"); return; }
			if (event.code === "Backquote" || key === "`") { if (!event.repeat) { run("terminal"); } return; }
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
	function send(text: string, side: boolean, targetId = session.id, files: string[] = [], steer = false, contextFrom: ContextPick[] = [], routine?: { runId: string; unattended: boolean }) {
		const body = text.trim();
		const previousTarget = sessionsRef.current.find((item) => item.id === targetId);
		if (!body || !previousTarget) { return false; }
		const saved = previousTarget.environment === "Local" ? readHistory(undefined, true) : null;
		if (refuseDeletedChat(targetId, saved ?? undefined)) { return false; }
		// The history write can reach storage before the other window receives its storage event.
		if (saved) { adoptLocalSendSettings(saved, targetId); }
		const target = sessionsRef.current.find((item) => item.id === targetId)!;
		if (!target.folder) { setNotice("Choose a project folder before sending."); return false; }
		const sessionId = target.id;
		const picks = side ? [] : contextPicksFrom(contextFrom, sessionId);
		const uiId = side ? `side-${sessionId}` : sessionId;
		const folder = target.folder;
		if (target.environment === "Local") { refreshSandboxProfile(); }
		const current = settingsRef.current;
		const chosenModel = target.model ?? current.model;
		const chosenEffort = target.effort ?? current.effort;
		const chosenMode = side ? "Normal" : knownMode(modesRef.current[sessionId] ?? current.defaultMode, current);
		const cloud = target.environment === "Cloud";
		const api = window.grokCode;
		if (target.environment === "SSH") { setNotice("SSH execution is not available."); return false; }
		if (folderUnavailable(target)) { return false; }
		// Settings profiles apply on either conversation's next use. Checkbox changes wait for a main-chat message.
		const sideSession = target.folder === previousTarget.folder && target.sandbox === previousTarget.sandbox ? sideAgents[sessionId] : undefined;
		const conversation = side && sideSession ? { ...target, ...sideSession } : target;
		const profileSession = (side || body.startsWith("/")) && conversation.sandbox?.option === "profile" ? { ...conversation, sandboxOn: true } : conversation;
		const profileChanging = sandboxProfileChanging(profileSession, current);
		const changing = sandboxChanging(target) || profileChanging;
		const changeSandbox = profileChanging || (changing && !side && !body.startsWith("/"));
		const carrySandboxContext = !side && !body.startsWith("/") && (changeSandbox || target.sandboxContextPending === true);
		const sandbox = changing && !changeSandbox ? conversation.sandbox : sandboxFor(profileSession, current);
		if (sandbox && target.worktreeFolder && PLATFORM === "win32") { setNotice(WINDOWS_SANDBOX_WORKTREE); return false; }
		if (cloud && side) { setNotice("Side chat is unavailable in Cloud sessions."); return false; }
		if (cloud && (files.length || picks.length)) { setNotice(CLOUD_ATTACHMENTS); return false; }
		if (cloud && (!target.cloud || !api?.cloudSend)) { setNotice("Cursor cloud is unavailable for this session."); return false; }
		if (!side) { noteFolderClash(target); }
		if (!side) { invalidateSuggestion(sessionId); }
		if (turnTargets.current[uiId] || (!side && branching === sessionId) || (cloud && (target.cloud?.active || (steer && queuedRef.current[sessionId]?.length)))) {
			if (side) {
				setNotice(SIDE_BUSY);
				return false;
			}
			const item = { id: crypto.randomUUID(), text: body, attachments: files, ...(picks.length ? { contextFrom: picks } : {}) };
			// Attachments, earlier-chat context and commands cannot go into a running turn, so they wait; a steer Grok refuses joins the queue.
			if (!cloud && steer && !profileChanging && !target.sandboxContextPending && turnTargets.current[uiId] && api?.steer && !files.length && !picks.length && !body.startsWith("/")) {
				void steerQueued(item, sessionId, true);
				return true;
			}
			setHeld((list) => ({ ...list, [sessionId]: false }));
			setQueued((list) => ({ ...list, [sessionId]: [...(list[sessionId] ?? []), item] }));
			if (cloud && target.cloud?.active && !turnTargets.current[uiId]) { void resumeCloud(target); }
			return true;
		}
		if (!cloud && !target.model) { updateSession(sessionId, { model: chosenModel, effort: chosenEffort }); }
		if (!side) {
			setHeld((list) => ({ ...list, [sessionId]: false }));
			if (!cloud && !modesRef.current[sessionId]) { changeMode(sessionId, chosenMode); }
		}
		if (!side && target.title === "New session" && target.titleAuto !== false) {
			const title = body.replace(/\s+/g, " ").slice(0, 48);
			setSessions((list) => list.map((item) => (item.id === sessionId && item.title === "New session" ? { ...item, title, titleAuto: true, detail: "Live", when: "now" } : item)));
		}
		const stamp = Date.now();
		const turnId = crypto.randomUUID();
		const replyId = `${side ? "side-grok" : "grok"}-${cloud ? turnId : stamp}`;
		const replyTarget: TurnTarget = { sessionId, replyId, turnId, where: side ? "side" : "main" };
		rememberReply(uiId, replyTarget);
		const userMessage: ChatMessage = { id: `${side ? "side-user" : "user"}-${cloud ? turnId : stamp}`, role: "user", text: body, at: stamp, live: true, ...(files.length ? { attachments: files } : {}), ...(picks.length ? { contextFrom: picks } : {}) };
		const replyMessage: ChatMessage = { id: replyId, role: "grok", text: "", pending: true, streaming: true, live: true };
		const store = side ? setSideChats : setExtraChats;
		store((list) => ({ ...list, [sessionId]: [...(list[sessionId] ?? []), userMessage, replyMessage] }));
		if (!side) { setSessions((list) => list.map((item) => (item.id === sessionId ? { ...item, lastActivityAt: stamp, completed: false } : item))); }
		if (!api) {
			writeReply(uiId, (message) => replyWithNote({ ...message, at: Date.now() }, "Open this window from the desktop app to talk to Grok."), false, replyTarget);
			finishReply(uiId, replyTarget);
			return true;
		}
		setBusy((list) => ({ ...list, [uiId]: true }));
		if (cloud && target.cloud && api.cloudSend) {
			const fallback = "Cursor could not start this turn.";
			const name = ((extraChats[sessionId] ?? []).find((message) => message.role === "user")?.text ?? body).slice(0, 80);
			void api.cloudSend({ uiSessionId: uiId, turnId, text: body, name, cloud: target.cloud }).catch(() => ({ ok: false, error: fallback })).then((result) => {
				if (result.ok || replyTarget.finished) { return; }
				setHeld((list) => ({ ...list, [sessionId]: true }));
				updateSession(sessionId, { failed: true });
				writeReply(uiId, (message) => replyWithNote({ ...message, at: Date.now() }, result.error || fallback), false, replyTarget);
				announceTurn(fallback, target.title);
				finishReply(uiId, replyTarget);
			});
			return true;
		}
		const sideAgent = changeSandbox ? undefined : sideSession?.agentSessionId;
		// A side question carries the main-chat messages it has not seen yet; a reply still streaming waits for the next one.
		const main = (extraChats[sessionId] ?? []).filter((message) => !message.streaming);
		const seen = sideAgent ? main.findIndex((message) => message.id === sideSeen.current[sessionId]) : -1;
		const blocks = picks.map((pick) => contextSnapshot(pick.title, extraChats[pick.id] ?? []));
		const outgoing = side ? `${sideContext(main.slice(seen + 1))}${body}` : contextForGrok(carrySandboxContext ? [contextSnapshot(target.title, main), ...blocks] : blocks, body);
		// A run that never started has failed, so its sidebar row says so. A Stop or a closed window during the start has not.
		const routineStartFailed = (reason?: string) => {
			if (!side && target.routineId && reason !== "Stopped." && reason !== "Closed.") { updateSession(sessionId, { failed: true, unread: sessionId !== activeIdRef.current }); }
		};
		void api.send({
			uiSessionId: uiId,
			turnId,
			cwd: folder,
			text: outgoing,
			model: chosenModel,
			effort: chosenEffort,
			mode: chosenMode,
			agentSessionId: side ? sideAgent : changeSandbox ? undefined : target.agentSessionId,
			allowedFolders: target.allowedFolders ?? [],
			browser: !side && settings.browserControl && !sandbox && !target.routineId,
			...(routine ? { routineRunId: routine.runId } : {}),
			...(routine?.unattended ? { unattended: true } : {}),
			...(sandbox ? { sandbox } : {}),
			...(files.length ? { attachments: files } : {}),
		}).then((result) => {
			if (!side && result.ok) { sentModes.current[sessionId] = result.mode ?? chosenMode; }
			if (result.agentSessionId) {
				const agentId = result.agentSessionId;
				// A reply that lands after Choose a folder must not bring the old folder's side conversation back.
				const now = sessionsRef.current.find((item) => item.id === sessionId) ?? (pendingRef.current?.id === sessionId ? pendingRef.current : undefined);
				if (side) {
					if (now?.folder === folder) { setSideAgents((list) => ({ ...list, [sessionId]: { agentSessionId: agentId, sandbox } })); }
				} else {
					setSessions((list) => list.map((item) => (item.id === sessionId && item.folder === folder ? {
						...item, agentSessionId: agentId, sandbox,
						sandboxContextPending: body.startsWith("/") ? changeSandbox || item.sandboxContextPending : result.ok ? undefined : item.sandboxContextPending,
					} : item)));
				}
				if (changeSandbox && !side) {
					// Only a side chat still in the old sandbox needs to start over.
					if (!profileChanging || JSON.stringify(sideSession?.sandbox) !== JSON.stringify(sandbox)) {
						setSideAgents((list) => Object.fromEntries(Object.entries(list).filter(([id]) => id !== sessionId)));
						delete sideSeen.current[sessionId];
					}
					const carried = body.startsWith("/") ? "without earlier conversation. Your next main message will include the newest part of this conversation" : "with the newest part of this conversation";
					setNotice(`Sandbox is ${sandbox ? "on" : "off"}. Grok started a new session ${carried}.`, true);
				}
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
			} else if (result.ok && side && main.length) {
				sideSeen.current[sessionId] = main[main.length - 1].id;
			}
			if (result.ok) { return; }
			if (replyTarget.finished) { return; }
			if (missingFolderError(result.error) && sessionsRef.current.some((item) => item.id === sessionId && item.folder === folder)) {
				setMissingFolders((list) => ({ ...list, [sessionId]: folder }));
				if (queuedRef.current[sessionId]?.length) { setHeld((list) => ({ ...list, [sessionId]: true })); }
				if (!side && steer && (!draftsRef.current[sessionId] || draftsRef.current[sessionId].trim() === body)) {
					setDrafts((list) => list[sessionId] ? list : { ...list, [sessionId]: prompt.trim() === body ? prompt : body });
					if (files.length) { setAttachments((list) => ({ ...list, [sessionId]: [...new Set([...files, ...(list[sessionId] ?? [])])].slice(0, 20) })); }
					if (picks.length) { setContextPicks((list) => ({ ...list, [sessionId]: picks.reduce((current, pick) => addContextPick(current, pick), list[sessionId] ?? []) })); }
				}
			}
			routineStartFailed(result.error);
			writeReply(uiId, (message) => replyWithNote({ ...message, at: Date.now() }, result.error || "Grok could not start."), false, replyTarget);
			announceTurn(result.error === "Stopped." ? "Grok stopped." : "Grok could not start the turn.", target.title);
			finishReply(uiId, replyTarget);
		}).catch(() => {
			if (replyTarget.finished) { return; }
			routineStartFailed();
			writeReply(uiId, (message) => replyWithNote({ ...message, at: Date.now() }, "Grok could not start."), false, replyTarget);
			announceTurn("Grok could not start the turn.", target.title);
			finishReply(uiId, replyTarget);
		});
		return true;
	}

	useEffect(() => {
		for (const [sessionId, items] of Object.entries(queued)) {
			if (!items.length || queuedRef.current[sessionId] !== items || held[sessionId] || busy[sessionId] || turnTargets.current[sessionId] || branching === sessionId) { continue; }
			if (refuseDeletedChat(sessionId)) { setHeld((current) => ({ ...current, [sessionId]: true })); continue; }
			const target = sessionsRef.current.find((item) => item.id === sessionId);
			if (target && folderUnavailable(target)) {
				setHeld((current) => ({ ...current, [sessionId]: true }));
				continue;
			}
			if (target?.environment === "Cloud" && target.cloud?.active) { void resumeCloud(target); continue; }
			const [first] = items;
			if (target?.environment === "Cloud" && !send(first.text, false, sessionId, first.attachments, false, first.contextFrom ?? [])) {
				setHeld((current) => ({ ...current, [sessionId]: true }));
				continue;
			}
			setQueued((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((item) => item.id !== first.id) }));
			if (target?.environment !== "Cloud") { send(first.text, false, sessionId, first.attachments, false, first.contextFrom ?? []); }
		}
	}, [queued, held, busy, branching, branches, missingFolders]);

	function sendNow(sessionId: string, itemId: string) {
		if (refuseDeletedChat(sessionId)) { return; }
		const target = sessionsRef.current.find((item) => item.id === sessionId);
		if (target && folderUnavailable(target)) { return; }
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
		if (!typed) {
			const saved = readHistory(undefined, true);
			if (refuseDeletedChat(sessionId, saved ?? undefined)) { return; }
			if (saved) { adoptLocalSendSettings(saved, sessionId); }
			refreshSandboxProfile();
			const target = sessionsRef.current.find((entry) => entry.id === sessionId);
			const remote = saved?.sessions.find((entry) => entry.id === sessionId);
			if (target && (sandboxProfileChanging(target, settingsRef.current) || target.sandboxContextPending || (remote?.folder === target.folder && remote.sandboxContextPending))) { return; }
		}
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
		return { uiSessionId: session.id, cwd: session.folder, model: session.model ?? current.model, effort: session.effort ?? current.effort, mode: knownMode(modes[session.id] ?? current.defaultMode, current), agentSessionId: message.point!.agentSessionId, index: message.point!.index, text: message.text, ...(session.sandbox ? { sandbox: session.sandbox } : {}) };
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
		const forked: Session = { ...newSession({ folder: source.folder, project: source.project, branch: source.branch, worktree: source.worktree, environment: source.environment }, source.id), title: `${source.title} (fork)`, titleAuto: false, detail: "Fork", agentSessionId, model: source.model, effort: source.effort, allowedFolders: source.allowedFolders, worktreeFolder: source.worktreeFolder, sandbox: source.sandbox };
		setSessions((current) => [forked, ...current]);
		setExtraChats((list) => ({ ...list, [forked.id]: copied }));
		if (modes[source.id]) { changeMode(forked.id, modes[source.id]); }
		if (prePlan[source.id]) { setPrePlan((current) => ({ ...current, [forked.id]: prePlan[source.id] })); }
		selectSession(forked.id);
	}

	async function commitPending(): Promise<Session | null> {
		const draft = pendingRef.current;
		if (!draft) { return session; }
		if (!draft.folder) { return null; }
		let created = draft;
		if (draft.environment === "Cloud") {
			if (draft.id !== session.id || draft.folder !== session.folder || !cloudReady || !cloudSetupResult?.repoUrl || !cloudSetupResult.ref || !cloudChoice) {
				setNotice("Finish checking the Cloud session's repository and model before sending.");
				return null;
			}
			const { cloudMachineDraft, ...base } = draft;
			const machine = typeof cloudMachineDraft === "string" ? cloudMachineDraft.trim() : undefined;
			created = { ...base, branch: cloudSetupResult.ref, cloudModelLabel, cloud: {
				repoUrl: cloudSetupResult.repoUrl, ref: cloudSetupResult.ref, model: { id: cloudChoice.id, params: cloudChoice.params },
				autoCreatePR: machine ? false : draft.cloud?.autoCreatePR ?? false,
				...(machine ? { machine } : {}),
			} };
		} else if (useWorktree) {
			if (worktreeReason) { setNotice(worktreeReason); return null; }
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
			const source = sessionsRef.current.find((item) => item.id === draft.parentId && item.folder === draft.folder);
			const sandboxGit = sandboxGitSession(draft) || (source && sandboxGitSession(source));
			const result = await api.addWorktree(draft.folder, { name, prefix: settingsRef.current.branchPrefix, ...(sandboxGit ? { sandbox: true } : {}) }).finally(() => { creatingWorktree.current = false; });
			setNotices((list) => list.some((item) => item.text === "Creating the worktree…") ? list.filter((item) => item.text !== "Creating the worktree…") : list);
			if (!result.ok || !result.folder) {
				setNotice(result.error || "The worktree could not be created.");
				return null;
			}
			created = { ...draft, folder: result.folder, branch: result.branch ?? draft.branch, worktree: shortPath(result.folder), worktreeFolder: result.folder };
			setDrafts((current) => ({ ...current, [created.id]: current[draft.id] ?? "" }));
		}
		const formNow = pendingRef.current;
		const keepForm = !!formNow && formNow.id !== draft.id;
		sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
		setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
		if (!keepForm) {
			setActiveId(created.id);
			pendingRef.current = null;
			setPending(null);
		}
		return created;
	}

	function startWorktreeFromHere() {
		if (isCloud) { return; }
		const source = session;
		let target = pendingRef.current;
		if (!target) {
			if (keptForm.current && draftsRef.current[keptForm.current.session.id]) {
				setNotice("Finish or clear the unsent New session draft before starting another worktree.");
				return;
			}
			flushEditor();
			target = { ...newSession({ folder: source.folder, project: source.project, branch: source.branch, worktree: source.worktree, environment: source.environment }, source.id), ...(source.model ? { model: source.model } : {}), ...(source.effort ? { effort: source.effort } : {}) };
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
		if (isCloud) { createSession({ folder: source.folder, project: source.project, environment: "Cloud" }); return; }
		const created: Session = { ...newSession({ folder: source.folder, project: source.project, branch: source.branch, worktree: source.worktree, environment: source.environment }, source.id), ...(source.model ? { model: source.model } : {}), ...(source.effort ? { effort: source.effort } : {}) };
		sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
		setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
		selectSession(created.id);
	}

	// A command picked in Settings, such as /create-skill, goes to this session and leaves its draft alone.
	async function runFromSettings(text: string) {
		setSettingsOpen(null);
		if (isCloud) { setNotice("Local Grok commands are unavailable in Cloud sessions."); return; }
		const target = await commitPending();
		if (target) { send(text, false, target.id); }
	}

	function postLocal(text: string, lines: string[]) {
		const sessionId = session.id;
		const stamp = crypto.randomUUID();
		const at = Date.now();
		const appNote = lines.join("\n");
		setExtraChats((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { id: `user-${stamp}`, role: "user", text, at, live: true }, { id: `grok-${stamp}`, role: "grok", text: appNote, appNote, at, live: true }] }));
		setNotice(lines.join(" · "));
	}

	async function readLimit() {
		const epoch = signInEpoch.current;
		const request = ++limitRead.current;
		const result = await window.grokCode?.billing?.().catch(() => ({ ok: false as const, error: "Grok did not return usage." }));
		if (epoch !== signInEpoch.current) { return undefined; }
		if (request === limitRead.current) {
			if (result?.ok) { setLimit(result); }
			setLimitStale(!result?.ok);
		}
		return result;
	}

	async function showUsage(text: string) {
		const epoch = signInEpoch.current;
		const result = keyMode ? undefined : await readLimit();
		if (epoch !== signInEpoch.current) { return; }
		const lines = keyMode ? ["Subscription limits aren't shown in API-key mode."] : result?.ok ? [limitLine(result)] : [result?.error || "Grok did not return usage."];
		const percent = session.usage?.contextWindow ? Math.min(100, Math.round((session.usage.contextTokens / Math.max(1, session.usage.contextWindow)) * 100)) : null;
		if (percent !== null) { lines.push(`Context ${percent}%${keyMode || text === "/cost" ? ` · $${(session.costUsd ?? 0).toFixed(2)}` : ""}`); }
		postLocal(text, lines);
	}

	async function submit(value = prompt) {
		const text = value.trim();
		if (!text) {
			if (isCloud && queuedRef.current[session.id]?.length && held[session.id] && !busy[session.id]) { setHeld((current) => ({ ...current, [session.id]: false })); }
			return;
		}
		if (text === "/config") { setSettingsOpen("general"); setPrompt(""); return; }
		if (isCloud && text.startsWith("!") && text.length > 1) { setNotice("The local terminal is unavailable in Cloud sessions."); return; }
		if (text.startsWith("!") && text.length > 1 && pending) { setNotice("Send a first message to start this session, then run terminal commands with !."); return; }
		if (text.startsWith("!") && text.length > 1 && !pending) {
			if (folderMissing) { return; }
			setPrompt("");
			await runInTerminal(text.slice(1).trim());
			return;
		}
		if (text === "/status" || text === "/info") {
			const percent = session.usage?.contextWindow ? Math.min(100, Math.round((session.usage.contextTokens / Math.max(1, session.usage.contextWindow)) * 100)) : null;
			const lines = [
				appVersion.current ? `Codewomplers Grok Desktop ${appVersion.current}` : "Codewomplers Grok Desktop",
				isCloud ? `${cloudModelLabel} · ${session.cloud?.machine ?? "Cloud"}` : `${model} · ${effort} · ${mode}`,
				session.folder,
				...(percent != null ? [`Context ${percent}% · $${(session.costUsd ?? 0).toFixed(2)}`] : []),
			];
			postLocal(text, lines);
			setPrompt("");
			return;
		}
		const local = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text);
		const action = local ? slashActions[local[1]] : undefined;
		if (isCloud && local && !CLOUD_APP_COMMANDS.has(local[1]) && (action || local[1] === "btw" || local[1] === "loop" || commands.some((item) => item.name === local[1]))) {
			setNotice(local[1] === "btw" ? "Side chat is unavailable in Cloud sessions." : "Local Grok commands are unavailable in Cloud sessions.");
			return;
		}
		if (local && action) {
			const arg = (local[2] ?? "").trim();
			if (arg && !TAKES_ARG.has(local[1])) { setNotice(`/${local[1]} takes no argument.`); return; }
			if (pending && ["rename", "delete", "fork", "rewind", "copy"].includes(local[1])) { setNotice("Send a first message to start this session."); return; }
			setPrompt("");
			await action(arg);
			return;
		}
		if (folderMissing) { return; }
		if (text.startsWith("/btw ")) {
			setSideOpen(true);
			if (send(text.slice(5), true)) { setPrompt(""); }
			return;
		}
		const files = attachments[session.id] ?? [];
		const picks = contextPicks[session.id] ?? [];
		if (isCloud && (files.length || picks.length)) { setNotice(CLOUD_ATTACHMENTS); return; }
		const target = await commitPending();
		if (!target) { return; }
		if (send(text, false, target.id, files, true, picks)) {
			setDrafts((current) => ((current[target.id] ?? "") === prompt ? { ...current, [session.id]: "", [target.id]: "" } : current));
			setAttachments((current) => {
				const sent = new Set(files);
				const next = { ...current };
				for (const id of new Set([session.id, target.id])) {
					if (current[id] === undefined && files.length === 0) { continue; }
					next[id] = (current[id] ?? []).filter((file) => !sent.has(file));
				}
				return next;
			});
			setContextPicks((current) => {
				const sent = new Set(picks.map((pick) => pick.id));
				const next = { ...current };
				for (const id of new Set([session.id, target.id])) {
					if (current[id] === undefined && picks.length === 0) { continue; }
					next[id] = (current[id] ?? []).filter((pick) => !sent.has(pick.id));
				}
				return next;
			});
		}
	}

	function addAttachments(paths: string[]) {
		if (isCloud) { setNotice(CLOUD_ATTACHMENTS); return; }
		const sessionId = session.id;
		const clean = paths.filter(Boolean);
		if (!clean.length) { return; }
		setAttachments((current) => ({ ...current, [sessionId]: [...new Set([...(current[sessionId] ?? []), ...clean])].slice(0, 20) }));
	}

	function onDrop(event: DragEvent) {
		const api = window.grokCode;
		if (!event.dataTransfer?.files?.length) { return; }
		if (isCloud) { event.preventDefault(); setNotice(CLOUD_ATTACHMENTS); return; }
		if (!api?.pathForFile) { return; }
		event.preventDefault();
		addAttachments(Array.from(event.dataTransfer.files).map((file) => api.pathForFile(file)));
	}

	function onPaste(event: ClipboardEvent) {
		const api = window.grokCode;
		const image = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith("image/"));
		const blob = image?.getAsFile();
		if (isCloud && blob) { event.preventDefault(); setNotice(CLOUD_ATTACHMENTS); return; }
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
		const target = toolReplyTarget(uiId, toolId);
		return request(api, uiId).then((result) => {
			if (result.ok) { onAnswered?.(); }
			if (!result.ok && result.closed) {
				writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: result.error || "That request already closed." } : tool)) }), false, target);
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

	async function signOut() {
		const api = window.grokCode;
		try {
			const status = api?.signInStatus ? await api.signInStatus() : signInStatus;
			if (status?.mode === "key" && status.hasKey) {
				if (!api?.removeSignInKey || !await askConfirm({ title: "Change how Grok signs in?", body: "Every session's Grok stops, and Grok's background commands and scheduled loops stop.", ok: "Remove key", danger: true })) { return; }
				const result = await api.removeSignInKey();
				setNotice(result.ok ? "API key removed." : result.error || "The API key could not be removed.");
				return;
			}
			const check = setup.result?.grok;
			if (check?.keySource === "env" && check.signIn !== "saved") { setNotice("Remove XAI_API_KEY from your environment to stop using it."); return; }
			if (!api?.signOut || !await askConfirm({ title: "Sign out of Grok?", body: "This signs Grok out on this computer, in a terminal too. Grok's background commands and scheduled loops will stop.", ok: "Sign out", danger: true })) { return; }
			const result = await api.signOut();
			setNotice(result.ok ? "Signed out. Grok asks you to sign in when you next send a message." : result.error || "Grok could not sign out.");
		} catch {
			setNotice("Grok's sign-in could not be changed.");
		}
	}

	function openUrl(url: string, external: boolean) {
		const api = window.grokCode;
		if (external || isCloud || !settingsRef.current.linksInBuiltIn) {
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
		const local = sessionsRef.current.some((entry) => entry.id === item.id);
		const saved = local ? undefined : readHistory();
		if (!local) {
			setSessions((list) => (list.some((entry) => entry.id === item.id) ? list : [{ ...item, archived: false }, ...list]));
			const messages = saved?.extraChats[item.id] ?? coldChat(item.id);
			if (messages) { setExtraChats((list) => (list[item.id] ? list : { ...list, [item.id]: messages })); }
		} else if (item.archived) {
			updateSession(item.id, { archived: false, pinned: false, lastActivityAt: Date.now() });
		}
		selectSession(item.id, undefined, saved);
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

	function terminalOwner(id: string) {
		if (deletedRef.current.includes(id)) { return undefined; }
		if (pendingRef.current?.id === id) { return pendingRef.current; }
		if (keptForm.current?.session.id === id) { return keptForm.current.session; }
		return sessionsRef.current.find((item) => item.id === id);
	}

	async function openTerminal(sessionId = session.id, folder = session.folder, title = "") {
		const api = window.grokCode;
		if (!api?.terminalOpen) {
			setTerminalError("Reopen this window to open a terminal.");
			return "";
		}
		const result = await api.terminalOpen({ cwd: folder }).catch(() => null);
		const owner = terminalOwner(sessionId);
		if (owner?.environment !== "Local" || folderKey(owner.folder) !== folderKey(folder)) {
			if (result?.id) { stopTerminal(result.id); }
			return "";
		}
		if (!result?.ok || !result.id) {
			setTerminalError(result?.error || "The terminal could not start.");
			return "";
		}
		const id = result.id;
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
		void window.grokCode?.terminalClose?.(id).catch(() => {});
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
				const target = toolReplyTarget(uiId, toolId);
				writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: decision === "deny" ? "Denied" : "Allowed" } : tool)) }), false, target);
				void window.grokCode?.decide({ uiSessionId: uiId, toolId, decision }).then((result) => {
					if (result.ok) {
						if (result.warning) { setNotice(result.warning); }
						return;
					}
					writeReply(uiId, (message) => ({ ...message, tools: message.tools?.map((tool) => (tool.id === toolId ? { ...tool, waiting: false, detail: result.error || "That approval already closed." } : tool)) }), false, target);
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
			fileMenu: showFileMenu,
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
		const crlf = (original.match(/\r\n/g)?.length ?? 0) > (original.match(/(?<!\r)\n/g)?.length ?? 0);
		const savedText = draft.text.replace(/\r?\n/g, crlf ? "\r\n" : "\n");
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

	function showFileMenu(file: string, event: MouseEvent) {
		setFileMenu({ file, x: event.clientX, y: event.clientY, opener: event.currentTarget as HTMLElement });
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
		const item = sessionsRef.current.find((entry) => entry.id === id);
		if (item?.environment === "Cloud") {
			if (turnTargets.current[id] || item.cloud?.active) { setNotice("Stop this session first."); return; }
		} else { void window.grokCode?.stopSession?.(id); }
		deletedRef.current = [...deletedRef.current, id];
		setDeleted(deletedRef.current);
		void window.grokCode?.removeColdChats?.([id]);
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
		if (target?.environment === "Cloud" && !target.archived && (turnTargets.current[id] || target.cloud?.active)) { setNotice("Stop this session first."); return; }
		if (target && !target.archived && target.worktreeFolder && window.grokCode?.removeWorktree && !sharesFolder(target)) {
			setHeld((current) => ({ ...current, [id]: true }));
			void window.grokCode.removeWorktree(target.folder, target.worktreeFolder, { force: false, branch: target.branch }).then(async (result) => {
				if (result.ok) { updateSession(id, { archived: true, pinned: false }); return; }
				const retained = result.ignored?.length ? `This worktree has files git ignores that removal would delete: ${result.ignored.join(", ")}.` : result.error || "This worktree is not clean.";
				if (result.dirty && await askConfirm({ title: "Archive this session?", body: `${retained} The worktree stays on disk.`, ok: "Archive anyway", danger: true })) { updateSession(id, { archived: true, pinned: false }); return; }
				if (result.dirty === false) { updateSession(id, { archived: true, pinned: false }); setNotice(`Archived, but the worktree folder could not be removed: ${result.error || "unknown error"}. Close any terminal open in it and delete the folder.`); return; }
				if (!result.dirty) { updateSession(id, { archived: true, pinned: false }); setNotice(`Archived. The worktree could not be checked, so it stays on disk: ${result.error || "unknown error"}`); }
			});
			return;
		}
		if (target?.archived && target.worktreeFolder) {
			if (!window.grokCode?.restoreWorktree) { setNotice("Reopen this window to restore the worktree."); return; }
			const base = folderKey(target.worktreeFolder).replace(/\/\.grok\/worktrees\/[^/]+$/, "");
			const source = sessionsRef.current.find((item) => item.id === target.parentId);
			const sourceFolder = source ? folderKey(source.folder) : "";
			const sandbox = sandboxGitSession(target) || (source && sandboxGitSession(source) && (sourceFolder === base || sourceFolder.startsWith(`${base}/`)));
			const policy = sandbox ? [{ sandbox: true }] as const : [] as const;
			void window.grokCode.restoreWorktree(target.worktreeFolder, target.branch, ...policy).then((result) => {
				if (result.ok) { updateSession(id, { archived: false, pinned: false, lastActivityAt: Date.now() }); } else { setNotice(result.error || "The worktree could not be restored."); }
			}).catch(() => setNotice("The worktree could not be restored."));
			return;
		}
		if (target && !target.archived) {
			setHeld((current) => ({ ...current, [id]: true }));
			if (target.environment !== "Cloud") { void window.grokCode?.stopSession?.(id); }
		}
		// Unarchive counts as activity, so automatic archiving does not archive it again at the next launch.
		setSessions((current) => current.map((item) => (item.id === id ? { ...item, archived: !item.archived, pinned: false, ...(item.archived ? { lastActivityAt: Date.now() } : {}) } : item)));
	}

	const usage = session.usage;
	// The context split and the week's spend are read from Grok's files, and the usage limit from Grok (a one-shot Grok when none is running), when a turn ends or the session changes.
	const agentId = session.agentSessionId ?? "";
	const idle = !busy[session.id];
	const signInRevision = signInEpoch.current;
	useEffect(() => {
		if (!idle || isCloud) { return; }
		const api = window.grokCode;
		void api?.recentSpend?.().then((result) => { if (result.ok && result.usd != null) { setRecentUsd(result.usd); } });
		if (!keyMode) { void readLimit(); }
		if (!agentId) { return; }
		void api?.contextBreakdown?.(agentId).then((result) => {
			if (result.ok && result.parts) { setBreakdown({ id: agentId, parts: result.parts, autoCompactPercent: result.autoCompactPercent ?? 85 }); }
		});
	}, [agentId, idle, keyMode, isCloud, signInRevision]);
	useEffect(() => {
		const reset = Date.parse(limit?.resetsAt ?? "");
		if (!Number.isFinite(reset)) { return; }
		let timer: ReturnType<typeof setTimeout>;
		const markAtReset = () => {
			const delay = reset - Date.now();
			if (delay <= 0) { setLimitStale(true); }
			else { timer = setTimeout(markAtReset, Math.min(delay, 2_147_483_647)); }
		};
		markAtReset();
		return () => clearTimeout(timer);
	}, [limit]);
	const queue = queued[session.id] ?? [];
	const profileChanging = sandboxProfileChanging(session, settings);
	const files = attachments[session.id] ?? [];
	const chatChoices = contextChoices(sessions, session.id);
	const chosenChats = contextPicks[session.id] ?? [];
	const isBusy = !!busy[session.id] || !!(isCloud && session.cloud?.active);
	const releaseCloudQueue = isCloud && queue.length > 0 && held[session.id] && !busy[session.id];
	const suggestion = !isCloud && settings.promptSuggestions && !prompt && !isBusy && !pending ? suggestions[session.id] ?? "" : "";
	const sendLabel = isBusy && !prompt.trim() && !releaseCloudQueue ? "Stop" : "Send";
	const recentFolders = [...new Map(sessions.filter((item) => item.folder && !item.routineId).map((item) => [folderKey(item.folder), item.folder])).values()].slice(0, 5);
	const projectPicks = firstRun ? cliProjectFolders : recentFolders;
	const diffComments = comments[session.id] ?? [];
	const prInfo = prs[session.id];

	function sidePane(id: SidePaneId) {
		const focus = () => setFocusedPane(id);
		const index = visiblePanes.indexOf(id);
		const shownIndex = shownPaneIds.indexOf(id);
		const shown = shownIndex >= 0;
		const second = paneColumns === 2 && shownIndex >= firstPaneColumn;
		const row = second ? shownIndex - firstPaneColumn : shownIndex;
		const rowsInSecond = shownPaneIds.length - firstPaneColumn;
		const gridRow = second && row === rowsInSecond - 1 && rowsInSecond < paneRows
			? `${paneRows === 2 ? row * 2 + 1 : row + 1} / -1`
			: paneRows === 2 ? row * 2 + 1 : row + 1;
		const layout: PaneLayoutControls = {
			expanded: fullPane === id,
			onToggleExpand: () => setExpandedPane((current) => current === id ? null : id),
			...(index > 0 ? { moveEarlier: () => movePane(id, -1) } : {}),
			...(index >= 0 && index < visiblePanes.length - 1 ? { moveLater: () => movePane(id, 1) } : {}),
		};
		let body = null;
		if (id === "diff") {
			body = (
				<DiffPane
					key={JSON.stringify([session.id, session.folder])}
					layout={layout}
					snapshot={progressiveChanges ? (session.folder ? paneChanges : { ok: false, error: "Choose a folder to see changes." }) : diffs[session.id]}
					progressive={progressiveChanges}
					loadingFiles={wantsChangeList && !inventory}
					loadingFile={!!patchKey && (!activePatch || activePatch.loading)}
					fileError={activePatch?.error}
					fullLimitReached={!!activePatch?.full && !!activePatch.file?.truncated}
					onLoadFull={() => loadChangePatch(!!activePatch?.file?.truncated)}
					onStopLoad={stopChangeLoad}
					scope={scope}
					onScope={(value) => setDiffScope((current) => ({ ...current, [session.id]: value }))}
					commits={commits[session.id] ?? []}
					selectedFile={diffFile}
					onSelectFile={setDiffFile}
					onRefresh={() => { setDiffTick((value) => value + 1); setRemoteTick((value) => value + 1); }}
					busy={isBusy}
					sandboxGit={sandboxGitSession(session)}
					onCommit={async (input) => {
						const commit = window.grokCode?.gitCommit;
						const result: WriteResult & { message?: string; committed?: boolean; sha?: string } = commit ? await commit(session.folder, { ...input, expected: branch?.branch }).catch(() => ({ ok: false, error: "The commit could not be checked. Refresh to see what happened." })) : { ok: false, error: "Reopen this window to commit." };
						setNotice(result.ok ? result.message || "Committed." : result.error || "The commit could not be checked. Refresh to see what happened.", result.ok);
						return result;
					}}
					onRevert={(file) => {
						const api = window.grokCode;
						if (!api?.revertFile) { return Promise.resolve({ ok: false, error: "Reopen this window to restore this file." }); }
						const policy = sandboxGitSession(session) ? { sandbox: true } : undefined;
						return api.revertFile(session.folder, file, policy).then((result) => {
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
					onViewed={(file, fingerprint) => {
						if (progressiveChanges) { rememberChangeMark(file, fingerprint); }
						setViewed((current) => {
							const mine = { ...current[session.id], ...(fingerprint ? { [file]: fingerprint } : {}) };
							if (!fingerprint) { delete mine[file]; }
							return { ...current, [session.id]: mine };
						});
					}}
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
					onFileMenu={showFileMenu}
					onClose={() => closePane("diff")}
				/>
			);
		} else if (id === "editor") {
			body = (
				<FilesPane
					layout={layout}
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
					onFileMenu={showFileMenu}
					onClose={() => closePane("editor")}
				/>
			);
		} else if (id === "terminal") {
			body = (
				<TerminalPane
					layout={layout}
					tabs={sessionTerminals}
					terminalScreenReader={settings.terminalScreenReader}
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
					onClose={() => { closePane("terminal"); promptRef.current?.focus(); }}
				/>
			);
		} else if (id === "browser") {
			body = browserPaneIds.map((ownerId) => {
				const reporting = ownerId === session.id;
				const visible = reporting && browserVisible && !grokBotOpen;
				const tabs = browserTabs[ownerId] ?? [];
				const servers: DevServer[] = (devScripts[ownerId] ?? []).map((item) => ({ ...item, running: !!devTabs[`${ownerId}:${item.script}`] }));
				const updateTabs = (update: (tabs: BrowserTab[]) => BrowserTab[]) => {
					setBrowserTabs((current) => ({ ...current, [ownerId]: update(current[ownerId] ?? []) }));
				};
				const updateTab = (tabId: string, update: (tab: BrowserTab) => BrowserTab) => {
					updateTabs((list) => list.map((tab) => tab.id === tabId ? update(tab) : tab));
				};
				const activate = (tabId: string) => setActiveBrowser((current) => ({ ...current, [ownerId]: tabId }));
				return <div className="browser-pane-host" hidden={!visible} inert={!visible} key={ownerId}>
					<BrowserPane
						uiSessionId={ownerId}
						visible={visible}
						reporting={reporting}
						layout={visible ? layout : undefined}
						controlEnabled={reporting && !isCloud && settings.browserControl}
						controlStopped={browserStopped[ownerId] ?? false}
						controlActivity={browserActivity[ownerId]}
						onStopControl={() => browserAccess(true)}
						onResumeControl={() => browserAccess(false)}
						tabs={tabs}
						activeId={tabs.find((tab) => tab.id === activeBrowser[ownerId])?.id ?? tabs[0]?.id ?? ""}
						onActivate={activate}
						onNewTab={() => {
							const tabId = crypto.randomUUID();
							updateTabs((list) => [...list, { id: tabId, url: "", title: "New tab" }]);
							activate(tabId);
						}}
						onCloseTab={(tabId) => updateTabs((list) => list.filter((tab) => tab.id !== tabId))}
						onNavigate={(tabId, raw) => {
							let url: URL;
							try { url = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`); } catch { setBrowserError("Type an http or https address."); return; }
							if (url.protocol !== "http:" && url.protocol !== "https:") { setBrowserError("Only http and https addresses open here."); return; }
							setBrowserError("");
							updateTab(tabId, (tab) => ({ ...tab, url: url.toString(), title: url.host }));
						}}
						onPageChanged={(tabId, url, title) => updateTab(tabId, (tab) => ({ ...tab, url: url || tab.url, title: title || tab.title }))}
						error={browserError}
						keepCookies={settings.keepCookies}
						onKeepCookies={(on) => changeSettings({ keepCookies: on })}
						onClearData={async () => {
							if (!await askConfirm({ title: "Clear browsing data?", body: "Cookies, site data and cache in the Browser pane will be cleared.", ok: "Clear data", danger: true })) { return; }
							const results = await Promise.all(["persist:grok-code", "temp:grok-code"].map((partition) => window.grokCode?.clearBrowsingData?.(partition)));
							const failed = results.find((result) => result && !result.ok);
							setNotice(failed ? (failed.error || "Browsing data could not be cleared.") : "Browsing data cleared.", !failed);
						}}
						linksInBuiltIn={settings.linksInBuiltIn}
						onLinksInBuiltIn={(on) => changeSettings({ linksInBuiltIn: on, linkAsked: true })}
						devServers={servers}
						onStartServer={(script) => { void startServer(script); }}
						onStopServer={(script) => { const tabId = devTabs[`${ownerId}:${script}`]; if (tabId) { stopTerminal(tabId); } }}
						onStopAll={() => Object.entries(devTabs).filter(([key]) => key.startsWith(`${ownerId}:`)).forEach(([, tabId]) => stopTerminal(tabId))}
						selectTick={selectTick}
						onPicked={(pick) => {
							if (!visible) { return; }
							setPrompt((current) => `${current}${current ? "\n\n" : ""}Selected element on ${pick.url}: \`${pick.selector}\`\n\`\`\`html\n${pick.html}\n\`\`\``);
							promptRef.current?.focus?.();
						}}
						onProblem={(tabId, problem) => updateTab(tabId, (tab) => ({ ...tab, problems: addProblem(tab.problems ?? [], problem) }))}
						onClearProblems={(tabId) => updateTab(tabId, (tab) => ({ ...tab, problems: [] }))}
						onDiagnostics={(text) => {
							if (!visible) { return; }
							setPrompt((current) => `${current}${current ? "\n\n" : ""}${text}`);
							promptRef.current?.focus?.();
						}}
						onClose={() => closePane("browser")}
					/>
				</div>;
			});
		} else {
			body = <PaneView id={id} model={modelForPanes} layout={layout} />;
		}
		return <div key={id} data-pane={id} hidden={!shown} inert={!shown} style={shown ? { gridColumn: second ? 2 : 1, gridRow } : undefined} className={focusedPane === id ? "side-slot focused" : "side-slot"} onMouseDownCapture={focus} onFocusCapture={focus}>{body}</div>;
	}

	function paneRowDivider() {
		const bound = (value: number) => Math.min(PANE_SPLIT_MAX, Math.max(PANE_SPLIT_MIN, Math.round(value)));
		return <div
			className="splitter pane-row-splitter"
			style={{ gridRow: 2, gridColumn: paneColumns === 2 && shownPaneIds.length === 3 ? 1 : "1 / -1" }}
			role="separator" aria-orientation="horizontal" aria-label="Resize stacked panes"
			aria-valuenow={paneSplit} aria-valuemin={PANE_SPLIT_MIN} aria-valuemax={PANE_SPLIT_MAX} tabIndex={0}
			onPointerDown={(event) => {
				const height = (event.currentTarget.parentElement?.clientHeight ?? 0) - PANE_SPLITTER_WIDTH * 3;
				if (event.button !== 0 || height <= 0) { return; }
				event.preventDefault();
				event.currentTarget.focus();
				paneDrag.current = { id: event.pointerId, y: event.clientY, height, start: paneSplit };
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const drag = paneDrag.current;
				if (drag?.id === event.pointerId) { setPaneSplit(bound(drag.start + (event.clientY - drag.y) / drag.height * 100)); }
			}}
			onLostPointerCapture={() => { paneDrag.current = null; }}
			onDoubleClick={() => setPaneSplit(50)}
			onKeyDown={(event) => {
				const step = event.shiftKey ? 15 : 5;
				const next = event.key === "ArrowUp" ? paneSplit - step : event.key === "ArrowDown" ? paneSplit + step
					: event.key === "Home" ? PANE_SPLIT_MIN : event.key === "End" ? PANE_SPLIT_MAX : null;
				if (next !== null) { event.preventDefault(); setPaneSplit(bound(next)); }
			}}
		/>;
	}

	function resizeHandle(key: ColumnWidth, label: string, width: number, min: number, max: number) {
		const direction = key === "sidebarWidth" ? 1 : -1;
		const edge = key === "sidebarWidth" ? " sidebar-splitter" : key === "railWidth" ? " rail-splitter" : "";
		const bound = (value: number) => Math.min(Math.max(value, min), max);
		const save = (value: number) => changeSettings({ [key]: bound(value) });
		const start = (event: MouseEvent<HTMLDivElement>) => {
			if (event.button > 0) { return; }
			event.preventDefault();
			resizeCleanup.current?.();
			const startX = event.clientX;
			let next = width;
			setResizePreview({ key, width });
			const move = (moveEvent: globalThis.MouseEvent) => {
				const value = bound(width + direction * (moveEvent.clientX - startX));
				if (value === next) { return; }
				next = value;
				setResizePreview({ key, width: next });
			};
			const finish = () => {
				cleanup();
				setResizePreview(null);
				if (next !== width) { save(next); }
			};
			const cleanup = () => {
				window.removeEventListener("mousemove", move);
				window.removeEventListener("mouseup", finish);
				window.removeEventListener("blur", finish);
				resizeCleanup.current = null;
			};
			resizeCleanup.current = cleanup;
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", finish);
			window.addEventListener("blur", finish);
		};
		const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
			const step = (event.shiftKey ? 96 : 24) * direction;
			let next;
			if (event.key === "ArrowLeft") { next = width - step; }
			else if (event.key === "ArrowRight") { next = width + step; }
			else if (event.key === "Home") { next = min; }
			else if (event.key === "End") { next = max; }
			else { return; }
			event.preventDefault();
			save(next);
		};
		const onDoubleClick = () => {
			const defaultWidth = bound(DEFAULT_SETTINGS[key]);
			let next = min;
			if (width < max && width === min) { next = defaultWidth; }
			else if (width < max && width === defaultWidth) { next = max; }
			save(next);
		};
		return <div
			className={`splitter${edge}${resizePreview?.key === key ? " resizing" : ""}`}
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={width}
			aria-valuemin={min}
			aria-valuemax={max}
			inert={settingsCover}
			tabIndex={0}
			title="Drag, or use the arrow keys, to resize. Double-click to switch between narrow, default and wide."
			onMouseDown={start}
			onKeyDown={onKeyDown}
			onDoubleClick={onDoubleClick}
		/>;
	}

	const contextPercent = usage ? Math.min(100, Math.round((usage.contextTokens / Math.max(1, usage.contextWindow)) * 100)) : null;
	const limitLeft = limit && limit.percent !== null ? Math.max(0, Math.round(100 - limit.percent)) : null;
	const limitName = limit?.period ? `${limit.period[0].toUpperCase()}${limit.period.slice(1)}` : "Limit";
	const limitTitle = limit ? `${limitLine(limit)}${limitStale ? " · Last reported; may be out of date." : ""}` : "Grok's usage limit isn't available.";
	const contextTitle = `Context about ${contextPercent}% used${keyMode ? ` · session cost $${(session.costUsd ?? 0).toFixed(2)}${recentUsd !== null ? `\nGrok, last 7 days on this computer: $${recentUsd.toFixed(2)}` : ""}` : ""}`;
	const showFolderWarn = !collisionSeen[session.id] && folderBusy(session);
	// shortcut: the disconnect choice is the main chat only; a side-chat exit keeps its error text
	const lastGrok = [...messages].reverse().find((message) => message.role === "grok" && !message.pending);
	const wasInterrupted = lastGrok?.appNote === INTERRUPTED_NOTE;
	const showDisconnect = !pending && !folderMissing && !isCloud && !busy[session.id] && (wasInterrupted || (session.failed === true && !!lastGrok?.appNote?.startsWith("Grok exited.")));
	const mountedPanes = PANE_ORDER.filter((id) => visiblePanes.includes(id)
		|| (id === "terminal" && sessionTerminals.length > 0)
		|| (id === "browser" && browserPaneIds.length > 0));
	const paneGridStyle: CSSProperties = {
		width: fullPane ? undefined : paneWidth,
		gridTemplateColumns: `repeat(${paneColumns}, minmax(0, 1fr))`,
		gridTemplateRows: paneRows === 2 ? `minmax(0, ${paneSplit}fr) 6px minmax(0, ${100 - paneSplit}fr)`
			: `repeat(${paneRows}, minmax(${paneRows > 2 ? "240px" : "0"}, 1fr))`,
		rowGap: paneRows === 2 ? 0 : undefined,
	};

	// One pair of buttons, shown on whatever covers the window: the chat's top bar, Settings, Routines or Grok Bot.
	const historyNav = (
		<span className="history-nav">
			<button type="button" className="icon-btn" aria-label="Back" title="Back" disabled={!formOver && trailStop(trail.back) < 0} onClick={() => travel(true)}><Icon name="chevron-left" /></button>
			<button type="button" className="icon-btn" aria-label="Forward" title="Forward" disabled={trailStop(trail.forward) < 0} onClick={() => travel(false)}><Icon name="chevron-right" /></button>
		</span>
	);

	return (
		<div className={sidebarCollapsed ? "app collapsed" : "app"} style={{ "--sidebar-width": `${sidebarWidth}px`, "--rail-width": `${railWidth}px` } as CSSProperties}>
			<div aria-live="polite" aria-relevant="additions" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>
				{turnAnnouncements.map((item) => <span key={item.id}>{item.text}</span>)}
			</div>
			{(menu || fileMenu) && <button className="backdrop" inert={settingsCover} aria-label="Close menu" onClick={() => { setMenu(null); setFileMenu(null); }} />}
			{!sidebarCollapsed && (
				<Sidebar
					inert={settingsCover}
					revealActiveOnMount={revealSidebarProject.current}
					sessions={sessions.filter((item) => item.id !== firstSessionId.current || item.folder)}
					chats={extraChats}
					activeId={grokBotOpen ? "" : sidebarActiveId}
					grokBot={grokBot.status.signedIn || botWindow ? { open: grokBotOpen, running: grokBot.status.connection === "live" && Object.values(grokBot.status.live).some((live) => live.running), onOpen: () => setGrokBotOpen(true) } : undefined}
					query={query}
					activity={activity}
					onQuery={setQuery}
					onSelect={(id, find) => { setGrokBotOpen(false); selectSession(id, find); }}
					onNew={() => { setGrokBotOpen(false); createSession(); }}
					onNewIn={(seed) => { setGrokBotOpen(false); createSession(seed); }}
					onPin={(id) => setSessions((current) => current.map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item)))}
					onArchive={(id) => {
						const target = sessions.find((item) => item.id === id);
						if (target?.environment === "Cloud") { archiveSession(id, target); return; }
						const working = busy[id] || busy[`side-${id}`] || [...(grokTasks[id] ?? []), ...(grokTasks[`side-${id}`] ?? [])].some((task) => task.status === "running") || [...(subagents[id] ?? []), ...(subagents[`side-${id}`] ?? [])].some((agent) => agent.status === "running");
						if (target && !target.archived && working) {
							const worktree = target.worktreeFolder && !sharesFolder(target) ? ` ${WORKTREE_ARCHIVE_NOTE}` : "";
							void askConfirm({ title: "Archive this session?", body: `Grok is still working in this session. Archiving stops the turn and any background commands.${worktree}`, ok: "Archive and stop", danger: true }).then((yes) => { if (yes) { archiveSession(id, target); } });
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
					onRoutines={() => setRoutinesOpen(true)}
					onCollapse={() => changeSettings({ sidebarCollapsed: true })}
					onNotice={setNotice}
					account={account}
					signIn={setup.result?.grok.ok ? setup.result.grok.signIn : undefined}
					signInMode={signInStatus?.mode ?? setup.result?.grok.signInMode}
					keySource={setup.result?.grok.keySource}
					keyIgnored={setup.result?.grok.keyIgnored}
					keyUnreadable={setup.result?.grok.keyUnreadable}
					keyRejected={setup.result?.grok.keyRejected}
					recentUsd={keyMode ? recentUsd : null}
					onShortcuts={() => setShortcuts(true)}
					onOpenUrl={(url) => openUrl(url, true)}
					onSignOut={signOut}
					update={update}
					onUpdate={() => { void openUpdate(update); }}
				/>
			)}
			{!sidebarCollapsed && resizeHandle("sidebarWidth", "Resize sidebar", sidebarWidth, SIDEBAR_MIN, sidebarCap)}
			<main className={grokBotOpen ? "workspace grok-bot-covered" : "workspace"} inert={settingsCover}>
				{grokBotOpen && (botWindow ? <GrokBotWindow nav={historyNav} onClose={() => setGrokBotOpen(false)} /> : <GrokBotView bot={grokBot} nav={historyNav} onClose={() => setGrokBotOpen(false)} />)}
				<header className="topbar">
					{sidebarCollapsed && <button className="icon-btn" aria-label="Show sidebar" title={shouldCollapseSidebar(windowWidth, visiblePanes.length > 0) ? "Show sidebar and return to chat" : "Show sidebar"} onClick={() => {
						if (shouldCollapseSidebar(windowWidth, visiblePanes.length > 0)) {
							if (panes.includes("editor")) { flushEditor(); }
							setPanes([]);
							setFocusedPane(null);
							setExpandedPane(null);
						}
						if (settings.sidebarCollapsed) { changeSettings({ sidebarCollapsed: false }); }
					}}><Icon name="sidebar" /></button>}
					{historyNav}
					<div className="session-title">
						{renaming === session.id ? (
							<input
								className="title-input"
								aria-label="Session title"
								autoFocus
								defaultValue={session.title}
								onBlur={(event) => { const title = event.target.value.trim(); if (title && !pending) { renameSession(session.id, title); } setRenaming(null); }}
								onKeyDown={(event) => {
									if (event.nativeEvent?.isComposing) { return; }
									if (event.key === "Enter") { (event.target as HTMLInputElement).blur(); }
									if (event.key === "Escape") { event.stopPropagation(); setRenaming(null); }
								}}
							/>
						) : (
							<button type="button" className="title-btn" title="Rename" onClick={() => { if (!pending) { setRenaming(session.id); } }}>{pending ? "New session" : session.title}</button>
						)}
						<button type="button" className="icon-btn caret" aria-label="Session menu" aria-haspopup="menu" aria-expanded={menu === "session"} onClick={() => setMenu(menu === "session" ? null : "session")}><Icon name="chevron-down" /></button>
						<span className="meta">{session.project}{titleBranch ? ` · ${titleBranch}` : ""}{session.cloud?.machine ? ` · ${session.cloud.machine}` : ""}{sandboxActive(session) ? " · Sandboxed" : ""}{isBusy ? " · working" : ""}</span>
					</div>
					<span className="spacer" />
					<div className="pane-switch" role="toolbar" aria-label="Panes">
						{PANES.filter((pane) => !isCloud || pane.id === "editor").map((pane) => (
							<button key={pane.id} type="button" className={panes.includes(pane.id) ? "pane-tab on" : "pane-tab"} aria-pressed={panes.includes(pane.id)} aria-label={pane.label} title={pane.label} onClick={() => togglePane(pane.id)}>
								<PaneIcon id={pane.id} />
							</button>
						))}
						<button type="button" className="pane-tab" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}><Icon name="more" /></button>
					</div>
					{menu === "session" && (
						<PopupMenu className="pop down session-menu" aria-label="Session menu" onDismiss={() => setMenu(null)}>
							<div className="menu-label">Transcript view</div>
							{VIEWS.map((item) => (
								<button key={item} type="button" className={view === item ? "item on" : "item"} role="menuitemradio" aria-checked={view === item} onClick={() => { setViews((current) => ({ ...current, [session.id]: item })); setMenu(null); }}>{VIEW_LABEL[item]}{view === item && <Icon name="check" className="menu-check" />}</button>
							))}
							<div className="menu-label">Open in</div>
							<button type="button" className="item" role="menuitem" disabled={!!pending} onClick={() => { openSessionWindow(session.id); setMenu(null); }}>New window{pending && <small>Send a first message to start the session.</small>}</button>
							<button type="button" className="item" role="menuitem" onClick={() => openIn("explorer")}>{FILE_MANAGER}</button>
							<button type="button" className="item" role="menuitem" onClick={() => openIn("vscode")}>VS Code</button>
							<hr />
							{!isCloud && <button type="button" className="item" role="menuitem" disabled={railOpen && !railShown} onClick={() => { changeSettings({ railOpen: !railOpen }); setMenu(null); }}>{railOpen && !railShown ? "Session rail (window too narrow)" : railShown ? "Hide session rail" : "Show session rail"}</button>}
							<button type="button" className="item" role="menuitem" disabled={!!pending} onClick={() => { setRenaming(session.id); setMenu(null); }}>Rename{pending && <small>Send a first message to start the session.</small>}</button>
						</PopupMenu>
					)}
					{menu === "more" && (
						<PopupMenu className="pop down more-menu" aria-label="More" onDismiss={() => setMenu(null)}>
							{!isCloud && MENU_PANES.map((pane) => (
								<button key={pane.id} type="button" className={panes.includes(pane.id) ? "item on" : "item"} role="menuitemcheckbox" aria-checked={panes.includes(pane.id)} onClick={() => togglePane(pane.id)}>
									{pane.label}
									<small>{pane.id === "plan" ? (planText || todos.length ? "Grok's current plan" : "No plan yet") : `${backgroundTasks.filter((task) => task.running).length} running`}</small>
									{panes.includes(pane.id) && <Icon name="check" className="menu-check" />}
								</button>
							))}
							<hr />
							<button type="button" className="item" role="menuitem" disabled={railOpen && !railShown} onClick={() => { changeSettings({ railOpen: !railOpen }); setMenu(null); }}>{railOpen && !railShown ? "Session rail (window too narrow)" : railShown ? "Hide session rail" : "Show session rail"}</button>
							<button type="button" className="item" role="menuitem" onClick={() => { setShortcuts(true); setMenu(null); }}>Keyboard shortcuts<small>{keyLabel("Ctrl+/")}</small></button>
							<button type="button" className="item" role="menuitem" onClick={() => { setSettingsOpen("general"); setMenu(null); }}>Settings</button>
						</PopupMenu>
					)}
				</header>
				<div className="stage">
					<div className={pending && !messages.length ? "stage-main new-stage" : "stage-main"} inert={!!fullPane}>
						{pending && (
							<div className="new-page">
								<h1>{pending.folder ? "What should Grok work on?" : "Where should Grok work?"}</h1>
								{!pending.folder && <p className="new-folder-intro">Choose the project folder for this session.</p>}
								{isCloud && <div aria-label="Cloud setup">
									<label className="field">Run on
										<select aria-label="Run on" value={machineMode ? "machine" : "cloud"} onChange={(event) => {
											const cloudMachineDraft = event.target.value === "machine" ? "" : undefined;
											setPending((item) => item ? { ...item, cloudMachineDraft } : item);
										}}>
											<option value="cloud">Cursor's cloud</option>
											<option value="machine">My machine</option>
										</select>
									</label>
									{machineMode && <>
										<label className="field">Machine name
											<input aria-label="Machine name" aria-describedby="cursor-machine-name-hint" list="cursor-machine-names" value={machineDraft} onChange={(event) => {
												const cloudMachineDraft = event.target.value;
												setPending((item) => item ? { ...item, cloudMachineDraft } : item);
											}} />
										</label>
										<datalist id="cursor-machine-names">
											{settings.cursorMachines.filter((item) => item.repo === machineRepo.toLowerCase()).map(({ name }) => <option key={name} value={name} />)}
										</datalist>
										<p className="note" id="cursor-machine-name-hint">Letters, digits, dots, dashes and underscores. Start with a letter or digit, and don't end with a dot. Capitals count: type it as the worker shows it.</p>
									</>}
									{cloudSetupResult?.repoUrl && cloudSetupResult.ref && <p className="note">{cloudSetupResult.repoUrl.replace(/^https:\/\//, "")}, branch {cloudSetupResult.ref}</p>}
									{!cloudKeyAvailable ? <p className="note">Add a Cursor API key in Settings.</p> : !cloudSetupResult ? <p className="note" role="status">Checking Cloud setup…</p> : <>
										{cloudSetupResult.reachable === true && <p className="note">Cursor can reach this repository.</p>}
										{cloudSetupResult.reachable === false && <p className="note">Cursor can't reach this repository yet. <button type="button" className="texty" onClick={() => openUrl("https://cursor.com/dashboard?tab=integrations", true)}>Open Cursor's GitHub integration</button></p>}
										{cloudSetupResult.error && <p className="note" role="alert">{cloudSetupResult.error}</p>}
										<button type="button" className="texty" onClick={() => void checkCloudSetup(pending)}>Check again</button>
									</>}
									{machineMode ? <>
										{machineRef && !machineRefValid && <p className="note" role="alert">{MACHINE_REF_ERROR}</p>}
										{machineCommands.length > 0 && <>
											<p className="note"><strong>Set it up on that computer</strong></p>
											<p className="note">Run these in the folder where the clone should go, the second once the clone has finished.</p>
											{machineCommands.map((command) => <p className="note" key={command}><code>{command}</code> <button type="button" className="texty" aria-label={`Copy ${command}`} onClick={() => copyText(command)}>Copy</button></p>)}
										</>}
										<p className="note">First time on that computer? Settings has the install steps. <button type="button" className="texty" onClick={() => setSettingsOpen("general")}>Open Settings</button></p>
										<p className="note">The agent runs commands, switches branches and commits on {validMachineName(machineName) ? machineName : "that computer"}, in the folder its worker runs in, as that computer's user. Give the worker its own clone, as above, not a folder you work in.</p>
										{machineRefValid && <p className="note">The agent is told to work on a branch of its own, started from {machineRef} on GitHub, and not to push, so its commits stay in that clone. It works with that computer's Git sign-in, so nothing but that instruction stops a push.</p>}
									</> : <>
										<p className="note">Cloud sessions start from what's on GitHub. Your uncommitted changes and unpushed commits aren't included.</p>
										{!!cloudSetupResult?.ahead && <p className="note">This branch is {cloudSetupResult.ahead} {cloudSetupResult.ahead === 1 ? "commit" : "commits"} ahead of its upstream.</p>}
										{!!cloudSetupResult?.behind && <p className="note">This branch is {cloudSetupResult.behind} {cloudSetupResult.behind === 1 ? "commit" : "commits"} behind its upstream.</p>}
									</>}
									<p className="note">Cloud sessions use your Cursor credit.</p>
									{!machineMode && <label className="toggle"><input type="checkbox" checked={pending.cloud?.autoCreatePR ?? false} disabled={!cloudModel || !cloudVariant} onChange={(event) => { if (cloudModel && cloudVariant) { changeCloudChoice(cloudModel, cloudVariant, event.target.checked); } }} /> Open a pull request</label>}
									{cloudSetupResult?.modelsError && <p className="note" role="alert">{cloudSetupResult.modelsError} <button type="button" className="texty" onClick={() => void checkCloudSetup(pending)}>Try again</button></p>}
								</div>}
							</div>
						)}
						<div className="chat-row">
							<PaneView id="chat" model={modelForPanes} />
						</div>
						<div className="dock" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
							{!isCloud && sideOpen && (
								<div className="side-q" role="dialog" aria-label="Side chat">
									<div className="side-q-hd"><b>Side chat</b><span className="meta">Always runs in Normal mode. Reads this session; nothing goes back into it. It is not added to this chat's history; Grok keeps its own copy in ~/.grok/sessions.</span><span className="spacer" /><button type="button" className="pane-x" aria-label="Close side chat" onClick={() => setSideOpen(false)}><Icon name="close" /></button></div>
									<SideLog messages={sideChats[session.id] ?? []} model={sideModel} />
									<textarea
										aria-label="Side question"
										rows={2}
										value={sideText}
										placeholder="Ask a side question"
										onChange={(event) => setSideText(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
												event.preventDefault();
												if (send(sideText, true)) { setSideText(""); }
											}
										}}
									/>
								</div>
							)}
							{folderMissing && <div className="missing-folder-banner">
								<Icon name="folder-unavailable" />
								<p role="status" id="missing-session-folder">This session's folder is missing.<small>Choose a folder to send. Your draft is kept.</small></p>
								<button type="button" className="yes" disabled={!!busy[session.id]} onClick={() => void chooseSessionFolder()}>Choose folder…</button>
							</div>}
							<div className="composer">
								{session.prWatch?.alert && <div className="queue pr-alert">
									<span>{prAlertText(session.prWatch.number, session.prWatch.alert)}</span>
									<button className="texty" onClick={askGrokToFix}>Ask Grok to fix</button>
										<button className="texty" aria-label="Dismiss pull request alert" onClick={dismissPrAlert}><Icon name="close" /></button>
									</div>}
								{queue.length > 0 && (
									<div className="queue">
									{held[session.id] && <p className="note">{isCloud ? "Held until you press Send." : "Held until you press Send now or send a new message."}</p>}
										{queue.map((item) => (
											<div className="queued" key={item.id}>
												<span>{item.text}{item.contextFrom?.length ? ` · ${item.contextFrom.map((pick) => pick.title).join(", ")}` : ""}</span>
												{!isCloud && !profileChanging && !session.sandboxContextPending && busy[session.id] && !held[session.id] && !item.attachments.length && !item.contextFrom?.length && !item.text.trim().startsWith("/") && <button className="texty" onClick={() => void steerQueued(item)}>Steer</button>}
												{!isCloud && <button className="texty" title="Stops the current reply if one is running, then sends this message." disabled={folderMissing} onClick={() => sendNow(session.id, item.id)}>Send now</button>}
												<button className="texty" onClick={() => editQueued(item)}>Edit</button>
												<button className="texty" aria-label="Remove queued message" onClick={() => setQueued((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((entry) => entry.id !== item.id) }))}><Icon name="close" /></button>
											</div>
										))}
									</div>
								)}
								{(contextPicks[session.id] ?? []).length > 0 && (
									<div className="attach-list">
										{(contextPicks[session.id] ?? []).map((pick) => (
											<span className="attach-chip" key={pick.id} title={`Earlier context from ${pick.title}`}>
												{pick.title}
												<button type="button" aria-label={`Remove context from ${pick.title}`} onClick={() => setContextPicks((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((item) => item.id !== pick.id) }))}><Icon name="close" /></button>
											</span>
										))}
									</div>
								)}
								{files.length > 0 && (
									<div className="attach-list">
										{files.map((file) => (
											<span className="attach-chip" key={file} title={file}>
												{imageSrc(file) ? <button type="button" className="thumb" aria-label={`View ${file.split(/[\\/]/).pop()}`} onClick={() => openImage(file)}><img src={imageSrc(file)} alt={file.split(/[\\/]/).pop()} /></button> : file.split(/[\\/]/).pop()}
												<button type="button" aria-label={`Remove ${file.split(/[\\/]/).pop()}`} onClick={() => setAttachments((current) => ({ ...current, [session.id]: (current[session.id] ?? []).filter((item) => item !== file) }))}><Icon name="close" /></button>
											</span>
										))}
									</div>
								)}
								{popup && (
									<div className="mention pop-list" role="listbox" ref={popupList} aria-label={popup.kind === "slash" ? "Commands" : "Files"}>
										{popup.kind === "mention" && folderFiles?.status === "loading" && <div className="item">Reading this folder…</div>}
										{popup.kind === "mention" && folderFiles?.status === "error" && <div className="item">{folderFiles.error}</div>}
										{popup.kind === "slash" ? COMMAND_GROUPS.map((group) => {
											const options = popup.items.flatMap((item, index) => item.group === group ? [renderPopupItem(item, index)] : []);
											return options.length > 0 && <div key={group} className="command-group" role="group" aria-label={`${group}, ${options.length} ${options.length === 1 ? "command" : "commands"}`}>
												<div className="command-group-label" aria-hidden="true">{group}<span>{options.length}</span></div>
												{options}
											</div>;
										}) : popup.items.map(renderPopupItem)}
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
										<AppNote>
											<p>{wasInterrupted ? "The previous turn was interrupted." : "Grok disconnected."} The next message continues this conversation. New session starts fresh in this folder.</p>
											<div className="app-note-actions">
												<button type="button" className="texty" onClick={() => promptRef.current?.focus?.()}>Resume</button>
												<button type="button" className="texty" onClick={startFreshSession}>New session</button>
											</div>
										</AppNote>
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
									aria-describedby={folderMissing ? "missing-session-folder" : undefined}
									rows={2}
									placeholder={suggestion ? `${suggestion}   (Tab to use)` : isBusy ? (isCloud ? "Queue a message while Cursor works" : "Steer Grok while it works") : pending ? "Describe a task to start a new session" : isCloud ? "Reply to Cursor" : "Reply to Grok, or type / for commands and @ to mention files"}
									value={prompt}
									onChange={(event) => setPrompt(event.target.value)}
									onPaste={onPaste}
									onKeyDown={(event) => {
									if (event.nativeEvent?.isComposing) { return; }
										if (popup && popup.items.length) {
											if (event.key === "ArrowDown" || event.key === "ArrowUp") {
												event.preventDefault();
												const step = event.key === "ArrowDown" ? 1 : -1;
												setPopValue((current) => {
													const index = Math.max(0, popup.items.findIndex((item) => item.value === current));
													return popup.items[(index + step + popup.items.length) % popup.items.length].value;
												});
												return;
											}
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
									<div className="composer-primary">
										<MenuButton label="+" icon="plus" title={isCloud ? "Commands and saved prompts" : "Add files, folders and commands"} open={menu === "plus" || menu === "context"} onClick={() => setMenu(menu === "plus" || menu === "context" ? null : "plus")} />
										<MenuButton label={session.environment} icon="monitor" title="Environment" open={menu === "env"} onClick={() => setMenu(menu === "env" ? null : "env")} />
										<MenuButton label={session.folder ? shortPath(session.folder) : "Choose folder…"} icon="folder" title={session.folder || "Choose a project folder"} open={menu === "folder"} onClick={() => setMenu(menu === "folder" ? null : "folder")} />
										{pending && !isCloud && <label className="chip worktree-chip" title="Work on a new branch in its own Git worktree">
											<input type="checkbox" aria-label="Worktree" checked={useWorktree} disabled={!!worktreeReason && !useWorktree} aria-describedby={worktreeReason ? "worktree-unavailable" : undefined} onChange={(event) => setUseWorktree(event.target.checked)} /> Worktree
										</label>}
										{session.environment === "Local" && (pending || !sandboxBlocked || sandboxWanted(session)) && <label className="chip worktree-chip" title="Run Grok's commands in a sandbox. Changing this during a session starts a new Grok session with the newest part of the conversation.">
											<input type="checkbox" aria-label="Sandbox" checked={sandboxWanted(session)} disabled={sandboxBlocked && !sandboxWanted(session)} aria-describedby={pending && sandboxBlocked ? "sandbox-unavailable" : undefined} onChange={(event) => {
												// Windows offers three kinds of sandbox, so turning one on asks which. Nothing changes until that's answered.
												if (event.target.checked && PLATFORM === "win32") { setSandboxPicker(session.id); return; }
												setSessionSandbox({ sandboxOn: event.target.checked });
											}} /> {sandboxChipLabel(session, settings)}
										</label>}
										{!isCloud && <MenuButton label={mode} icon="shield" title={keyLabel("Permission mode (Ctrl+Shift+M)")} open={menu === "mode"} onClick={() => setMenu(menu === "mode" ? null : "mode")} />}
									</div>
									<div className="composer-actions">
										{!isCloud && !keyMode && <span className={`limit-meter${limitLeft === null ? "" : limitLeft <= 10 ? " high" : limitLeft <= 25 ? " warn" : ""}`} title={limitTitle} aria-label={limitTitle}>{limitLeft === null ? "Limit" : <><span className="limit-period">{limitName} · </span>{limitLeft}% left</>}</span>}
										{!isCloud && contextPercent !== null && <span className="usage-ring" title={contextTitle} style={{ ["--pct" as string]: `${contextPercent}` }} aria-label={`Context ${contextPercent}% used`} />}
										{isCloud ? <MenuButton label={cloudModelLabel} icon="spark" title={keyLabel("Cursor model (Ctrl+Shift+I)")} open={menu === "model" && !cloudModelLocked} disabled={cloudModelLocked} onClick={() => setMenu(menu === "model" ? null : "model")} /> :
											<MenuButton label={`${baseModel}${fastOn ? " · fast" : ""} · ${effort}`} icon="spark" title={keyLabel("Model (Ctrl+Shift+I) and effort (Ctrl+Shift+E)")} open={menu === "model" || menu === "effort"} onClick={() => setMenu(menu === "model" ? null : "model")} />}
										<button
											type="button"
											className={sendLabel === "Stop" ? "send-btn stop" : "send-btn"}
											aria-label={sendLabel}
													title={sendLabel === "Stop" ? "Stop (Esc)" : folderMissing || (pending && !session.folder) ? "Choose a folder to send" : isBusy ? (isCloud || prompt.trim().startsWith("/") || files.length || chosenChats.length ? "Queue (Enter)" : "Steer (Enter)") : "Send (Enter)"}
													disabled={sendLabel === "Send" && (folderMissing || (!!pending && (!session.folder || (isCloud && !cloudReady))) || (!prompt.trim() && !releaseCloudQueue))}
											onClick={() => { if (sendLabel === "Stop") { stop(session.id); } else { void submit(); } }}
										>
											<Icon name={sendLabel === "Stop" ? "stop" : "send"} />
										</button>
									</div>
									{menu === "plus" && (
										<PopupMenu className="pop up" aria-label="Add to prompt" onDismiss={() => setMenu(null)}>
											{!isCloud && <><button role="menuitem"
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
											<button role="menuitem" type="button" className="item" disabled={addingFolder} onClick={() => void addFolder()}>{addingFolder ? "Adding folder…" : "Add folder"}<small>{addingFolder ? "Wait for the folder to finish adding." : "Grok can also work in this folder."}</small></button></>}
											<button role="menuitem" type="button" className="item" onClick={() => { setPrompt("/"); setPopClosed(""); setMenu(null); promptRef.current?.focus?.(); }}>Slash commands</button>
											<button role="menuitem" type="button" className="item" onClick={() => openPromptLibrary("insert")}>Saved prompts<small>{keyLabel("Search and insert without sending (Ctrl+Shift+P)")}</small></button>
											<button role="menuitem" type="button" className="item" disabled={!prompt.trim()} onClick={() => openPromptLibrary("save")}>Save current prompt{!prompt.trim() && <small>Type a prompt first.</small>}</button>
											{!isCloud && <><button role="menuitem" type="button" className="item" onClick={() => setMenu("context")}>Context from another chat<small>Up to three earlier chats, labelled as context.</small></button>
											<button role="menuitem" type="button" className="item" onClick={() => { setSettingsOpen("skills"); setMenu(null); }}>Skills and tools<small>{servers.length ? `${servers.length} MCP servers from Grok` : "Managed in Grok's configuration"}</small></button>
											{!!session.allowedFolders?.length && <div className="menu-label">Added folders</div>}
											{session.allowedFolders?.map((folder) => <div className="item" key={folder}>{folder}</div>)}</>}
										</PopupMenu>
									)}
									{!isCloud && menu === "context" && (
										<PopupMenu className="pop up" aria-label="Earlier chats" opener={overlayOpener.current} onDismiss={() => setMenu(null)}>
											{chatChoices.length === 0 && <div className="item">No other chats yet.</div>}
											{chatChoices.map((item) => {
												const added = chosenChats.some((pick) => pick.id === item.id);
												return (
													<button role="menuitem" key={item.id} type="button" className="item" disabled={added || chosenChats.length >= CONTEXT_PICK_LIMIT} onClick={() => { setContextPicks((current) => ({ ...current, [session.id]: addContextPick(current[session.id] ?? [], item) })); setMenu(null); }}>
														{item.title}
														{item.archived && <small>Archived</small>}
														{added ? <small>Added</small> : chosenChats.length >= CONTEXT_PICK_LIMIT && <small>Three chats are already selected.</small>}
													</button>
												);
											})}
											{chosenChats.length >= CONTEXT_PICK_LIMIT && <div className="item">Three chats is the limit.</div>}
										</PopupMenu>
									)}
									{menu === "env" && (
										<PopupMenu className="pop up" aria-label="Environment" onDismiss={() => setMenu(null)}>
											{(["Local", "SSH", "Cloud"] as Environment[]).map((environment) => (
												<button role="menuitemradio" aria-checked={session.environment === environment} key={environment} type="button" className={session.environment === environment ? "item on" : "item"} disabled={environment !== session.environment && (!pending || environment === "SSH" || (environment === "Cloud" && !cloudKeyAvailable))} onClick={() => choosePendingEnvironment(environment)}>
													{environment}
													<small>{environment === "Local" ? "This computer" : environment === "Cloud" ? (session.cloud?.machine ? `${session.cloud.machine}, through Cursor` : "Cursor's computers") : "Not available yet"}</small>
													{environment !== "SSH" && environment !== session.environment && !pending && <small>Choose this environment when starting a new session.</small>}
													{environment === "Cloud" && environment !== session.environment && pending && !cloudKeyAvailable && <small>Add a Cursor API key in Settings.</small>}
													{environment === session.environment && <Icon name="check" className="menu-check" />}
												</button>
											))}
										</PopupMenu>
									)}
									{menu === "folder" && pending && (
										<PopupMenu className="pop up" aria-label="Folder" opener={overlayOpener.current} onDismiss={() => setMenu(null)}>
											{session.folder && <><div className="item">{session.folder}</div><button role="menuitem" type="button" className="item" onClick={() => openIn("explorer")}>Open in {FILE_MANAGER}</button></>}
											<button role="menuitem" type="button" className="item" onClick={pickPendingFolder}>Choose a folder</button>
										</PopupMenu>
									)}
									{menu === "folder" && !pending && (
										<PopupMenu className="pop up" aria-label="Folder" opener={overlayOpener.current} onDismiss={() => setMenu(null)}>
											<div className="item">{session.folder}</div>
											<button role="menuitem" type="button" className="item" onClick={() => openIn("explorer")}>Open in {FILE_MANAGER}</button>
											<button role="menuitem"
												type="button"
												className="item"
												disabled={isCloud || !!busy[session.id]}
												onClick={() => void chooseSessionFolder()}
											>
												Choose a folder
												<small>{isCloud ? (pending ? "Choose the repository on the New session page." : "This Cloud session's repository is fixed.") : busy[session.id] ? "Stop or finish the turn before changing folders." : "The next message starts a new Grok conversation in that folder."}</small>
											</button>
										</PopupMenu>
									)}
									{!isCloud && menu === "mode" && (
										<PopupMenu className="pop up" aria-label="Permission mode" opener={overlayOpener.current} onDismiss={() => setMenu(null)}>
											{isBusy && <div className="menu-label">Stop or finish this turn before changing mode.</div>}
											{MODES.map((item) => (
												<button role="menuitemradio" aria-checked={mode === item.id}
													key={item.id}
													type="button"
													className={mode === item.id ? "mode-row on" : "mode-row"}
													disabled={isBusy}
													onClick={() => {
														if (turnTargets.current[session.id]) { return; }
														setMenu(null);
														requestMode(session.id, item.id);
													}}
												>
													{item.id}
													<small>{item.detail}</small>
													{mode === item.id && <Icon name="check" className="menu-check" />}
													{restartStops(item.id) > 0 && <small className="mode-warn">The next message restarts Grok and stops {restartStops(item.id)} running background {restartStops(item.id) === 1 ? "task" : "tasks"}.</small>}
												</button>
											))}
										</PopupMenu>
									)}
									{isCloud && menu === "model" && !cloudModelLocked && (
										<PopupMenu className="pop up right" aria-label="Cursor models" opener={overlayOpener.current} onDismiss={() => setMenu(null)}>
											<div className="menu-label">Cursor models</div>
											{cloudCatalog.map((item) => {
												const variant = chooseVariant(item);
												return <button role="menuitemradio" aria-checked={item.id === cloudChoice?.id} key={item.id} type="button" className={item.id === cloudChoice?.id ? "item on" : "item"} disabled={!variant} onClick={() => { if (variant) { changeCloudChoice(item, variant); } }}>{item.displayName}{variant?.isMaxMode ? " · Max" : ""}{!variant && <small>Cursor reports no available configuration.</small>}{item.id === cloudChoice?.id && <Icon name="check" className="menu-check" />}</button>;
											})}
											{!cloudCatalog.length && <p className="note">{cloudSetupResult?.modelsError || "Cursor models aren't available yet."} {!pending && cloudKeyAvailable && <button role="menuitem" type="button" className="texty" onClick={() => void checkCloudSetup(session)}>Try again</button>}</p>}
											{cloudModel && cloudChoice && cloudModel.parameters?.map((parameter) => (
												<div key={parameter.id}>
													<div className="menu-label">{parameter.displayName || parameter.id}</div>
													{parameter.values.map((value) => {
														const selected = cloudChoice.params.some((param) => param.id === parameter.id && param.value === value.value);
														const variant = chooseVariant(cloudModel, cloudChoice.params, parameter.id, value.value);
														return <button role="menuitemradio" aria-checked={selected} key={value.value} type="button" className={selected ? "item on" : "item"} disabled={!variant} onClick={() => { if (variant) { changeCloudChoice(cloudModel, variant); } }}>{value.displayName || value.value}{variant?.isMaxMode ? " · Max" : ""}{!variant && <small>Unavailable with the current configuration.</small>}{selected && <Icon name="check" className="menu-check" />}</button>;
													})}
												</div>
											))}
										</PopupMenu>
									)}
									{!isCloud && (menu === "model" || menu === "effort") && (
										<PopupMenu key={menu} className="pop up right" aria-label="Model and effort" opener={overlayOpener.current} onDismiss={() => setMenu(null)}>
											{menu === "model" && (
												<>
													<div className="menu-label">Model</div>
													{modelList.map((item) => (
														<button role="menuitemradio" aria-checked={baseModel === item} key={item} type="button" className={baseModel === item ? "item on" : "item"} onClick={() => {
															const next = fastOn && FAST_MODEL[item] ? FAST_MODEL[item] : item;
															const allowed = models.find((entry) => entry.id === next)?.efforts;
															const choice = { model: next, effort: allowed?.length && !allowed.includes(effort) ? allowed[allowed.length > 1 ? 1 : 0] : (next === "grok-4.5" && effort === "xhigh" ? "high" : effort) };
															changeSettings(choice);
															if (pending) { setPending((current) => current ? { ...current, ...choice } : current); } else { updateSession(session.id, choice); }
														}}>
															{models.find((entry) => entry.id === item)?.name ?? item}
															<small>{models.find((entry) => entry.id === item)?.description ?? ""}</small>
															{baseModel === item && <Icon name="check" className="menu-check" />}
														</button>
													))}
													{FAST_MODEL[baseModel] && (
														<button type="button" className="item" role="menuitemcheckbox" aria-checked={fastOn} onClick={() => {
															const choice = { model: fastOn ? baseModel : FAST_MODEL[baseModel], effort };
															changeSettings(choice);
															if (pending) { setPending((current) => current ? { ...current, ...choice } : current); } else { updateSession(session.id, choice); }
														}}>
															Fast mode
															<small>Grok's faster build of this model</small>
															<Icon name={fastOn ? "check-square" : "square"} className="menu-check" />
														</button>
													)}
												</>
											)}
											<div className="menu-label">Effort</div>
											{efforts.map((item) => (
												<button role="menuitemradio" aria-checked={effort === item} key={item} type="button" className={effort === item ? "mode-row on" : "mode-row"} onClick={() => {
													const choice = { model, effort: item };
													changeSettings(choice);
													if (pending) { setPending((current) => current ? { ...current, ...choice } : current); } else { updateSession(session.id, choice); }
													setMenu(null);
												}}>{item}<small>{EFFORT_DETAIL[item] ?? ""}</small>{effort === item && <Icon name="check" className="menu-check" />}</button>
											))}
										</PopupMenu>
									)}
								</div>
							</div>
							{pending && <>
								{!session.folder && <p className="new-send-note">Choose a folder to send. You can type your task now.</p>}
								{!isCloud && worktreeReason && <p className="new-worktree-help" id="worktree-unavailable">Worktree: {worktreeReason}</p>}
								{session.environment === "Local" && sandboxBlocked && <p className="new-worktree-help" id="sandbox-unavailable">Sandbox: {WINDOWS_WORKTREE_SANDBOX}</p>}
								<div className="new-project-picks" role="group" aria-label={firstRun ? "From your Grok CLI sessions" : "Projects"}>
									{projectPicks.length > 0 && <span>{firstRun ? "From your Grok CLI sessions:" : "Projects:"}</span>}
									{projectPicks.map((folder) => <button key={folder} type="button" aria-pressed={folderKey(session.folder) === folderKey(folder)} title={folder} onClick={() => choosePendingFolder(folder)}><Icon name="folder" />{shortPath(folder)}</button>)}
									<button type="button" onClick={pickPendingFolder}><Icon name="folder" />{session.folder ? "Other folder…" : "Choose folder…"}</button>
								</div>
								{firstRun && !isCloud && <div className="new-setup-status" role="group" aria-label="Setup checks">
									{setup.result ? <>
										<span>{setup.result.grok.ok && <Icon name="check" />} {setup.result.grok.ok ? "Grok CLI installed" : "Grok CLI not installed"}</span>
										<span>{setup.result.grok.signedIn && <Icon name="check" />} {setup.result.grok.signedIn ? "Signed in" : "Sign-in needed"}</span>
										<span>{setup.result.git.ok && <Icon name="check" />} {setup.result.git.ok ? "Git installed" : "Git not found"}</span>
									</> : setup.checking && <span role="status">Checking setup…</span>}
									<button className="texty" type="button" disabled={setup.checking} onClick={() => checkSetup()}>Check setup</button>
								</div>}
							</>}
							{notices.map((item) => <div key={item.id} className="note composer-note" role="status">{item.text}<button type="button" className="texty" aria-label="Dismiss" onClick={() => setNotices((list) => list.filter((entry) => entry.id !== item.id))}><Icon name="close" /></button></div>)}
						</div>
					</div>
					{railShown && (
						<div className="rail-column" inert={!!fullPane}>
							{resizeHandle("railWidth", "Resize session rail", railWidth, RAIL_MIN, railCap)}
							<SessionRail
								key={session.id}
								session={session}
								sandboxSettings={settings}
								folderMissing={folderMissing}
								diff={progressiveChanges ? shownInventory : diffs[session.id]}
								branch={branch}
								pr={prInfo}
								usage={usage}
								breakdown={breakdown && breakdown.id === agentId ? breakdown : undefined}
								recentUsd={recentUsd}
								subscription={keyMode ? undefined : { plan: account?.plan || limit?.tier || "", percent: limit?.percent ?? null, period: limit?.period ? limitName : "", resets: formatLimitReset(limit?.resetsAt), stale: !!limit && limitStale }}
								onOpenDiff={(file) => { if (file) { setDiffFile(file); } showPane("diff"); }}
								onCompact={() => { send("/compact", false); }}
								onOpenUrl={(url) => openUrl(url, true)}
								onCreatePr={createPr}
								onMergeWhenReady={mergeWhenReady}
							/>
						</div>
					)}
					{panesOpen && !fullPane && resizeHandle("sideWidth", "Resize panes", paneWidth, paneMin, paneCap)}
					{mountedPanes.length > 0 && (
						<div key="pane-grid" className={fullPane ? "side-col expanded" : "side-col"} data-tall-stack={paneRows > 2 || undefined} hidden={!panesOpen} style={paneGridStyle}>
							{mountedPanes.map(sidePane)}
							{paneRows === 2 && paneRowDivider()}
						</div>
					)}
				</div>
			</main>
			{fileMenu && (
				<PopupMenu className="file-menu" aria-label="File actions" opener={fileMenu.opener} onDismiss={() => setFileMenu(null)} inert={settingsCover} style={{ top: Math.min(fileMenu.y, window.innerHeight - 260), left: Math.min(fileMenu.x, window.innerWidth - 220) }}>
					<button type="button" role="menuitem" onClick={() => openFile(fileMenu.file)}>Open</button>
					{!isCloud && <button type="button" role="menuitem" onClick={() => { setPrompt((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${fileMenu.file} `); setFileMenu(null); promptRef.current?.focus?.(); }}>Attach as context</button>}
					<button type="button" role="menuitem" onClick={() => openIn("vscode", fileMenu.file)}>Open in VS Code</button>
					<button type="button" role="menuitem" onClick={() => { void window.grokCode?.reveal(session.folder, fileMenu.file).then((result) => { if (!result.ok) { setNotice(result.error || "That file is not in this folder."); } }); setFileMenu(null); }}>Show in {FILE_MANAGER}</button>
					<div className="menu-label">Copy</div>
					<button type="button" role="menuitem" onClick={() => { copyText(PLATFORM === "win32" ? `${session.folder.replace(/[\\/]+$/, "")}\\${fileMenu.file.replace(/\//g, "\\")}` : `${session.folder.replace(/\/+$/, "")}/${fileMenu.file}`, "Copied the absolute path."); setFileMenu(null); }}>Absolute path</button>
					<button type="button" role="menuitem" onClick={() => { copyText(fileMenu.file, "Copied the relative path."); setFileMenu(null); }}>Relative path</button>
					<button type="button" role="menuitem" onClick={() => { copyText(fileMenu.file.split(/[\\/]/).pop() ?? fileMenu.file, "Copied the filename."); setFileMenu(null); }}>Filename</button>
				</PopupMenu>
			)}
			{shortcuts && (
				<div className="overlay" onClick={() => setShortcuts(false)}>
					<div className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} ref={focusShortcuts}>
						<h2>Keyboard shortcuts</h2>
						{Object.entries(SHORTCUTS).map(([group, shortcuts]) => (
							<div className="shortcut-group" key={group}>
								<h3>{group}</h3>
								<ul>{shortcuts.map(([key, label]) => <li key={`${key}-${label}`}><span>{label}</span><kbd>{keyLabel(key)}</kbd></li>)}</ul>
							</div>
						))}
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
			{sandboxPicker === session.id && <SandboxSettings settings={settings} onChange={changeSettings} picker={{ sessionId: session.id, sessions, onUse: (sandboxChoice) => { setSessionSandbox({ sandboxOn: true, sandboxChoice }); setSandboxPicker(""); }, onClose: () => setSandboxPicker("") }} />}
			{promptLibrary && <SavedPromptPicker prompts={settings.savedPrompts} draft={promptLibrary.text} mode={promptLibrary.mode} onSave={savePrompt} onInsert={insertPrompt} onClose={closePromptLibrary} />}
			{settingsOpen && <SettingsPage settings={settings} onChange={changeSettings} onClose={() => setSettingsOpen(null)} onCheckSetup={openSetupFromAbout} servers={servers} folder={session.folder} onRun={(text) => void runFromSettings(text)} initialTab={settingsOpen} signInStatus={signInStatus} signInCheck={setup.result?.grok} cloudKeyStatus={cloudKeyStatus} grokBot={grokBot} previewTheme={uiPreviewTheme} onPreviewTheme={setUiPreviewTheme} nav={historyNav} />}
			{routinesOpen && <RoutinesPage models={modelList.map((id) => ({ id, name: models.find((item) => item.id === id)?.name ?? id }))} effortsFor={effortsFor} defaultModel={model} defaultEffort={effort} onClose={() => setRoutinesOpen(false)} nav={historyNav} />}
			{setup.open && <Setup result={setup.result} checking={setup.checking} installing={setup.installing} onInstallGrok={() => void runInstall("grok")} onInstallGit={() => void runInstall("git")} onUpdateGrok={() => void runInstall("update")} onCheck={() => checkSetup()} onCopy={(text) => void copyText(text)} onClose={closeSetup} onOpenSignIn={() => { closeSetup(); setSettingsOpen("general"); }} />}
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
	return id === "plan" || id === "tasks" ? null : <Icon name={id} />;
}

function MenuButton({ label, icon, title, open, disabled, onClick }: { label: string; icon: IconName; title?: string; open: boolean; disabled?: boolean; onClick: () => void }) {
	const add = icon === "plus";
	const letters = icon === "folder" ? [...label] : [];
	const display = letters.length > 22 ? `${letters.slice(0, 11).join("")}…${letters.slice(-10).join("")}` : label;
	return (
		<button type="button" className={`chip${open ? " hot" : ""}${add ? " chip-add" : ""}`} title={title} aria-label={add ? title : display !== label ? label : undefined} disabled={disabled} onClick={onClick} aria-haspopup="menu" aria-expanded={open}>
			<Icon name={icon} />
			{!add && <><span className="chip-label">{display}</span><Icon name="chevron-down" className="chip-caret" /></>}
		</button>
	);
}
