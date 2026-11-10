/// <reference types="vite/client" />

type GrokBotWindowState = "starting" | "open" | "missing" | "notfound" | "closed" | "elsewhere" | "problem";

interface GrokQuestion {
	question: string;
	options: { label: string; description?: string }[];
	multiSelect: boolean;
	header?: string;
}

interface GrokTodo {
	text: string;
	status: "pending" | "in_progress" | "completed";
}

interface GrokBgTask {
	id: string;
	label: string;
	command: string;
	outputFile?: string;
	kind: string;
	status: string;
	startedAt: number;
	endedAt: number;
	exitCode: number | null;
}

interface GrokLoop {
	id: string;
	prompt: string;
	schedule: string;
	nextFireAt: string;
	durable?: boolean;
	expiresAt?: string;
}

interface GrokSubagent {
	id: string;
	label: string;
	agentType: string;
	model: string;
	status: string;
	childSessionId?: string;
	output?: string;
	durationMs?: number;
	tokensUsed?: number;
	toolCalls?: number;
	endedAt?: number;
}

interface GrokUsage {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens: number;
	reasoningTokens: number;
	modelCalls: number;
	contextTokens: number;
	contextWindow: number;
	costUsd: number;
}

// Estimated tokens for the fixed parts of a Grok session's context.
interface ContextParts {
	systemPrompt: number;
	rules: number;
	skills: number;
	workflows: number;
	mcp: number;
	tools: number;
}

interface ContextBreakdown {
	parts: ContextParts;
	autoCompactPercent: number;
}

interface GrokCommand {
	name: string;
	description: string;
	hint: string;
}

interface GrokModel {
	id: string;
	name: string;
	description: string;
	efforts: string[];
	contextWindow: number;
}

interface GrokMcpServer {
	name: string;
	source: string;
	status: string;
}

interface GrokSignInStatus {
	mode: "grok" | "key";
	hasKey: boolean;
	keyReadable: boolean;
	keyring: boolean;
}

interface CursorKeyStatus {
	hasKey: boolean;
	keyReadable: boolean;
	keyring: boolean;
	name: string;
}

interface CursorSetupResult {
	ok: boolean;
	repoUrl?: string;
	ref?: string;
	upstream?: string;
	ahead?: number;
	behind?: number;
	dirty?: boolean;
	reachable?: boolean | null;
	error?: string;
	models?: import("./types").CursorModel[];
	modelsError?: string;
}

interface CloudTurnInput {
	uiSessionId: string;
	turnId: string;
	cloud: import("./types").CloudRecord;
}

interface GrokReadiness {
	grok: {
		ok: boolean;
		version?: string;
		signedIn?: boolean;
		signIn?: "saved" | "key" | "none";
		signInMode?: GrokSignInStatus["mode"];
		keySource?: "app" | "env";
		keyIgnored?: boolean;
		keyUnreadable?: boolean;
		keyRejected?: boolean;
		apiKey?: boolean;
		error?: string;
		at?: { source: "GROK_PATH" | "installer" | "PATH"; path: string };
		update?: { checked: boolean; current?: string; latest?: string; available?: boolean; autoUpdate?: boolean; channel?: string };
	};
	git: { ok: boolean };
	gh: { ok: boolean; signedIn?: boolean };
	install: string;
	platform: string;
	config?: { ok: boolean; files?: { role: string; path: string; broken: boolean }[]; warnings?: string[] };
	network?: { httpsProxy: string; httpProxy: string; noProxy: string; caCerts: string };
	app?: { version: string; electron: string; os: string };
}

// What `grok inspect`, `grok mcp list` and `grok plugin list` report for one folder.
interface GrokInventory {
	ok: boolean;
	error?: string;
	trusted?: boolean;
	skills?: { name: string; command: string; description: string; source: string; path: string; disabled: boolean }[];
	servers?: { name: string; detail: string; source: string; enabled: boolean; removable: boolean; transport?: string; target?: string; command?: string; args?: string[]; env?: { name: string; value: string }[]; headers?: { name: string; value: string }[]; configPath?: string }[];
	plugins?: { name: string; version: string; description: string; marketplace: string; installed: boolean; enabled: boolean }[];
	otherPlugins?: { name: string; detail: string }[];
	marketplaces?: { name: string; source: string }[];
}

type GrokCustomizeChange =
	| { action: "mcp-add"; name: string; transport: "stdio" | "http" | "sse"; target: string; env?: string; headers?: string; scope: "user" | "project" }
	| { action: "mcp-remove" | "mcp-enable" | "mcp-disable" | "plugin-uninstall" | "plugin-enable" | "plugin-disable" | "plugin-update"; name: string }
	| { action: "plugin-install" | "marketplace-add" | "marketplace-remove"; source: string }
	| { action: "marketplace-update" };

interface GrokToolEvent {
  id: string;
  kind?: string;
  title?: string;
  detail?: string;
  summary?: string;
  waiting?: boolean;
	label?: string;
	description?: string;
	command?: string;
	backgroundTask?: boolean;
	input?: string;
	path?: string;
	output?: string;
	additions?: number;
	deletions?: number;
	diff?: import("./types").ToolDiff;
	questions?: GrokQuestion[];
	plan?: string;
	todos?: GrokTodo[];
	// What Always allow would remember for this approval: the exact command in this folder, or the tool for this conversation.
	always?: "folder" | "conversation" | "site";
	noAlways?: boolean;
	commandPrefix?: string;
	readsOnly?: boolean;
}

interface GrokAlwaysRules {
	folder: string;
	commands: string[];
}

interface GrokAccount {
	email: string;
	plan: string;
	team: string;
	version: string;
}

type InboundResult = { accepted: true; status: "sent" | "queued" | "held" } | { accepted: false; stale?: true };

interface GrokOpenAtSignIn {
	ok: boolean;
	available: boolean;
	on: boolean;
	blockedBySystem: boolean;
	error?: string;
}

type GrokRoutineMode = "Auto-review" | "Normal" | "Always-approve";
type GrokRoutineSchedule =
	| { kind: "manual" }
	| { kind: "once"; at: number }
	// weekdays: 0 is Sunday, empty means every day. monthDay: 1 to 28, not with weekdays. months: 1 is January, empty means every month.
	| { kind: "recurring"; times: string[]; weekdays: number[]; monthDay: number | null; months: number[] };

// What a save sends. Leave id out for a new routine; the store makes it.
interface GrokRoutineInput {
	id?: string;
	name: string;
	prompt: string;
	folder: string;
	model: string;
	effort: string;
	mode: GrokRoutineMode;
	schedule: GrokRoutineSchedule;
}

interface GrokRoutine extends GrokRoutineInput {
	id: string;
	enabled: boolean;
	createdAt: number;
	resumedAt: number;
	lastScheduledFor: number;
	nextRun: number | null;
}

interface GrokRoutineRun {
	id: string;
	routineId: string;
	trigger: "schedule" | "manual";
	scheduledFor: number;
	dispatchedAt: number | null;
	sessionId: string;
	turnId: string;
	agentSessionId: string;
	state: "dispatched" | "running" | "unknown" | "finished" | "ended" | "failed" | "interrupted" | "skipped" | "missed";
	stopReason: string;
	waiting: string[];
	denied: string[];
	preview: string;
	error: string;
	endedAt: number | null;
}

interface GrokRoutinesState {
	routines: GrokRoutine[];
	runs: GrokRoutineRun[];
	error: string;
}

type GrokRoutineRequest =
	| { action: "list" }
	| { action: "save"; routine: GrokRoutineInput }
	| { action: "remove"; id: string }
	| { action: "setEnabled"; id: string; enabled: boolean }
	| { action: "runNow"; id: string }
	| { action: "stop"; runId: string }
	| { action: "open"; runId?: string };

interface GrokEvent {
	type: "chunk" | "thought" | "tool" | "done" | "error" | "mode" | "usage" | "context" | "commands" | "models" | "mcp" | "mcp-status" | "terminal-data" | "terminal-exit" | "account" | "sign-in-changed" | "bg-tasks" | "subagent" | "title" | "steer" | "turn-start" | "update-open" | "ui-default" | "inbound" | "loops" | "browser-open" | "browser-activity" | "cloud-state" | "cloud-key-changed" | "accessibility-support-changed" | "grokbot-status" | "grokbot-rows" | "grokbot-reset" | "grokbot-live" | "grokbot-failed" | "routines" | "routine-fire" | "routine-open";
	routineId?: string;
	sessionId?: string;
	project?: string;
	folder?: string;
	model?: string;
	effort?: string;
	routines?: GrokRoutine[];
	runs?: GrokRoutineRun[];
	error?: string;
	resume?: boolean;
	parallel?: boolean;
	background?: boolean;
	agentId?: string;
	runId?: string;
	active?: boolean;
	branch?: string;
	prUrl?: string;
	machine?: string;
	url?: string;
	running?: boolean;
	stopped?: boolean;
	requestId?: string;
	agentSessionId?: string;
	current?: string;
	latest?: string;
	tag?: string;
	tasks?: GrokBgTask[];
	loops?: GrokLoop[];
	reset?: boolean;
	subagent?: GrokSubagent;
	title?: string;
	account?: GrokAccount | null;
  uiSessionId: string;
	turnId: string;
  text?: string;
  tool?: GrokToolEvent;
  stopReason?: string;
  message?: string;
	mode?: "Plan" | "Normal" | "Auto-review" | "Always-approve";
	usage?: GrokUsage;
	contextTokens?: number;
	contextWindow?: number;
	commands?: GrokCommand[];
	models?: GrokModel[];
	servers?: GrokMcpServer[];
	name?: string;
	status?: string;
	id?: string;
	data?: string;
	code?: number | null;
}

interface PrCheck {
	name: string;
	state: "pass" | "fail" | "run" | "wait" | "skip";
	url?: string;
}

interface PrStatus {
	ok: boolean;
	error?: string;
	pr?: null | { number: number; title: string; url: string; state: string; isDraft: boolean; mergeable?: string; autoMerge: boolean; checks: PrCheck[]; feedback: { at: string; who: string; kind: "comment" | "review" }[] };
}

interface BranchInfo {
	ok: boolean;
	error?: string;
	repo?: boolean;
	branch?: string;
	base?: string;
	ahead?: number;
	behind?: number;
	upstream?: string;
}

interface GrokSendResult {
  ok: boolean;
  error?: string;
	mode?: GrokEvent["mode"];
	agentSessionId?: string;
	promptIndex?: number;
	lostSession?: boolean;
	closed?: boolean;
	warning?: string;
}

interface GrokSandboxChoice { option: "profile" | "docker" | "wsl" | "windows-sandbox"; profile?: "workspace" | "strict"; image?: string; distro?: string; mappedFolders?: string[] }
interface GrokSandboxCheck { ready: boolean; installed?: boolean; problem?: string; detail?: string; signedIn?: boolean; distros?: string[]; distro?: string }
interface GrokSandboxTest { ok: boolean; checks: { label: string; pass: boolean }[]; canReadOutside?: boolean; error?: string }
interface GrokBranchRequest { uiSessionId: string; cwd: string; model: string; effort: string; mode: string; agentSessionId: string; index: number; text: string; sandbox?: GrokSandboxChoice }
interface GrokRewindResult { ok: boolean; error?: string; done?: boolean; revertedFiles?: string[]; cleanFiles?: string[]; conflicts?: string[] }

interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
}

interface DiffHunk {
	revertible?: boolean;
  id: string;
  loc: string;
  lines: DiffLine[];
	reviewable?: boolean;
}

interface DiffFile {
  path: string;
	// The old path of a rename, in the same folder.
	from?: string;
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
	conflicted?: boolean;
	truncated?: boolean;
	patchLoaded?: boolean;
	patchFingerprint?: string;
}

interface DiffSnapshot {
  ok: boolean;
  error?: string;
  repo?: boolean;
  truncated?: boolean;
  files?: DiffFile[];
}

interface ChangesRequest {
	id: string;
	cwd: string;
	scope: string;
	file?: string;
	from?: string;
	full?: boolean;
}

interface FolderList {
  ok: boolean;
  error?: string;
  files?: string[];
  truncated?: boolean;
}

interface FileText {
  ok: boolean;
  error?: string;
  text?: string;
  binary?: boolean;
	version?: string;
}

interface WriteResult {
  ok: boolean;
  error?: string;
	version?: string;
	message?: string;
}

interface BrowserNetworkProblem {
	webContentsId: number;
	url: string;
	message: string;
	at: number;
}

interface GrokCodeApi {
  send: (payload: {
    uiSessionId: string;
		turnId: string;
		agentSessionId?: string;
    cwd: string;
		allowedFolders?: string[];
    text: string;
    model: string;
    effort: string;
    mode: string;
		attachments?: string[];
		browser?: boolean;
		routineRunId?: string;
		unattended?: boolean;
		sandbox?: GrokSandboxChoice;
  }) => Promise<GrokSendResult>;
	setMode?: (uiSessionId: string, mode: string) => Promise<{ ok: boolean; error?: string }>;
	sandboxCheck?: (choice: GrokSandboxChoice) => Promise<GrokSandboxCheck>;
	sandboxHolder?: () => Promise<string>;
	sandboxTest?: (choice: GrokSandboxChoice, model: string) => Promise<GrokSandboxTest>;
	sandboxSignIn?: (choice: GrokSandboxChoice) => Promise<{ ok: boolean; error?: string }>;
	sandboxBuild?: () => Promise<{ ok: boolean; error?: string }>;
	sandboxCancel?: () => Promise<void>;
	onSandboxText?: (callback: (text: string) => void) => () => void;
  cancel: (uiSessionId: string) => Promise<void>;
	stopSession?: (uiSessionId: string) => Promise<void>;
	forgetSession?: (uiSessionId: string) => Promise<void>;
  decide: (payload: { uiSessionId: string; toolId: string; decision: "allow" | "deny" | "always" | "prefix" }) => Promise<GrokSendResult>;
	answerQuestion: (payload: { uiSessionId: string; toolId: string; answers: Record<string, string> | null }) => Promise<GrokSendResult>;
	answerPlan: (payload: { uiSessionId: string; toolId: string; outcome: "approved" | "feedback" | "abandoned"; feedback?: string; mode?: "Normal" | "Auto-review" | "Always-approve" }) => Promise<GrokSendResult>;
	setAllowedFolders: (payload: { uiSessionId: string; allowedFolders: string[] }) => Promise<GrokSendResult>;
  pickFolder: () => Promise<string | null>;
  diff: (cwd: string) => Promise<DiffSnapshot>;
  files: (cwd: string) => Promise<FolderList>;
  readFile: (cwd: string, file: string) => Promise<FileText>;
	readImage?: (cwd: string, file: string) => Promise<{ ok: boolean; error?: string; dataUrl?: string; bytes?: number }>;
	writeFile: (cwd: string, file: string, text: string, expectedVersion: string) => Promise<WriteResult>;
	revertFile: (cwd: string, file: string, policy?: { sandbox: boolean }) => Promise<WriteResult>;
	revertHunk?: (cwd: string, file: string, hunk: DiffHunk) => Promise<WriteResult>;
  pickFiles: () => Promise<string[]>;
	newWindow: (uiSessionId?: string) => Promise<WriteResult>;
  copyText: (text: string) => Promise<WriteResult>;
  exportMarkdown?: (payload: { agentSessionId: string; title?: string }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string; path?: string }>;
  listCliSessions?: (knownIds: string[]) => Promise<{ ok: boolean; error?: string; sessions?: { id: string; title: string; folder: string; lastActive: number }[] }>;
	listCliProjectFolders?: () => Promise<string[]>;
  sessionLoops?: (uiSessionId: string, agentSessionId: string) => Promise<{ ok: boolean; live?: boolean; loops?: GrokLoop[] }>;
  openCliSession?: (agentSessionId: string) => Promise<{ ok: boolean; error?: string; truncated?: boolean; session?: { id: string; title: string; folder: string; branch?: string; model?: string; effort?: string; lastActive?: number }; messages?: { role: "user" | "grok"; text: string }[] }>;
  reveal: (cwd: string, file: string) => Promise<WriteResult>;
  onEvent: (callback: (event: GrokEvent) => void) => () => void;
	onBrowserProblem?: (callback: (problem: BrowserNetworkProblem) => void) => () => void;
	browserTabs?: (payload: { uiSessionId: string; enabled: boolean; visible: boolean; activeId: string; tabs: { id: string; webContentsId: number; url: string; problems: string }[] }) => Promise<WriteResult>;
	browserStop?: (uiSessionId: string) => Promise<WriteResult>;
	browserResume?: (uiSessionId: string) => Promise<WriteResult>;
	pathForFile: (file: File) => string;
	openExternal: (url: string) => Promise<WriteResult>;
	openIn: (payload: { target: "explorer" | "vscode"; cwd: string; file?: string; line?: number }) => Promise<WriteResult>;
	clearBrowsingData: (partition: string) => Promise<WriteResult>;
	attention: () => Promise<WriteResult>;
	taskbar?: (state: "idle" | "running" | "needs-you") => Promise<WriteResult>;
	keepAwake: (payload: { working: boolean; onBattery: boolean }) => Promise<WriteResult>;
	accessibilitySupport: () => Promise<boolean>;
	inbound?: (enabled: boolean) => Promise<WriteResult>;
	inboundResult?: (requestId: string, result: InboundResult) => Promise<void>;
	openAtSignIn?: (enabled?: boolean) => Promise<GrokOpenAtSignIn>;
	routinesReady?: () => Promise<void>;
	routines?: (request: GrokRoutineRequest) => Promise<WriteResult & Partial<GrokRoutinesState> & { id?: string; runId?: string }>;
	routineResult?: (runId: string, result: { ok: false; error: string }) => Promise<void>;
	saveImage: (base64: string) => Promise<WriteResult & { path?: string }>;
	prunePastedImages?: (history: string | null, backup?: string | null) => boolean;
	openImage: (file: string) => Promise<WriteResult>;
	appInfo: () => Promise<{ ok: boolean; version?: string; electron?: string }>;
	updateCheck?: (force?: boolean) => Promise<{ ok: boolean; available?: boolean; reason?: string; current?: string; latest?: string; tag?: string }>;
	updatePrepare?: (tag: string) => Promise<{ ok: boolean; ready?: boolean; busy?: boolean; asksPassword?: boolean; reason?: string; notes?: string; steps?: string; current?: string; latest?: string; tag?: string }>;
	updateStart?: (tag: string) => Promise<WriteResult>;
	updateResult?: () => Promise<{ ok: boolean; message: string } | null>;
	contextBreakdown?: (agentSessionId: string) => Promise<{ ok: boolean; error?: string } & Partial<ContextBreakdown>>;
	taskOutput?: (file: string) => Promise<{ ok: boolean; error?: string; text?: string; truncated?: boolean }>;
	subagentTranscript?: (id: string) => Promise<{ ok: boolean; error?: string; messages?: import("./types").ChatMessage[]; truncated?: boolean }>;
	suggestPrompt?: (uiSessionId: string) => Promise<string>;
	killTask?: (uiSessionId: string, taskId: string) => Promise<{ ok: boolean; error?: string; outcome?: string }>;
	rewind?: (payload: GrokBranchRequest & { rewindMode: "all" | "conversation_only" | "files_only"; force: boolean; seen?: string[] }) => Promise<GrokRewindResult>;
	fork?: (payload: GrokBranchRequest) => Promise<{ ok: boolean; error?: string; agentSessionId?: string }>;
	steer?: (uiSessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
	recentSpend?: () => Promise<{ ok: boolean; error?: string; usd?: number }>;
	homeDir?: string;
	platform?: string;
	readColdChat?: (id: string) => string | false | null;
	writeColdChat?: (id: string, text: string) => boolean;
	removeColdChats?: (ids: string[]) => Promise<void>;
	readiness?: (request?: { folder?: string; full?: boolean }) => Promise<GrokReadiness>;
	installGrok?: () => Promise<{ ok: boolean; error?: string }>;
	updateGrokCli?: () => Promise<{ ok: boolean; error?: string }>;
	installGit?: () => Promise<{ ok: boolean; error?: string }>;
	customize?: (cwd: string, skillsOnly?: boolean) => Promise<GrokInventory>;
	skillExcerpt?: (cwd: string, skillPath: string) => Promise<{ ok: boolean; text?: string; folder?: string; error?: string }>;
	customizeChange?: (cwd: string, input: GrokCustomizeChange) => Promise<{ ok: boolean; error?: string; message?: string }>;
	account?: () => Promise<GrokAccount | null | undefined>;
	billing?: () => Promise<{ ok: true; percent: number | null; period: string; resetsAt: string; tier: string } | { ok: false; error: string }>;
	signOut?: () => Promise<WriteResult>;
	signInStatus?: () => Promise<GrokSignInStatus>;
	saveSignIn?: (input: { mode: GrokSignInStatus["mode"]; key?: string }, options?: { signOutConfirmed?: boolean }) => Promise<WriteResult & { needsSignOut?: boolean }>;
	removeSignInKey?: () => Promise<WriteResult>;
	cloudKeyStatus?: () => Promise<CursorKeyStatus>;
	grokBotStatus?: () => Promise<import("./grok-bot-rows").GrokBotStatus & { ok: boolean }>;
	grokBotSignIn?: () => Promise<WriteResult>;
	grokBotCancelSignIn?: () => Promise<WriteResult>;
	grokBotSignOut?: () => Promise<WriteResult>;
	grokBotHistory?: (agentId: string, beforeSeq?: string) => Promise<WriteResult & { rows?: import("./grok-bot-rows").GrokBotRow[]; beforeSeq?: string }>;
	grokBotSend?: (payload: { agentId: string; messageId: string; text: string }) => Promise<WriteResult & { accepted?: boolean; delivery?: string; unknown?: boolean }>;
	grokBotStop?: (agentId: string) => Promise<WriteResult & { hadActiveRun?: boolean }>;
	grokBotAnswer?: (payload: { agentId: string; entryId: string; value: string }) => Promise<WriteResult>;
	grokBotOpenFile?: (payload: { agentId: string; entryId: string }) => Promise<WriteResult>;
	grokBotRetry?: () => Promise<WriteResult>;
	grokBotWindowOpen?: () => Promise<{ ok: boolean }>;
	grokBotWindowPlace?: (box: { x: number; y: number; width: number; height: number; viewHeight: number; visible: boolean }) => Promise<void>;
	grokBotWindowHide?: () => Promise<void>;
	grokBotWindowRelease?: () => Promise<void>;
	onGrokBotWindow?: (callback: (state: GrokBotWindowState) => void) => () => void;
	cloudKeySave?: (key: string) => Promise<WriteResult>;
	cloudKeyRemove?: () => Promise<WriteResult>;
	cloudSetup?: (folder: string) => Promise<CursorSetupResult>;
	cloudSend?: (payload: CloudTurnInput & { text: string; name: string }) => Promise<WriteResult>;
	cloudResume?: (payload: CloudTurnInput) => Promise<WriteResult>;
	cloudCancel?: (uiSessionId: string) => Promise<WriteResult>;
	devScripts: (cwd: string) => Promise<{ ok: boolean; scripts?: { script: string; command: string }[] }>;
	terminalOpen?: (payload: { cwd: string }) => Promise<WriteResult & { id?: string; backend?: "pty" | "pipe"; warning?: string }>;
	terminalWrite?: (id: string, text: string) => Promise<WriteResult>;
	terminalInput?: (id: string, data: string) => Promise<WriteResult>;
	terminalResize?: (id: string, cols: number, rows: number) => Promise<WriteResult>;
	terminalClose?: (id: string) => Promise<WriteResult>;
	terminalInterrupt?: (id: string) => Promise<{ ok: boolean; error?: string; stopped?: number }>;
	alwaysRules?: () => Promise<GrokAlwaysRules[]>;
	removeAlwaysRule?: (folder: string, command: string) => Promise<WriteResult>;
	branchInfo?: (cwd: string) => Promise<BranchInfo>;
	scopedDiff?: (cwd: string, scope: string) => Promise<DiffSnapshot>;
	readChanges?: (request: ChangesRequest) => Promise<DiffSnapshot>;
	stopChanges?: (id: string) => Promise<void>;
	listCommits?: (cwd: string) => Promise<{ ok: boolean; error?: string; commits?: { sha: string; short: string; subject: string; when: string }[] }>;
	prStatus?: (cwd: string, number?: number) => Promise<PrStatus>;
	prCreate?: (cwd: string, expected?: string, policy?: { sandbox: boolean }) => Promise<WriteResult & { url?: string; message?: string }>;
	gitCommit?: (cwd: string, options: { paths: string[]; message: string; push: boolean; expected?: string; sandbox?: boolean; hooks?: boolean }) => Promise<WriteResult & { message?: string; committed?: boolean; sha?: string }>;
	prMergeWhenReady?: (cwd: string, number: number) => Promise<WriteResult>;
	addWorktree?: (cwd: string, payload: { name: string; prefix: string; sandbox?: boolean }) => Promise<WriteResult & { folder?: string; branch?: string }>;
	restoreWorktree?: (folder: string, branch: string, policy?: { sandbox: boolean }) => Promise<WriteResult & { folder?: string; branch?: string }>;
	removeWorktree?: (cwd: string, folder: string, payload: { force: boolean; branch: string; autoArchive?: boolean }) => Promise<WriteResult & { dirty?: boolean; ignored?: string[]; skipped?: boolean }>;
}

interface Window {
  grokCode?: GrokCodeApi;
	queryLocalFonts?: () => Promise<{ family: string }[]>;
}
