export type PaneId =
  | "chat"
  | "diff"
  | "browser"
  | "terminal"
  | "editor"
  | "plan"
  | "tasks";

export type SidePaneId = Exclude<PaneId, "chat">;

export type SessionStatus = "running" | "needs-you" | "idle";

export type Environment = "Local" | "SSH" | "Cloud";

export type PermissionMode =
  | "Normal"
  | "Plan"
  | "Auto-review"
  | "Always-approve";

export function mapMode(mode: string | undefined): PermissionMode | undefined {
  if (mode === "Manual" || mode === "Accept edits") { return "Normal"; }
  if (mode === "Auto" || mode === "Bypass permissions") { return "Always-approve"; }
  if (mode === "Normal" || mode === "Plan" || mode === "Auto-review" || mode === "Always-approve") { return mode; }
  return undefined;
}

export type TranscriptView = "normal" | "thinking" | "verbose";

export interface ProjectSeed {
  project: string;
  folder: string;
  branch: string;
  worktree: string;
  environment: Environment;
}

export interface CursorParam { id: string; value: string }

export interface CursorVariant {
	params: CursorParam[];
	displayName?: string;
	isDefault?: boolean;
	isMaxMode?: boolean;
}

export interface CursorModel {
	id: string;
	displayName: string;
	parameters?: { id: string; displayName?: string; values: { value: string; displayName?: string }[] }[];
	variants: CursorVariant[];
}

export function validMachineName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/.test(value);
}

export interface CloudRecord {
	repoUrl: string;
	ref: string;
	model: { id: string; params: CursorParam[] };
	autoCreatePR: boolean;
	machine?: string;
	agentId?: string;
	runId?: string;
	turnId?: string;
	active?: boolean;
	branch?: string;
	prUrl?: string;
}

export interface Session {
  id: string;
	parentId?: string;
  title: string;
	titleAuto?: boolean;
  project: string;
  folder: string;
  branch: string;
  worktree: string;
  environment: Environment;
	cloud?: CloudRecord;
	cloudMachineDraft?: string;
	cloudModelLabel?: string;
  status: SessionStatus;
  detail: string;
  when: string;
  pinned: boolean;
  archived: boolean;
  source: "desktop" | "phone";
	agentSessionId?: string;
	model?: string;
	effort?: string;
	allowedFolders?: string[];
	createdAt?: number;
	lastActivityAt?: number;
	unread?: boolean;
	completed?: boolean;
	failed?: boolean;
	prWatch?: { number: number; failing: string[]; seenAt: string; alert?: { failed: string[]; feedback: number; from: string[] } };
	sectionId?: string;
	worktreeFolder?: string;
	usage?: GrokUsage;
	costUsd?: number;
}

export interface ToolCard {
  id?: string;
  kind: string;
  title: string;
  detail: string;
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
	diff?: ToolDiff;
	questions?: GrokQuestion[];
	plan?: string;
	todos?: GrokTodo[];
	always?: "folder" | "conversation" | "site";
	noAlways?: boolean;
	commandPrefix?: string;
	readsOnly?: boolean;
}

// The text an edit replaced and its replacement; Grok sends snippets, not whole files.
export interface ToolDiff { oldText: string; newText: string; oldLine?: number; newLine?: number; clipped?: boolean; whole?: boolean; replaceAll?: boolean }

// A reply keeps its text and tool calls in the order they arrived.
export type MessagePart = { kind: "text"; text: string } | { kind: "tool"; id: string } | { kind: "steer"; text: string };

export interface ChatMessage {
  id: string;
  role: "user" | "grok";
  text: string;
	appNote?: string;
	at?: number;
  thought?: string;
  tools?: ToolCard[];
	parts?: MessagePart[];
	attachments?: string[];
	contextFrom?: { id: string; title: string }[];
	point?: { agentSessionId: string; index: number };
  live?: boolean;
  pending?: boolean;
	streaming?: boolean;
}

// Claude Code Desktop's title-bar pane buttons; Plan and Background tasks live in the ⋮ menu.
export const PANES: { id: SidePaneId; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "diff", label: "Changes" },
  { id: "browser", label: "Browser" },
  { id: "editor", label: "Files" },
];

export const MENU_PANES: { id: SidePaneId; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "tasks", label: "Background tasks" },
];

export const MODES: { id: PermissionMode; detail: string }[] = [
  { id: "Normal", detail: "Ask before edits and commands." },
	{ id: "Plan", detail: "Explore and write a plan. Commands ask, unless you chose Always allow earlier in this session. Only the plan file can be edited." },
  { id: "Auto-review", detail: "Grok's safety check runs the call. A call it will not allow asks you." },
  { id: "Always-approve", detail: "Run tools without asking. Deny rules and safety hooks still apply." },
];

export const MODELS: string[] = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const EFFORT_DETAIL: Record<string, string> = {
	low: "Fastest. Least reasoning.",
	medium: "Balanced speed and reasoning.",
	high: "More reasoning. Slower.",
	xhigh: "Most reasoning. Slowest, and uses the most tokens.",
};
export type Effort = (typeof EFFORTS)[number];
export const FAST_MODEL: Record<string, string> = { "grok-4.7": "grok-4.7-build-fast" };

// The page loads from file://, so an attached image's own path serves as its thumbnail.
export function imageSrc(file: string) {
	return /\.(png|jpe?g|gif|webp)$/i.test(file) ? `file:///${encodeURI(file.replace(/\\/g, "/")).replace(/#/g, "%23")}` : "";
}
