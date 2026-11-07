// The main process's platform. Code loaded without the preload (tests) behaves as on Windows.
export const PLATFORM = (typeof window !== "undefined" && window.grokCode?.platform) || "win32";

// On macOS, Cmd takes Ctrl's place, except Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+`: macOS itself owns Cmd+Tab and Cmd+`.
export function modKey(event: { ctrlKey: boolean; metaKey: boolean; key: string; code: string }) {
	if (PLATFORM !== "darwin" || event.key === "Tab" || event.code === "Backquote") { return event.ctrlKey; }
	return event.metaKey;
}

// The same rule for shortcut text: "Ctrl+N" reads "Cmd+N" on macOS, and "Ctrl+click" reads "Cmd+click".
export function keyLabel(text: string) {
	return PLATFORM === "darwin" ? text.replace(/Ctrl\+(?!(?:Shift\+)?Tab|`)/g, "Cmd+") : text;
}

export const FILE_MANAGER = PLATFORM === "darwin" ? "Finder" : PLATFORM === "linux" ? "File Manager" : "File Explorer";

// Folder paths compare without case on Windows and macOS, whose usual file systems ignore it; Linux keeps case.
export function caseKey(text: string) {
	return PLATFORM === "linux" ? text : text.toLowerCase();
}

// Claude Code Desktop's shortcut list, with Windows keys.
export const SHORTCUTS: [string, string][] = [
	["Ctrl+/", "Show keyboard shortcuts"],
	["Ctrl+N", "New session"],
	["Ctrl+Tab", "Next session"],
	["Ctrl+Shift+Tab", "Previous session"],
	["Ctrl+Shift+]", "Next session"],
	["Ctrl+Shift+[", "Previous session"],
	["Ctrl+Alt+1", "New session: choose the Local environment"],
	["Esc", "Stop Grok's response"],
	["Enter", "Send, or steer while Grok works (commands and attachments queue)"],
	["Shift+Enter", "New line"],
	["@", "Mention a file"],
	["/", "Commands"],
	["!", "Run a shell command in the Terminal pane"],
	["Ctrl+Shift+D", "Toggle the Changes pane"],
	["Ctrl+Shift+B", "Toggle the Browser pane"],
	["Ctrl+Shift+S", "Select an element in the Browser"],
	["Ctrl+`", "Toggle the Terminal pane"],
	["Ctrl+\\", "Close the focused pane"],
	["Ctrl+;", "Open side chat"],
	["Ctrl+O", "Cycle transcript views"],
	["Ctrl+Shift+P", "Search saved prompts"],
	["Ctrl+F", "Find in the conversation"],
	["Ctrl+F", "Find and replace in the Files editor"],
	["Ctrl+C", "Stop the running command, in the Terminal input"],
	["Ctrl+Shift+M", "Open the permission mode menu"],
	["Ctrl+Shift+I", "Open the model menu"],
	["Ctrl+Shift+E", "Open the effort menu"],
	["1–9", "Pick an item in an open menu, or an answer in Grok's question"],
	["Ctrl+Enter", "Send diff comments (Changes pane)"],
	["Ctrl+,", "Open Settings"],
	["Ctrl+click", "Open a session in a new window, or a link in your browser"],
];
