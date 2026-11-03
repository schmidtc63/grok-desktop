/// <reference types="vite/client" />

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

interface GrokReadiness {
	grok: { ok: boolean; version?: string; signedIn?: boolean; error?: string };
	git: { ok: boolean };
	gh: { ok: boolean; signedIn?: boolean };
	install: string;
}

// What `grok inspect`, `grok mcp list` and `grok plugin list` report for one folder.
interface GrokInventory {
	ok: boolean;
	error?: string;
	trusted?: boolean;
	skills?: { name: string; command: string; description: string; source: string; path: string; disabled: boolean }[];
	servers?: { name: string; detail: string; source: string; enabled: boolean; removable: boolean }[];
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
	input?: string;
	path?: string;
	output?: string;
	additions?: number;
	deletions?: number;
	diff?: import("./types").ToolDiff;
	questions?: GrokQuestion[];
	plan?: string;
	todos?: GrokTodo[];
}

interface GrokAccount {
	email: string;
	plan: string;
	team: string;
	version: string;
}

interface GrokEvent {
	type: "chunk" | "thought" | "tool" | "done" | "error" | "mode" | "usage" | "context" | "commands" | "models" | "mcp" | "mcp-status" | "terminal-data" | "terminal-exit" | "account" | "bg-tasks" | "subagent" | "title" | "steer";
	tasks?: GrokBgTask[];
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
	pr?: null | { number: number; title: string; url: string; state: string; isDraft: boolean; mergeable?: string; autoMerge: boolean; checks: PrCheck[] };
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
	agentSessionId?: string;
	promptIndex?: number;
	lostSession?: boolean;
	closed?: boolean;
}

interface GrokBranchRequest { uiSessionId: string; cwd: string; model: string; effort: string; mode: string; agentSessionId: string; index: number; text: string }
interface GrokRewindResult { ok: boolean; error?: string; done?: boolean; revertedFiles?: string[]; cleanFiles?: string[]; conflicts?: string[] }

interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
}

interface DiffHunk {
  id: string;
  loc: string;
  lines: DiffLine[];
	reviewable?: boolean;
}

interface DiffFile {
  path: string;
  additions?: number;
  deletions?: number;
  hunks: DiffHunk[];
}

interface DiffSnapshot {
  ok: boolean;
  error?: string;
  repo?: boolean;
  truncated?: boolean;
  files?: DiffFile[];
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

interface CommandResult {
  ok: boolean;
  error?: string;
  code?: number;
  output?: string;
  truncated?: boolean;
	timedOut?: boolean;
}

interface WriteResult {
  ok: boolean;
  error?: string;
	version?: string;
	message?: string;
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
  }) => Promise<GrokSendResult>;
  cancel: (uiSessionId: string) => Promise<void>;
	stopSession?: (uiSessionId: string) => Promise<void>;
	forgetSession?: (uiSessionId: string) => Promise<void>;
  decide: (payload: { uiSessionId: string; toolId: string; decision: "allow" | "deny" | "always" }) => Promise<GrokSendResult>;
	answerQuestion: (payload: { uiSessionId: string; toolId: string; answers: Record<string, string> | null }) => Promise<GrokSendResult>;
	answerPlan: (payload: { uiSessionId: string; toolId: string; outcome: "approved" | "feedback" | "abandoned"; feedback?: string; mode?: "Normal" | "Auto-review" | "Always-approve" }) => Promise<GrokSendResult>;
	setAllowedFolders: (payload: { uiSessionId: string; allowedFolders: string[] }) => Promise<GrokSendResult>;
  pickFolder: () => Promise<string | null>;
  diff: (cwd: string) => Promise<DiffSnapshot>;
  files: (cwd: string) => Promise<FolderList>;
  readFile: (cwd: string, file: string) => Promise<FileText>;
	writeFile: (cwd: string, file: string, text: string, expectedVersion: string) => Promise<WriteResult>;
  revertFile: (cwd: string, file: string) => Promise<WriteResult>;
  pickFiles: () => Promise<string[]>;
	newWindow: (uiSessionId?: string) => Promise<WriteResult>;
  copyText: (text: string) => Promise<WriteResult>;
  reveal: (cwd: string, file: string) => Promise<WriteResult>;
  run: (payload: { cwd: string; command: string }) => Promise<CommandResult>;
  onEvent: (callback: (event: GrokEvent) => void) => () => void;
	pathForFile: (file: File) => string;
	openExternal: (url: string) => Promise<WriteResult>;
	openIn: (payload: { target: "explorer" | "vscode"; cwd: string; file?: string; line?: number }) => Promise<WriteResult>;
	clearBrowsingData: (partition: string) => Promise<WriteResult>;
	attention: () => Promise<WriteResult>;
	keepAwake: (payload: { working: boolean; onBattery: boolean }) => Promise<WriteResult>;
	saveImage: (base64: string) => Promise<WriteResult & { path?: string }>;
	openImage: (file: string) => Promise<WriteResult>;
	appInfo: () => Promise<{ ok: boolean; version?: string; electron?: string }>;
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
	readiness?: () => Promise<GrokReadiness>;
	customize?: (cwd: string) => Promise<GrokInventory>;
	customizeChange?: (cwd: string, input: GrokCustomizeChange) => Promise<{ ok: boolean; error?: string; message?: string }>;
	account?: () => Promise<GrokAccount | null | undefined>;
	signOut?: () => Promise<WriteResult>;
	devScripts: (cwd: string) => Promise<{ ok: boolean; scripts?: { script: string; command: string }[] }>;
	terminalOpen?: (payload: { cwd: string }) => Promise<WriteResult & { id?: string }>;
	terminalWrite?: (id: string, text: string) => Promise<WriteResult>;
	terminalClose?: (id: string) => Promise<WriteResult>;
	terminalHistory?: (id: string) => Promise<string>;
	branchInfo?: (cwd: string) => Promise<BranchInfo>;
	scopedDiff?: (cwd: string, scope: string) => Promise<DiffSnapshot>;
	listCommits?: (cwd: string) => Promise<{ ok: boolean; error?: string; commits?: { sha: string; short: string; subject: string; when: string }[] }>;
	prStatus?: (cwd: string) => Promise<PrStatus>;
	prCreate?: (cwd: string, expected?: string) => Promise<WriteResult & { url?: string; message?: string }>;
	prMergeWhenReady?: (cwd: string, number: number) => Promise<WriteResult>;
	addWorktree?: (cwd: string, payload: { name: string; prefix: string }) => Promise<WriteResult & { folder?: string; branch?: string }>;
	restoreWorktree?: (folder: string, branch: string) => Promise<WriteResult & { folder?: string; branch?: string }>;
	removeWorktree?: (cwd: string, folder: string, payload: { force: boolean }) => Promise<WriteResult & { dirty?: boolean; ignored?: string[] }>;
}

interface Window {
  grokCode?: GrokCodeApi;
}
