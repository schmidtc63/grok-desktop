export type UiTheme = "light" | "dark";
export type UiValues = Record<string, string | number>;
export interface UiConfig { id: string; name: string; values: UiValues; }
export interface UiControl { key: string; label: string; css: string; kind: "px" | "percent" | "color" | "font" | "weight"; min?: number; max?: number; selector?: string[]; }
export interface UiElement { id: string; label: string; selector: string[]; sample?: string; noText?: boolean; controls: UiControl[]; }
export interface UiSection { id: string; label: string; help?: string; elements: UiElement[]; }

export const MAX_UI_CONFIGS = 50;
export const UI_FONTS = {
	system: { label: "System", stack: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
	arial: { label: "Arial", stack: "Arial, sans-serif" },
	verdana: { label: "Verdana", stack: "Verdana, sans-serif" },
	tahoma: { label: "Tahoma", stack: "Tahoma, sans-serif" },
	georgia: { label: "Georgia", stack: "Georgia, serif" },
	times: { label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
	garamond: { label: "EB Garamond", stack: '"EB Garamond", Georgia, serif' },
	consolas: { label: "Consolas", stack: 'Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace' },
	cascadia: { label: "Cascadia Mono", stack: '"Cascadia Mono", Consolas, ui-monospace, Menlo, monospace' },
	courier: { label: "Courier New", stack: '"Courier New", Courier, monospace' },
};
// A font installed on the computer is saved as local:<family>. The family goes inside a CSS string, so a saved name must not be able to close it.
export const LOCAL_FONT = "local:";
const fontName = /^[^\p{Cc}"\\<>{};]{1,120}$/u;

export function installedFontNames(fonts: { family: string }[]): string[] {
	const names = fonts.map(({ family }) => family).filter((family) => fontName.test(family));
	return [...new Set(names)].sort((first, second) => first.localeCompare(second));
}

function fontStack(control: UiControl, value: string): string {
	if (!value.startsWith(LOCAL_FONT)) { return UI_FONTS[value as keyof typeof UI_FONTS].stack; }
	// A computer without this font uses a standard one instead.
	const fallback = /^--(?:mono|editor|terminal)-font$/.test(control.css) ? UI_FONTS.consolas : UI_FONTS.system;
	return `"${value.slice(LOCAL_FONT.length)}", ${fallback.stack}`;
}

const pixels = (key: string, label: string, css: string, min: number, max: number): UiControl => ({ key, label, css, kind: "px", min, max });
const percent = (key: string, label: string, css: string): UiControl => ({ key, label, css, kind: "percent", min: 80, max: 200 });
const color = (key: string, label: string, css: string): UiControl => ({ key, label, css, kind: "color" });
const font = (key = "font", label = "Font", css = "font-family"): UiControl => ({ key, label, css, kind: "font" });
const size = pixels("size", "Text size", "font-size", 9, 40);
const textAt = (selector: string[]): UiControl[] => [{ ...size, selector }, { ...font(), selector }];
const line = pixels("lineHeight", "Line height", "line-height", 10, 60);
const weight: UiControl = { key: "weight", label: "Weight", css: "font-weight", kind: "weight" };
const text = color("color", "Text color", "color");
const background = color("background", "Background", "background-color");
const border = color("border", "Border color", "border-color");
const radius = pixels("radius", "Corner radius", "border-radius", 0, 24);
const vertical = pixels("paddingBlock", "Vertical padding", "padding-block", 0, 32);
const horizontal = pixels("paddingInline", "Horizontal padding", "padding-inline", 0, 32);

function tokens(entries: [string, string][]): UiControl[] {
	return entries.map(([key, label]) => color(key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), label, `--${key}`));
}

function element(id: string, label: string, selector: string | string[], controls: UiControl[], options?: Pick<UiElement, "sample" | "noText">): UiElement {
	return { id, label, selector: typeof selector === "string" ? [selector] : selector, controls, ...options };
}

const menuItems = [".pop button.item", ".mode-row", ".row-pop button", ".rail-menu button", ".file-menu button", ".bp-item"];

export const UI_SECTIONS: UiSection[] = [
	{ id: "app", label: "Whole app", help: "The fonts and size percentages here apply across the app. A Font or Text size on a single element overrides them. View > Zoom scales the whole window. Translucent colors become solid when you change them.", elements: [
		element("app.fonts", "Fonts and sizes", ":root", [font("text", "App text"), percent("textScale", "App text size (%)", "--text-scale"), font("mono", "Code", "--mono-font"), percent("monoScale", "Code size (%)", "--mono-scale"), font("display", "Titles", "--display-font"), percent("displayScale", "Titles size (%)", "--display-scale")]),
		element("app.backgrounds", "Backgrounds", ":root", tokens([["bg", "Window"], ["sidebar", "Sidebar and rail"], ["panel", "Panels"], ["panel-2", "Raised panels"], ["card", "Cards"], ["input", "Inputs"], ["pop", "Menus and dialogs"], ["chip", "Chips"], ["code", "Code"], ["bubble", "Your messages"]])),
		element("app.text", "Text colors", ":root", tokens([["text", "Main"], ["muted", "Secondary"], ["faint", "Faint"], ["code-text", "Code"], ["file-link-color", "File links"]])),
		element("app.accent", "Accent", ":root", tokens([["accent", "Accent"], ["accent-ink", "Text on accent"], ["gold", "Ornaments"], ["initial", "Account initial"], ["initial-bg", "Initial background"]])),
		element("app.lines", "Lines and hover", ":root", tokens([["line", "Lines"], ["line-strong", "Strong lines"], ["hover", "Hover"]])),
		element("app.status", "Status", ":root", tokens([["green", "Green"], ["amber", "Amber"], ["warning-text", "Warning text"], ["red", "Red"], ["blue", "Blue"], ["add-text", "Added text"], ["del-text", "Removed text"]])),
		element("app.syntax", "Code colors", ":root", tokens([["syn-keyword", "Keywords"], ["syn-name", "Names"], ["syn-function", "Functions"], ["syn-type", "Types"], ["syn-property", "Properties"], ["syn-string", "Strings"], ["syn-number", "Numbers"], ["syn-comment", "Comments"], ["syn-meta", "Meta"], ["syn-invalid", "Invalid"]])),
	] },
	{ id: "sidebar", label: "Sidebar", elements: [
		element("sidebar.panel", "Panel", ".sidebar", [background, border]),
		element("sidebar.newSession", "New session button", ".new-btn", [size, weight, font(), text]),
		element("sidebar.icons", "Tool icons", ".side-icon", [text], { noText: true }),
		element("sidebar.search", "Search box", ".side-search input", [size, font(), text, background, border, radius]),
		element("sidebar.filter", "Filter line", ".side-filter", [...textAt([".side-filter", ".side-filter .texty"]), text]),
		element("sidebar.project", "Project heading", ".group-label", [size, weight, font(), text]),
		element("sidebar.row", "Session row", ".session", [radius, vertical, horizontal]),
		element("sidebar.selected", "Selected session", ".session.active", [background]),
		element("sidebar.title", "Session title", ".session b", [size, font(), text]),
		element("sidebar.unread", "Unread session title", ".session.unread b", [size, weight, font(), text]),
		element("sidebar.meta", "Session details line", ".session small.session-meta", [size, font(), text]),
		element("sidebar.needsYou", '"Needs you" line', ".session small.needs-you", [size, font(), text]),
		element("sidebar.failed", "Error line", ".session small.failed", [size, font(), text]),
		element("sidebar.loops", "Loop count", ".session small.loop-count", [size, font(), text]),
		element("sidebar.account", "Account name", ".account-btn", [size, font(), text]),
		element("sidebar.plan", "Account plan and menu details", [".account-btn small", ".account-head span", ".account-foot"], [size, font(), text], { sample: ".account-btn small" }),
		element("sidebar.initial", "Account initial", ".account-btn .avatar", [size, font(), text, background, radius]),
	] },
	{ id: "title", label: "Title bar", elements: [
		element("title.bar", "Bar", ".topbar", [background, border, vertical, horizontal]),
		element("title.name", "Session title", ".title-btn", [size, weight, font(), text]),
		element("title.meta", "Project and branch", ".session-title .meta", [size, font(), text]),
		element("title.pane", "Pane button", ".pane-tab", [text, radius], { noText: true }),
		element("title.paneOn", "Open pane button", ".pane-tab.on", [text, background], { noText: true }),
	] },
	{ id: "chat", label: "Chat", help: "Reply styles also apply in side chat. Markdown headings, code and other Markdown styles apply in the Plan pane too.", elements: [
		element("chat.empty", "Empty chat line", ".chat-empty", [size, font(), text]),
		element("chat.userBubble", "Your message bubble", ".user-bubble", [{ ...background, css: "--bubble" }, radius, vertical, horizontal]),
		element("chat.userText", "Your message text", ".msg .message-text", [size, font(), text, { ...line, css: "--message-line-height", selector: [".msg.user"] }]),
		element("chat.reply", "Grok's reply text", ".msg.grok > .md", [size, font(), text, { ...line, css: "--message-line-height", selector: [".msg.grok"] }]),
		element("chat.h1", "Heading 1", ".md h1", [size, weight, font(), text]),
		element("chat.h2", "Heading 2", ".md h2", [size, weight, font(), text]),
		element("chat.h3", "Heading 3 and 4", [".md h3", ".md h4"], [size, weight, font(), text]),
		element("chat.inlineCode", "Inline code", [".md code:not(pre code)", ".msg.grok > .md code:not(pre code)"], [size, font(), text, background]),
		element("chat.codeFrame", "Code block frame", ".md-code", [background, border, radius]),
		element("chat.codeHeader", "Code block header", ".md-code-hd", [...textAt([".md-code-hd", ".md-code-hd .texty"]), text]),
		element("chat.codeText", "Code block text", ".md-code pre", [size, line, text, vertical, horizontal, { ...font(), selector: [".md-code pre code"] }]),
		element("chat.link", "Links", ".md a", [size, font(), text]),
		element("chat.fileLink", "File links", ".file-link", [size, font(), text]),
		element("chat.quote", "Quotes", ".md blockquote", [size, font(), text, border]),
		element("chat.table", "Table cells", ".md-table :is(th, td)", [size, font(), border]),
		element("chat.tableHead", "Table header", ".md-table th", [size, font(), background]),
		element("chat.diagram", "Diagram frame", ".md-diagram-body", [background], { noText: true }),
		element("chat.thinkingLabel", "Thinking label", ".thought-hd", [size, font(), text]),
		element("chat.thinkingText", "Thinking text", ".thought-bd", [size, font(), text, border]),
		element("chat.toolRow", "Tool row", ".tool-head", [...textAt([".tool-head", ".tool-count", ".tool-count .add", ".tool-count .del", ".tool-path", ".edit-view button"]), text]),
		element("chat.toolName", "Tool name", ".tool-label", [size, weight, font(), text]),
		element("chat.toolStatus", "Tool status", ".tool-status", [size, font(), text]),
		element("chat.toolOutput", "Tool output", ".tool-code", [size, line, font(), text, background, radius]),
		element("chat.approval", "Approval card", ".tool-row.live", [background, border, radius]),
		element("chat.question", "Question", ".tool-question", [...textAt([".tool-question", ".chip-tag"]), text]),
		element("chat.choice", "Answer choice", ".tool-choices button", [...textAt([".tool-choices button", ".opt-key"]), text, border, radius]),
		element("chat.tasks", "Task list", ".task-list", [size, font(), background, border, radius]),
		element("chat.taskItem", "Task item", ".task-item", [size, font(), text]),
		element("chat.time", "Message time", ".msg-time", [size, font(), text]),
		element("chat.messageActions", "Message actions", ".msg-actions .texty", [size, font(), text]),
		element("chat.note", "App notes", ".app-note", [...textAt([".app-note", ".app-note-body > strong", ".missing-folder-banner", ".missing-folder-banner button"]), background, border]),
		element("chat.working", "Working line", ".working", [size, font(), text]),
		element("chat.steer", "Steering note", ".steer-note", [size, font(), background]),
		element("chat.find", "Find bar", ".find-bar", [...textAt([".find-bar", ".find-count"]), background, border]),
	] },
	{ id: "composer", label: "Composer", elements: [
		element("composer.box", "Box", ".composer", [background, border, radius, vertical, horizontal]),
		element("composer.text", "Prompt text", ".composer textarea", [size, line, font(), text]),
		element("composer.chip", "Chips", ".composer-row .chip", [size, font(), text, background, border, radius]),
		element("composer.send", "Send button", ".send-btn", [text, background, radius], { noText: true }),
		element("composer.stop", "Stop button", ".send-btn.stop", [text, background], { noText: true }),
		element("composer.usage", "Usage meter", ".limit-meter", [size, font(), text]),
		element("composer.queued", "Queued messages", ".queued", [size, font(), text]),
		element("composer.notes", "Notes in the box", [".folder-warn", ".disconnect-choice", ".loop-line"], [size, font(), text], { sample: ".loop-line" }),
		element("composer.attachment", "Attachments", ".attach-chip", [size, font(), background, radius]),
		element("composer.suggestions", "Suggestion list", ".mention", [background, border]),
		element("composer.suggestion", "Suggestion", ".pop-list .item", [size, font(), text]),
		element("composer.suggestionGroup", "Suggestion group label", ".command-group-label", [size, font(), text]),
		element("composer.note", "Line under the box", ".composer-note", [size, font(), text]),
		element("composer.side", "Side chat", ".side-q", [...textAt([".side-q", ".side-q-hd .meta"]), background, border, radius]),
	] },
	{ id: "rail", label: "Session rail", elements: [
		element("rail.panel", "Panel", ".session-rail", [background, border]),
		element("rail.card", "Card", ".rail-card", [background, border, radius, vertical, horizontal]),
		element("rail.heading", "Card heading", ".rail-hd", [size, weight, font(), text]),
		element("rail.row", "Rows", ".rail-row", [size, font(), text]),
		element("rail.files", "Change counts and files", [".rail-counts", ".rail-file"], [...textAt([".rail-counts", ".rail-file", ".session-rail .add", ".session-rail .del"]), text]),
		element("rail.values", "Label and value rows", [".rail-kv", ".rail-costs summary"], [size, font(), text], { sample: ".rail-kv" }),
		element("rail.plan", "Plan card", ".rail-plan", [size, font(), background, border, radius]),
		element("rail.planTrack", "Plan bar track", ".rail-plan-bar", [background], { noText: true }),
		element("rail.planFill", "Plan bar fill", ".rail-plan-bar span", [background], { noText: true }),
		element("rail.contextHead", "Context heading", ".ctx-head", [size, font()]),
		element("rail.context", "Context rows", ".ctx-row", [size, font(), text]),
	] },
	{ id: "panes", label: "Panes", help: "Shared by Changes, Files, Terminal, Browser, Plan and Background tasks.", elements: [
		element("panes.frame", "Frame", ".pane", [background, border, radius]),
		element("panes.header", "Header", ".pane-hd", [size, font(), text, background, border]),
		element("panes.title", "Title", ".pane-hd b", [size, weight, font(), text]),
		element("panes.body", "Body", ".pane-bd", [size, font(), text, vertical, horizontal]),
	] },
	{ id: "changes", label: "Changes", elements: [
		element("changes.file", "File row", ".file-row", [size, font(), text, background, border, radius]),
		element("changes.status", "Status lines and labels", [".dp-load", ".dp-include-all", ".dp-badge"], [size, font()], { sample: ".dp-load" }),
		element("changes.block", "Diff block", ".dp-hunk", [background, border, radius]),
		element("changes.blockHead", "Diff block header", ".dp-hunk-hd", [{ ...size, selector: [".dp-hunk-hd", ".dp-goto"] }, font(), text]),
		element("changes.line", "Diff lines", [".dp-line", ".edit-side"], [size, line, font()]),
		element("changes.number", "Line numbers", ".dp-num", [size, font(), text]),
		element("changes.added", "Added lines", ".dp-add", [size, font(), background, { ...text, css: "--add-text" }]),
		element("changes.removed", "Removed lines", ".dp-del", [size, font(), background, { ...text, css: "--del-text" }]),
		element("changes.context", "Unchanged lines", ".dp-context .dp-text", [size, font(), text]),
		element("changes.note", "Review note", ".dp-note", [size, font(), background, border]),
		element("changes.footer", "Footer", ".dp-foot", [size, font(), background, border]),
	] },
	{ id: "files", label: "Files", elements: [
		element("files.filter", "Filter box", ".fp-filter", [size, font(), text, background, border, radius]),
		element("files.row", "File row", ".fp-row", [size, font(), text]),
		element("files.rowOn", "Open file row", ".fp-row.on", [size, font(), text, background]),
		element("files.frame", "Editor frame", ".fp-editor", [border, radius]),
		element("files.language", "Language menu", ".ce-lang", [size, font()]),
		element("files.editor", "Editor text", ":root", [{ ...size, css: "--editor-font-size" }, font("font", "Font", "--editor-font"), { ...line, css: "--editor-line-height" }], { sample: ".ui-sample-editor" }),
	] },
	{ id: "terminal", label: "Terminal", elements: [
		element("terminal.text", "Terminal text", ":root", [{ ...size, css: "--terminal-font-size" }, font("font", "Font", "--terminal-font"), { ...line, css: "--terminal-line-height" }], { sample: ".tp-out" }),
		element("terminal.colors", "Terminal colors", ".tp-pane", [{ ...background, css: "--code" }, { ...text, css: "--code-text" }], { sample: ".tp-out" }),
		element("terminal.tab", "Tab", ".tp-tab", [size, font(), text]),
		element("terminal.tabOn", "Selected tab", ".tp-tab.on", [size, font(), text, background]),
	] },
	{ id: "browser", label: "Browser", elements: [
		element("browser.tab", "Tab", ".bp-tab", [size, font(), text]),
		element("browser.tabOn", "Selected tab", ".bp-tab.on", [size, font(), text, background]),
		element("browser.bar", "Toolbar", ".bp-bar", [background, border]),
		element("browser.address", "Address box", ".bp-addr input", [size, font(), text, background, border, radius]),
		element("browser.problems", "Problems list", [".bp-problems", ".bp-problems li", ".bp-problems-btn"], [size, font(), text]),
		element("browser.control", '"Grok is using this" bar', ".bp-control", [...textAt([".bp-control", ".bp-control small"]), text, background]),
	] },
	{ id: "tasks", label: "Background tasks", elements: [
		element("tasks.row", "Task row", ".bg-task", [size, font(), text, border]),
		element("tasks.output", "Task output", [".task-output", ".task-command"], [size, font(), text], { sample: ".task-output" }),
	] },
	{ id: "menus", label: "Menus and dialogs", elements: [
		element("menus.menu", "Menu", [".pop", ".row-pop", ".rail-menu", ".file-menu", ".bp-menu"], [background, border, radius], { sample: ".row-pop" }),
		element("menus.item", "Menu item", menuItems, [...textAt([...menuItems, ".bp-server-name"]), radius, { ...text, selector: menuItems.map((selector) => selector === ".row-pop button" ? ".row-pop button:not(.danger)" : selector) }], { sample: ".row-pop button" }),
		element("menus.detail", "Menu item detail", [".mode-row small", ".item small", ".popup-menu button small", ".popup-menu .menu-reason", ".row-pop.cli-sessions button small", ".row-pop.cli-sessions .meta"], [size, font(), text], { sample: ".popup-menu button small" }),
		element("menus.section", "Menu section label", ".menu-label", [size, weight, font(), text]),
		element("menus.dialog", "Dialog", ".sheet", [...textAt([".sheet", ".sheet kbd", ".set-row small", ".sandbox-output"]), background, border, radius, vertical, horizontal]),
		element("menus.dialogTitle", "Dialog title", ".sheet h2", [size, weight, font(), text]),
		element("menus.dialogHeading", "Dialog headings", [".shortcut-group h3", ".setup-row h3", ".sandbox-sheet-body h3"], [size, weight, font(), text], { sample: ".shortcut-group h3" }),
		element("menus.button", "Button", [".texty", ".actions button"], [size, font(), text, border, radius]),
		element("menus.primary", "Main button", ".actions .yes", [size, weight, font(), text, background]),
	] },
	{ id: "new", label: "New session", elements: [
		element("new.heading", "Heading", ".new-page h1", [size, weight, font(), text]),
		element("new.intro", "Folder intro", ".new-folder-intro", [size, font(), text]),
		element("new.project", "Project buttons", ".new-project-picks button", [...textAt([".new-project-picks", ".new-project-picks button"]), text, background, border]),
		element("new.status", "Setup checks", ".new-setup-status", [size, font(), text]),
		element("new.note", "Notes", [".new-send-note", ".new-worktree-help"], [size, font(), text]),
		element("new.field", "Form labels", ".field", [size, font(), text]),
	] },
];

const THEMES: UiTheme[] = ["light", "dark"];
export const UI_WEIGHTS = [400, 500, 600, 700];

export function uiKeys(element: UiElement, control: UiControl): string[] {
	const key = `${element.id}.${control.key}`;
	return control.kind === "color" ? THEMES.map((theme) => `${key}.${theme}`) : [key];
}

const controls = new Map<string, { control: UiControl; selectors: string[]; theme?: UiTheme }>();
for (const element of UI_SECTIONS.flatMap((section) => section.elements)) {
	for (const control of element.controls) {
		uiKeys(element, control).forEach((key, index) => {
			controls.set(key, {
				control,
				selectors: control.selector ?? element.selector,
				theme: control.kind === "color" ? THEMES[index] : undefined,
			});
		});
	}
}

function validValue(control: UiControl, value: unknown): value is UiValues[string] {
	switch (control.kind) {
		case "px":
		case "percent": return typeof value === "number" && Number.isInteger(value) && value >= control.min! && value <= control.max!;
		case "color": return typeof value === "string" && value.length === 7 && /^#[0-9a-f]{6}$/i.test(value);
		case "weight": return typeof value === "number" && UI_WEIGHTS.includes(value);
		case "font": return typeof value === "string" && (Object.hasOwn(UI_FONTS, value) || (value.startsWith(LOCAL_FONT) && fontName.test(value.slice(LOCAL_FONT.length))));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeValues(values: unknown): UiValues {
	if (!isRecord(values)) { return {}; }
	const normalized: UiValues = {};
	for (const [key, value] of Object.entries(values)) {
		const definition = controls.get(key);
		if (definition && validValue(definition.control, value)) { normalized[key] = value; }
	}
	return normalized;
}

export function uiConfigNameError(configs: UiConfig[], name: string, id?: string): string {
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > 80) { return "Use a name from 1 to 80 characters."; }
	const lower = trimmed.toLowerCase();
	if (lower === "default") { return "Default is reserved for the built-in look."; }
	if (configs.some((config) => config.id !== id && config.name.toLowerCase() === lower)) { return "A configuration already has that name."; }
	return "";
}

export function normalizeUiConfigs(value: unknown): UiConfig[] {
	const configs: UiConfig[] = [];
	if (!Array.isArray(value)) { return configs; }
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string") { continue; }
		const { id, name, values } = item;
		if (configs.some((config) => config.id === id) || uiConfigNameError(configs, name)) { continue; }
		configs.push({ id, name: name.trim(), values: normalizeValues(values) });
		if (configs.length === MAX_UI_CONFIGS) { break; }
	}
	return configs;
}

export function setUiValues(configs: UiConfig[], id: string, values: UiValues): UiConfig[] {
	if (!configs.some((config) => config.id === id)) { return configs; }
	return configs.map((config) => config.id === id ? { ...config, values } : config);
}

export function uiConfigCss(values: UiValues): string {
	const rules: string[] = [];
	// Catalog order, not saved order: a row and the broader row it overrides often tie on specificity, so its rule must come later.
	for (const [key, { control, selectors, theme }] of controls) {
		const value = values[key];
		if (!validValue(control, value)) { continue; }
		const cssValue = control.kind === "font" ? fontStack(control, String(value)) : control.kind === "px" ? `${value}px` : control.kind === "percent" ? Number(value) / 100 : value;
		const declaration = ` { ${control.css}: ${cssValue}; }`;
		const targets = (root: string) => selectors[0] === ":root"
			? `${root}, ${root === ":root" ? ".ui-preview" : `${root} .ui-preview`}`
			: selectors.map((selector) => `${root === ":root" ? "" : `:where(${root}) `}${selector}:where(:not(.settings-nav *, .settings-body *))`).join(", ");
		if (theme) {
			rules.push(`${targets(`:root[data-theme="${theme}"]`)}${declaration}`);
			rules.push(`@media (prefers-color-scheme: ${theme}) { ${targets(":root:not([data-theme])")}${declaration} }`);
		} else {
			rules.push(`${targets(":root")}${declaration}`);
		}
	}
	return rules.join("\n");
}

export function uiSampleSelector(element: UiElement, control?: UiControl): string {
	const selectors = control?.selector ?? (element.sample ? [element.sample] : element.selector);
	return selectors.map((selector) => selector === ":root" ? ".ui-preview" : `.ui-preview ${selector}`).join(", ");
}

let revision = 0;

export function applyUiConfig(css: string): void {
	if (typeof document === "undefined" || !document.head) { return; }
	let style = document.getElementById("ui-config");
	if (!style) {
		style = document.createElement("style");
		style.id = "ui-config";
		document.head.appendChild(style);
	}
	if (style.textContent !== css) {
		style.textContent = css;
		document.documentElement.setAttribute("data-ui-config", String(++revision));
	}
}

type Rgba = [number, number, number, number];

function rgba(value: string): Rgba | undefined {
	const color = value.trim().toLowerCase();
	if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(color)) {
		const hex = color.length <= 5 ? color.slice(1).replace(/./g, "$&$&") : color.slice(1);
		const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
		return [channel(0), channel(2), channel(4), hex.length === 8 ? channel(6) / 255 : 1];
	}
	const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+))?\s*\)$/.exec(color);
	if (!match) { return undefined; }
	const [red, green, blue] = match.slice(1, 4).map(Number);
	const alpha = Number(match[4] ?? 1);
	if (red > 255 || green > 255 || blue > 255 || alpha > 1) { return undefined; }
	return [red, green, blue, alpha];
}

export function uiColorHex(value: string): string | undefined {
	const color = rgba(value);
	return color && `#${color.slice(0, 3).map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([red, green, blue]: Rgba): number {
	const linear = (channel: number) => {
		const srgb = channel / 255;
		return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function ratio(foreground: Rgba, background: Rgba): number {
	const first = luminance(foreground);
	const second = luminance(background);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function contrastRatio(foreground: string, background: string): number {
	const front = rgba(foreground);
	const back = rgba(background);
	return front?.[3] === 1 && back?.[3] === 1 ? ratio(front, back) : NaN;
}

const displayRatio = (value: number) => (Math.floor(value * 100) / 100).toFixed(2);

export function contrastWarning(element: Element): string {
	const style = getComputedStyle(element);
	const foreground = rgba(style.color);
	if (foreground?.[3] !== 1) { return ""; }
	let background: Rgba | undefined;
	for (let node: Element | null = element; node; node = node.parentElement) {
		const current = node === element ? style : getComputedStyle(node);
		if (Number(current.opacity) < 1 || current.filter !== "none" || current.mixBlendMode !== "normal" || current.backdropFilter !== "none") { return ""; }
		if (!background) {
			const color = rgba(current.backgroundColor);
			if (!color || current.backgroundImage !== "none" || current.backgroundBlendMode !== "normal") { return ""; }
			if (color[3] === 1) { background = color; }
			else if (color[3] !== 0) { return ""; }
		}
	}
	if (!background) { return ""; }
	const size = Number.parseFloat(style.fontSize);
	const minimum = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
	const value = ratio(foreground, background);
	return value < minimum ? `Low contrast: ${displayRatio(value)}:1. Text this size needs at least ${minimum}:1.` : "";
}

export function tokenContrastWarnings(preview: Element): string[] {
	const style = getComputedStyle(preview);
	const pairs = [
		["--text", "--bg", "Main text on the window"],
		["--muted", "--bg", "Secondary text on the window"],
		["--text", "--panel", "Main text on panels"],
		["--code-text", "--code", "Code text on code"],
		["--accent-ink", "--accent", "Text on accent"],
	];
	const warnings: string[] = [];
	for (const [foreground, background, label] of pairs) {
		const value = contrastRatio(style.getPropertyValue(foreground), style.getPropertyValue(background));
		if (value < 4.5) { warnings.push(`${label} has low contrast (${displayRatio(value)}:1). It needs at least 4.5:1.`); }
	}
	return warnings;
}
