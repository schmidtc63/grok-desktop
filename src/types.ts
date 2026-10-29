export type PaneId =
  | "chat"
  | "diff"
  | "browser"
  | "terminal"
  | "editor"
  | "plan"
  | "tasks";

export type SidePaneId = Exclude<PaneId, "chat">;

export type SessionStatus = "running" | "needs-you" | "idle" | "scheduled";

export type Environment = "Local" | "SSH" | "Cloud";

export type PermissionMode =
  | "Manual"
  | "Accept edits"
  | "Plan"
  | "Auto"
  | "Bypass permissions";

export type TranscriptView = "normal" | "thinking" | "verbose";

export interface ProjectSeed {
  project: string;
  folder: string;
  branch: string;
  worktree: string;
  environment: Environment;
}

export interface Session {
  id: string;
  title: string;
  project: string;
  folder: string;
  branch: string;
  worktree: string;
  environment: Environment;
  status: SessionStatus;
  detail: string;
  when: string;
  pinned: boolean;
  archived: boolean;
  source: "desktop" | "phone";
	agentSessionId?: string;
	allowedFolders?: string[];
	createdAt?: number;
	lastActivityAt?: number;
	unread?: boolean;
	completed?: boolean;
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
	questions?: GrokQuestion[];
	plan?: string;
	todos?: GrokTodo[];
}

// A reply keeps its text and tool calls in the order they arrived.
export type MessagePart = { kind: "text"; text: string } | { kind: "tool"; id: string };

export interface ChatMessage {
  id: string;
  role: "user" | "grok";
  text: string;
  thought?: string;
  tools?: ToolCard[];
	parts?: MessagePart[];
	attachments?: string[];
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
  { id: "Manual", detail: "Ask before edits and commands." },
  { id: "Accept edits", detail: "Auto-accept file edits in the session's folders. Still ask before other commands." },
  { id: "Plan", detail: "Explore and propose a plan. No source edits." },
  { id: "Auto", detail: "Run tools without asking. Grok Desktop has no safety classifier for this mode." },
  { id: "Bypass permissions", detail: "No prompts. Meant for a sandbox or a VM." },
];

export const MODELS: string[] = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];
export const FAST_MODEL: Record<string, string> = { "grok-4.7": "grok-4.7-build-fast" };
