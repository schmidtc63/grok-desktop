const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { transformSync } = require("esbuild");

const storageLocks = new WeakMap();
// App's child components render as named placeholders so a test can read the props App gives them.
const PLACEHOLDERS = {
	"./Panes": { AppNote: "AppNote", PaneView: "PaneView", SideLog: "SideLog" },
	"./Sidebar": { Sidebar: "Sidebar" },
	"./SessionRail": { SessionRail: "SessionRail" },
	"./DiffPane": { DiffPane: "DiffPane" },
	"./FilesPane": { FilesPane: "FilesPane" },
	"./TerminalPane": { TerminalPane: "TerminalPane" },
	"./BrowserPane": { BrowserPane: "BrowserPane" },
	"./GrokBotView": { GrokBotView: "GrokBotView" },
	"./GrokBotWindow": { GrokBotWindow: "GrokBotWindow" },
	"./SavedPromptPicker": { SavedPromptPicker: "SavedPromptPicker" },
};

function harness(storage = new Map(), search = "", clock = Date, timers = { setTimeout, clearTimeout }, fresh = false, platform = "win32") {
	if (!storageLocks.has(storage)) {
		const tails = new Map();
		storageLocks.set(storage, {
			request(name, options, callback) {
				if (typeof options === "function") { callback = options; options = {}; }
				const result = (tails.get(name) ?? Promise.resolve()).then(() => {
					if (options.signal?.aborted) { throw new DOMException("Aborted", "AbortError"); }
					return callback();
				});
				tails.set(name, result.catch(() => {}));
				return result;
			},
			async drain() { await Promise.all([...tails].filter(([name]) => name !== "grok-code.pr-watch").map(([, tail]) => tail)); },
		});
	}
	const locks = storageLocks.get(storage);
	const hooks = [];
	let cursor = 0;
	let dirty = true;
	let tree;
	let listener;
	let effects = [];
	const files = { "a.txt": { text: "original\r\n", version: "a1" }, "b.txt": { text: "other", version: "b1" } };
	const sends = [];
	const writes = [];
	const historyWrites = [];
	const settingsWrites = [];
	const pickedFolders = [];
	const forgotten = [];
	const pickedFiles = [];
	const allowedUpdates = [];
	const newWindows = [];
	const questionAnswers = [];
	const planAnswers = [];
	const decisions = [];
	const cancels = [];
	const modeChanges = [];
	const confirms = [];
	const notifications = [];
	let confirmAnswer = true;
	let chooseFixtureFolder = !fresh && !storage.has("grok-code.history.v1");
	const windowEvents = new Map();
	let colorPicker;
	const jsx = (type, props, key) => {
		if (colorPicker && type === "input" && props?.type === "color" && props.ref) { props.ref.current = colorPicker; }
		return { type, props: props ?? {}, key };
	};
	const react = {
		Fragment: "fragment",
		lazy: () => "Lazy",
		Suspense: "Suspense",
		createElement: (type, props, ...children) => jsx(type, { ...props, children: children.length > 1 ? children : children[0] }),
		useState(initial) {
			const i = cursor++;
			if (!hooks[i]) { hooks[i] = { value: typeof initial === "function" ? initial() : initial }; }
			return [hooks[i].value, (update) => {
				const value = typeof update === "function" ? update(hooks[i].value) : update;
				if (!Object.is(hooks[i].value, value)) { hooks[i].value = value; dirty = true; }
			}];
		},
		useRef(value) {
			const i = cursor++;
			if (!hooks[i]) { hooks[i] = { current: value }; }
			return hooks[i];
		},
		useId() { return `test-id-${cursor++}`; },
		useMemo(fn, deps) {
			const i = cursor++;
			if (!hooks[i] || deps.some((value, j) => !Object.is(value, hooks[i].deps[j]))) { hooks[i] = { value: fn(), deps }; }
			return hooks[i].value;
		},
		useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
		useEffect(fn, deps) {
			const i = cursor++;
			if (!hooks[i] || !deps || deps.some((value, j) => !Object.is(value, hooks[i].deps[j]))) {
				effects.push(() => { hooks[i]?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; });
			}
		},
	};
	react.useLayoutEffect = react.useEffect;
	const api = {
		platform,
		onEvent(fn) { listener = fn; return () => {}; },
		diff: async () => ({ ok: true, files: [] }),
		files: async () => ({ ok: true, files: Object.keys(files) }),
		readFile: async (_cwd, file) => files[file] ? { ok: true, ...files[file] } : { ok: false, error: "Missing file." },
		writeFile: async (...args) => {
			writes.push(args);
			if (args[3] !== files[args[1]].version) { return { ok: false, error: "The file changed on disk." }; }
			files[args[1]] = { text: args[2], version: "saved" };
			return { ok: true, version: "saved" };
		},
		send: async (input) => { sends.push(input); return { ok: true, agentSessionId: "provider-session" }; },
		setMode: async (id, mode) => { modeChanges.push({ id, mode }); return { ok: true }; },
		decide: async (input) => { decisions.push(input); return { ok: true }; },
		pickFolder: async () => pickedFolders.shift() ?? null,
		branchInfo: async () => ({ ok: true, repo: true }),
		addWorktree: async () => ({ ok: false, error: "No worktree fixture" }),
		forgetSession: async (id) => { forgotten.push(id); },
		pickFiles: async () => pickedFiles.shift() ?? [],
		setAllowedFolders: async (input) => { allowedUpdates.push(input); return { ok: true }; },
		newWindow: async (id) => { newWindows.push(id); return { ok: true }; },
		answerQuestion: async (input) => { questionAnswers.push(input); return { ok: true }; },
		answerPlan: async (input) => { planAnswers.push(input); return { ok: true }; },
		cancel: async (id) => { cancels.push(id); },
		homeDir: path.join(__dirname, ".."),
	};
	const appWindow = { innerWidth: 1400, grokCode: api, location: { search }, confirm: (message) => { confirms.push(message); return confirmAnswer; }, focus() {}, addEventListener: (event, callback) => windowEvents.set(event, callback), removeEventListener: (event) => windowEvents.delete(event) };
	appWindow.setInterval = (run, delay) => { const timer = setInterval(run, delay); timer.unref(); return timer; };
	appWindow.clearInterval = clearInterval;
	const cache = {};
	const attributes = new Map();
	const documentNodes = new Map();
	const appDocument = {
		documentElement: {
			setAttribute: (name, value) => attributes.set(name, value),
			getAttribute: (name) => attributes.get(name),
			removeAttribute: (name) => attributes.delete(name),
		},
		head: { appendChild: (node) => documentNodes.set(node.id, node) },
		createElement: () => ({ textContent: "" }),
		getElementById: (id) => documentNodes.get(id),
		hasFocus: () => true, querySelector: () => null, querySelectorAll: () => [],
	};
	function load(name) {
		if (cache[name]) { return cache[name]; }
		const file = path.join(__dirname, "..", "src", name);
		const source = transformSync(fs.readFileSync(file, "utf8"), { loader: name.endsWith("tsx") ? "tsx" : "ts", format: "cjs", jsx: "automatic" }).code;
		const module = { exports: {} };
		const imports = (id) => {
			if (name === "FilesPane.tsx" && id === "./CodeEditorLoader") { return { CodeEditorLoader: "CodeEditor" }; }
			if (id === "react") { return react; }
			if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
			if (name === "App.tsx" && PLACEHOLDERS[id]) { return PLACEHOLDERS[id]; }
			if (id.endsWith(".css")) { return {}; }
			if (!id.startsWith("./")) { return require(id); }
			const base = id.slice(2);
			return load(fs.existsSync(path.join(__dirname, "..", "src", `${base}.ts`)) ? `${base}.ts` : `${base}.tsx`);
		};
		vm.runInNewContext(source, {
			require: imports, module, exports: module.exports, crypto: { randomUUID },
			navigator: { locks }, setTimeout: (run, delay) => { const timer = timers.setTimeout(run, delay); if (delay >= 10000) { timer?.unref?.(); } return timer; }, clearTimeout: timers.clearTimeout, HTMLElement: class {}, DOMException, Date: clock, AbortController,
			Notification: class { constructor(title, options) { Object.assign(this, { title, ...options }); notifications.push(this); } },
			document: appDocument,
			localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { if (storage.failWrites) { throw storage.failWrites === "quota" ? new DOMException("The quota has been exceeded.", "QuotaExceededError") : new Error("Quota exceeded"); } storage.set(key, value); if (key === "grok-code.history.v1") { historyWrites.push(value); } if (key === "grok-code.settings.v1") { settingsWrites.push(value); } } },
			window: appWindow, URL, URLSearchParams,
		}, { filename: file });
		cache[name] = module.exports;
		return module.exports;
	}
	const { App } = load("App.tsx");
	let component = App;
	function render() {
		let passes = 0;
		while (dirty) {
			assert.ok(passes++ < 30, "render effects must settle");
			dirty = false;
			cursor = 0;
			tree = component();
			const pending = effects;
			effects = [];
			pending.forEach((effect) => effect());
		}
		if (chooseFixtureFolder) {
			chooseFixtureFolder = false;
			const choose = nodes(tree).find((node) => node.type === "button" && textOf(node) === "Choose folder…");
			if (choose) { pickedFolders.unshift(api.homeDir); choose.props.onClick(); }
		}
		return tree;
	}
	function nodes(value, found = []) {
		if (!value || typeof value !== "object") { return found; }
		if (Array.isArray(value)) { value.forEach((item) => nodes(item, found)); return found; }
		if (value.props) { found.push(value); nodes(value.props.children, found); }
		return found;
	}
	async function settle() {
		for (let i = 0; i < 5; i++) { render(); await locks.drain(); await new Promise((resolve) => setImmediate(resolve)); }
		return render();
	}
	const find = (predicate) => nodes(tree).find(predicate);
	function settingsTree(value) {
		if (Array.isArray(value)) { return value.map(settingsTree); }
		if (!value || typeof value !== "object" || !value.props) { return value; }
		if (value.type === "Lazy") { return load("EditorSettings.tsx").EditorSettings(value.props); }
		return { ...value, props: { ...value.props, children: settingsTree(value.props.children) } };
	}
	return {
		storage, locks, sends, writes, historyWrites, settingsWrites, pickedFolders, forgotten, pickedFiles, allowedUpdates, newWindows, questionAnswers, planAnswers, decisions, cancels, confirms, notifications, files, api, modeChanges, settle, render, window: appWindow, document: appDocument,
		unmount: () => hooks.forEach((hook) => hook?.cleanup?.()),
		prFixPrompt: (number, alert) => load("prWatch.ts").prFixPrompt(number, alert),
		cloudModels: () => load("cloud-models.ts"),
		get confirmAnswer() { return confirmAnswer; },
		set confirmAnswer(value) { confirmAnswer = value; },
		window: appWindow,
		windowEvent: (name, event = {}) => windowEvents.get(name)?.(event),
		unloadNow: () => { const event = { prevented: false, returnValue: true, preventDefault() { this.prevented = true; } }; windowEvents.get("beforeunload")?.(event); return event; },
		async beforeUnload() { await appWindow.grokPrepareUnload?.(); return this.unloadNow(); },
		storageEvent: (key) => windowEvents.get("storage")?.({ key }),
		key: (event) => windowEvents.get("keydown")({ preventDefault() {}, stopPropagation() {}, target: {}, ctrlKey: false, shiftKey: false, altKey: false, code: "", ...event }),
		ask: (question) => load("confirm.ts").askConfirm(question),
		confirmModule: () => load("confirm.ts"),
		fileHits: (text, known = [], tools = []) => load("Panes.tsx").mentionedFiles(text, tools, "C:/project", known),
		editRows: (diff) => load("Panes.tsx").editRows(diff),
		splitRows: (rows) => load("Panes.tsx").splitRows(rows),
		splitFits: (width) => load("Panes.tsx").splitFits(width),
		SPLIT_MIN_WIDTH: () => load("Panes.tsx").SPLIT_MIN_WIDTH,
		readSettings: () => load("Settings.tsx").readSettings(),
		editorLanguages: () => load("editor-languages.ts"),
		editDiff: (props) => load("Panes.tsx").EditDiff(props),
		editDiffView: (props) => { component = () => load("Panes.tsx").EditDiff(props); dirty = true; return render(); },
		settingsView: (props) => { component = () => settingsTree(load("Settings.tsx").SettingsPage(props)); dirty = true; return render(); },
		grokBotView: (props) => { component = () => load("GrokBotView.tsx").GrokBotView(props); dirty = true; return render(); },
		uiConfigView: (props, remount = false) => {
			if (remount) { hooks.splice(0).forEach((hook) => hook?.cleanup?.()); }
			component = () => load("UiConfigSettings.tsx").UiConfigSettings(props);
			dirty = true;
			return render();
		},
		uiControlView: (control, picker) => {
			colorPicker = picker;
			component = () => { const field = load("UiConfigSettings.tsx").UiValueControl(control.props); return field.type(field.props); };
			dirty = true;
			return render();
		},
		sandboxView: (props) => { component = () => load("SandboxSettings.tsx").SandboxSettings(props); dirty = true; return render(); },
		sandboxModule: () => load("sandbox.ts"),
		customizeView: (props) => { component = () => load("Customize.tsx").Customize(props); dirty = true; return render(); },
		customizeModule: () => load("Customize.tsx"),
		catalog: () => load("connector-catalog.ts"),
		redactKeys: (value) => load("redact.ts").redactKeys(value),
		messageTime: (message) => load("Panes.tsx").messageTime(message),
		supportReport: (result) => load("Setup.tsx").supportReport(result),
		sideCap: (width, sidebarWidth) => load("App.tsx").sideCap(width, sidebarWidth),
		shouldCollapseSidebar: (width, panesOpen) => load("App.tsx").shouldCollapseSidebar(width, panesOpen),
		markdown: (props) => { component = () => load("Markdown.tsx").Markdown(props); dirty = true; return render(); },
		view: (id, model) => { component = () => { const pane = load("Panes.tsx").PaneView({ id, model }); return pane.type(pane.props); }; dirty = true; return render(); },
		row: (props) => { component = () => load("Panes.tsx").ToolRow(props); dirty = true; return render(); },
		group: (props) => { component = () => load("Panes.tsx").ToolGroup(props); dirty = true; return render(); },
		rail: (props) => { component = () => load("SessionRail.tsx").SessionRail(props); dirty = true; return render(); },
		diffView: (props) => { component = () => load("DiffPane.tsx").DiffPane(props); dirty = true; return render(); },
		fileFingerprint: (file) => load("DiffPane.tsx").fileFingerprint(file),
		canMarkViewed: (file) => load("DiffPane.tsx").canMarkViewed(file),
		filesView: (props) => { component = () => load("FilesPane.tsx").FilesPane({ ...props, autoSave: false }); dirty = true; return render(); },
		message: (model, readOnly = false, extra = {}) => { component = () => { const pane = load("Panes.tsx").PaneView({ id: "chat", model }); const chat = pane.type(pane.props); const body = nodes(chat).find((node) => node.type.name === "MessageBody"); return body.type({ ...body.props, readOnly, ...extra }); }; dirty = true; return render(); },
		userClipOverflows: (contentHeight, boxHeight) => load("Panes.tsx").userClipOverflows(contentHeight, boxHeight),
		userClipBoxHeight: (lineHeightPx) => load("Panes.tsx").userClipBoxHeight(lineHeightPx),
		USER_MESSAGE_LINES: () => load("Panes.tsx").USER_MESSAGE_LINES,
		contextSnapshot: (title, messages) => load("context-from-chat.ts").contextSnapshot(title, messages),
		contextForGrok: (blocks, request) => load("context-from-chat.ts").contextForGrok(blocks, request),
		contextChoices: (sessions, currentId) => load("context-from-chat.ts").contextChoices(sessions, currentId),
		addContextPick: (current, pick) => load("context-from-chat.ts").addContextPick(current, pick),
		CONTEXT_PICK_LIMIT: () => load("context-from-chat.ts").CONTEXT_PICK_LIMIT,
		CONTEXT_SNAPSHOT_CHARS: () => load("context-from-chat.ts").CONTEXT_SNAPSHOT_CHARS,
		emit: (event) => listener(event),
		model: () => find((node) => node.type === "PaneView").props.model,
		sidebar: () => find((node) => node.type === "Sidebar").props,
		// The Files pane's props, opening the pane first when it is closed.
		editor: () => {
			if (!find((node) => node.type === "FilesPane")) {
				find((node) => node.props["aria-label"] === "Files" && node.props.className?.startsWith("pane-tab")).props.onClick();
				render();
			}
			return find((node) => node.type === "FilesPane").props;
		},
		notice: () => [nodes(tree).filter((node) => node.props.className === "note composer-note").at(-1)?.props.children].flat()[0],
		notices: () => nodes(tree).filter((node) => node.props.className === "note composer-note").map((node) => [node.props.children].flat()[0]),
		node: find,
		nodes: (value = tree) => nodes(value),
	};
}

function strings(value, found = []) {
	if (typeof value === "string" || typeof value === "number") { found.push(String(value)); return found; }
	if (Array.isArray(value)) { value.forEach((item) => strings(item, found)); return found; }
	if (value && typeof value === "object" && value.props) { strings(value.props.children, found); }
	return found;
}

// Values made inside the vm context fail deepStrictEqual on their prototypes, so compare their JSON.
function same(actual, expected, message) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function textOf(value) {
	return strings(value).join("");
}

function button(appWindow, label) {
	return appWindow.node((node) => node.type === "button" && (node.props["aria-label"] === label || [node.props.children].flat()[0] === label));
}

function worktreeInput(appWindow) {
	return appWindow.node((node) => node.props["aria-label"] === "Worktree");
}

function folderChip(appWindow) {
	return appWindow.node((node) => node.type.name === "MenuButton" && node.props.icon === "folder");
}

function chooseEnvironment(appWindow, environment) {
	appWindow.node((node) => node.type.name === "MenuButton" && node.props.title === "Environment").props.onClick();
	appWindow.render();
	const choice = button(appWindow, environment);
	assert.equal(choice.props.disabled, false);
	choice.props.onClick();
}

function queuedAction(appWindow, index, label) {
	const row = appWindow.nodes().filter((node) => node.props.className === "queued")[index];
	return row && appWindow.nodes(row).find((node) => node.type === "button" && (node.props["aria-label"] === label || textOf(node) === label));
}

function typePrompt(appWindow, text) {
	appWindow.node((node) => node.props["aria-label"] === "Prompt").props.onChange({ target: { value: text } });
	appWindow.render();
}

function sendPrompt(appWindow, text) {
	typePrompt(appWindow, text);
	const stamp = Date.now();
	while (Date.now() === stamp) {
		// Message ids come from Date.now(), so each send waits for a new millisecond.
	}
	button(appWindow, "Send").props.onClick();
}

// A new session is a page until its first message, like Claude's; sending commits it.
async function startSession(appWindow, text) {
	appWindow.sidebar().onNew();
	await appWindow.settle();
	sendPrompt(appWindow, text);
	await appWindow.settle();
	return appWindow.model().session.id;
}

function savedHistory(appWindow) {
	return JSON.parse(appWindow.storage.get("grok-code.history.v1"));
}

function controlledTimers() {
	let now = 0;
	let sequence = 0;
	const waiting = new Map();
	return {
		setTimeout(callback, delay) { const id = ++sequence; waiting.set(id, { callback, at: now + delay }); return id; },
		clearTimeout(id) { waiting.delete(id); },
		advance(ms) {
			now += ms;
			for (const [id, timer] of waiting) { if (timer.at <= now) { waiting.delete(id); timer.callback(); } }
		},
	};
}

async function check() {
	const app = harness();
	await app.settle();
	const firstId = app.model().session.id;
	assert.equal(app.model().session.environment, "Local");
	assert.equal(app.model().session.project, path.basename(path.join(__dirname, "..")), "a first session opens in the home folder the main process names");
	assert.ok(fs.existsSync(app.model().session.folder));
	// Auto save off, since with it on opening another file saves the draft first.
	app.editor().onAutoSave(false);
	app.render();
	app.editor().onEdit("draft\n");
	app.render();
	app.editor().onSelectFile("b.txt");
	await app.settle();
	app.editor().onSelectFile("a.txt");
	await app.settle();
	assert.equal(app.editor().draft.text, "draft\n", "file navigation preserves the dirty draft");
	assert.equal(app.editor().draft.version, "a1");

	sendPrompt(app, "first turn");
	await app.settle();
	assert.equal(app.sends.length, 1);
	assert.equal(app.model().session.agentSessionId, "provider-session");
	app.emit({ type: "tool", uiSessionId: firstId, turnId: app.sends.at(-1).turnId, tool: { id: "approval", waiting: true, detail: "Waiting for you" } });
	await app.settle();
	const observer = harness(app.storage);
	await observer.settle();
	assert.equal(observer.model().messages.at(-1).tools[0].waiting, false, "a restored approval is not actionable");
	assert.equal(savedHistory(app).extraChats[firstId].at(-1).tools[0].waiting, true, "opening another window does not overwrite the owner's active card");
	app.node((node) => node.props.label === "Normal").props.onClick();
	app.render();
	assert.equal(app.nodes().filter((node) => node.props.className?.startsWith("mode-row")).every((node) => node.props.disabled), true);
	const secondId = await startSession(app, "second turn");
	assert.equal(app.sends.length, 2, "a second session runs while the first is still answering");
	assert.equal(app.sends[1].uiSessionId, secondId);
	const firstTurn = app.sends[0].turnId;
	app.emit({ type: "chunk", uiSessionId: firstId, turnId: firstTurn, text: "original reply" });
	app.emit({ type: "chunk", uiSessionId: secondId, turnId: app.sends[1].turnId, text: "second reply" });
	app.emit({ type: "tool", uiSessionId: firstId, turnId: firstTurn, tool: { id: "approval", waiting: false, detail: "Allowed" } });
	app.emit({ type: "done", uiSessionId: firstId, turnId: firstTurn });
	app.emit({ type: "done", uiSessionId: secondId, turnId: app.sends[1].turnId });
	await app.settle();
	assert.equal(app.model().messages.at(-1).text, "second reply", "each reply stays in its own session");
	assert.equal(app.sidebar().sessions.find((item) => item.id === firstId).unread, true, "a session that finishes in the background is marked unread");
	observer.sidebar().onPin(firstId);
	await observer.settle();
	assert.equal(savedHistory(app).extraChats[firstId].at(-1).text, "original reply", "a stale window's unrelated changes preserve shared history");
	observer.sidebar().onSelect(firstId);
	await observer.settle();
	sendPrompt(observer, "follow up");
	await observer.settle();
	assert.equal(observer.sends[0].agentSessionId, "provider-session");
	assert.ok(savedHistory(app).extraChats[firstId].some((message) => message.text === "original reply"), "new messages from a stale window merge without replacing the previous response");
	app.sidebar().onSelect(firstId);
	await app.settle();
	assert.equal(app.model().messages.at(-1).text, "original reply");
	assert.equal(app.sidebar().sessions.find((item) => item.id === firstId).unread, false, "selecting a session marks it read");
	const findAt = app.model().findAt;
	assert.equal(app.sidebar().chats[firstId].at(-1).text, "original reply", "sidebar search reads the saved conversations");
	app.sidebar().onSelect(firstId, "Original");
	await app.settle();
	assert.deepEqual({ ...app.model().findAt }, { tick: findAt.tick + 1, text: "Original" }, "a message-text match opens Find in the main chat with the search text");
	app.sidebar().onSelect(firstId);
	await app.settle();
	assert.equal(app.model().findAt.tick, findAt.tick + 1, "a plain selection leaves Find alone");

	app.files["a.txt"] = { text: "agent change\r\n", version: "a2" };
	app.editor().onSelectFile("b.txt");
	await app.settle();
	app.editor().onSelectFile("a.txt");
	await app.settle();
	assert.equal(app.editor().draft.text, "draft\n");
	assert.equal(app.editor().draft.version, "a1", "refresh keeps the draft's original save version");
	assert.equal(app.editor().conflict, true, "a newer disk version shows the conflict banner");
	app.editor().onSave();
	await app.settle();
	assert.equal(app.writes.at(-1)[2], "draft\r\n", "a CRLF file stays CRLF when saved from textarea text");
	assert.equal(app.writes.at(-1)[3], "a1");
	assert.equal(app.editor().draft.note, "The file changed on disk.", "a stale save is refused");
	app.editor().onDiscard();
	await app.settle();
	assert.equal(app.editor().draft.text, "agent change\r\n", "Discard loads the latest disk contents");
	assert.equal(app.editor().draft.version, "a2");
	assert.ok(app.editor().draft.recoveryTexts.includes("draft\n"), "Discard keeps the user's text as a retained draft");
	app.editor().onEdit("agent change\nmerged draft\n");
	app.render();
	app.editor().onSave();
	await app.settle();
	assert.equal(app.writes.at(-1)[3], "a2", "the reconciled draft saves against the newly loaded version");
	assert.equal(app.editor().draft.version, "saved");
	assert.ok(app.editor().draft.recoveryTexts.includes("draft\n"), "successful saving does not silently discard retained text");
	const restored = harness(app.storage);
	await restored.settle();
	restored.sidebar().onSelect(firstId);
	await restored.settle();
	assert.ok(restored.model().messages.some((message) => message.text === "original reply"), "history survives a new App mount");
	assert.equal(restored.model().session.agentSessionId, "provider-session");
	assert.equal(restored.sidebar().sessions.length, 2);
	assert.ok(restored.editor().draft.recoveryTexts?.includes("draft\n"), "retained text survives a new App mount after its file is saved");

	const chat = harness();
	const model = { session: { id: "scroll", worktree: "GrokCode", project: "GrokCode", folder: "C:/project" }, messages: [{ id: "reply", text: "one" }], todos: [], view: "normal" };
	chat.view("chat", model);
	const scroller = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 };
	chat.node((node) => node.props.ref).props.ref.current = scroller;
	chat.node((node) => node.props.onScroll).props.onScroll({ currentTarget: scroller });
	model.messages[0].text = "two";
	chat.view("chat", model);
	assert.equal(scroller.scrollTop, 0, "streaming preserves a user's scroll-up position");
	scroller.scrollTop = 800;
	chat.node((node) => node.props.onScroll).props.onScroll({ currentTarget: scroller });
	model.messages[0].text = "three";
	chat.view("chat", model);
	assert.equal(scroller.scrollTop, 1000, "streaming follows when the user is already at the bottom");

	const recovery = harness();
	await recovery.settle();
	recovery.editor().onEdit("recover this draft");
	recovery.render();
	sendPrompt(recovery, "delete file");
	await recovery.settle();
	delete recovery.files["a.txt"];
	assert.equal(recovery.model().busy, true);
	recovery.emit({ type: "done", uiSessionId: recovery.model().session.id, turnId: recovery.sends.at(-1).turnId });
	await recovery.settle();
	assert.equal(recovery.model().busy, false, "the done event was handled");
	assert.equal(recovery.editor().file, "a.txt", "completion refresh keeps the deleted dirty path selected");
	assert.ok(recovery.editor().files.files.includes("a.txt"), "the deleted dirty path stays selectable");
	const viewer = harness();
	viewer.filesView(recovery.editor());
	assert.equal(viewer.node((node) => node.props["aria-label"] === "File text").props.value, "recover this draft");
	assert.equal(viewer.node((node) => node.props["aria-label"] === "File text").props.readOnly, true);
	recovery.files["a.txt"] = { binary: true, text: "", version: "binary" };
	recovery.editor().onSelectFile("b.txt");
	await recovery.settle();
	recovery.editor().onSelectFile("a.txt");
	await recovery.settle();
	viewer.filesView(recovery.editor());
	assert.equal(viewer.node((node) => node.props["aria-label"] === "File text").props.value, "recover this draft", "a re-encoded file does not hide its prior draft");
	assert.equal(viewer.node((node) => node.props["aria-label"] === "File text").props.readOnly, true);
	assert.equal(recovery.editor().draft.version, "a1");

	const sharedStorage = new Map();
	const firstWindow = harness(sharedStorage);
	const secondWindow = harness(sharedStorage);
	let release;
	const held = firstWindow.locks.request("grok-code.history.v1", () => new Promise((resolve) => { release = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	firstWindow.render();
	secondWindow.render();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sharedStorage.get("grok-code.history.v1"), undefined, "all persistence writes must wait for the shared exclusive lock");
	for (const appWindow of [firstWindow, secondWindow]) {
		appWindow.render();
		appWindow.sidebar().onNew();
		appWindow.render();
		sendPrompt(appWindow, "a new chat");
	}
	await new Promise((resolve) => setImmediate(resolve));
	firstWindow.render();
	secondWindow.render();
	const ids = [firstWindow, secondWindow].flatMap((appWindow) => appWindow.sidebar().sessions.map((session) => session.id));
	release();
	await Promise.all([held, firstWindow.settle(), secondWindow.settle()]);
	const storedIds = new Set(JSON.parse(sharedStorage.get("grok-code.history.v1")).sessions.map((session) => session.id));
	assert.equal(storedIds.size, 4, "overlapping queued writes preserve both windows' initial and new chats");
	assert.ok(ids.every((id) => storedIds.has(id)));

	const scoped = harness();
	await scoped.settle();
	const scopedId = scoped.model().session.id;
	const scopedCwd = scoped.model().session.folder;
	async function addAllowed(picked) {
		if (!button(scoped, "Add folder")) {
			scoped.node((node) => node.props.label === "+").props.onClick();
			scoped.render();
		}
		scoped.pickedFolders.push(picked);
		button(scoped, "Add folder").props.onClick();
		await scoped.settle();
	}
	sendPrompt(scoped, "default folders");
	await scoped.settle();
	assert.equal(scoped.sends[0].allowedFolders.length, 0, "cwd and system temp remain backend defaults");
	scoped.emit({ type: "done", uiSessionId: scopedId, turnId: scoped.sends.at(-1).turnId });
	await scoped.settle();
	await addAllowed(null);
	assert.equal(scoped.allowedUpdates.length, 0, "cancelled picker does not change policy");
	await addAllowed("C:\\Shared\\One");
	assert.equal(scoped.allowedUpdates[0].uiSessionId, scopedId);
	assert.equal(scoped.model().session.allowedFolders.join("|"), "C:\\Shared\\One");
	assert.equal(scoped.model().session.folder, scopedCwd);
	assert.equal(scoped.model().session.agentSessionId, "provider-session");
	await addAllowed("c:/SHARED/one///");
	assert.equal(scoped.allowedUpdates.length, 1, "Windows slash/case variants do not add duplicates");
	sendPrompt(scoped, "use allowed folder");
	await scoped.settle();
	assert.equal(scoped.sends[1].allowedFolders.join("|"), "C:\\Shared\\One");
	await addAllowed("C:\\Shared\\Two");
	assert.equal(scoped.allowedUpdates[1].allowedFolders.join("|"), "C:\\Shared\\One|C:\\Shared\\Two", "an active turn receives the entire updated per-session list");
	scoped.api.setAllowedFolders = async (input) => { scoped.allowedUpdates.push(input); return { ok: false, error: "Folder update rejected." }; };
	await addAllowed("C:\\Rejected");
	assert.equal(scoped.model().session.allowedFolders.length, 2, "a failed policy update is not persisted");
	assert.equal(scoped.notice(), "Folder update rejected.");
	scoped.emit({ type: "done", uiSessionId: scopedId, turnId: scoped.sends.at(-1).turnId });
	await scoped.settle();
	scoped.api.setAllowedFolders = async (input) => { scoped.allowedUpdates.push(input); return { ok: true }; };
	let finishPicker;
	scoped.api.pickFolder = () => new Promise((resolve) => { finishPicker = resolve; });
	if (!button(scoped, "Add folder")) { scoped.node((node) => node.props.label === "+").props.onClick(); scoped.render(); }
	button(scoped, "Add folder").props.onClick();
	scoped.sidebar().onNew();
	await scoped.settle();
	const isolatedId = scoped.model().session.id;
	finishPicker("C:\\Shared\\Three");
	await scoped.settle();
	assert.equal(scoped.allowedUpdates.at(-1).uiSessionId, scopedId, "picker completion stays bound to its original session");
	assert.equal(scoped.model().session.id, isolatedId);
	assert.equal(scoped.model().session.allowedFolders, undefined, "another chat does not inherit selected folders");
	const scopedRestored = harness(scoped.storage);
	await scopedRestored.settle();
	scopedRestored.sidebar().onSelect(scopedId);
	await scopedRestored.settle();
	assert.equal(scopedRestored.model().session.allowedFolders.join("|"), "C:\\Shared\\One|C:\\Shared\\Two|C:\\Shared\\Three", "extra allowed folders survive remount");
	sendPrompt(scopedRestored, "/btw before the move");
	await scopedRestored.settle();
	scopedRestored.emit({ type: "done", uiSessionId: `side-${scopedId}`, turnId: scopedRestored.sends.at(-1).turnId });
	await scopedRestored.settle();
	scopedRestored.pickedFolders.push("C:\\Other\\Project");
	scopedRestored.node((node) => node.props.label === scopedRestored.model().session.project).props.onClick();
	scopedRestored.render();
	button(scopedRestored, "Choose a folder").props.onClick();
	await scopedRestored.settle();
	assert.equal(scopedRestored.model().session.allowedFolders, undefined, "Choose a folder drops the folders added for the old one");
	assert.deepEqual(scopedRestored.forgotten, [scopedId], "Choose a folder tells the host to forget the old conversation");
	sendPrompt(scopedRestored, "/btw after the move");
	await scopedRestored.settle();
	assert.equal(scopedRestored.sends.at(-1).agentSessionId, undefined, "Choose a folder starts the side chat's Grok conversation over too");

	const pendingDraft = harness();
	await pendingDraft.settle();
	const sharedId = await startSession(pendingDraft, "Existing shared chat");
	const otherWriter = harness(pendingDraft.storage);
	await otherWriter.settle();
	let releaseDraftWrite;
	const heldDraftWrite = pendingDraft.locks.request("grok-code.history.v1", () => new Promise((resolve) => { releaseDraftWrite = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	otherWriter.sidebar().onRename(sharedId, "Newer title from another window");
	otherWriter.render();
	pendingDraft.editor().onEdit("UNSAVED USER WORK");
	pendingDraft.render();
	assert.equal(pendingDraft.unloadNow().prevented, true, "unload cannot write outside the lock");
	let closed = false;
	const closing = pendingDraft.beforeUnload().then((event) => { closed = true; return event; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, false, "the close waits for the history lock");
	assert.doesNotMatch(pendingDraft.storage.get("grok-code.history.v1"), /UNSAVED USER WORK/);
	pendingDraft.node((node) => node.props["aria-label"] === "Prompt").props.onChange({ target: { value: "Latest edit while closing" } });
	releaseDraftWrite();
	await heldDraftWrite;
	assert.equal((await closing).prevented, false, "a durable draft permits normal close");
	assert.equal(savedHistory(pendingDraft).sessions.find((item) => item.id === sharedId).title, "Newer title from another window");
	assert.equal(savedHistory(pendingDraft).composerDrafts[sharedId], "Latest edit while closing");
	const draftRemount = harness(pendingDraft.storage);
	await draftRemount.settle();
	assert.equal(draftRemount.editor().draft.text, "UNSAVED USER WORK", "normal reload restores user text");
	assert.equal(draftRemount.editor().draft.version, "a1", "recovered text retains its original disk version");
	pendingDraft.storage.failWrites = true;
	pendingDraft.editor().onEdit("QUOTA FAILURE DRAFT");
	await pendingDraft.settle();
	assert.equal((await pendingDraft.beforeUnload()).prevented, true, "quota failure cannot silently permit draft loss on close");
	assert.equal(pendingDraft.notice(), "Chat history could not be saved on this computer.");
	pendingDraft.storage.failWrites = false;
	pendingDraft.editor().onEdit("retry persisted draft");
	await pendingDraft.settle();
	const otherDraftWindow = harness(pendingDraft.storage);
	await otherDraftWindow.settle();
	pendingDraft.editor().onEdit("OWNER WINDOW TEXT");
	await pendingDraft.settle();
	otherDraftWindow.editor().onEdit("OTHER WINDOW TEXT");
	await otherDraftWindow.settle();
	const concurrentDraftRemount = harness(pendingDraft.storage);
	await concurrentDraftRemount.settle();
	assert.equal(concurrentDraftRemount.editor().draft.text, "OTHER WINDOW TEXT");
	assert.ok(concurrentDraftRemount.editor().draft.recoveryTexts.includes("OWNER WINDOW TEXT"), "concurrent edits preserve the other window's user text");
	const recoveredEditor = harness();
	recoveredEditor.filesView(concurrentDraftRemount.editor());
	assert.equal(recoveredEditor.node((node) => node.props["aria-label"] === "Retained draft 1").props.value, "OWNER WINDOW TEXT");
	concurrentDraftRemount.editor().onClearRecovery();
	await concurrentDraftRemount.settle();
	const clearedDraftRemount = harness(pendingDraft.storage);
	await clearedDraftRemount.settle();
	assert.equal(clearedDraftRemount.editor().draft.recoveryTexts.length, 0, "explicit retained-text discard persists");

	const selectedWindow = harness(app.storage, `?session=${encodeURIComponent(firstId)}`);
	await selectedWindow.settle();
	assert.equal(selectedWindow.model().session.id, firstId, "window bootstrap opens the requested saved chat");
	await selectedWindow.sidebar().onOpenWindow(firstId);
	assert.deepEqual(selectedWindow.newWindows, [firstId]);
	const opening = harness();
	await opening.settle();
	let releaseOpening;
	const openingLock = opening.locks.request("grok-code.history.v1", () => new Promise((resolve) => { releaseOpening = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	opening.sidebar().onNew();
	opening.render();
	sendPrompt(opening, "open me elsewhere");
	await new Promise((resolve) => setImmediate(resolve));
	opening.render();
	const openingId = opening.model().session.id;
	const openingRequest = opening.sidebar().onOpenWindow(openingId);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opening.newWindows.length, 0, "a new window waits until its new chat is persisted");
	releaseOpening();
	await Promise.all([openingLock, openingRequest]);
	await opening.settle();
	assert.deepEqual(opening.newWindows, [openingId]);
	opening.storage.failWrites = true;
	const unsavedId = await startSession(opening, "not saved");
	await opening.sidebar().onOpenWindow(unsavedId);
	await opening.settle();
	assert.equal(opening.newWindows.length, 1, "a failed chat save cannot open a window on a different chat");

	const mentionApp = harness();
	await mentionApp.settle();
	typePrompt(mentionApp, "@a");
	mentionApp.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
	mentionApp.render();
	assert.equal(mentionApp.sends.length, 0, "Enter accepts a mention rather than submitting its unfinished token");
	assert.equal(mentionApp.node((node) => node.props["aria-label"] === "Prompt").props.value, "@a.txt ");
	const linkApp = harness();
	assert.equal(linkApp.fileHits("See docs/My Plan.md", ["docs/My Plan.md", "Plan.md"]).map((hit) => hit.file).join("|"), "docs/My Plan.md");
	assert.equal(linkApp.fileHits("See C:/project/docs/My Plan.md", ["docs/My Plan.md", "Plan.md"]).map((hit) => hit.file).join("|"), "docs/My Plan.md");
	assert.equal(linkApp.fileHits("See C:\\project\\docs\\My Plan.md", ["docs/My Plan.md", "Plan.md"]).map((hit) => hit.file).join("|"), "docs/My Plan.md");
	assert.equal(linkApp.fileHits("grok-4.7 e.g 3.14 example.com").length, 0, "ordinary dotted prose is not treated as file paths");
	assert.equal(linkApp.fileHits("src/unlisted.custom unlisted.py").map((hit) => hit.file).join("|"), "src/unlisted.custom|unlisted.py", "plausible unlisted source paths retain links");
	assert.equal(linkApp.fileHits("Edit src\\foo.ts, .\\src\\bar.ts and C:\\project\\lib\\baz.ts").map((hit) => hit.file).join("|"), "src/foo.ts|src/bar.ts|lib/baz.ts", "Windows paths keep their folders");
	await linkApp.settle();
	linkApp.model().openLink(`${linkApp.model().session.folder.replace(/\\/g, "/")}/src/foo.ts:12`, { ctrlKey: false, metaKey: false });
	await linkApp.settle();
	assert.equal(linkApp.editor().file, "src/foo.ts", "a markdown link to a drive path opens the file instead of being refused as a URL");
	const messageLinks = harness();
	const openedFiles = [];
	messageLinks.message({ ...app.model(), session: { ...app.model().session, folder: "C:/project" }, folderFiles: { status: "ready", files: ["Plan.md"] }, messages: [{ id: "links", role: "grok", text: "Open Plan.md then docs/Other Plan.md" }], openFile: (file) => openedFiles.push(file) });
	const changedMessage = harness();
	const cachedModel = { ...app.model(), session: { ...app.model().session, folder: "C:/project" }, folderFiles: { status: "ready", files: ["first.ts", "second.ts"] }, messages: [{ id: "cached", role: "grok", text: "Read first.ts" }] };
	changedMessage.message(cachedModel);
	const linkedFiles = () => {
		const rendered = changedMessage.node((node) => node.type.name === "Markdown");
		return changedMessage.nodes(rendered.type(rendered.props)).filter((node) => node.type.name === "FileButton").map((node) => node.props.file);
	};
	assert.ok(linkedFiles().includes("first.ts"));
	changedMessage.message({ ...cachedModel, messages: [{ ...cachedModel.messages[0], text: "Read second.ts" }] });
	assert.ok(linkedFiles().includes("second.ts"), "file-link memo updates with message text");
	assert.equal(linkedFiles().includes("first.ts"), false);
	const markdown = messageLinks.node((node) => node.type.name === "Markdown");
	const fileButtons = messageLinks.nodes(markdown.type(markdown.props)).filter((node) => node.type.name === "FileButton");
	assert.equal(fileButtons.length, 1, "actual message rendering must not re-link a rejected basename fragment");
	fileButtons[0].type(fileButtons[0].props).props.onClick();
	assert.deepEqual(openedFiles, ["Plan.md"]);
	assert.equal(fileButtons[0].props.label, "Plan.md");
	console.log("Renderer regressions passed: persistent drafts/close guards/quota/concurrent recovery, stale reconciliation, chat bootstrap, mention acceptance, file links, and existing ownership/persistence checks.");
}

async function checkTurnIds() {
	const turns = harness();
	await turns.settle();
	const id = turns.model().session.id;
	const answering = () => turns.model().busy;
	sendPrompt(turns, "first");
	await turns.settle();
	const turnId = turns.sends.at(-1).turnId;
	assert.match(String(turnId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "every send carries a new turn id");
	turns.emit({ type: "chunk", uiSessionId: id, turnId: "another-window-turn", text: "another window's reply" });
	turns.emit({ type: "chunk", uiSessionId: id, text: "an event without a turn id" });
	turns.emit({ type: "mode", uiSessionId: id, turnId: "another-window-turn", mode: "Plan" });
	turns.emit({ type: "done", uiSessionId: id, turnId: "another-window-turn" });
	await turns.settle();
	assert.equal(turns.model().messages.at(-1).text, "", "another turn's chunks stay out of this reply");
	assert.equal(answering(), true, "another turn's done does not clear this window's busy state");
	assert.ok(turns.node((node) => node.props.label === "Normal"), "another turn's mode event is ignored");
	turns.emit({ type: "chunk", uiSessionId: id, turnId, text: "own reply" });
	turns.emit({ type: "done", uiSessionId: id, turnId });
	await turns.settle();
	assert.equal(turns.model().messages.at(-1).text, "own reply");
	assert.equal(answering(), false);
	assert.ok(!turns.sidebar().sessions.find((item) => item.id === id).unread, "a reply that finishes on screen is not unread");
	let finish;
	turns.api.send = (input) => { turns.sends.push(input); return new Promise((resolve) => { finish = resolve; }); };
	sendPrompt(turns, "second");
	await turns.settle();
	turns.emit({ type: "chunk", uiSessionId: id, turnId: turns.sends.at(-1).turnId, text: "partial" });
	await turns.settle();
	finish({ ok: false, error: "Grok is still answering. Press Stop, or wait for that reply." });
	await turns.settle();
	assert.equal(turns.model().messages.at(-1).text, "partial\nGrok is still answering. Press Stop, or wait for that reply.", "a rejected send shows its error after the text already in the reply");
	assert.equal(answering(), false);
	turns.api.send = async (input) => { turns.sends.push(input); return { ok: true }; };
	sendPrompt(turns, "third");
	await turns.settle();
	assert.equal(turns.sends.length, 3, "a rejected send releases this window's turn");
	assert.notEqual(turns.sends[2].turnId, turns.sends[1].turnId);
}

async function checkTurnAnnouncements() {
	const app = harness();
	await app.settle();
	sendPrompt(app, "Review the build");
	await app.settle();
	const firstId = app.model().session.id;
	app.sidebar().onRename(firstId, "Build review");
	await app.settle();
	const first = { uiSessionId: firstId, turnId: app.sends.at(-1).turnId };
	const region = () => app.node((node) => node.props["aria-live"] === "polite");
	const announcements = () => app.nodes(region()).slice(1).map(textOf);
	assert.ok(app.render().props.children.includes(region()), "the live region sits outside the inert workspace");
	assert.equal(region().props["aria-relevant"], "additions");
	app.emit({ ...first, type: "chunk", text: "Part of the reply" });
	app.emit({ ...first, type: "thought", text: "Thinking aloud" });
	app.emit({ ...first, type: "tool", tool: { id: "reading", waiting: false } });
	app.emit({ ...first, turnId: "unrelated", type: "tool", tool: { id: "unrelated", waiting: true } });
	await app.settle();
	same(announcements(), []);

	const secondId = await startSession(app, "Do something else");
	const second = { uiSessionId: secondId, turnId: app.sends.at(-1).turnId };
	const permission = { ...first, type: "tool", tool: { id: "approval", waiting: true } };
	app.emit(permission);
	app.emit(permission);
	app.emit({ ...first, type: "tool", tool: { id: "question", waiting: true, questions: [{ question: "Which build?", options: [{ label: "Windows" }], multiSelect: false }] } });
	await app.settle();
	same(announcements(), ["In Build review, Grok needs your approval.", "In Build review, Grok has a question."]);

	app.emit({ ...first, type: "done", stopReason: "end_turn" });
	app.emit({ ...first, type: "done", stopReason: "end_turn" });
	app.emit({ ...second, type: "done", stopReason: "end_turn" });
	await app.settle();
	same(announcements().slice(2), ["In Build review, Grok's reply is ready.", "Grok's turn ended."]);
	sendPrompt(app, "Try again");
	await app.settle();
	const third = { uiSessionId: secondId, turnId: app.sends.at(-1).turnId };
	app.emit({ ...third, type: "chunk", text: "An interrupted reply" });
	app.emit({ ...third, type: "done", stopReason: "cancelled" });
	await app.settle();
	assert.equal(announcements().at(-1), "Grok stopped.");
	sendPrompt(app, "Try once more");
	await app.settle();
	app.emit({ uiSessionId: secondId, turnId: app.sends.at(-1).turnId, type: "error", message: "A network error." });
	await app.settle();
	assert.equal(announcements().at(-1), "Grok stopped with an error.");
	app.api.send = async () => ({ ok: false, error: "Grok is unavailable." });
	sendPrompt(app, "Try starting again");
	await app.settle();
	assert.match(announcements().at(-1), /Grok could not start the turn\.$/);
	app.unmount();
}

async function checkFailedSession() {
	const app = harness();
	await app.settle();
	const id = app.model().session.id;
	sendPrompt(app, "first attempt");
	await app.settle();
	app.emit({ type: "error", uiSessionId: id, turnId: app.sends.at(-1).turnId, message: "The turn failed." });
	await app.settle();
	assert.equal(app.sidebar().sessions.find((item) => item.id === id).failed, true, "an error marks the sidebar session failed");
	sendPrompt(app, "try again");
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(app.sidebar().sessions.find((item) => item.id === id).failed, false, "a later successful turn clears the failed state");
	console.log("PASS failed session: errors reach the sidebar and a later successful turn clears them");
}

async function checkInterrupted() {
	const live = harness();
	await live.settle();
	const id = live.model().session.id;
	sendPrompt(live, "write a long answer");
	await live.settle();
	live.emit({ type: "chunk", uiSessionId: id, turnId: live.sends.at(-1).turnId, text: "first half" });
	await live.settle();
	assert.equal(live.model().messages.at(-1).pending, false);
	await live.beforeUnload();
	const reopened = harness(live.storage);
	await reopened.settle();
	assert.equal(reopened.model().messages.at(-1).text, "first half\nInterrupted when this window closed.", "a reply cut off after its first chunk is restored as interrupted");
	assert.equal(reopened.model().messages.at(-1).streaming, false);
	live.emit({ type: "done", uiSessionId: id, turnId: live.sends.at(-1).turnId });
	await live.settle();
	const finished = harness(live.storage);
	await finished.settle();
	assert.equal(finished.model().messages.at(-1).text, "first half", "a finished reply is restored unchanged");
}

async function checkSessionOrder() {
	const savedOrder = (appWindow) => savedHistory(appWindow).sessions.map((item) => item.id).join("|");
	const single = harness();
	await single.settle();
	single.sidebar().onNew();
	await single.settle();
	assert.equal(savedHistory(single).sessions.length, 1, "a new session page is not saved before its first message");
	sendPrompt(single, "now it exists");
	await single.settle();
	assert.equal(savedOrder(single), single.sidebar().sessions.map((item) => item.id).join("|"), "the saved order is the on-screen order");
	const shared = new Map();
	const early = harness(shared);
	await early.settle();
	const first = early.model().session.id;
	const late = harness(shared);
	await late.settle();
	const second = await startSession(late, "second");
	const third = await startSession(early, "third");
	assert.equal(savedOrder(early), [third, second, first].join("|"), "a window that loaded earlier keeps another window's newer session above older ones");
	early.sidebar().onDelete(second);
	await early.settle();
	assert.equal(savedOrder(early), [third, first].join("|"), "a deleted session leaves saved history");
	assert.equal(savedHistory(early).extraChats[second], undefined, "its transcript is removed too");
	late.sidebar().onRename(first, "renamed elsewhere");
	await late.settle();
	assert.equal(savedOrder(late), [third, first].join("|"), "another window cannot bring a deleted session back");
	early.sidebar().onPin(third);
	await early.settle();
	assert.equal(savedHistory(early).sessions.find((item) => item.id === first).title, "renamed elsewhere", "a window that loaded before another window's rename keeps that title when it saves");
	const lone = harness();
	await lone.settle();
	const loneId = lone.model().session.id;
	const loneFolder = lone.model().session.folder;
	lone.sidebar().onSelect(loneId);
	await lone.settle();
	lone.sidebar().onDelete(loneId);
	await lone.settle();
	assert.notEqual(lone.model().session.id, loneId, "deleting the last session leaves a new one");
	assert.equal(lone.model().session.folder, loneFolder, "in the same folder");
	assert.equal(savedOrder(lone), lone.model().session.id, "the delete is saved");
	const kept = harness();
	await kept.settle();
	const blank = kept.model().session.id;
	const shelved = await startSession(kept, "shelved");
	const open = await startSession(kept, "open");
	kept.sidebar().onArchive(blank);
	kept.sidebar().onArchive(shelved);
	await kept.settle();
	button(kept, "Archive and stop").props.onClick();
	await kept.settle();
	assert.equal(kept.sidebar().sessions.filter((item) => !item.archived).map((item) => item.id).join("|"), open, "one unarchived session is left");
	kept.sidebar().onDelete(open);
	await kept.settle();
	assert.equal(kept.model().session.archived, false, "deleting the last unarchived session opens a new one, not an archived one");
	assert.notEqual(kept.model().session.id, shelved);
	assert.equal(savedHistory(kept).sessions.some((item) => item.id === shelved && item.archived), true, "the archived session is kept");
	const wiped = harness();
	await wiped.settle();
	const lost = wiped.model().session;
	const stale = savedHistory(wiped);
	stale.sessions = [{ ...stale.sessions[0], id: "other-window" }];
	wiped.storage.set("grok-code.history.v1", JSON.stringify(stale));
	wiped.editor().onEdit("any change");
	await wiped.settle();
	assert.equal(savedHistory(wiped).sessions.find((item) => item.id === lost.id)?.folder, lost.folder, "a session that another window's stale write dropped is saved whole again");
	const reopened = harness(wiped.storage);
	await reopened.settle();
	assert.ok(reopened.sidebar().sessions.some((item) => item.id === lost.id), "the saved history still loads after that save");
}

async function checkRemoteSendSettings() {
	const owner = await composerWindow();
	const id = owner.model().session.id;
	const pickMode = async (mode) => {
		owner.node((node) => node.type.name === "MenuButton" && node.props.icon === "shield").props.onClick();
		owner.render();
		owner.nodes().find((node) => node.props.className?.startsWith("mode-row") && [node.props.children].flat()[0] === mode).props.onClick();
		await owner.settle();
	};
	await pickMode("Always-approve");
	const observer = harness(owner.storage, `?session=${id}`);
	const sleeping = harness(owner.storage, `?session=${id}`);
	await observer.settle();
	await sleeping.settle();

	await pickMode("Normal");
	const folder = "C:/new-project";
	owner.storage.failWrites = "quota";
	owner.pickedFolders.push(folder);
	owner.node((node) => node.props.label === owner.model().session.project).props.onClick();
	owner.render();
	button(owner, "Choose a folder").props.onClick();
	await owner.settle();
	assert.notEqual(owner.model().session.folder, folder, "a failed write cannot publish a changed folder");
	owner.storage.failWrites = false;

	owner.pickedFolders.push(folder);
	button(owner, "Choose a folder").props.onClick();
	await owner.settle();
	owner.node((node) => node.props["aria-label"] === "Sandbox").props.onChange({ target: { checked: true } });
	owner.render();
	owner.node((node) => node.type.name === "SandboxSettings").props.picker.onUse({ option: "docker", image: "grok-test" });
	await owner.settle();

	observer.storageEvent("grok-code.history.v1");
	await observer.settle();
	assert.equal(observer.model().session.folder, folder);
	assert.equal(observer.node((node) => node.type.name === "MenuButton" && node.props.icon === "shield").props.label, "Normal");
	assert.equal(observer.node((node) => node.props["aria-label"] === "Sandbox").props.checked, true);

	// This window sends before its storage event is delivered.
	sendPrompt(sleeping, "Use the changed settings");
	await sleeping.settle();
	const sent = sleeping.sends.at(-1);
	assert.equal(sent.mode, "Normal");
	assert.equal(sent.cwd, folder);
	assert.equal(sent.agentSessionId, undefined, "the old folder's Grok session cannot follow the send");
	same(sent.sandbox, { option: "docker", image: "grok-test" });
	owner.unmount();
	observer.unmount();
	sleeping.unmount();
}

async function checkRemoteDeletion() {
	const key = "grok-code.history.v1";
	const owner = await composerWindow();
	const id = owner.model().session.id;
	const observer = harness(owner.storage, `?session=${id}`);
	const sleeping = harness(owner.storage, `?session=${id}`);
	const inactive = harness(owner.storage, `?session=${id}`);
	await observer.settle();
	await sleeping.settle();
	await inactive.settle();
	const otherId = await startSession(inactive, "A different chat");
	sendPrompt(observer, "Start a turn in this window");
	await observer.settle();
	sendPrompt(observer, "Keep this queued message");
	await observer.settle();
	typePrompt(observer, "Keep my unsent work");
	owner.sidebar().onDelete(id);
	await owner.settle();
	assert.ok(savedHistory(owner).deleted.includes(id));
	observer.storageEvent(key);
	await observer.settle();
	assert.match(observer.notice(), /deleted in another window/);
	inactive.sidebar().onRename(otherId, "Still viewing a different chat");
	await inactive.settle();
	inactive.storageEvent(key);
	await inactive.settle();
	assert.doesNotMatch(inactive.notice() ?? "", /deleted in another window/, "observing deletion of another chat stays quiet");
	inactive.sidebar().onSelect(id);
	await inactive.settle();
	assert.match(inactive.notice(), /deleted in another window/, "opening the deleted chat explains what happened");
	sendPrompt(observer, "Keep my unsent work");
	await observer.settle();
	assert.equal(observer.sends.length, 1);
	queuedAction(observer, 0, "Send now").props.onClick();
	await observer.settle();
	assert.equal(observer.cancels.length, 0, "Send now on the deleted chat leaves the queue and current turn alone");
	assert.ok(queuedAction(observer, 0, "Edit"), "the queued message can still be copied");
	assert.equal(observer.node((node) => node.props["aria-label"] === "Prompt").props.value, "Keep my unsent work");
	assert.equal((await observer.beforeUnload()).prevented, true, "the deleted chat's local draft still needs a close warning");

	const nearLimit = savedHistory(owner);
	nearLimit.deleted.push(...Array.from({ length: 499 }, (_, index) => `later-deletion-${index}`));
	owner.storage.set(key, JSON.stringify(nearLimit));
	owner.sidebar().onDelete(owner.model().session.id);
	await owner.settle();
	assert.equal(savedHistory(owner).deleted.length, 500);
	assert.ok(!savedHistory(owner).deleted.includes(id), "the original deletion aged out of the recent list");
	// This window never received the deletion storage event.
	sendPrompt(sleeping, "Keep the draft here too");
	await sleeping.settle();
	assert.equal(sleeping.sends.length, 0);
	assert.match(sleeping.notice(), /deleted in another window/);
	sleeping.sidebar().onRename(id, "A stale edit");
	await sleeping.settle();
	assert.ok(!savedHistory(sleeping).sessions.some((item) => item.id === id));
	assert.equal(savedHistory(sleeping).extraChats[id], undefined);
	assert.equal(savedHistory(sleeping).composerDrafts[id], undefined);
	assert.equal(sleeping.node((node) => node.props["aria-label"] === "Prompt").props.value, "Keep the draft here too");
	owner.unmount();
	observer.unmount();
	sleeping.unmount();
	inactive.unmount();
}

async function checkLostSession() {
	const lost = harness();
	await lost.settle();
	const id = lost.model().session.id;
	sendPrompt(lost, "first");
	await lost.settle();
	lost.emit({ type: "done", uiSessionId: id, turnId: lost.sends.at(-1).turnId });
	await lost.settle();
	assert.equal(lost.model().session.agentSessionId, "provider-session");
	const error = "Grok could not reload the earlier conversation (Path not found.). Send again to start a new one.";
	lost.api.send = async (input) => { lost.sends.push(input); return { ok: false, lostSession: true, error }; };
	sendPrompt(lost, "second");
	await lost.settle();
	assert.equal(lost.sends.at(-1).agentSessionId, "provider-session");
	assert.equal(lost.model().session.agentSessionId, undefined, "a lost Grok conversation is forgotten");
	assert.equal(lost.model().messages.at(-1).text, error);
	assert.equal(savedHistory(lost).sessions.find((item) => item.id === id).agentSessionId, undefined);
	lost.api.send = async (input) => { lost.sends.push(input); return { ok: true, agentSessionId: "fresh-session" }; };
	sendPrompt(lost, "third");
	await lost.settle();
	assert.equal(lost.sends.at(-1).agentSessionId, undefined, "the next send starts a new Grok conversation");
	lost.api.send = async (input) => { lost.sends.push(input); return { ok: true, agentSessionId: "side-session" }; };
	sendPrompt(lost, "/btw one");
	await lost.settle();
	lost.emit({ type: "done", uiSessionId: `side-${id}`, turnId: lost.sends.at(-1).turnId });
	await lost.settle();
	lost.api.send = async (input) => { lost.sends.push(input); return { ok: false, lostSession: true, error }; };
	sendPrompt(lost, "/btw two");
	await lost.settle();
	assert.equal(lost.sends.at(-1).agentSessionId, "side-session");
	lost.api.send = async (input) => { lost.sends.push(input); return { ok: true, agentSessionId: "side-fresh" }; };
	sendPrompt(lost, "/btw three");
	await lost.settle();
	assert.equal(lost.sends.at(-1).agentSessionId, undefined, "a lost side conversation is forgotten too");
}

async function checkModeEvents() {
	const moded = harness();
	await moded.settle();
	const id = moded.model().session.id;
	sendPrompt(moded, "plan this");
	await moded.settle();
	moded.emit({ type: "mode", uiSessionId: id, turnId: moded.sends.at(-1).turnId, mode: "Plan" });
	await moded.settle();
	assert.ok(moded.node((node) => node.props.label === "Plan"), "the composer shows the mode Grok switched to");
	moded.emit({ type: "done", uiSessionId: id, turnId: moded.sends.at(-1).turnId });
	await moded.settle();
	sendPrompt(moded, "also cover the tests");
	await moded.settle();
	assert.equal(moded.sends.at(-1).mode, "Plan", "the next turn sends Grok's plan mode back");
	moded.emit({ type: "done", uiSessionId: id, turnId: moded.sends.at(-1).turnId });
	await moded.settle();
	moded.node((node) => node.props.label === "Plan").props.onClick();
	moded.render();
	moded.nodes().find((node) => node.props.className?.startsWith("mode-row") && [node.props.children].flat()[0] === "Auto-review").props.onClick();
	await moded.settle();
	await startSession(moded, "same folder");
	assert.equal(moded.sends.at(-1).mode, "Normal", "a new session starts in Normal");
	moded.node((node) => node.props.label === "Normal").props.onClick();
	moded.render();
	assert.equal(moded.nodes().some((node) => node.props.className?.startsWith("mode-row") && [node.props.children].flat()[0] === "Always-approve"), true, "Always-approve is in the mode menu");
}

async function checkAnswers() {
	const asks = harness();
	await asks.settle();
	const id = asks.model().session.id;
	sendPrompt(asks, "plan it");
	await asks.settle();
	const turnId = asks.sends.at(-1).turnId;
	const tool = (toolId) => asks.model().messages.at(-1).tools.find((item) => item.id === toolId);
	for (const toolId of ["plan-1", "plan-2", "plan-3", "plan-4"]) {
		asks.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: toolId, kind: "plan", title: "Plan", detail: "Waiting for your approval", waiting: true, plan: "# Plan" } });
	}
	asks.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "ask-1", kind: "question", title: "Question", detail: "Waiting for your answer", waiting: true, questions: [{ question: "Which color?", options: [{ label: "Red" }], multiSelect: false }] } });
	asks.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "run-1", kind: "execute", title: "Run", detail: "Waiting for you", waiting: true, command: "npm test" } });
	await asks.settle();
	same(asks.model().messages.at(-1).parts.map((part) => part.id), ["plan-1", "plan-2", "plan-3", "plan-4", "ask-1", "run-1"], "tool rows keep their arrival order");
	asks.model().decide("run-1", "always");
	await asks.settle();
	same(asks.decisions.at(-1), { uiSessionId: id, toolId: "run-1", decision: "always" });
	assert.equal(tool("run-1").detail, "Allowed");
	assert.equal((await asks.model().answerPlan("plan-1", { outcome: "approved", mode: "Normal" })).ok, true);
	await asks.settle();
	assert.equal(JSON.stringify(asks.planAnswers.at(-1)), JSON.stringify({ uiSessionId: id, toolId: "plan-1", outcome: "approved", mode: "Normal" }));
	assert.ok(asks.node((node) => node.props.label === "Normal"), "approving sets the session's mode");
	assert.equal(tool("plan-1").waiting, true, "the backend's event, not the call, closes the row");
	await asks.model().answerPlan("plan-2", { outcome: "abandoned" });
	await asks.settle();
	assert.equal(asks.planAnswers.at(-1).outcome, "abandoned");
	assert.ok(asks.node((node) => node.props.label === "Normal"), "abandoning with no saved pre-Plan mode resumes Normal");
	asks.api.answerPlan = async (input) => { asks.planAnswers.push(input); return { ok: false, closed: true, error: "That plan approval already closed." }; };
	await asks.model().answerPlan("plan-3", { outcome: "approved", mode: "Normal" });
	await asks.settle();
	assert.equal(tool("plan-3").waiting, false, "a plan the backend already closed closes its row");
	assert.equal(tool("plan-3").detail, "That plan approval already closed.");
	assert.ok(asks.node((node) => node.props.label === "Normal"), "a failed approval does not change the mode");
	asks.api.answerPlan = async (input) => { asks.planAnswers.push(input); return { ok: false, error: "Write what to change first." }; };
	assert.equal((await asks.model().answerPlan("plan-4", { outcome: "feedback", feedback: "x" })).error, "Write what to change first.");
	await asks.settle();
	assert.equal(tool("plan-4").waiting, true, "any other failure keeps the plan waiting");
	await asks.model().answerQuestion("ask-1", { "Which color?": "Red" });
	assert.equal(JSON.stringify(asks.questionAnswers.at(-1)), JSON.stringify({ uiSessionId: id, toolId: "ask-1", answers: { "Which color?": "Red" } }));
	asks.api.answerQuestion = async () => ({ ok: false, closed: true, error: "That question already closed." });
	await asks.model().answerQuestion("ask-1", null);
	await asks.settle();
	assert.equal(tool("ask-1").waiting, false);
	assert.equal(tool("ask-1").detail, "That question already closed.");
}

async function checkSavedSize() {
	const slim = harness();
	await slim.settle();
	const id = slim.model().session.id;
	sendPrompt(slim, "run it");
	await slim.settle();
	const turnId = slim.sends.at(-1).turnId;
	const command = `echo ${"c".repeat(5995)}`;
	const input = JSON.stringify({ command, description: "Long command" }, null, 2);
	slim.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "long", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command, input } });
	slim.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "long", detail: "Ran", waiting: false, output: "o".repeat(1500) } });
	slim.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "plan", kind: "plan", title: "Plan", detail: "Waiting for your approval", waiting: true, plan: "p".repeat(25000) } });
	await slim.settle();
	const stored = () => savedHistory(slim).extraChats[id].at(-1).tools;
	const [savedLong, savedPlan] = stored();
	assert.equal(command.length, 6000);
	assert.equal("output" in savedLong, false, "tool output is not saved");
	assert.equal("input" in savedLong, false, "tool input is not saved");
	assert.equal(savedLong.command, `${command.slice(0, 2000)}…`);
	assert.equal(savedPlan.plan, `${"p".repeat(20000)}…`);
	const [liveLong, livePlan] = slim.model().messages.at(-1).tools;
	assert.equal(liveLong.command, command, "the window keeps the complete command");
	assert.equal(liveLong.input, input);
	assert.equal(liveLong.output.length, 1500);
	assert.equal(livePlan.plan.length, 25000);
	await startSession(slim, "another");
	assert.equal(savedHistory(slim).sessions.length, 2);
	assert.equal(stored()[0].command, `${command.slice(0, 2000)}…`, "cutting an already cut value leaves it unchanged");
	assert.equal(stored()[1].plan, `${"p".repeat(20000)}…`);

	const big = harness();
	big.files["a.txt"] = { text: "x".repeat(150 * 1024), version: "big1" };
	await big.settle();
	await startSession(big, "second");
	const mine = await startSession(big, "third");
	const storedDrafts = () => Object.entries(savedHistory(big).editorDrafts);
	assert.equal(storedDrafts().filter(([, draft]) => draft.text === draft.baseText).length, 0, "a file that was only read is not saved with the history");
	big.editor().onEdit("my own text");
	await big.settle();
	same(storedDrafts().map(([key, draft]) => [JSON.parse(key)[0], draft.text]), [[mine, "my own text"]], "a draft that holds the user's text is saved");
	big.storage.failWrites = "quota";
	big.editor().onEdit("my own text, more");
	await big.settle();
	assert.equal(big.notice(), "Chat history is full and is not being saved. Delete old sessions to free space.", "full storage says what to do");
	big.storage.failWrites = false;
	big.sidebar().onDelete(mine);
	await big.settle();
	same(storedDrafts(), [], "a deleted session's draft leaves the saved history");
	assert.equal(big.notice(), undefined, "a save that works again clears the history notice");
}

async function checkGrokState() {
	let escapeClock;
	class Clock extends Date { static now() { return escapeClock ?? Date.now(); } }
	const app = harness(new Map(), "", Clock);
	await app.settle();
	const id = app.model().session.id;
	app.sidebar().onSelect(id);
	await app.settle();
	app.node((node) => node.props.label === "+").props.onClick();
	app.render();
	assert.ok(strings(app.render()).includes("Managed in Grok's configuration"), "with no MCP report the + menu says where connectors live");
	app.emit({ type: "mcp", servers: [{ name: "github", source: "user", status: "" }, { name: "linear", source: "project", status: "" }] });
	app.emit({ type: "mcp-status", name: "github", status: "connected" });
	app.emit({ type: "commands", commands: [{ name: "review-skill", description: "Review a change", hint: "path" }, { name: "review", description: "Review the diff", hint: "" }, { name: "goal", description: "Set a goal", hint: "objective" }] });
	await app.settle();
	assert.ok(strings(app.render()).includes("2 MCP servers from Grok"));
	assert.ok(JSON.parse(app.storage.get("grok-code.commands.v1")).some((item) => item.name === "review"), "Grok's command list is cached for the next window");
	let finishSkills;
	app.api.customize = (folder, skillsOnly) => {
		assert.equal(folder, app.model().session.folder);
		assert.equal(skillsOnly, true);
		return new Promise((resolve) => { finishSkills = resolve; });
	};
	typePrompt(app, "/rev");
	await app.settle();
	const commandNodes = () => app.nodes(app.node((node) => node.props["aria-label"] === "Commands"));
	const groupLabels = () => commandNodes().filter((node) => node.props.role === "group").map((node) => node.props["aria-label"]);
	const selectedCommand = () => [commandNodes().find((node) => node.props["aria-selected"] === true).props.children].flat()[0];
	const nextCommand = () => {
		app.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
		app.render();
	};
	same(groupLabels(), ["Grok, 2 commands"], "names alone do not classify a Grok command as a skill");
	nextCommand();
	assert.equal(selectedCommand(), "/review");
	finishSkills({ ok: true, skills: [{ command: "/review-skill" }, { command: "/review", disabled: true }] });
	await app.settle();
	same(groupLabels(), ["Grok, 1 command", "Skills, 1 command"], "only an enabled inventory match goes in Skills");
	assert.equal(selectedCommand(), "/review", "the active option survives regrouping");
	nextCommand();
	assert.equal(selectedCommand(), "/review-skill", "keyboard navigation skips group headings");
	typePrompt(app, "/");
	assert.match(groupLabels()[0], /^App, \d+ commands$/);
	typePrompt(app, "");

	const terminalWrites = [];
	app.api.terminalOpen = async () => ({ ok: true, id: "term-1" });
	app.api.terminalWrite = async (id, text) => { terminalWrites.push([id, text]); return { ok: true }; };
	sendPrompt(app, "!git status");
	await app.settle();
	same(terminalWrites, [["term-1", "git status"]], "! runs the command in the Terminal pane");
	assert.equal(app.sends.length, 0, "! does not go to Grok");
	assert.ok(app.node((node) => node.type === "TerminalPane"), "the Terminal pane opens");
	assert.equal(app.node((node) => node.type === "SessionRail"), undefined, "the rail steps aside when a pane leaves the chat too narrow");
	app.node((node) => node.type === "TerminalPane").props.onClose();
	await app.settle();
	assert.ok(app.node((node) => node.type === "SessionRail"), "the rail returns when the pane closes");

	const pressEnter = () => app.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {}, stopPropagation() {} });
	typePrompt(app, "/goal");
	pressEnter();
	app.render();
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "/goal ", "Enter on a command that takes input completes it");
	assert.equal(app.sends.length, 0);
	typePrompt(app, "/rev");
	pressEnter();
	await app.settle();
	assert.equal(app.sends.at(-1).text, "/review", "Enter on a command that takes no input runs it");
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	typePrompt(app, "/status");
	pressEnter();
	await app.settle();
	assert.equal(app.sends.length, 1, "/status stays in the app");
	assert.match(app.model().messages.at(-1).text, /^Codewomplers Grok Desktop\n/, "/status answers in the chat");
	assert.match(app.notice(), /^Codewomplers Grok Desktop · /, "/status also leaves a line under the composer");
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "");
	typePrompt(app, "/sta");
	app.node((node) => node.props.role === "option" && textOf(node).startsWith("/status")).props.onClick();
	await app.settle();
	assert.equal(app.sends.length, 1, "choosing /status from the menu runs it");
	assert.equal(app.model().messages.at(-1).role, "grok");

	app.pickedFiles.push(["C:\\shots\\screen.png", "C:\\notes\\todo.md"]);
	button(app, "Add files or photos").props.onClick();
	await app.settle();
	assert.equal(app.nodes().filter((node) => node.props.className === "attach-chip").length, 2);
	same(app.nodes().filter((node) => node.type === "img").map((node) => node.props.src), ["file:///C:/shots/screen.png"], "an attached image shows as a thumbnail");
	sendPrompt(app, "look at these");
	await app.settle();
	same(app.sends.at(-1).attachments, ["C:\\shots\\screen.png", "C:\\notes\\todo.md"], "attachments go with the message");
	assert.equal(app.nodes().filter((node) => node.props.className === "attach-chip").length, 0, "sending clears the attachments");
	same(app.model().messages.at(-2).attachments, ["C:\\shots\\screen.png", "C:\\notes\\todo.md"]);

	const turnId = app.sends.at(-1).turnId;
	const usage = { model: "grok-4.7", inputTokens: 40000, outputTokens: 2000, cachedReadTokens: 30000, reasoningTokens: 500, modelCalls: 2, contextTokens: 22000, contextWindow: 200000, costUsd: 0.25 };
	app.emit({ type: "usage", uiSessionId: id, turnId, usage });
	app.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "todo", kind: "other", title: "Update tasks", detail: "Ran", todos: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] } });
	app.emit({ type: "done", uiSessionId: id, turnId });
	await app.settle();
	assert.equal(app.model().session.costUsd, 0.25);
	same(app.model().todos.map((item) => item.text), ["Read", "Fix"], "the latest task list reaches the transcript and Plan pane");
	assert.ok(app.node((node) => node.props["aria-label"] === "Context 11% used"), "the composer shows context use");
	const rail = harness();
	const cards = rail.nodes(rail.rail(app.node((node) => node.type === "SessionRail").props)).filter((node) => node.type.name === "RailCard");
	const railText = cards.map((card) => `${textOf(card.props.extra)} ${textOf(card.props.children)}`).join(" ");
	assert.ok(railText.includes("11%"), "the rail's Context card shows the percentage");
	const railProps = app.node((node) => node.type === "SessionRail").props;
	const costs = rail.node((node) => node.type === "details" && node.props.className === "rail-costs");
	assert.equal(costs.props.open, undefined, "subscription costs start collapsed");
	assert.match(textOf(costs), /Cost figures reported by GrokSession cost\$0\.25/);
	assert.doesNotMatch(app.node((node) => node.props.className === "usage-ring").props.title, /\$/, "the subscription composer tooltip stays about context");
	const keyRail = harness();
	const keyRailTree = keyRail.rail({ ...railProps, subscription: undefined });
	assert.equal(keyRail.nodes(keyRailTree).some((node) => node.type === "details" && node.props.className === "rail-costs"), false);
	assert.match(textOf(keyRail.nodes(keyRailTree).find((node) => node.type.name === "RailCard" && node.props.title === "Context").props.children), /Session cost\$0\.25/);
	const parts = { systemPrompt: 2000, rules: 1000, skills: 9000, workflows: 200, mcp: 600, tools: 11600 };
	const splitText = (contextTokens) => {
		const splitRail = harness();
		const splitCards = splitRail.nodes(splitRail.rail({ ...railProps, usage: { ...railProps.usage, contextTokens, contextWindow: 256000 }, breakdown: { parts, autoCompactPercent: 85 }, recentUsd: 12.5 })).filter((node) => node.type.name === "RailCard");
		return splitCards.map((card) => textOf(card.props.children)).join(" ");
	};
	const fifty = splitText(50000);
	assert.ok(fifty.includes("Messages25.6k10.0%"), "Messages is the live total less Grok's fixed parts");
	assert.ok(fifty.includes("System tools11.6k4.5%") && fifty.includes("Skills9.0k3.5%"), "each fixed part shows its tokens and share of the window");
	assert.ok(fifty.includes("Autocompact buffer38.4k15.0%") && fifty.includes("Free space168k65.5%"), "the buffer is the 15% above Grok's 85% threshold");
	assert.ok(fifty.includes("168k until auto-compact"));
	assert.ok(fifty.includes("Grok, last 7 days$12.50"), "the rail shows the week's spend");
	const small = splitText(10000);
	assert.ok(small.includes("Messages00.0%") && small.includes("Skills3.7k"), "estimates larger than the real total are scaled down to it");
	app.emit({ type: "context", uiSessionId: id, turnId, contextTokens: 100000, contextWindow: 200000 });
	await app.settle();
	assert.equal(app.model().session.usage.contextTokens, 22000, "a context update from a finished turn is ignored");
	const sendsBefore = app.sends.length;
	app.node((node) => node.type === "SessionRail").props.onCompact();
	await app.settle();
	assert.equal(app.sends.at(-1).text, "/compact", "Compact session asks Grok to compact");
	assert.equal(app.sends.length, sendsBefore + 1);
	app.emit({ type: "context", uiSessionId: id, turnId: app.sends.at(-1).turnId, contextTokens: 9000, contextWindow: 200000 });
	await app.settle();
	assert.equal(app.model().session.usage.contextTokens, 9000, "the context in use updates while a turn runs");
	assert.equal(app.model().session.costUsd, 0.25, "a live context update keeps the session cost");
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();

	assert.equal(app.sidebar().account, undefined, "the account is unknown until Grok starts");
	app.emit({ type: "account", account: { email: "someone@example.com", plan: "SuperGrok", team: "", version: "1.0.70" } });
	await app.settle();
	assert.equal(app.sidebar().account.email, "someone@example.com", "Grok's sign-in reply reaches the account menu");
	let signOuts = 0;
	app.api.signOut = async () => { signOuts += 1; return { ok: true }; };
	app.sidebar().onSignOut();
	await app.settle();
	button(app, "Sign out").props.onClick();
	await app.settle();
	assert.equal(signOuts, 1);
	assert.match(app.notice(), /Signed out/);
	app.emit({ type: "account", account: null });
	await app.settle();
	assert.equal(app.sidebar().account, null, "after signing out the menu says so");

	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	const settingsPage = app.node((node) => node.type?.name === "SettingsPage");
	assert.ok(settingsPage, "Ctrl+, opens Settings");
	settingsPage.props.onChange({ appearance: "light" });
	await app.settle();
	assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).appearance, "light", "settings are saved");
	assert.equal(settingsPage.props.folder, app.model().session.folder, "Settings asks Grok about the open session's folder");
	const sentBefore = app.sends.length;
	settingsPage.props.onRun("/create-skill");
	await app.settle();
	assert.equal(app.sends.length, sentBefore + 1);
	assert.equal(app.sends.at(-1).text, "/create-skill", "a command picked in Settings goes to the open session");
	assert.equal(app.node((node) => node.type?.name === "SettingsPage"), undefined, "and Settings closes");
	app.key({ key: ",", ctrlKey: true });
	await app.settle();

	const twice = harness();
	await twice.settle();
	let finishWorktree;
	let worktreeCalls = 0;
	twice.api.addWorktree = () => { worktreeCalls += 1; return new Promise((resolve) => { finishWorktree = resolve; }); };
	twice.sidebar().onNew();
	await twice.settle();
	worktreeInput(twice).props.onChange({ target: { checked: true } });
	twice.render();
	const sendsBeforeTwice = twice.sends.length;
	sendPrompt(twice, "make it twice");
	await twice.settle();
	sendPrompt(twice, "make it twice");
	await twice.settle();
	assert.equal(worktreeCalls, 1, "a second Enter while the worktree is being made does not make another");
	typePrompt(twice, "keep typing while the worktree is created");
	finishWorktree({ ok: true, folder: "C:\\project\\.grok\\worktrees\\make-it-twice", branch: "grok/make-it-twice" });
	await twice.settle();
	assert.equal(twice.sends.length, sendsBeforeTwice + 1, "the prompt is sent once");
	assert.equal(twice.sends.at(-1).text, "make it twice", "the first message stays unchanged");
	assert.equal(twice.node((node) => node.props["aria-label"] === "Prompt").props.value, "keep typing while the worktree is created", "typing during worktree creation stays in the composer");
	app.key({ key: "Escape" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await app.settle();
	assert.equal(app.node((node) => node.type?.name === "SettingsPage"), undefined, "Escape closes Settings");
	assert.deepEqual(app.cancels, [], "Escape that closes a page does not stop Grok");
	sendPrompt(app, "long job");
	await app.settle();
	app.node((node) => node.props.label === "+").props.onClick();
	app.render();
	escapeClock = Date.now();
	app.key({ key: "Escape" });
	await app.settle();
	assert.deepEqual(app.cancels, [], "Escape that closes a menu does not stop Grok");
	escapeClock += 499;
	app.key({ key: "Escape" });
	await app.settle();
	assert.deepEqual(app.cancels, [], "a second Escape inside the overlay's grace period does not stop Grok");
	escapeClock += 1;
	app.key({ key: "Escape" });
	await app.settle();
	same(app.cancels, [id], "Escape with nothing open stops Grok when the grace period expires");
}

async function checkLimitMeter() {
	const app = harness();
	const meter = () => app.node((node) => String(node.props.className || "").startsWith("limit-meter"));
	const fresh = harness();
	fresh.api.signInStatus = async () => ({ mode: "key", hasKey: true, keyReadable: true, keyring: true });
	fresh.api.readiness = async () => ({ grok: { ok: true, signedIn: true, signIn: "saved", signInMode: "key", keyIgnored: true }, git: { ok: true }, gh: { ok: true } });
	fresh.api.billing = async () => ({ ok: true, percent: 28, period: "weekly", resetsAt: "2026-11-11T22:56:56.873+00:00", tier: "SuperGrok" });
	await fresh.settle();
	assert.equal(textOf(fresh.node((node) => String(node.props.className || "").startsWith("limit-meter"))), "Weekly · 72% left", "the active saved sign-in shows its limit before any message when Grok ignores the configured key");
	let billing = { ok: false, error: "Grok did not return usage." };
	app.api.billing = async () => billing;
	await app.settle();
	const id = app.model().session.id;
	assert.equal(textOf(meter()), "Limit", "no limit while Grok cannot be read");
	assert.equal(meter().props.className, "limit-meter");
	assert.match(meter().props.title, /isn't available/);
	billing = { ok: true, percent: 80, period: "weekly", resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), tier: "SuperGrok" };
	sendPrompt(app, "first");
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(textOf(meter()), "Weekly · 20% left", "a finished turn reads the limit");
	assert.equal(meter().props.className, "limit-meter warn");
	assert.match(meter().props.title, /^SuperGrok weekly limit 80% used · resets /);
	assert.equal(app.node((node) => node.type === "SessionRail").props.subscription.stale, false);
	billing = { ok: false, error: "Grok did not return usage." };
	sendPrompt(app, "second");
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(textOf(meter()), "Weekly · 20% left", "a failed read keeps the last limit");
	assert.match(meter().props.title, /may be out of date/);
	assert.equal(app.node((node) => node.type === "SessionRail").props.subscription.stale, true);
	billing = { ok: true, percent: 92.4, period: "monthly", resetsAt: "", tier: "SuperGrok" };
	sendPrompt(app, "third");
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(textOf(meter()), "Monthly · 8% left");
	assert.equal(meter().props.className, "limit-meter high");
	assert.equal(app.node((node) => node.type === "SessionRail").props.subscription.stale, false);
}

async function checkSlashCommands() {
	const app = harness();
	await app.settle();
	const id = app.model().session.id;
	app.sidebar().onSelect(id);
	await app.settle();
	const run = async (text) => {
		const sent = app.sends.length;
		typePrompt(app, text);
		app.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {}, stopPropagation() {} });
		await app.settle();
		assert.equal(app.sends.length, sent, `${text} stays in the app`);
	};
	app.api.billing = async () => ({ ok: true, percent: 90, period: "weekly", resetsAt: "2026-11-04T22:56:56.873+00:00", tier: "SuperGrok" });
	await run("/usage");
	assert.match(app.model().messages.at(-1).text, /^SuperGrok weekly limit 90% used · resets /);
	assert.equal(app.model().messages.at(-2).text, "/usage");
	app.api.billing = async () => ({ ok: false, error: "Usage is unavailable." });
	await run("/usage");
	assert.equal(app.model().messages.at(-1).text, "Usage is unavailable.");
	await run("/cost");
	assert.equal(app.model().messages.at(-2).text, "/cost");
	assert.equal(app.model().messages.at(-1).text, "Usage is unavailable.");
	await run("/rename New name");
	assert.equal(app.model().session.title, "New name");
	await run("/theme dark");
	assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).appearance, "dark");
	await run("/theme blue");
	assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).appearance, "dark");
	assert.equal(app.notice(), "Use /theme system, light or dark.");
	await run("/plan");
	assert.equal(savedHistory(app).modes[id], "Plan");
	await run("/auto");
	assert.equal(savedHistory(app).modes[id], "Auto-review");
	await run("/plan fix the parser");
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "/plan fix the parser");
	assert.equal(app.notice(), "/plan takes no argument.");
	assert.equal(savedHistory(app).modes[id], "Auto-review");
	await run("/tasks");
	assert.ok(app.node((node) => node.type === "PaneView" && node.props.id === "tasks"));
	for (const [command, tab] of [["/mcps", "connectors"], ["/skills", "skills"], ["/marketplace", "plugins"]]) {
		await run(command);
		const settings = app.node((node) => node.type?.name === "SettingsPage");
		assert.equal(settings.props.initialTab, tab, `${command} still opens the correct Skills and tools tab`);
		settings.props.onClose();
		await app.settle();
	}
	app.node((node) => node.props.label === "+").props.onClick();
	app.render();
	button(app, "Skills and tools").props.onClick();
	await app.settle();
	const toolsSettings = app.node((node) => node.type?.name === "SettingsPage");
	assert.equal(toolsSettings.props.initialTab, "skills", "the composer menu still opens Skills");
	toolsSettings.props.onClose();
	await app.settle();
	await run("/fork");
	assert.equal(app.notice(), "No sent message to fork from yet.");
	await run("/rewind");
	assert.equal(app.notice(), "No sent message to rewind to yet.");
	typePrompt(app, "/us");
	assert.ok(app.node((node) => node.props.role === "option" && textOf(node).startsWith("/usage")));
	typePrompt(app, "/cost");
	assert.equal(app.node((node) => node.props.role === "option" && textOf(node).startsWith("/cost")), undefined);
	typePrompt(app, "/rename");
	app.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {}, stopPropagation() {} });
	app.render();
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "/rename ", "commands with hints complete instead of running");
	app.sidebar().onNew();
	await app.settle();
	await run("/rename x");
	assert.equal(app.notice(), "Send a first message to start this session.");
	assert.equal(app.sidebar().sessions.find((item) => item.id === id).title, "New name");
	app.sidebar().onSelect(id);
	await app.settle();
	sendPrompt(app, "working turn");
	await app.settle();
	await run("/delete");
	assert.equal(app.notice(), "Stop this session before deleting it.");
	assert.ok(app.sidebar().sessions.some((item) => item.id === id));
	assert.equal(app.node((node) => node.props.role === "alertdialog"), undefined);
	app.emit({ type: "usage", uiSessionId: id, turnId: app.sends.at(-1).turnId, usage: { contextTokens: 22000, contextWindow: 200000, costUsd: 0.25 } });
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	await run("/usage");
	assert.equal(app.model().messages.at(-1).text, "Usage is unavailable.\nContext 11%");
	await run("/cost");
	assert.equal(app.model().messages.at(-1).text, "Usage is unavailable.\nContext 11% · $0.25");
	await run("/delete");
	assert.equal(app.node((node) => node.props.role === "alertdialog").props["aria-label"], 'Delete "New name"?');
	button(app, "Delete").props.onClick();
	await app.settle();
	assert.equal(app.sidebar().sessions.some((item) => item.id === id), false);
	assert.equal(app.sends.length, 1);
}

async function checkToolRows() {
	const decisions = [];
	const questionCalls = [];
	const planCalls = [];
	let reply = () => Promise.resolve({ ok: true });
	const model = {
		session: { id: "rows", folder: "C:\\project", worktree: "project" },
		decide: (toolId, decision) => decisions.push(`${toolId}:${decision}`),
		answerQuestion: (toolId, answers) => { questionCalls.push([toolId, answers]); return reply(); },
		answerPlan: (toolId, choice) => { planCalls.push([toolId, choice]); return reply(); },
		resumeMode: "Normal",
	};
	const show = (tool) => { const rows = harness(); rows.row({ tool, m: model }); return rows; };
	const option = (rows, label) => rows.node((node) => node.type === "button" && node.props["aria-pressed"] !== undefined && strings(node).includes(label));
	const head = (rows) => rows.node((node) => node.props.className === "tool-head");
	const planText = (rows) => rows.node((node) => node.type.name === "Markdown")?.props.text;
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	const secret = "npm run secret-build -- --all";
	const ran = show({ id: "ran", kind: "execute", label: "Run Command", title: `Execute \`${secret}\``, description: "Build everything", command: secret, output: "built 3 packages", detail: "Ran" });
	assert.equal(textOf(ran.render()).includes("secret-build"), false, "a collapsed row does not show the command");
	assert.ok(textOf(ran.render()).includes("Build everything"));
	assert.equal(head(ran).type, "button");
	assert.equal(head(ran).props["aria-expanded"], false);
	head(ran).props.onClick();
	assert.ok(textOf(ran.render()).includes(secret), "expanding shows the command");
	assert.ok(textOf(ran.render()).includes("built 3 packages"), "expanding shows the output");
	assert.equal(head(ran).props["aria-expanded"], true);
	const verbose = harness();
	verbose.row({ tool: { id: "v", kind: "execute", title: "Execute", command: secret, detail: "Ran" }, m: { ...model, view: "verbose" } });
	assert.ok(textOf(verbose.render()).includes(secret), "the Verbose view opens tool rows");
	const titled = show({ id: "titled", kind: "execute", title: `Execute \`${secret}\``, command: secret, detail: "Ran" });
	assert.equal(textOf(titled.render()).includes("secret-build"), false, "the title fallback drops the quoted command");
	assert.ok(textOf(titled.render()).includes("Run Command"));
	const read = show({ id: "read", kind: "read", title: "Read `C:\\project\\src\\App.tsx`", path: "c:/PROJECT/src/App.tsx", detail: "Ran" });
	assert.ok(strings(read.render()).includes("src/App.tsx"), "a path inside the session folder is shown relative to it");
	const outside = show({ id: "outside", kind: "read", title: "Read", path: "C:\\projects\\other.txt", detail: "Ran" });
	assert.ok(strings(outside.render()).includes("C:\\projects\\other.txt"));
	const edit = show({ id: "edit", kind: "edit", title: "Edit `a.txt`", path: "C:\\project\\a.txt", additions: 3, deletions: 2, detail: "Ran" });
	assert.ok(textOf(edit.render()).includes("+3 −2"));
	const failedRow = show({ id: "failed", kind: "execute", title: "run_terminal_command", detail: "Failed" });
	assert.ok(failedRow.node((node) => node.props.className === "tool-status bad"), "failures are marked");
	const restored = show({ id: "old", kind: "execute", title: "Execute `npm test`", summary: "npm test", detail: "Ran" });
	head(restored).props.onClick();
	assert.ok(strings(restored.render()).includes("npm test"), "a restored row without output still expands");
	const sample = show({ kind: "Read", title: "src/tax/merchandise.ts", detail: "Lines 40-68" });
	assert.equal(sample.node((node) => node.type === "button"), undefined, "a row with nothing to expand is not a button");

	const long = `Write-Output start; ${"x".repeat(5962)}; Write-Output end`;
	assert.equal(long.length, 6000);
	const approval = show({ id: "approve", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: long, summary: `${long.slice(0, 500)}…`, always: "folder" });
	assert.ok(approval.nodes().some((node) => node.props.children === long), "a waiting approval shows the complete command");
	const hiddenControls = "Write-Output 'café\u202E安全\u200B\u2060'";
	const visibleControls = "Write-Output 'café⟦U+202E⟧安全⟦U+200B⟧⟦U+2060⟧'";
	const controlApproval = show({ id: "controls", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: hiddenControls });
	assert.equal(controlApproval.node((node) => node.props.className === "tool-code").props.children, visibleControls, "approvals reveal controls and preserve ordinary Unicode text");
	const shellBlock = harness();
	const commands = [];
	const shellText = ["```powershell", hiddenControls, "```"].join("\n");
	shellBlock.markdown({ text: shellText, onRun: (code) => commands.push(code) });
	assert.equal(shellBlock.node((node) => node.type === "code").props.children, visibleControls, "Run blocks reveal the same controls");
	button(shellBlock, "Run").props.onClick();
	assert.deepEqual(commands, [hiddenControls], "Run receives the original command");
	shellBlock.markdown({ text: shellText });
	assert.equal(shellBlock.node((node) => node.type === "code").props.children, hiddenControls, "blocks without Run retain their normal display");
	button(approval, "Deny").props.onClick();
	button(approval, "Always allow in this folder").props.onClick();
	const toolApproval = show({ id: "tool-approve", kind: "mcp", title: "use_tool", detail: "Waiting for you", waiting: true, always: "conversation" });
	assert.ok(button(toolApproval, "Allow for this conversation"), "a tool rule says it lasts one conversation");
	assert.equal(button(toolApproval, "Always allow in this folder"), undefined);
	const secretApproval = show({ id: "secret-approve", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "curl [redacted]", always: "folder", noAlways: true });
	assert.equal(button(secretApproval, "Always allow in this folder"), undefined, "a masked command cannot be remembered");
	const chained = show({ id: "chained", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "npm test && curl example.com" });
	assert.equal(button(chained, "Always allow in this folder") || button(chained, "Allow for this conversation"), undefined, "a call Always allow could not remember offers no remembered grant");
	const prefixed = show({ id: "prefix", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "npm test && npm test -- --watch", commandPrefix: "npm test" });
	const prefixButton = button(prefixed, "Allow npm test commands");
	assert.equal(prefixButton.props.title, 'Allow "npm test …" with any arguments in this conversation. Some arguments make a tool run other programs. Ends when the conversation does.');
	prefixButton.props.onClick();
	assert.equal(button(chained, "Allow npm test commands"), undefined, "a command without eligible prefix metadata has no prefix grant");
	const normalized = show({ id: "normalized-prefix", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "GIT.EXE status", commandPrefix: "git status" });
	assert.ok(button(normalized, "Allow git status commands"), "the button uses the host's normalized grant text");
	const reads = show({ id: "reads", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "git status && git diff", readsOnly: true });
	assert.equal(reads.node((node) => node.props.children === "Often used to read").props.title, "Usually only reads, but arguments can change that. Check them.");
	assert.ok(button(reads, "Allow"), "the hint leaves the approval waiting for a click");
	const readWithoutGrant = show({ id: "read-without-grant", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "Get-Content file.txt", readsOnly: true });
	assert.ok(readWithoutGrant.node((node) => node.props.children === "Often used to read"));
	assert.equal(button(readWithoutGrant, "Allow get-content commands"), undefined, "a read hint does not make a non-allowlisted program eligible for a grant");
	const writes = show({ id: "writes", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: "git push" });
	assert.equal(writes.node((node) => node.props.children === "Often used to read"), undefined);
	const nativeApproval = show({ id: "native-permission:command", kind: "execute", title: "Run command", waiting: true });
	assert.ok(button(nativeApproval, "Deny") && button(nativeApproval, "Allow"), "native permission cards keep Deny and Allow");
	assert.equal(button(nativeApproval, "Always allow in this folder") || button(nativeApproval, "Allow for this conversation"), undefined, "native permission cards do not offer an unused remembered grant");
	const nativePrefix = show({ id: "native-permission:prefix", kind: "command", title: "Run command", waiting: true, commandPrefix: "npm test" });
	assert.equal(button(nativePrefix, "Allow npm test commands"), undefined, "native permission cards do not offer a prefix grant the native protocol cannot remember");
	button(approval, "Allow").props.onClick();
	assert.equal(decisions.join("|"), "approve:deny|approve:always|prefix:prefix|approve:allow");
	const mcpInput = JSON.stringify({ tool_name: "chrome__tabs_open", tool_input: { url: `https://example.com/${"p".repeat(600)}` } }, null, 2);
	const mcp = show({ id: "mcp", kind: "other", label: "Use Tool", title: "use_tool", detail: "Waiting for you", waiting: true, input: mcpInput, summary: "use_tool" });
	assert.ok(mcp.nodes().some((node) => node.props.children === mcpInput), "a waiting approval without a command shows its complete input");
	const emptyPlan = show({ id: "plan-empty", kind: "plan", title: "Plan", detail: "Waiting for your approval", waiting: true, plan: "" });
	assert.ok(button(emptyPlan, "Approve"), "an empty plan still gets plan buttons");
	assert.equal(button(emptyPlan, "Allow"), undefined);
	assert.equal(button(emptyPlan, "Deny"), undefined);

	const questions = [
		{ header: "Color", question: "Which color?", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: false },
		{ question: "Which sizes?", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiSelect: true },
	];
	const asked = show({ id: "ask", kind: "question", title: "Question", detail: "Waiting for your answer", waiting: true, questions });
	assert.ok(asked.node((node) => node.props.className === "chip-tag" && node.props.children === "Color"), "a question's header shows as a chip");
	assert.equal(button(asked, "Submit").props.disabled, true);
	option(asked, "Red").props.onClick();
	asked.render();
	assert.equal(option(asked, "Red").props["aria-pressed"], true);
	assert.equal(button(asked, "Submit").props.disabled, true, "Submit waits for every question");
	for (const label of ["S", "M", "L", "M"]) {
		option(asked, label).props.onClick();
		asked.render();
	}
	assert.equal(button(asked, "Submit").props.disabled, false);
	const other = asked.node((node) => node.props["aria-label"] === "Other answer: Which color?");
	assert.equal(other.props.maxLength, 4000);
	other.props.onChange({ target: { value: "  Green  " } });
	asked.render();
	assert.equal(option(asked, "Red").props["aria-pressed"], false, "typing an answer replaces the picked option");
	let finish;
	reply = () => new Promise((resolve) => { finish = resolve; });
	button(asked, "Submit").props.onClick();
	asked.render();
	assert.equal(JSON.stringify(questionCalls.at(-1)), JSON.stringify(["ask", { "Which color?": "Green", "Which sizes?": "S, L" }]));
	assert.equal(asked.nodes().filter((node) => node.type === "button").every((node) => node.props.disabled), true, "buttons are disabled while the answer is sent");
	finish({ ok: false, error: "Answer every question first." });
	await tick();
	asked.render();
	assert.ok(strings(asked.render()).includes("Answer every question first."), "a failure is shown in the row");
	assert.equal(button(asked, "Submit").props.disabled, false, "a failure re-enables the row");
	reply = () => Promise.resolve({ ok: true });
	const skipped = show({ id: "skip", kind: "question", title: "Question", detail: "Waiting for your answer", waiting: true, questions });
	button(skipped, "Skip").props.onClick();
	assert.equal(JSON.stringify(questionCalls.at(-1)), JSON.stringify(["skip", null]));
	const answered = show({ id: "answered", kind: "other", title: "Question", detail: "Answered", waiting: false, questions });
	assert.equal(answered.nodes().filter((node) => node.type === "button" || node.type === "input").length, 1, "an answered question has no controls");
	head(answered).props.onClick();
	assert.ok(strings(answered.render()).includes("Which sizes?"), "an answered question can be read");
	assert.equal(button(answered, "Submit"), undefined);
	const approved = show({ id: "approved", kind: "plan", title: "Plan", detail: "Approved · Normal", waiting: false, plan: "# Plan\n1. Do it" });
	head(approved).props.onClick();
	approved.render();
	assert.equal(planText(approved), "# Plan\n1. Do it", "an approved plan can be read");
	assert.equal(approved.nodes().filter((node) => node.type === "button").length, 1, "an approved plan has no controls");

	reply = () => Promise.resolve({ ok: false, error: "Try again." });
	const planned = show({ id: "plan", kind: "plan", title: "Plan", detail: "Waiting for your approval", waiting: true, plan: "# Plan" });
	for (const label of ["Approve", "Abandon"]) {
		button(planned, label).props.onClick();
		planned.render();
		assert.equal(button(planned, label).props.disabled, true);
		await tick();
		planned.render();
	}
	assert.equal(JSON.stringify(planCalls), JSON.stringify([["plan", { outcome: "approved", mode: "Normal" }], ["plan", { outcome: "abandoned", mode: "Normal" }]]));
	button(planned, "Keep planning").props.onClick();
	planned.render();
	const note = planned.node((node) => node.props["aria-label"] === "What should change in the plan");
	assert.equal(note.props.maxLength, 8000);
	assert.equal(button(planned, "Send").props.disabled, true, "Send waits for text");
	note.props.onChange({ target: { value: "   " } });
	planned.render();
	assert.equal(button(planned, "Send").props.disabled, true);
	planned.node((node) => node.props["aria-label"] === "What should change in the plan").props.onChange({ target: { value: "Add tests" } });
	planned.render();
	button(planned, "Send").props.onClick();
	assert.equal(JSON.stringify(planCalls.at(-1)), JSON.stringify(["plan", { outcome: "feedback", feedback: "Add tests" }]));

	const groupedApp = harness();
	await groupedApp.settle();
	const grouped = harness();
	const groupTools = [
		{ id: "g1", kind: "read", label: "Read", title: "Read a.ts", path: "C:/project/a.ts", detail: "Ran" },
		{ id: "g2", kind: "read", label: "Read", title: "Read b.ts", path: "C:/project/b.ts", detail: "Failed" },
		{ id: "g3", kind: "search", label: "Search", title: "Search src", detail: "Ran" },
		{ id: "g4", kind: "execute", label: "Run Command", title: "Run npm test", command: "npm test", detail: "Waiting for you", waiting: true },
		{ id: "g5", kind: "read", label: "Read", title: "Read c.ts", path: "C:/project/c.ts", detail: "Ran" },
	];
	const groupedMessage = { id: "grouped", role: "grok", text: "Looking.", tools: groupTools, parts: [{ kind: "tool", id: "g1" }, { kind: "tool", id: "g2" }, { kind: "tool", id: "g3" }, { kind: "tool", id: "g4" }, { kind: "text", text: "Looking." }, { kind: "tool", id: "g5" }] };
	const groupedModel = { ...groupedApp.model(), messages: [groupedMessage] };
	grouped.message(groupedModel);
	const placedRows = grouped.nodes(grouped.render()).filter((node) => node.type.name === "ToolGroup" || node.type.name === "ToolRow");
	assert.deepEqual(placedRows.map((node) => (node.type.name === "ToolGroup" ? node.props.tools.map((tool) => tool.id).join("+") : node.props.tool.id)), ["g1+g2+g3", "g4", "g5"], "a run of tool calls folds into one group; an approval and a lone call after text stay rows");
	const groupView = harness();
	groupView.group({ tools: groupTools.slice(0, 3), m: groupedModel });
	const groupRows = () => groupView.nodes(groupView.render()).filter((node) => node.type.name === "ToolRow").length;
	assert.equal(textOf(groupView.node((node) => node.props.className === "tool-head")), "Read 2 files, searched 1 time1 failed", "the group's row sums up its calls");
	assert.equal(groupRows(), 0, "the folded rows stay hidden");
	groupView.node((node) => node.props.className === "tool-head").props.onClick();
	assert.equal(groupRows(), 3, "opening the group shows its rows");
	const verboseView = harness();
	verboseView.group({ tools: groupTools.slice(0, 3), m: { ...groupedModel, view: "verbose" } });
	assert.equal(verboseView.nodes(verboseView.render()).filter((node) => node.type.name === "ToolRow").length, 3, "Verbose opens groups");
	const deniedCommand = { ...groupTools[3], waiting: false, detail: "Denied" };
	groupView.group({ tools: [...groupTools.slice(0, 3), deniedCommand], m: groupedModel });
	const statuses = groupView.nodes(groupView.node((node) => node.props.className === "tool-head")).filter((node) => node.props.className?.startsWith("tool-status"));
	assert.deepEqual(statuses.map((node) => [textOf(node), node.props.className]), [["1 denied", "tool-status"], ["1 failed", "tool-status bad"]], "only failures use the error color");
}

async function checkInboundTurns() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const agentSessionId = app.model().session.agentSessionId;
	const answers = [];
	const marker = "[Sent by a local tool, not typed in Grok Code]";
	app.api.inboundResult = async (requestId, result) => { answers.push([requestId, result]); };
	const inbound = async (requestId, text, target = agentSessionId) => {
		app.emit({ type: "inbound", requestId, agentSessionId: target, text });
		await app.settle();
		return answers.at(-1);
	};
	same(await inbound("idle", "/always-approve"), ["idle", { accepted: true, status: "sent" }]);
	assert.equal(app.sends.length, 2);
	assert.equal(app.sends.at(-1).text, `${marker}\n\n/always-approve`, "the marker prevents a local turn from running a slash command");
	assert.equal(app.sends.at(-1).mode, "Normal");
	same(await inbound("busy", "wait for this turn"), ["busy", { accepted: true, status: "queued" }]);
	assert.equal(app.sends.length, 2);
	same(savedHistory(app).queued[id].map((item) => item.text), [`${marker}\n\nwait for this turn`]);
	button(app, "Stop").props.onClick();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId, stopReason: "cancelled" });
	await app.settle();
	same(await inbound("held", "stay on hold"), ["held", { accepted: true, status: "held" }]);
	assert.equal(app.sends.length, 2, "an inbound turn does not release held messages");
	same(savedHistory(app).queued[id].map((item) => item.text), [`${marker}\n\nwait for this turn`, `${marker}\n\nstay on hold`]);
	assert.ok(app.nodes().some((node) => node.props.className === "note" && textOf(node).includes("Held until")), "the session stays held");
	const queued = JSON.stringify(savedHistory(app).queued);
	same(await inbound("unknown", "unknown target", "unknown-session"), ["unknown", { accepted: false }]);
	assert.equal(app.sends.length, 2);
	assert.equal(JSON.stringify(savedHistory(app).queued), queued);
	app.sidebar().onArchive(id);
	await app.settle();
	same(await inbound("archived", "archived target"), ["archived", { accepted: false }]);
	assert.equal(app.sends.length, 2);
	assert.equal(JSON.stringify(savedHistory(app).queued), queued);

	const stale = await composerWindow();
	const staleId = stale.model().session.id;
	const staleAnswers = [];
	stale.api.inboundResult = async (...answer) => { staleAnswers.push(answer); };
	const saved = savedHistory(stale);
	saved.modes[staleId] = "Plan";
	stale.storage.set("grok-code.history.v1", JSON.stringify(saved));
	stale.emit({ type: "inbound", requestId: "stale", agentSessionId: stale.model().session.agentSessionId, text: "use the current mode" });
	await stale.settle();
	same(staleAnswers, [["stale", { accepted: false, stale: true }]]);
	assert.equal(stale.sends.length, 1);
	same(savedHistory(stale).queued, {}, "a stale window queues nothing");
}

function routineFire(overrides = {}) {
	return { type: "routine-fire", runId: "run-1", routineId: "routine-1", sessionId: "new-run-1", title: "Morning report · Nov 8", project: "Morning report", folder: "C:/routines/routine-1", model: "grok-4.7", effort: "low", mode: "Auto-review", text: "[Scheduled run.]\n\nWrite the report.", ...overrides };
}

const workspaceInert = (app) => app.node((node) => node.props.className?.split(" ").includes("workspace")).props.inert;

async function checkRoutineFire() {
	const registering = harness();
	const order = [];
	const subscribe = registering.api.onEvent;
	registering.api.onEvent = (listener) => { order.push("subscribe"); return subscribe(listener); };
	registering.api.routinesReady = async () => { order.push("ready"); };
	await registering.settle();
	same(order, ["subscribe", "ready"], "the page registers for routines only after it can hear them");

	const app = await composerWindow();
	const visible = app.model().session.id;
	const sendsBefore = app.sends.length;
	app.emit(routineFire());
	await app.settle();
	assert.equal(app.model().session.id, visible, "a fire creates the session without changing the active one");
	const made = app.sidebar().sessions.find((item) => item.id === "new-run-1");
	same([made.title, made.titleAuto, made.model, made.effort, made.routineId, made.folder, made.project, made.worktree, made.environment], ["Morning report · Nov 8", false, "grok-4.7", "low", "routine-1", "C:/routines/routine-1", "Morning report", "Morning report", "Local"]);
	assert.equal(app.sidebar().sessions[0].id, "new-run-1", "it joins the list as a committed form does");
	assert.equal(app.sends.length, sendsBefore + 1);
	const sent = app.sends.at(-1);
	same([sent.uiSessionId, sent.cwd, sent.model, sent.effort, sent.mode, sent.text], ["new-run-1", "C:/routines/routine-1", "grok-4.7", "low", "Auto-review", "[Scheduled run.]\n\nWrite the report."], "it uses the routine's mode rather than the default");
	assert.equal(sent.unattended, true, "an Auto-review run tells Grok nobody is watching");
	assert.equal(app.readSettings().defaultMode, "Normal");
	assert.equal(made.sandbox, undefined, "and no sandbox");
	assert.equal(sent.sandbox, undefined);
	assert.equal(savedHistory(app).modes["new-run-1"], "Auto-review");
	app.emit({ type: "chunk", uiSessionId: "new-run-1", turnId: sent.turnId, text: "Report" });
	app.emit({ type: "done", uiSessionId: "new-run-1", turnId: sent.turnId, stopReason: "end_turn" });
	await app.settle();
	assert.equal(app.model().session.id, visible, "and it stays that way when the run ends");
	assert.equal(app.sidebar().sessions.find((item) => item.id === "new-run-1").unread, true);
	app.emit(routineFire());
	await app.settle();
	assert.equal(app.sends.length, sendsBefore + 1, "a session id that already exists does nothing");

	const stale = await composerWindow();
	const kept = stale.model().session.id;
	const doomed = await startSession(stale, "A chat that gets deleted");
	stale.emit({ type: "done", uiSessionId: doomed, turnId: stale.sends.at(-1).turnId });
	await stale.settle();
	assert.equal(stale.model().session.id, doomed);
	stale.sidebar().onDelete(doomed);
	await stale.settle();
	assert.equal(stale.model().session.id, kept, "deleting the chat on screen leaves a stale activeId, and the screen falls back");
	stale.emit(routineFire());
	await stale.settle();
	assert.equal(stale.sidebar().sessions[0].id, "new-run-1", "the new session comes first in the list");
	assert.equal(stale.model().session.id, kept, "a fire with a stale activeId leaves the same chat on screen");
	stale.emit(routineFire({ runId: "run-2", sessionId: "new-run-2" }));
	await stale.settle();
	assert.equal(stale.model().session.id, kept, "and so does the next one");

	const form = await composerWindow();
	form.sidebar().onNew();
	await form.settle();
	typePrompt(form, "A half-written prompt");
	form.emit(routineFire());
	await form.settle();
	assert.ok(form.node((node) => node.props.className === "new-page"), "the new-session form stays open");
	assert.equal(form.node((node) => node.props["aria-label"] === "Prompt").props.value, "A half-written prompt");
	assert.equal(form.sends.at(-1).uiSessionId, "new-run-1");

	const two = await composerWindow();
	two.emit(routineFire({ runId: "run-a", sessionId: "new-a", mode: "Auto-review" }));
	two.emit(routineFire({ runId: "run-b", sessionId: "new-b", mode: "Always-approve" }));
	same(two.sends.slice(-2).map((item) => item.routineRunId), ["run-a", "run-b"], "each dispatch identifies its run regardless of mode");
	same(two.sends.slice(-2).map((item) => [item.uiSessionId, item.mode, item.unattended]), [["new-a", "Auto-review", true], ["new-b", "Always-approve", undefined]], "two fires before a render each keep their own mode");
	await two.settle();
	same([savedHistory(two).modes["new-a"], savedHistory(two).modes["new-b"]], ["Auto-review", "Always-approve"]);
	assert.equal(two.sidebar().sessions.filter((item) => item.routineId).length, 2);

	const browsing = harness(new Map([["grok-code.settings.v1", JSON.stringify({ browserControl: true })]]));
	await browsing.settle();
	sendPrompt(browsing, "A chat somebody is watching");
	await browsing.settle();
	assert.equal(browsing.sends.at(-1).browser, true, "Browser control is on for a chat somebody started");
	browsing.emit(routineFire());
	await browsing.settle();
	assert.equal(browsing.sends.at(-1).uiSessionId, "new-run-1");
	assert.equal(browsing.sends.at(-1).browser, false, "a routine does not start the Browser server");

	const typed = await composerWindow();
	typed.emit(routineFire());
	await typed.settle();
	typed.emit({ type: "done", uiSessionId: "new-run-1", turnId: typed.sends.at(-1).turnId, stopReason: "end_turn" });
	await typed.settle();
	typed.emit({ type: "routine-open", sessionId: "new-run-1" });
	await typed.settle();
	sendPrompt(typed, "A question about the report");
	await typed.settle();
	same([typed.sends.at(-1).uiSessionId, typed.sends.at(-1).text, typed.sends.at(-1).unattended], ["new-run-1", "A question about the report", undefined], "a message typed into the run's chat has somebody watching");
	assert.equal(typed.sends.at(-1).routineRunId, undefined, "a typed message does not try to claim a routine");

	const refused = await composerWindow();
	const results = [];
	refused.api.routineResult = async (...answer) => { results.push(answer); };
	const refusedSends = refused.sends.length;
	refused.emit(routineFire({ folder: "" }));
	await refused.settle();
	same(results, [["run-1", { ok: false, error: "This window could not start the run." }]], "a send that returns false reports routineResult");
	assert.equal(refused.sends.length, refusedSends);
	const refusedRun = refused.sidebar().sessions.find((item) => item.id === "new-run-1");
	same([refusedRun.failed, refusedRun.unread], [true, true], "and its row shows the failure");
	refused.emit(routineFire());
	await refused.settle();
	assert.equal(results.length, 1, "a send that starts reports nothing");

	const unstarted = await composerWindow();
	unstarted.api.send = async () => ({ ok: false, error: "Grok could not start." });
	unstarted.emit(routineFire());
	await unstarted.settle();
	const unstartedRun = unstarted.sidebar().sessions.find((item) => item.id === "new-run-1");
	same([unstartedRun.failed, unstartedRun.unread], [true, true], "a run Grok could not start shows as failed");
	unstarted.api.send = async () => { throw new Error("gone"); };
	unstarted.emit(routineFire({ runId: "run-2", sessionId: "new-run-2" }));
	await unstarted.settle();
	assert.equal(unstarted.sidebar().sessions.find((item) => item.id === "new-run-2").failed, true, "as does one whose send is lost");
	unstarted.api.send = async () => ({ ok: false, error: "Stopped." });
	unstarted.emit(routineFire({ runId: "run-3", sessionId: "new-run-3" }));
	await unstarted.settle();
	assert.notEqual(unstarted.sidebar().sessions.find((item) => item.id === "new-run-3").failed, true, "a Stop during the start is not a failure");
	const plainFail = await composerWindow();
	plainFail.api.send = async () => ({ ok: false, error: "Grok could not start." });
	const plainId = await startSession(plainFail, "A plain chat");
	await plainFail.settle();
	assert.notEqual(plainFail.sidebar().sessions.find((item) => item.id === plainId).failed, true, "a plain chat's failed start stays as it was");

	const observer = await composerWindow();
	const other = harness(observer.storage);
	await other.settle();
	observer.emit(routineFire());
	await observer.settle();
	other.storageEvent("grok-code.history.v1");
	await other.settle();
	assert.equal(other.sidebar().sessions.some((item) => item.id === "new-run-1"), false, "other windows do not adopt a routine session while it runs");
	console.log("PASS routine fire: the session starts in its own mode with the screen left alone, even with a stale active id");
}

async function checkRoutineOpen() {
	const app = await composerWindow();
	const first = app.model().session.id;
	app.emit(routineFire());
	await app.settle();
	assert.equal(app.model().session.id, first);
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	assert.equal(workspaceInert(app), true, "Settings covers the workspace");
	app.emit({ type: "routine-open", sessionId: "new-run-1", agentSessionId: "provider-session" });
	await app.settle();
	assert.equal(app.model().session.id, "new-run-1", "routine-open selects an existing session");
	assert.equal(workspaceInert(app), false, "and closes Settings");

	app.emit({ type: "grokbot-status", status: { signedIn: true, keyring: true, signingIn: false, connection: "live", bots: [{ agentId: "bot-a", name: "First Bot" }], live: {} } });
	await app.settle();
	app.sidebar().grokBot.onOpen();
	await app.settle();
	assert.ok(app.node((node) => node.type === "GrokBotView"));
	app.emit({ type: "routine-open", sessionId: first });
	await app.settle();
	assert.equal(app.node((node) => node.type === "GrokBotView"), undefined, "and the Grok Bot page");
	assert.equal(app.model().session.id, first);
	app.sidebar().grokBot.onOpen();
	await app.settle();
	assert.ok(app.node((node) => node.type === "GrokBotView"));
	app.emit({ type: "routine-open", sessionId: first });
	await app.settle();
	assert.equal(app.node((node) => node.type === "GrokBotView"), undefined, "even when that chat is the one behind the Grok Bot page");

	const owner = await composerWindow();
	owner.storage.set("grok-code.settings.v1", JSON.stringify({ defaultMode: "Always-approve" }));
	const other = harness(owner.storage);
	const cliWindow = harness(owner.storage);
	const sidebarWindow = harness(owner.storage);
	await other.settle();
	await cliWindow.settle();
	await sidebarWindow.settle();
	assert.equal(other.readSettings().defaultMode, "Always-approve");
	const routineAgentId = "routine-provider-session";
	for (const window of [owner, other]) {
		const send = window.api.send;
		window.api.send = async (input) => ({ ...await send(input), agentSessionId: routineAgentId });
	}
	owner.emit(routineFire({ mode: "Normal" }));
	owner.emit({ type: "chunk", uiSessionId: "new-run-1", turnId: owner.sends.at(-1).turnId, text: "The report." });
	owner.emit({ type: "done", uiSessionId: "new-run-1", turnId: owner.sends.at(-1).turnId, stopReason: "end_turn" });
	await owner.settle();
	assert.ok(savedHistory(owner).sessions.some((item) => item.id === "new-run-1"));
	assert.equal(other.sidebar().sessions.some((item) => item.id === "new-run-1"), false);
	other.emit({ type: "routine-open", sessionId: "new-run-1" });
	await other.settle();
	assert.equal(other.model().session.id, "new-run-1", "routine-open adopts a session from saved history");
	assert.equal(other.model().messages.at(-1).text, "The report.", "with its chat");
	sendPrompt(other, "Follow up from the other window");
	await other.settle();
	assert.equal(other.sends.at(-1).mode, "Normal", "routine-open uses the saved mode on its first send");
	assert.equal(savedHistory(other).modes["new-run-1"], "Normal");

	owner.emit({ type: "routine-open", sessionId: "new-run-1" });
	await owner.settle();
	for (const [from, to] of [["Normal", "Auto-review"], ["Auto-review", "Plan"]]) {
		owner.node((node) => node.props.label === from).props.onClick();
		owner.render();
		owner.node((node) => node.props.role === "menuitemradio" && node.props.children[0] === to).props.onClick();
		await owner.settle();
	}
	const watched = savedHistory(owner);
	watched.sessions.find((item) => item.id === "new-run-1").prWatch = { number: 42, failing: [], seenAt: new Date().toISOString() };
	owner.storage.set("grok-code.history.v1", JSON.stringify(watched));
	cliWindow.storageEvent("grok-code.history.v1");
	sidebarWindow.storageEvent("grok-code.history.v1");
	await cliWindow.settle();
	await sidebarWindow.settle();
	assert.ok(cliWindow.sidebar().sessions.some((item) => item.id === "new-run-1"), "the storage event can adopt a watched chat before it opens");
	cliWindow.sidebar().onOpenCliSession(routineAgentId);
	await cliWindow.settle();
	assert.equal(cliWindow.model().session.id, "new-run-1");
	assert.equal(cliWindow.model().resumeMode, "Auto-review", "Open CLI session restores the pre-Plan mode");
	sendPrompt(cliWindow, "Review the plan in this window");
	await cliWindow.settle();
	assert.equal(cliWindow.sends.at(-1).mode, "Plan", "Open CLI session uses the saved mode on its first send");
	assert.equal(savedHistory(cliWindow).modes["new-run-1"], "Plan");
	sidebarWindow.sidebar().onSelect("new-run-1");
	await sidebarWindow.settle();
	sendPrompt(sidebarWindow, "Open the watched chat from the sidebar");
	await sidebarWindow.settle();
	assert.equal(sidebarWindow.sends.at(-1).mode, "Plan", "a watched session also uses the saved mode when opened from the sidebar");

	const damaged = savedHistory(cliWindow);
	damaged.modes["new-run-1"] = "Future mode";
	const loaded = harness(new Map(cliWindow.storage).set("grok-code.history.v1", JSON.stringify(damaged)), "?session=new-run-1");
	await loaded.settle();
	sendPrompt(loaded, "Use a known mode");
	await loaded.settle();
	assert.equal(loaded.sends.at(-1).mode, "Normal", "an unknown saved mode loads as Normal");

	const launched = await composerWindow();
	launched.emit(routineFire());
	launched.emit({ type: "done", uiSessionId: "new-run-1", turnId: launched.sends.at(-1).turnId, stopReason: "end_turn" });
	await launched.settle();
	const restarted = harness(new Map(launched.storage));
	await restarted.settle();
	assert.equal(restarted.model().session.id, launched.model().session.id, "a new launch opens an ordinary chat, not the newest run");
	assert.equal(restarted.sidebar().sessions.find((item) => item.id === "new-run-1").unread, true, "so the run keeps its unread dot");
	const stepping = await composerWindow();
	const steppingChat = stepping.model().session.id;
	const steppingOther = await startSession(stepping, "Another chat");
	stepping.emit({ type: "done", uiSessionId: steppingOther, turnId: stepping.sends.at(-1).turnId });
	stepping.emit(routineFire());
	await stepping.settle();
	stepping.key({ key: "Tab", ctrlKey: true });
	await stepping.settle();
	assert.equal(stepping.model().session.id, steppingChat, "Ctrl+Tab passes over a run's chat");
	stepping.key({ key: "Tab", ctrlKey: true });
	await stepping.settle();
	assert.equal(stepping.model().session.id, steppingOther, "whichever way round the list goes");

	const opened = [];
	const cli = await composerWindow();
	cli.api.openCliSession = async (id) => { opened.push(id); return { ok: true, session: { id, title: "From the CLI", folder: "C:/work/app" }, messages: [{ role: "user", text: "open" }] }; };
	cli.emit({ type: "routine-open", sessionId: "new-gone", agentSessionId: "cli-session" });
	await cli.settle();
	same(opened, ["cli-session"], "with no saved session, an agent session goes to openCliSession");
	assert.equal(cli.model().session.agentSessionId, "cli-session");
	assert.equal(workspaceInert(cli), false);

	const page = await composerWindow();
	const onScreen = page.model().session.id;
	page.emit({ type: "routine-open" });
	await page.settle();
	assert.equal(workspaceInert(page), true, "with no session, it opens the Routines page");
	assert.equal(page.sidebar().inert, true);
	assert.equal(page.notice(), undefined, "with no notice when no session was named");
	assert.equal(page.model().session.id, onScreen);
	page.emit({ type: "routine-open", sessionId: onScreen });
	await page.settle();
	assert.equal(workspaceInert(page), false, "a session closes the Routines page");
	page.emit({ type: "routine-open", sessionId: "new-gone" });
	await page.settle();
	assert.equal(workspaceInert(page), true, "a session this computer no longer has opens the page");
	assert.match(page.notice(), /no longer in this window/, "and says so");

	const busy = await composerWindow();
	const firstChat = busy.model().session.id;
	busy.emit({ type: "done", uiSessionId: firstChat, turnId: busy.sends.at(-1).turnId });
	const secondChat = await startSession(busy, "A running turn");
	assert.equal(busy.cancels.length, 0);
	busy.emit({ type: "routine-open" });
	await busy.settle();
	assert.equal(workspaceInert(busy), true);
	busy.key({ key: "Tab", ctrlKey: true });
	await busy.settle();
	assert.equal(busy.model().session.id, secondChat, "shortcuts stay off while the page covers the sessions");
	busy.key({ key: "Escape" });
	await busy.settle();
	assert.equal(workspaceInert(busy), false, "Escape with the Routines page open closes it");
	assert.equal(busy.cancels.length, 0, "and does not call cancel");
	busy.emit({ type: "routine-open" });
	await busy.settle();
	busy.document.querySelector = (selector) => selector === "[data-routine-form]" ? {} : null;
	busy.key({ key: "Escape" });
	await busy.settle();
	assert.equal(workspaceInert(busy), true, "Escape never closes the page over an open routine form");
	assert.equal(busy.cancels.length, 0);
	busy.emit({ type: "routine-open", sessionId: firstChat });
	await busy.settle();
	assert.equal(workspaceInert(busy), true, "nor does a click on a routine notification");
	assert.equal(busy.model().session.id, secondChat);
	busy.document.querySelector = () => null;
	console.log("PASS routine open: existing session, saved history, CLI fallback, the Routines page state and Escape");
}

async function checkOpenAtSignInRow() {
	const view = harness();
	const calls = [];
	let answer = { ok: true, available: true, on: false, blockedBySystem: false };
	view.api.openAtSignIn = async (...args) => { calls.push(args); return answer; };
	const open = (target) => target.settingsView({ settings: target.readSettings(), initialTab: "general", onChange() { throw new Error("This setting is not a saved setting."); }, onClose() {}, onCheckSetup() {}, onRun() {}, servers: [], folder: "C:/project" });
	const toggle = (target) => target.node((node) => node.props["aria-label"] === "Open at sign-in");
	const notes = (target) => target.nodes().filter((node) => node.type === "p" && node.props.className === "note").map(textOf);
	open(view);
	assert.equal(toggle(view).props.disabled, true, "until the system answers the switch is off and disabled");
	await view.settle();
	same(calls, [[]], "the row reads the system on mount");
	assert.equal(toggle(view).props.checked, false);
	assert.equal(toggle(view).props.disabled, false);
	assert.ok(view.nodes().some((node) => node.type === "small" && textOf(node) === "Starts the app when you sign in to this computer. Scheduled routines run only while the app is open."));
	answer = { ...answer, on: true };
	toggle(view).props.onChange({ target: { checked: true } });
	await view.settle();
	same(calls.at(-1), [true]);
	assert.equal(toggle(view).props.checked, true, "it shows what the handler returned");
	answer = { ...answer, on: false };
	toggle(view).props.onChange({ target: { checked: true } });
	await view.settle();
	assert.equal(toggle(view).props.checked, false, "even when that is not what was asked for");
	answer = { ok: true, available: true, on: true, blockedBySystem: true };
	toggle(view).props.onChange({ target: { checked: true } });
	await view.settle();
	assert.ok(notes(view).some((text) => text.includes("turned off in Windows' Startup apps")));
	answer = { ok: false, available: true, on: false, blockedBySystem: false, error: "The setting could not be changed: Access denied" };
	toggle(view).props.onChange({ target: { checked: true } });
	await view.settle();
	assert.ok(notes(view).includes("The setting could not be changed: Access denied"));
	assert.equal(notes(view).some((text) => text.includes("Startup apps")), false);
	assert.equal(view.settingsWrites.length, 0, "nothing goes into saved settings");
	view.api.openAtSignIn = async () => { throw new Error("Bridge gone."); };
	toggle(view).props.onChange({ target: { checked: true } });
	await view.settle();
	assert.ok(notes(view).includes("The setting could not be changed."));

	const source = harness();
	source.api.openAtSignIn = async () => ({ ok: true, available: false, on: false, blockedBySystem: false });
	open(source);
	await source.settle();
	assert.equal(toggle(source).props.disabled, true, "where it is unavailable the row is disabled");
	assert.ok(notes(source).includes("Open at sign-in works in the installed app."));
	console.log("PASS Open at sign-in row: reads on mount, shows the system's answer, and explains blocked and unavailable");
}

async function checkQueue() {
	const app = harness();
	await app.settle();
	const firstId = app.model().session.id;
	const prompt = () => app.node((node) => node.props["aria-label"] === "Prompt");
	const queuedTexts = () => app.nodes().filter((node) => node.props.className === "queued").map((node) => textOf(node.props.children[0]));
	assert.equal(app.node((node) => node.props.className === "suggestion"), undefined, "no sample suggestion line");
	typePrompt(app, "draft for first");
	app.sidebar().onNew();
	await app.settle();
	assert.equal(prompt().props.value, "", "a new session has its own empty draft");
	sendPrompt(app, "open the second session");
	await app.settle();
	const secondId = app.model().session.id;
	app.emit({ type: "done", uiSessionId: secondId, turnId: app.sends.at(-1).turnId });
	app.sidebar().onSelect(firstId);
	await app.settle();
	assert.equal(prompt().props.value, "draft for first", "each session keeps its own draft");
	const base = app.sends.length;

	sendPrompt(app, "first turn");
	await app.settle();
	assert.equal(app.sends.length, base + 1);
	assert.equal(prompt().props.value, "");
	assert.ok(button(app, "Stop"), "an empty prompt during a turn shows Stop");
	sendPrompt(app, "queued one");
	await app.settle();
	sendPrompt(app, "queued two");
	await app.settle();
	assert.equal(app.sends.length, base + 1, "Enter while Grok answers queues the message");
	assert.equal(prompt().props.value, "", "a queued message leaves the prompt box");
	assert.deepEqual(queuedTexts(), ["queued one", "queued two"]);
	assert.equal((await app.beforeUnload()).prevented, false, "a saved queue survives a close or reload");
	same(savedHistory(app).queued[firstId].map((item) => item.text), ["queued one", "queued two"], "the saved queue keeps message order");
	app.sidebar().onSelect(secondId);
	await app.settle();
	assert.deepEqual(queuedTexts(), [], "the queue belongs to its session");
	assert.equal((await app.beforeUnload()).prevented, false, "a saved queue in another session does not block closing");
	app.sidebar().onSelect(firstId);
	await app.settle();
	app.emit({ type: "done", uiSessionId: firstId, turnId: app.sends[base].turnId });
	await app.settle();
	assert.equal(app.sends.length, base + 2, "the next queued message goes when the turn ends");
	assert.equal(app.sends[base + 1].text, "queued one");
	assert.equal(app.sends[base + 1].uiSessionId, firstId);
	assert.deepEqual(queuedTexts(), ["queued two"]);

	sendPrompt(app, "urgent");
	await app.settle();
	assert.deepEqual(queuedTexts(), ["queued two", "urgent"]);
	assert.match(queuedAction(app, 1, "Send now").props.title, /stops the current reply/i);
	queuedAction(app, 1, "Send now").props.onClick();
	await app.settle();
	assert.deepEqual(app.cancels, [firstId], "Send now stops the running turn");
	assert.deepEqual(queuedTexts(), ["urgent", "queued two"]);
	app.emit({ type: "done", uiSessionId: firstId, turnId: app.sends[base + 1].turnId, stopReason: "cancelled" });
	await app.settle();
	assert.equal(app.sends.at(-1).text, "urgent", "Send now sends that message next");

	button(app, "Stop").props.onClick();
	await app.settle();
	assert.deepEqual(app.cancels, [firstId, firstId]);
	app.emit({ type: "done", uiSessionId: firstId, turnId: app.sends.at(-1).turnId, stopReason: "cancelled" });
	await app.settle();
	assert.equal(app.sends.length, base + 3, "Stop holds the rest of the queue");
	assert.deepEqual(queuedTexts(), ["queued two"]);
	assert.equal((await app.beforeUnload()).prevented, false, "a held queue is saved too");
	sendPrompt(app, "/btw side while held");
	await app.settle();
	assert.equal(app.sends.length, base + 4);
	assert.equal(app.sends.at(-1).uiSessionId, `side-${firstId}`, "a side question runs as its own Grok conversation");
	assert.ok(app.sends.at(-1).text.startsWith("Read-only context from the main conversation."), "the first side question carries the main conversation as context");
	assert.ok(app.sends.at(-1).text.endsWith("Side question: side while held"));
	assert.equal(app.sends.at(-1).mode, "Normal", "a side question never inherits an auto mode");
	app.emit({ type: "done", uiSessionId: `side-${firstId}`, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(app.sends.length, base + 4, "a side question does not release a queue that Stop held");
	queuedAction(app, 0, "Remove queued message").props.onClick();
	await app.settle();
	assert.deepEqual(queuedTexts(), [], "a queued message can be removed");
	assert.equal(app.sends.length, base + 4);
	assert.equal((await app.beforeUnload()).prevented, false, "with nothing queued and no unsaved file text, a close does not ask");

	sendPrompt(app, "busy again");
	await app.settle();
	sendPrompt(app, "/btw side");
	await app.settle();
	assert.equal(app.sends.length, base + 6, "a side question runs while its session answers");
	assert.ok(app.sends.at(-1).text.includes("User: busy again"), "a later side question carries main-chat messages it has not seen");
	assert.ok(!app.sends.at(-1).text.includes("side while held") && app.sends.at(-1).text.endsWith("Side question: side"), "it does not resend what the side chat already saw, or the reply still streaming");
	assert.equal(app.sends.at(-1).agentSessionId, "provider-session");
	assert.equal(app.model().busy, true, "the main turn keeps running");

	sendPrompt(app, "held, then deleted");
	await app.settle();
	button(app, "Stop").props.onClick();
	await app.settle();
	app.emit({ type: "done", uiSessionId: firstId, turnId: app.sends[base + 4].turnId, stopReason: "cancelled" });
	await app.settle();
	assert.deepEqual(queuedTexts(), ["held, then deleted"], "Stop holds the queue");
	app.sidebar().onDelete(firstId);
	await app.settle();
	assert.equal((await app.beforeUnload()).prevented, false, "a deleted session's held queue does not make a close ask");
}

async function checkFixBrief() {
	const settingsKey = "grok-code.settings.v1";
	const fresh = harness();
	await fresh.settle();
	assert.equal(JSON.parse(fresh.storage.get(settingsKey)).defaultMode, "Normal", "empty storage starts in Normal");
	const explicit = harness(new Map([[settingsKey, JSON.stringify({ defaultMode: "Always-approve" })]]));
	await explicit.settle();
	sendPrompt(explicit, "keep my saved setting");
	await explicit.settle();
	assert.equal(explicit.sends.at(-1).mode, "Always-approve", "an explicit saved default survives relaunch");
	explicit.storage.set(settingsKey, JSON.stringify({ defaultMode: "Normal" }));
	explicit.storageEvent(settingsKey);
	await explicit.settle();
	explicit.sidebar().onCollapse();
	await explicit.settle();
	assert.equal(JSON.parse(explicit.storage.get(settingsKey)).defaultMode, "Normal", "a sidebar change keeps the other window's stricter default");

	const plans = harness();
	await plans.settle();
	const first = plans.model().session.id;
	const finish = async () => { plans.emit({ type: "done", uiSessionId: plans.sends.at(-1).uiSessionId, turnId: plans.sends.at(-1).turnId }); await plans.settle(); };
	const pickMode = async (next) => {
		plans.node((node) => ["Normal", "Plan", "Auto-review", "Always-approve"].includes(node.props.label)).props.onClick();
		plans.render();
		plans.nodes().find((node) => node.props.className?.startsWith("mode-row") && [node.props.children].flat()[0] === next).props.onClick();
		await plans.settle();
	};
	sendPrompt(plans, "session A");
	await plans.settle();
	await finish();
	await startSession(plans, "session B");
	await finish();
	await pickMode("Always-approve");
	plans.sidebar().onSelect(first);
	await plans.settle();
	await pickMode("Plan");
	assert.equal(savedHistory(plans).prePlan[first], "Normal", "Plan records A's mode despite B's folder preference");
	const restored = harness(plans.storage, `?session=${first}`);
	await restored.settle();
	assert.equal(restored.model().resumeMode, "Normal", "the pre-Plan mode survives a reload");
	sendPrompt(restored, "write the plan");
	await restored.settle();
	await restored.model().answerPlan("plan", { outcome: "approved", mode: restored.model().resumeMode });
	await restored.settle();
	assert.equal(restored.planAnswers.at(-1).mode, "Normal");
	assert.ok(restored.node((node) => node.props.label === "Normal"), "Approve restores A's Normal chip");

	const commands = harness();
	await commands.settle();
	commands.sidebar().onNew();
	await commands.settle();
	sendPrompt(commands, "!git status");
	await commands.settle();
	assert.equal(commands.sends.length, 0, "! on the new-session page sends nothing to Grok");
	assert.equal(commands.node((node) => node.props["aria-label"] === "Prompt").props.value, "!git status", "the command draft stays in the composer");
	assert.match(commands.notice(), /Send a first message/);
	sendPrompt(commands, "start it");
	await commands.settle();
	commands.emit({ type: "done", uiSessionId: commands.model().session.id, turnId: commands.sends.at(-1).turnId });
	await commands.settle();
	const opens = [];
	const writes = [];
	commands.api.terminalOpen = async ({ cwd }) => { opens.push(cwd); return { ok: true, id: `term-${opens.length}` }; };
	commands.api.terminalWrite = async (id, text) => { writes.push([id, text]); return { ok: true }; };
	sendPrompt(commands, "!git status");
	await commands.settle();
	commands.pickedFolders.push("C:/changed-folder");
	commands.node((node) => node.props.label === commands.model().session.project).props.onClick();
	commands.render();
	button(commands, "Choose a folder").props.onClick();
	await commands.settle();
	sendPrompt(commands, "!git status");
	await commands.settle();
	same(opens, [commands.api.homeDir, "C:/changed-folder"], "a folder change opens another terminal");
	same(writes.map(([id]) => id), ["term-1", "term-2"]);
	commands.node((node) => node.props["aria-label"] === "More").props.onClick();
	commands.render();
	assert.equal(button(commands, "Session rail (window too narrow)").props.disabled, true);
	commands.key({ key: "Escape" });
	await commands.settle();
	sendPrompt(commands, "keep working");
	await commands.settle();
	sendPrompt(commands, "/btw side question");
	await commands.settle();
	assert.ok(commands.node((node) => node.props.className === "side-q"));
	commands.key({ key: "Escape", target: { closest: (selector) => selector === ".side-q" } });
	await commands.settle();
	assert.equal(commands.node((node) => node.props.className === "side-q"), undefined);
	assert.deepEqual(commands.cancels, [], "Esc in side chat closes it without cancelling the turn");
	commands.key({ key: "Escape", target: { closest: (selector) => selector === ".side-col, .session-rail" } });
	await commands.settle();
	assert.deepEqual(commands.cancels, [], "Esc in a pane or rail leaves the turn running");

	const archived = savedHistory(plans);
	const target = archived.sessions.find((item) => item.id === first);
	Object.assign(target, { archived: true, worktreeFolder: "C:/project/.grok/worktrees/a", folder: "C:/project/.grok/worktrees/a", branch: "grok/a" });
	const worktree = harness(new Map([["grok-code.history.v1", JSON.stringify(archived)]]));
	await worktree.settle();
	const restores = [];
	worktree.api.restoreWorktree = async (...args) => { restores.push(args); return { ok: false, error: "The branch is gone." }; };
	worktree.sidebar().onArchive(first);
	await worktree.settle();
	assert.equal(worktree.sidebar().sessions.find((item) => item.id === first).archived, true, "failed restoration leaves the session archived");
	assert.equal(worktree.notice(), "The branch is gone.");
	worktree.api.restoreWorktree = async (...args) => { restores.push(args); return { ok: true }; };
	worktree.sidebar().onArchive(first);
	await worktree.settle();
	same(restores[0], [target.worktreeFolder, "grok/a"]);
	assert.equal(worktree.sidebar().sessions.find((item) => item.id === first).archived, false);
	worktree.api.removeWorktree = async () => ({ ok: false, error: "Directory in use." });
	worktree.sidebar().onArchive(first);
	await worktree.settle();
	assert.match(worktree.notice(), /Archived\. The worktree could not be checked, so it stays on disk: Directory in use/);
	assert.ok(!worktree.notice().includes("delete the folder"), "an unchecked worktree never gets deletion advice");
	worktree.sidebar().onArchive(first);
	await worktree.settle();
	worktree.api.removeWorktree = async () => ({ ok: false, dirty: false, error: "Directory in use." });
	worktree.sidebar().onArchive(first);
	await worktree.settle();
	assert.match(worktree.notice(), /Archived, but the worktree folder could not be removed: Directory in use/);

	const merge = harness();
	merge.api.prStatus = async () => ({ ok: true, pr: { number: 42, state: "OPEN", checks: [] } });
	let merged;
	merge.api.prMergeWhenReady = async (...args) => { merged = args; return { ok: true }; };
	await merge.settle();
	await merge.node((node) => node.type === "SessionRail").props.onMergeWhenReady();
	same(merged, [merge.model().session.folder, 42], "the displayed PR number reaches the merge API");
}

async function checkRoutineBatchB() {
	const seed = harness();
	await seed.settle();
	sendPrompt(seed, "seed");
	await seed.settle();
	seed.emit({ type: "done", uiSessionId: seed.model().session.id, turnId: seed.sends.at(-1).turnId });
	await seed.settle();
	for (const inWorktree of [false, true]) {
		const history = savedHistory(seed);
		if (inWorktree) { history.sessions[0].worktreeFolder = history.sessions[0].folder; }
		const appWindow = harness(new Map([["grok-code.history.v1", JSON.stringify(history)]]));
		await appWindow.settle();
		sendPrompt(appWindow, "active turn");
		await appWindow.settle();
		sendPrompt(appWindow, "queued follow-up");
		await appWindow.settle();
		const cancel = async () => {
			appWindow.emit({ type: "done", uiSessionId: appWindow.model().session.id, turnId: appWindow.sends.at(-1).turnId, stopReason: "cancelled" });
			return { ok: true };
		};
		const stops = [];
		appWindow.api.stopSession = async (id) => { stops.push(id); return cancel(); };
		appWindow.api.removeWorktree = async (...args) => { stops.push(args[1]); return cancel(); };
		appWindow.sidebar().onArchive(appWindow.model().session.id);
		await appWindow.settle();
		assert.ok(textOf(appWindow.render()).includes("Grok is still working in this session. Archiving stops the turn and any background commands."), "archiving a working session asks first");
		assert.deepEqual(stops, [], "nothing stops before the confirmation");
		assert.equal(appWindow.sidebar().sessions.find((item) => item.id === appWindow.sends[0].uiSessionId).archived, false);
		button(appWindow, "Archive and stop").props.onClick();
		await appWindow.settle();
		assert.equal(stops.length, 1, "confirming archive stops the session's Grok");
		assert.equal(appWindow.sends.length, 1, `archive holds the queued follow-up (${inWorktree ? "worktree" : "local"})`);
		assert.equal(appWindow.sidebar().sessions.find((item) => item.id === appWindow.sends[0].uiSessionId).archived, true);
	}
	const background = await composerWindow();
	const backgroundId = background.model().session.id;
	const stopped = [];
	background.api.stopSession = async (id) => { stopped.push(id); return { ok: true }; };
	background.emit({ type: "bg-tasks", uiSessionId: backgroundId, tasks: [{ id: "server", label: "Dev server", command: "npm run dev", kind: "bash", status: "running", startedAt: Date.now(), endedAt: 0, exitCode: null }] });
	await background.settle();
	background.sidebar().onArchive(backgroundId);
	await background.settle();
	assert.ok(textOf(background.render()).includes("Archiving stops the turn and any background commands."), "a running background command alone asks before archiving");
	button(background, "Cancel").props.onClick();
	await background.settle();
	assert.deepEqual(stopped, [], "cancelling the confirmation keeps the background command");
	assert.equal(background.sidebar().sessions.find((item) => item.id === backgroundId).archived, false);
	background.emit({ type: "bg-tasks", uiSessionId: backgroundId, tasks: [{ id: "server", label: "Dev server", command: "npm run dev", kind: "bash", status: "completed", startedAt: Date.now(), endedAt: Date.now(), exitCode: 0 }] });
	await background.settle();
	background.sidebar().onArchive(backgroundId);
	await background.settle();
	same(stopped, [backgroundId], "an idle session archives in one click");
	assert.equal(background.sidebar().sessions.find((item) => item.id === backgroundId).archived, true);

	const streaming = harness();
	await streaming.settle();
	sendPrompt(streaming, "show PowerShell");
	await streaming.settle();
	const turn = streaming.sends.at(-1);
	streaming.emit({ type: "chunk", uiSessionId: turn.uiSessionId, turnId: turn.turnId, text: "```powershell\nGet-Location\n```" });
	await streaming.settle();
	const reply = harness();
	const runVisible = () => {
		reply.message({ ...streaming.model(), messages: streaming.model().messages.filter((message) => message.role === "grok") });
		const markdown = reply.node((node) => node.type.name === "Markdown");
		return !!reply.nodes(markdown.type(markdown.props)).find((node) => node.type === "button" && node.props.children === "Run");
	};
	assert.equal(runVisible(), false, "a streaming PowerShell block has no Run button");
	streaming.emit({ type: "done", uiSessionId: turn.uiSessionId, turnId: turn.turnId });
	await streaming.settle();
	assert.equal(runVisible(), true, "Run appears after the reply finishes");

	const pr = harness();
	pr.api.branchInfo = async () => ({ ok: true, branch: "feature-on-screen", ahead: 1 });
	let created;
	pr.api.prCreate = async (...args) => { created = args; return { ok: true }; };
	await pr.settle();
	await pr.node((node) => node.type === "SessionRail").props.onCreatePr();
	same(created, [pr.model().session.folder, "feature-on-screen"], "Create PR carries the displayed branch");
}

async function checkNativeTerminalRouting() {
	const appWindow = await composerWindow();
	const sessionId = appWindow.model().session.id;
	let nextId = 0;
	const writes = [];
	const inputs = [];
	const sizes = [];
	const closed = [];
	appWindow.api.terminalOpen = async () => ({ ok: true, id: `pty-${++nextId}`, backend: "pty" });
	appWindow.api.terminalWrite = async (id, text) => { writes.push([id, text]); return { ok: true }; };
	appWindow.api.terminalInput = async (id, text) => { inputs.push([id, text]); return { ok: true }; };
	appWindow.api.terminalResize = async (...args) => { sizes.push(args); return { ok: true }; };
	appWindow.api.terminalClose = async (id) => { closed.push(id); return { ok: true }; };
	const terminal = () => appWindow.node((node) => node.type === "TerminalPane").props;
	await appWindow.model().runInTerminal("Get-Location");
	await appWindow.settle();
	terminal().onInput("pty-1", "echo draft ");
	terminal().onResize("pty-1", 120, 40);
	await appWindow.model().runInTerminal("npm test");
	await appWindow.settle();
	same(writes, [["pty-1", "Get-Location"], ["pty-2", "npm test"]], "Run never submits into a native terminal's draft or foreground program");
	same(inputs, [["pty-1", "echo draft "]], "typed bytes use the raw input bridge");
	same(sizes, [["pty-1", 120, 40]], "terminal dimensions reach the host bridge");
	terminal().onCloseTab("pty-1");
	await appWindow.settle();
	let finishOpen;
	appWindow.api.terminalOpen = () => new Promise((resolve) => { finishOpen = resolve; });
	terminal().onNew();
	const prompt = { focus() { appWindow.document.activeElement = this; } };
	appWindow.node((node) => node.props["aria-label"] === "Prompt").props.ref.current = prompt;
	terminal().onClose();
	assert.equal(appWindow.document.activeElement, prompt, "closing a focused terminal returns focus to the composer");
	await appWindow.settle();
	appWindow.key({ key: "`", code: "Backquote", ctrlKey: true, repeat: true });
	await appWindow.settle();
	assert.equal(button(appWindow, "Terminal").props["aria-pressed"], false, "a held shortcut does not reopen the pane after focus moves");
	appWindow.emit({ type: "terminal-data", id: "pty-2", data: "still running while hidden" });
	finishOpen({ ok: true, id: "pty-3", backend: "pty" });
	await appWindow.settle();
	same(closed, ["pty-1"], "closing the pane keeps open and opening terminals alive");
	button(appWindow, "Terminal").props.onClick();
	await appWindow.settle();
	same(terminal().tabs.map((tab) => tab.id), ["pty-2", "pty-3"], "reopening shows both original tabs");
	assert.equal(terminal().tabs[0].output, "still running while hidden");
	terminal().onNew();
	appWindow.sidebar().onDelete(sessionId);
	await appWindow.settle();
	finishOpen({ ok: true, id: "pty-4", backend: "pty" });
	await appWindow.settle();
	same(closed, ["pty-1", "pty-2", "pty-3", "pty-4"], "deleting the owner stops its tabs and closes a late open");
}

async function checkBrowserControl() {
	const timers = controlledTimers();
	const app = harness(new Map(), "", Date, timers);
	const reports = [];
	const actions = [];
	app.api.browserTabs = async (payload) => { reports.push(payload); return { ok: true }; };
	app.api.browserStop = async (id) => { actions.push(`stop:${id}`); return { ok: true }; };
	app.api.browserResume = async (id) => { actions.push(`resume:${id}`); return { ok: true }; };
	await app.settle();
	const firstId = app.model().session.id;
	assert.equal(app.readSettings().browserControl, false);
	same(reports.at(-1), { uiSessionId: firstId, enabled: false, visible: false, activeId: "", tabs: [] });
	sendPrompt(app, "first turn");
	await app.settle();
	assert.equal(app.sends.at(-1).browser, false, "browser control is absent from default turns");
	app.emit({ type: "done", uiSessionId: firstId, turnId: app.sends.at(-1).turnId });
	app.emit({ type: "browser-open", uiSessionId: firstId, url: "https://example.test/" });
	await app.settle();
	assert.equal(app.node((node) => node.type === "BrowserPane"), undefined, "disabled browser control does not open a pane");
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	const settings = app.node((node) => node.type.name === "SettingsPage").props;
	const view = harness();
	view.settingsView({ ...settings, initialTab: "general" });
	const toggle = view.node((node) => node.props["aria-label"] === "Let Grok use the Browser pane");
	assert.equal(toggle.props.checked, false);
	assert.ok(textOf(view.render()).includes("What it reads goes to xAI"));
	assert.ok(textOf(view.render()).includes("Links and redirects can load a new site before Grok asks to read it"));
	toggle.props.onChange({ target: { checked: true } });
	settings.onClose();
	await app.settle();
	assert.equal(reports.at(-1).enabled, true, "a hidden pane still reports the current session and enabled switch");
	app.emit({ type: "browser-open", uiSessionId: firstId, url: "https://example.test/path" });
	await app.settle();
	const browser = () => app.node((node) => node.type === "BrowserPane" && node.props.visible)?.props;
	const retainedBrowser = (id) => app.node((node) => node.type === "BrowserPane" && node.props.uiSessionId === id)?.props;
	assert.equal(browser().uiSessionId, firstId);
	assert.equal(browser().tabs[0].url, "https://example.test/path");
	const cleared = [];
	app.api.clearBrowsingData = async (partition) => { cleared.push(partition); return { ok: true }; };
	for (const accept of [false, true]) {
		void browser().onClearData();
		await app.settle();
		assert.equal(cleared.length, 0, "clearing browser storage waits for confirmation");
		button(app, accept ? "Clear data" : "Cancel").props.onClick();
		await app.settle();
	}
	assert.deepEqual(cleared, ["persist:grok-code", "temp:grok-code"]);
	const firstTab = browser().activeId;
	app.emit({ type: "browser-activity", uiSessionId: firstId, text: "clicking a button", running: true });
	await app.settle();
	timers.advance(20000);
	await app.settle();
	assert.equal(browser().controlActivity.running, true, "a long call keeps its banner until completion");
	app.emit({ type: "browser-activity", uiSessionId: firstId, text: "click finished", running: false });
	await app.settle();
	timers.advance(4999);
	await app.settle();
	assert.ok(browser().controlActivity);
	timers.advance(1);
	await app.settle();
	assert.equal(browser().controlActivity, undefined, "a completed call keeps its banner for five seconds");
	browser().onStopControl();
	await app.settle();
	assert.equal(browser().controlStopped, true);
	browser().onResumeControl();
	await app.settle();
	assert.equal(browser().controlStopped, false);
	assert.deepEqual(actions, [`stop:${firstId}`, `resume:${firstId}`]);
	sendPrompt(app, "browser enabled");
	await app.settle();
	assert.equal(app.sends.at(-1).browser, true);
	sendPrompt(app, "/btw read without browser tools");
	await app.settle();
	assert.equal(app.sends.at(-1).browser, false, "side chats never get browser control");
	const secondId = await startSession(app, "another session");
	assert.equal(browser().uiSessionId, secondId);
	assert.equal(retainedBrowser(firstId).visible, false);
	assert.equal(retainedBrowser(firstId).reporting, false, "the retained background Browser cannot publish the window's active report");
	retainedBrowser(firstId).onPageChanged(firstTab, "https://example.test/next", "Next page");
	await app.settle();
	assert.equal(retainedBrowser(firstId).tabs[0].url, "https://example.test/next");
	assert.equal(browser().tabs.length, 0, "background navigation only updates the owning session");
	browser().onClose();
	await app.settle();
	app.emit({ type: "browser-open", uiSessionId: firstId, url: "https://outside.test/" });
	await app.settle();
	assert.equal(browser(), undefined, "a background session cannot open the current session's pane");
	assert.equal(reports.at(-1).uiSessionId, secondId);
	app.sidebar().onSelect(firstId);
	await app.settle();
	assert.equal(retainedBrowser(firstId).reporting, true);
	assert.equal(retainedBrowser(firstId).visible, false);
	app.key({ key: "b", ctrlKey: true, shiftKey: true });
	await app.settle();
	assert.equal(browser().activeId, firstTab);
	assert.equal(browser().tabs[0].url, "https://example.test/next");
	const decisions = [];
	const card = harness();
	card.row({ tool: { id: "browser-site", kind: "browser", title: "Read example.test", waiting: true, always: "site" }, m: { session: { folder: "C:/project" }, decide: (...args) => decisions.push(args) } });
	button(card, "Allow on this site for this conversation").props.onClick();
	assert.deepEqual(decisions, [["browser-site", "always"]]);
	const local = savedHistory(app).sessions.find((item) => item.id === firstId);
	const cloud = { ...local, id: "cloud-first", environment: "Cloud" };
	const fromCloud = harness(new Map([
		["grok-code.history.v1", JSON.stringify({ sessions: [cloud, local] })],
		["grok-code.settings.v1", JSON.stringify({ browserControl: true })],
	]), "?session=cloud-first");
	await fromCloud.settle();
	assert.equal(fromCloud.model().session.environment, "Cloud");
	fromCloud.emit({ type: "browser-open", uiSessionId: cloud.id, url: "https://example.test/" });
	await fromCloud.settle();
	assert.equal(fromCloud.node((node) => node.type === "BrowserPane"), undefined);
	fromCloud.sidebar().onSelect(local.id);
	await fromCloud.settle();
	fromCloud.emit({ type: "browser-open", uiSessionId: local.id, url: "https://example.test/" });
	await fromCloud.settle();
	assert.equal(fromCloud.node((node) => node.type === "BrowserPane").props.visible, true, "a Local browser event opens the pane after starting in Cloud");
	fromCloud.unmount();
	app.unmount();
	console.log("PASS browser control UI: opt-in disclosure, hidden/current ownership, main/side flags, activity timer, Stop/resume and site approval label");
}

async function checkTerminalSelection() {
	const appWindow = harness();
	await appWindow.settle();
	let nextId = 0;
	const writes = [];
	appWindow.api.terminalOpen = async () => ({ ok: true, id: `tab-${++nextId}` });
	appWindow.api.terminalWrite = async (id, text) => { writes.push([id, text]); return { ok: true }; };
	appWindow.api.devScripts = async () => ({ ok: true, scripts: [{ script: "dev", command: "test server" }] });
	appWindow.model().openLink("https://example.test", { ctrlKey: false, metaKey: false });
	await appWindow.settle();
	button(appWindow, "Browser pane").props.onClick();
	await appWindow.settle();
	const browser = () => appWindow.node((node) => node.type === "BrowserPane").props;
	browser().onStartServer("dev");
	await appWindow.settle();
	await appWindow.model().runInTerminal("Get-Location");
	await appWindow.settle();
	same(writes, [["tab-1", "npm run dev"], ["tab-2", "Get-Location"]], "Run opens a separate terminal from the dev server");
	const terminal = () => appWindow.node((node) => node.type === "TerminalPane").props;
	terminal().onCloseTab("tab-2");
	await appWindow.settle();
	assert.equal(terminal().activeId, "tab-1", "closing the selected terminal selects a remaining tab");
	terminal().onClose();
	await appWindow.settle();
	assert.equal(browser().devServers[0].running, true, "hiding Terminal leaves the dev server running in Browser");
	button(appWindow, "Terminal").props.onClick();
	await appWindow.settle();
	assert.equal(terminal().activeId, "tab-1", "reopening Terminal keeps the dev server tab selected");
	browser().onNewTab();
	await appWindow.settle();
	const closed = browser().activeId;
	browser().onCloseTab(closed);
	await appWindow.settle();
	assert.ok(browser().activeId && browser().activeId !== closed, "closing the selected browser tab selects a remaining tab");
	const tabId = browser().activeId;
	browser().onProblem(tabId, { kind: "console", level: "warning", message: "Failed https://example.test/api?token=message-secret#fragment", url: "https://example.test/?token=page-secret", source: "https://example.test/app.js?token=source-secret#fragment", line: 12, headers: "header-secret", body: "body-secret", cookies: "cookie-secret" });
	await appWindow.settle();
	assert.equal(browser().tabs.find((tab) => tab.id === tabId).problems.length, 1);
	assert.doesNotMatch(JSON.stringify(browser().tabs.find((tab) => tab.id === tabId).problems), /secret|fragment|headers|cookies|body/);
	browser().onPageChanged(tabId, "https://example.test/next", "Next");
	await appWindow.settle();
	assert.equal(browser().tabs.find((tab) => tab.id === tabId).problems.length, 1, "navigation retains the tab's evidence");
	browser().onClose();
	await appWindow.settle();
	button(appWindow, "Browser").props.onClick();
	await appWindow.settle();
	assert.equal(browser().tabs.find((tab) => tab.id === tabId).problems.length, 1, "closing the pane preserves the still-open tab's evidence");
	const prompt = () => appWindow.node((node) => node.type === "textarea" && node.props["aria-label"] === "Prompt");
	prompt().props.onChange({ target: { value: "Please investigate" } });
	await appWindow.settle();
	const sent = appWindow.sends.length;
	const diagnostics = "Browser diagnostics\nPage: https://example.test/next\nCaptured: 2026-11-06T20:00:00.000Z\n\nWARNING console: Failed";
	browser().onDiagnostics(diagnostics);
	await appWindow.settle();
	assert.equal(prompt().props.value, `Please investigate\n\n${diagnostics}`, "diagnostics append to the existing draft");
	assert.equal(appWindow.sends.length, sent, "Add to prompt never sends the evidence");
	browser().onClearProblems(tabId);
	await appWindow.settle();
	assert.equal(browser().tabs.find((tab) => tab.id === tabId).problems.length, 0, "Clear removes the tab's stored diagnostics");
	browser().onProblem(tabId, { kind: "request", message: "HTTP 500", url: "https://example.test/api" });
	await appWindow.settle();
	browser().onCloseTab(tabId);
	await appWindow.settle();
	assert.ok(!browser().tabs.some((tab) => tab.id === tabId), "closing a tab drops its evidence with the tab");
}

// With auto save on, a change App makes saves the open file's pending edit once, before the Files pane's timer would.
async function checkEditorFlush() {
	const saved = (appWindow) => appWindow.writes.map((args) => [args[1], args[2]]);
	const opening = harness();
	await opening.settle();
	opening.editor().onEdit("edit, then open b");
	opening.render();
	opening.editor().onSelectFile("b.txt");
	await opening.settle();
	same(saved(opening), [["a.txt", "edit, then open b"]], "opening another file saves the edit once");

	const switching = harness();
	await switching.settle();
	const firstId = switching.model().session.id;
	const secondId = await startSession(switching, "second");
	switching.sidebar().onSelect(firstId);
	await switching.settle();
	switching.editor().onEdit("edit, then switch");
	switching.render();
	switching.sidebar().onSelect(secondId);
	await switching.settle();
	same(saved(switching), [["a.txt", "edit, then switch"]], "switching session saves the edit once");

	const creating = harness();
	await creating.settle();
	creating.editor().onEdit("edit, then new session");
	creating.render();
	creating.sidebar().onNew();
	await creating.settle();
	same(saved(creating), [["a.txt", "edit, then new session"]], "a new session saves the edit once");

	const closing = harness();
	await closing.settle();
	closing.editor().onEdit("edit, then close with the tab");
	closing.render();
	closing.node((node) => node.props["aria-label"] === "Files" && node.props.className?.startsWith("pane-tab")).props.onClick();
	await closing.settle();
	closing.editor().onEdit("edit, then close with the x");
	closing.render();
	closing.editor().onClose();
	await closing.settle();
	same(saved(closing), [["a.txt", "edit, then close with the tab"], ["a.txt", "edit, then close with the x"]], "closing the Files pane either way saves the edit once");

	const picking = harness();
	await picking.settle();
	picking.editor().onEdit("edit, then pick in the pane");
	picking.render();
	const pane = picking.editor();
	pane.onSave();
	pane.onSelectFile("b.txt");
	await picking.settle();
	same(saved(picking), [["a.txt", "edit, then pick in the pane"]], "the Files pane's own flush and App's flush in one event write the edit once");

	for (const [text, ending] of [["line\r\n".repeat(39) + "last\n", "\r\n"], ["line\nline\r\nlast\n", "\n"], ["line\r\nlast\n", "\n"], ["line\r\nlast\r\n", "\r\n"], ["line\nlast\n", "\n"]]) {
		const editor = harness();
		editor.files["a.txt"].text = text;
		await editor.settle();
		const edit = text.replace(/\r\n/g, "\n").replace("last", "last!");
		editor.editor().onEdit(edit);
		await editor.settle();
		editor.editor().onSave();
		await editor.settle();
		same(saved(editor), [["a.txt", edit.replace(/\n/g, ending)]], "saving a typed edit uses the original file's dominant line ending");
		editor.unmount();
	}
}

async function checkPlanResumeMode() {
	const plan = harness();
	plan.row({ tool: { id: "release-plan", kind: "plan", title: "Plan", detail: "Waiting for your approval", waiting: true, plan: "# Plan" }, m: { resumeMode: "Auto-review" } });
	assert.ok(button(plan, "Approve") && button(plan, "Keep planning") && button(plan, "Abandon"));
	assert.equal(textOf(plan.node((node) => node.type === "p" && node.props.className === "note")), "Approve or Abandon switches this session to Auto-review.");
}

async function checkFirstLaunch() {
	const app = harness(new Map(), "", Date, undefined, true);
	app.api.listCliProjectFolders = async () => ["C:/work/example-project"];
	app.api.readiness = async () => ({ grok: { ok: true, signedIn: true }, git: { ok: true } });
	await app.settle();
	const placeholder = app.model().session.id;
	assert.ok(app.node((node) => node.props.className === "new-page"), "empty storage opens the New session form");
	assert.equal(app.sidebar().sessions.length, 0, "the folderless placeholder is not selectable from the sidebar");
	assert.equal(folderChip(app).props.label, "Choose folder…");
	assert.ok(textOf(app.node((node) => node.props.className === "new-setup-status")).includes("Signed in"));
	assert.ok(worktreeInput(app).props.disabled);
	typePrompt(app, "first session");
	assert.ok(button(app, "Send").props.disabled);
	enterPrompt(app);
	await app.settle();
	assert.equal(app.sends.length, 0, "Enter preserves the draft until a project folder is chosen");
	app.node((node) => node.type === "button" && node.props.title === "C:/work/example-project").props.onClick();
	await app.settle();
	assert.equal(worktreeInput(app).props.disabled, false);
	assert.equal(button(app, "Send").props.disabled, false);
	button(app, "Send").props.onClick();
	await app.settle();
	assert.equal(app.node((node) => node.props.className === "new-page"), undefined);
	assert.equal(app.sends.length, 1);
	assert.equal(app.sends[0].cwd, "C:/work/example-project");
	assert.equal(app.sends[0].text, "first session");
	same(app.sidebar().sessions.map((session) => session.id), [placeholder], "the first send replaces its placeholder without a duplicate sidebar session");
	same(savedHistory(app).sessions.map((session) => session.id), [placeholder], "only that session is saved");
}

async function checkSessionModel() {
	const app = harness();
	await app.settle();
	sendPrompt(app, "session A");
	await app.settle();
	const first = app.model().session.id;
	app.emit({ type: "done", uiSessionId: first, turnId: app.sends.at(-1).turnId });
	await app.settle();
	const second = await startSession(app, "session B");
	app.emit({ type: "done", uiSessionId: second, turnId: app.sends.at(-1).turnId });
	await app.settle();
	app.sidebar().onSelect(first);
	await app.settle();
	app.node((node) => node.props.title === "Model (Ctrl+Shift+I) and effort (Ctrl+Shift+E)").props.onClick();
	app.render();
	button(app, "grok-4.5").props.onClick();
	app.render();
	button(app, "low").props.onClick();
	await app.settle();
	same([app.model().session.model, app.model().session.effort], ["grok-4.5", "low"]);
	app.sidebar().onSelect(second);
	await app.settle();
	assert.ok(app.node((node) => node.props.label === "grok-4.7 · high"), "the other session's model chip keeps its own pair");
	sendPrompt(app, "keep session B's model");
	await app.settle();
	same([app.sends.at(-1).model, app.sends.at(-1).effort], ["grok-4.7", "high"], "changing session A does not change session B's next turn");
	sendPrompt(app, "/btw same model in the side chat");
	await app.settle();
	assert.equal(app.sends.at(-1).uiSessionId, `side-${second}`);
	same([app.sends.at(-1).model, app.sends.at(-1).effort], ["grok-4.7", "high"], "side chat uses its owning session's model and effort");
	const history = savedHistory(app);
	delete history.sessions.find((session) => session.id === second).model;
	delete history.sessions.find((session) => session.id === second).effort;
	app.storage.set("grok-code.history.v1", JSON.stringify(history));
	const legacy = harness(app.storage, `?session=${second}`);
	await legacy.settle();
	assert.ok(legacy.node((node) => node.props.label === "grok-4.5 · low"), "an older session follows app settings until it sends");
	const settingsKey = "grok-code.settings.v1";
	const changeDefault = async (model, effort) => {
		legacy.storage.set(settingsKey, JSON.stringify({ ...JSON.parse(legacy.storage.get(settingsKey)), model, effort }));
		legacy.storageEvent(settingsKey);
		await legacy.settle();
	};
	await changeDefault("grok-4.6", "medium");
	assert.ok(legacy.node((node) => node.props.label === "grok-4.6 · medium"));
	sendPrompt(legacy, "freeze the current choice");
	await legacy.settle();
	same([legacy.sends.at(-1).model, legacy.sends.at(-1).effort], ["grok-4.6", "medium"]);
	same([legacy.model().session.model, legacy.model().session.effort], ["grok-4.6", "medium"]);
	await changeDefault("grok-4.7", "high");
	assert.ok(legacy.node((node) => node.props.label === "grok-4.6 · medium"), "the older session keeps its pair after sending");
}

async function checkSettingsSaveFailure() {
	const app = harness();
	await app.settle();
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	const props = () => app.node((node) => node.type?.name === "SettingsPage").props;
	const view = harness();
	view.settingsView(props());
	const control = (label) => view.nodes(view.render()).find((node) => node.props["aria-label"] === label);
	assert.equal(control("Auto save").props.role, "switch");
	app.storage.failWrites = true;
	control("Appearance").props.onChange({ target: { value: "light" } });
	await app.settle();
	assert.equal(app.notice(), "Settings could not be saved. Changes last until the app closes.");
	assert.equal(props().settings.appearance, "light", "the failed save keeps the choice in memory");
	assert.match(textOf(view.render()), /Not saved\./);
	app.storage.failWrites = false;
	button(view, "Sessions").props.onClick();
	view.render();
	assert.equal(button(view, "Save"), undefined, "branch prefix saves without an explicit button");
	control("Branch prefix").props.onChange({ target: { value: "main" } });
	assert.equal(control("Branch prefix").props["aria-invalid"], true);
	assert.match(textOf(view.render()), /Not saved\. Use 1–40/);
	control("Branch prefix").props.onBlur();
	assert.equal(app.readSettings().branchPrefix, "grok");
	control("Branch prefix").props.onChange({ target: { value: "features" } });
	control("Branch prefix").props.onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault() {} });
	assert.equal(app.readSettings().branchPrefix, "features", "Enter saves a valid prefix immediately");
	assert.ok(view.nodes(view.render()).some((node) => node.props.role === "status" && textOf(node).trim() === "Saved"));
	control("Branch prefix").props.onChange({ target: { value: "work" } });
	control("Branch prefix").props.onBlur();
	assert.equal(app.readSettings().branchPrefix, "work", "leaving the field also saves a valid prefix");
}

function inactiveWorktree(clock = Date, autoArchiveDays = 1) {
	const session = { id: "inactive-worktree", title: "Inactive worktree", project: "project", folder: "C:/project", worktreeFolder: "C:/project/.grok/worktrees/inactive", branch: "grok/inactive", worktree: "inactive", environment: "Local", status: "idle", detail: "Ready", when: "3 days ago", pinned: false, archived: false, source: "desktop", lastActivityAt: clock.now() - 3 * 24 * 60 * 60 * 1000 };
	return harness(new Map([["grok-code.history.v1", JSON.stringify({ sessions: [session] })], ["grok-code.settings.v1", JSON.stringify({ autoArchiveDays })]]), "", clock);
}

async function checkCleanAutoArchive() {
	const app = inactiveWorktree();
	const removals = [];
	let finish;
	let folderExists = true;
	app.api.removeWorktree = (...args) => { removals.push(args); return new Promise((resolve) => { finish = () => { folderExists = false; resolve({ ok: true }); }; }); };
	await app.settle();
	const session = app.model().session;
	same(removals, [[session.folder, session.worktreeFolder, { force: false, branch: session.branch, autoArchive: true }]]);
	app.sidebar().onRename(session.id, "Renamed while removing");
	await app.settle();
	assert.equal(removals.length, 1, "rerendering does not start a second worktree removal");
	finish();
	await app.settle();
	assert.equal(folderExists, false, "a clean worktree folder is removed");
	assert.equal(savedHistory(app).sessions[0].archived, true);
	assert.deepEqual(app.confirms, [], "automatic archiving never prompts");
}

async function checkDirtyAutoArchive() {
	const app = inactiveWorktree();
	const removals = [];
	let folderExists = true;
	app.api.removeWorktree = async (...args) => { removals.push(args); if (args[2].force) { folderExists = false; } return { ok: false, dirty: true, error: "This worktree is not on its session branch." }; };
	await app.settle();
	const session = app.model().session;
	same(removals, [[session.folder, session.worktreeFolder, { force: false, branch: session.branch, autoArchive: true }]]);
	assert.equal(folderExists, true, "dirty worktree files stay on disk");
	assert.equal(savedHistory(app).sessions[0].archived, true, "a retained dirty worktree still archives");
	assert.match(app.notice(), /not on its session branch.*stays on disk/);
	assert.deepEqual(app.confirms, [], "dirty automatic archiving does not ask to force removal");
}

async function checkBusyAutoArchive() {
	let now = Date.now();
	class Clock extends Date { static now() { return now; } }
	const app = inactiveWorktree(Clock, 0);
	const removals = [];
	app.api.removeWorktree = async (...args) => { removals.push(args); return { ok: true }; };
	await app.settle();
	sendPrompt(app, "long-running task");
	await app.settle();
	now += 2 * 24 * 60 * 60 * 1000;
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	app.node((node) => node.type?.name === "SettingsPage").props.onChange({ autoArchiveDays: 1 });
	await app.settle();
	assert.equal(app.model().busy, true);
	assert.equal(savedHistory(app).sessions[0].archived, false, "a running session older than the cutoff stays unarchived");
	assert.deepEqual(removals, [], "a running session's worktree is untouched");
	assert.deepEqual(app.confirms, []);
}

async function checkTurnStartsDuringAutoArchive() {
	const app = inactiveWorktree();
	let finishRemoval;
	app.api.removeWorktree = () => new Promise((resolve) => { finishRemoval = resolve; });
	await app.settle();
	sendPrompt(app, "Start work while the sweep is checking the worktree");
	await app.settle();
	assert.equal(app.sends.length, 1);
	finishRemoval({ ok: false, skipped: true });
	await app.settle();
	assert.equal(app.model().busy, true);
	assert.equal(savedHistory(app).sessions[0].archived, false, "skipped worktree removal leaves the active session unarchived");
}

async function checkUnarchiveAfterAutoArchive() {
	const app = inactiveWorktree();
	const removals = [];
	app.api.removeWorktree = async (...args) => { removals.push(args); return { ok: true }; };
	app.api.restoreWorktree = async () => ({ ok: true });
	await app.settle();
	const id = savedHistory(app).sessions[0].id;
	assert.equal(savedHistory(app).sessions[0].archived, true);
	app.sidebar().onArchive(id);
	await app.settle();
	assert.equal(savedHistory(app).sessions[0].archived, false, "Unarchive is not undone by automatic archiving");
	assert.equal(removals.length, 1, "the restored worktree is not removed again");
	const relaunch = harness(app.storage);
	relaunch.api.removeWorktree = async (...args) => { removals.push(args); return { ok: true }; };
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).sessions[0].archived, false, "Unarchive counts as activity, so the next launch keeps it");
	assert.equal(removals.length, 1);
}

async function checkSettingsBlocksShortcuts() {
	const app = harness();
	await app.settle();
	sendPrompt(app, "session A");
	await app.settle();
	const first = app.model().session.id;
	app.emit({ type: "done", uiSessionId: first, turnId: app.sends.at(-1).turnId });
	await app.settle();
	const second = await startSession(app, "session B");
	assert.equal(app.model().session.id, second);
	const body = app.document.body = {};
	const opener = { isConnected: true, focus() { app.document.activeElement = this; } };
	app.document.activeElement = opener;
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	assert.equal(app.sidebar().inert, true);
	assert.equal(app.node((node) => node.props.className === "workspace").props.inert, true);
	app.key({ key: "Tab", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().session.id, second, "Ctrl+Tab does not switch the session hidden behind Settings");
	const findTick = app.model().findTick;
	app.key({ key: "f", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().findTick, findTick, "Ctrl+F does not open conversation search behind Settings");
	let menuClicks = 0;
	let prevented = 0;
	app.document.querySelector = (selector) => selector === ".pop" ? {} : null;
	app.document.querySelectorAll = (selector) => selector === ".pop button:not(:disabled)" ? [{ click: () => { menuClicks++; } }] : [];
	const menuKey = { key: "1", preventDefault() { prevented++; } };
	app.key(menuKey);
	assert.equal(menuClicks, 0, "a digit cannot click an open menu behind Settings");
	assert.equal(prevented, 0, "the digit is available to the Settings field");
	app.document.activeElement = body;
	app.key({ key: "Escape", target: { closest: (selector) => selector === ".side-col, .session-rail" } });
	await app.settle();
	assert.equal(app.node((node) => node.type?.name === "SettingsPage"), undefined, "Escape from the rail closes Settings");
	assert.equal(app.document.activeElement, opener, "Settings restores focus to its opener");
	assert.equal(app.sidebar().inert, false);
	app.key(menuKey);
	assert.equal(menuClicks, 1, "the same digit still selects the menu item outside Settings");
	assert.equal(prevented, 1);
	app.key({ key: "Tab", ctrlKey: true });
	await app.settle();
	assert.notEqual(app.model().session.id, second, "with Settings closed Ctrl+Tab switches again");

	app.key({ key: "/", ctrlKey: true });
	await app.settle();
	const shortcuts = app.node((node) => node.props["aria-label"] === "Keyboard shortcuts" && node.props.role === "dialog");
	assert.equal(shortcuts.props.tabIndex, -1, "the sheet can receive programmatic focus");
	const sheet = { focus() { app.document.activeElement = this; } };
	shortcuts.props.ref(sheet);
	assert.equal(app.document.activeElement, sheet, "opening shortcuts focuses the dialog");
	app.key({ key: "Escape" });
	await app.settle();
	app.key({ key: "/", code: "Digit7", shiftKey: true, ctrlKey: true });
	await app.settle();
	assert.ok(app.node((node) => node.props["aria-label"] === "Keyboard shortcuts"), "a shifted slash opens the shortcut sheet");
	app.key({ key: "Escape" });
	await app.settle();
	app.key({ key: ";", code: "Comma", shiftKey: true, ctrlKey: true });
	await app.settle();
	assert.ok(app.node((node) => node.props["aria-label"] === "Side chat"), "a shifted semicolon opens side chat");
	app.key({ key: "b", shiftKey: true, ctrlKey: true });
	await app.settle();
	assert.equal(button(app, "Browser").props["aria-pressed"], true);
	app.key({ key: "\\", code: "Minus", ctrlKey: true, altKey: true, getModifierState: () => true, preventDefault() { assert.fail("ordinary AltGr text is not a shortcut"); } });
	assert.equal(button(app, "Browser").props["aria-pressed"], true);
	app.key({ key: "#", code: "Backslash", ctrlKey: true });
	await app.settle();
	assert.equal(button(app, "Browser").props["aria-pressed"], false, "the physical Backslash key closes the pane without AltGr");
}

async function checkUiConfiguration() {
	const key = "grok-code.settings.v1";
	const initial = { id: "original", name: "Original", values: { "chat.reply.size": 19 } };
	const storage = new Map([[key, JSON.stringify({ appearance: "light", uiConfigs: [initial], activeUiConfig: initial.id })]]);
	const app = harness(storage);
	await app.settle();
	assert.match(app.document.getElementById("ui-config").textContent, /font-size: 19px/);
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	const settingsPage = app.node((node) => node.type?.name === "SettingsPage").props;
	const view = harness();
	const nav = view.settingsView(settingsPage).props.children[0].props.children.find(Array.isArray).map(textOf);
	same(nav.slice(-2), ["UI Configuration", "About"]);
	settingsPage.onPreviewTheme("dark");
	await app.settle();
	assert.equal(app.document.documentElement.getAttribute("data-theme"), "dark");
	storage.set(key, JSON.stringify({ ...JSON.parse(storage.get(key)), appearance: "system" }));
	app.storageEvent(key);
	await app.settle();
	assert.equal(app.document.documentElement.getAttribute("data-theme"), "dark");
	settingsPage.onPreviewTheme(null);
	await app.settle();
	assert.equal(app.document.documentElement.getAttribute("data-theme"), undefined);
	app.emit({ type: "ui-default" });
	await app.settle();
	assert.equal(app.document.getElementById("ui-config").textContent, "");
	assert.equal(JSON.parse(storage.get(key)).activeUiConfig, "");
	same(JSON.parse(storage.get(key)).uiConfigs, [initial]);
	const stale = harness(new Map([[key, JSON.stringify({ activeUiConfig: "gone", uiConfigs: "bad" })]]));
	assert.equal(stale.readSettings().activeUiConfig, "");
	same(stale.readSettings().uiConfigs, []);

	let settings = { ...view.readSettings(), uiConfigs: [initial], activeUiConfig: initial.id };
	let succeeds = true;
	const patches = [];
	const themes = [];
	const peeks = [];
	const panel = harness();
	const callbacks = {
		onChange(patch) { patches.push(patch); settings = { ...settings, ...patch }; return succeeds; },
		onPreviewTheme(theme) { themes.push(theme); },
		onPeek(show) { peeks.push(show); },
	};
	const show = (remount) => panel.uiConfigView({ settings, previewTheme: "dark", ...callbacks }, remount);
	const click = (label) => button(panel, label).props.onClick();
	const input = (id) => panel.node((node) => node.props.id === id);
	const change = (node, value) => node.props.onChange({ currentTarget: { value } });
	const submit = () => panel.node((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
	show();
	click("New…");
	show();
	for (const name of ["", "original", "Default"]) {
		change(input("ui-config-name"), name);
		show();
		submit();
		show();
		assert.ok(panel.node((node) => node.props.role === "alert"), `invalid name ${name} shows an error`);
	}
	assert.equal(patches.length, 0);
	change(input("ui-config-name"), "My UI");
	show();
	submit();
	show();
	const created = settings.activeUiConfig;
	assert.notEqual(created, initial.id);
	same(settings.uiConfigs.at(-1).values, initial.values, "New copies the selected configuration");
	click("Rename…");
	show();
	change(input("ui-config-name"), "My revised UI");
	show();
	submit();
	show();
	assert.equal(settings.uiConfigs.at(-1).name, "My revised UI");
	same(settings.uiConfigs.at(-1).values, initial.values);

	const open = (label) => {
		panel.node((node) => node.type === "details" && textOf(node.props.children[0]).startsWith(label)).props.onToggle({ currentTarget: { open: true } });
		show();
	};
	const openReply = () => { open("Chat"); open("Grok's reply text"); };
	openReply();
	const control = (label) => panel.node((node) => node.type?.name === "UiValueControl" && node.props.control.label === label);
	const field = (view) => view.node((node) => node.type === "input");
	const number = harness();
	const initialSize = control("Text size");
	number.uiControlView(initialSize);
	change(field(number), "999");
	number.render();
	assert.equal(field(number).props.value, "999");
	assert.equal(field(number).props["aria-invalid"], true);
	assert.equal(settings.uiConfigs.at(-1).values["chat.reply.size"], 19);
	succeeds = false;
	change(field(number), "25");
	show();
	assert.equal(settings.uiConfigs.at(-1).values["chat.reply.size"], 25);
	assert.ok(textOf(panel.render()).includes("Not saved."));
	show(true);
	assert.ok(textOf(panel.render()).includes("Not saved."), "the failure stays visible after reopening the panel");
	succeeds = true;
	click("Try again");
	show();
	same(patches.at(-1).uiConfigs, settings.uiConfigs);
	assert.ok(textOf(panel.render()).includes("Saved"));
	show(true);
	openReply();
	change(input("ui-config-choice"), "");
	show();
	assert.equal(control("Text size").props.input.disabled, true);
	change(input("ui-config-choice"), created);
	show();
	const beforeRevert = control("Text size").key;
	click("Revert");
	show();
	assert.equal(control("Text size").props.stored, 19);
	assert.notEqual(control("Text size").key, beforeRevert, "Revert remounts the field over an invalid draft");
	const beforeReset = control("Text size").key;
	panel.node((node) => node.props["aria-label"] === "Reset Chat: Grok's reply text: Text size").props.onClick();
	show();
	assert.equal(control("Text size").props.stored, undefined);
	assert.notEqual(control("Text size").key, beforeReset, "Reset remounts the field over an invalid draft");
	const chooseFont = (value) => { const node = control("Font"); change(node.type(node.props), value); show(); };
	chooseFont("arial");
	assert.equal(settings.uiConfigs.at(-1).values["chat.reply.font"], "arial");
	const beforeDefault = control("Font").key;
	chooseFont("");
	assert.ok(!Object.hasOwn(settings.uiConfigs.at(-1).values, "chat.reply.font"), "choosing Default removes the value");
	assert.equal(control("Font").key, beforeDefault, "choosing Default keeps the select mounted, so it keeps keyboard focus");
	const fontChoices = (stored) => {
		const node = control("Font");
		return [node.type({ ...node.props, stored }).props.children].flat(Infinity).filter(Boolean);
	};
	assert.equal(control("Font").props.installed, null, "without the font API the list is empty");
	assert.equal(fontChoices().length, 11, "without the font API Font offers Default and the standard fonts");
	assert.ok(!textOf(panel.render()).includes("restart the app"), "without the font API the panel doesn't promise installed fonts");
	assert.equal(fontChoices("local:Gone").at(-1).props.children, "Gone", "without the font API a saved font stays selected");
	panel.window.queryLocalFonts = () => ({ then(run) { run([{ family: "Hasklig" }, { family: "Fira Code" }]); return { catch() {} }; } });
	show(true);
	openReply();
	same(control("Font").props.installed, ["Fira Code", "Hasklig"]);
	assert.ok(textOf(panel.render()).includes("restart the app"));
	const installedGroup = fontChoices().at(-1);
	assert.equal(installedGroup.props.label, "Installed on this computer");
	same(installedGroup.props.children.map((option) => option.props.value), ["local:Fira Code", "local:Hasklig"]);
	chooseFont("local:Fira Code");
	assert.equal(settings.uiConfigs.at(-1).values["chat.reply.font"], "local:Fira Code");
	assert.equal(fontChoices("local:Fira Code").length, 12, "an installed font that is on this computer isn't listed twice");
	const missingFont = fontChoices("local:Gone").at(-2);
	assert.equal(missingFont.props.value, "local:Gone", "a saved font missing from this computer stays selected");
	assert.equal(missingFont.props.children, "Gone (not on this computer)");
	chooseFont("");
	delete panel.window.queryLocalFonts;
	show(true);
	openReply();

	open("Whole app");
	open("Fonts and sizes");
	const scale = harness();
	scale.uiControlView(control("App text size (%)"));
	change(field(scale), "79");
	assert.ok(!Object.hasOwn(settings.uiConfigs.at(-1).values, "app.fonts.textScale"), "a size outside the range is not saved");
	change(field(scale), "125");
	assert.equal(settings.uiConfigs.at(-1).values["app.fonts.textScale"], 125);
	show();
	panel.node((node) => node.props["aria-label"] === "Reset Whole app: Fonts and sizes: App text size (%)").props.onClick();
	show();
	openReply();

	const color = harness();
	const colorEvents = new Map();
	const picker = { value: "#325476", addEventListener: (event, listener) => colorEvents.set(event, listener), removeEventListener: (event) => colorEvents.delete(event) };
	color.uiControlView(control("Text color"), picker);
	const beforeColor = patches.length;
	colorEvents.get("change")();
	assert.equal(patches.length, beforeColor, "closing the color picker without input saves nothing");
	field(color).props.onInput({ currentTarget: picker });
	assert.equal(patches.length, beforeColor, "the input event only previews the color");
	colorEvents.get("change")();
	show();
	assert.equal(settings.uiConfigs.at(-1).values["chat.reply.color.dark"], "#325476");
	const peek = button(panel, "Hold to see the app").props;
	peek.onPointerDown({ button: 0, pointerId: 1, currentTarget: { setPointerCapture() {} } });
	assert.equal(peeks.at(-1), true);
	peek.onPointerCancel();
	assert.equal(peeks.at(-1), false);
	peek.onKeyDown({ key: " ", preventDefault() {} });
	panel.windowEvent("blur");
	assert.equal(peeks.at(-1), false);
	const confirmations = [];
	const clearConfirm = panel.confirmModule().setConfirmHost((pending) => confirmations.push(pending));
	click("Delete");
	assert.match(confirmations[0].title, /My revised UI/);
	confirmations[0].resolve(true);
	await new Promise((resolve) => setImmediate(resolve));
	clearConfirm();
	show();
	assert.equal(settings.activeUiConfig, "");
	same(settings.uiConfigs, [initial]);
	panel.unmount();
	assert.equal(peeks.at(-1), false);
	assert.equal(themes.at(-1), null);
	app.unmount();
	console.log("PASS UI configuration: navigation, persistence, recovery, theme ownership, controls, reset and Revert");
}

async function checkRememberedAccount() {
	const first = harness();
	await first.settle();
	assert.equal(first.sidebar().account, undefined, "with nothing remembered the account is unknown until Grok starts");
	first.emit({ type: "account", account: { email: "someone@example.com", plan: "SuperGrok", team: "", version: "1.0.70" } });
	await first.settle();
	const relaunch = harness(first.storage);
	relaunch.api.account = async () => undefined;
	await relaunch.settle();
	assert.equal(relaunch.sidebar().account?.email, "someone@example.com", "the last account shows at launch, before Grok starts");
	relaunch.emit({ type: "account", account: null });
	await relaunch.settle();
	const afterSignOut = harness(relaunch.storage);
	await afterSignOut.settle();
	assert.equal(afterSignOut.sidebar().account, null, "a sign-out is remembered too");
}

async function composerWindow(timers) {
	const app = harness(new Map(), "", Date, timers);
	await app.settle();
	sendPrompt(app, "Saved session");
	await app.settle();
	app.emit({ type: "done", uiSessionId: app.model().session.id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	return app;
}

async function checkPrWatch() {
	const seed = await composerWindow(controlledTimers());
	const baseline = savedHistory(seed);
	const created = harness(new Map(seed.storage), "", Date, controlledTimers());
	created.api.prCreate = async () => ({ ok: true, url: "https://github.com/owner/repo/pull/12" });
	await created.settle();
	await created.node((node) => node.type === "SessionRail").props.onCreatePr();
	await created.settle();
	const started = created.sidebar().sessions[0].prWatch;
	assert.equal(started.number, 12);
	same(started.failing, []);
	assert.ok(started.seenAt);
	created.pickedFolders.push("C:/other-repository");
	created.node((node) => node.props.label === created.model().session.project).props.onClick();
	created.render();
	button(created, "Choose a folder").props.onClick();
	await created.settle();
	assert.equal(created.model().session.prWatch, undefined, "choosing another folder clears the old repository's PR watch");
	const status = { ok: true, pr: { number: 12, state: "OPEN", checks: [{ name: "build", state: "fail" }], feedback: [{ at: "2026-11-06T01:00:00Z", who: "octocat", kind: "review" }] } };
	const adoptTimers = controlledTimers();
	const adopted = harness(new Map(seed.storage), "", Date, adoptTimers);
	adopted.api.prStatus = async () => status;
	await adopted.settle();
	const quiet = adopted.sidebar().sessions[0].prWatch;
	same(quiet.failing, ["build"]);
	assert.equal(quiet.seenAt, "2026-11-06T01:00:00Z");
	adoptTimers.advance(10000);
	await adopted.settle();
	assert.equal(adopted.sidebar().sessions[0].prWatch.alert, undefined, "an existing PR starts without alerts for old feedback or failures");
	assert.equal(adopted.notifications.length, 0);
	adopted.unmount();
	const watched = { ...baseline.sessions[0], id: "watched", prWatch: { number: 12, failing: [], seenAt: "2026-11-06T00:00:00Z" } };
	const history = { ...baseline, sessions: [...baseline.sessions, watched] };
	const storage = new Map([["grok-code.history.v1", JSON.stringify(history)]]);
	const timers = controlledTimers();
	const app = harness(storage, "", Date, timers);
	let next = status;
	const polls = [];
	app.api.prStatus = async (folder, number) => { if (number) { polls.push([folder, number]); } return number ? next : { ok: true, pr: null }; };
	await app.settle();
	timers.advance(9999);
	await app.settle();
	assert.equal(polls.length, 0);
	timers.advance(1);
	await app.settle();
	same(polls[0], [watched.folder, 12]);
	const alert = app.sidebar().sessions.find((item) => item.id === watched.id).prWatch.alert;
	same(alert, { failed: ["build"], feedback: 1, from: ["octocat"] });
	assert.equal(app.sidebar().sessions.find((item) => item.id === watched.id).unread, true);
	assert.equal(app.notifications.length, 1, "background PR feedback notifies");
	assert.equal(app.notifications[0].body, "PR #12: CI failed (build) and 1 new review comment from octocat.");
	assert.equal(app.sends.length, 0, "polling never starts a Grok turn");
	app.sidebar().onSelect(watched.id);
	await app.settle();
	button(app, "Ask Grok to fix").props.onClick();
	await app.settle();
	assert.equal(app.sends.at(-1).text, app.prFixPrompt(12, alert));
	assert.equal(app.model().session.prWatch.alert, undefined, "sending the explicit fix request clears only the alert");
	assert.equal(app.model().session.prWatch.number, 12);
	next = { ...status, pr: { ...status.pr, checks: [] } };
	timers.advance(180000);
	await app.settle();
	next = status;
	timers.advance(180000);
	await app.settle();
	const sends = app.sends.length;
	button(app, "Dismiss pull request alert").props.onClick();
	await app.settle();
	assert.equal(app.sends.length, sends, "dismissing a PR alert sends nothing");
	assert.equal(app.model().session.prWatch.alert, undefined);
	next = { ...status, pr: { ...status.pr, state: "MERGED" } };
	timers.advance(180000);
	await app.settle();
	assert.equal(app.model().session.prWatch, undefined);
	app.unmount();
	const offTimers = controlledTimers();
	const off = harness(new Map([["grok-code.history.v1", JSON.stringify(history)], ["grok-code.settings.v1", JSON.stringify({ notifyPr: "off" })]]), "", Date, offTimers);
	off.api.prStatus = async (_folder, number) => number ? status : { ok: true, pr: null };
	await off.settle();
	offTimers.advance(10000);
	await off.settle();
	assert.equal(off.notifications.length, 0, "notifyPr off suppresses the banner");
	assert.ok(off.sidebar().sessions.find((item) => item.id === watched.id).prWatch.alert, "turning off banners retains the fix alert");
	off.key({ key: ",", ctrlKey: true });
	await off.settle();
	const settings = off.node((node) => node.type.name === "SettingsPage");
	const view = harness();
	const settingsTree = view.settingsView({ ...settings.props, initialTab: "notifications" });
	assert.ok(textOf(settingsTree).includes("Pull requests"));
	assert.ok(textOf(settingsTree).includes("When CI fails or new review feedback arrives on a pull request a session opened."));
	off.unmount();
	console.log("PASS PR watch renderer: create/adopt, delayed polling, background unread/banner, explicit fix/dismiss, merge and notification setting");
}

async function checkPrWatchWindows() {
	const seed = await composerWindow(controlledTimers());
	const firstTimers = controlledTimers();
	const secondTimers = controlledTimers();
	const first = harness(seed.storage, "", Date, firstTimers);
	const second = harness(seed.storage, "", Date, secondTimers);
	const polled = [];
	const status = { ok: true, pr: { number: 12, state: "OPEN", checks: [{ name: "build", state: "fail" }], feedback: [] } };
	first.api.prStatus = async (_folder, number) => { if (number) { polled.push("first"); } return number ? status : { ok: true, pr: null }; };
	second.api.prStatus = async (_folder, number) => { if (number) { polled.push("second"); } return number ? status : { ok: true, pr: null }; };
	second.api.prCreate = async () => ({ ok: true, url: "https://github.com/owner/repo/pull/12" });
	await first.settle();
	await second.settle();
	const id = await startSession(second, "Watch a new session in the other window");
	second.emit({ type: "done", uiSessionId: id, turnId: second.sends.at(-1).turnId });
	await second.settle();
	await second.node((node) => node.type === "SessionRail").props.onCreatePr();
	await second.settle();
	const chat = JSON.stringify(savedHistory(second).extraChats[id]);
	first.storageEvent("grok-code.history.v1");
	await first.settle();
	assert.equal(first.sidebar().sessions.find((item) => item.id === id).prWatch.number, 12, "the polling window adopts a watch created in a new session in another window");
	assert.equal(JSON.stringify(savedHistory(first).extraChats[id]), chat, "watch synchronization preserves the other window's conversation");
	firstTimers.advance(10000);
	secondTimers.advance(10000);
	await first.settle();
	await second.settle();
	assert.deepEqual(polled, ["first"], "only the window holding the lifetime lock polls");
	second.storageEvent("grok-code.history.v1");
	await second.settle();
	assert.ok(button(second, "Ask Grok to fix"), "the alert reaches the session's other window");
	button(second, "Dismiss pull request alert").props.onClick();
	await second.settle();
	first.storageEvent("grok-code.history.v1");
	await first.settle();
	assert.equal(first.sidebar().sessions.find((item) => item.id === id).prWatch.alert, undefined, "dismissal reaches the polling window");
	firstTimers.advance(180000);
	await first.settle();
	assert.equal(first.notifications.length, 1, "a quiet poll does not resurrect the dismissed alert");
	first.unmount();
	await second.settle();
	secondTimers.advance(10000);
	await second.settle();
	assert.equal(polled.at(-1), "second", "a waiting window takes over after the polling window unmounts");
	const removed = savedHistory(second);
	removed.sessions = removed.sessions.filter((item) => item.id !== id);
	removed.deleted.push(id);
	second.storage.set("grok-code.history.v1", JSON.stringify(removed));
	second.storageEvent("grok-code.history.v1");
	await second.settle();
	assert.equal(second.sidebar().sessions.find((item) => item.id === id).prWatch, undefined, "a deletion from another window clears the retained watch");
	const count = polled.length;
	secondTimers.advance(180000);
	await second.settle();
	assert.equal(polled.length, count, "a deleted session is no longer polled");
	second.unmount();
	console.log("PASS PR watch windows: lifetime lock, new-session watch/history sync, alert dismissal sync and takeover");
}

async function checkComposerDraftRelaunch() {
	const app = await composerWindow();
	const id = app.model().session.id;
	app.node((node) => node.props["aria-label"] === "Prompt").props.onChange({ target: { value: "Unsent text\nwith a second line" } });
	assert.equal((await app.beforeUnload()).prevented, false, "close flushes the latest message text even before the next render");
	assert.equal(savedHistory(app).composerDrafts[id], "Unsent text\nwith a second line");
	const relaunch = harness(app.storage);
	await relaunch.settle();
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "Unsent text\nwith a second line");
	assert.equal(relaunch.sends.length, 0, "restored text never sends itself");
	typePrompt(relaunch, "A newer unsaved message");
	relaunch.storage.failWrites = true;
	assert.equal((await relaunch.beforeUnload()).prevented, true, "failed history writes protect message drafts on close");
	relaunch.storage.failWrites = false;
	assert.equal((await relaunch.beforeUnload()).prevented, false);
}

async function checkNewSessionDraftRelaunch() {
	const app = await composerWindow();
	const original = app.model().session.id;
	app.sidebar().onNewIn({ folder: "C:/draft-project", project: "draft-project", branch: "feature/draft", worktree: "draft-project", environment: "Local" });
	await app.settle();
	const draftId = app.model().session.id;
	const worktree = () => worktreeInput(app);
	worktree().props.onChange({ target: { checked: true } });
	app.render();
	typePrompt(app, "Do this later");
	await app.beforeUnload();
	const relaunch = harness(app.storage);
	await relaunch.settle();
	assert.ok(relaunch.node((node) => node.props.className === "new-page"));
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "Do this later");
	assert.equal(folderChip(relaunch).props.title, "C:/draft-project");
	assert.equal(relaunch.model().session.branch, "feature/draft");
	assert.equal(worktreeInput(relaunch).props.checked, true);
	assert.equal(relaunch.sidebar().sessions.some((item) => item.id === draftId), false, "the restored form is not a sidebar session");
	assert.equal(relaunch.sends.length, 0);
	const otherWindow = harness(app.storage);
	await otherWindow.settle();
	assert.equal(otherWindow.node((node) => node.props["aria-label"] === "Prompt").props.value, "Do this later");
	const restoredIds = [draftId, relaunch.model().session.id, otherWindow.model().session.id];
	assert.equal(new Set(restoredIds).size, 3, "each restore gets a fresh id, so two windows cannot send into one session");
	relaunch.sidebar().onSelect(original);
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).newSessionDraft?.text, "Do this later", "looking at another session keeps the form");
	relaunch.sidebar().onNew();
	await relaunch.settle();
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "Do this later");
	assert.equal(worktreeInput(relaunch).props.checked, true, "the kept form keeps its worktree choice");
	typePrompt(relaunch, "");
	await relaunch.settle();
	relaunch.sidebar().onSelect(original);
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).newSessionDraft, undefined, "a form left empty clears its saved slot");
	const first = harness();
	await first.settle();
	typePrompt(first, "First-launch draft");
	await first.beforeUnload();
	const firstRelaunch = harness(first.storage);
	await firstRelaunch.settle();
	assert.equal(firstRelaunch.sidebar().sessions.length, 0, "a first-launch placeholder is not restored as a real session");
	assert.equal(firstRelaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "First-launch draft");
	sendPrompt(firstRelaunch, "First-launch draft");
	await firstRelaunch.settle();
	assert.equal(firstRelaunch.sidebar().sessions.length, 1);
	assert.equal(savedHistory(firstRelaunch).newSessionDraft, undefined, "sending the form clears its saved slot");
}

async function checkNewSessionAttachmentDraftRelaunch() {
	const historyKey = "grok-code.history.v1";
	for (const raw of [' { "sessions": [], "attachments": { "draft": ["C:/shots/original-paste.png"] } } ', "{malformed history"]) {
		const backup = '{ "sessions": [], "attachments": { "backup": ["C:/shots/backup-only.png"] } }';
		const storage = new Map([[historyKey, raw], ["grok-code.history.bad", backup]]);
		const app = harness(storage);
		const pruned = [];
		app.api.prunePastedImages = (snapshot, damagedBackup) => pruned.push({ snapshot, backup: damagedBackup, savedAtCall: storage.get(historyKey), writesAtCall: app.historyWrites.length });
		app.render();
		await app.settle();
		assert.notEqual(storage.get(historyKey), raw, "the first save replaces the original history snapshot");
		same(pruned, [{ snapshot: raw, backup, savedAtCall: raw, writesAtCall: 0 }], "startup cleanup receives the original history and damaged backup once, before persistence, including malformed input");
		app.unmount();
	}
	for (const text of ["", "Image draft"]) {
		const app = harness();
		await app.settle();
		const first = "C:/shots/first-paste.png";
		const second = "C:/shots/second-paste.png";
		typePrompt(app, text);
		stageAttachments(app, [first]);
		await app.settle();
		same(savedHistory(app).newSessionDraft?.attachments, [first], "pending form attachments save even without message text");
		stageAttachments(app, [second]);
		await app.settle();
		same(savedHistory(app).newSessionDraft?.attachments, [first, second], "changing only attachments updates the saved form");
		app.node((node) => node.props["aria-label"] === "Remove first-paste.png").props.onClick();
		await app.settle();
		same(savedHistory(app).newSessionDraft?.attachments, [second]);
		assert.equal((await app.beforeUnload()).prevented, false);
		const relaunch = harness(app.storage);
		await relaunch.settle();
		assert.ok(relaunch.node((node) => node.props.className === "new-page"));
		assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, text);
		assert.ok(relaunch.node((node) => node.props.className === "attach-chip" && node.props.title === second), "the restored form has its pasted image");
		assert.equal(relaunch.sends.length, 0);
		sendPrompt(relaunch, "Send restored image");
		await relaunch.settle();
		same(relaunch.sends.at(-1).attachments, [second], "the restored image is sent with the first message");
		assert.equal(savedHistory(relaunch).newSessionDraft, undefined);
		app.unmount();
		relaunch.unmount();
	}
}

async function checkReplacedNewSessionDraft() {
	for (const kept of [false, true]) {
		const timers = controlledTimers();
		const first = await composerWindow(timers);
		const id = first.model().session.id;
		first.sidebar().onNew();
		await first.settle();
		typePrompt(first, "First window's original draft");
		timers.advance(500);
		await first.settle();
		typePrompt(first, "First window's draft");
		assert.equal((await first.beforeUnload()).prevented, false, "the owner of the saved draft can close");
		assert.equal(savedHistory(first).newSessionDraft.text, "First window's draft", "the owner's latest edit is saved on close");
		if (kept) { first.sidebar().onSelect(id); await first.settle(); }

		const otherTimers = controlledTimers();
		const other = harness(first.storage, `?session=${id}`, Date, otherTimers);
		await other.settle();
		other.sidebar().onNew();
		await other.settle();
		typePrompt(other, "Second window's draft");
		otherTimers.advance(500);
		await other.settle();
		const otherDraft = savedHistory(other).newSessionDraft;
		assert.equal(otherDraft.text, "Second window's draft");

		let quota = !kept;
		let refusedWrites = 0;
		const set = first.storage.set.bind(first.storage);
		first.storage.set = (name, value) => {
			if (quota && name === "grok-code.history.v1" && JSON.parse(value).newSessionDraft?.text === otherDraft.text) {
				refusedWrites++;
				throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			}
			return set(name, value);
		};
		if (!kept) { typePrompt(first, "First window's newest text"); }
		assert.equal((await first.beforeUnload()).prevented, true, "a pending or kept draft displaced by another window warns at close");
		timers.advance(500);
		await first.settle();
		same(savedHistory(first).newSessionDraft, otherDraft, "canceling the close and its pending save preserve the other draft");
		if (quota) { assert.ok(refusedWrites >= 2, "both the failed close save and its queued retry tried to keep the other draft"); }
		quota = false;
		assert.equal((await first.beforeUnload()).prevented, true, "the repeat unload used for Close anyway still protects the other draft");
		same(savedHistory(first).newSessionDraft, otherDraft);
		if (kept) { first.sidebar().onNew(); await first.settle(); }
		assert.equal(first.node((node) => node.props["aria-label"] === "Prompt").props.value, kept ? "First window's draft" : "First window's newest text");
		typePrompt(first, "");
		assert.equal((await first.beforeUnload()).prevented, false, "there is no close warning when this window has no unsent text");
		same(savedHistory(first).newSessionDraft, otherDraft, "clearing this window's form does not clear another window's saved draft at close");
		first.unmount();
		other.unmount();
	}
}

async function checkInvalidHistoryBackup() {
	const key = "grok-code.history.v1";
	const backup = "grok-code.history.bad";
	for (const [raw, invalid, quota] of [["{truncated", true, false], ['{"sessions":[{"id":"damaged"}]}', true, false], ['{"sessions":[]}', false, false], ["{broken", true, true]]) {
		const storage = new Map([[key, raw], [backup, "Previous backup"]]);
		const writes = [];
		const set = storage.set.bind(storage);
		storage.set = (name, value) => {
			writes.push(name);
			if (quota && name === backup) { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); }
			return set(name, value);
		};
		const app = harness(storage);
		await app.settle();
		assert.ok(writes.includes(key), "the app starts and saves replacement history");
		assert.deepEqual(savedHistory(app).sessions, []);
		assert.equal(storage.get(backup), invalid && !quota ? raw : "Previous backup", "only a damaged history can replace the backup");
		if (invalid) { assert.ok(writes.indexOf(backup) < writes.indexOf(key) && writes.includes(backup), "backup is attempted before history is overwritten"); }
		if (quota) { assert.equal(app.notice(), "The damaged chat history could not be backed up."); }
		const unreadable = "Saved chat history could not be read. The damaged copy was kept.";
		if (invalid && !quota) { assert.ok(app.notices().includes(unreadable), "damaged history tells the user the copy was kept"); }
		else { assert.ok(!app.notices().includes(unreadable), "a readable history, or a backup that could not be written, does not add the kept-copy notice"); }
		app.unmount();
	}
}

async function checkKeptNewSessionForm() {
	const app = await composerWindow();
	const original = app.model().session.id;
	const prompt = () => app.node((node) => node.props["aria-label"] === "Prompt").props.value;
	const folder = () => folderChip(app).props.title;
	app.sidebar().onNewIn({ folder: "C:/kept-project", project: "kept-project", branch: "main", worktree: "kept-project", environment: "Local" });
	await app.settle();
	const formId = app.model().session.id;
	typePrompt(app, "Half-written task");
	app.sidebar().onSelect(original);
	await app.settle();
	assert.equal(app.model().session.id, original);
	assert.equal(app.sidebar().sessions.some((item) => item.id === formId), false, "the kept form is not a sidebar row");
	assert.equal(savedHistory(app).newSessionDraft?.text, "Half-written task");
	const sessionWindow = harness(app.storage, `?session=${original}`);
	await sessionWindow.settle();
	assert.equal(sessionWindow.model().session.id, original, "a window opened for a session shows it, not the form");
	assert.equal(sessionWindow.node((node) => node.props.className === "new-page"), undefined);
	typePrompt(sessionWindow, "A reply drafted in the other window");
	await sessionWindow.settle();
	assert.equal(savedHistory(sessionWindow).newSessionDraft?.text, "Half-written task", "another window's saves keep the form");
	app.sidebar().onNew();
	await app.settle();
	assert.equal(app.model().session.id, formId, "New session reopens the kept form");
	assert.equal(prompt(), "Half-written task");
	assert.equal(folder(), "C:/kept-project");
	app.sidebar().onNew();
	await app.settle();
	assert.equal(prompt(), "Half-written task", "New session on the form keeps its text");
	app.sidebar().onNewIn({ folder: "C:/other-project", project: "other-project", branch: "main", worktree: "other-project", environment: "Local" });
	await app.settle();
	assert.equal(prompt(), "Half-written task", "a folder picked in the sidebar keeps the text");
	assert.equal(folder(), "C:/other-project");
	const before = app.sends.length;
	sendPrompt(app, "Half-written task");
	await app.settle();
	assert.equal(app.sends.length, before + 1);
	assert.equal(app.sidebar().sessions.find((item) => item.id === formId)?.folder, "C:/other-project", "the reopened form sends like a fresh one");
	assert.equal(savedHistory(app).newSessionDraft, undefined);
	app.sidebar().onNew();
	await app.settle();
	assert.notEqual(app.model().session.id, formId);
	assert.equal(prompt(), "", "after sending, New session starts empty");
}

async function checkSentComposerDraft() {
	const app = await composerWindow();
	const id = app.model().session.id;
	typePrompt(app, "Send this draft");
	await app.beforeUnload();
	assert.equal(savedHistory(app).composerDrafts[id], "Send this draft");
	sendPrompt(app, "Send this draft");
	await app.settle();
	assert.equal(savedHistory(app).composerDrafts[id], undefined, "sending removes the saved draft entry");
	const relaunch = harness(app.storage);
	await relaunch.settle();
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "");
	assert.equal(relaunch.sends.length, 0);
}

async function checkComposerDraftMerge() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const other = harness(app.storage);
	await other.settle();
	typePrompt(app, "Keep this window's draft");
	await app.beforeUnload();
	other.sidebar().onRename(id, "Renamed in the other window");
	await other.settle();
	assert.equal(savedHistory(other).composerDrafts[id], "Keep this window's draft", "another window's history save preserves an unchanged draft entry");
	const stale = harness(app.storage);
	await stale.settle();
	sendPrompt(app, "Keep this window's draft");
	await app.settle();
	stale.sidebar().onRename(id, "Another unrelated rename");
	await stale.settle();
	assert.equal(savedHistory(stale).composerDrafts[id], undefined, "a stale window does not resurrect a remotely cleared draft");
}

async function checkDeletedComposerDraft() {
	const app = await composerWindow();
	const id = app.model().session.id;
	typePrompt(app, "Delete with this session");
	await app.beforeUnload();
	app.sidebar().onDelete(id);
	await app.settle();
	assert.equal(savedHistory(app).composerDrafts[id], undefined, "deleted sessions cannot retain message drafts");
	assert.equal(savedHistory(app).sessions.some((item) => item.id === id), false);
	const stored = savedHistory(app);
	stored.composerDrafts.missingSession = "Ignore an orphaned draft";
	app.storage.set("grok-code.history.v1", JSON.stringify(stored));
	const relaunch = harness(app.storage);
	await relaunch.settle();
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "");
	relaunch.sidebar().onRename(relaunch.model().session.id, "Drop the orphan on save");
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).composerDrafts.missingSession, undefined);
}

async function checkComposerDraftDebounce() {
	let now = 0;
	let sequence = 0;
	const waiting = new Map();
	const timers = {
		setTimeout(callback, delay) { const id = ++sequence; waiting.set(id, { callback, at: now + delay }); return id; },
		clearTimeout(id) { waiting.delete(id); },
	};
	const advance = (ms) => {
		now += ms;
		for (const [id, timer] of waiting) { if (timer.at <= now) { waiting.delete(id); timer.callback(); } }
	};
	const app = await composerWindow(timers);
	advance(500);
	await app.settle();
	const baseline = app.historyWrites.length;
	for (const text of ["s", "st", "ste", "stea", "stead", "steady"]) {
		typePrompt(app, text);
		advance(100);
		await app.settle();
	}
	assert.equal(app.historyWrites.length, baseline, "steady typing does not save history on each keystroke");
	advance(399);
	await app.settle();
	assert.equal(app.historyWrites.length, baseline);
	advance(1);
	await app.settle();
	assert.equal(app.historyWrites.length, baseline + 1, "one history write follows 500 ms without typing");
	assert.equal(savedHistory(app).composerDrafts[app.model().session.id], "steady");
}

function stageAttachments(app, paths) {
	app.api.pathForFile = (file) => file.path;
	app.node((node) => typeof node.props.onDrop === "function").props.onDrop({ preventDefault() {}, dataTransfer: { files: paths.map((file) => ({ path: file })) } });
}

async function checkQueueRelaunch() {
	const app = await composerWindow();
	const firstId = app.model().session.id;
	const queuedFile = path.join(__dirname, "queued-context.md");
	const stagedFile = path.join(__dirname, "staged-context.md");
	sendPrompt(app, "hold a running turn");
	await app.settle();
	stageAttachments(app, [queuedFile]);
	sendPrompt(app, "queued first");
	await app.settle();
	sendPrompt(app, "queued second");
	await app.settle();
	const secondId = await startSession(app, "another session");
	app.emit({ type: "done", uiSessionId: secondId, turnId: app.sends.at(-1).turnId });
	await app.settle();
	stageAttachments(app, [stagedFile]);
	await app.settle();
	app.sidebar().onSelect(firstId);
	await app.settle();
	typePrompt(app, "keep this composer draft");
	await app.beforeUnload();
	const relaunch = harness(app.storage);
	await relaunch.settle();
	relaunch.sidebar().onSelect(firstId);
	await relaunch.settle();
	const rows = () => relaunch.nodes().filter((node) => node.props.className === "queued");
	same(rows().map((node) => textOf(node.props.children[0])), ["queued first", "queued second"]);
	assert.ok(relaunch.nodes().some((node) => node.props.className === "note" && textOf(node).includes("Held until")));
	assert.equal(relaunch.sends.length, 0, "a recovered queue never sends itself");
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "keep this composer draft", "queue recovery leaves the composer alone");
	queuedAction(relaunch, 1, "Send now").props.onClick();
	await relaunch.settle();
	assert.equal(relaunch.sends.at(-1).text, "queued second", "Send now chooses the recovered row");
	relaunch.emit({ type: "done", uiSessionId: firstId, turnId: relaunch.sends.at(-1).turnId });
	await relaunch.settle();
	assert.equal(relaunch.sends.at(-1).text, "queued first", "the remaining recovered queue follows afterward");
	same(relaunch.sends.at(-1).attachments, [queuedFile], "queued attachments survive recovery");
	relaunch.sidebar().onSelect(secondId);
	await relaunch.settle();
	assert.ok(relaunch.node((node) => node.props.className === "attach-chip" && node.props.title === stagedFile), "staged attachments return in their own session");
	relaunch.sidebar().onDelete(secondId);
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).attachments[secondId], undefined, "deleting a session removes its saved attachment chips");
	relaunch.sidebar().onDelete(firstId);
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).queued[firstId], undefined, "deleting a session removes its saved queue");
}

async function checkQueueFailedClose() {
	const app = await composerWindow();
	const id = app.model().session.id;
	sendPrompt(app, "keep Grok occupied");
	await app.settle();
	app.storage.failWrites = true;
	typePrompt(app, "queued before the next render");
	button(app, "Send").props.onClick();
	await Promise.resolve();
	app.node((node) => node.props["aria-label"] === "Prompt").props.onChange({ target: { value: "" } });
	assert.equal((await app.beforeUnload()).prevented, true, "an unsaved queue protects close before React rerenders");
	app.storage.failWrites = false;
	assert.equal((await app.beforeUnload()).prevented, false);
	assert.equal(savedHistory(app).queued[id][0].text, "queued before the next render");
	const staged = await composerWindow();
	const stagedId = staged.model().session.id;
	const file = path.join(__dirname, "unsaved-staged.md");
	staged.storage.failWrites = true;
	stageAttachments(staged, [file]);
	assert.equal((await staged.beforeUnload()).prevented, true, "staged files alone protect a failed save before the next render");
	staged.storage.failWrites = false;
	assert.equal((await staged.beforeUnload()).prevented, false);
	same(savedHistory(staged).attachments[stagedId], [file]);
}

async function checkQueueWindowMerge() {
	const owner = await composerWindow();
	const id = owner.model().session.id;
	sendPrompt(owner, "running turn");
	await owner.settle();
	sendPrompt(owner, "queue one");
	await owner.settle();
	const observer = harness(owner.storage);
	await observer.settle();
	sendPrompt(owner, "queue two");
	await owner.settle();
	observer.sidebar().onRename(id, "Unrelated change from another window");
	await observer.settle();
	same(savedHistory(observer).queued[id].map((item) => item.text), ["queue one", "queue two"], "a stale window's unrelated save preserves the current queue");
}

async function checkQueueAcrossWindows() {
	const owner = await composerWindow();
	const id = owner.model().session.id;
	sendPrompt(owner, "running turn");
	await owner.settle();
	sendPrompt(owner, "q1");
	await owner.settle();
	const observer = harness(owner.storage);
	await observer.settle();
	const rows = () => observer.nodes().filter((node) => node.props.className === "queued");
	assert.equal(textOf(rows()[0].props.children[0]), "q1");
	assert.equal(observer.sends.length, 0);
	owner.emit({ type: "done", uiSessionId: id, turnId: owner.sends[1].turnId });
	await owner.settle();
	assert.equal(owner.sends.at(-1).text, "q1");
	observer.storageEvent("grok-code.history.v1");
	await observer.settle();
	assert.equal(rows().length, 0, "another window removes remotely sent queue rows");
	owner.emit({ type: "done", uiSessionId: id, turnId: owner.sends.at(-1).turnId });
	await owner.settle();
	sendPrompt(observer, "a new message");
	await observer.settle();
	observer.emit({ type: "done", uiSessionId: id, turnId: observer.sends.at(-1).turnId });
	await observer.settle();
	same(observer.sends.map((input) => input.text), ["a new message"], "releasing a restored queue never resends a remote copy");
	sendPrompt(owner, "another running turn");
	await owner.settle();
	sendPrompt(owner, "q2");
	await owner.settle();
	const writes = observer.historyWrites.length;
	observer.storageEvent("grok-code.history.v1");
	await observer.settle();
	assert.equal(textOf(rows()[0].props.children[0]), "q2");
	assert.ok(observer.nodes().some((node) => node.props.className === "note" && textOf(node).includes("Held until")));
	assert.equal(observer.sends.length, 1, "adopted queue rows stay held");
	assert.equal(observer.historyWrites.length, writes, "adopting an unchanged queue does not echo a history write");
	const file = path.join(__dirname, "shared-staged.md");
	stageAttachments(owner, [file]);
	await owner.settle();
	observer.storageEvent("grok-code.history.v1");
	await observer.settle();
	assert.ok(observer.node((node) => node.props.className === "attach-chip" && node.props.title === file));
	button(owner, "Remove shared-staged.md").props.onClick();
	await owner.settle();
	observer.storageEvent("grok-code.history.v1");
	await observer.settle();
	assert.equal(observer.node((node) => node.props.className === "attach-chip" && node.props.title === file), undefined, "remote attachment removals reach a clean observer");
	observer.sidebar().onRename(id, "Do not resurrect removed chips");
	await observer.settle();
	assert.equal(savedHistory(observer).attachments[id], undefined);
}

async function checkQueueValidationAndEdit() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const file = path.join(__dirname, "valid-context.md");
	const saved = savedHistory(app);
	saved.queued = { [id]: [{ id: "valid", text: "valid queued text", attachments: [file] }, { id: 5, text: "bad id", attachments: [] }, { id: "blank", text: " ", attachments: [] }, { id: "bad-files", text: "bad files", attachments: [null] }], orphan: [{ id: "orphan", text: "orphan", attachments: [] }] };
	saved.attachments = { [id]: [file], bad: 4, orphan: [file] };
	const restored = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]));
	await restored.settle();
	assert.equal(restored.nodes().filter((node) => node.props.className === "queued").length, 1, "malformed records do not discard valid history");
	assert.equal(restored.model().session.id, id);
	assert.equal(restored.sends.length, 0);
	restored.sidebar().onRename(id, "Validated saved queue");
	await restored.settle();
	assert.equal(savedHistory(restored).queued.orphan, undefined);
	assert.equal(savedHistory(restored).attachments.orphan, undefined);
	const editing = await composerWindow();
	sendPrompt(editing, "running while editing the queue");
	await editing.settle();
	const queuedFiles = [path.join(__dirname, "queued-a.md"), path.join(__dirname, "queued-b.md")];
	stageAttachments(editing, queuedFiles);
	sendPrompt(editing, "queued edit");
	await editing.settle();
	const draftFiles = Array.from({ length: 20 }, (_, index) => path.join(__dirname, `draft-${index}.md`));
	stageAttachments(editing, draftFiles);
	typePrompt(editing, "draft");
	const before = editing.sends.length;
	queuedAction(editing, 0, "Edit").props.onClick();
	await editing.settle();
	assert.equal(editing.nodes().filter((node) => node.props.className === "queued").length, 0);
	assert.equal(editing.node((node) => node.props["aria-label"] === "Prompt").props.value, "draft\n\nqueued edit");
	assert.equal(editing.nodes().filter((node) => node.props.className === "attach-chip").length, 22, "Edit returns every attachment without silent truncation");
	assert.equal(editing.sends.length, before, "Edit never submits the queued message");
}

async function checkConversationActionsAndView() {
	const app = await composerWindow();
	const tick = app.model().findTick;
	app.key({ key: "f", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().findTick, tick + 1, "Ctrl+F opens conversation search");
	app.model().quote("a\nb");
	await app.settle();
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "> a\n> b\n\n");
	typePrompt(app, "draft");
	const before = app.sends.length;
	app.model().quote("a\nb");
	await app.settle();
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "draft\n\n> a\n> b\n\n");
	assert.equal(app.sends.length, before, "Quote edits the draft without sending");
	const verbose = harness(new Map([["grok-code.settings.v1", JSON.stringify({ defaultView: "verbose" })]]));
	await verbose.settle();
	assert.equal(verbose.model().view, "verbose");
	verbose.key({ key: "o", ctrlKey: true });
	await verbose.settle();
	assert.equal(verbose.model().view, "normal", "Ctrl+O cycles from the configured default");
	const invalid = harness(new Map([["grok-code.settings.v1", JSON.stringify({ defaultView: "unknown" })]]));
	await invalid.settle();
	assert.equal(invalid.model().view, "normal");
}

async function checkNativeTasksAndTitles() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const task = { id: "command", label: "Wait for build", command: "Start-Sleep 20", kind: "bash", status: "running", startedAt: Date.now(), endedAt: 0, exitCode: null };
	const killed = [];
	app.api.killTask = async (...args) => { killed.push(args); return { ok: true, outcome: "killed" }; };
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [task] });
	app.emit({ type: "subagent", uiSessionId: id, subagent: { id: "review", label: "Review the parser", agentType: "reviewer", model: "grok", status: "running" } });
	await app.settle();
	const commandRow = () => app.model().tasks.find((item) => item.label === task.label);
	assert.equal(commandRow().tooltip, task.command, "native task metadata arrives outside a turn");
	commandRow().onStop();
	await app.settle();
	same(killed, [[id, task.id]], "Stop addresses the native command in its owning session");
	assert.equal(commandRow().running, true, "Stop waits for a provider lifecycle update");
	app.api.killTask = async () => ({ ok: false, error: "The native command was not found" });
	commandRow().onStop();
	await app.settle();
	assert.equal(app.notice(), "The native command was not found", "native cancellation failures stay visible");
	app.emit({ type: "subagent", uiSessionId: id, subagent: { id: "review", label: "", agentType: "", model: "", status: "completed" } });
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [{ ...task, status: "completed", endedAt: Date.now(), exitCode: 0 }] });
	await app.settle();
	assert.match(app.model().tasks.find((item) => item.label === "Review the parser").detail, /Finished/);
	assert.equal(commandRow().onStop, undefined, "finished commands cannot be stopped");
	app.emit({ type: "subagent", uiSessionId: id, subagent: { id: "long", label: "Still reviewing", status: "running" } });
	for (let index = 0; index < 22; index++) { app.emit({ type: "subagent", uiSessionId: id, subagent: { id: `done-${index}`, label: `Finished ${index}`, status: "completed" } }); }
	await app.settle();
	assert.ok(app.model().tasks.some((item) => item.label === "Still reviewing"), "history caps retain running subagents");
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [], reset: true });
	await app.settle();
	assert.ok(app.model().tasks.length > 0, "process reset retains finished native work");
	assert.ok(app.model().tasks.every((item) => !item.running), "process reset cancels every running item");
	assert.match(app.model().tasks.find((item) => item.label === "Still reviewing").detail, /Cancelled/);
	app.emit({ type: "title", uiSessionId: id, title: "Generated task name" });
	await app.settle();
	assert.equal(app.model().session.title, "Generated task name", "native titles arrive outside a turn");
	app.node((node) => node.props.className === "title-btn").props.onClick();
	app.render();
	app.node((node) => node.props["aria-label"] === "Session title").props.onBlur({ target: { value: "Generated task name" } });
	await app.settle();
	assert.equal(app.model().session.titleAuto, true, "unchanged title-bar blur preserves auto-titling");
	app.node((node) => node.props.className === "title-btn").props.onClick();
	app.render();
	app.node((node) => node.props["aria-label"] === "Session title").props.onBlur({ target: { value: "My title" } });
	await app.settle();
	app.emit({ type: "title", uiSessionId: id, title: "Automatic overwrite" });
	await app.settle();
	assert.equal(app.model().session.title, "My title", "title-bar rename pins the user's title");
	app.sidebar().onRename(id, "Sidebar title");
	await app.settle();
	app.emit({ type: "title", uiSessionId: id, title: "Another overwrite" });
	await app.settle();
	assert.equal(app.model().session.title, "Sidebar title", "sidebar rename also pins the title");
	const saved = savedHistory(app);
	delete saved.sessions[0].titleAuto;
	const legacy = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]));
	await legacy.settle();
	legacy.emit({ type: "title", uiSessionId: id, title: "Legacy overwrite" });
	await legacy.settle();
	assert.equal(legacy.model().session.title, "Sidebar title", "existing saved names survive the upgrade");
	app.sidebar().onRename(id, "New session");
	await app.settle();
	sendPrompt(app, "another turn");
	await app.settle();
	assert.equal(app.model().session.title, "New session", "a manual placeholder-like name stays pinned on send");
	assert.equal(app.model().tasks.find((item) => item.id === "turn").detail, "Replying in this session");
}

async function checkManualTitleAcrossWindows() {
	const owner = await composerWindow();
	const id = owner.model().session.id;
	const observer = harness(owner.storage);
	const queued = harness(owner.storage);
	await observer.settle();
	await queued.settle();
	queued.emit({ type: "title", uiSessionId: id, title: "Automatic update already queued" });
	owner.sidebar().onRename(id, "Pinned in the owning window");
	await owner.settle();
	await queued.settle();
	assert.equal(savedHistory(owner).sessions.find((session) => session.id === id).title, "Pinned in the owning window", "an automatic title queued in another window cannot overwrite a saved manual rename");
	assert.equal(savedHistory(owner).sessions.find((session) => session.id === id).titleAuto, false);
	observer.emit({ type: "title", uiSessionId: id, title: "Automatic update before storage notification" });
	await observer.settle();
	assert.equal(observer.model().session.title, "Pinned in the owning window", "a native title arriving before the storage event respects the saved manual title");
	owner.sidebar().onRename(id, "Pinned once more");
	await owner.settle();
	observer.storageEvent("grok-code.history.v1");
	queued.storageEvent("grok-code.history.v1");
	await observer.settle();
	await queued.settle();
	assert.equal(observer.model().session.title, "Pinned once more", "storage notification displays another window's explicit rename");
	assert.equal(queued.model().session.title, "Pinned once more");
	assert.equal(observer.model().session.titleAuto, false);
}

async function checkMessageDatesAndMarkdown() {
	const app = await composerWindow();
	const messages = app.model().messages;
	assert.equal(messages[0].at, Number(messages[0].id.split("-").at(-1)));
	assert.ok(messages[1].at >= messages[0].at, "reply completion is recorded separately from submission");
	assert.equal(app.messageTime({ id: "user-1793395173962", role: "user", text: "" }).at, 1793395173962);
	assert.equal(app.messageTime({ id: "grok-1793395173962", role: "grok", text: "" }), null, "legacy assistant IDs are not completion times");
	assert.equal(app.messageTime({ id: "x", role: "grok", text: "", at: Date.now(), streaming: true }), null);
	for (const command of ["/status", "/info"]) {
		sendPrompt(app, command);
		await app.settle();
		assert.ok(app.model().messages.slice(-2).every((message) => Number.isFinite(message.at)), `${command} messages carry hover dates`);
	}
	app.api.send = async () => ({ ok: false, error: "Cannot start" });
	sendPrompt(app, "startup failure");
	await app.settle();
	assert.ok(Number.isFinite(app.model().messages.at(-1).at), "send rejection dates the completed error response");
	const viewer = harness();
	const links = [];
	const props = { ...app.editor(), file: "docs/a.md", lineTick: 1, line: undefined, open: { status: "ready", text: "# Original" }, draft: { text: "# Unsaved", baseText: "# Original", version: "v1" }, onLink: (href) => links.push(href) };
	viewer.filesView(props);
	const markdown = () => viewer.node((node) => node.type?.name === "Markdown");
	assert.equal(markdown().props.text, "# Unsaved", "Markdown preview uses the current unsaved draft");
	assert.equal(viewer.node((node) => node.type === "CodeEditor"), undefined);
	markdown().props.onLink("b.md:42", {});
	same(links, ["docs/b.md:42"]);
	button(viewer, "Edit").props.onClick();
	viewer.render();
	assert.equal(viewer.node((node) => node.type === "CodeEditor").props.value, "# Unsaved");
	button(viewer, "Preview").props.onClick();
	viewer.render();
	viewer.filesView({ ...props, line: 2, lineTick: 2 });
	assert.ok(viewer.node((node) => node.type === "CodeEditor"), "line-target navigation opens Source");
	viewer.filesView({ ...props, file: "a.ts", line: undefined, lineTick: 3 });
	assert.ok(viewer.node((node) => node.type === "CodeEditor"));
	assert.equal(button(viewer, "Preview"), undefined, "non-Markdown files retain the plain editor");
}

async function checkPromptPredictions() {
	const unattended = await composerWindow();
	let unattendedAsks = 0;
	unattended.api.suggestPrompt = async () => { unattendedAsks += 1; return ""; };
	unattended.emit(routineFire());
	await unattended.settle();
	unattended.emit({ type: "done", uiSessionId: "new-run-1", turnId: unattended.sends.at(-1).turnId, stopReason: "end_turn" });
	await unattended.settle();
	assert.equal(unattendedAsks, 0, "a routine's run asks for no prompt suggestion");

	const app = await composerWindow();
	const id = app.model().session.id;
	const requests = [];
	app.api.suggestPrompt = (sessionId) => new Promise((resolve) => requests.push({ sessionId, resolve }));
	const prompt = () => app.node((node) => node.props["aria-label"] === "Prompt");
	const key = (value) => { prompt().props.onKeyDown({ key: value, shiftKey: false, preventDefault() {}, stopPropagation() {} }); app.render(); };
	const done = async (reason = "end_turn") => { app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId, stopReason: reason }); await app.settle(); };
	const turn = async (text) => { sendPrompt(app, text); await app.settle(); await done(); };
	await turn("first prediction");
	assert.equal(requests[0].sessionId, id);
	requests[0].resolve("Run the focused check");
	await app.settle();
	assert.match(prompt().props.placeholder, /^Run the focused check/);
	key("Tab");
	assert.equal(prompt().props.value, "Run the focused check");
	assert.equal(app.sends.length, 2, "Tab accepts without sending");
	typePrompt(app, "");
	await turn("second prediction");
	requests.at(-1).resolve("Review the result");
	await app.settle();
	key("Escape");
	assert.equal(prompt().props.value, "");
	assert.doesNotMatch(prompt().props.placeholder, /^Review the result/);
	await turn("prediction A");
	const stale = requests.at(-1);
	await turn("prediction B");
	const current = requests.at(-1);
	current.resolve("Current suggestion");
	await app.settle();
	stale.resolve("Stale suggestion");
	await app.settle();
	assert.match(prompt().props.placeholder, /^Current suggestion/, "an old turn cannot replace a newer prediction");
	await turn("typing invalidates pending predictions");
	const typed = requests.at(-1);
	typePrompt(app, "my own text");
	typePrompt(app, "");
	typed.resolve("Discard after typing");
	await app.settle();
	assert.doesNotMatch(prompt().props.placeholder, /^Discard/);
	await turn("disable a pending prediction");
	const disabled = requests.at(-1);
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	let settings = app.node((node) => node.type?.name === "SettingsPage");
	settings.props.onChange({ promptSuggestions: false });
	await app.settle();
	settings = app.node((node) => node.type?.name === "SettingsPage");
	settings.props.onChange({ promptSuggestions: true });
	settings.props.onClose();
	await app.settle();
	disabled.resolve("Discard after disabling");
	await app.settle();
	assert.doesNotMatch(prompt().props.placeholder, /^Discard/);
	const before = requests.length;
	sendPrompt(app, "cancelled turn");
	await app.settle();
	await done("cancelled");
	sendPrompt(app, "failed turn");
	await app.settle();
	app.emit({ type: "error", uiSessionId: id, turnId: app.sends.at(-1).turnId, message: "Failed" });
	await app.settle();
	assert.equal(requests.length, before, "cancelled and error turns do not request predictions");
	sendPrompt(app, "/btw side question");
	await app.settle();
	app.emit({ type: "done", uiSessionId: app.sends.at(-1).uiSessionId, turnId: app.sends.at(-1).turnId });
	await app.settle();
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	settings = app.node((node) => node.type?.name === "SettingsPage");
	settings.props.onChange({ promptSuggestions: false });
	settings.props.onClose();
	await app.settle();
	await turn("prediction disabled");
	assert.equal(requests.length, before, "side replies and the disabled setting do not request predictions");
}

async function branchWindow(worktree = false) {
	const seed = await composerWindow();
	const saved = savedHistory(seed);
	const session = saved.sessions[0];
	Object.assign(session, { title: "Branch source", agentSessionId: "provider-session", model: "grok-4.7", effort: "high", allowedFolders: [path.join(__dirname, "allowed")] });
	if (worktree) { session.worktreeFolder = path.join(__dirname, "worktrees", "branch-source"); }
	const point = (index, agentSessionId = session.agentSessionId) => ({ index, agentSessionId });
	saved.extraChats[session.id] = [
		{ id: "old-user", role: "user", text: "Earlier conversation", point: point(0, "old-provider") },
		{ id: "old-reply", role: "grok", text: "Earlier reply" },
		{ id: "first-user", role: "user", text: "First prompt", point: point(0) },
		{ id: "first-reply", role: "grok", text: "First reply" },
		{ id: "second-user", role: "user", text: "Second prompt\nAnother line", point: point(1), attachments: [path.join(__dirname, "rewind-context.md")] },
		{ id: "second-reply", role: "grok", text: "Second reply" },
		{ id: "third-user", role: "user", text: "Third prompt", point: point(2) },
		{ id: "third-reply", role: "grok", text: "Third reply" },
	];
	saved.modes[session.id] = "Plan";
	saved.prePlan[session.id] = "Auto-review";
	const app = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]), `?session=${session.id}`);
	await app.settle();
	return app;
}

async function checkPromptPoints() {
	const app = harness();
	app.api.send = async (input) => { app.sends.push(input); return { ok: true, agentSessionId: "indexed-provider", promptIndex: 3 }; };
	await app.settle();
	sendPrompt(app, "An indexed prompt");
	await app.settle();
	const id = app.model().session.id;
	same(app.model().messages[0].point, { agentSessionId: "indexed-provider", index: 3 });
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	sendPrompt(app, "/btw side prompt");
	await app.settle();
	assert.equal(app.model().messages.filter((message) => message.point).length, 1, "side replies do not attach a point to the main chat");
	assert.equal(app.node((node) => node.type === "SideLog").props.messages[0].point, undefined, "side user messages never get a point");
	const model = app.model();
	const view = harness();
	view.view("chat", { ...model, busy: false, messages: [...model.messages, { id: "stale", role: "user", text: "Old", point: { agentSessionId: "old", index: 0 } }] });
	assert.equal(view.nodes().filter((node) => node.type === "button" && textOf(node) === "Rewind").length, 1, "only a user point from the current Grok conversation has Rewind");
	assert.ok(button(view, "Fork"));
	view.view("chat", { ...model, busy: true });
	assert.equal(button(view, "Rewind"), undefined);
	assert.equal(button(view, "Fork"), undefined, "branch actions are hidden while Grok works");
}

async function checkRewindCut() {
	const app = await branchWindow();
	const id = app.model().session.id;
	const target = app.model().messages.find((message) => message.id === "second-user");
	const calls = [];
	app.api.rewind = async (input) => { calls.push(input); return input.force ? { ok: true, done: true, revertedFiles: ["r1.txt", "r2.txt"] } : { ok: true, done: false, cleanFiles: ["r1.txt"], conflicts: ["r2.txt"], error: "External modifications detected." }; };
	app.model().rewind(target);
	await app.settle();
	assert.equal(calls[0].force, false);
	assert.equal(calls[0].index, 1);
	assert.equal(calls[0].agentSessionId, "provider-session");
	assert.equal(app.model().messages.length, 8, "a preview leaves the transcript alone");
	assert.ok(textOf(app.node((node) => node.props.role === "dialog")).includes("r2.txt"));
	typePrompt(app, "Existing draft");
	const staged = path.join(__dirname, "already-staged.md");
	stageAttachments(app, [staged]);
	await app.settle();
	const remote = savedHistory(app);
	remote.extraChats[id].push({ id: "remote-only", role: "grok", text: "Another window added this" });
	app.storage.set("grok-code.history.v1", JSON.stringify(remote));
	button(app, "Rewind conversation and files").props.onClick();
	await app.settle();
	same(calls[1].seen, ["r2.txt"], "forced rewind carries every conflict the dialog showed");
	assert.equal(calls[1].rewindMode, "all");
	same(app.model().messages.map((message) => message.id), ["old-user", "old-reply", "first-user", "first-reply"]);
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "Existing draft\n\nSecond prompt\nAnother line");
	same(savedHistory(app).attachments[id], [staged, ...target.attachments]);
	same(savedHistory(app).extraChats[id].map((message) => message.id), ["old-user", "old-reply", "first-user", "first-reply", "remote-only"], "save drops this window's cut messages and preserves an unseen remote addition");
	const relaunch = harness(app.storage, `?session=${id}`);
	await relaunch.settle();
	assert.equal(relaunch.model().messages.some((message) => message.id === target.id), false, "the cut survives relaunch");
}

async function checkRewindGuardsAndQueue() {
	const app = await branchWindow();
	const id = app.model().session.id;
	const target = app.model().messages.find((message) => message.id === "second-user");
	const original = JSON.stringify(app.model().messages);
	let result = { ok: true, done: true, revertedFiles: ["r1.txt"] };
	let finish;
	const calls = [];
	app.api.rewind = (input) => { calls.push(input); return input.force ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true, cleanFiles: ["r1.txt"] }); };
	let files = 0;
	let diffs = 0;
	app.api.files = async () => { files += 1; return { ok: true, files: [] }; };
	app.api.diff = async () => { diffs += 1; return { ok: true, files: [] }; };
	for (const mode of ["Files only", "Conversation only"]) {
		app.model().rewind(target);
		await app.settle();
		button(app, mode).props.onClick();
		app.render();
		const before = [files, diffs];
		if (mode === "Conversation only") { result = { ok: false, done: false, error: "Restoration failed.", revertedFiles: ["r1.txt"] }; }
		finish(result);
		await app.settle();
		assert.equal(JSON.stringify(app.model().messages), original, "files-only and failed rewinds leave the transcript alone");
		assert.ok(files > before[0] && diffs > before[1], "every forced result refreshes the file and diff panes");
	}
	assert.match(app.notice(), /Restoration failed.*1 file was restored/);
	app.model().rewind(target);
	await app.settle();
	app.key({ key: "Escape" });
	await app.settle();
	assert.equal(app.node((node) => node.props["aria-label"] === "Rewind to before this message?"), undefined);
	assert.deepEqual(app.cancels, [], "Escape dismisses the rewind dialog without Stop");
	app.model().rewind(target);
	await app.settle();
	const count = calls.length;
	sendPrompt(app, "A turn started while the dialog was open");
	await app.settle();
	button(app, "Conversation only").props.onClick();
	await app.settle();
	assert.equal(calls.length, count, "confirming while busy refuses without calling the host");
	assert.match(app.notice(), /started answering/);
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	app.model().rewind(target);
	await app.settle();
	button(app, "Conversation only").props.onClick();
	app.render();
	const sent = app.sends.length;
	sendPrompt(app, "Send after the rewind");
	await app.settle();
	assert.equal(app.sends.length, sent, "a message submitted during a rewind waits in the queue");
	assert.ok(queuedAction(app, 0, "Send now"));
	finish({ ok: true, done: true, revertedFiles: [] });
	await app.settle();
	assert.equal(app.sends.length, sent + 1);
	assert.equal(app.sends.at(-1).text, "Send after the rewind");
}

async function checkRewindSessionChanges() {
	const app = await branchWindow();
	const id = app.model().session.id;
	const target = app.model().messages.find((message) => message.id === "second-user");
	const calls = [];
	app.api.rewind = async (input) => { calls.push(input); return { ok: true, cleanFiles: [] }; };
	app.model().rewind(target);
	await app.settle();
	app.pickedFolders.push(path.join(__dirname, "another-project"));
	app.node((node) => node.props.label === app.model().session.project).props.onClick();
	app.render();
	button(app, "Choose a folder").props.onClick();
	await app.settle();
	button(app, "Rewind conversation").props.onClick();
	await app.settle();
	assert.equal(calls.length, 1, "a dialog from a prior folder refuses without a forced request");
	assert.match(app.notice(), /session changed/);
	const other = await branchWindow();
	const selected = other.model().session.id;
	const second = await startSession(other, "Open another session");
	other.emit({ type: "done", uiSessionId: second, turnId: other.sends.at(-1).turnId });
	other.sidebar().onSelect(selected);
	await other.settle();
	other.api.rewind = async () => ({ ok: true, cleanFiles: [] });
	other.model().rewind(other.model().messages.find((message) => message.id === target.id));
	await other.settle();
	other.sidebar().onSelect(second);
	await other.settle();
	assert.equal(other.node((node) => node.props["aria-label"] === "Rewind to before this message?"), undefined, "selecting another session closes the dialog");
	assert.notEqual(other.model().session.id, id);
}

async function checkFork() {
	const app = await branchWindow(true);
	const source = app.model().session;
	const sourceMessages = JSON.stringify(app.model().messages);
	const calls = [];
	const removals = [];
	app.api.fork = async (input) => { calls.push(input); return { ok: true, agentSessionId: "fork-provider" }; };
	app.api.removeWorktree = async (...args) => { removals.push(args); return { ok: true }; };
	app.model().fork(app.model().messages.find((message) => message.id === "first-user"));
	await app.settle();
	const fork = app.model().session;
	assert.equal(app.sidebar().sessions[0].id, fork.id);
	assert.notEqual(fork.id, source.id);
	assert.equal(savedHistory(app).sessions.find((item) => item.id === fork.id).parentId, source.id, "the fork saves its source session ID");
	assert.equal(fork.title, "Branch source (fork)");
	assert.equal(fork.agentSessionId, "fork-provider");
	same([fork.model, fork.effort, fork.folder, fork.worktreeFolder, fork.allowedFolders], [source.model, source.effort, source.folder, source.worktreeFolder, source.allowedFolders]);
	assert.equal(calls[0].index, 0);
	same(app.model().messages.map((message) => message.id), ["old-user", "old-reply", "first-user", "first-reply"], "fork includes the selected prompt's reply and stops before the next user");
	assert.equal(app.model().messages[0].point, undefined, "copied points from an older conversation are dropped");
	same(app.model().messages[2].point, { index: 0, agentSessionId: "fork-provider" });
	assert.equal(savedHistory(app).modes[fork.id], "Plan");
	assert.equal(app.model().resumeMode, "Auto-review", "fork keeps the source's pre-Plan mode");
	app.sidebar().onSelect(source.id);
	await app.settle();
	assert.equal(JSON.stringify(app.model().messages), sourceMessages, "fork does not change the source transcript");
	app.sidebar().onArchive(source.id);
	await app.settle();
	assert.equal(removals.length, 0, "archiving a session whose fork is open keeps their shared worktree");
	app.sidebar().onArchive(fork.id);
	await app.settle();
	assert.equal(removals.length, 1, "archiving the last open session removes the worktree");
}

async function checkBackgroundReportPlacement() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const emit = (turnId, type, fields = {}) => app.emit({ type, uiSessionId: id, turnId, ...fields });
	emit("task-report-silent", "turn-start", { background: true });
	emit("task-report-silent", "done");
	await app.settle();
	assert.equal(app.model().messages.some((message) => message.id === "grok-task-report-silent"), false, "a wake with no output leaves no empty report row");

	const reportId = "task-report-early";
	emit(reportId, "turn-start", { background: true });
	sendPrompt(app, "The newer prompt");
	await app.settle();
	const normalTurn = app.sends.at(-1).turnId;
	emit(reportId, "chunk", { text: "Report starts." });
	emit(reportId, "tool", { tool: { id: "report-tool", kind: "execute", title: "Check result", detail: "Ran" } });
	emit(normalTurn, "chunk", { text: "The newer reply." });
	emit(reportId, "chunk", { text: "Report ends." });
	emit(reportId, "done");
	emit(normalTurn, "done");
	await app.settle();
	const [report, prompt, reply] = app.model().messages.slice(-3);
	assert.equal(report.id, "grok-task-report-early", "the report keeps its start position even when text arrives after the newer prompt");
	assert.equal(prompt.text, "The newer prompt");
	assert.equal(reply.text, "The newer reply.");
	same(report.parts, [{ kind: "text", text: "Report starts." }, { kind: "tool", id: "report-tool" }, { kind: "text", text: "Report ends." }]);
	assert.equal(report.text, "Report starts.\nReport ends.", "copied report text keeps the tool boundary");
	app.unmount();
	console.log("PASS background report placement: silent wake cleanup, early ordering and text around a tool");
}

async function checkRestoredBackgroundTools() {
	const app = await composerWindow();
	const id = app.model().session.id;
	sendPrompt(app, "Launch background commands");
	await app.settle();
	const turnId = app.sends.at(-1).turnId;
	for (const tool of [
		{ id: "marked", kind: "execute", title: "Run command", detail: "Running", backgroundTask: true },
		{ id: "legacy", kind: "execute", title: "[bg] Run command", detail: "Running" },
		{ id: "foreground", kind: "execute", title: "Run command", detail: "Running" },
		{ id: "completed", kind: "execute", title: "Run command", detail: "Ran", backgroundTask: true },
	]) {
		app.emit({ type: "tool", uiSessionId: id, turnId, tool });
	}
	app.emit({ type: "done", uiSessionId: id, turnId });
	await app.settle();
	const saved = savedHistory(app);
	const tools = saved.extraChats[id].at(-1).tools;
	assert.equal(tools.find((tool) => tool.id === "marked").backgroundTask, true, "the marker survives saving");
	assert.equal(tools.find((tool) => tool.id === "marked").detail, "Running", "a live command remains Running before restore");
	const cloudId = "cloud-background-tools";
	saved.sessions.push({ ...saved.sessions.find((item) => item.id === id), id: cloudId, title: "Cloud fixture", environment: "Cloud" });
	saved.extraChats[cloudId] = saved.extraChats[id];
	const restored = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]), `?session=${id}`);
	await restored.settle();
	const details = () => Object.fromEntries(restored.model().messages.at(-1).tools.map((tool) => [tool.id, tool.detail]));
	assert.deepEqual(details(), { marked: "Stopped", legacy: "Stopped", foreground: "Running", completed: "Ran" }, "restore stops only identified local background rows");
	restored.sidebar().onSelect(cloudId);
	await restored.settle();
	assert.deepEqual(details(), { marked: "Running", legacy: "Running", foreground: "Running", completed: "Ran" }, "Cloud tool rows keep their saved status");
	app.unmount();
	restored.unmount();
	console.log("PASS background tool restore: marked and legacy local rows stop, Cloud status is retained");
}

async function checkBackgroundReports() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const messagesBefore = app.model().messages.length;
	let suggestions = 0;
	app.api.suggestPrompt = async () => { suggestions += 1; return ""; };
	const start = (turnId, uiSessionId = id) => app.emit({ type: "turn-start", uiSessionId, turnId, background: true });
	const emit = (turnId, type, text, uiSessionId = id) => app.emit({ type, uiSessionId, turnId, ...(text ? { text } : {}) });
	const report = (turnId) => app.model().messages.find((message) => message.id === `grok-${turnId}`);
	start("task-report-idle");
	await app.settle();
	assert.equal(button(app, "Stop"), undefined, "a background report does not become a send or steer target");
	emit("task-report-idle", "chunk", "The background command finished.");
	emit("task-report-idle", "done");
	await app.settle();
	assert.equal(app.model().messages.length, messagesBefore + 1, "an idle report adds only one Grok message");
	assert.equal(report("task-report-idle").role, "grok");
	assert.equal(report("task-report-idle").text, "The background command finished.");
	assert.equal(suggestions, 0, "background completion does not request a next prompt suggestion");
	start("task-report-idle");
	emit("task-report-idle", "chunk", "Duplicate delivery.");
	emit("task-report-idle", "done");
	await app.settle();
	assert.equal(report("task-report-idle").text, "The background command finished.", "a repeated report id is rendered once");
	assert.equal(app.model().messages.filter((message) => message.id === "grok-task-report-idle").length, 1);
	for (const [turnId, text] of [["task-report-close-a", "Close A."], ["task-report-close-b", "Close B."]]) {
		start(turnId);
		emit(turnId, "chunk", text);
		emit(turnId, "done");
	}
	await app.settle();
	assert.equal(report("task-report-close-a").text, "Close A.");
	assert.equal(report("task-report-close-b").text, "Close B.", "two completions before a render retain separate messages");

	app.api.steer = undefined;
	sendPrompt(app, "A newer user prompt");
	await app.settle();
	const normalTurn = app.sends.at(-1).turnId;
	const normalReply = app.model().messages.at(-1).id;
	start("task-report-first");
	start("task-report-second");
	emit("task-report-second", "chunk", "Second report.");
	emit("task-report-first", "chunk", "First report.");
	sendPrompt(app, "Queued user prompt");
	await app.settle();
	const sentBeforeReport = app.sends.length;
	emit("task-report-first", "done");
	await app.settle();
	assert.equal(app.sends.length, sentBeforeReport, "finishing a report does not drain the user's queue");
	assert.ok(button(app, "Stop"), "finishing a report leaves the newer user prompt active");
	emit(normalTurn, "chunk", "The user's own reply.");
	emit(normalTurn, "done");
	await app.settle();
	assert.equal(app.sends.at(-1).text, "Queued user prompt", "an unfinished report does not hold the normal queue");
	const queuedTurn = app.sends.at(-1).turnId;
	emit("task-report-second", "chunk", " More.");
	emit("task-report-second", "done");
	await app.settle();
	assert.ok(button(app, "Stop"), "the second report cannot finish the newly queued user turn");
	assert.equal(app.model().messages.find((message) => message.id === normalReply).text, "The user's own reply.");
	assert.equal(report("task-report-first").text, "First report.");
	assert.equal(report("task-report-second").text, "Second report. More.");
	sendPrompt(app, "/btw A side question");
	await app.settle();
	const sideTurn = app.sends.at(-1).turnId;
	const sideId = app.sends.at(-1).uiSessionId;
	const sideMessages = () => app.node((node) => node.type === "SideLog").props.messages;
	const sideReply = sideMessages().at(-1).id;
	const sideCount = sideMessages().length;
	start("task-report-side", sideId);
	emit("task-report-side", "chunk", "A side background report.", sideId);
	emit("task-report-side", "done", undefined, sideId);
	emit(sideTurn, "chunk", "The side question's own reply.", sideId);
	emit(sideTurn, "done", undefined, sideId);
	await app.settle();
	assert.equal(sideMessages().length, sideCount + 1, "a side report adds only a Grok message in that side conversation");
	assert.equal(sideMessages().find((message) => message.id === "grok-task-report-side").text, "A side background report.");
	assert.equal(sideMessages().find((message) => message.id === sideReply).text, "The side question's own reply.");
	assert.equal(app.model().messages.some((message) => message.id === "grok-task-report-side"), false, "side reports never enter the parent transcript");
	assert.ok(button(app, "Stop"), "a side report leaves the main prompt active");
	emit(queuedTurn, "done");
	await app.settle();
	start("task-report-partial");
	emit("task-report-partial", "chunk", "A saved partial report.");
	await app.settle();
	await app.beforeUnload();
	app.unmount();

	const restored = harness(new Map(app.storage));
	await restored.settle();
	const savedReport = restored.model().messages.find((message) => message.id === "grok-task-report-idle");
	restored.emit({ type: "turn-start", uiSessionId: id, turnId: "task-report-idle", background: true });
	restored.emit({ type: "chunk", uiSessionId: id, turnId: "task-report-idle", text: "Restored duplicate." });
	restored.emit({ type: "done", uiSessionId: id, turnId: "task-report-idle" });
	await restored.settle();
	const copies = restored.model().messages.filter((message) => message.id === "grok-task-report-idle");
	assert.equal(copies.length, 1, "a persisted report remains one message after restore and redelivery");
	assert.equal(copies[0].text, savedReport.text);
	assert.equal(button(restored, "Stop"), undefined);
	const savedPartial = restored.model().messages.find((message) => message.id === "grok-task-report-partial");
	restored.emit({ type: "turn-start", uiSessionId: id, turnId: "task-report-partial", background: true });
	restored.emit({ type: "chunk", uiSessionId: id, turnId: "task-report-partial", text: "Partial replay." });
	restored.emit({ type: "done", uiSessionId: id, turnId: "task-report-partial" });
	await restored.settle();
	assert.equal(restored.model().messages.filter((message) => message.id === savedPartial.id).length, 1);
	assert.equal(restored.model().messages.find((message) => message.id === savedPartial.id).text, savedPartial.text, "an interrupted saved report retains its text once on redelivery");
	assert.equal(restored.model().messages.find((message) => message.id === savedPartial.id).appNote, savedPartial.appNote);
	restored.unmount();
	console.log("PASS background reports: independent main and side messages, normal queue ownership, close completions, and restored deduplication");
}

async function checkSteer() {
	const app = await composerWindow();
	const id = app.model().session.id;
	sendPrompt(app, "A running turn");
	await app.settle();
	const turn = app.sends.at(-1).turnId;
	app.emit({ type: "chunk", uiSessionId: id, turnId: turn, text: "Before." });
	sendPrompt(app, "Steer this turn");
	await app.settle();
	let finish;
	const calls = [];
	app.api.steer = (...args) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); };
	queuedAction(app, 0, "Steer").props.onClick();
	app.render();
	same(calls, [[id, "Steer this turn"]]);
	assert.equal(queuedAction(app, 0, "Send now"), undefined, "steer removes its row before the host answers");
	app.emit({ type: "steer", uiSessionId: id, turnId: turn, text: "Steer this turn" });
	app.emit({ type: "chunk", uiSessionId: id, turnId: turn, text: "After." });
	await app.settle();
	const reply = app.model().messages.at(-1);
	assert.equal(reply.text, "Before.After.");
	same(reply.parts, [{ kind: "text", text: "Before." }, { kind: "steer", text: "Steer this turn" }, { kind: "text", text: "After." }]);
	const view = harness();
	view.message({ ...app.model(), messages: [reply] });
	assert.equal(textOf(view.node((node) => node.props.className === "steer-note")), "You, while Grok workedSteer this turn");
	app.emit({ type: "done", uiSessionId: id, turnId: turn });
	await app.settle();
	app.emit({ type: "steer", uiSessionId: id, turnId: turn, text: "Acknowledged after completion" });
	await app.settle();
	const completedReply = app.model().messages.at(-1);
	assert.equal(completedReply.parts.at(-1).text, "Acknowledged after completion", "a delayed steer notice stays with its completed reply");
	assert.equal(completedReply.text, "Before.After.");
	assert.equal(completedReply.streaming, false, "recording the steer leaves the reply finished");
	finish({ ok: true });
	await app.settle();
	assert.equal(app.sends.length, 2, "ending the turn while steer is pending never sends that row again");
	sendPrompt(app, "Another running turn");
	await app.settle();
	// Without steering in this window, typed messages queue, which gives the rows to steer.
	const steerApi = app.api.steer;
	app.api.steer = undefined;
	for (const text of ["before", "failed steer", "after"]) { sendPrompt(app, text); await app.settle(); }
	app.api.steer = steerApi;
	queuedAction(app, 1, "Steer").props.onClick();
	app.render();
	finish({ ok: false, error: "Grok is stopping this turn." });
	await app.settle();
	same(app.nodes().filter((node) => node.props.className === "queued").map((node) => textOf(node.props.children[0])), ["before", "failed steer", "after"], "a failed steer goes back to its previous queue position");
	assert.match(app.notice(), /Grok is stopping.*stays queued/);
	stageAttachments(app, [path.join(__dirname, "steer-attachment.md")]);
	sendPrompt(app, "With an attachment");
	await app.settle();
	sendPrompt(app, "/compact");
	await app.settle();
	assert.equal(queuedAction(app, 3, "Steer"), undefined, "attachments cannot be steered");
	assert.equal(queuedAction(app, 4, "Steer"), undefined, "slash commands cannot be steered");
	button(app, "Stop").props.onClick();
	await app.settle();
	assert.equal(button(app, "Steer"), undefined, "Stop holds the queue and hides Steer");

	const typed = await composerWindow();
	const typedId = typed.model().session.id;
	sendPrompt(typed, "A running turn");
	await typed.settle();
	const queuedTexts = () => typed.nodes().filter((node) => node.props.className === "queued").map((node) => textOf(node.props.children[0]));
	const sentBefore = typed.sends.length;
	const steers = [];
	let answer = { ok: true };
	typed.api.steer = async (...args) => { steers.push(args); return answer; };
	sendPrompt(typed, "Use the other file");
	await typed.settle();
	same(steers, [[typedId, "Use the other file"]], "Enter during a turn steers it");
	same(queuedTexts(), [], "a steered message is not queued");
	assert.equal(typed.sends.length, sentBefore, "nor sent as a new turn");
	sendPrompt(typed, "/compact");
	await typed.settle();
	stageAttachments(typed, [path.join(__dirname, "steer-attachment.md")]);
	sendPrompt(typed, "With an attachment");
	await typed.settle();
	assert.equal(steers.length, 1, "commands and attachments are not steered");
	same(queuedTexts(), ["/compact", "With an attachment"], "they wait in the queue");
	answer = { ok: false, error: "Grok has finished this turn." };
	sendPrompt(typed, "Too late");
	await typed.settle();
	same(queuedTexts(), ["/compact", "With an attachment", "Too late"], "a steer Grok refuses joins the end of the queue");
	assert.match(typed.notice(), /finished this turn.*stays queued/);

	const adopt = await composerWindow();
	const adoptId = adopt.model().session.id;
	sendPrompt(adopt, "First turn");
	await adopt.settle();
	const adoptSends = adopt.sends.length;
	sendPrompt(adopt, "/compact");
	await adopt.settle();
	adopt.emit({ type: "done", uiSessionId: adoptId, turnId: adopt.sends.at(-1).turnId });
	await adopt.settle();
	assert.equal(adopt.sends.length, adoptSends + 1, "a queued prompt can start as soon as the original ends");
	assert.equal(adopt.sends.at(-1).text, "/compact");
	const normalTurn = adopt.sends.at(-1).turnId;
	const normalReply = adopt.model().messages.at(-1).id;
	adopt.emit({ type: "turn-start", uiSessionId: adoptId, turnId: "steer-turn", text: "Also add tests", parallel: true });
	await adopt.settle();
	assert.equal(adopt.model().messages.at(-2).role, "user");
	assert.equal(adopt.model().messages.at(-2).text, "Also add tests", "a turn Grok starts for a late steer shows the steer as a message");
	assert.equal(adopt.model().messages.at(-1).pending, true);
	assert.ok(button(adopt, "Stop"), "that turn can be stopped like any other");
	adopt.emit({ type: "chunk", uiSessionId: adoptId, turnId: "steer-turn", text: "Added." });
	adopt.emit({ type: "chunk", uiSessionId: adoptId, turnId: normalTurn, text: "Compacted." });
	adopt.emit({ type: "tool", uiSessionId: adoptId, turnId: "steer-turn", tool: { id: "fallback-tool", kind: "read", title: "Read", waiting: true } });
	await adopt.settle();
	assert.equal(adopt.model().messages.at(-1).text, "Added.");
	assert.equal(adopt.model().messages.find((message) => message.id === normalReply).text, "Compacted.", "a normal reply keeps its target while the fallback is active");
	assert.equal(adopt.model().messages.at(-1).tools[0].id, "fallback-tool");
	adopt.emit({ type: "turn-start", uiSessionId: adoptId, turnId: normalTurn, resume: true, parallel: true });
	await adopt.settle();
	assert.equal(adopt.model().messages.find((message) => message.id === normalReply).text, "Compacted.", "a native execution switch preserves the existing reply");
	adopt.model().decide("fallback-tool", "deny");
	await adopt.settle();
	assert.equal(adopt.model().messages.find((message) => message.id === "grok-steer-turn").tools[0].waiting, false, "a tool answer updates its own reply after execution switches");
	adopt.emit({ type: "done", uiSessionId: adoptId, turnId: "steer-turn" });
	await adopt.settle();
	assert.ok(button(adopt, "Stop"), "finishing the fallback keeps the normal turn busy");
	const count = adopt.model().messages.length;
	adopt.emit({ type: "turn-start", uiSessionId: adoptId, turnId: "second", text: "Ignored" });
	await adopt.settle();
	assert.equal(adopt.model().messages.length, count, "a turn the app already shows is not replaced");
	adopt.emit({ type: "turn-start", uiSessionId: adoptId, turnId: "another-steer", text: "A later steer", parallel: true });
	adopt.emit({ type: "done", uiSessionId: adoptId, turnId: normalTurn });
	await adopt.settle();
	assert.ok(button(adopt, "Stop"), "finishing the normal turn keeps an unfinished fallback busy");
	adopt.emit({ type: "chunk", uiSessionId: adoptId, turnId: "another-steer", text: "Another reply." });
	adopt.emit({ type: "done", uiSessionId: adoptId, turnId: "another-steer" });
	adopt.emit({ type: "chunk", uiSessionId: adoptId, turnId: "steer-turn", text: "Late text" });
	adopt.emit({ type: "tool", uiSessionId: adoptId, turnId: "steer-turn", tool: { id: "fallback-tool", detail: "Finished" } });
	await adopt.settle();
	assert.equal(button(adopt, "Stop"), undefined, "the session stops being busy after every reply ends");
	assert.equal(adopt.model().messages.find((message) => message.id === "grok-steer-turn").text, "Added.", "late text from a finished fallback is ignored");
	assert.equal(adopt.model().messages.find((message) => message.id === "grok-steer-turn").tools[0].detail, "Finished", "a late tool update stays on its fallback reply");
	assert.equal(adopt.model().messages.find((message) => message.id === normalReply).text, "Compacted.");

	const refused = await composerWindow();
	const refusedId = refused.model().session.id;
	let finishSend;
	refused.api.send = () => new Promise((resolve) => { finishSend = resolve; });
	sendPrompt(refused, "A new prompt");
	await refused.settle();
	const refusedReply = refused.model().messages.at(-1).id;
	refused.emit({ type: "turn-start", uiSessionId: refusedId, turnId: "fallback-during-start", text: "An earlier steer", parallel: true });
	refused.emit({ type: "chunk", uiSessionId: refusedId, turnId: "fallback-during-start", text: "An independent reply." });
	finishSend({ ok: false, error: "The new prompt failed." });
	await refused.settle();
	assert.equal(refused.model().messages.find((message) => message.id === refusedReply).appNote, "The new prompt failed.");
	assert.equal(refused.model().messages.at(-1).text, "An independent reply.");
	assert.ok(button(refused, "Stop"), "a failed send leaves its independent fallback busy");
	refused.emit({ type: "done", uiSessionId: refusedId, turnId: "fallback-during-start" });
	await refused.settle();
	assert.equal(button(refused, "Stop"), undefined);

	const stopped = await composerWindow();
	stopped.api.steer = async () => ({ ok: false, error: "Stopped." });
	sendPrompt(stopped, "Running before Stop");
	await stopped.settle();
	const stoppedId = stopped.model().session.id;
	const stoppedTurnId = stopped.sends.at(-1).turnId;
	const stoppedSends = stopped.sends.length;
	button(stopped, "Stop").props.onClick();
	sendPrompt(stopped, "Typed after Stop");
	await stopped.settle();
	stopped.emit({ type: "done", uiSessionId: stoppedId, turnId: stoppedTurnId, stopReason: "cancelled" });
	await stopped.settle();
	assert.equal(stopped.sends.length, stoppedSends, "a refused late steer cannot release a stopped queue");
	assert.ok(queuedAction(stopped, 0, "Send now"), "the text stays available to send explicitly");
}

async function checkStreamHistorySaves() {
	const timers = controlledTimers();
	const app = await composerWindow(timers);
	sendPrompt(app, "Stream a reply");
	await app.settle();
	timers.advance(500);
	await app.settle();
	const id = app.model().session.id;
	const turnId = app.sends.at(-1).turnId;
	const emit = (type, extra) => app.emit({ type, uiSessionId: id, turnId, ...extra });
	const baseline = app.historyWrites.length;
	for (const text of ["First ", "second ", "third"]) { emit("chunk", { text }); await app.settle(); }
	emit("thought", { text: "Thinking progress" });
	await app.settle();
	assert.equal(app.historyWrites.length, baseline, "streamed text alone does not save immediately");
	timers.advance(1999);
	await app.settle();
	assert.equal(app.historyWrites.length, baseline);
	timers.advance(1);
	await app.settle();
	assert.equal(app.historyWrites.length, baseline + 1, "stream progress saves once after two seconds");
	assert.equal(savedHistory(app).extraChats[id].at(-1).text, "First second third");
	assert.equal(savedHistory(app).extraChats[id].at(-1).thought, "Thinking progress");
	emit("chunk", { text: " final" });
	await app.settle();
	emit("done", { stopReason: "end_turn" });
	await app.settle();
	assert.equal(savedHistory(app).extraChats[id].at(-1).text, "First second third final", "turn completion saves final text immediately");
	sendPrompt(app, "Another running turn");
	await app.settle();
	const activeTurn = app.sends.at(-1).turnId;
	app.sidebar().onRename(id, "Renamed while running");
	await app.settle();
	assert.equal(savedHistory(app).sessions.find((item) => item.id === id).title, "Renamed while running");
	sendPrompt(app, "Steer this instruction");
	await app.settle();
	assert.equal(savedHistory(app).queued[id][0].text, "Steer this instruction", "queue changes save immediately");
	app.api.steer = async () => ({ ok: true });
	queuedAction(app, 0, "Steer").props.onClick();
	await app.settle();
	app.emit({ type: "steer", uiSessionId: id, turnId: activeTurn, text: "Steer this instruction" });
	await app.settle();
	assert.equal(savedHistory(app).queued[id], undefined);
	assert.ok(savedHistory(app).extraChats[id].at(-1).parts.some((part) => part.kind === "steer" && part.text === "Steer this instruction"), "accepted steering is saved without advancing time");
	app.emit({ type: "chunk", uiSessionId: id, turnId: activeTurn, text: "Mixed batch" });
	app.emit({ type: "tool", uiSessionId: id, turnId: activeTurn, tool: { id: "mixed-tool", kind: "read", title: "Read a file", detail: "Ran" } });
	await app.settle();
	assert.equal(savedHistory(app).extraChats[id].at(-1).text, "Mixed batch");
	assert.equal(savedHistory(app).extraChats[id].at(-1).tools[0].id, "mixed-tool", "a tool update makes a batched stream change urgent");
	app.sidebar().onDelete(id);
	await app.settle();
	assert.equal(savedHistory(app).sessions.some((item) => item.id === id), false, "deleting a running session saves immediately");

	const seed = await branchWindow();
	const source = seed.model().session.id;
	const rewound = harness(new Map(seed.storage), `?session=${source}`, Date, timers);
	rewound.api.files = async () => ({ ok: true, files: [] });
	await rewound.settle();
	await startSession(rewound, "Keep another session running");
	rewound.sidebar().onSelect(source);
	await rewound.settle();
	rewound.api.rewind = async (input) => input.force ? { ok: true, done: true, revertedFiles: [] } : { ok: true, cleanFiles: [] };
	rewound.model().rewind(rewound.model().messages.find((message) => message.id === "first-user"));
	await rewound.settle();
	button(rewound, "Rewind conversation").props.onClick();
	await rewound.settle();
	same(savedHistory(rewound).extraChats[source].map((message) => message.id), ["old-user", "old-reply"], "rewind cuts save immediately while another session runs");
}

async function checkResizeChurn() {
	const timers = controlledTimers();
	const app = await composerWindow(timers);
	app.window.innerWidth = 1600;
	app.windowEvent("resize");
	timers.advance(100);
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	const baseline = app.settingsWrites.length;
	app.node((node) => node.props["aria-label"] === "Resize panes").props.onMouseDown({ clientX: 1000, preventDefault() {} });
	for (const clientX of [900, 800, 0]) {
		app.windowEvent("mousemove", { clientX });
		await app.settle();
		assert.equal(app.settingsWrites.length, baseline, "dragging does not save settings on mousemove");
	}
	app.windowEvent("mouseup");
	await app.settle();
	assert.equal(app.settingsWrites.length, baseline + 1, "one settings write commits the drag");
	assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).sideWidth, 926, "the final width leaves room for the sidebar and chat");
	const splitter = () => app.node((node) => node.props["aria-label"] === "Resize panes").props;
	for (const [key, shiftKey, width] of [["Home", false, 320], ["ArrowLeft", false, 344], ["ArrowLeft", true, 440], ["ArrowRight", false, 416], ["End", false, 926]]) {
		let prevented = false;
		splitter().onKeyDown({ key, shiftKey, preventDefault() { prevented = true; } });
		await app.settle();
		assert.ok(prevented);
		assert.equal(splitter()["aria-valuenow"], width);
		assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).sideWidth, width);
	}
	for (const width of [320, 560, 926]) {
		splitter().onDoubleClick();
		await app.settle();
		assert.equal(splitter()["aria-valuenow"], width);
	}

	const resized = harness(new Map(), "", Date, timers);
	resized.window.innerWidth = 1600;
	await resized.settle();
	assert.ok(resized.node((node) => node.type === "SessionRail"));
	resized.window.innerWidth = 900;
	resized.windowEvent("resize");
	await resized.settle();
	assert.ok(resized.node((node) => node.type === "SessionRail"), "resize waits for the debounce");
	timers.advance(99);
	await resized.settle();
	assert.ok(resized.node((node) => node.type === "SessionRail"));
	timers.advance(1);
	await resized.settle();
	assert.equal(resized.node((node) => node.type === "SessionRail"), undefined, "the new width takes effect after 100 ms");
}

async function checkColumnWidths() {
	const app = harness();
	await app.settle();
	const handle = (window, label) => window.node((node) => node.props["aria-label"] === label)?.props;
	for (const [label, key, original, min, delta] of [
		["Resize sidebar", "sidebarWidth", 268, 200, 40],
		["Resize session rail", "railWidth", 280, 240, -40],
	]) {
		const divider = () => handle(app, label);
		const storedWidth = () => JSON.parse(app.storage.get("grok-code.settings.v1"))[key];
		assert.equal(divider().tabIndex, 0);
		assert.equal(divider().title, "Drag, or use the arrow keys, to resize. Double-click to switch between narrow, default and wide.");
		assert.equal(divider()["aria-valuenow"], original);
		divider().onMouseDown({ button: 0, clientX: 700, preventDefault() {} });
		app.windowEvent("mousemove", { clientX: 700 + delta });
		await app.settle();
		assert.equal(divider()["aria-valuenow"], original + 40);
		assert.equal(storedWidth(), original, "drag preview does not write settings");
		app.windowEvent("mouseup");
		await app.settle();
		assert.equal(storedWidth(), original + 40);
		for (const [press, width] of [["Home", min], [delta > 0 ? "ArrowRight" : "ArrowLeft", min + 24], ["End", 420]]) {
			divider().onKeyDown({ key: press, preventDefault() {} });
			await app.settle();
			assert.equal(divider()["aria-valuenow"], width);
		}
		for (const width of [min, original, 420]) {
			divider().onDoubleClick();
			await app.settle();
			assert.equal(divider()["aria-valuenow"], width);
		}
	}
	app.unmount();
	const timers = controlledTimers();
	const reopened = harness(app.storage, "", Date, timers);
	await reopened.settle();
	assert.equal(handle(reopened, "Resize sidebar")["aria-valuenow"], 420, "sidebar width survives restart");
	assert.equal(handle(reopened, "Resize session rail")["aria-valuenow"], 420, "rail width survives restart");
	reopened.window.innerWidth = 1100;
	reopened.windowEvent("resize");
	timers.advance(100);
	reopened.editor();
	await reopened.settle();
	assert.equal(handle(reopened, "Resize sidebar")["aria-valuenow"], 374);
	assert.equal(handle(reopened, "Resize panes")["aria-valuenow"], 320, "both widths leave 400px for chat at the desktop breakpoint");
	assert.equal(handle(reopened, "Resize session rail"), undefined, "the saved rail steps aside when it does not fit");
	reopened.window.innerWidth = 680;
	reopened.windowEvent("resize");
	timers.advance(100);
	await reopened.settle();
	assert.equal(handle(reopened, "Resize sidebar"), undefined, "a narrow window with panes still auto-collapses the sidebar");
	assert.equal(handle(reopened, "Resize panes")["aria-valuenow"], 354, "a narrow window preserves 320px for chat");
	const saved = JSON.parse(reopened.storage.get("grok-code.settings.v1"));
	assert.equal(saved.sidebarWidth, 420);
	assert.equal(saved.railWidth, 420, "automatic fit does not overwrite saved widths");
	reopened.unmount();
}

async function checkHiddenSidebarProjectReveal() {
	const app = await composerWindow();
	const first = app.model().session.id;
	await startSession(app, "Second session");
	app.sidebar().onCollapse();
	await app.settle();
	app.key({ key: "Tab", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().session.id, first);
	button(app, "Show sidebar").props.onClick();
	await app.settle();
	assert.equal(app.sidebar().revealActiveOnMount, true, "the remounted sidebar reveals the session switched to while hidden");
	app.unmount();
}

async function checkSmallUiBatch() {
	const timers = controlledTimers();
	const app = await composerWindow(timers);
	const add = (text) => { app.sidebar().onNotice(text); app.render(); };
	add("First error");
	add("Second error");
	same(app.notices(), ["First error", "Second error"]);
	add("Third error");
	add("Fourth error");
	same(app.notices(), ["Second error", "Third error", "Fourth error"], "only the newest three notices remain");
	add("Third error");
	same(app.notices(), ["Second error", "Fourth error", "Third error"], "duplicate text moves to the newest position");
	const oldest = app.nodes().find((node) => node.props.className === "note composer-note");
	app.nodes(oldest).find((node) => node.type === "button").props.onClick();
	app.render();
	same(app.notices(), ["Fourth error", "Third error"], "dismiss removes only its own notice");

	app.api.copyText = async () => ({ ok: true });
	const taskbar = [];
	app.api.taskbar = async (state) => { taskbar.push(state); return { ok: true }; };
	sendPrompt(app, "A streamed reply");
	await app.settle();
	const id = app.model().session.id;
	const turnId = app.sends.at(-1).turnId;
	app.model().copyText("Copy this");
	await app.settle();
	app.emit({ type: "chunk", uiSessionId: id, turnId, text: "First" });
	await app.settle();
	timers.advance(2000);
	await app.settle();
	add("Persistent error");
	app.emit({ type: "chunk", uiSessionId: id, turnId, text: " second" });
	await app.settle();
	timers.advance(1999);
	await app.settle();
	assert.ok(app.notices().includes("Copied."));
	timers.advance(1);
	await app.settle();
	assert.ok(!app.notices().includes("Copied."), "unrelated notices and successful history checkpoints do not extend the fade");
	assert.ok(app.notices().includes("Persistent error"));
	same(taskbar, ["running"], "streamed chunks do not repeat taskbar IPC");
	app.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "approval", title: "Edit", waiting: true } });
	await app.settle();
	app.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "approval", waiting: false } });
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId });
	await app.settle();
	same(taskbar, ["running", "needs-you", "running", "idle"]);
	app.storage.failWrites = "quota";
	app.sidebar().onRename(id, "Save failure");
	await app.settle();
	assert.ok(app.notices().some((text) => text.startsWith("Chat history is full")));
	add("Keep reading this");
	app.storage.failWrites = false;
	app.sidebar().onRename(id, "Save recovered");
	await app.settle();
	assert.ok(!app.notices().some((text) => text.startsWith("Chat history is full")), "recovery clears an older history warning");
	assert.equal(app.notice(), "Keep reading this");

	app.sidebar().onNewIn({ folder: "C:/project", project: "project", branch: "main", worktree: "project", environment: "Local" });
	await app.settle();
	worktreeInput(app).props.onChange({ target: { checked: true } });
	let failWorktree;
	app.api.addWorktree = () => new Promise((resolve) => { failWorktree = resolve; });
	sendPrompt(app, "Try this worktree");
	await app.settle();
	assert.ok(app.notices().includes("Creating the worktree…"));
	failWorktree({ ok: false, error: "Worktree failed" });
	await app.settle();
	assert.ok(!app.notices().includes("Creating the worktree…"));
	assert.equal(app.notice(), "Worktree failed");

	const sizing = harness(new Map([["grok-code.settings.v1", JSON.stringify({ sideWidth: 560, railOpen: false })]]), "", Date, timers);
	sizing.window.innerWidth = 1100;
	await sizing.settle();
	sizing.editor();
	await sizing.settle();
	assert.equal(sizing.sideCap(1100, 268), 426);
	assert.equal(sizing.sideCap(1100, 0), 694);
	const side = () => sizing.node((node) => node.props.className === "side-col");
	assert.equal(side().props.style.width, 426);
	assert.equal(JSON.parse(sizing.storage.get("grok-code.settings.v1")).sideWidth, 560, "narrowing does not change the saved preference");
	sizing.node((node) => node.props["aria-label"] === "Resize panes").props.onMouseDown({ clientX: 1000, preventDefault() {} });
	sizing.windowEvent("mousemove", { clientX: 0 });
	sizing.windowEvent("mouseup");
	await sizing.settle();
	assert.equal(side().props.style.width, 426, "the drag uses the same cap as rendering");
	assert.equal(JSON.parse(sizing.storage.get("grok-code.settings.v1")).sideWidth, 560, "a drag stopped at the existing cap does not overwrite the preference");
	sizing.window.innerWidth = 1600;
	sizing.windowEvent("resize");
	timers.advance(100);
	await sizing.settle();
	assert.equal(side().props.style.width, 560, "widening restores the saved preference");
	sizing.window.innerWidth = 1100;
	sizing.windowEvent("resize");
	timers.advance(100);
	sizing.sidebar().onCollapse();
	await sizing.settle();
	sizing.node((node) => node.props["aria-label"] === "Resize panes").props.onMouseDown({ clientX: 1000, preventDefault() {} });
	sizing.windowEvent("mousemove", { clientX: 1001 });
	sizing.windowEvent("mouseup");
	await sizing.settle();
	assert.equal(side().props.style.width, 559, "a one-pixel drag with the sidebar collapsed does not jump");
}

async function checkReviewWorkspace() {
	const app = await composerWindow();
	const ordinary = (path, id) => ({ path, additions: 1, deletions: 0, hunks: [{ id, loc: "@@ -1 +1,2 @@", lines: [{ kind: "context", text: "Original" }, { kind: "add", text: "Added" }] }] });
	const snapshot = { ok: true, truncated: true, files: [ordinary("a.txt", "a-1"), ordinary("b.txt", "b-1"), { path: "conflict.txt", hunks: [{ id: "conflict-1", loc: "Conflict", reviewable: false, lines: [{ kind: "context", text: "Unresolved" }] }] }] };
	app.api.diff = async () => snapshot;
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	const props = () => app.node((node) => node.type === "DiffPane").props;
	const source = app.model().session.id;
	const view = harness();
	const update = async () => { await app.settle(); view.diffView(props()); };
	await update();
	assert.equal(view.fileFingerprint({ hunks: [{ id: "one" }, { id: "two" }] }), "one\ntwo");
	assert.equal(view.canMarkViewed(snapshot.files[0]), true);
	assert.equal(view.canMarkViewed(snapshot.files[2]), false);
	const progress = () => textOf(view.node((node) => node.props.className === "meta dp-progress"));
	const viewed = () => view.node((node) => node.type === "button" && node.props.className?.includes("dp-viewed-toggle"));
	const section = () => view.node((node) => node.type === "section" && node.props["aria-label"] === "Changes");
	const sectionKey = (key, target = "SECTION") => section().props.onKeyDown({ key, altKey: true, defaultPrevented: false, target: { tagName: target }, preventDefault() {} });
	const nav = (direction) => view.node((node) => node.type === "button" && node.props.title?.startsWith(`${direction} file (`));
	assert.equal(progress(), "0 of 3 viewed · more files were left out");
	assert.equal(nav("Previous").props.disabled, true);
	const scrollers = [];
	// The side scroller's top is at 100; the diff's Previous / Next bar is 600 px above it, so the bar sits at scrollTop 300.
	const side = { scrollTop: 900, getBoundingClientRect: () => ({ top: 100 }) };
	let barTop = -500;
	view.node((node) => node.props.className === "dp-body").props.ref.current = { scrollTo: () => scrollers.push("diff"), getBoundingClientRect: () => ({ top: barTop }) };
	section().props.ref.current = { focus() {}, querySelector: () => side };
	nav("Next").props.onClick();
	await update();
	assert.equal(props().selectedFile, "b.txt");
	same(scrollers, ["diff"], "a new file resets the Review diff scroller");
	assert.equal(side.scrollTop, 300, "a reader below the bar in the side pane returns to the bar, not to the list");
	side.scrollTop = 0;
	barTop = 400;
	nav("Previous").props.onClick();
	await update();
	assert.equal(side.scrollTop, 0, "a reader at the list stays at the list");
	sectionKey("ArrowDown", "TEXTAREA");
	await update();
	assert.equal(props().selectedFile, "a.txt", "typing does not navigate files");
	sectionKey("ArrowDown");
	await update();
	assert.equal(props().selectedFile, "b.txt");
	sectionKey("ArrowUp");
	await update();
	viewed().props.onClick();
	await update();
	assert.equal(props().viewed["a.txt"], "a-1");
	assert.equal(viewed().props["aria-pressed"], true);
	assert.equal(progress(), "1 of 3 viewed · more files were left out");
	assert.ok(view.node((node) => node.props["aria-label"] === "Viewed"));
	viewed().props.onClick();
	await update();
	assert.equal(props().viewed["a.txt"], undefined, "undoing Viewed clears the file fingerprint");
	viewed().props.onClick();
	await update();
	snapshot.files[0] = ordinary("a.txt", "a-2");
	props().onRefresh();
	await update();
	assert.equal(viewed().props["aria-pressed"], false, "a changed hunk loses Viewed");
	assert.equal(progress(), "0 of 3 viewed · more files were left out");

	const review = () => button(view, "Expand Changes");
	assert.equal(review().props["aria-pressed"], false);
	button(view, "Comment on line 1").props.onClick();
	view.render();
	view.node((node) => node.type === "textarea").props.onChange({ target: { value: "Retained draft" } });
	view.render();
	review().props.onClick();
	await update();
	assert.equal(section().props.className, "pane dp-review");
	assert.ok(app.node((node) => node.props.className === "side-col expanded"));
	assert.equal(view.node((node) => node.type === "textarea").props.value, "Retained draft");
	button(view, "Return Changes to the side").props.onClick();
	await update();
	assert.equal(view.node((node) => node.type === "textarea").props.value, "Retained draft", "toggle retains the comment draft without a remount");
	review().props.onClick();
	await update();
	let stopped = false;
	view.node((node) => node.type === "textarea").props.onKeyDown({ key: "Escape", nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() { stopped = true; } });
	view.render();
	assert.equal(stopped, true);
	assert.equal(view.node((node) => node.type === "textarea"), undefined);
	assert.equal(section().props.className, "pane dp-review", "comment Escape keeps the Review view");
	app.key({ key: "Escape" });
	await update();
	assert.equal(section().props.className, "pane");
	props().onSelectFile("conflict.txt");
	await update();
	assert.equal(viewed().props.disabled, true);
	assert.equal(nav("Next").props.disabled, true);
	props().onViewed("a.txt", "a-2");
	await app.settle();
	const next = await startSession(app, "Another review session");
	assert.notEqual(next, source);
	same(props().viewed, {}, "Viewed marks are isolated per session");
	app.sidebar().onSelect(source);
	await app.settle();
	assert.equal(props().viewed["a.txt"], "a-2", "returning to the session retains its marks");
	assert.equal(savedHistory(app).viewed, undefined, "Viewed is not saved to history");
}

async function checkProgressiveChanges() {
	const app = await composerWindow();
	const requests = [];
	const stops = [];
	app.api.readChanges = (input) => new Promise((resolve) => requests.push({ input, resolve }));
	app.api.stopChanges = async (id) => { stops.push(id); };
	const inventory = { ok: true, files: [{ path: "a.txt", hunks: [], additions: 8 }, { path: "b.txt", from: "old.txt", hunks: [], additions: 3 }] };
	const file = (path, id, truncated = false) => ({ path, truncated, hunks: [{ id, loc: "@@ -1 +1 @@", lines: [{ kind: "add", text: "changed" }] }] });
	const props = () => app.node((node) => node.type === "DiffPane").props;
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	assert.equal(props().loadingFiles, true);
	assert.equal(requests[0].input.file, undefined, "read the inventory first");
	requests[0].resolve(inventory);
	await app.settle();
	assert.equal(requests[1].input.file, "a.txt");
	assert.equal(props().loadingFile, true);
	props().onSelectFile("b.txt");
	await app.settle();
	assert.ok(stops.includes(requests[1].input.id), "changing files stops the previous patch load");
	assert.equal(requests[2].input.from, "old.txt", "a selected rename carries both literal paths");
	requests[1].resolve({ ok: true, files: [file("a.txt", "late")] });
	requests[2].resolve({ ok: true, files: [file("b.txt", "preview", true)] });
	await app.settle();
	assert.equal(props().snapshot.files[0].patchLoaded, undefined, "ignore the superseded patch reply");
	assert.equal(props().snapshot.files[1].truncated, true);
	assert.equal(props().snapshot.files[1].additions, 3, "patch loading keeps the inventory counts");
	props().onLoadFull();
	await app.settle();
	assert.equal(requests[3].input.full, true);
	props().onStopLoad();
	requests[3].resolve({ ok: true, files: [file("b.txt", "late-full")] });
	await app.settle();
	assert.ok(stops.includes(requests[3].input.id));
	assert.equal(props().fileError, "Diff loading stopped.");
	assert.equal(props().snapshot.files[1].hunks[0].id, "preview", "stopping a full load leaves the preview intact");
	props().onLoadFull();
	await app.settle();
	requests[4].resolve({ ok: true, files: [file("b.txt", "full")] });
	await app.settle();
	props().onViewed("b.txt", "full");
	props().onSelectFile("a.txt");
	await app.settle();
	assert.equal(props().snapshot.files[1].patchFingerprint, "full", "viewed metadata stays when the old patch body is released");
	assert.equal(props().snapshot.files[1].hunks.length, 0);
	props().onRefresh();
	await app.settle();
	assert.ok(stops.includes(requests[5].input.id));
	assert.equal(props().loadingFiles, true);
	same(props().snapshot.files.map((entry) => entry.path), ["a.txt", "b.txt"], "refresh leaves the rows mounted while the new inventory loads");
	requests[6].resolve(inventory);
	await app.settle();
	assert.equal(requests[7].input.file, "a.txt", "refresh rereads the selected patch against the new list");
	props().onScope("branch");
	await app.settle();
	assert.ok(stops.includes(requests[7].input.id));
	assert.equal(requests[8].input.scope, "branch");
	assert.equal(props().snapshot, undefined, "a previous scope's rows do not cross into the new scope");
	requests[8].resolve({ ok: false, error: "Reading changed files timed out." });
	await app.settle();
	assert.equal(props().snapshot.error, "Reading changed files timed out.");
	assert.equal(props().loadingFiles, false);
	props().onClose();
	await app.settle();
	requests.at(-1).resolve(inventory);
	await app.settle();
	const beforeReopen = requests.length;
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	assert.equal(requests.length, beforeReopen + 1, "reopening refreshes the file inventory even with the session rail visible");
	assert.equal(requests.at(-1).input.file, undefined);
	assert.equal(props().loadingFiles, true);
	requests.at(-1).resolve(inventory);
	await app.settle();
	assert.equal(requests.at(-1).input.file, "a.txt", "the selected patch starts after the refreshed inventory");
	console.log("PASS progressive Changes: list first, scoped patch loads, cancellation, retries, viewed metadata, and timeout errors");
}

async function checkCommitButtons() {
	const commitText = "Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `a.txt`. Don't push.";
	const pushText = "Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `a.txt`. Then push the branch.";
	const app = await composerWindow();
	const snapshot = { ok: true, files: [{ path: "a.txt", hunks: [], additions: 1, deletions: 0 }] };
	app.api.diff = async () => snapshot;
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	const props = () => app.node((node) => node.type === "DiffPane").props;
	const view = harness();
	view.diffView(props());
	assert.ok(button(view, "Commit"));
	assert.ok(button(view, "Commit and push"));
	const initialSends = app.sends.length;
	for (const label of ["Commit", "Commit and push"]) {
		button(view, label).props.onClick();
		await view.settle();
		assert.ok(view.node((node) => node.props.role === "dialog"));
		button(view, "Cancel").props.onClick();
		await view.settle();
		await app.settle();
		assert.equal(app.sends.length, initialSends, `${label} sends nothing when cancelled`);
	}
	button(view, "Commit").props.onClick();
	assert.equal(app.sends.length, initialSends, "opening the dialog sends nothing");
	await view.settle();
	button(view, "Ask Grok to commit").props.onClick();
	await view.settle();
	await app.settle();
	assert.equal(app.sends.at(-1).text, commitText, "the rendered Commit button sends the fixed request to this session");
	app.emit({ type: "done", uiSessionId: app.model().session.id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	view.diffView(props());
	button(view, "Commit and push").props.onClick();
	assert.equal(app.sends.length, initialSends + 1, "opening the push dialog sends nothing");
	await view.settle();
	button(view, "Ask Grok to commit").props.onClick();
	await view.settle();
	await app.settle();
	assert.equal(app.sends.at(-1).text, pushText, "the rendered push button sends its exact fixed request");
	const sent = app.sends.length;
	view.diffView(props());
	button(view, "Commit").props.onClick();
	await view.settle();
	assert.equal(button(view, "Ask Grok to commit").props.disabled, false, "the Grok choice remains available while busy");
	button(view, "Ask Grok to commit").props.onClick();
	await view.settle();
	await app.settle();
	assert.equal(app.sends.length, sent, "Commit queues while a turn is running");
	assert.equal(savedHistory(app).queued[app.model().session.id][0].text, commitText);
	for (const changed of [{ snapshot: { ok: true, files: [] } }, { snapshot: { ...snapshot, repo: false } }, { snapshot: { ...snapshot, ok: false } }, { scope: "branch" }, { scope: "abc1234" }]) {
		view.diffView({ ...props(), ...changed });
		assert.equal(button(view, "Commit"), undefined);
		assert.equal(button(view, "Commit and push"), undefined);
	}
}

async function checkRevertHunkBridge() {
	const app = await composerWindow();
	const hunk = { id: "a:one", loc: "@@ -1 +1 @@", revertible: true, lines: [{ kind: "del", text: "original" }, { kind: "add", text: "changed" }] };
	app.api.diff = async () => ({ ok: true, files: [{ path: "a.txt", hunks: [hunk] }] });
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	app.editor();
	await app.settle();
	const pane = () => app.node((node) => node.type === "DiffPane").props;
	const calls = [];
	app.api.revertHunk = async (...args) => { calls.push(args); app.files["a.txt"] = { text: "reverted\r\n", version: "reverted" }; return { ok: true }; };
	assert.equal((await pane().onRevertHunk("a.txt", hunk)).ok, true);
	await app.settle();
	same(calls, [[app.model().session.folder, "a.txt", hunk]], "the hunk route forwards the session folder and exact captured content");
	assert.equal(app.editor().open.text, "reverted\r\n", "a successful hunk revert refreshes the open file");
	app.api.revertHunk = async () => { throw new Error("Bridge lost"); };
	assert.equal((await pane().onRevertHunk("a.txt", hunk)).error, "That change could not be reverted.");
	delete app.api.revertHunk;
	assert.equal((await pane().onRevertHunk("a.txt", hunk)).error, "Reopen this window to revert this change.");
	console.log("PASS hunk revert app: captured file/content, editor refresh and rejected/missing bridge");
}

async function checkDirectCommitBridge() {
	const app = await composerWindow(controlledTimers());
	app.api.diff = async () => ({ ok: true, files: [{ path: "a.txt", hunks: [] }] });
	app.api.branchInfo = async () => ({ ok: true, branch: "feature", base: "main" });
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	const pane = () => app.node((node) => node.type === "DiffPane").props;
	pane().onRefresh();
	await app.settle();
	const folder = app.model().session.folder;
	const calls = [];
	let finish;
	app.api.gitCommit = (...args) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); };
	const input = { paths: ["a.txt"], message: "Fix it", push: false };
	const pending = pane().onCommit(input);
	await startSession(app, "Another session while the hook runs");
	finish({ ok: true, committed: true, sha: "abc1234", message: "Committed abc1234." });
	assert.equal((await pending).committed, true);
	await app.settle();
	same(calls, [[folder, { ...input, expected: "feature" }]], "the direct route uses the original session folder and displayed branch");
	assert.equal(app.notice(), "Committed abc1234.", "commit results survive switching sessions");
	assert.equal(pane().busy, true, "the pane receives the session's running state");
	app.document.querySelector = (selector) => selector === "[data-commit-dialog]" ? {} : null;
	const id = app.model().session.id;
	app.key({ key: "Escape" });
	app.key({ key: "n", ctrlKey: true });
	await app.settle();
	assert.deepEqual(app.cancels, [], "the commit dialog suppresses the window Stop shortcut");
	assert.equal(app.model().session.id, id, "the commit dialog suppresses new-session shortcuts");
	app.document.querySelector = () => null;
	app.api.gitCommit = async () => ({ ok: false, committed: true, sha: "abc1234", error: "Committed abc1234, but the push failed: offline" });
	const failed = await pane().onCommit({ ...input, push: true });
	await app.settle();
	assert.equal(app.notice(), failed.error, "partial-success errors reach the app notice");
	app.api.gitCommit = async () => { throw new Error("Bridge lost"); };
	const rejected = await pane().onCommit(input);
	await app.settle();
	assert.equal(rejected.error, "The commit could not be checked. Refresh to see what happened.");
	assert.equal(app.notice(), rejected.error);
	delete app.api.gitCommit;
	const missing = await pane().onCommit(input);
	await app.settle();
	assert.equal(missing.error, "Reopen this window to commit.");
	assert.equal(app.notice(), missing.error);
	const saved = savedHistory(app);
	const sandboxSession = saved.sessions.find((item) => item.id === id);
	sandboxSession.sandbox = { option: "profile" };
	const sandboxApp = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]), `?session=${id}`);
	sandboxApp.api.prCreate = async (...args) => { calls.push(args); return { ok: true }; };
	await sandboxApp.settle();
	sandboxApp.key({ key: "d", ctrlKey: true, shiftKey: true });
	await sandboxApp.settle();
	const sandboxPane = sandboxApp.node((node) => node.type === "DiffPane").props;
	assert.equal(sandboxPane.sandboxGit, true);
	await sandboxPane.onCreatePr();
	assert.equal(calls.at(-1)[2].sandbox, true, "the shared Create PR handler applies sandbox policy");
	sandboxApp.unmount();
	console.log("PASS direct commit app: original folder/branch, busy state, persistent notices, rejected/missing bridge and modal shortcut isolation");
}

async function checkRefreshScopes() {
	const app = await composerWindow();
	const calls = { diff: 0, branch: 0, pr: 0, commits: 0 };
	app.api.diff = async () => { calls.diff += 1; return { ok: true, files: [] }; };
	app.api.branchInfo = async () => { calls.branch += 1; return { ok: true, repo: false }; };
	app.api.prStatus = async () => { calls.pr += 1; return { ok: true, pr: null }; };
	app.api.listCommits = async () => { calls.commits += 1; return { ok: true, commits: [] }; };
	const reset = () => { for (const key of Object.keys(calls)) { calls[key] = 0; } };
	app.key({ key: "d", ctrlKey: true, shiftKey: true });
	await app.settle();
	assert.equal(calls.commits, 1, "opening Changes loads commit history");
	app.editor();
	await app.settle();
	reset();
	app.editor().onEdit("local edit");
	await app.settle();
	app.editor().onSave();
	await app.settle();
	same(calls, { diff: 1, branch: 1, pr: 0, commits: 0 }, "saving a file refreshes only local diff and branch information");
	for (const type of ["done", "error"]) {
		sendPrompt(app, `Finish with ${type}`);
		await app.settle();
		reset();
		const turn = app.sends.at(-1);
		app.emit({ type, uiSessionId: turn.uiSessionId, turnId: turn.turnId, message: "Stopped with an error" });
		await app.settle();
		same(calls, { diff: 1, branch: 1, pr: 1, commits: 1 }, `${type} refreshes local changes and remote metadata`);
	}
	reset();
	app.node((node) => node.type === "DiffPane").props.onRefresh();
	await app.settle();
	same(calls, { diff: 1, branch: 1, pr: 1, commits: 1 }, "manual refresh reloads both scopes");
}

async function checkHeaderBranch() {
	const app = harness(new Map([["grok-code.settings.v1", JSON.stringify({ railOpen: false })]]));
	const emptyFolder = "C:/no-repo";
	app.api.branchInfo = async (folder) => folder === emptyFolder ? { ok: true, repo: false } : { ok: true, branch: "git-topic" };
	const header = () => app.node((node) => node.props.className === "session-title");
	await app.settle();
	assert.match(textOf(header()), / · git-topic/, "the header reads Git with both Changes and the rail closed");
	app.pickedFolders.push(emptyFolder);
	app.node((node) => node.props.label === app.model().session.project).props.onClick();
	app.render();
	button(app, "Choose a folder").props.onClick();
	await app.settle();
	assert.doesNotMatch(textOf(header()), / · (git-topic|main)/, "a non-repository folder has no branch suffix");
	app.unmount();
}

async function checkSideDrafts() {
	const app = await composerWindow();
	const first = app.model().session.id;
	const second = await startSession(app, "Second session");
	app.key({ key: ";", ctrlKey: true });
	app.render();
	const side = () => app.node((node) => node.props["aria-label"] === "Side question").props;
	side().onChange({ target: { value: "Draft for the second session" } });
	app.sidebar().onSelect(first);
	app.render();
	assert.equal(side().value, "");
	side().onChange({ target: { value: "Draft for the first session" } });
	app.render();
	side().onKeyDown({ key: "Enter", preventDefault() {} });
	await app.settle();
	assert.equal(side().value, "");
	assert.equal(app.sends.at(-1).uiSessionId, `side-${first}`);
	app.sidebar().onSelect(second);
	app.render();
	assert.equal(side().value, "Draft for the second session");
	app.unmount();
}

async function checkComposerIme() {
	const app = await composerWindow();
	app.key({ key: ";", ctrlKey: true });
	app.render();
	const count = app.sends.length;
	for (const label of ["Prompt", "Side question"]) {
		const field = () => app.node((node) => node.props["aria-label"] === label).props;
		const draft = "編集中";
		field().onChange({ target: { value: draft } });
		app.render();
		field().onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { assert.fail(`${label} consumed the IME Enter`); } });
		await app.settle();
		assert.equal(app.sends.length, count, `${label} does not send while composing`);
		assert.equal(field().value, draft);
	}
	sendPrompt(app, "Keep answering");
	await app.settle();
	app.key({ key: "Escape", isComposing: true });
	await app.settle();
	assert.equal(app.cancels.length, 0, "IME Escape leaves the active turn alone");
	app.node((node) => node.props.className === "title-btn").props.onClick();
	await app.settle();
	const title = app.node((node) => node.props["aria-label"] === "Session title");
	title.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, target: { blur() { assert.fail("IME Enter submitted the title"); } } });
	const transcript = harness();
	transcript.view("chat", { ...app.model(), findTick: 1 });
	transcript.node((node) => node.props["aria-label"] === "Find in conversation").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { assert.fail("IME Enter advanced to the next result"); } });
	transcript.unmount();
	app.unmount();
}

async function checkSavedThinkingAndLegacySettings() {
	const app = await composerWindow();
	const id = app.model().session.id;
	for (const withTool of [false, true]) {
		sendPrompt(app, `Think ${withTool ? "with a tool" : "without tools"}`);
		await app.settle();
		const turnId = app.sends.at(-1).turnId;
		app.emit({ type: "thought", uiSessionId: id, turnId, text: "t".repeat(30000) });
		if (withTool) { app.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "thinking-tool", kind: "read", title: "Read", detail: "Ran" } }); }
		app.emit({ type: "done", uiSessionId: id, turnId });
		await app.settle();
		assert.equal(savedHistory(app).extraChats[id].at(-1).thought, `${"t".repeat(20000)}…`, "saved thinking is capped for every message");
		assert.equal(app.model().messages.at(-1).thought.length, 30000, "the in-memory thinking remains complete");
	}
	const storage = new Map([["grok-code.settings.v1", JSON.stringify({ appearance: "dark", modeByFolder: { "c:/old-project": "Auto-review" } })]]);
	const legacy = harness(storage);
	await legacy.settle();
	legacy.key({ key: ",", ctrlKey: true });
	await legacy.settle();
	const settings = legacy.node((node) => node.type?.name === "SettingsPage");
	assert.equal(settings.props.settings.appearance, "dark", "legacy folder-mode settings still load");
	settings.props.onClose();
	await legacy.settle();
	const baseline = legacy.settingsWrites.length;
	legacy.node((node) => node.props.label === "Normal").props.onClick();
	legacy.render();
	legacy.nodes().find((node) => node.props.className?.startsWith("mode-row") && [node.props.children].flat()[0] === "Auto-review").props.onClick();
	await legacy.settle();
	assert.equal(legacy.settingsWrites.length, baseline, "selecting a mode no longer writes the obsolete folder-mode setting");
}

async function checkBackgroundWorkHistory() {
	const task = (id, status = "completed", endedAt = Date.now()) => ({ id, label: `Task ${id}`, command: "Write-Output done", kind: "bash", status, startedAt: 100, endedAt: status === "running" ? 0 : endedAt, exitCode: status === "running" ? null : 0, outputFile: `C:/grok/sessions/task-${id}.log` });
	const agent = (id, status = "completed", extra = {}) => ({ id, label: `Agent ${id}`, agentType: "reviewer", model: "grok", status, ...extra });
	const app = await composerWindow();
	const id = app.model().session.id;
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [task("finished"), task("running", "running")] });
	app.emit({ type: "subagent", uiSessionId: id, subagent: agent("result", "running", { childSessionId: "child-session" }) });
	app.emit({ type: "subagent", uiSessionId: id, subagent: agent("result", "completed", { output: "r".repeat(8000), durationMs: 1234, tokensUsed: 321, toolCalls: 5 }) });
	app.emit({ type: "subagent", uiSessionId: id, subagent: { id: "result", label: "", agentType: "", model: "", status: "completed" } });
	app.emit({ type: "subagent", uiSessionId: id, subagent: agent("active", "running") });
	await app.settle();
	const work = () => savedHistory(app).backgroundWork;
	assert.equal(work()[id].tasks.length, 1, "running commands are never persisted");
	assert.equal(work()[id].agents.length, 1, "running subagents are never persisted");
	assert.equal(work()[id].agents[0].output.length, 2000, "saved subagent results are capped");
	const result = app.model().tasks.find((item) => item.label === "Agent result").info.subagent;
	assert.equal(result.output.length, 8000, "the in-memory subagent result stays intact");
	assert.equal(result.childSessionId, "child-session");
	assert.equal(result.durationMs, 1234);
	assert.equal(result.tokensUsed, 321);
	assert.equal(result.toolCalls, 5, "sparse updates retain completed metadata");
	const relaunch = harness(new Map(app.storage));
	await relaunch.settle();
	same(relaunch.model().tasks.map((item) => item.label).sort(), ["Agent result", "Task finished"], "finished commands and subagents survive relaunch");
	app.emit({ type: "bg-tasks", uiSessionId: `side-${id}`, tasks: [task("side")] });
	app.emit({ type: "subagent", uiSessionId: `side-${id}`, subagent: agent("side") });
	await app.settle();
	assert.equal(work()[`side-${id}`].tasks[0].id, "side", "side-chat work survives save cleanup");
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [task("new", "running")] });
	await app.settle();
	assert.equal(work()[id].tasks.find((item) => item.id === "running").status, "cancelled", "a missing running task is retired");
	assert.ok(work()[id].tasks.find((item) => item.id === "running").endedAt > 0);
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [], reset: true });
	await app.settle();
	assert.ok(work()[id].tasks.find((item) => item.id === "new").endedAt > 0, "reset timestamps cancelled commands");
	assert.ok(work()[id].agents.find((item) => item.id === "active").endedAt > 0, "reset timestamps cancelled subagents");
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [task("after-reset")] });
	await app.settle();
	for (const expected of ["finished", "running", "new", "after-reset"]) { assert.ok(work()[id].tasks.some((item) => item.id === expected), "new task lists retain finished work from prior processes"); }
	const sideRelaunch = harness(new Map(app.storage));
	await sideRelaunch.settle();
	assert.ok(sideRelaunch.model().tasks.some((item) => item.label === "Task side"));
	app.sidebar().onDelete(id);
	await app.settle();
	assert.equal(work()[id], undefined);
	assert.equal(work()[`side-${id}`], undefined, "deleting a session removes main and side background history");

	const capped = await composerWindow();
	const capId = capped.model().session.id;
	capped.emit({ type: "bg-tasks", uiSessionId: capId, tasks: [...Array.from({ length: 25 }, (_, index) => task(`done-${index}`, "completed", 1000 + index)), task("run-a", "running"), task("run-b", "running")] });
	for (let index = 0; index < 25; index++) { capped.emit({ type: "subagent", uiSessionId: capId, subagent: agent(`done-${index}`, "completed", { endedAt: 1000 + index }) }); }
	capped.emit({ type: "subagent", uiSessionId: capId, subagent: agent("run-a", "running") });
	capped.emit({ type: "subagent", uiSessionId: capId, subagent: agent("run-b", "running") });
	await capped.settle();
	const capWork = savedHistory(capped).backgroundWork[capId];
	assert.equal(capWork.tasks.length, 20);
	assert.equal(capWork.agents.length, 20);
	assert.equal(capWork.tasks[0].id, "done-24");
	assert.equal(capWork.tasks.at(-1).id, "done-5");
	assert.equal(capWork.agents[0].id, "done-24");
	assert.equal(capWork.agents.at(-1).id, "done-5");
	assert.equal(capped.model().tasks.filter((item) => item.running).length, 4, "caps retain all running work");
	const corrupt = savedHistory(capped);
	corrupt.backgroundWork[capId] = { tasks: [null, { id: "invalid" }, task("valid")], agents: [null, { id: "invalid", status: 3 }, agent("valid")] };
	corrupt.backgroundWork.invalid = { tasks: "bad", agents: [] };
	corrupt.backgroundWork.orphan = { tasks: [task("orphan")], agents: [] };
	corrupt.backgroundWork["side-orphan"] = { tasks: [], agents: [agent("orphan")] };
	const validated = harness(new Map([["grok-code.history.v1", JSON.stringify(corrupt)]]));
	await validated.settle();
	same(validated.model().tasks.map((item) => item.label).sort(), ["Agent valid", "Task valid"], "restore drops invalid items, records and orphan session keys");
	validated.sidebar().onRename(capId, "Trigger validated cleanup");
	await validated.settle();
	same(Object.keys(savedHistory(validated).backgroundWork), [capId]);

	const merged = await composerWindow();
	const first = merged.model().session.id;
	merged.emit({ type: "bg-tasks", uiSessionId: first, tasks: [task("first")] });
	await merged.settle();
	const second = await startSession(merged, "Second session");
	merged.emit({ type: "bg-tasks", uiSessionId: second, tasks: [task("second")] });
	await merged.settle();
	const external = savedHistory(merged);
	external.backgroundWork[first].tasks[0].label = "Changed in another window";
	merged.storage.set("grok-code.history.v1", JSON.stringify(external));
	merged.emit({ type: "bg-tasks", uiSessionId: second, tasks: [task("second-new")] });
	await merged.settle();
	assert.equal(savedHistory(merged).backgroundWork[first].tasks[0].label, "Changed in another window", "an unrelated session event preserves another window's background history");
}

function coldChatFiles(appWindow, files) {
	appWindow.api.readColdChat = (id) => {
		if (files.unreadable?.has(id)) { return false; }
		return files.has(id) ? files.get(id) : null;
	};
	appWindow.api.writeColdChat = (id, text) => {
		if (files.failWrites) { return false; }
		files.set(id, text);
		return true;
	};
	appWindow.api.removeColdChats = async (ids) => {
		for (const id of ids) { files.delete(id); }
	};
	return appWindow;
}

function coldChatFixture(id, chars) {
	return [{ id: `${id}-user`, role: "user", text: `Question for ${id}` }, { id: `${id}-reply`, role: "grok", text: "w".repeat(chars) }];
}

function coldHistoryValue(rows, extra = {}) {
	const now = Date.now();
	const sessions = rows.map(([id, , hours]) => ({ id, title: id, project: "project", folder: path.join(__dirname, ".."), branch: "main", worktree: "project", environment: "Local", status: "idle", detail: "Ready", when: "now", pinned: false, archived: false, source: "desktop", createdAt: now - hours * 3600000, lastActivityAt: now - hours * 3600000 }));
	const extraChats = Object.fromEntries(rows.filter(([, chars]) => chars).map(([id, chars]) => [id, coldChatFixture(id, chars)]));
	return JSON.stringify({ sessions, extraChats, modes: {}, prePlan: {}, editorDrafts: {}, deleted: [], ...extra });
}

async function checkColdChats() {
	const MILLION = 1000000;
	const key = "grok-code.history.v1";
	const three = [["old", 4 * MILLION, 30], ["mid", 4 * MILLION, 20], ["new", 4 * MILLION, 10]];
	const ids = (chat) => (chat ?? []).map((message) => message.id);
	const stored = (appWindow) => savedHistory(appWindow).extraChats;
	const open = async (storage, files, search = "") => {
		const appWindow = coldChatFiles(harness(storage, search), files);
		await appWindow.settle();
		return appWindow;
	};

	const files = new Map();
	const app = await open(new Map([[key, coldHistoryValue(three)]]), files);
	app.sidebar().onRename("new", "Trigger a save");
	await app.settle();
	same([...files.keys()], ["old", "mid"], "over the limit, the least recently active chats move until the value is near the target");
	same(Object.keys(stored(app)), ["new"], "moved chats leave the value");
	assert.ok(app.storage.get(key).length < 5 * MILLION, "the value is back under the target");
	same(ids(JSON.parse(files.get("old"))), ["old-user", "old-reply"], "a chat's file holds the whole chat");
	assert.equal(JSON.parse(files.get("old"))[1].text.length, 4 * MILLION);
	assert.equal(app.sidebar().chats.old[1].text.length, 4 * MILLION, "search and the transcript keep the moved chat in this window");
	app.sidebar().onRename("new", "Trigger another save");
	await app.settle();
	same(Object.keys(stored(app)), ["new"], "an unchanged moved chat does not come back to the value");

	const relaunch = await open(app.storage, files);
	same(Object.keys(relaunch.sidebar().chats).sort(), ["mid", "new", "old"], "a restart reads every moved chat back");
	relaunch.sidebar().onSelect("old");
	await relaunch.settle();
	same(ids(relaunch.model().messages), ["old-user", "old-reply"], "a restart shows every message");
	assert.equal(relaunch.model().messages[1].text.length, 4 * MILLION);

	sendPrompt(relaunch, "One more question");
	await relaunch.settle();
	const continued = ids(stored(relaunch).old);
	assert.equal(continued.length, 4, "a changed moved chat returns whole");
	same(continued.slice(0, 2), ["old-user", "old-reply"]);
	same(ids(JSON.parse(files.get("old"))), ["old-user", "old-reply"], "its file stays until the next move");
	relaunch.emit({ type: "done", uiSessionId: "old", turnId: relaunch.sends.at(-1).turnId });
	await relaunch.settle();
	const thirdRun = await open(relaunch.storage, files);
	same(ids(thirdRun.sidebar().chats.old), continued, "the value wins over a stale file");

	const pointed = [
		{ id: "first-user", role: "user", text: "First", point: { agentSessionId: "provider-session", index: 0 } },
		{ id: "first-reply", role: "grok", text: "First reply" },
		{ id: "second-user", role: "user", text: "Second", point: { agentSessionId: "provider-session", index: 1 } },
		{ id: "second-reply", role: "grok", text: "Second reply" },
	];
	const rewindRow = JSON.parse(coldHistoryValue([["rewound", 0, 5]]));
	rewindRow.sessions[0].agentSessionId = "provider-session";
	const rewindFiles = new Map([["rewound", JSON.stringify(pointed)]]);
	const rewound = await open(new Map([[key, JSON.stringify(rewindRow)]]), rewindFiles, "?session=rewound");
	rewound.api.files = async () => ({ ok: true, files: [] });
	rewound.api.rewind = async (input) => input.force ? { ok: true, done: true, revertedFiles: [] } : { ok: true, cleanFiles: [] };
	rewound.model().rewind(rewound.model().messages.find((message) => message.id === "second-user"));
	await rewound.settle();
	button(rewound, "Rewind conversation").props.onClick();
	await rewound.settle();
	same(ids(stored(rewound).rewound), ["first-user", "first-reply"], "a rewind cuts a moved chat");
	const afterRewind = await open(rewound.storage, rewindFiles, "?session=rewound");
	same(ids(afterRewind.model().messages), ["first-user", "first-reply"], "a rewind does not bring messages back from the stale file");

	app.sidebar().onDelete("mid");
	await app.settle();
	assert.equal(files.has("mid"), false, "deleting a session removes its file");
	assert.ok(savedHistory(app).deleted.includes("mid"));
	const sweepFiles = new Map([["gone", JSON.stringify(coldChatFixture("gone", 10))]]);
	const swept = await open(new Map([[key, coldHistoryValue([["kept", 10, 1]], { deleted: ["gone"] })]]), sweepFiles);
	assert.equal(sweepFiles.size, 0, "startup removes a file left behind for a deleted session");
	assert.equal(swept.sidebar().chats.gone, undefined);

	const failFiles = new Map();
	failFiles.failWrites = true;
	const failing = await open(new Map([[key, coldHistoryValue(three)]]), failFiles);
	failing.sidebar().onRename("new", "Trigger a save");
	await failing.settle();
	same(Object.keys(stored(failing)).sort(), ["mid", "new", "old"], "a failed write keeps every chat in the value");
	assert.equal(failing.notice(), undefined, "a failed move is not a failed save");
	failFiles.failWrites = false;
	failing.sidebar().onRename("new", "Try again");
	await failing.settle();
	same(Object.keys(stored(failing)), ["new"], "the next save moves them once writes work again");

	const runFiles = new Map();
	const running = await open(new Map([[key, coldHistoryValue([["idle", 4 * MILLION, 30], ["run", 5 * MILLION, 40]])]]), runFiles, "?session=run");
	same([...runFiles.keys()], [], "under the limit, nothing moves");
	sendPrompt(running, "p".repeat(2 * MILLION));
	await running.settle();
	same([...runFiles.keys()], ["idle"], "a running chat stays even when the value is still over the target");
	assert.ok(stored(running).run, "the running chat stays in the value");

	const windowFiles = new Map();
	const shared = new Map([[key, coldHistoryValue(three)]]);
	windowFiles.failWrites = true;
	const otherWindow = await open(shared, windowFiles, "?session=old");
	windowFiles.failWrites = false;
	const movingWindow = await open(shared, windowFiles, "?session=new");
	movingWindow.sidebar().onRename("new", "Trigger a save");
	await movingWindow.settle();
	same([...windowFiles.keys()], ["old", "mid"]);
	const fromFirstWindow = [...JSON.parse(windowFiles.get("old")), { id: "first-window", role: "grok", text: "Only the first window saw this" }];
	windowFiles.set("old", JSON.stringify(fromFirstWindow));
	sendPrompt(otherWindow, "From the second window");
	await otherWindow.settle();
	same(ids(stored(otherWindow).old).slice(0, 3), ["old-user", "old-reply", "first-window"], "a second window keeps the older messages of a chat the first window moved");
	assert.equal(ids(stored(otherWindow).old).length, 5);
	assert.equal(stored(otherWindow).mid, undefined, "the second window's unchanged copy stays out of the value");

	const brokenFiles = new Map([["bad", "{ not json"], ["stuck", JSON.stringify(coldChatFixture("stuck", 10))]]);
	brokenFiles.unreadable = new Set(["stuck"]);
	const broken = await open(new Map([[key, coldHistoryValue([["bad", 0, 3], ["stuck", 0, 2], ["fine", 10, 1]])]]), brokenFiles, "?session=stuck");
	assert.ok(broken.notices().some((text) => text.startsWith("An older chat could not be read")), "a file that can't be read is not silent");
	same(ids(broken.model().messages), []);
	brokenFiles.unreadable.clear();
	sendPrompt(broken, "Continue anyway");
	await broken.settle();
	same(ids(stored(broken).stuck).slice(0, 2), ["stuck-user", "stuck-reply"], "a file readable again keeps its messages when the chat continues");
	const heldFiles = new Map([["held", JSON.stringify(coldChatFixture("held", 10))]]);
	const held = await open(new Map([[key, coldHistoryValue([["held", 0, 1]])]]), heldFiles, "?session=held");
	heldFiles.unreadable = new Set(["held"]);
	sendPrompt(held, "Continue");
	await held.settle();
	same(ids(stored(held).held).slice(0, 2), ["held-user", "held-reply"], "when the file can't be read, the window's own copy keeps the older messages");

	const elsewhereFiles = new Map([["elsewhere", JSON.stringify(coldChatFixture("elsewhere", 10))]]);
	const adopting = await open(new Map([[key, coldHistoryValue([["here", 10, 1]])]]), elsewhereFiles);
	const withRow = (fields) => {
		const value = savedHistory(adopting);
		value.sessions.push({ ...JSON.parse(coldHistoryValue([["elsewhere", 0, 2]])).sessions[0], ...fields });
		adopting.storage.set(key, JSON.stringify(value));
	};
	withRow({ prWatch: { number: 12, branch: "main" } });
	adopting.storageEvent(key);
	await adopting.settle();
	same(ids(adopting.sidebar().chats.elsewhere), ["elsewhere-user", "elsewhere-reply"], "a session adopted from another window reads its moved chat");
	const opening = await open(new Map([[key, coldHistoryValue([["here", 10, 1]])]]), elsewhereFiles);
	const openingValue = savedHistory(opening);
	openingValue.sessions.push({ ...JSON.parse(coldHistoryValue([["elsewhere", 0, 2]])).sessions[0], agentSessionId: "01a19999-aaaa-7bbb-8ccc-ddddeeeeffff" });
	opening.storage.set(key, JSON.stringify(openingValue));
	opening.sidebar().onOpenCliSession("01a19999-aaaa-7bbb-8ccc-ddddeeeeffff");
	await opening.settle();
	same(ids(opening.model().messages), ["elsewhere-user", "elsewhere-reply"], "opening a session from another window reads its moved chat");

	const plain = harness(new Map([[key, coldHistoryValue(three)]]));
	await plain.settle();
	plain.sidebar().onRename("new", "Trigger a save");
	await plain.settle();
	same(Object.keys(stored(plain)).sort(), ["mid", "new", "old"], "with no file store, chats stay in the value");
	console.log("PASS moved chats: over the limit, restart, return to the value, rewind, delete, failed writes, running chats, two windows, unreadable files");
}

async function checkTaskDetails() {
	const app = await composerWindow();
	const timers = controlledTimers();
	const view = harness(new Map(), "", Date, timers);
	const outputCalls = [];
	const transcriptReads = [];
	const command = { id: "command-details", label: "Background ping", detail: "Command", running: true, info: { kind: "command", command: "ping -n 4 127.0.0.1", outputFile: "C:/logs/ping.log", exitCode: null, startedAt: 1000, endedAt: 0, status: "running" } };
	const model = { ...app.model(), tasks: [command], taskOutput: async (file) => { outputCalls.push(file); return { ok: true, text: outputCalls.length === 1 ? "First ping reply" : "Ping finished", truncated: true }; },
		subagentTranscript: (id) => new Promise((resolve, reject) => { transcriptReads.push({ id, resolve, reject }); }) };
	const row = () => view.node((node) => node.props.className === "bg-task-main");
	view.view("tasks", model);
	assert.equal(row().props.disabled, false, "native task rows with details can be clicked");
	row().props.onClick();
	await view.settle();
	assert.equal(row().props["aria-expanded"], true);
	assert.deepEqual(outputCalls, [command.info.outputFile]);
	assert.ok(textOf(view.render()).includes("First ping reply"));
	assert.ok(textOf(view.render()).includes("Showing the last 200 KB."));
	assert.ok(button(view, "Refresh"));
	const finished = { ...command, running: false, info: { ...command.info, status: "completed", endedAt: 4000, exitCode: 0 } };
	view.view("tasks", { ...model, tasks: [finished] });
	await view.settle();
	assert.equal(outputCalls.length, 2, "finishing an open command reloads its output once");
	assert.ok(textOf(view.render()).includes("Ping finished"));
	assert.ok(textOf(view.render()).includes("exit 0"));
	assert.equal(button(view, "Refresh"), undefined);
	view.view("tasks", { ...model, tasks: [finished] });
	await view.settle();
	assert.equal(outputCalls.length, 2, "an unrelated render does not reread output");
	view.view("tasks", { ...model, tasks: [{ ...finished, info: { ...finished.info, outputFile: "missing.log" } }], taskOutput: async () => ({ ok: false, error: "Log is gone" }) });
	await view.settle();
	assert.ok(textOf(view.render()).includes("Log is gone"));
	const agent = { id: "child-details", label: "Count files", detail: "Subagent", running: true, info: { kind: "agent", subagent: { id: "child", childSessionId: "child-session", agentType: "explore", model: "grok-4.7", status: "running", output: "Counting files" } } };
	const transcript = () => view.node((node) => node.props.className === "task-transcript");
	const readCount = async (ms, expected) => {
		timers.advance(ms);
		await view.settle();
		assert.equal(transcriptReads.length, expected);
	};
	view.view("tasks", { ...model, tasks: [agent] });
	row().props.onClick();
	await readCount(4000, 0);
	assert.equal(view.node((node) => node.type.name === "MessageBody").props.readOnly, true, "subagent results are observational");
	button(view, "Show transcript").props.onClick();
	await readCount(0, 1);
	assert.equal(transcriptReads[0].id, "child-session");
	assert.ok(textOf(view.render()).includes("Loading transcript..."));
	const log = "~~~text\n" + "Found src/example.ts\n".repeat(105000) + "~~~";
	const result = { ok: true, messages: [{ id: "p", role: "user", text: "List files" }, { id: "r", role: "grok", text: log, parts: [{ kind: "text", text: log }] }], truncated: true };
	transcriptReads[0].resolve(result);
	await view.settle();
	const block = transcript();
	assert.ok(block);
	const bodies = view.nodes(block).filter((node) => node.type.name === "MessageBody");
	assert.equal(bodies.length, 2);
	assert.ok(bodies.every((node) => node.props.readOnly), "every child transcript message is observational");
	const messageView = harness();
	const rendered = messageView.message({ ...model, messages: [bodies[1].props.message] }, true);
	const markdown = messageView.nodes(rendered).find((node) => node.type.name === "Markdown");
	const renderStart = performance.now();
	const largeTranscript = messageView.markdown(markdown.props);
	const renderMs = performance.now() - renderStart;
	assert.ok(textOf(largeTranscript).includes("Found src/example.ts"));

	await readCount(1999, 1);
	await readCount(1, 2);
	await readCount(6000, 2);
	assert.equal(transcript(), block, "a pending re-read leaves the transcript visible");
	const unchanged = structuredClone(result);
	const refreshStart = performance.now();
	transcriptReads[1].resolve(unchanged);
	await view.settle();
	const refreshMs = performance.now() - refreshStart;
	assert.equal(transcript(), block, "the same content does not rerender");
	await readCount(2000, 3);
	transcriptReads[2].reject(new Error("Temporary read failure"));
	await view.settle();
	assert.equal(transcript(), block, "a failed re-read leaves the last success visible");
	await readCount(2000, 4);
	row().props.onClick();
	await readCount(0, 4);
	assert.equal(row().props["aria-expanded"], false);
	transcriptReads[3].resolve(result);
	await readCount(6000, 4);
	assert.equal(transcript(), undefined, "an in-flight read cannot reopen the row");
	row().props.onClick();
	await readCount(0, 5);
	view.view("tasks", { ...model, tasks: [{ ...agent, running: false }] });
	await readCount(0, 5);
	transcriptReads[4].resolve(result);
	await readCount(0, 6);
	assert.ok(transcript(), "the last transcript remains visible while the final read is pending");
	const finalText = log + "\nFinished counting";
	transcriptReads[5].resolve({ ...result, messages: [result.messages[0], { ...result.messages[1], text: finalText, parts: [{ kind: "text", text: finalText }] }] });
	await readCount(6000, 6);
	assert.equal(view.nodes(transcript()).find((node) => node.props.message?.id === "r").props.message.text, finalText);
	console.log(`PASS subagent transcript: lazy load, serialized polling, failed reads, close and final refresh (2 MB fixture: ${Math.round(renderMs)} ms Markdown render, ${Math.round(refreshMs)} ms unchanged refresh in renderer harness)`);
}

async function checkLongMessages() {
	const app = harness();
	await app.settle();
	const lineHeight = 23;
	const limit = app.userClipBoxHeight(lineHeight);
	assert.equal(limit, app.USER_MESSAGE_LINES() * lineHeight);
	assert.equal(app.userClipOverflows(limit, limit), false, "a message as tall as the eight-line box stays open");
	assert.equal(app.userClipOverflows(limit + 1, limit), false, "one pixel of rounding stays open");
	assert.equal(app.userClipOverflows(limit + 2, limit), true, "text taller than the box collapses");
	const long = Array.from({ length: 12 }, (_, index) => `report line ${index}`).join("\n");
	const model = { ...app.model(), messages: [{ id: "long-user", role: "user", text: long }, { id: "long-reply", role: "grok", text: long }] };
	function watchClip(view) {
		view.window.getComputedStyle = () => ({ lineHeight: `${lineHeight}px` });
		let onResize = () => {};
		view.window.ResizeObserver = class {
			constructor(callback) { onResize = callback; }
			observe() {}
			disconnect() {}
		};
		return {
			at(scrollHeight) {
				const box = { scrollHeight };
				view.node((node) => node.props.className === "message-text").props.ref(box);
				view.render();
				return box;
			},
			resize(box, scrollHeight) {
				box.scrollHeight = scrollHeight;
				onResize();
				view.render();
			},
		};
	}
	const view = harness();
	view.message(model);
	const clip = watchClip(view);
	const box = clip.at(limit + 2);
	assert.equal(view.node((node) => node.props.className === "user-clip clipped").props.className, "user-clip clipped");
	clip.resize(box, limit);
	assert.equal(view.node((node) => node.props.className === "user-clip clipped"), undefined, "a wider column that fits the box opens");
	assert.equal(view.node((node) => node.props.children === "Show more"), undefined);
	clip.resize(box, limit + 2);
	assert.equal(view.node((node) => node.props.className === "user-clip clipped").props.className, "user-clip clipped", "a narrower column collapses again");
	const more = view.node((node) => node.type === "button" && node.props.children === "Show more");
	assert.equal(more.props["aria-expanded"], false);
	more.props.onClick();
	view.render();
	assert.equal(view.node((node) => node.type === "button" && node.props.children === "Show less").props["aria-expanded"], true);
	assert.equal(view.node((node) => node.props.className === "user-clip clipped"), undefined, "Show less removes the clip");
	const reply = harness();
	reply.message({ ...app.model(), messages: [{ id: "long-reply", role: "grok", text: long }] });
	assert.equal(reply.node((node) => node.props.children === "Show more"), undefined, "Grok's replies stay open");
	const found = harness();
	found.message(model, false, { find: "report line 11" });
	watchClip(found).at(limit + 2);
	assert.equal(found.node((node) => node.props.className === "user-clip clipped"), undefined, "a find match opens the whole message");
	assert.equal(found.node((node) => node.props.children === "Show more"), undefined);
	const missed = harness();
	missed.message(model, false, { find: "not in the report" });
	watchClip(missed).at(limit + 2);
	assert.ok(missed.node((node) => node.props.className === "user-clip clipped"));
	const short = harness();
	short.message({ ...app.model(), messages: [{ id: "short-user", role: "user", text: "hello" }] });
	watchClip(short).at(limit);
	assert.equal(short.node((node) => node.props.children === "Show more"), undefined);
}

async function checkReadOnlyMessages() {
	const app = await composerWindow();
	const links = [];
	const commands = [];
	const text = ["Read src/file.ts and `src/file.ts`.", "", "```powershell", "Get-Location", "```", "", "[relative](src/file.ts) [web](https://example.com/docs)"].join("\n");
	const model = { ...app.model(), session: { ...app.model().session, folder: "C:/project" }, folderFiles: { status: "ready", files: ["src/file.ts"] }, messages: [{ id: "child-text", role: "grok", text }], openLink: (href) => links.push(href), runInTerminal: (code) => commands.push(code) };
	const normal = harness();
	normal.message(model);
	const renderedNormal = normal.node((node) => node.type.name === "Markdown");
	const normalNodes = normal.nodes(renderedNormal.type(renderedNormal.props));
	assert.ok(normalNodes.some((node) => node.type.name === "FileButton"), "normal messages retain file links");
	assert.ok(normalNodes.some((node) => node.type === "button" && node.props.children === "Run"), "normal messages retain Run");
	const child = harness();
	child.message(model, true);
	const renderedChild = child.node((node) => node.type.name === "Markdown");
	const childNodes = child.nodes(renderedChild.type(renderedChild.props));
	assert.equal(childNodes.some((node) => node.type.name === "FileButton"), false, "child text never links to parent files");
	assert.equal(childNodes.some((node) => node.type === "button" && node.props.children === "Run"), false, "child commands cannot run in the parent checkout");
	assert.ok(childNodes.some((node) => node.type === "button" && node.props.children === "Copy"));
	for (const href of ["src/file.ts", "C:/project/src/file.ts", "file:///C:/project/src/file.ts"]) { renderedChild.props.onLink(href, {}); }
	assert.deepEqual(links, [], "explicit Markdown file links cannot open the parent checkout either");
	renderedChild.props.onLink("https://example.com/docs", {});
	assert.deepEqual(links, ["https://example.com/docs"], "web links still work");
	assert.deepEqual(commands, []);
}

async function checkEditDiffs() {
	const app = harness();
	const diff = { oldText: "a\nb\nc\nd\ne\nf\n", newText: "a\nb\nc\nX\ne\nf\n", oldLine: 10, newLine: 10 };
	same(app.editRows(diff), [
		{ kind: "context", text: "a", oldLine: 10, newLine: 10 },
		{ kind: "context", text: "b", oldLine: 11, newLine: 11 },
		{ kind: "context", text: "c", oldLine: 12, newLine: 12 },
		{ kind: "del", text: "d", oldLine: 13 },
		{ kind: "add", text: "X", newLine: 13 },
		{ kind: "context", text: "e", oldLine: 14, newLine: 14 },
		{ kind: "context", text: "f", oldLine: 15, newLine: 15 },
	]);
	same(app.editRows({ oldText: "", newText: "new\nfile\n" }).map((row) => [row.kind, row.text]), [["add", "new"], ["add", "file"]]);
	same(app.editRows({ oldText: "a", newText: "a\na" }).map((row) => [row.kind, row.text]), [["context", "a"], ["add", "a"]]);
	same(app.editRows({ oldText: "x\ny\nz", newText: "x\ny\ny\nz" }).map((row) => [row.kind, row.text]), [["context", "x"], ["context", "y"], ["add", "y"], ["context", "z"]]);
	const trimmed = app.editRows({ oldText: "a\nb\nc\nd\ne\nOLD\nf", newText: "a\nb\nc\nd\ne\nNEW\nf", oldLine: 10 });
	assert.equal(trimmed[0].text, "c");
	assert.equal(trimmed[0].oldLine, 12);
	assert.equal(trimmed.find((row) => row.kind === "del").oldLine, 15);
	assert.ok(app.editRows({ oldText: "", newText: "x" }).every((row) => row.oldLine === undefined && row.newLine === undefined));
	const model = { session: { folder: "C:/project" }, decide() {} };
	const row = harness();
	row.row({ tool: { id: "edit", kind: "edit", title: "Edit", path: "a.txt", detail: "Ran", additions: 6, deletions: 6, diff }, m: model });
	assert.ok(textOf(row.render()).includes("+1 −1"), "head counts match changed rows");
	row.node((node) => node.props.className === "tool-head").props.onClick();
	row.render();
	assert.ok(row.node((node) => node.type.name === "EditDiff"), "expanded edit has a diff");
	const longDiff = { oldText: "", newText: Array.from({ length: 205 }, (_, index) => "line " + index).join("\n") };
	const compact = app.editDiff({ diff: longDiff });
	assert.equal(app.nodes(compact).filter((node) => node.props.className === "dp-line dp-add").length, 200);
	assert.ok(textOf(compact).includes("5 more lines not shown."));
	assert.equal(app.nodes(app.editDiff({ diff: longDiff, all: true })).filter((node) => node.props.className === "dp-line dp-add").length, 205);
	for (const clipped of [false, true]) {
		for (const flag of ["whole", "replaceAll"]) {
			const approval = harness();
			approval.row({ tool: { id: "native-permission:edit", kind: "edit", title: "Edit", summary: "src/file.txt", detail: "Waiting for you", waiting: true, input: "COMPLETE RAW INPUT", diff: { ...diff, clipped, [flag]: true } }, m: model });
			const text = textOf(approval.render());
			assert.ok(text.includes("src/file.txt"), "native approval names its file without a path field");
			assert.equal(!!approval.node((node) => node.type.name === "EditDiff"), !clipped);
			assert.equal(text.includes("COMPLETE RAW INPUT"), clipped, "only clipped approvals use complete arguments");
			const notes = text + (clipped ? "" : textOf(app.editDiff({ diff: { ...diff, [flag]: true }, all: true })));
			assert.ok(notes.includes(flag === "whole" ? "Writes the whole file." : "Replaces every match in the file"));
			if (!clipped) { assert.equal(approval.node((node) => node.type.name === "EditDiff").props.all, true); }
		}
	}
	const controlDiff = Object.freeze({ oldText: "café\u202Eold\u202C", newText: "安全\u200Bnew\u2060" });
	for (const view of ["unified", "split"]) {
		for (const waiting of [false, true]) {
			const approval = harness();
			approval.row({ tool: { id: "control-edit", kind: "edit", title: "Edit", path: "a.txt", detail: waiting ? "Waiting for you" : "Ran", waiting, diff: controlDiff }, m: { ...model, view: "verbose", diffView: view } });
			const card = approval.node((node) => node.type.name === "EditDiff");
			assert.equal(card.props.diff, controlDiff, "approval rendering retains the original edit data");
			const painted = app.editDiff(card.props);
			const texts = app.nodes(painted).filter((node) => node.props.className === "dp-text").map(textOf);
			same(texts, waiting ? ["café⟦U+202E⟧old⟦U+202C⟧", "安全⟦U+200B⟧new⟦U+2060⟧"] : [controlDiff.oldText, controlDiff.newText], `${view} reveals controls only while the edit waits for approval`);
		}
	}
	const clipped = harness();
	clipped.row({ tool: { id: "clipped", kind: "edit", title: "Edit", detail: "Ran", additions: 300, deletions: 250, diff: { ...diff, clipped: true } }, m: model });
	assert.ok(textOf(clipped.render()).includes("+300 −250"), "clipped text keeps Grok's full counts");
	for (const detail of ["Failed", "Denied", "Not run"]) {
		const failed = harness();
		failed.row({ tool: { id: "failed-edit", kind: "edit", title: "Edit", path: "a.txt", detail, additions: 6, deletions: 6, diff }, m: { ...model, view: "verbose" } });
		assert.equal(failed.node((node) => node.type.name === "EditDiff"), undefined, detail + " hides the diff");
		assert.ok(textOf(failed.render()).includes("+6 −6"), detail + " keeps Grok's counts");
	}
	const saved = await composerWindow();
	const id = saved.model().session.id;
	sendPrompt(saved, "two edits");
	await saved.settle();
	for (const [toolId, length] of [["small", 1000], ["large", 9000]]) {
		saved.emit({ type: "tool", uiSessionId: id, turnId: saved.sends.at(-1).turnId, tool: { id: toolId, kind: "edit", title: "Edit", detail: "Ran", additions: 1, deletions: 2, diff: { oldText: "", newText: "x".repeat(length) } } });
	}
	await saved.settle();
	const tools = savedHistory(saved).extraChats[id].at(-1).tools;
	assert.equal(tools[0].diff.newText.length, 1000);
	assert.equal(tools[1].diff, undefined);
	same(tools.map((tool) => [tool.additions, tool.deletions]), [[1, 2], [1, 2]]);
	saved.emit({ type: "done", uiSessionId: id, turnId: saved.sends.at(-1).turnId });
	await saved.settle();
}

async function checkSplitDiffs() {
	const app = harness();
	const limit = app.SPLIT_MIN_WIDTH();
	assert.equal(app.splitFits(limit - 1), false);
	assert.equal(app.splitFits(limit), true);
	const replaced = { oldText: "a\nb\nc\nd\ne\nf\n", newText: "a\nb\nc\nX\ne\nf\n", oldLine: 10, newLine: 10 };
	const pairs = app.splitRows(app.editRows(replaced));
	same(pairs[0], { left: { kind: "context", text: "a", line: 10 }, right: { kind: "context", text: "a", line: 10 } });
	same(pairs.find((row) => row.left && row.left.kind === "del"), { left: { kind: "del", text: "d", line: 13 }, right: { kind: "add", text: "X", line: 13 } });
	same(app.splitRows(app.editRows({ oldText: "a\nb\nd", newText: "a\nX\nY\nd" })), [
		{ left: { kind: "context", text: "a" }, right: { kind: "context", text: "a" } },
		{ left: { kind: "del", text: "b" }, right: { kind: "add", text: "X" } },
		{ right: { kind: "add", text: "Y" } },
		{ left: { kind: "context", text: "d" }, right: { kind: "context", text: "d" } },
	]);
	same(app.splitRows(app.editRows({ oldText: "a\nb\nc\nd", newText: "a\nX\nd" })), [
		{ left: { kind: "context", text: "a" }, right: { kind: "context", text: "a" } },
		{ left: { kind: "del", text: "b" }, right: { kind: "add", text: "X" } },
		{ left: { kind: "del", text: "c" } },
		{ left: { kind: "context", text: "d" }, right: { kind: "context", text: "d" } },
	]);
	same(app.splitRows(app.editRows({ oldText: "a\nb\nc", newText: "a\nc" })), [
		{ left: { kind: "context", text: "a" }, right: { kind: "context", text: "a" } },
		{ left: { kind: "del", text: "b" } },
		{ left: { kind: "context", text: "c" }, right: { kind: "context", text: "c" } },
	]);
	same(app.splitRows(app.editRows({ oldText: "", newText: "only\n" })), [{ right: { kind: "add", text: "only" } }]);
	same(app.splitRows(app.editRows({ oldText: "gone\n", newText: "" })), [{ left: { kind: "del", text: "gone" } }]);
	const longLine = "L".repeat(400);
	const painted = app.editDiff({ diff: replaced, view: "split" });
	const changed = app.nodes(painted).find((node) => node.props.className === "edit-split-row" && app.nodes(node).some((cell) => cell.props.className === "edit-side dp-del"));
	const diffCells = (row, className) => app.nodes(row).filter((node) => node.props.className === className).map(textOf);
	same(diffCells(changed, "edit-marker"), ["−", "+"]);
	same(diffCells(changed, "dp-text"), ["d", "X"]);
	assert.ok(textOf(changed).includes("13"));
	assert.ok(textOf(app.editDiff({ diff: { oldText: longLine, newText: `M${longLine}` }, view: "split" })).includes(longLine), "a long line stays whole in the split view");
	const emptySide = app.editDiff({ diff: { oldText: "", newText: "only\n" }, view: "split" });
	assert.ok(app.nodes(emptySide).some((node) => node.props.className === "edit-side edit-side-empty"));
	assert.ok(textOf(emptySide).includes("+only"));
	const narrow = app.editDiff({ diff: { oldText: "+a", newText: "-b" }, view: "split", width: limit - 1 });
	assert.equal(app.nodes(narrow).find((node) => node.props.className === "edit-split-row"), undefined);
	same(diffCells(narrow, "edit-marker"), ["−", "+"]);
	same(diffCells(narrow, "dp-text"), ["+a", "-b"], "leading signs from the file stay in the code column");
	assert.ok(textOf(narrow).includes("Showing unified because this column is narrow."));
	assert.equal(app.nodes(narrow).find((node) => node.type === "button" && node.props.children === "Split").props["aria-pressed"], true, "a narrow column keeps the saved split choice");
	const wide = app.editDiff({ diff: { oldText: "a", newText: "b" }, view: "split", width: limit });
	assert.ok(app.nodes(wide).some((node) => node.props.className === "edit-split-row"));
	assert.equal(textOf(wide).includes("narrow"), false);
	const longDiff = { oldText: "", newText: Array.from({ length: 205 }, (_, index) => "line " + index).join("\n") };
	const compact = app.editDiff({ diff: longDiff, view: "split" });
	assert.equal(app.nodes(compact).filter((node) => node.props.className === "edit-side dp-add").length, 200);
	assert.ok(textOf(compact).includes("5 more lines not shown."));
	assert.equal(app.nodes(app.editDiff({ diff: longDiff, view: "split", all: true })).filter((node) => node.props.className === "edit-side dp-add").length, 205);
	const row = harness();
	let chosen = "";
	row.row({ tool: { id: "edit", kind: "edit", title: "Edit", path: "a.txt", detail: "Ran", diff: replaced }, m: { session: { folder: "C:/project" }, view: "verbose", diffView: "split", setDiffView(next) { chosen = next; } } });
	const card = () => row.node((node) => node.type.name === "EditDiff");
	assert.equal(card().props.view, "split");
	assert.equal(card().props.all, undefined, "a finished edit keeps the shorter diff");
	card().props.onView("unified");
	assert.equal(chosen, "unified");
	let measured = 0;
	let onResize = () => {};
	row.window.ResizeObserver = class { constructor(callback) { onResize = callback; } observe() {} disconnect() {} };
	const live = row.editDiff({ diff: replaced, view: "split", onWidth(next) { measured = next; } });
	const box = { clientWidth: 300 };
	row.nodes(live).find((node) => node.props.className === "edit-diff-wrap").props.ref(box);
	assert.equal(measured, 300);
	box.clientWidth = limit;
	onResize();
	assert.equal(measured, limit);
	card().props.onWidth(limit - 1);
	row.render();
	assert.equal(card().props.width, limit - 1);
	const fallback = row.editDiff(card().props);
	assert.ok(textOf(fallback).includes("Showing unified because this column is narrow."));
	const memory = harness();
	await memory.settle();
	assert.equal(memory.model().diffView, "unified");
	const choice = memory.editDiff({ diff: { oldText: "a", newText: "b" }, view: memory.model().diffView, onView: memory.model().setDiffView });
	memory.nodes(choice).find((node) => node.type === "button" && node.props.children === "Split").props.onClick();
	memory.render();
	assert.equal(memory.model().diffView, "split");
	assert.equal(JSON.parse(memory.storage.get("grok-code.settings.v1")).diffView, "split");
	const stored = harness();
	stored.storage.set("grok-code.settings.v1", JSON.stringify({ diffView: "sideways" }));
	assert.equal(stored.readSettings().diffView, "unified", "an unknown saved view falls back to unified");
	const stable = harness();
	let observers = 0;
	stable.window.ResizeObserver = class { constructor() { observers += 1; } observe() {} disconnect() {} };
	const onWidth = () => {};
	const sameProps = { diff: { oldText: "a", newText: "b" }, onWidth };
	const firstRef = stable.nodes(stable.editDiffView(sameProps)).find((node) => node.props.className === "edit-diff-wrap").props.ref;
	firstRef({ clientWidth: 800 });
	assert.equal(observers, 1);
	const secondRef = stable.nodes(stable.editDiffView(sameProps)).find((node) => node.props.className === "edit-diff-wrap").props.ref;
	// React 19 re-invokes a ref callback only when its identity changes.
	if (secondRef !== firstRef) { secondRef({ clientWidth: 800 }); }
	assert.equal(secondRef, firstRef);
	assert.equal(observers, 1, "re-rendering with the same props does not create another ResizeObserver");
}

async function checkSetupSheet() {
	const healthy = { grok: { ok: true, signedIn: true, version: "1.0.70" }, git: { ok: true }, gh: { ok: true, signedIn: true }, install: "INSTALL GROK" };
	const setupNode = (app) => app.node((node) => node.type.name === "Setup");
	const good = harness();
	let checks = 0;
	const requests = [];
	good.api.readiness = async (request) => { checks++; requests.push(request); return healthy; };
	await good.settle();
	assert.equal(setupNode(good), undefined, "healthy launch stays closed");
	assert.equal(checks, 1);
	same(requests[0], { folder: good.model().session.folder, full: false }, "the launch check stays light and names the session folder");
	const body = good.document.body = {};
	const opener = { isConnected: true, focus() { good.document.activeElement = this; } };
	good.document.activeElement = opener;
	good.key({ key: ",", ctrlKey: true });
	await good.settle();
	const settings = good.node((node) => node.type.name === "SettingsPage");
	const about = harness();
	about.settingsView({ ...settings.props, initialTab: "about" });
	assert.ok(button(about, "Check setup"), "About exposes setup checks");
	button(about, "Check setup").props.onClick();
	await good.settle();
	assert.equal(good.node((node) => node.type.name === "SettingsPage"), undefined);
	assert.ok(setupNode(good));
	assert.equal(checks, 2, "manual setup runs a fresh check");
	assert.ok(textOf(setupNode(good).type(setupNode(good).props)).includes("Grok is signed in."));
	const setupDialog = () => good.nodes(setupNode(good).type(setupNode(good).props)).find((node) => node.props.role === "dialog");
	const sheetRef = setupDialog().props.ref;
	const sheet = { focus() { good.document.activeElement = this; } };
	assert.equal(setupDialog().props.tabIndex, -1);
	sheetRef(sheet);
	assert.equal(good.document.activeElement, sheet, "Setup focuses the sheet on mount");
	setupNode(good).props.onCheck();
	await good.settle();
	assert.equal(checks, 3);
	same(requests.at(-1), { folder: good.model().session.folder, full: true }, "Check again requests full diagnostics for the session folder");
	assert.ok(setupNode(good), "healthy recheck keeps sheet open");
	assert.equal(setupDialog().props.ref, sheetRef, "a recheck does not remount the focus callback");
	good.emit({ type: "account", account: { email: "someone@example.com", plan: "SuperGrok", team: "", version: "1.0.60" } });
	await good.settle();
	setupNode(good).props.onCheck();
	await good.settle();
	assert.equal(good.sidebar().account.version, "1.0.70", "a setup check replaces the Grok version saved from an older session");
	assert.equal(good.sidebar().account.email, "someone@example.com", "and keeps the rest of the account");
	good.document.activeElement = body;
	good.key({ key: "Escape" });
	await good.settle();
	assert.equal(setupNode(good), undefined);
	assert.equal(good.node((node) => node.type.name === "SettingsPage").props.initialTab, "about", "Escape returns from Setup to About");
	good.node((node) => node.type.name === "SettingsPage").props.onCheckSetup();
	await good.settle();
	setupNode(good).props.onClose();
	await good.settle();
	const returned = good.node((node) => node.type.name === "SettingsPage");
	assert.equal(returned.props.initialTab, "about", "dismissing Setup also returns to About");
	returned.props.onClose();
	await good.settle();
	assert.equal(good.document.activeElement, opener, "closing the returned Settings restores the original opener");
	const missing = harness(new Map(good.storage));
	missing.api.readiness = async () => ({ ...healthy, grok: { ok: false, error: "Grok is not installed." } });
	await missing.settle();
	assert.ok(textOf(setupNode(missing).type(setupNode(missing).props)).includes("INSTALL GROK"));
	const keyed = harness();
	keyed.api.readiness = async () => ({ ...healthy, grok: { ok: true, signedIn: true, signIn: "key", apiKey: true, version: "1.0.70" } });
	await keyed.settle();
	assert.equal(setupNode(keyed), undefined, "an API key counts as signed in, so launch stays closed");
	const signedOut = harness(new Map(good.storage));
	signedOut.api.readiness = async () => ({ ...healthy, grok: { ok: true, signedIn: false } });
	await signedOut.settle();
	assert.ok(textOf(setupNode(signedOut).type(setupNode(signedOut).props)).includes("grok login"));
	sendPrompt(signedOut, "a running turn");
	await signedOut.settle();
	signedOut.key({ key: "Escape" });
	await signedOut.settle();
	assert.equal(setupNode(signedOut), undefined);
	assert.deepEqual(signedOut.cancels, [], "Escape closes setup without cancelling the turn");
	signedOut.emit({ type: "done", uiSessionId: signedOut.model().session.id, turnId: signedOut.sends.at(-1).turnId });
	await signedOut.settle();
	const overlap = harness();
	const results = [];
	overlap.api.readiness = () => new Promise((resolve) => results.push(resolve));
	await overlap.settle();
	overlap.key({ key: ",", ctrlKey: true });
	await overlap.settle();
	overlap.node((node) => node.type.name === "SettingsPage").props.onCheckSetup();
	await overlap.settle();
	assert.equal(results.length, 2);
	results[1]({ ...healthy, grok: { ok: true, signedIn: false, version: "SECOND" } });
	await overlap.settle();
	results[0]({ ...healthy, grok: { ok: false, error: "FIRST" } });
	await overlap.settle();
	const latest = setupNode(overlap);
	assert.equal(latest.props.result.grok.version, "SECOND", "older setup check cannot replace the newest result");
	assert.equal(latest.props.checking, false);
	const sheetText = (app) => textOf(setupNode(app).type(setupNode(app).props));
	const sheetButton = (app, label) => app.nodes(setupNode(app).type(setupNode(app).props)).find((node) => node.type === "button" && textOf(node) === label);
	const clicked = harness(new Map(good.storage));
	let installs = 0;
	let finishInstall;
	let installChecks = 0;
	const missingWin = { ...healthy, grok: { ok: false, error: "Grok is not installed." }, git: { ok: false }, platform: "win32" };
	clicked.api.readiness = async () => { installChecks += 1; return missingWin; };
	clicked.api.installGrok = () => new Promise((resolve) => { installs += 1; finishInstall = resolve; });
	await clicked.settle();
	assert.equal(installChecks, 1);
	assert.ok(sheetText(clicked).includes("Install Grok CLI"));
	assert.ok(sheetText(clicked).includes("Or run this in a terminal:"));
	assert.ok(sheetText(clicked).includes("Installing the Grok CLI also installs Git."));
	sheetButton(clicked, "Install Grok CLI").props.onClick();
	clicked.render();
	assert.equal(installs, 1, "the button calls installGrok");
	assert.equal(sheetButton(clicked, "Installing…").props.disabled, true);
	assert.equal(installChecks, 1, "readiness waits until the install finishes");
	finishInstall({ ok: true });
	await clicked.settle();
	assert.equal(installChecks, 2, "a finished install checks readiness again");
	assert.ok(setupNode(clicked), "the sheet stays open after installing");
	const failed = harness(new Map(good.storage));
	failed.api.readiness = async () => missingWin;
	failed.api.installGrok = async () => ({ ok: false, error: "The Grok installer failed." });
	await failed.settle();
	sheetButton(failed, "Install Grok CLI").props.onClick();
	await failed.settle();
	assert.equal(failed.notice(), "The Grok installer failed.");
	const Setup = setupNode(clicked).type;
	const baseProps = setupNode(clicked).props;
	const gitSheet = (result) => textOf(Setup({ ...baseProps, result, installing: "" }));
	const gitMissing = { ...healthy, git: { ok: false } };
	const winGit = gitSheet({ ...gitMissing, platform: "win32" });
	assert.ok(winGit.includes("Git is not installed."));
	assert.ok(winGit.includes("Install Git from git-scm.com."));
	const darwin = gitSheet({ ...gitMissing, platform: "darwin" });
	assert.ok(darwin.includes("Install Git"));
	assert.ok(darwin.includes("Apple's window installs the Command Line Tools, which include Git. Press Check again when it finishes."));
	assert.ok(gitSheet({ ...gitMissing, platform: "linux" }).includes("Install Git with your package manager."));
	const diagnostic = {
		...healthy,
		app: { version: "0.7.0", electron: "39.0.0", os: "win32 10.0.26300 x64" },
		grok: { ok: true, signedIn: true, signInMode: "grok", version: "1.0.77", at: { source: "installer", path: "~/.grok/bin/grok.exe" }, update: { checked: true, current: "1.0.77", latest: "1.0.77", available: false, autoUpdate: true, channel: "stable" }, token: "SECRET", email: "PRIVATE" },
		config: { ok: true, files: [{ role: "user", path: "~/.grok/config.toml", broken: false }], warnings: ["hooks (unrecognized config key)", "privacy (unrecognized config key)"] },
		hooks: "SECRET", permissions: "SECRET", mcpServers: "SECRET", env: "SECRET",
	};
	const expectedReport = [
		"Codewomplers Grok Desktop 0.7.0, Electron 39.0.0, win32 10.0.26300 x64",
		"Grok 1.0.77, stable channel, runs from ~/.grok/bin/grok.exe (installer)",
		"Grok update: up to date",
		"Grok sign-in: signed in",
		"Grok config: ~/.grok/config.toml; can't read: none; warnings: hooks (unrecognized config key), privacy (unrecognized config key)",
		"Git: installed",
		"GitHub CLI: signed in",
	].join("\n");
	assert.equal(good.supportReport(diagnostic), expectedReport, "the report contains only the specified facts in order");
	const password = "s3cret-pass";
	const apiKey = "key-value-should-not-appear";
	const keyReport = good.supportReport({
		...diagnostic,
		grok: { ...diagnostic.grok, signIn: "key", apiKey: true },
		network: { httpsProxy: "http://proxy.corp:8080", httpProxy: "not set", noProxy: "localhost", caCerts: "~/.certs/corp.pem (missing)" },
		proxyUrl: `http://proxyuser:${password}@proxy.corp:8080`,
		XAI_API_KEY: apiKey,
	});
	assert.equal(keyReport, [
		expectedReport.replace("Grok sign-in: signed in", "Grok sign-in: API key (XAI_API_KEY)"),
		"HTTPS proxy: http://proxy.corp:8080",
		"HTTP proxy: not set",
		"NO_PROXY: localhost",
		"Extra CA certificates: ~/.certs/corp.pem (missing)",
	].join("\n"));
	assert.equal(keyReport.includes(password), false);
	assert.equal(keyReport.includes("proxyuser"), false);
	assert.equal(keyReport.includes(apiKey), false);
	assert.equal(keyReport.includes("SECRET"), false);
	assert.equal(keyReport.includes("PRIVATE"), false);
	const savedReport = good.supportReport({ ...diagnostic, grok: { ...diagnostic.grok, signIn: "saved", apiKey: true } });
	assert.ok(savedReport.includes("Grok sign-in: saved sign-in"));
	assert.ok(good.supportReport({ ...diagnostic, grok: { ...diagnostic.grok, signIn: "none", signedIn: false } }).includes("Grok sign-in: not signed in"));
	assert.ok(!savedReport.includes("an API key is also set"));
	assert.equal(savedReport.includes(apiKey), false);
	assert.ok(gitSheet({ ...diagnostic, grok: { ok: true, signedIn: true, signIn: "key", apiKey: true, keySource: "env" } }).includes("API key (XAI_API_KEY)"));
	assert.ok(gitSheet({ ...diagnostic, grok: { ok: true, signedIn: true, signIn: "key", signInMode: "key", keySource: "app" } }).includes("API key (saved in this app)"));
	const rejectedKey = gitSheet({ ...diagnostic, grok: { ok: true, signedIn: false, signIn: "none", signInMode: "key", keyRejected: true } });
	assert.ok(rejectedKey.includes("Grok rejected the API key, or couldn't reach xAI to check it."));
	assert.ok(!rejectedKey.includes("grok login"));
	assert.ok(!gitSheet({ ...diagnostic, grok: { ok: true, signedIn: true, signIn: "key", apiKey: true } }).includes("grok login"));
	assert.ok(gitSheet({ ...diagnostic, grok: { ...diagnostic.grok, signIn: "saved", apiKey: true } }).includes("XAI_API_KEY is also set. Grok uses the saved sign-in while it exists."));
	assert.ok(gitSheet({ ...diagnostic, network: { httpsProxy: "http://proxy.corp:8080", httpProxy: "not set", noProxy: "localhost", caCerts: "~/.certs/corp.pem (found)" } }).includes("HTTPS proxy: http://proxy.corp:8080"));
	assert.ok(gitSheet({ ...diagnostic, network: { httpsProxy: "http://proxy.corp:8080", httpProxy: "not set", noProxy: "localhost", caCerts: "~/.certs/corp.pem (found)" } }).includes("Extra CA certificates: ~/.certs/corp.pem (found)"));
	assert.equal(good.supportReport({ grok: { ok: false, error: "Missing" }, git: { ok: false }, gh: { ok: false } }), "Grok: not installed (Missing)\nGit: not installed\nGitHub CLI: not installed", "missing diagnostics are omitted without undefined values");
	let copied;
	const copySheet = Setup({ ...baseProps, result: diagnostic, onCopy: (text) => { copied = text; } });
	good.nodes(copySheet).find((node) => node.type === "button" && textOf(node) === "Copy support report").props.onClick();
	assert.equal(copied, expectedReport);
	assert.equal(good.nodes(Setup({ ...baseProps, result: undefined })).find((node) => node.type === "button" && textOf(node) === "Copy support report").props.disabled, true);
	const brokenConfig = { ...diagnostic, config: { ...diagnostic.config, files: [{ role: "user", path: "~/.grok/config.toml", broken: true }] } };
	assert.ok(gitSheet(brokenConfig).includes("Grok can't read ~/.grok/config.toml, so its settings aren't used."));
	assert.ok(!gitSheet(brokenConfig).includes("reads its config without problems"), "a broken file is not reported as healthy");
	assert.ok(gitSheet({ ...diagnostic, config: { ok: false } }).includes("Grok's config couldn't be read."));
	assert.ok(gitSheet({ ...diagnostic, config: { ok: true, files: [], warnings: [] } }).includes("Grok reads its config without problems."));
	assert.ok(gitSheet(diagnostic).includes("Grok reads its config without problems."), "Grok's own warnings about keys it still loads don't show as problems");
	assert.ok(!gitSheet(diagnostic).includes("unrecognized config key"), "the sheet leaves Grok's config warnings to the report");
	assert.ok(gitSheet({ ...diagnostic, grok: { ...diagnostic.grok, update: { checked: false } } }).includes("Grok couldn't check for a newer version."));
	assert.ok(good.supportReport({ ...diagnostic, grok: { ...diagnostic.grok, update: { checked: false } } }).includes("Grok update: not checked"));
	const updating = harness();
	const updateRequests = [];
	const available = { ...diagnostic, grok: { ...diagnostic.grok, update: { ...diagnostic.grok.update, latest: "1.0.78", available: true } } };
	updating.api.readiness = async (request) => { updateRequests.push(request); return available; };
	let updates = 0;
	let finishUpdate;
	updating.api.updateGrokCli = () => new Promise((resolve) => { updates++; finishUpdate = resolve; });
	await updating.settle();
	sendPrompt(updating, "/doctor");
	await updating.settle();
	assert.ok(sheetText(updating).includes("Grok 1.0.78 is available."));
	assert.ok(sheetText(updating).includes("Runs from ~/.grok/bin/grok.exe, the Grok installer's copy."));
	sheetButton(updating, "Update Grok").props.onClick();
	updating.render();
	assert.equal(updates, 1, "Update Grok calls the mocked updateGrokCli");
	assert.equal(sheetButton(updating, "Updating…").props.disabled, true);
	assert.equal(updateRequests.length, 2, "diagnostics wait until updating finishes");
	finishUpdate({ ok: true });
	await updating.settle();
	assert.equal(updateRequests.length, 3, "a finished Grok update checks readiness again");
	same(updateRequests.at(-1), { folder: updating.model().session.folder, full: true });
	assert.ok(updating.supportReport(available).includes("Grok update: 1.0.78 available"));
	updating.api.updateGrokCli = async () => { throw new Error("offline"); };
	sheetButton(updating, "Update Grok").props.onClick();
	await updating.settle();
	assert.equal(updating.notice(), "Updating Grok failed.");
	console.log("PASS doctor sheet: light launch, full folder checks, Grok update flow, config diagnostics and safe support reports");
}

function referenceFileHits(text, known, tools) {
	const escape = (value) => value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
	const relative = (raw) => {
		const value = raw.trim().replace(/^[@\u0060]+|[\u0060]+$/g, "").replace(/^"+|"+$/g, "");
		if (!value || value.length > 300 || /[\0\r\n]/.test(value)) { return ""; }
		const folderKey = "c:/project";
		let slash = value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
		if (/^[a-z]:/i.test(slash) || slash.startsWith("/")) {
			if (!slash.toLowerCase().startsWith(folderKey + "/")) { return ""; }
			slash = slash.slice(folderKey.length + 1);
		}
		if (!slash || slash.split("/").some((part) => part === ".." || part === ".")) { return ""; }
		const matches = known.filter((file) => file.toLowerCase() === slash.toLowerCase());
		if (matches.length) {
			const knownHit = matches.find((file) => file === slash) || (matches.length === 1 ? matches[0] : "");
			return knownHit;
		}
		if (/\s/.test(slash)) { return ""; }
		if (/^[\w.@][\w.@/-]*\.[A-Za-z0-9]{1,8}$/.test(slash) && (slash.includes("/") || /\.(?:[cm]?[jt]sx?|json|md|txt|css|s[ac]ss|html?|xml|ya?ml|toml|ini|sql|asp|inc|vbs|asa|py|rb|go|rs|[ch]|cpp|hpp|sh|ps1|png|jpe?g|gif|svg|webp)$/i.test(slash))) { return slash; }
		return "";
	};
	const found = new Map();
	const add = (raw, range, occurrence) => {
		const file = relative(raw);
		if (!file) { return; }
		let hit = found.get(file);
		if (!hit) { hit = { file, range, occurrences: [] }; found.set(file, hit); }
		if (occurrence) { hit.occurrences.push(occurrence); }
	};
	for (const tool of tools) {
		const match = /(\d+)\s*[–-]\s*(\d+)/.exec(tool.detail);
		const start = Number(match?.[1]);
		const end = Number(match?.[2]);
		add(tool.title, start && end >= start && end - start <= 80 ? { start, end } : null);
		if (tool.summary && tool.summary !== tool.title) { add(tool.summary, null); }
	}
	const spans = [];
	const groups = new Map();
	for (const file of known) {
		const key = file.toLowerCase();
		const group = groups.get(key);
		if (group) { group.push(file); } else { groups.set(key, [file]); }
	}
	const partialPathAt = (index) => /[^\s]+\/[^.\s]*\s+$/.test(text.slice(0, index).replace(/\\/g, "/"));
	for (const file of [...new Set([...known, ...found.keys()])].sort((left, right) => right.length - left.length)) {
		const root = "C:/project";
		const candidates = [root + "/" + file, (root + "/" + file).replace(/\//g, "\\"), file];
		const variants = groups.get(file.toLowerCase());
		const pattern = new RegExp("(?:^|[^\\w./\\\\:-])(" + candidates.map(escape).join("|") + ")(?=$|[^\\w./\\\\-])", variants && variants.length > 1 ? "g" : "gi");
		for (const match of text.matchAll(pattern)) {
			const start = (match.index ?? 0) + match[0].length - match[1].length;
			if (spans.some((span) => start >= span.start && start < span.end) || (!file.includes("/") && partialPathAt(start))) { continue; }
			const span = { start, end: start + match[1].length };
			spans.push(span);
			add(file, null, span);
		}
	}
	for (const match of text.matchAll(/[@\u0060]?(?:[A-Za-z]:)?[\w.@/\\-]+\.[A-Za-z0-9]{1,8}/g)) {
		const start = match.index ?? 0;
		if (spans.some((span) => start >= span.start && start < span.end) || (!/[\\/]/.test(match[0]) && partialPathAt(start))) { continue; }
		const prefix = match[0].match(/^[@\u0060]+/)?.[0].length ?? 0;
		add(match[0], null, { start: start + prefix, end: start + match[0].length });
	}
	return [...found.values()];
}

async function checkFileLinkIndex() {
	const app = harness();
	const known = ["src/Foo.ts", "Foo.ts", "docs/My Notes.md", "readme.md", "README.md", "a.ts", "long/a.ts"];
	const cases = [
		{ text: "Read C:/project/src/Foo.ts and C:\\project\\src\\Foo.ts." },
		{ text: "Read src/ Foo.ts, docs/My Notes.md and SRC/FOO.TS." },
		{ text: "Compare long/a.ts, a.ts, and README.MD." },
		{ text: "other/src/Foo.ts", tools: [{ title: "other/src/Foo.ts", detail: "Lines 3-5" }] },
	];
	for (const item of cases) { same(app.fileHits(item.text, known, item.tools ?? []), referenceFileHits(item.text, known, item.tools ?? []), "indexed links preserve the previous algorithm"); }
	const caseText = "Open src/Foo.ts and src/foo.ts.";
	const caseHits = app.fileHits(caseText, ["src/Foo.ts", "src/foo.ts"]);
	same(caseHits.flatMap((hit) => hit.occurrences.map((span) => [caseText.slice(span.start, span.end), hit.file])), [["src/Foo.ts", "src/Foo.ts"], ["src/foo.ts", "src/foo.ts"]], "each case variant opens its own file");
	same(app.fileHits("Open SRC/FOO.TS.", ["src/Foo.ts"]).map((hit) => hit.file), ["src/Foo.ts"], "one case variant still matches either spelling");
	same(app.fileHits("Open SRC/FOO.TS.", ["src/Foo.ts", "src/foo.ts"]), [], "a third spelling does not pick between two case variants");
	app.unmount();
}

async function checkFileListIdentityAndLimit() {
	const app = await composerWindow();
	const previous = app.model().folderFiles.files;
	const id = app.model().session.id;
	sendPrompt(app, "refresh without changes");
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(app.model().folderFiles.files, previous, "unchanged reload preserves the file array and message-link cache");
	app.files["deep/new.txt"] = { text: "new", version: "1" };
	sendPrompt(app, "refresh after new file");
	await app.settle();
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.notEqual(app.model().folderFiles.files, previous);
	assert.ok(app.model().folderFiles.files.includes("deep/new.txt"));
	const props = app.editor();
	const files = Array.from({ length: 600 }, (_, index) => "deep/file-" + String(index).padStart(3, "0") + ".txt");
	const list = harness();
	list.filesView({ ...props, files: { status: "ready", files } });
	const rows = () => list.nodes().filter((node) => node.type === "button" && files.includes(node.props.title));
	assert.equal(rows().length, 500);
	assert.ok(textOf(list.render()).includes("Showing 500 of 600. Type to filter."));
	list.node((node) => node.type === "input").props.onChange({ target: { value: "file-599" } });
	list.render();
	assert.equal(rows().length, 1, "filter includes files beyond the visible cut");
}

async function checkModeRestartWarnings() {
	const menu = (app) => { app.node((node) => ["Normal", "Plan", "Auto-review", "Always-approve"].includes(node.props.label)).props.onClick(); app.render(); };
	const warned = (app) => app.nodes().filter((node) => node.props.className?.startsWith("mode-row") && textOf(node).includes("next message restarts Grok"));
	const task = { id: "bg", label: "Background", kind: "bash", command: "ping", status: "running", exitCode: null, startedAt: 1, endedAt: 0 };
	const fresh = harness();
	await fresh.settle();
	fresh.emit({ type: "bg-tasks", uiSessionId: fresh.model().session.id, tasks: [task] });
	await fresh.settle();
	menu(fresh);
	assert.equal(warned(fresh).length, 0, "no warning before a main-chat send");
	const app = await composerWindow();
	const id = app.model().session.id;
	app.emit({ type: "bg-tasks", uiSessionId: "side-" + id, tasks: [task] });
	await app.settle();
	menu(app);
	assert.equal(warned(app).length, 0, "side-chat background work is excluded");
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [task] });
	await app.settle();
	same(warned(app).map((node) => node.props.children[0]), ["Auto-review", "Always-approve"]);
	assert.ok(warned(app).every((node) => textOf(node).includes("stops 1 running background task.")));
	app.emit({ type: "subagent", uiSessionId: id, subagent: { id: "agent", label: "Agent", status: "running" } });
	await app.settle();
	assert.ok(warned(app).every((node) => textOf(node).includes("stops 2 running background tasks.")));
	app.emit({ type: "bg-tasks", uiSessionId: id, tasks: [{ ...task, status: "completed", endedAt: 2, exitCode: 0 }] });
	app.emit({ type: "subagent", uiSessionId: id, subagent: { id: "agent", label: "Agent", status: "completed" } });
	await app.settle();
	assert.equal(warned(app).length, 0, "finished work needs no warning");
	const rejected = await composerWindow();
	const rejectedId = rejected.model().session.id;
	rejected.emit({ type: "bg-tasks", uiSessionId: rejectedId, tasks: [task] });
	await rejected.settle();
	menu(rejected);
	warned(rejected).find((node) => node.props.children[0] === "Always-approve").props.onClick();
	await rejected.settle();
	assert.deepEqual(rejected.modeChanges.at(-1), { id: rejectedId, mode: "Always-approve" }, "the mode chip asks the host before it changes");
	assert.equal(rejected.node((node) => node.type.name === "MenuButton" && node.props.icon === "shield").props.label, "Always-approve");
	rejected.api.send = async (input) => { rejected.sends.push(input); return { ok: false, error: "That folder is missing." }; };
	sendPrompt(rejected, "rejected before Grok");
	await rejected.settle();
	menu(rejected);
	same(warned(rejected).map((node) => node.props.children[0]), ["Auto-review", "Always-approve"], "rejected send preserves the previous accepted mode");
	const stayed = await composerWindow();
	const stayedId = stayed.model().session.id;
	const chip = () => stayed.node((node) => node.type.name === "MenuButton" && node.props.icon === "shield").props.label;
	assert.equal(chip(), "Normal");
	stayed.api.setMode = async () => ({ ok: false, error: "Grok did not change mode." });
	menu(stayed);
	stayed.nodes().find((node) => node.props.className?.startsWith("mode-row") && node.props.children[0] === "Plan").props.onClick();
	await stayed.settle();
	assert.equal(chip(), "Normal", "a refused mode change leaves the chip where it was");
	assert.equal(stayed.notice(), "Grok did not change mode.");
	assert.equal(stayedId, stayed.model().session.id);
	const raced = await composerWindow();
	const racedChip = () => raced.node((node) => node.type.name === "MenuButton" && node.props.icon === "shield").props.label;
	const openMenu = () => { raced.node((node) => ["Normal", "Plan", "Auto-review", "Always-approve"].includes(node.props.label)).props.onClick(); raced.render(); };
	const pick = (mode) => raced.nodes().find((node) => node.props.className?.startsWith("mode-row") && node.props.children[0] === mode).props.onClick();
	const pending = [];
	raced.api.setMode = (sessionId, mode) => new Promise((resolve) => {
		raced.modeChanges.push({ id: sessionId, mode });
		pending.push(resolve);
	});
	openMenu();
	pick("Plan");
	raced.render();
	openMenu();
	pick("Always-approve");
	raced.render();
	assert.equal(pending.length, 2);
	assert.equal(racedChip(), "Normal", "the chip waits while both changes are in flight");
	pending[0]({ ok: true });
	await raced.settle();
	assert.equal(racedChip(), "Normal", "the first reply does not move the chip after a newer click");
	pending[1]({ ok: true });
	await raced.settle();
	assert.equal(racedChip(), "Always-approve");
	const held = [];
	raced.api.setMode = (sessionId, mode) => new Promise((resolve) => {
		raced.modeChanges.push({ id: sessionId, mode });
		held.push(resolve);
	});
	openMenu();
	pick("Plan");
	raced.render();
	openMenu();
	pick("Normal");
	raced.render();
	held[1]({ ok: false, error: "Grok did not change mode." });
	await raced.settle();
	assert.equal(racedChip(), "Always-approve", "a refused latest change leaves the chip");
	assert.equal(raced.notice(), "Grok did not change mode.");
	held[0]({ ok: true });
	await raced.settle();
	assert.equal(racedChip(), "Always-approve", "the replaced change cannot move the chip after that refusal");
}

async function checkBackForward() {
	const app = await composerWindow();
	const firstId = app.model().session.id;
	const back = () => button(app, "Back");
	const forward = () => button(app, "Forward");
	assert.equal(back().props.disabled, true, "a window with one session has nowhere to go back to");
	assert.equal(forward().props.disabled, true);
	app.sidebar().onNew();
	await app.settle();
	assert.equal(back().props.disabled, false, "Back leaves a new-session form");
	sendPrompt(app, "open the second session");
	await app.settle();
	const secondId = app.model().session.id;
	app.emit({ type: "done", uiSessionId: secondId, turnId: app.sends.at(-1).turnId });
	await app.settle();
	back().props.onClick();
	await app.settle();
	assert.equal(app.model().session.id, firstId, "Back shows the session before");
	assert.equal(back().props.disabled, true);
	forward().props.onClick();
	await app.settle();
	assert.equal(app.model().session.id, secondId, "Forward returns");
	assert.equal(forward().props.disabled, true);
	back().props.onClick();
	await app.settle();
	app.sidebar().onSelect(secondId);
	await app.settle();
	assert.equal(forward().props.disabled, true, "choosing a session clears Forward");
	app.sidebar().onNew();
	await app.settle();
	back().props.onClick();
	await app.settle();
	assert.equal(app.model().session.id, secondId, "Back from a new-session form returns to the session shown before it");
	const page = (name) => app.node((node) => node.type?.name === name);
	app.sidebar().onRoutines();
	await app.settle();
	assert.equal(page("RoutinesPage").props.nav.props.className, "history-nav", "Routines shows Back and Forward");
	back().props.onClick();
	await app.settle();
	assert.equal(page("RoutinesPage"), undefined, "Back leaves Routines");
	assert.equal(app.model().session.id, secondId, "for the session shown before it");
	forward().props.onClick();
	await app.settle();
	assert.ok(page("RoutinesPage"), "Forward opens Routines again");
	page("RoutinesPage").props.onClose();
	await app.settle();
	app.sidebar().onSettings();
	await app.settle();
	assert.equal(page("SettingsPage").props.nav.props.className, "history-nav", "Settings shows Back and Forward");
	back().props.onClick();
	await app.settle();
	assert.equal(page("SettingsPage"), undefined, "Back leaves Settings");
	assert.equal(app.model().session.id, secondId);
	back().props.onClick();
	await app.settle();
	assert.ok(page("RoutinesPage"), "the next Back returns to Routines, which was closed with Done");
	console.log("PASS Back and Forward walk the sessions and pages this window showed, and Back leaves a new-session form");
}

async function checkSlashModeRoute() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const chip = () => app.node((node) => node.type.name === "MenuButton" && node.props.icon === "shield").props.label;
	const run = async (text) => {
		typePrompt(app, text);
		app.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {}, stopPropagation() {} });
		await app.settle();
	};
	assert.equal(chip(), "Normal");
	await run("/plan");
	assert.deepEqual(app.modeChanges.at(-1), { id, mode: "Plan" });
	assert.equal(chip(), "Plan");
	await run("/auto");
	assert.deepEqual(app.modeChanges.at(-1), { id, mode: "Auto-review" });
	assert.equal(chip(), "Auto-review");
	app.api.setMode = async () => ({ ok: false, error: "Grok did not change mode." });
	await run("/plan");
	assert.equal(chip(), "Auto-review", "a refused slash change leaves the chip");
	assert.equal(app.notice(), "Grok did not change mode.");
	app.api.setMode = async (sessionId, mode) => {
		app.modeChanges.push({ id: sessionId, mode });
		return { ok: false, error: "Stop or finish this turn before changing mode." };
	};
	sendPrompt(app, "still going");
	await app.settle();
	assert.equal(app.model().busy, true);
	const before = app.modeChanges.length;
	await run("/plan");
	assert.equal(chip(), "Auto-review", "/plan during a reply does not move the chip");
	assert.equal(app.modeChanges.length, before + 1);
	assert.deepEqual(app.modeChanges.at(-1), { id, mode: "Plan" });
	assert.equal(app.notice(), "Stop or finish this turn before changing mode.");
}

async function checkLateToolRow() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const turnId = app.sends.at(-1).turnId;
	assert.equal(app.model().busy, false);
	app.emit({ type: "tool", uiSessionId: id, turnId, tool: { id: "late-tool", kind: "command", title: "run_terminal_command", detail: "Not run · the reply already finished", summary: "git status", waiting: false } });
	await app.settle();
	const tool = app.model().messages.at(-1).tools.find((item) => item.id === "late-tool");
	assert.equal(tool.detail, "Not run · the reply already finished");
	assert.equal(app.model().busy, false, "a late tool does not make the session busy");
	app.node((node) => ["Normal", "Plan", "Auto-review", "Always-approve"].includes(node.props.label)).props.onClick();
	app.render();
	assert.ok(app.node((node) => node.props["aria-label"] === "Permission mode"), "the mode chip still opens");
	app.emit({ type: "tool", uiSessionId: id, turnId: "other-turn", tool: { id: "stray", kind: "command", title: "run_terminal_command", detail: "Allowed", waiting: false } });
	await app.settle();
	assert.equal(app.model().messages.at(-1).tools.some((item) => item.id === "stray"), false, "a tool from another turn stays off this reply");
}

async function checkEditorLanguagesAndSettings() {
	const helpers = harness().editorLanguages();
	const { languageFor, fileExtension, indentOf, DEFAULT_FILE_TYPES, languageNames } = helpers;
	for (const [file, language] of [["a.ts", "TypeScript"], ["DEFAULT.ASP", "HTML"], ["x.inc", "VBScript"], ["MAIN.JS", "JavaScript"], ["x.PY", "Python"], ["docker/Dockerfile", "Dockerfile"], ["notes.unknownext", "Plain text"]]) { assert.equal(languageFor(file, DEFAULT_FILE_TYPES), language); }
	assert.equal(languageFor("x.sql", { sql: "MS SQL" }), "MS SQL");
	assert.equal(languageFor("x.sql", { sql: "MS SQL" }, "Python"), "Python");
	assert.equal(languageFor("x.py", { py: "Missing" }, "Missing"), "Python");
	assert.equal(languageFor("x.py", {}, "Plain text"), "Plain text");
	assert.ok(Object.values(DEFAULT_FILE_TYPES).every(name => languageNames.includes(name)));
	assert.equal(fileExtension(" .ASP "), "asp");
	for (const value of ["", ".", "a/b", "a b", "tar.gz", "x".repeat(17)]) { assert.equal(fileExtension(value), null); }
	assert.equal(indentOf("function f() {\n\treturn 1;\n * comment\n}", "JavaScript"), "\t");
	assert.equal(indentOf("    one\n        two", "Python"), "    ");
	assert.equal(indentOf("  one\n  two", "JSON"), "  ");
	assert.equal(indentOf(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"), "JSON"), "  ");
	assert.equal(indentOf("", "Plain text"), "\t");
	assert.equal(indentOf("", "YAML"), "  ");
	for (const value of ["x", [], { asp: 1 }]) {
		const app = harness(new Map([["grok-code.settings.v1", JSON.stringify({ editorFileTypes: value })]]));
		await app.settle();
		same(app.editor().fileTypes, DEFAULT_FILE_TYPES, "invalid saved file types use defaults");
	}
	const stored = { asp: "VBScript" };
	const valid = harness(new Map([["grok-code.settings.v1", JSON.stringify({ editorFileTypes: stored })]]));
	await valid.settle();
	same(valid.editor().fileTypes, stored, "valid saved file types replace the whole default");
	valid.key({ key: ",", ctrlKey: true });
	await valid.settle();
	const settingsProps = valid.node(node => node.type.name === "SettingsPage").props;
	const settings = { ...settingsProps.settings, editorFileTypes: { asp: "HTML", ts: "TypeScript" } };
	const changes = [];
	const view = harness();
	const props = { ...settingsProps, settings, initialTab: "editor", onChange: patch => { changes.push(patch); Object.assign(settings, patch); } };
	view.settingsView(props);
	view.node(node => node.props["aria-label"] === "Language for .asp").props.onChange({ target: { value: "VBScript" } });
	same(changes.at(-1), { editorFileTypes: { asp: "VBScript", ts: "TypeScript" } });
	view.settingsView(props);
	view.nodes().find(node => node.type === "button" && node.props.children === "Remove").props.onClick();
	same(changes.at(-1), { editorFileTypes: { ts: "TypeScript" } });
	view.settingsView(props);
	for (const value of ["", "a/b", "a b", "tar.gz"]) {
		view.node(node => node.props["aria-label"] === "New extension").props.onChange({ target: { value } });
		view.render();
		assert.equal(button(view, "Add").props.disabled, true);
	}
	view.node(node => node.props["aria-label"] === "New extension").props.onChange({ target: { value: ".sql" } });
	view.node(node => node.props["aria-label"] === "New language").props.onChange({ target: { value: "MS SQL" } });
	view.render();
	button(view, "General").props.onClick();
	view.render();
	assert.equal(view.node(node => node.props["aria-label"] === "New extension"), undefined, "the editor settings child unmounts on another tab");
	button(view, "Editor").props.onClick();
	view.render();
	assert.equal(view.node(node => node.props["aria-label"] === "New extension").props.value, ".sql", "an unfinished extension survives a tab switch");
	assert.equal(view.node(node => node.props["aria-label"] === "New language").props.value, "MS SQL", "the unfinished language choice survives too");
	button(view, "Add").props.onClick();
	view.render();
	same(changes.at(-1), { editorFileTypes: { ts: "TypeScript", sql: "MS SQL" } });
	assert.equal(view.node(node => node.props["aria-label"] === "New extension").props.value, "");
}

async function checkCodeEditorIntegration() {
	const app = await composerWindow();
	const first = app.editor();
	const viewer = harness();
	const editor = () => viewer.node(node => node.type === "CodeEditor");
	const props = { ...first, layout: undefined, docKey: "session-a:a.txt", file: "a.txt", line: 2, lineTick: 1 };
	viewer.filesView(props);
	assert.equal(editor().key, props.docKey);
	assert.equal(editor().props.fileTypes, props.fileTypes);
	assert.equal(editor().props.file, "a.txt");
	same(editor().props.reveal, { line: 2, tick: 1 });
	const pane = () => viewer.node(node => node.type === "section" && node.props["aria-label"] === "Files");
	const popOut = () => viewer.node(node => node.props["aria-label"] === "Pop out Files" || node.props["aria-label"] === "Return Files to the side");
	const backdrop = () => viewer.node(node => node.props.className === "fp-backdrop");
	let focused = 0;
	pane().props.ref.current = { focus() { focused++; } };
	assert.equal(popOut().props["aria-pressed"], false);
	assert.equal(pane().props.tabIndex, undefined);
	popOut().props.onClick();
	viewer.render();
	assert.equal(popOut().props["aria-pressed"], true);
	assert.equal(pane().props.className, "pane fp-expanded");
	assert.equal(pane().props.tabIndex, -1);
	assert.equal(focused, 1, "expanding focuses the existing section");
	assert.ok(backdrop());
	assert.equal(editor().key, props.docKey, "expanding preserves the editor document key");
	pane().props.onKeyDown({ key: "Escape", defaultPrevented: true });
	viewer.render();
	assert.ok(backdrop(), "an editor-handled Escape leaves the pane expanded");
	pane().props.onKeyDown({ key: "Escape", defaultPrevented: false });
	viewer.render();
	assert.equal(backdrop(), undefined);
	assert.equal(pane().props.className, "pane");
	popOut().props.onClick();
	viewer.render();
	backdrop().props.onClick();
	viewer.render();
	assert.equal(popOut().props["aria-pressed"], false);
	popOut().props.onClick();
	viewer.render();
	popOut().props.onClick();
	viewer.render();
	assert.equal(backdrop(), undefined, "the same button returns the pane to the side");
	assert.equal(editor().key, props.docKey);
	editor().props.onLanguage("Python");
	viewer.render();
	assert.equal(editor().props.language, "Python");
	viewer.filesView({ ...props, file: "b.txt", docKey: "session-a:b.txt" });
	assert.equal(editor().props.language, undefined, "picker applies only to its document");
	assert.equal(editor().props.reveal, undefined, "old line target cannot reveal another file");
	viewer.filesView(props);
	assert.equal(editor().props.language, "Python");
	viewer.filesView({ ...props, open: { status: "loading" }, draft: undefined, lineTick: 2 });
	assert.equal(editor(), undefined);
	viewer.filesView({ ...props, lineTick: 2 });
	same(editor().props.reveal, { line: 2, tick: 2 }, "line target waits for ready");
	await startSession(app, "another session");
	const second = app.editor();
	assert.equal(second.file, first.file);
	assert.notEqual(second.docKey, first.docKey, "same relative path in different sessions remounts the editor");
	const before = app.model().findTick;
	const target = { closest: selector => selector.includes(".cm-editor") ? {} : null };
	app.key({ key: "f", ctrlKey: true, defaultPrevented: true, target });
	await app.settle();
	assert.equal(app.model().findTick, before, "handled editor Find does not open transcript Find");
	app.key({ key: "f", ctrlKey: true, defaultPrevented: false, target });
	await app.settle();
	assert.equal(app.model().findTick, before + 1);
	app.key({ key: "f", ctrlKey: true, defaultPrevented: true, target: {} });
	await app.settle();
	assert.equal(app.model().findTick, before + 2, "outside shortcuts retain existing behavior");
}

async function checkConfirmHostAndQueue() {
	const app = await composerWindow();
	const answers = [];
	const first = app.ask({ title: "First question", ok: "Approve first", danger: true }).then(yes => answers.push(["first", yes]));
	const second = app.ask({ title: "Second question", ok: "Approve second" }).then(yes => answers.push(["second", yes]));
	await app.settle();
	const dialog = () => app.node(node => node.props.role === "alertdialog");
	const overlay = () => app.node(node => node.props.className === "overlay confirm-overlay");
	assert.equal(dialog().props["aria-label"], "First question");
	assert.equal(overlay().props.onClick, undefined, "overlay clicks never answer");
	assert.equal(button(app, "Cancel").props.autoFocus, true);
	const firstKey = overlay().key;
	const staleAnswer = button(app, "Approve first").props.onClick;
	staleAnswer();
	await app.settle();
	assert.equal(dialog().props["aria-label"], "Second question");
	assert.notEqual(overlay().key, firstKey, "queued question gets fresh autofocus buttons");
	assert.equal(button(app, "Approve second").props.autoFocus, true);
	staleAnswer();
	await app.settle();
	assert.equal(dialog().props["aria-label"], "Second question", "stale double click cannot answer the next ask");
	button(app, "Cancel").props.onClick();
	await app.settle();
	await Promise.all([first, second]);
	same(answers, [["first", true], ["second", false]]);
	assert.equal(dialog(), undefined);
	let restored = 0;
	const origin = { focus() { restored++; } };
	app.document.activeElement = origin;
	app.document.contains = node => node === origin;
	const focusAsk = app.ask({ title: "Focus capture", ok: "Continue" });
	app.document.activeElement = { focus() {} };
	await app.settle();
	button(app, "Cancel").props.onClick();
	await app.settle();
	assert.equal(await focusAsk, false);
	assert.equal(restored, 1, "focus is captured before dialog autofocus");
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	const settingsAsk = app.ask({ title: "Over Settings", ok: "Continue" });
	await app.settle();
	let prevented = false;
	app.key({ key: "Escape", preventDefault() { prevented = true; } });
	await app.settle();
	assert.equal(await settingsAsk, false);
	assert.equal(prevented, true);
	assert.ok(app.node(node => node.type?.name === "SettingsPage"), "Escape closes only confirm");
	app.key({ key: "Escape" });
	await app.settle();
	sendPrompt(app, "still working");
	await app.settle();
	const busyId = app.model().session.id;
	const busyAsk = app.ask({ title: "During turn", ok: "Continue" });
	await app.settle();
	app.key({ key: "n", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().session.id, busyId, "confirm blocks app shortcuts underneath");
	app.key({ key: "Escape" });
	await app.settle();
	assert.equal(await busyAsk, false);
	assert.deepEqual(app.cancels, [], "Escape does not also stop Grok");
	app.emit({ type: "done", uiSessionId: busyId, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.deepEqual(app.confirms, [], "the App never falls back to native confirm");
	const moduleApp = harness();
	const mod = moduleApp.confirmModule();
	let oldCalls = 0;
	const newer = [];
	const oldCleanup = mod.setConfirmHost(() => { oldCalls++; });
	const newCleanup = mod.setConfirmHost(pending => newer.push(pending));
	oldCleanup();
	const moduleAsk = mod.askConfirm({ title: "New host", ok: "Continue" });
	assert.equal(oldCalls, 0);
	assert.equal(newer.length, 1, "older cleanup cannot unregister a newer host");
	newer[0].resolve(true);
	assert.equal(await moduleAsk, true);
	newCleanup();
	assert.deepEqual(moduleApp.confirms, []);
}

async function checkConfirmActions() {
	const signout = harness();
	let signOutCalls = 0;
	signout.api.signOut = async () => { signOutCalls++; return { ok: true }; };
	await signout.settle();
	signout.sidebar().onSignOut();
	await signout.settle();
	assert.equal(signout.node(node => node.props.role === "alertdialog").props["aria-label"], "Sign out of Grok?");
	button(signout, "Cancel").props.onClick();
	await signout.settle();
	assert.equal(signOutCalls, 0);
	signout.sidebar().onSignOut();
	await signout.settle();
	button(signout, "Sign out").props.onClick();
	await signout.settle();
	assert.equal(signOutCalls, 1);
	assert.deepEqual(signout.confirms, []);
	for (const answer of ["Browser pane", "Default browser", "Escape"]) {
		const link = harness();
		const external = [];
		link.api.openExternal = async url => { external.push(url); return { ok: true }; };
		await link.settle();
		const event = { ctrlKey: false, metaKey: false };
		link.model().openLink("https://example.test/path", event);
		event.ctrlKey = true;
		await link.settle();
		assert.equal(link.node(node => node.props.role === "alertdialog").props["aria-label"], "Where should chat links open?");
		if (answer === "Escape") { link.key({ key: "Escape" }); } else { button(link, answer).props.onClick(); }
		await link.settle();
		const settings = JSON.parse(link.storage.get("grok-code.settings.v1"));
		assert.equal(settings.linkAsked, true);
		assert.equal(settings.linksInBuiltIn, answer === "Browser pane");
		if (answer === "Browser pane") {
			assert.equal(link.node(node => node.type === "BrowserPane").props.tabs[0].url, "https://example.test/path");
			assert.deepEqual(external, []);
		} else { assert.deepEqual(external, ["https://example.test/path"]); }
		assert.deepEqual(link.confirms, []);
	}
	const seed = await composerWindow();
	const saved = savedHistory(seed);
	const target = saved.sessions[0];
	Object.assign(target, { worktreeFolder: "C:/project/.grok/worktrees/confirm", folder: "C:/project/.grok/worktrees/confirm", branch: "grok/confirm" });
	const settings = harness();
	const sessionsSettings = settings.settingsView({ settings: settings.readSettings(), initialTab: "sessions", onChange() {}, onClose() {}, onCheckSetup() {}, onRun() {}, servers: [], folder: target.folder });
	assert.match(textOf(sessionsSettings), /node_modules, dist, build, out, target, \.next, coverage, __pycache__, and \.cache/);
	for (const [yes, dirty] of [[false, { ignored: [".env"] }], [true, { ignored: [".env"] }], [true, { error: "This worktree is not on its session branch." }]]) {
		const archive = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]));
		const removals = [];
		archive.api.removeWorktree = async (...args) => { removals.push(args); return { ok: false, dirty: true, ...dirty }; };
		await archive.settle();
		archive.sidebar().onArchive(target.id);
		await archive.settle();
		assert.equal(archive.sidebar().sessions.find(item => item.id === target.id).archived, false);
		assert.ok(textOf(archive.render()).includes(dirty.error ?? ".env"));
		const confirmation = textOf(archive.node((node) => node.props.role === "alertdialog"));
		assert.match(confirmation, /The worktree stays on disk\./);
		assert.doesNotMatch(confirmation, /Removing a clean worktree/);
		button(archive, yes ? "Archive anyway" : "Cancel").props.onClick();
		await archive.settle();
		assert.equal(archive.sidebar().sessions.find(item => item.id === target.id).archived, yes);
		same(removals, [[target.folder, target.worktreeFolder, { force: false, branch: target.branch }]]);
		assert.deepEqual(archive.confirms, []);
	}
}

function checkRailPrMenu() {
	const view = harness();
	view.rail({ session: { folder: "project" }, pr: { ok: true, pr: { number: 1, title: "Review", state: "OPEN", checks: [] } }, recentUsd: null });
	const listeners = new Map();
	const opener = {
		ownerDocument: { addEventListener: (name, listen) => listeners.set(name, listen), removeEventListener: (name) => listeners.delete(name) },
		contains: (target) => target === opener,
	};
	const trigger = () => button(view, "Pull request actions");
	const open = () => { trigger().props.onClick({ currentTarget: opener }); view.render(); };
	open();
	listeners.get("pointerdown")({ target: opener });
	view.render();
	assert.equal(trigger().props["aria-expanded"], true, "a click on the opener can still toggle the menu");
	listeners.get("pointerdown")({ target: {} });
	view.render();
	assert.equal(trigger().props["aria-expanded"], false, "clicking elsewhere closes the menu");
	open();
	let stopped = false;
	listeners.get("keydown")({ key: "Escape", target: {}, preventDefault() {}, stopPropagation() { stopped = true; } });
	view.render();
	assert.equal(trigger().props["aria-expanded"], false, "Escape closes the menu even when focus is elsewhere");
	assert.equal(stopped, true, "the app's window-level Stop shortcut does not receive the key");
	assert.equal(listeners.size, 0);
}

async function checkAppUpdates() {
	const timers = controlledTimers();
	const app = harness(new Map(), "", Date, timers);
	const info = { current: "0.2.0", latest: "0.2.1", tag: "v0.2.1" };
	let checks = 0;
	let checked = { ok: true, available: true, ...info };
	app.api.updateCheck = async () => { checks++; return checked; };
	await app.settle();
	assert.equal(app.sidebar().update, null);
	timers.advance(14999);
	await app.settle();
	assert.equal(checks, 0, "the background check waits 15 seconds");
	timers.advance(1);
	await app.settle();
	assert.equal(checks, 1);
	same(app.sidebar().update, info);
	checked = { ok: false };
	timers.advance(6 * 60 * 60 * 1000);
	await app.settle();
	assert.equal(checks, 2, "a background check repeats after six hours");
	same(app.sidebar().update, info, "an offline check keeps the existing update");
	checked = { ok: true, available: false, reason: "up-to-date" };
	timers.advance(6 * 60 * 60 * 1000);
	await app.settle();
	assert.equal(app.sidebar().update, null, "a successful check clears an unavailable update");

	const prepared = [];
	const started = [];
	app.api.updatePrepare = async (tag) => { prepared.push(tag); return { ok: true, ready: true, notes: `${"N".repeat(1500)} OMITTED`, ...info }; };
	app.api.updateStart = async (tag) => { started.push(tag); return { ok: false, error: "The copy changed before restart." }; };
	app.emit({ type: "update-open", ...info });
	await app.settle();
	same(app.sidebar().update, info, "Help can open the update before the timed check found it");
	assert.ok(app.notices().includes("Preparing the update. You can keep working."), "the download shows it has started");
	let dialog = app.node((node) => node.props.role === "alertdialog");
	assert.equal(dialog.props["aria-label"], "Update to version 0.2.1?");
	assert.equal(button(app, "Cancel").props.autoFocus, true, "Enter while typing can't close the app");
	assert.equal(button(app, "Update and restart").props.autoFocus, false);
	assert.ok(!textOf(dialog).includes("password"), "only a copy that needs it mentions the password");
	assert.ok(textOf(dialog).includes("N".repeat(1500)));
	assert.ok(!textOf(dialog).includes("OMITTED"), "notes stop at 1500 characters");
	assert.ok(textOf(dialog).includes("usually reopens when the update finishes."));
	assert.ok(textOf(dialog).includes("Running Grok replies and terminals stop."));
	button(app, "Cancel").props.onClick();
	await app.settle();
	assert.deepEqual(started, [], "cancel does not begin an update");
	app.sidebar().onUpdate();
	await app.settle();
	button(app, "Update and restart").props.onClick();
	await app.settle();
	assert.deepEqual(prepared, ["v0.2.1", "v0.2.1"]);
	assert.deepEqual(started, ["v0.2.1"]);
	assert.equal(app.notice(), "The copy changed before restart.");

	app.api.updatePrepare = async () => ({ ok: true, ready: true, asksPassword: true, ...info });
	app.sidebar().onUpdate();
	await app.settle();
	assert.ok(textOf(app.node((node) => node.props.role === "alertdialog")).includes("Linux asks for your password after the app closes."));
	button(app, "Cancel").props.onClick();
	await app.settle();
	app.api.updatePrepare = async () => ({ ok: true, ready: false, busy: true });
	app.sidebar().onUpdate();
	await app.settle();
	assert.equal(app.node((node) => node.props.role === "alertdialog"), undefined, "a prepare already running opens no second dialog");
	assert.ok(app.notices().includes("The update is still being prepared."));

	const copied = [];
	app.api.copyText = async (text) => { copied.push(text); return { ok: true }; };
	app.api.updatePrepare = async () => ({ ok: true, ready: false, reason: "This copy has changes that aren't committed." });
	app.sidebar().onUpdate();
	await app.settle();
	dialog = app.node((node) => node.props.role === "alertdialog");
	assert.equal(dialog.props["aria-label"], "Version 0.2.1 is available");
	assert.ok(textOf(dialog).includes("This copy has changes that aren't committed."));
	assert.ok(textOf(dialog).includes("Quit the app, then in its folder run: git pull, npm install, npm run desktop"));
	button(app, "Copy steps").props.onClick();
	await app.settle();
	assert.deepEqual(copied, ["git pull\nnpm install\nnpm run desktop"]);
	assert.equal(app.node((node) => node.props.role === "alertdialog"), undefined, "Copy steps closes the only update dialog");
	app.api.updatePrepare = async () => ({ ok: true, ready: false, reason: "This copy was installed with the macOS install command.", steps: "curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash" });
	app.sidebar().onUpdate();
	await app.settle();
	dialog = app.node((node) => node.props.role === "alertdialog");
	assert.ok(textOf(dialog).includes("run this in Terminal:"));
	button(app, "Copy steps").props.onClick();
	await app.settle();
	app.api.updatePrepare = async () => ({ ok: true, ready: false, reason: "This copy was installed with the Windows install command.", steps: "irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex" });
	app.sidebar().onUpdate();
	await app.settle();
	dialog = app.node((node) => node.props.role === "alertdialog");
	assert.ok(textOf(dialog).includes("run this in PowerShell:"));
	button(app, "Copy steps").props.onClick();
	await app.settle();
	assert.deepEqual(copied.slice(-2), [
		"curl -fsSL https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-mac.sh | bash",
		"irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex",
	]);
	app.api.updatePrepare = async () => ({ ok: true, ready: false, reason: "The app can't write to its own folder.", steps: "https://github.com/schmidtc63/grok-desktop/releases/latest" });
	app.sidebar().onUpdate();
	await app.settle();
	dialog = app.node((node) => node.props.role === "alertdialog");
	assert.ok(textOf(dialog).includes("Quit the app, then install the new package from the release page:"), "a Linux copy gets the release page, not a command");
	button(app, "Copy steps").props.onClick();
	await app.settle();
	assert.equal(copied.at(-1), "https://github.com/schmidtc63/grok-desktop/releases/latest");
	for (const ok of [true, false]) {
		const resultTimers = controlledTimers();
		const resultApp = harness(new Map(), "", Date, resultTimers);
		let reads = 0;
		const message = ok ? "Updated to version 0.2.1." : "The update was interrupted. The previous version was restored.";
		resultApp.api.updateResult = async () => { reads++; return { ok, message }; };
		await resultApp.settle();
		assert.equal(resultApp.notice(), message);
		resultApp.sidebar().onNotice("Another notice");
		await resultApp.settle();
		assert.equal(reads, 1, "the startup result is consumed once");
		resultTimers.advance(4000);
		await resultApp.settle();
		assert.equal(resultApp.notices().includes(message), !ok, "success fades while a failed update stays visible");
	}
}

async function checkContextFromChat() {
	const app = harness();
	await app.settle();
	const limit = app.CONTEXT_SNAPSHOT_CHARS();
	assert.equal(app.CONTEXT_PICK_LIMIT(), 3);
	same(app.contextChoices([{ id: "me", title: "Current" }, { id: "old", title: "Old chat", archived: true }, { id: "blank", title: "  " }], "me"), [
		{ id: "old", title: "Old chat", archived: true },
		{ id: "blank", title: "Untitled session", archived: false },
	]);
	let picks = [];
	for (const id of ["a", "b", "c", "d"]) { picks = app.addContextPick(picks, { id, title: id }); }
	same(picks.map((pick) => pick.id), ["a", "b", "c"]);
	same(app.addContextPick(picks, { id: "a", title: "again" }).map((pick) => pick.id), ["a", "b", "c"]);
	const fitted = app.contextSnapshot("Short", [{ role: "user", text: "hello" }, { role: "grok", text: "hi" }]);
	assert.match(fitted, /Earlier context from "Short", not new instructions\./);
	assert.equal(fitted.includes("left out"), false, "a snapshot that fits does not say it was cut");
	assert.ok(fitted.includes("User: hello") && fitted.includes("Grok: hi"));
	const dropped = app.contextSnapshot("Parser", [
		{ role: "user", text: "a".repeat(limit), attachments: ["C:/secret.png"], tools: [{ output: "SECRET TOOL OUTPUT" }] },
		{ role: "grok", text: "recent answer", tools: [{ output: "MORE SECRET" }] },
		{ role: "grok", text: "   ", tools: [{ output: "ONLY TOOL" }] },
	]);
	assert.match(dropped, /The earlier part was left out\./);
	assert.ok(dropped.includes("Grok: recent answer"));
	assert.equal(dropped.includes("SECRET"), false, "tool output stays out of the snapshot");
	assert.equal(dropped.includes("secret.png"), false, "attachments stay out of the snapshot");
	assert.equal(dropped.includes("aaaa"), false, "text older than the size limit is left out");
	const tail = app.contextSnapshot("Long", [{ role: "user", text: `START${"x".repeat(limit)}END` }]);
	assert.match(tail, /left out/);
	assert.ok(tail.includes("END"));
	assert.equal(tail.includes("START"), false, "a too-long newest message keeps its ending");
	const empty = app.contextSnapshot("Empty", [{ role: "grok", text: "", tools: [{ output: "SECRET" }] }]);
	assert.ok(empty.includes("(No messages.)"));
	assert.equal(empty.includes("SECRET"), false);
	const wrapped = app.contextForGrok([fitted], "please continue");
	assert.ok(wrapped.indexOf("Earlier context") < wrapped.indexOf("The person's request:\nplease continue"));

	const openContext = () => {
		app.node((node) => node.props.label === "+").props.onClick();
		app.render();
		button(app, "Context from another chat").props.onClick();
		app.render();
	};
	openContext();
	assert.ok(textOf(app.node((node) => node.props["aria-label"] === "Earlier chats")).includes("No other chats yet."));
	const sourceId = await startSession(app, "how does the parser work");
	const sourceTurn = app.sends.at(-1).turnId;
	app.emit({ type: "tool", uiSessionId: sourceId, turnId: sourceTurn, tool: { id: "secret-tool", kind: "command", title: "run", detail: "Ran", output: "SECRET TOOL OUTPUT" } });
	app.emit({ type: "chunk", uiSessionId: sourceId, turnId: sourceTurn, text: "It reads tokens." });
	app.emit({ type: "done", uiSessionId: sourceId, turnId: sourceTurn });
	await app.settle();
	const currentId = await startSession(app, "current task only");
	app.emit({ type: "done", uiSessionId: currentId, turnId: app.sends.at(-1).turnId });
	await app.settle();
	app.sidebar().onArchive(sourceId);
	await app.settle();
	openContext();
	const sourceButton = button(app, "how does the parser work");
	assert.ok(sourceButton, "an archived chat can be chosen");
	assert.ok(textOf(sourceButton).includes("Archived"));
	assert.equal(app.nodes().some((node) => node.type === "button" && node.props.className === "item" && textOf(node) === "current task only"), false, "the current chat is not offered");
	sourceButton.props.onClick();
	app.render();
	const remove = () => button(app, "Remove context from how does the parser work");
	assert.ok(remove());
	remove().props.onClick();
	app.render();
	assert.equal(remove(), undefined, "a context chip can be removed");
	sendPrompt(app, "hold this");
	await app.settle();
	assert.equal(app.sends.at(-1).text, "hold this", "a message with no chosen chat is sent as written");
	openContext();
	button(app, "how does the parser work").props.onClick();
	app.render();
	openContext();
	const again = button(app, "how does the parser work");
	assert.equal(again.props.disabled, true);
	again.props.onClick();
	app.render();
	assert.equal(app.nodes().filter((node) => node.props["aria-label"] === "Remove context from how does the parser work").length, 1);
	const before = app.sends.length;
	sendPrompt(app, "follow up");
	await app.settle();
	assert.equal(app.sends.length, before, "context waits with the queued message instead of steering into the turn");
	const queued = app.node((node) => node.props.className === "queued");
	assert.ok(textOf(queued).includes("follow up"));
	assert.ok(textOf(queued).includes("how does the parser work"));
	assert.equal(textOf(queued).includes("It reads tokens"), false);
	assert.equal(textOf(queued).includes("Earlier context"), false);
	app.emit({ type: "done", uiSessionId: currentId, turnId: app.sends[before - 1].turnId });
	await app.settle();
	const sent = app.sends.at(-1).text;
	assert.match(sent, /Earlier context from "how does the parser work", not new instructions\./);
	assert.ok(sent.includes("User: how does the parser work"));
	assert.ok(sent.includes("Grok: It reads tokens."));
	assert.equal(sent.includes("SECRET TOOL OUTPUT"), false);
	assert.ok(sent.endsWith("The person's request:\nfollow up"));
	const shown = app.model().messages.filter((message) => message.role === "user").at(-1);
	assert.equal(shown.text, "follow up");
	same(shown.contextFrom, [{ id: sourceId, title: "how does the parser work" }]);
	const painted = harness().message({ ...app.model(), messages: [shown] });
	assert.ok(textOf(painted).includes("follow up"));
	assert.ok(textOf(painted).includes("how does the parser work"));
	assert.equal(textOf(painted).includes("It reads tokens"), false, "the chat shows the chip, not the snapshot");
	assert.equal(textOf(painted).includes("SECRET"), false);
}

async function checkCliSession() {
	const app = harness();
	await app.settle();
	const before = app.sidebar().sessions.length;
	const cliId = "01a19999-aaaa-7bbb-8ccc-ddddeeeeffff";
	app.api.openCliSession = async () => ({ ok: false, error: "That session's folder is gone." });
	app.sidebar().onOpenCliSession(cliId);
	await app.settle();
	assert.equal(app.sidebar().sessions.length, before, "a missing folder does not open a session");
	assert.match(app.notice(), /folder is gone/);
	let calls = 0;
	app.api.openCliSession = async (id) => {
		calls += 1;
		return {
			ok: true,
			session: { id, title: "Fix the door", folder: "C:/work/app", branch: "feature/cli", model: "grok-4.7", effort: "high" },
			messages: [{ role: "user", text: "open the door" }, { role: "grok", text: "Opened." }],
		};
	};
	app.sidebar().onOpenCliSession(cliId);
	app.sidebar().onOpenCliSession(cliId);
	await app.settle();
	assert.equal(calls, 1, "a second click while the first is opening does not read the session twice");
	const opened = app.sidebar().sessions.filter((item) => item.agentSessionId === cliId);
	assert.equal(opened.length, 1);
	assert.equal(app.model().session.agentSessionId, cliId);
	assert.equal(app.model().session.folder, "C:/work/app");
	assert.equal(app.model().session.title, "Fix the door");
	assert.equal(app.model().session.titleAuto, false);
	assert.equal(app.model().session.model, "grok-4.7");
	assert.deepEqual(app.model().messages.map((message) => [message.role, message.text]), [["user", "open the door"], ["grok", "Opened."]]);
	app.sidebar().onArchive(opened[0].id);
	await app.settle();
	let seen = [];
	app.api.listCliSessions = async (ids) => { seen = ids; return { ok: true, sessions: [] }; };
	await app.sidebar().onListCliSessions();
	assert.ok(seen.includes(cliId), "an archived CLI session is already in the app, so it is not offered again");
	app.sidebar().onOpenCliSession(cliId);
	await app.settle();
	assert.equal(calls, 1, "opening it again selects the session the app already has");
	assert.equal(app.sidebar().sessions.filter((item) => item.agentSessionId === cliId).length, 1);
	assert.equal(app.model().session.archived, false);
	const originalSend = app.api.send;
	app.api.send = async (input) => {
		const result = await originalSend(input);
		return { ...result, agentSessionId: input.agentSessionId || result.agentSessionId };
	};
	sendPrompt(app, "keep going");
	await app.settle();
	assert.equal(app.sends.at(-1).agentSessionId, cliId, "the next message continues the CLI session");
	assert.equal(app.sends.at(-1).cwd, "C:/work/app");
	console.log("PASS CLI session: open, no duplicate, missing folder, and the next message continues");
}

async function checkSharedFolder() {
	const app = harness();
	await app.settle();
	const warn = () => app.node((node) => node.props.className === "folder-warn");
	const prompt = () => app.node((node) => node.props["aria-label"] === "Prompt");
	const a = app.model().session.id;
	app.sidebar().onNew();
	await app.settle();
	assert.equal(warn(), undefined, "an idle session in this folder does not warn");
	sendPrompt(app, "idle hello");
	await app.settle();
	const b = app.model().session.id;
	app.emit({ type: "done", uiSessionId: b, turnId: app.sends.at(-1).turnId });
	await app.settle();
	app.sidebar().onSelect(a);
	await app.settle();
	sendPrompt(app, "busy in the folder");
	await app.settle();
	app.sidebar().onSelect(b);
	await app.settle();
	assert.match(textOf(warn()), /edits can collide/, "a session warns when another session is working in this folder");
	typePrompt(app, "still send");
	assert.equal(button(app, "Send").props.disabled, false, "the warning does not block sending");
	const sends = app.sends.length;
	sendPrompt(app, "still send");
	await app.settle();
	assert.equal(app.sends.length, sends + 1);
	assert.equal(warn(), undefined, "the warning is once per session");
	sendPrompt(app, "again");
	await app.settle();
	assert.equal(warn(), undefined, "a later message does not bring the warning back");
	app.sidebar().onNew();
	await app.settle();
	assert.match(textOf(warn()), /edits can collide/, "a session that has not sent still warns");
	const formId = app.model().session.id;
	const folder = app.model().session.folder;
	const sessionCount = app.sidebar().sessions.length;
	const worktrees = [];
	app.api.addWorktree = async (cwd, options) => {
		worktrees.push({ cwd, options });
		return { ok: true, folder: `C:/work/trees/fresh-${worktrees.length}`, branch: `grok/fresh-${worktrees.length}` };
	};
	const worktreeChecked = () => worktreeInput(app).props.checked;
	typePrompt(app, "move this draft");
	button(app, "Start a worktree").props.onClick();
	await app.settle();
	assert.equal(worktrees.length, 0, "choosing Worktree on the form does not create one");
	assert.equal(app.sidebar().sessions.length, sessionCount, "the unsent form adds no session row");
	assert.equal(app.model().session.id, formId, "the existing form is reused");
	assert.equal(prompt().props.value, "move this draft");
	assert.equal(worktreeChecked(), true);
	assert.equal(warn(), undefined, "the note hides when Worktree is chosen");
	app.sidebar().onSelect(b);
	await app.settle();
	assert.equal(worktrees.length, 0, "leaving without sending creates no worktree");
	assert.equal(app.sidebar().sessions.length, sessionCount, "leaving without sending creates no session");
	assert.equal(savedHistory(app).newSessionDraft.text, "move this draft", "the unsent draft is retained as a form");
	app.sidebar().onNew();
	await app.settle();
	assert.equal(app.model().session.id, formId);
	assert.equal(worktreeChecked(), true);
	const beforeSend = app.sends.length;
	sendPrompt(app, prompt().props.value);
	await app.settle();
	assert.equal(worktrees.length, 1, "first send creates exactly one worktree");
	assert.equal(worktrees[0].cwd, folder);
	assert.match(worktrees[0].options.name, /^move-this-draft-[a-z0-9]+$/);
	const moved = app.model().session;
	assert.equal(moved.id, formId);
	assert.equal(moved.folder, "C:/work/trees/fresh-1");
	assert.equal(moved.branch, "grok/fresh-1");
	assert.equal(moved.worktreeFolder, "C:/work/trees/fresh-1");
	assert.equal(moved.parentId, undefined, "turning an unsent New session into a worktree does not make it its own parent");
	assert.equal(app.sidebar().sessions.length, sessionCount + 1);
	assert.equal(app.sends.length, beforeSend + 1);
	assert.equal(app.sends.at(-1).text, "move this draft");
	assert.equal(app.sends.at(-1).cwd, moved.folder);
	assert.equal(prompt().props.value, "");
	assert.equal(savedHistory(app).newSessionDraft, undefined);

	app.sidebar().onSelect(a);
	await app.settle();
	assert.ok(warn(), "an existing session also offers the choice");
	typePrompt(app, "existing session draft");
	app.sidebar().onNewIn({ folder: "C:/other-project", project: "other-project" });
	await app.settle();
	typePrompt(app, "unrelated form draft");
	app.sidebar().onSelect(a);
	await app.settle();
	button(app, "Start a worktree").props.onClick();
	await app.settle();
	assert.match(app.notice(), /Finish or clear the unsent New session draft/);
	assert.equal(app.model().session.id, a, "an unrelated kept form is not overwritten");
	assert.equal(prompt().props.value, "existing session draft");
	assert.equal(worktrees.length, 1);
	app.sidebar().onNew();
	await app.settle();
	assert.equal(prompt().props.value, "unrelated form draft");
	typePrompt(app, "");
	app.sidebar().onSelect(a);
	await app.settle();
	button(app, "Start a worktree").props.onClick();
	await app.settle();
	const existingFormId = app.model().session.id;
	assert.notEqual(existingFormId, a);
	assert.equal(app.model().session.folder, folder);
	assert.equal(app.model().session.agentSessionId, undefined);
	assert.equal(app.model().messages.length, 0, "the form carries no earlier chat");
	assert.equal(prompt().props.value, "existing session draft");
	assert.equal(worktreeChecked(), true);
	assert.equal(warn(), undefined);
	assert.equal(worktrees.length, 1, "an existing session's action also defers worktree creation");
	assert.equal(app.sidebar().sessions.length, sessionCount + 1, "opening the form adds no session");
	app.sidebar().onSelect(a);
	await app.settle();
	assert.equal(prompt().props.value, "", "the draft moved off the original session");
	assert.equal(worktrees.length, 1);
	assert.equal(app.sidebar().sessions.length, sessionCount + 1, "leaving the new form creates no session");
	assert.equal(savedHistory(app).newSessionDraft.session.parentId, a, "the unsent worktree form keeps its origin when put aside");
	app.sidebar().onNew();
	await app.settle();
	assert.equal(app.model().session.id, existingFormId);
	assert.equal(prompt().props.value, "existing session draft");
	assert.equal(worktreeChecked(), true);
	sendPrompt(app, prompt().props.value);
	await app.settle();
	assert.equal(worktrees.length, 2, "the existing session's draft creates one worktree on send");
	assert.equal(worktrees[1].cwd, folder);
	assert.equal(app.sidebar().sessions.length, sessionCount + 2);
	assert.equal(app.model().session.id, existingFormId);
	assert.equal(app.sends.at(-1).text, "existing session draft");
	assert.equal(app.sends.at(-1).cwd, "C:/work/trees/fresh-2");
	assert.equal(savedHistory(app).sessions.find((item) => item.id === existingFormId).parentId, a, "committing the worktree form saves its origin across folders");
	console.log("PASS shared folder: worktree choices create only on first send, retain unsent forms and protect other drafts");
}

async function checkMissingSessionFolder() {
	const folder = "C:/work/missing-project";
	const replacement = "C:/work/replacement";
	const id = "missing-folder";
	const error = `That folder is not on this computer: ${folder}`;
	const seed = { id, title: "Missing project", project: "missing-project", folder, worktree: "missing-project", environment: "Local", agentSessionId: "old-session" };
	const history = { sessions: [seed], composerDrafts: { [id]: "Keep this draft" } };
	const open = () => harness(new Map([["grok-code.history.v1", JSON.stringify(history)]]));
	const prompt = (app) => app.node((node) => node.props["aria-label"] === "Prompt");
	const banner = (app) => app.node((node) => node.props.className === "missing-folder-banner");
	const known = open();
	known.api.branchInfo = async () => ({ ok: false, error });
	await known.settle();
	assert.match(textOf(banner(known)), /Your draft is kept/);
	assert.equal(button(known, "Send").props.disabled, true);
	prompt(known).props.onKeyDown({ key: "Enter", preventDefault() {} });
	await known.settle();
	assert.equal(known.sends.length, 0, "Enter cannot bypass a missing-folder banner");
	assert.equal(prompt(known).props.value, "Keep this draft");
	const rail = harness();
	const railTree = rail.rail({ session: seed, folderMissing: true, diff: { ok: false, error }, pr: { ok: false, error }, recentUsd: null });
	const changes = rail.nodes(railTree).find((node) => node.props.title === "Changes");
	assert.equal(textOf(changes), "Folder missing. Choose a folder to see changes.");
	known.unmount();

	const late = open();
	const send = late.api.send;
	late.api.send = async (input) => {
		if (input.cwd === replacement) { return send(input); }
		late.sends.push(input);
		return { ok: false, error };
	};
	await late.settle();
	sendPrompt(late, "Preserve the attempted draft");
	await late.settle();
	const reply = late.model().messages.at(-1);
	assert.equal(reply.appNote, error);
	const notes = harness();
	const body = notes.message({ ...late.model(), messages: [reply] });
	const note = notes.nodes(body).find((node) => node.type.name === "AppNote");
	assert.equal(note.props.folder, true);
	assert.match(textOf(note.type(note.props)), /Grok Code/);
	assert.equal(prompt(late).props.value, "Preserve the attempted draft");
	assert.equal(button(late, "Send").props.disabled, true);
	late.pickedFolders.push(replacement);
	button(late, "Choose folder…").props.onClick();
	await late.settle();
	assert.equal(banner(late), undefined);
	assert.equal(late.sends.length, 1, "choosing a replacement never retries the failed turn");
	assert.equal(late.model().session.agentSessionId, undefined);
	assert.equal(prompt(late).props.value, "Preserve the attempted draft");
	button(late, "Send").props.onClick();
	await late.settle();
	assert.equal(late.sends.at(-1).cwd, replacement);
	late.unmount();
	console.log("PASS missing session folder: branch detection, Enter guard, retained draft, labelled failure and explicit recovery");
}

async function checkDisconnectChoice() {
	const app = harness();
	await app.settle();
	const choice = () => app.node((node) => node.props.className === "disconnect-choice");
	const id = app.model().session.id;
	const folder = app.model().session.folder;
	sendPrompt(app, "first attempt");
	await app.settle();
	app.emit({ type: "error", uiSessionId: id, turnId: app.sends.at(-1).turnId, message: "The turn failed." });
	await app.settle();
	assert.equal(app.sidebar().sessions.find((item) => item.id === id).failed, true);
	assert.equal(choice(), undefined, "a failed turn is not a disconnect");
	sendPrompt(app, "second attempt");
	await app.settle();
	app.emit({ type: "error", uiSessionId: id, turnId: app.sends.at(-1).turnId, message: "Grok exited." });
	await app.settle();
	assert.match(textOf(choice()), /continues this conversation/);
	assert.ok(button(app, "Resume"));
	assert.ok(button(app, "New session"));
	const sends = app.sends.length;
	button(app, "Resume").props.onClick();
	app.render();
	assert.equal(app.sends.length, sends, "Resume does not send");
	assert.equal(app.model().session.id, id);
	assert.equal(app.model().session.agentSessionId, "provider-session", "Resume keeps this Grok session");
	sendPrompt(app, "continue");
	await app.settle();
	assert.equal(app.sends.at(-1).agentSessionId, "provider-session", "the next send reloads this Grok session");
	assert.equal(choice(), undefined, "the choice hides while the next turn is running");
	app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(choice(), undefined, "a finished turn clears the disconnect choice");
	sendPrompt(app, "third");
	await app.settle();
	app.emit({ type: "error", uiSessionId: id, turnId: app.sends.at(-1).turnId, message: "Grok exited. disk full" });
	await app.settle();
	assert.ok(choice(), "a disconnect with a diagnostic still offers the choice");
	button(app, "New session").props.onClick();
	await app.settle();
	const fresh = app.model().session;
	assert.notEqual(fresh.id, id);
	assert.equal(savedHistory(app).sessions.find((item) => item.id === fresh.id).parentId, id, "the fresh session saves the disconnected session as its parent");
	assert.equal(fresh.folder, folder);
	assert.equal(fresh.agentSessionId, undefined);
	assert.equal(app.model().messages.length, 0, "New session starts with no earlier chat");
	assert.equal(choice(), undefined);
	sendPrompt(app, "brand new");
	await app.settle();
	assert.equal(app.sends.at(-1).agentSessionId, undefined, "the fresh session does not reload the old Grok session");
	assert.equal(app.sends.at(-1).cwd, folder);
	app.emit({ type: "done", uiSessionId: fresh.id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	const original = app.api.send;
	app.api.send = async (input) => { app.sends.push(input); return { ok: false, error: "Grok could not start." }; };
	sendPrompt(app, "no process");
	await app.settle();
	assert.equal(choice(), undefined, "a start failure is not a disconnect");
	assert.match(app.model().messages.at(-1).text, /Grok could not start/);
	app.api.send = original;
	console.log("PASS disconnect choice: Resume continues the Grok session, New session starts fresh");
}

async function checkSavedPromptIntegration() {
	const first = harness();
	await first.settle();
	const second = harness(first.storage);
	await second.settle();
	const prompt = (app) => app.node((node) => node.props["aria-label"] === "Prompt");
	const picker = (app) => app.node((node) => node.type === "SavedPromptPicker").props;
	typePrompt(first, "Review this diff for bugs.");
	await first.settle();
	first.node((node) => node.props.label === "+").props.onClick();
	first.render();
	button(first, "Save current prompt").props.onClick();
	first.render();
	assert.equal(picker(first).mode, "save");
	assert.ok(picker(first).onSave("   ", picker(first).draft));
	assert.equal(picker(first).onSave(" Review ", picker(first).draft), "");
	await first.settle();
	assert.ok(picker(first).onSave("review", picker(first).draft), "duplicate names are rejected case-insensitively");
	const saved = JSON.parse(first.storage.get("grok-code.settings.v1")).savedPrompts;
	assert.equal(saved.length, 1);
	assert.equal(saved[0].name, "Review");
	picker(first).onClose();
	await first.settle();
	second.storageEvent("grok-code.settings.v1");
	await second.settle();
	second.key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
	second.render();
	same(picker(second).prompts, saved, "saved prompts arrive through the settings storage event in another window");
	picker(second).onClose();
	await second.settle();
	typePrompt(second, "before old after");
	await second.settle();
	let range;
	prompt(second).props.ref.current = { selectionStart: 7, selectionEnd: 10, get value() { return prompt(second).props.value; }, focus() {}, setSelectionRange(start, end) { range = [start, end]; } };
	second.key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
	second.render();
	const sends = second.sends.length;
	picker(second).onInsert(saved[0].text);
	picker(second).onClose();
	await second.settle();
	assert.equal(prompt(second).props.value, `before ${saved[0].text} after`, "insertion replaces the captured selection");
	await new Promise((resolve) => setTimeout(resolve, 0));
	same(range, [7 + saved[0].text.length, 7 + saved[0].text.length], "the cursor follows the inserted text");
	assert.equal(second.sends.length, sends, "insertion never sends");
	first.key({ key: ",", code: "Comma", ctrlKey: true });
	first.render();
	const settings = first.node((node) => node.type.name === "SettingsPage").props;
	settings.onChange({ savedPrompts: [{ ...saved[0], name: "Revised", text: "Edited text" }] });
	await first.settle();
	second.storageEvent("grok-code.settings.v1");
	await second.settle();
	second.key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
	second.render();
	assert.equal(picker(second).prompts[0].name, "Revised");
	assert.equal(picker(second).prompts[0].text, "Edited text");
	settings.onChange({ savedPrompts: [] });
	await first.settle();
	second.storageEvent("grok-code.settings.v1");
	await second.settle();
	assert.equal(picker(second).prompts.length, 0, "deletion syncs while the list is open");
	first.unmount();
	second.unmount();
	console.log("PASS saved prompts: composer save, selection insertion without sending, and settings cross-window sync");
}

async function checkPaneLayout() {
	const app = harness();
	app.window.innerWidth = 1400;
	await app.settle();
	const open = async (label) => { button(app, label).props.onClick(); await app.settle(); };
	const grid = () => app.node((node) => node.props.className?.startsWith("side-col"));
	const slot = (id) => app.node((node) => node.props["data-pane"] === id);
	const placement = (id) => [slot(id).props.style.gridColumn, slot(id).props.style.gridRow];
	const divider = () => app.node((node) => node.props["aria-label"] === "Resize stacked panes");
	await open("Browser");
	app.node((node) => node.type === "BrowserPane" && node.props.visible).props.onNewTab();
	await app.settle();
	await open("Terminal");
	same(placement("browser"), [1, 1]);
	same(placement("terminal"), [1, 3]);
	assert.equal(divider().props["aria-orientation"], "horizontal");
	divider().props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
	await app.settle();
	assert.equal(divider().props["aria-valuenow"], 55);
	assert.match(grid().props.style.gridTemplateRows, /55fr.*45fr/);
	await open("Changes");
	same(placement("diff"), [2, "1 / -1"], "the third pane spans the second column");
	await open("Files");
	same(placement("diff"), [2, 1]);
	same(placement("editor"), [2, 3]);
	const domOrder = () => app.nodes(grid()).filter((node) => node.props["data-pane"]).map((node) => node.props["data-pane"]);
	const stableOrder = domOrder();
	app.node((node) => node.type === "BrowserPane" && node.props.visible).props.layout.moveLater();
	await app.settle();
	same(placement("browser"), [1, 3]);
	same(domOrder(), stableOrder, "moving a pane changes grid placement without moving its DOM slot");
	app.editor().layout.onToggleExpand();
	await app.settle();
	assert.equal(grid().props.className, "side-col expanded");
	assert.equal(slot("browser").props.hidden, true);
	assert.equal(slot("terminal").props.hidden, true);
	assert.equal(slot("editor").props.hidden, false);
	assert.equal(app.node((node) => node.type === "BrowserPane").props.visible, false);
	app.key({ key: "Escape" });
	await app.settle();
	assert.equal(grid().props.className, "side-col");
	assert.equal(slot("browser").props.hidden, false);
	assert.equal(divider().props["aria-valuenow"], 55, "restoring a pane keeps its split ratio");
	app.editor().layout.onToggleExpand();
	await app.settle();
	app.sidebar().onNew();
	await app.settle();
	assert.equal(grid().props.className, "side-col", "starting another session reveals its composer");
	app.unmount();
	const narrow = harness();
	narrow.window.innerWidth = 900;
	await narrow.settle();
	for (const label of ["Changes", "Browser", "Terminal"]) { button(narrow, label).props.onClick(); await narrow.settle(); }
	const narrowGrid = narrow.node((node) => node.props.className === "side-col");
	assert.equal(narrowGrid.props.style.gridTemplateColumns, "repeat(1, minmax(0, 1fr))");
	assert.equal(narrowGrid.props["data-tall-stack"], true);
	assert.ok(900 - narrowGrid.props.style.width - 6 >= 320, "a narrow grid preserves chat width");
	narrow.unmount();
	console.log("PASS pane layout: stacked splitter, two columns, stable slot movement, expand/restore and narrow fallback");
}

async function checkNarrowWindow() {
	for (const width of [680, 900, 1400]) {
		for (const savedCollapsed of [false, true]) {
			const app = harness(new Map([["grok-code.settings.v1", JSON.stringify({ sidebarCollapsed: savedCollapsed, sideWidth: 560, railOpen: false })]]));
			app.window.innerWidth = width;
			await app.settle();
			assert.equal(app.shouldCollapseSidebar(width, false), false);
			assert.equal(app.shouldCollapseSidebar(width, true), width < 1100);
			assert.equal(!!app.node((node) => node.type === "Sidebar"), !savedCollapsed, "without a pane, the sidebar follows its saved preference");
			app.editor();
			await app.settle();
			const effectiveCollapsed = savedCollapsed || width < 1100;
			assert.equal(!!app.node((node) => node.type === "Sidebar"), !effectiveCollapsed);
			const pane = app.node((node) => node.props.className === "side-col");
			const cap = app.sideCap(width, effectiveCollapsed ? 0 : 268);
			assert.equal(pane.props.style.width, Math.min(560, cap));
			assert.ok(pane.props.style.width >= 320);
			assert.ok(width - (effectiveCollapsed ? 0 : 268) - 6 - cap >= (width < 1100 ? 320 : 400), "the pane cap preserves the chat's minimum width");
			assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).sidebarCollapsed, savedCollapsed, "automatic collapse never changes settings");
			if (width < 1100 && !savedCollapsed) {
				if (width === 680) { app.editor().onEdit("pending narrow-window edit"); await app.settle(); }
				button(app, "Browser").props.onClick();
				await app.settle();
				button(app, "Show sidebar").props.onClick();
				await app.settle();
				assert.ok(app.node((node) => node.type === "Sidebar"));
				assert.equal(app.node((node) => node.props.className === "side-col"), undefined, "one click returns from all panes to sidebar and chat");
				assert.equal(JSON.parse(app.storage.get("grok-code.settings.v1")).sidebarCollapsed, false);
				if (width === 680) { assert.ok(app.writes.some((args) => args[2] === "pending narrow-window edit"), "returning to chat flushes pending editor auto-save"); }
			}
			app.unmount();
		}
	}
	console.log("PASS narrow windows: 680/900/1400 layouts, preserved preferences, chat minimum and one-click return");
}

async function checkSandbox() {
	const { sandboxActive, sandboxChanging, sandboxChipLabel, sandboxFor, sandboxLabel, sandboxStatus } = harness().sandboxModule();
	const setup = { sandboxProfile: "strict", sandboxOption: "wsl", sandboxDockerImage: "", sandboxWslDistro: "Ubuntu", sandboxMappedFolders: [] };
	const on = { environment: "Local", sandboxOn: true };
	const started = { environment: "Local", agentSessionId: "started", sandbox: { option: "docker" } };
	assert.equal(sandboxFor({ environment: "Local" }, setup, "win32"), undefined, "a session starts without a sandbox");
	same(sandboxFor(on, setup, "linux"), { option: "profile", profile: "strict" }, "Linux uses Grok's own profile");
	same(sandboxFor(on, setup, "darwin"), { option: "profile", profile: "strict" }, "so does macOS");
	same(sandboxFor(on, setup, "win32"), { option: "wsl", profile: "strict", distro: "Ubuntu" }, "Windows uses what Settings set up");
	same(sandboxFor(started, setup, "win32"), { option: "docker" }, "a Grok session keeps the sandbox it started with");
	assert.equal(sandboxFor({ environment: "Cloud", sandboxOn: true }, setup, "win32"), undefined, "a Cloud session has its own computer");
	assert.equal(sandboxChanging(on), false, "a session Grok hasn't opened has nothing to change");
	assert.equal(sandboxChanging(started), false, "a session that hasn't been changed stays as it is");
	assert.equal(sandboxStatus(started), "Sandboxed: Docker");
	const turningOff = { ...started, sandboxOn: false };
	assert.equal(sandboxChanging(turningOff), true);
	assert.equal(sandboxActive(turningOff), true, "Grok stays sandboxed until the next message");
	assert.equal(sandboxStatus(turningOff), "Sandbox turns off with your next message");
	const turningOn = { environment: "Local", agentSessionId: "started", sandboxOn: true };
	assert.equal(sandboxChanging(turningOn), true);
	assert.equal(sandboxActive(turningOn), false, "Grok isn't sandboxed until the next message");
	assert.equal(sandboxStatus(turningOn), "Sandbox turns on with your next message");
	assert.equal(sandboxLabel({ option: "wsl", profile: "strict", distro: "Ubuntu" }), "Sandboxed: WSL, strict");
	const wsl = { option: "wsl", distro: "Ubuntu" };
	same(sandboxFor({ ...on, sandboxChoice: { option: "docker" } }, setup, "win32"), { option: "docker" }, "a session's own choice beats the last one chosen");
	const moving = { ...started, sandboxOn: true, sandboxChoice: wsl };
	assert.equal(sandboxChanging(moving), true, "choosing another sandbox is a change");
	assert.equal(sandboxActive(moving), true);
	same(sandboxFor(moving, setup, "win32"), wsl);
	assert.equal(sandboxStatus(moving), "Sandbox changes to WSL with your next message");
	assert.equal(sandboxChanging({ ...started, sandboxOn: true, sandboxChoice: { option: "docker" } }), false, "choosing the same one again changes nothing");
	assert.equal(sandboxChipLabel({ environment: "Local" }, setup, "win32"), "Sandbox");
	assert.equal(sandboxChipLabel(moving, setup, "win32"), "Sandbox · WSL", "on Windows the checkbox names the session's sandbox");
	assert.equal(sandboxChipLabel(on, setup, "linux"), "Sandbox", "macOS and Linux have only one kind");

	const sandboxBox = (appWindow) => appWindow.node((node) => node.props["aria-label"] === "Sandbox");
	const picker = (appWindow) => appWindow.node((node) => node.props.picker)?.props.picker;
	const setSandbox = async (appWindow, checked, choice = { option: "docker" }) => {
		sandboxBox(appWindow).props.onChange({ target: { checked } });
		await appWindow.settle();
		if (checked) {
			picker(appWindow).onUse(choice);
			await appWindow.settle();
		}
	};
	const app = harness(new Map([["grok-code.settings.v1", JSON.stringify({ browserControl: true })]]));
	await app.settle();
	app.sidebar().onNew();
	await app.settle();
	assert.equal(sandboxBox(app).props.checked, false, "a new session starts with the sandbox off");
	sandboxBox(app).props.onChange({ target: { checked: true } });
	await app.settle();
	assert.ok(picker(app), "on Windows, checking it opens the panel");
	assert.equal(sandboxBox(app).props.checked, false, "nothing changes until the panel is answered");
	picker(app).onClose();
	await app.settle();
	assert.equal(picker(app), undefined, "Cancel closes the panel");
	assert.equal(sandboxBox(app).props.checked, false, "and the sandbox stays off");
	await setSandbox(app, true);
	assert.equal(picker(app), undefined, "choosing closes the panel");
	assert.ok(textOf(app.node((node) => node.props.className === "meta" && textOf(node).includes("Sandboxed"))), "a new session says it will be sandboxed");
	assert.match(textOf(app.node((node) => node.props.className === "new-worktree-help")), /can't run in a sandbox on Windows/, "the Worktree option says why it's off");
	sendPrompt(app, "hello");
	await app.settle();
	const id = app.model().session.id;
	const finish = async () => {
		app.emit({ type: "done", uiSessionId: id, turnId: app.sends.at(-1).turnId });
		await app.settle();
	};
	const finishSide = async () => {
		app.emit({ type: "done", uiSessionId: `side-${id}`, turnId: app.sends.at(-1).turnId });
		await app.settle();
	};
	same(app.sends.at(-1).sandbox, { option: "docker" }, "the send names the sandbox");
	assert.equal(app.sends.at(-1).browser, false, "browser control is off in a sandboxed session");
	same(app.model().session.sandbox, { option: "docker" }, "the session keeps the sandbox it started with");
	await finish();
	sendPrompt(app, "/btw side");
	await app.settle();
	assert.equal(app.sends.at(-1).uiSessionId, `side-${id}`);
	same(app.sends.at(-1).sandbox, { option: "docker" }, "a side chat runs where the session is");
	await finishSide();

	await setSandbox(app, false);
	assert.equal(app.node((node) => node.props.className === "meta" && textOf(node).includes("Sandboxed")) !== undefined, true, "Grok stays sandboxed until the next message");
	sendPrompt(app, "/btw still there");
	await app.settle();
	same(app.sends.at(-1).sandbox, { option: "docker" }, "a side chat waits for the session's change");
	assert.equal(app.sends.at(-1).agentSessionId, "provider-session");
	await finishSide();
	sendPrompt(app, "/compact");
	await app.settle();
	same(app.sends.at(-1).sandbox, { option: "docker" }, "a command runs where the session is");
	assert.equal(app.sends.at(-1).agentSessionId, "provider-session", "a command doesn't start a new Grok session");
	assert.equal(app.sends.at(-1).text, "/compact");
	await finish();
	const working = app.api.send;
	app.api.send = async (input) => { app.sends.push(input); return { ok: false, error: "Grok could not start." }; };
	sendPrompt(app, "fails");
	await app.settle();
	same(app.model().session.sandbox, { option: "docker" }, "a change that fails leaves the session as it was");
	assert.equal(app.model().session.agentSessionId, "provider-session");
	app.api.send = working;
	sendPrompt(app, "second");
	await app.settle();
	assert.equal(app.sends.at(-1).sandbox, undefined, "the next message turns the sandbox off");
	assert.equal(app.sends.at(-1).agentSessionId, undefined, "Grok can't change a session's sandbox, so this is a new Grok session");
	assert.match(app.sends.at(-1).text, /^Earlier context from "hello"[\s\S]*User: hello[\s\S]*The person's request:\nsecond$/, "the new Grok session gets the conversation");
	assert.equal(app.model().session.sandbox, undefined, "the session is no longer sandboxed");
	assert.equal(app.model().session.agentSessionId, "provider-session");
	await finish();
	sendPrompt(app, "/btw after");
	await app.settle();
	assert.equal(app.sends.at(-1).agentSessionId, undefined, "the side chat starts over in the new place");
	assert.equal(app.sends.at(-1).sandbox, undefined);
	await finishSide();
	sendPrompt(app, "third");
	await app.settle();
	assert.equal(app.sends.at(-1).text, "third", "with no change, the conversation just continues");
	assert.equal(app.sends.at(-1).agentSessionId, "provider-session");
	await finish();
	await setSandbox(app, true);
	sendPrompt(app, "fourth");
	await app.settle();
	same(app.sends.at(-1).sandbox, { option: "docker" }, "turning it back on uses what the panel chose");
	assert.equal(app.sends.at(-1).agentSessionId, undefined);
	assert.match(app.sends.at(-1).text, /User: third[\s\S]*The person's request:\nfourth$/);
	same(app.model().session.sandbox, { option: "docker" });
	await finish();
	await setSandbox(app, false);
	await setSandbox(app, true);
	sendPrompt(app, "fifth");
	await app.settle();
	assert.equal(app.sends.at(-1).text, "fifth", "unchecking and choosing the same sandbox changes nothing");
	assert.equal(app.sends.at(-1).agentSessionId, "provider-session");
	await finish();
	await setSandbox(app, false);
	await setSandbox(app, true, wsl);
	sendPrompt(app, "sixth");
	await app.settle();
	same(app.sends.at(-1).sandbox, wsl, "a session can move to another kind of sandbox");
	assert.equal(app.sends.at(-1).agentSessionId, undefined, "and that's a new Grok session");
	assert.match(app.sends.at(-1).text, /User: fifth[\s\S]*The person's request:\nsixth$/);
	same(app.model().session.sandbox, wsl);

	const form = harness();
	await form.settle();
	form.sidebar().onNew();
	await form.settle();
	worktreeInput(form).props.onChange({ target: { checked: true } });
	await form.settle();
	assert.equal(sandboxBox(form).props.disabled, true, "on Windows a worktree session can't take a sandbox");
	assert.match(textOf(form.node((node) => node.props.id === "sandbox-unavailable")), /Turn Worktree off/, "the Sandbox option says why it's off");

	for (const platform of ["linux", "darwin"]) {
		const unix = harness(undefined, "", Date, undefined, false, platform);
		let steers = 0;
		unix.api.steer = async () => { steers += 1; return { ok: true }; };
		await unix.settle();
		unix.sidebar().onNew();
		await unix.settle();
		sandboxBox(unix).props.onChange({ target: { checked: true } });
		await unix.settle();
		sendPrompt(unix, "Start in Workspace");
		await unix.settle();
		const first = unix.sends.at(-1);
		same(first.sandbox, { option: "profile", profile: "workspace" });
		unix.key({ key: ",", ctrlKey: platform !== "darwin", metaKey: platform === "darwin" });
		await unix.settle();
		const settings = unix.node((node) => node.type?.name === "SettingsPage").props;
		settings.onChange({ sandboxProfile: "strict" });
		settings.onClose();
		await unix.settle();
		sendPrompt(unix, "Continue in Strict");
		await unix.settle();
		assert.equal(steers, 0, `${platform} queues the message until it can apply Strict`);
		assert.equal(queuedAction(unix, 0, "Steer"), undefined, "a queued message cannot steer the old profile");
		unix.emit({ type: "done", uiSessionId: first.uiSessionId, turnId: first.turnId });
		await unix.settle();
		const second = unix.sends.at(-1);
		same(second.sandbox, { option: "profile", profile: "strict" }, `${platform} applies Strict on the next message`);
		assert.equal(second.agentSessionId, undefined, "a profile change starts a new Grok session");
		assert.match(second.text, /User: Start in Workspace[\s\S]*The person's request:\nContinue in Strict$/);
		assert.equal(unix.sandboxModule().sandboxStatus(unix.model().session), "Sandboxed: Grok's sandbox, strict");
	}

	for (const platform of ["linux", "darwin"]) {
		const unix = harness(undefined, "", Date, undefined, false, platform);
		unix.api.send = async (input) => {
			unix.sends.push(input);
			return { ok: true, agentSessionId: input.agentSessionId ?? `profile-${unix.sends.length}` };
		};
		const send = async (text) => {
			sendPrompt(unix, text);
			await unix.settle();
			const sent = unix.sends.at(-1);
			unix.emit({ type: "done", uiSessionId: sent.uiSessionId, turnId: sent.turnId });
			await unix.settle();
			return sent;
		};
		const changeProfile = async (sandboxProfile) => {
			unix.key({ key: ",", ctrlKey: platform !== "darwin", metaKey: platform === "darwin" });
			await unix.settle();
			const settings = unix.node((node) => node.type?.name === "SettingsPage").props;
			settings.onChange({ sandboxProfile });
			settings.onClose();
			await unix.settle();
		};
		await unix.settle();
		unix.sidebar().onNew();
		await unix.settle();
		sandboxBox(unix).props.onChange({ target: { checked: true } });
		await unix.settle();
		await send("Main starts in Workspace");
		await send("/btw Side starts in Workspace");
		const mainAgent = unix.model().session.agentSessionId;
		await changeProfile("strict");
		const side = await send("/btw First use after tightening");
		same(side.sandbox, { option: "profile", profile: "strict" }, `${platform} side chat applies Strict on its next use`);
		assert.equal(side.agentSessionId, undefined, "the earlier side Grok session cannot retain Workspace");
		assert.match(side.text, /User: Main starts in Workspace[\s\S]*Side question: First use after tightening$/);
		const rail = harness(undefined, "", Date, undefined, false, platform);
		assert.match(textOf(rail.rail(unix.node((node) => node.type === "SessionRail").props)), /Main chat changes to Strict on next use/, "the rail identifies the main chat's pending profile");
		assert.equal(unix.model().session.agentSessionId, mainAgent, "a side change leaves the main conversation available until its next use");
		const continuedSide = await send("/btw Continue under Strict");
		assert.ok(continuedSide.agentSessionId, "a side chat already in Strict continues its new conversation");
		const strictSideAgent = continuedSide.agentSessionId;
		const main = await send("Main follows into Strict");
		same(main.sandbox, { option: "profile", profile: "strict" });
		assert.equal(main.agentSessionId, undefined, "main's next use cannot reload its Workspace session after a side change");
		assert.match(main.text, /User: Main starts in Workspace[\s\S]*The person's request:\nMain follows into Strict$/);
		assert.equal(unix.sandboxModule().sandboxStatus(unix.model().session), "Sandboxed: Grok's sandbox, strict");
		assert.equal((await send("/btw Stay in the Strict conversation")).agentSessionId, strictSideAgent, "main's switch preserves a side chat already on that profile");
		await changeProfile("workspace");
		const command = await send("/compact");
		same(command.sandbox, { option: "profile", profile: "workspace" }, `${platform} a slash command also applies the current profile`);
		assert.equal(command.agentSessionId, undefined, "the command starts a fresh Grok session");
		assert.equal(command.text, "/compact", "a slash command stays a command when the profile changes");
		assert.equal(unix.sandboxModule().sandboxStatus(unix.model().session), "Sandboxed: Grok's sandbox");
		const afterCommand = await send("/btw Follow the changed command profile");
		same(afterCommand.sandbox, { option: "profile", profile: "workspace" });
		assert.equal(afterCommand.agentSessionId, undefined, "the side chat restarts after main's command changes profile");
		sandboxBox(unix).props.onChange({ target: { checked: false } });
		await unix.settle();
		await changeProfile("strict");
		const pendingOffSide = await send("/btw Tighten the active sandbox while Off is pending");
		same(pendingOffSide.sandbox, { option: "profile", profile: "strict" }, "pending Off does not suppress the side chat's active sandbox profile change");
		assert.equal(pendingOffSide.agentSessionId, undefined);
		const tightenedCommand = await send("/compact");
		same(tightenedCommand.sandbox, { option: "profile", profile: "strict" }, "pending Off does not suppress a command's active sandbox profile change");
		assert.equal(tightenedCommand.agentSessionId, undefined);
		assert.equal(tightenedCommand.text, "/compact");
		assert.equal(unix.model().session.sandboxOn, false, "the checkbox's Off choice remains pending");
		assert.equal(unix.sandboxModule().sandboxStatus(unix.model().session), "Sandbox turns off with your next message");
		assert.equal((await send("Apply the pending checkbox")).sandbox, undefined, "an ordinary main message still applies Off");
	}

	for (const platform of ["linux", "darwin"]) {
		for (const action of ["/context", "Compact button"]) {
			let unix = harness(undefined, "", Date, undefined, false, platform);
			const attachSend = () => {
				unix.api.send = async (input) => {
					unix.sends.push(input);
					return { ok: true, agentSessionId: input.agentSessionId ?? `command-profile-${unix.sends.length}` };
				};
			};
			const finish = async () => {
				await unix.settle();
				const sent = unix.sends.at(-1);
				unix.emit({ type: "done", uiSessionId: sent.uiSessionId, turnId: sent.turnId });
				await unix.settle();
				return sent;
			};
			attachSend();
			await unix.settle();
			unix.sidebar().onNew();
			await unix.settle();
			sandboxBox(unix).props.onChange({ target: { checked: true } });
			await unix.settle();
			sendPrompt(unix, "Remember the original conversation before the command");
			await finish();
			unix.key({ key: ",", ctrlKey: platform !== "darwin", metaKey: platform === "darwin" });
			await unix.settle();
			const settings = unix.node((node) => node.type?.name === "SettingsPage").props;
			settings.onChange({ sandboxProfile: "strict" });
			settings.onClose();
			await unix.settle();
			if (action === "Compact button") { unix.node((node) => node.type === "SessionRail").props.onCompact(); }
			else { sendPrompt(unix, action); }
			const command = await finish();
			same(command.sandbox, { option: "profile", profile: "strict" });
			assert.equal(command.text, action === "Compact button" ? "/compact" : "/context");
			const notice = unix.notice();
			sendPrompt(unix, "/context");
			await finish();
			unix = harness(unix.storage, "", Date, undefined, false, platform);
			attachSend();
			await unix.settle();
			unix.api.send = async (input) => { unix.sends.push(input); return { ok: false, error: "Grok could not start." }; };
			sendPrompt(unix, "First continuation attempt");
			await finish();
			attachSend();
			sendPrompt(unix, "Continue after the command");
			const continued = await finish();
			assert.match(continued.text, /User: Remember the original conversation before the command[\s\S]*The person's request:\nContinue after the command$/, `${platform} ${action} preserves the conversation for the following main message, including after restart and a failed start`);
			assert.match(notice, /without earlier conversation[\s\S]*next main message/, "the command notice explains its actual context and the pending copy");
			sendPrompt(unix, "Continue once more");
			assert.equal((await finish()).text, "Continue once more", "the successful main message consumes the pending context copy");
		}
	}

	for (const platform of ["linux", "darwin"]) {
		const owner = harness(undefined, "", Date, undefined, false, platform);
		const finish = async (appWindow) => {
			await appWindow.settle();
			const sent = appWindow.sends.at(-1);
			appWindow.emit({ type: "done", uiSessionId: sent.uiSessionId, turnId: sent.turnId });
			await appWindow.settle();
			return sent;
		};
		const setProfile = async (appWindow, sandboxProfile) => {
			appWindow.key({ key: ",", ctrlKey: platform !== "darwin", metaKey: platform === "darwin" });
			await appWindow.settle();
			const settings = appWindow.node((node) => node.type?.name === "SettingsPage").props;
			settings.onChange({ sandboxProfile });
			settings.onClose();
			await appWindow.settle();
		};
		await owner.settle();
		owner.sidebar().onNew();
		await owner.settle();
		sandboxBox(owner).props.onChange({ target: { checked: true } });
		await owner.settle();
		sendPrompt(owner, "Remember this across windows");
		await finish(owner);
		const open = () => harness(owner.storage, `?session=${owner.model().session.id}`, Date, undefined, false, platform);
		const sleeping = open();
		const observer = open();
		const queued = open();
		await Promise.all([sleeping.settle(), observer.settle(), queued.settle()]);
		sendPrompt(queued, "An active turn in another window");
		await queued.settle();
		sendPrompt(queued, "A queued message");
		await queued.settle();
		let steers = 0;
		queued.api.steer = async () => { steers += 1; return { ok: true }; };
		await setProfile(owner, "strict");
		queuedAction(queued, 0, "Steer").props.onClick();
		await queued.settle();
		assert.equal(steers, 0, "an explicit queued Steer cannot bypass a saved profile tightening before its storage event");
		assert.ok(queuedAction(queued, 0, "Edit"), "the refused steer keeps its queue item");
		queuedAction(queued, 0, "Remove queued message").props.onClick();
		await finish(queued);
		sendPrompt(sleeping, "/context");
		const command = await finish(sleeping);
		same(command.sandbox, { option: "profile", profile: "strict" }, `${platform} a send reads a saved profile before its storage event arrives`);
		owner.storageEvent("grok-code.history.v1");
		await owner.settle();
		assert.equal(owner.model().session.sandboxContextPending, true, "adopting a command's new runtime also adopts its pending context");
		sendPrompt(observer, "Continue before the history event");
		const continued = await finish(observer);
		assert.match(continued.text, /User: Remember this across windows[\s\S]*The person's request:\nContinue before the history event$/, "synchronous runtime adoption keeps the pending conversation copy");
		owner.storageEvent("grok-code.history.v1");
		await owner.settle();
		assert.equal(owner.model().session.sandboxContextPending, undefined, "another window's completed handoff clears the marker even when its Grok ID and profile stay the same");
		owner.unmount();
		sleeping.unmount();
		observer.unmount();
		queued.unmount();

		const unsaved = harness(undefined, "", Date, undefined, false, platform);
		await unsaved.settle();
		unsaved.sidebar().onNew();
		await unsaved.settle();
		sandboxBox(unsaved).props.onChange({ target: { checked: true } });
		await unsaved.settle();
		unsaved.storage.failWrites = "quota";
		await setProfile(unsaved, "strict");
		unsaved.storage.failWrites = false;
		unsaved.storageEvent("grok-code.settings.v1");
		await unsaved.settle();
		sendPrompt(unsaved, "Keep the locally selected Strict profile");
		same((await finish(unsaved)).sandbox, { option: "profile", profile: "strict" }, "profile refresh preserves an unsaved local choice after a write failure");
		unsaved.unmount();
	}

	const view = harness();
	const tested = [];
	const changes = [];
	view.api.sandboxCheck = async () => ({ ready: false, problem: "Docker Desktop isn't installed." });
	view.api.sandboxTest = async (choice, model) => { tested.push([choice, model]); return { ok: false, checks: [{ label: "Grok can't change files outside it", pass: false }], canReadOutside: true }; };
	view.sandboxView({ settings: view.readSettings(), onChange: (patch) => { changes.push(patch); return true; } });
	await view.settle();
	assert.match(textOf(view.render()), /Docker Desktop isn't installed\./, "the tab shows what the check found");
	assert.match(textOf(view.render()), /1\. Install Docker Desktop\./, "a missing program keeps its install step");
	assert.ok(button(view, "Build image"), "Docker offers to build the image");
	assert.equal(textOf(view.render()).includes("Git Bash"), false, "Git Bash isn't offered, because it can't sandbox");
	view.node((node) => node.props.value === "wsl").props.onChange();
	same(changes, [{ sandboxOption: "wsl" }], "choosing an option saves it");
	button(view, "Test sandbox").props.onClick();
	await view.settle();
	same(tested, [[{ option: "docker" }, view.readSettings().model]], "the test runs what the settings describe");
	assert.match(textOf(view.render()), /Failed: Grok can't change files outside it\./, "a failed check is shown");

	const found = harness();
	found.api.sandboxCheck = async () => ({ ready: true, installed: true, detail: "Windows Sandbox is available." });
	found.sandboxView({ settings: { ...found.readSettings(), sandboxOption: "windows-sandbox" }, onChange: () => true });
	await found.settle();
	assert.match(textOf(found.render()), /1\. Windows Sandbox is turned on\./, "the step says it's done");
	assert.equal(textOf(found.render()).includes("Enable-WindowsOptionalFeature"), false, "a program already there needs no install command");

	// The panel a Windows session opens. A second session can't take Windows Sandbox from the one holding it.
	const panelFor = async ({ settings = {}, holder = "", sessionId = "mine", check = { ready: true, installed: true, detail: "Ready." } }) => {
		const panel = harness();
		const used = [];
		let closed = 0;
		panel.api.sandboxCheck = async () => check;
		panel.api.sandboxHolder = async () => holder;
		panel.sandboxView({ settings: { ...panel.readSettings(), ...settings }, onChange: () => true, picker: { sessionId, sessions: [{ id: "other", title: "Other work" }], onUse: (choice) => used.push(choice), onClose: () => { closed += 1; } } });
		await panel.settle();
		return { panel, used, closed: () => closed, radio: (value) => panel.node((node) => node.props.value === value) };
	};
	const free = await panelFor({});
	assert.equal(free.radio("windows-sandbox").props.disabled, false, "nothing holds Windows Sandbox");
	button(free.panel, "Use Docker").props.onClick();
	same(free.used, [{ option: "docker" }], "the panel hands back what it describes");
	button(free.panel, "Cancel").props.onClick();
	assert.equal(free.closed(), 1);
	const notReady = await panelFor({ check: { ready: false, problem: "Docker Desktop isn't installed." } });
	assert.equal(button(notReady.panel, "Use Docker").props.disabled, true, "a sandbox that isn't ready can't be chosen");
	const held = await panelFor({ holder: "other" });
	assert.equal(held.radio("windows-sandbox").props.disabled, true, "another session holds it");
	assert.match(textOf(held.panel.render()), /In use by "Other work"\. Windows runs only one at a time/, "the panel says who holds it and why");
	assert.equal(held.radio("docker").props.disabled, false, "Docker runs beside it");
	assert.equal(button(held.panel, "Use Docker").props.disabled, false);
	const heldChoice = await panelFor({ holder: "other", settings: { sandboxOption: "windows-sandbox" } });
	assert.equal(button(heldChoice.panel, "Use Windows Sandbox").props.disabled, true, "the last choice can be the one that's held");
	assert.equal(button(heldChoice.panel, "Test sandbox").props.disabled, true);
	assert.equal(button(heldChoice.panel, "Sign in").props.disabled, true);
	const own = await panelFor({ holder: "mine", settings: { sandboxOption: "windows-sandbox" } });
	assert.equal(own.radio("windows-sandbox").props.disabled, false, "a session can keep what it holds");
	assert.equal(button(own.panel, "Use Windows Sandbox").props.disabled, false);

	// A running job owns the keyboard. Starting one disables the pressed button, which drops focus out of the panel, so the panel takes it back.
	const running = await panelFor({});
	const sheet = () => running.panel.node((node) => node.props.role === "dialog");
	const escapeSheet = () => sheet().props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
	let focused = 0;
	let endJob;
	running.panel.api.sandboxBuild = () => new Promise((resolve) => { endJob = resolve; });
	running.panel.document.querySelector = (selector) => selector === "[data-sandbox-job]" ? { focus() { focused += 1; } } : null;
	assert.equal(sheet().props["data-sandbox-job"], undefined, "with no job the app's shortcuts work as usual");
	button(running.panel, "Build image").props.onClick();
	await running.panel.settle();
	assert.equal(sheet().props["data-sandbox-job"], "build", "a running job marks the panel for the app's key handler");
	assert.equal(focused, 1, "the panel takes the focus when a job starts");
	escapeSheet();
	assert.equal(running.closed(), 0, "Escape doesn't close the panel during a job, because that would stop the job");
	endJob({ ok: true });
	await running.panel.settle();
	assert.equal(sheet().props["data-sandbox-job"], undefined, "the mark goes when the job ends");
	assert.equal(focused, 1, "and the focus stays where the user left it");
	escapeSheet();
	assert.equal(running.closed(), 1, "with the job done Escape closes the panel");

	const behind = harness();
	await behind.settle();
	const idleId = await startSession(behind, "idle session");
	behind.emit({ type: "done", uiSessionId: idleId, turnId: behind.sends.at(-1).turnId });
	await behind.settle();
	const turnId = await startSession(behind, "running session");
	const jobRunning = (selector) => selector === "[data-sandbox-job]" ? {} : null;
	behind.document.querySelector = jobRunning;
	behind.key({ key: "Escape" });
	behind.key({ key: "Tab", ctrlKey: true });
	behind.key({ key: "n", ctrlKey: true });
	await behind.settle();
	same(behind.cancels, [], "Escape doesn't stop the turn behind a running job");
	assert.equal(behind.model().session.id, turnId, "shortcuts don't change the session behind a running job");
	behind.document.querySelector = () => null;
	behind.key({ key: "Escape" });
	await behind.settle();
	same(behind.cancels, [turnId], "with the job over Escape stops the turn again");
	behind.key({ key: "Tab", ctrlKey: true });
	await behind.settle();
	assert.equal(behind.model().session.id, idleId, "and Ctrl+Tab switches again");
	behind.document.querySelector = jobRunning;
	const jobAsk = behind.ask({ title: "During a job", ok: "Continue" });
	await behind.settle();
	behind.key({ key: "Escape" });
	await behind.settle();
	assert.equal(await jobAsk, false, "a confirm over the panel still answers Escape");
	console.log("PASS sandbox settings: the panel, the choice, the session keeping it, its label, and Windows Sandbox held by one session");
}

async function checkLoops() {
	const app = harness();
	await app.settle();
	const id = app.model().session.id;
	const when = new Date("2026-11-06T15:04:00.000Z").toLocaleString();
	app.emit({ type: "loops", uiSessionId: id, loops: [
		{ id: "live", prompt: "watch the build", schedule: "every minute", nextFireAt: "2026-11-06T15:04:00.000Z" },
		{ id: "later", prompt: "check mail", schedule: "", nextFireAt: "" },
	] });
	await app.settle();
	const lines = app.nodes().filter((node) => node.props.className === "loop-line");
	assert.equal(lines.length, 2, "each loop is one line above the composer");
	assert.equal(textOf(lines[0]), `watch the build · every minute · next ${when}`);
	assert.equal(textOf(lines[1]), "check mail · interval unknown · next run unknown");
	assert.equal(app.sidebar().loopCounts[id], 2, "the sidebar row gets the count");
	app.emit({ type: "loops", uiSessionId: `side-${id}`, loops: [{ id: "side", prompt: "side loop", schedule: "every hour", nextFireAt: "2026-11-06T16:00:00.000Z" }] });
	await app.settle();
	assert.equal(app.nodes().filter((node) => node.props.className === "loop-line").length, 2, "a side-chat loop stays off the main composer");
	assert.equal(app.sidebar().loopCounts[id], 3);
	app.api.sessionLoops = async () => ({ ok: true, live: true });
	app.sidebar().onSelect(id);
	await app.settle();
	assert.ok(textOf(app.nodes().find((node) => node.props.className === "loop-line")).includes("watch the build"), "selecting a live session keeps the notified next run");
	sendPrompt(app, "hello");
	await app.settle();
	const reads = [];
	app.api.sessionLoops = async (uiSessionId, agentSessionId) => {
		reads.push([uiSessionId, agentSessionId]);
		return { ok: true, live: false, loops: [{ id: "cold", prompt: "from disk", schedule: "every 5 minutes", nextFireAt: "" }] };
	};
	app.emit({ type: "loops", uiSessionId: id, loops: [], reset: true });
	await app.settle();
	assert.deepEqual(reads, [[id, app.model().session.agentSessionId]]);
	const cold = app.nodes().filter((node) => node.props.className === "loop-line");
	assert.equal(textOf(cold[0]), "from disk · every 5 minutes · next run unknown");
	assert.equal(app.sidebar().loopCounts[id], 2, "the cold loop plus the side-chat loop");
	console.log("PASS scheduled loops: chat lines, sidebar count, and cold read");
}

async function checkSignInProfile() {
	const app = harness();
	const fakeKey = `xai-${"a".repeat(80)}`;
	const mainRedact = require("../electron/redact.cjs").redactKeys;
	for (const sample of [fakeKey, `\\n${fakeKey}`, "xai-grok-cli", "xai.api_key"]) {
		assert.equal(app.redactKeys(sample) === mainRedact(sample), true, "both masking boundaries use the same pattern");
	}
	let mode = "grok";
	let readinessCalls = 0;
	let removeCalls = 0;
	let oldBilling;
	app.api.billing = () => new Promise((resolve) => { oldBilling = resolve; });
	app.api.signInStatus = async () => ({ mode, hasKey: mode === "key", keyReadable: mode === "key", keyring: true });
	app.api.readiness = async () => {
		readinessCalls++;
		return { grok: { ok: true, signedIn: true, signIn: mode === "key" ? "key" : "saved", signInMode: mode }, git: { ok: true }, gh: { ok: true } };
	};
	app.api.removeSignInKey = async () => { removeCalls++; return { ok: true }; };
	await app.settle();
	mode = "key";
	app.emit({ type: "sign-in-changed" });
	await app.settle();
	oldBilling({ ok: true, percent: 99, period: "daily", resetsAt: "", tier: "old" });
	await app.settle();
	assert.equal(app.sidebar().signInMode, "key");
	assert.equal(readinessCalls, 2, "sign-in changes rerun setup");
	assert.equal(app.node((node) => node.props.className?.startsWith("limit-meter")), undefined, "key mode hides stale subscription limits");
	sendPrompt(app, "/logout");
	await app.settle();
	assert.ok(app.node((node) => node.props.role === "alertdialog" && node.props["aria-label"] === "Change how Grok signs in?"));
	button(app, "Remove key").props.onClick();
	await app.settle();
	assert.equal(removeCalls, 1, "/logout uses the confirmed key-removal flow");

	sendPrompt(app, "Check masking");
	await app.settle();
	const turn = app.sends.at(-1);
	app.emit({ type: "chunk", uiSessionId: turn.uiSessionId, turnId: turn.turnId, text: `Key:\n${fakeKey.slice(0, 14)}` });
	await app.settle();
	await app.beforeUnload();
	app.emit({ type: "chunk", uiSessionId: turn.uiSessionId, turnId: turn.turnId, text: fakeKey.slice(14) });
	app.emit({ type: "done", uiSessionId: turn.uiSessionId, turnId: turn.turnId });
	await app.settle();
	assert.equal(app.model().messages.at(-1).text === "Key:\n[redacted]", true, "joined output is masked after a flush");
	const history = savedHistory(app);
	assert.equal(JSON.stringify(history).includes(fakeKey), false, "saved history has no complete key in joined output");

	const session = history.sessions.find((item) => item.id === turn.uiSessionId);
	session.folder = `C:/project/${fakeKey}`;
	const toolPath = `${session.folder}/a.txt`;
	const editorKey = JSON.stringify([session.id, session.folder, "a.txt"]);
	const draft = { text: `draft=${fakeKey}\r\n`, baseText: `base=${fakeKey}\r\n`, recoveryTexts: [`recovery=${fakeKey}\r\n`], version: "a1" };
	history.editorDrafts[editorKey] = draft;
	history.extraChats[session.id].push({
		id: "old-key", role: "grok", text: `Old:\n${fakeKey}`, parts: [{ kind: "text", text: fakeKey }],
		contextFrom: [{ id: "earlier-chat", title: fakeKey }],
		tools: [{ id: "old-tool", kind: "command", title: "Run", detail: `Error: ${fakeKey}`, output: fakeKey, path: toolPath }],
	});
	const reopened = harness(new Map([["grok-code.history.v1", JSON.stringify(history)]]));
	await reopened.settle();
	const old = reopened.model().messages.at(-1);
	assert.equal(old.text === "Old:\n[redacted]" && old.parts[0].text === "[redacted]", true, "legacy chat is masked at load");
	assert.equal(old.tools[0].output === "[redacted]" && old.tools[0].detail === "Error: [redacted]", true, "legacy tool output and errors are masked at load");
	assert.equal(old.contextFrom[0].id === "earlier-chat" && old.contextFrom[0].title === "[redacted]", true, "copied chat titles are masked without changing context ids");
	assert.equal(old.tools[0].path === toolPath && reopened.model().session.folder === session.folder, true, "paths retain their exact values at load");
	const recovered = reopened.editor().draft;
	assert.equal(recovered.text === draft.text && recovered.baseText === draft.baseText && recovered.recoveryTexts[0] === draft.recoveryTexts[0], true, "draft, baseline and recovery text retain their exact bytes at load");
	reopened.sidebar().onRename(session.id, "History mask check");
	await reopened.settle();
	const saved = savedHistory(reopened);
	assert.equal(JSON.stringify(saved.editorDrafts[editorKey]) === JSON.stringify(draft), true, "the next save preserves editor data byte for byte");
	assert.equal(saved.extraChats[session.id].at(-1).text === "Old:\n[redacted]", true, "the next save masks legacy chat");
	assert.equal(saved.extraChats[session.id].at(-1).tools[0].path === toolPath, true, "the next save preserves paths");
	app.unmount();
	reopened.unmount();
	console.log("PASS sign-in profile: cross-window refresh, key removal, hidden limits and chat-only history masking");
}

async function checkSignInSettings() {
	const app = harness();
	const key = "test-not-a-key";
	const saves = [];
	let allowSignOut = false;
	let saveError;
	app.api.saveSignIn = async (input, options) => {
		saves.push({ mode: input.mode, validKey: input.key === key, confirmed: options?.signOutConfirmed === true });
		if (saveError) { return { ok: false, error: saveError }; }
		if (!options?.signOutConfirmed) { app.confirmAnswer = allowSignOut; return { ok: false, needsSignOut: true }; }
		return { ok: true };
	};
	app.settingsView({ settings: app.readSettings(), onChange() {}, onClose() {}, onCheckSetup() {}, onRun() {}, servers: [], folder: "C:/project", signInStatus: { mode: "grok", hasKey: false, keyReadable: false, keyring: true }, cloudKeyStatus: { hasKey: true, keyReadable: true, keyring: true } });
	await app.settle();
	app.node((node) => node.props["aria-label"] === "xAI API key").props.onChange();
	await app.settle();
	const input = app.node((node) => node.props["aria-label"] === "xAI API key value");
	assert.equal(input.props.type, "password");
	assert.equal(input.props.autoComplete, "off");
	assert.equal(Object.hasOwn(input.props, "value"), false, "the key field is uncontrolled");
	const field = { value: "" };
	input.props.ref.current = field;
	async function save() {
		field.value = ` ${key}\r\n`;
		app.confirmAnswer = true;
		app.node((node) => node.props["aria-label"] === "Sign-in settings").props.onSubmit({ preventDefault() {} });
		await app.settle();
		assert.equal(field.value === "", true, "Save clears the password field");
	}
	await save();
	assert.deepEqual(saves, [{ mode: "key", validKey: true, confirmed: false }], "declining machine-wide sign-out prevents the confirmed save");
	allowSignOut = true;
	await save();
	assert.deepEqual(saves.slice(1), [{ mode: "key", validKey: true, confirmed: false }, { mode: "key", validKey: true, confirmed: true }]);
	assert.match(app.confirms.at(-1), /in a terminal too/);
	saveError = "Enter an API key of 1 to 512 characters with no spaces.";
	await save();
	assert.equal(textOf(app.node((node) => node.props.role === "alert")), saveError, "fixed key validation errors explain what to correct");
	let cursorRemovals = 0;
	app.api.cloudKeyRemove = async () => { cursorRemovals++; return { ok: true }; };
	const cursorField = { value: "unsaved replacement" };
	app.node((node) => node.props["aria-label"] === "Cursor API key").props.ref.current = cursorField;
	app.confirmAnswer = false;
	button(app, "Remove").props.onClick();
	await app.settle();
	assert.equal(cursorRemovals, 0);
	assert.equal(cursorField.value, "unsaved replacement", "cancel keeps the entered key");
	app.confirmAnswer = true;
	button(app, "Remove").props.onClick();
	await app.settle();
	assert.equal(cursorRemovals, 1);
	assert.match(app.confirms.at(-1), /Remove the Cursor API key/);
	app.unmount();
}

function fakeCloud(app, resumeResult = { ok: true }) {
	const { items: models } = require("./fixtures/cloud/models.json");
	const setups = [], sends = [], resumes = [], cancels = [];
	app.api.cloudKeyStatus = async () => ({ hasKey: true, keyReadable: true, keyring: true, name: "Test Cursor key" });
	app.api.cloudSetup = async (folder) => {
		setups.push(folder);
		const ref = folder.endsWith("second") ? "release" : "main";
		return { ok: true, repoUrl: `https://github.com/example/${path.basename(folder)}`, ref, upstream: `origin/${ref}`, reachable: true, ahead: 0, behind: 0, dirty: false, models };
	};
	app.api.cloudSend = async (input) => { sends.push(input); return { ok: true }; };
	app.api.cloudResume = async (input) => { resumes.push(input); return resumeResult; };
	app.api.cloudCancel = async (id) => { cancels.push(id); return { ok: true }; };
	return { setups, sends, resumes, cancels, models };
}

async function openCloudForm(app, attachment) {
	await app.settle();
	app.sidebar().onNewIn({ folder: "C:/first", project: "first", branch: "main", worktree: "first", environment: "Local" });
	await app.settle();
	if (attachment) { stageAttachments(app, [attachment]); await app.settle(); }
	chooseEnvironment(app, "Cloud");
	await app.settle();
}

function cloudState(app, turn, active, result = {}) {
	app.emit({ type: "cloud-state", uiSessionId: turn.uiSessionId, turnId: turn.turnId, agentId: "bc-example", runId: "run-example", active, ...result });
}

function cloudReply(app, turn) {
	const replies = app.model().messages.filter((item) => item.role === "grok");
	const matches = replies.filter((item) => item.id === `grok-${turn.turnId}`);
	assert.equal(matches.length, 1, "the Cloud turn has exactly one reply keyed by turn id");
	return matches[0];
}

function checkCloudModels() {
	const app = harness();
	const { items: models } = require("./fixtures/cloud/models.json");
	const { defaultVariant, chooseVariant } = app.cloudModels();
	for (const model of models) {
		same(chooseVariant(model), model.variants.find((variant) => variant.isDefault), `${model.id} selects Cursor's default variant`);
	}
	const grok = models.find((model) => model.id === "grok-4.7");
	const selected = defaultVariant(models);
	assert.equal(selected.id, grok.id);
	same(selected.params, grok.variants.find((variant) => variant.isDefault).params);
	assert.equal(selected.isMaxMode, true);
	assert.equal(defaultVariant(models.filter((model) => model.id !== grok.id)).id, "default");
	const opus = models.find((model) => model.id === "claude-opus-5");
	const maxFast = opus.variants.find((variant) => variant.params.some((param) => param.id === "effort" && param.value === "max") && variant.params.some((param) => param.id === "context" && param.value === "1m") && variant.params.some((param) => param.id === "fast" && param.value === "true"));
	const withoutThinking = chooseVariant(opus, maxFast.params, "thinking", "false");
	same(Object.fromEntries(withoutThinking.params.map(({ id, value }) => [id, value])), { cyber: "false", thinking: "false", context: "1m", effort: "low", fast: "true" }, "equal matches keep the first provider variant and preserve context and speed");
	for (const current of opus.variants) {
		for (const parameter of opus.parameters) {
			for (const option of parameter.values) {
				if (!opus.variants.some((variant) => variant.params.some((param) => param.id === parameter.id && param.value === option.value))) { continue; }
				const next = chooseVariant(opus, current.params, parameter.id, option.value);
				assert.ok(opus.variants.some((variant) => JSON.stringify(variant) === JSON.stringify(next)), "a value row picks a real Cursor variant");
				assert.ok(next.params.some((param) => param.id === parameter.id && param.value === option.value), "the requested value is selected");
				assert.ok(next.params.some((param) => param.id === "cyber" && param.value === "false"), "unlisted cyber parameter is preserved");
			}
		}
	}
	app.unmount();
	console.log("PASS Cloud models: provider defaults, Max Mode, Auto fallback and constrained value rows");
}

async function checkCloudSend() {
	const app = harness(), bridge = fakeCloud(app);
	const steers = [];
	app.api.steer = async (id, text) => { steers.push([id, text]); return { ok: true }; };
	await openCloudForm(app);
	assert.deepEqual(bridge.setups, ["C:/first"]);
	app.pickedFolders.push("C:/second");
	folderChip(app).props.onClick();
	app.render();
	button(app, "Choose a folder").props.onClick();
	await app.settle();
	assert.deepEqual(bridge.setups, ["C:/first", "C:/second"], "changing the Cloud form's folder checks its new upstream");
	const prompt = `Cloud task ${"a".repeat(100)}`;
	sendPrompt(app, prompt);
	await app.settle();
	assert.equal(app.sends.length, 0, "Cloud uses its own bridge");
	assert.equal(bridge.sends.length, 1);
	const turn = bridge.sends[0];
	assert.equal(turn.uiSessionId, app.model().session.id);
	assert.equal(turn.name, prompt.slice(0, 80));
	assert.equal(turn.text, prompt);
	assert.equal(turn.cloud.repoUrl, "https://github.com/example/second");
	assert.equal(turn.cloud.ref, "release");
	assert.equal(turn.cloud.autoCreatePR, false);
	const grok = bridge.models.find((model) => model.id === "grok-4.7");
	same(turn.cloud.model, { id: grok.id, params: grok.variants.find((variant) => variant.isDefault).params });
	cloudReply(app, turn);
	cloudState(app, turn, true);
	await app.settle();
	sendPrompt(app, "Queue this for the same Cloud agent");
	await app.settle();
	assert.equal(bridge.sends.length, 1);
	assert.deepEqual(steers, []);
	assert.ok(app.nodes().some((node) => node.props.className === "queued" && textOf(node).includes("Queue this for the same Cloud agent")));
	cloudState(app, turn, false);
	app.emit({ type: "error", uiSessionId: turn.uiSessionId, turnId: turn.turnId, message: "Cursor could not finish this turn." });
	await app.settle();
	assert.equal(bridge.sends.length, 1, "an error does not start the queued Cloud message");
	assert.equal(app.model().busy, false);
	same(savedHistory(app).queued[turn.uiSessionId].map((item) => item.text), ["Queue this for the same Cloud agent"]);
	app.unmount();

	const failed = harness(), failedBridge = fakeCloud(failed);
	await openCloudForm(failed);
	sendPrompt(failed, "Run until Cursor fails");
	await failed.settle();
	const failedTurn = failedBridge.sends[0];
	cloudState(failed, failedTurn, true);
	sendPrompt(failed, "Do not send this after the failure");
	await failed.settle();
	failed.emit({ type: "chunk", uiSessionId: failedTurn.uiSessionId, turnId: failedTurn.turnId, text: "\n\nCursor ended the run with an error." });
	failed.emit({ type: "error", uiSessionId: failedTurn.uiSessionId, turnId: failedTurn.turnId });
	await failed.settle();
	assert.equal(failedBridge.sends.length, 1, "a failed Cloud run keeps the queued prompt");
	const failedReply = cloudReply(failed, failedTurn);
	assert.equal(failedReply.pending, false, "a failed Cloud run ends the reply");
	assert.equal(failedReply.streaming, false);
	same(savedHistory(failed).queued[failedTurn.uiSessionId].map((item) => item.text), ["Do not send this after the failure"]);
	failed.unmount();

	const withFile = harness(), attached = fakeCloud(withFile);
	await openCloudForm(withFile, "C:/first/notes.md");
	sendPrompt(withFile, "Send my staged notes");
	await withFile.settle();
	assert.equal(attached.sends.length, 0, "a staged Local attachment cannot be sent after switching the form to Cloud");
	assert.equal(withFile.notice(), "Cloud sessions can't take attachments yet.");
	assert.equal(withFile.node((node) => node.props["aria-label"] === "Prompt").props.value, "Send my staged notes");
	withFile.unmount();
	for (const reachable of [null, false]) {
		const lookup = harness(), attempt = fakeCloud(lookup);
		const setup = lookup.api.cloudSetup;
		lookup.api.cloudSetup = async (...args) => ({ ...await setup(...args), reachable, ...(reachable === null ? { error: "Cursor repositories timed out." } : {}) });
		await openCloudForm(lookup);
		typePrompt(lookup, "Start the Cloud session");
		await lookup.settle();
		const send = button(lookup, "Send");
		assert.equal(send.props.disabled, reachable === false, "only a definite repository mismatch blocks Send");
		if (reachable === null) {
			send.props.onClick();
			await lookup.settle();
			assert.equal(attempt.sends.length, 1, "an unavailable repositories check still reaches Cloud send");
		}
		lookup.unmount();
	}
	console.log("PASS Cloud send: folder recheck, turn reply id, queue, error hold and attachment refusal");
}

async function checkCloudModelRetry() {
	const app = harness(), bridge = fakeCloud(app);
	await openCloudForm(app);
	sendPrompt(app, "Start the Cloud agent");
	await app.settle();
	const turn = bridge.sends[0];
	assert.equal(turn.cloud.repoUrl, "https://github.com/example/first");
	assert.equal(turn.cloud.ref, "main");
	app.emit({ type: "error", uiSessionId: turn.uiSessionId, turnId: turn.turnId, message: "Cursor refused to start the agent." });
	await app.settle();
	await app.beforeUnload();
	await app.settle();
	assert.equal(app.model().session.cloud.agentId, undefined);
	app.unmount();

	const reopened = harness(app.storage, `?session=${encodeURIComponent(turn.uiSessionId)}`);
	const retry = fakeCloud(reopened);
	const setup = reopened.api.cloudSetup;
	reopened.api.cloudSetup = async (folder) => ({ ...await setup(folder), repoUrl: "https://github.com/example/other", ref: "different-ref", upstream: "origin/different-ref" });
	await reopened.settle();
	reopened.node((node) => node.props.title === "Cursor model (Ctrl+Shift+I)").props.onClick();
	await reopened.settle();
	button(reopened, "Try again").props.onClick();
	await reopened.settle();
	assert.deepEqual(retry.setups, ["C:/first"], "Try again reloads the model catalog from the folder's current setup");
	button(reopened, "Auto").props.onClick();
	await reopened.settle();
	sendPrompt(reopened, "Retry with Auto");
	await reopened.settle();
	assert.equal(retry.sends.length, 1);
	const sent = retry.sends[0];
	assert.equal(sent.uiSessionId, turn.uiSessionId);
	same(sent.cloud.model, { id: "default", params: [] });
	assert.equal(sent.cloud.repoUrl, turn.cloud.repoUrl, "model selection preserves the saved session repository");
	assert.equal(sent.cloud.ref, turn.cloud.ref, "model selection preserves the saved starting ref");
	reopened.unmount();
	console.log("PASS Cloud model retry: a refreshed catalog does not change the saved repository or starting ref");
}

async function startCloudReply() {
	const app = harness(), bridge = fakeCloud(app);
	await openCloudForm(app);
	sendPrompt(app, "Start this Cloud task");
	await app.settle();
	assert.equal(bridge.sends.length, 1);
	const turn = bridge.sends[0];
	cloudState(app, turn, true);
	app.emit({ type: "chunk", uiSessionId: turn.uiSessionId, turnId: turn.turnId, text: "Original partial reply" });
	app.emit({ type: "thought", uiSessionId: turn.uiSessionId, turnId: turn.turnId, text: "Original thought" });
	app.emit({ type: "tool", uiSessionId: turn.uiSessionId, turnId: turn.turnId, tool: { id: "old-tool", kind: "tool", title: "Read", detail: "Completed", waiting: false } });
	await app.settle();
	await app.beforeUnload();
	await app.settle();
	assert.match(cloudReply(app, turn).text, /Original partial reply/);
	return { app, bridge, turn };
}

async function checkCloudReplay() {
	const warning = "Interrupted when this window closed. The Cloud agent may have started; check [Cursor agents](https://cursor.com/agents) before sending again.";
	const { app, turn } = await startCloudReply();
	app.unmount();
	const reopened = harness(app.storage, `?session=${encodeURIComponent(turn.uiSessionId)}`);
	const bridge = fakeCloud(reopened);
	await reopened.settle();
	assert.equal(bridge.resumes.length, 1, "opening saved history resumes the active Cloud run");
	assert.equal(bridge.resumes[0].uiSessionId, turn.uiSessionId);
	assert.equal(bridge.resumes[0].turnId, turn.turnId);
	assert.equal(bridge.resumes[0].cloud.runId, "run-example");
	assert.equal(cloudReply(reopened, turn).text, "Original partial reply", "an active run's reply is restored without a warning");
	const forTurn = { uiSessionId: turn.uiSessionId, turnId: turn.turnId };
	reopened.emit({ type: "turn-start", ...forTurn, resume: true });
	await reopened.settle();
	const reset = cloudReply(reopened, turn);
	assert.equal(reset.text, "");
	assert.equal(reset.thought || "", "");
	assert.equal(reset.tools?.length ?? 0, 0);
	assert.equal(reset.parts?.length ?? 0, 0);
	const branch = "cursor/example", prUrl = "https://github.com/example/first/pull/1";
	const links = `\n\nBranch: ${branch} · <${prUrl}>`;
	reopened.emit({ type: "chunk", ...forTurn, text: "Replayed reply" });
	reopened.emit({ type: "chunk", ...forTurn, text: links });
	cloudState(reopened, turn, false, { branch, prUrl });
	reopened.emit({ type: "done", ...forTurn });
	await reopened.settle();
	const final = cloudReply(reopened, turn);
	assert.equal(final.text, `Replayed reply${links}`);
	assert.equal(final.streaming, false);
	assert.equal(reopened.model().messages.filter((message) => message.role === "grok").length, 1);
	assert.equal(reopened.model().session.cloud.prUrl, prUrl);
	assert.equal(reopened.model().session.cloud.active, false);
	reopened.unmount();

	const beforeCreate = harness();
	const creatingBridge = fakeCloud(beforeCreate);
	await openCloudForm(beforeCreate);
	sendPrompt(beforeCreate, "Reload while Cursor starts the agent");
	await beforeCreate.settle();
	assert.equal(creatingBridge.sends.length, 1);
	const creating = creatingBridge.sends[0];
	await beforeCreate.beforeUnload();
	await beforeCreate.settle();
	const pending = savedHistory(beforeCreate).sessions.find((item) => item.id === creating.uiSessionId).cloud;
	assert.equal(!!pending.active, false);
	assert.equal(pending.agentId, undefined);
	assert.equal(pending.runId, undefined);
	beforeCreate.unmount();
	const reloadedOwner = harness(beforeCreate.storage, `?session=${encodeURIComponent(creating.uiSessionId)}`);
	const lateBridge = fakeCloud(reloadedOwner);
	await reloadedOwner.settle();
	assert.equal(lateBridge.resumes.length, 0, "startup cannot resume before Cursor returns run ids");
	const savedReply = cloudReply(reloadedOwner, creating);
	assert.equal(savedReply.streaming, false);
	assert.equal(savedReply.text, warning, "an interrupted create without run ids warns before another send");
	cloudState(reloadedOwner, creating, true);
	await reloadedOwner.settle();
	assert.equal(lateBridge.resumes.length, 1, "the owning window reload resumes when the late Cloud state arrives");
	const resumed = lateBridge.resumes[0];
	assert.equal(resumed.uiSessionId, creating.uiSessionId);
	assert.equal(resumed.turnId, creating.turnId);
	assert.equal(resumed.cloud.agentId, "bc-example");
	assert.equal(resumed.cloud.runId, "run-example");
	same(cloudReply(reloadedOwner, creating), savedReply, "receiving run ids preserves the saved reply until replay starts");
	reloadedOwner.emit({ type: "turn-start", uiSessionId: creating.uiSessionId, turnId: creating.turnId, resume: true });
	await reloadedOwner.settle();
	const replaying = cloudReply(reloadedOwner, creating);
	assert.equal(replaying.streaming, true);
	assert.equal(replaying.text, "");
	reloadedOwner.unmount();
	console.log("PASS Cloud restart: startup and late-id resume replace one reply and preserve result links after done");
}

async function checkCloudWindows() {
	const { app: owner, bridge, turn } = await startCloudReply();
	const observer = harness(owner.storage, `?session=${encodeURIComponent(turn.uiSessionId)}`);
	const refused = "This session is running in another window.";
	const other = fakeCloud(observer, { ok: false, error: refused });
	await observer.settle();
	assert.equal(other.resumes.length, 1);
	assert.equal(other.resumes[0].turnId, turn.turnId);
	assert.equal(observer.notice(), refused);
	const forTurn = { uiSessionId: turn.uiSessionId, turnId: turn.turnId };
	owner.emit({ type: "turn-start", ...forTurn, resume: true });
	owner.emit({ type: "chunk", ...forTurn, text: "Owner replay" });
	owner.emit({ type: "tool", ...forTurn, tool: { id: "new-tool", kind: "tool", title: "Read", detail: "Completed", waiting: false } });
	await owner.settle();
	assert.equal(cloudReply(owner, turn).text, "Owner replay");
	assert.equal(owner.model().messages.filter((message) => message.role === "grok").length, 1);
	button(owner, "Stop").props.onClick();
	await owner.settle();
	assert.deepEqual(bridge.cancels, [turn.uiSessionId]);
	assert.deepEqual(owner.cancels, [], "Cloud Stop does not call the local agent");
	assert.deepEqual(other.cancels, []);
	observer.unmount();
	owner.unmount();
	console.log("PASS Cloud windows: another window's resume is refused and owner replay and Stop still work");
}

const runOnField = (app) => app.node((node) => node.props["aria-label"] === "Run on");
const machineNameField = (app) => app.node((node) => node.props["aria-label"] === "Machine name");

async function chooseMachine(app, name) {
	runOnField(app).props.onChange({ target: { value: "machine" } });
	await app.settle();
	if (name !== undefined) {
		machineNameField(app).props.onChange({ target: { value: name } });
		await app.settle();
	}
}

function enterPrompt(app) {
	app.node((node) => node.props["aria-label"] === "Prompt").props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
}

async function checkMachineDraft() {
	const app = harness();
	fakeCloud(app);
	await app.settle();
	const original = await startSession(app, "A saved Local session");
	app.emit({ type: "done", uiSessionId: original, turnId: app.sends.at(-1).turnId });
	await app.settle();
	assert.equal(runOnField(app), undefined);
	await openCloudForm(app);
	assert.equal(runOnField(app).props.value, "cloud");
	assert.equal(machineNameField(app), undefined);
	await chooseMachine(app, "  laptop-2_  ");
	typePrompt(app, "Keep this machine draft");
	app.sidebar().onSelect(original);
	await app.settle();
	assert.equal(runOnField(app), undefined);
	app.sidebar().onNew();
	await app.settle();
	assert.equal(runOnField(app).props.value, "machine");
	assert.equal(machineNameField(app).props.value, "  laptop-2_  ");
	await app.beforeUnload();
	await app.settle();
	app.unmount();

	const reloaded = harness(app.storage);
	fakeCloud(reloaded);
	await reloaded.settle();
	assert.equal(runOnField(reloaded).props.value, "machine");
	assert.equal(machineNameField(reloaded).props.value, "  laptop-2_  ");
	assert.equal(reloaded.node((node) => node.props["aria-label"] === "Prompt").props.value, "Keep this machine draft");
	chooseEnvironment(reloaded, "Local");
	await reloaded.settle();
	assert.equal(runOnField(reloaded), undefined);
	assert.equal(machineNameField(reloaded), undefined);
	chooseEnvironment(reloaded, "Cloud");
	await reloaded.settle();
	assert.equal(runOnField(reloaded).props.value, "cloud");
	assert.equal(machineNameField(reloaded), undefined, "switching environments resets the machine choice");
	reloaded.unmount();
	console.log("PASS My machines draft: Cloud-only Run on, kept and restored names, and environment reset");
}

async function checkMachineSend() {
	const remembered = [{ name: "desktop", repo: "example/first" }, { name: "other-machine", repo: "example/other" }];
	const storage = new Map([["grok-code.settings.v1", JSON.stringify({ cursorMachines: [
		{ name: "desktop", repo: " EXAMPLE/FIRST " }, remembered[0], remembered[1],
		{ name: "-invalid", repo: "example/first" }, { name: "no-repo", repo: " " },
	] })]]);
	const app = harness(storage), bridge = fakeCloud(app);
	const copied = [];
	app.api.copyText = async (text) => { copied.push(text); return { ok: true }; };
	await openCloudForm(app);
	same(app.readSettings().cursorMachines, remembered);
	const prToggle = () => app.node((node) => node.type === "label" && textOf(node).trim() === "Open a pull request");
	app.nodes(prToggle()).find((node) => node.type === "input").props.onChange({ target: { checked: true } });
	await app.settle();
	assert.equal(app.nodes(prToggle()).find((node) => node.type === "input").props.checked, true);
	await chooseMachine(app);
	assert.equal(prToggle(), undefined);
	const suggestions = () => {
		const list = app.node((node) => node.type === "datalist" && node.props.id === machineNameField(app).props.list);
		assert.ok(list);
		return app.nodes(list).filter((node) => node.type === "option").map((node) => node.props.value);
	};
	same(suggestions(), ["desktop"], "suggestions stay with this repository");
	const hint = app.node((node) => node.props.id === machineNameField(app).props["aria-describedby"]);
	assert.equal(textOf(hint), "Letters, digits, dots, dashes and underscores. Start with a letter or digit, and don't end with a dot. Capitals count: type it as the worker shows it.");
	const draftId = app.model().session.id;
	typePrompt(app, "Run this on my machine");
	assert.equal(button(app, "Send").props.disabled, true, "a blank machine name keeps Send disabled");
	machineNameField(app).props.onChange({ target: { value: "laptop." } });
	await app.settle();
	assert.equal(button(app, "Send").props.disabled, true);
	enterPrompt(app);
	await app.settle();
	assert.equal(bridge.sends.length, 0);
	assert.equal(app.sidebar().sessions.some((item) => item.id === draftId), false, "Enter cannot create a machine session with an invalid name");
	machineNameField(app).props.onChange({ target: { value: "  laptop  " } });
	await app.settle();
	assert.equal(button(app, "Send").props.disabled, false);
	const branchNote = "The agent is told to work on a branch of its own, started from main on GitHub, and not to push, so its commits stay in that clone. It works with that computer's Git sign-in, so nothing but that instruction stops a push.";
	assert.ok(app.nodes().some((node) => node.type === "p" && textOf(node) === branchNote));
	const commands = [
		"git clone https://github.com/example/first.git first-cursor-laptop",
		"cursor-agent worker start --name laptop --worker-dir first-cursor-laptop",
	];
	const copyButtons = app.nodes().filter((node) => node.type === "button" && node.props["aria-label"]?.startsWith("Copy "));
	same(copyButtons.map((node) => node.props["aria-label"]), commands.map((command) => `Copy ${command}`), "setup has exactly two commands and no cd");
	for (const node of copyButtons) { node.props.onClick(); }
	await app.settle();
	assert.deepEqual(copied, commands);
	sendPrompt(app, "Run this on my machine");
	await app.settle();
	assert.equal(bridge.sends.length, 1);
	const turn = bridge.sends[0];
	assert.equal(turn.cloud.machine, "laptop");
	assert.equal(turn.cloud.autoCreatePR, false);
	const saved = savedHistory(app).sessions.find((item) => item.id === turn.uiSessionId);
	assert.equal(saved.cloud.machine, "laptop");
	assert.equal(Object.hasOwn(saved, "cloudMachineDraft"), false);
	same(app.readSettings().cursorMachines, remembered, "sending does not remember a name");
	const branch = "grok/machine-8b7104e0";
	cloudState(app, turn, true, { branch });
	await app.settle();
	same(app.readSettings().cursorMachines, remembered, "an agent id does not mean the worker ran successfully");
	cloudState(app, turn, false);
	app.emit({ type: "done", uiSessionId: turn.uiSessionId, turnId: turn.turnId });
	await app.settle();
	same(app.readSettings().cursorMachines, remembered, "done without a machine name does not remember it");
	assert.ok(app.nodes().some((node) => node.props.className === "meta" && textOf(node).includes(`first · ${branch} · laptop`)));
	sendPrompt(app, "/status");
	await app.settle();
	assert.match(app.model().messages.at(-1).text, /Grok 4\.7 · Max · laptop/);
	assert.equal(bridge.sends.length, 1, "/status stays local");
	app.node((node) => node.props.title === "Environment").props.onClick();
	await app.settle();
	assert.ok(app.nodes().some((node) => node.type === "small" && textOf(node) === "laptop, through Cursor"));

	for (const name of ["Laptop", "laptop"]) {
		await openCloudForm(app);
		await chooseMachine(app, name);
		const count = bridge.sends.length;
		sendPrompt(app, `Run successfully on ${name}`);
		await app.settle();
		assert.equal(bridge.sends.length, count + 1);
		const accepted = bridge.sends.at(-1);
		assert.equal(accepted.cloud.machine, name);
		cloudState(app, accepted, true);
		cloudState(app, accepted, false);
		app.emit({ type: "done", uiSessionId: accepted.uiSessionId, turnId: accepted.turnId, machine: name });
		await app.settle();
	}
	same(app.readSettings().cursorMachines, [{ name: "laptop", repo: "example/first" }, { name: "Laptop", repo: "example/first" }, ...remembered], "successful completions remember both spellings for the same normalized repository");
	await openCloudForm(app);
	await chooseMachine(app);
	same(suggestions(), ["laptop", "Laptop", "desktop"], "the suggestions preserve both spellings");
	app.unmount();
	console.log("PASS My machines send: validation, PR off, setup copy, successful-only case-sensitive remembering, and session labels");
}

async function checkMachineBranch() {
	const app = harness(), bridge = fakeCloud(app);
	const setup = app.api.cloudSetup;
	app.api.cloudSetup = async (folder) => ({ ...await setup(folder), ref: "topic;example", upstream: "origin/topic;example" });
	await openCloudForm(app);
	typePrompt(app, "Use the current branch");
	assert.equal(button(app, "Send").props.disabled, false, "ordinary Cloud can use this Git branch");
	await chooseMachine(app, "laptop");
	const error = "A machine session can't use this branch name. Switch the folder to a branch whose name has only letters, digits, dots, dashes, underscores and slashes.";
	assert.ok(app.nodes().some((node) => textOf(node) === error));
	assert.equal(app.nodes().filter((node) => node.type === "button" && node.props["aria-label"]?.startsWith("Copy ")).length, 0);
	assert.equal(button(app, "Send").props.disabled, true);
	enterPrompt(app);
	await app.settle();
	assert.equal(bridge.sends.length, 0);
	assert.ok(app.node((node) => node.props.className === "new-page"));
	app.unmount();
	console.log("PASS My machines branch check: unsafe shell ref hides setup commands and prevents Send and Enter");
}

async function checkMachineSettingsHelp() {
	const app = harness();
	const copied = [], opened = [];
	app.api.copyText = async (command) => { copied.push(command); return { ok: true }; };
	app.api.openExternal = async (url) => { opened.push(url); return { ok: true }; };
	app.settingsView({ settings: app.readSettings(), initialTab: "general", onChange() {}, onClose() {}, onCheckSetup() {}, onRun() {}, servers: [], folder: "C:/project" });
	await app.settle();
	assert.ok(app.nodes().some((node) => node.type === "h3" && textOf(node) === "My machines"));
	assert.ok(app.nodes().some((node) => node.type === "p" && textOf(node).includes("With My machines, they run on a computer of yours instead.")));
	const commands = [
		"curl https://cursor.com/install -fsS | bash",
		"irm 'https://cursor.com/install?win32=true' | iex",
		"cursor-agent login",
	];
	for (const command of commands) {
		const copy = button(app, `Copy ${command}`);
		assert.ok(copy, `Settings shows a Copy button for ${command}`);
		copy.props.onClick();
	}
	button(app, "Open Cursor's dashboard").props.onClick();
	await app.settle();
	assert.deepEqual(copied, commands);
	assert.deepEqual(opened, ["https://cursor.com/dashboard?tab=cloud-agents"]);
	app.unmount();
	console.log("PASS My machines Settings help copies the exact install and login commands and opens the Cursor dashboard");
}

async function checkGrokBotNavigation() {
	let now = Date.now();
	const app = harness(new Map(), "", class extends Date { static now() { return now; } });
	await app.settle();
	assert.equal(app.sidebar().grokBot, undefined, "the Bot row is absent before sign-in");
	sendPrompt(app, "Keep the first session");
	await app.settle();
	const first = app.model().session.id;
	app.emit({ type: "done", uiSessionId: first, turnId: app.sends.at(-1).turnId });
	await app.settle();
	now++;
	const second = await startSession(app, "Keep running under the Bot view");
	const turnId = app.sends.at(-1).turnId;
	button(app, "Browser").props.onClick();
	await app.settle();
	const browser = () => app.node((node) => node.type === "BrowserPane" && node.props.uiSessionId === second);
	assert.equal(browser().props.visible, true);
	const status = { signedIn: true, keyring: true, signingIn: false, connection: "live", bots: [{ agentId: "bot-a", name: "First Bot" }], live: {} };
	app.emit({ type: "grokbot-status", status });
	await app.settle();
	assert.ok(app.sidebar().grokBot, "sign-in adds the Bot row");
	const view = () => app.node((node) => node.type === "GrokBotView");
	const open = async () => { app.sidebar().grokBot.onOpen(); await app.settle(); assert.ok(view()); };
	await open();
	assert.equal(app.sidebar().activeId, "", "the covered coding session has no active Sidebar row");
	assert.ok(app.node((node) => node.props.className === "workspace grok-bot-covered"));
	assert.equal(browser().props.visible, false, "the covered Browser pane is hidden");
	let questionClicks = 0;
	const question = { querySelector: () => null, querySelectorAll: () => [{ click() { questionClicks++; } }] };
	app.document.querySelectorAll = (selector) => selector === ".chat .tool-question:has(.tool-choices)" ? [question] : [];
	app.key({ key: "1" });
	app.key({ key: "Tab", ctrlKey: true });
	await app.settle();
	assert.equal(questionClicks, 0, "a number cannot answer a covered question");
	assert.equal(app.model().session.id, second, "Ctrl+Tab cannot change the covered session");
	view().props.onClose();
	await app.settle();
	assert.equal(view(), undefined, "Close returns to the coding session");
	assert.equal(browser().props.visible, true);
	app.key({ key: "1" });
	assert.equal(questionClicks, 1, "the same question shortcut works once uncovered");
	await open();
	app.key({ key: "Escape" });
	await app.settle();
	assert.equal(view(), undefined, "Escape closes the Bot view");
	assert.deepEqual(app.cancels, [], "Escape does not stop the covered coding run");
	now += 499;
	app.key({ key: "Escape" });
	await app.settle();
	assert.deepEqual(app.cancels, [], "a second quick Escape does not stop the coding run");
	await open();
	app.emit({ type: "tool", uiSessionId: second, turnId, tool: { id: "bot-covered-approval", title: "Edit file", waiting: true } });
	await app.settle();
	assert.equal(app.notifications.length, 1, "an approval in the covered active session notifies");
	assert.equal(app.sidebar().sessions.find((item) => item.id === second).unread, true, "an approval marks the covered active session unread");
	app.notifications[0].onclick();
	await app.settle();
	assert.equal(view(), undefined, "clicking that notification closes the Bot view even for the same session");
	assert.equal(app.model().session.id, second);
	await open();
	app.sidebar().onSelect(first);
	await app.settle();
	assert.equal(view(), undefined, "selecting a coding session closes the Bot view");
	await open();
	app.sidebar().onNewIn({ folder: "C:/bot-test", project: "bot-test", environment: "Local" });
	await app.settle();
	assert.equal(view(), undefined, "New in project closes the Bot view");
	await open();
	app.emit({ type: "grokbot-status", status: { ...status, signedIn: false, connection: "off", bots: [], live: {} } });
	await app.settle();
	assert.equal(view(), undefined, "sign-out closes the Bot view");
	assert.equal(app.sidebar().grokBot, undefined, "sign-out removes the Bot row");
	app.unmount();
	console.log("PASS Grok Bot navigation: sign-in row, close routes, Escape grace, covered shortcuts, notifications and Browser visibility");
}

async function checkGrokBotWindowSetting() {
	const app = harness(new Map([["grok-code.settings.v1", JSON.stringify({ grokBotWindow: true })]]));
	const released = [];
	app.api.grokBotWindowRelease = async () => { released.push(true); };
	await app.settle();
	assert.ok(app.sidebar().grokBot, "the setting shows the row with no sign-in");
	app.sidebar().grokBot.onOpen();
	await app.settle();
	const shown = () => app.node((node) => node.type === "GrokBotWindow");
	assert.ok(shown(), "the row opens the app's window view");
	assert.equal(app.node((node) => node.type === "GrokBotView"), undefined, "the chat view stays closed");
	assert.ok(app.node((node) => node.props.className === "workspace grok-bot-covered"));
	shown().props.onClose();
	await app.settle();
	assert.equal(shown(), undefined, "Close leaves the view");
	app.sidebar().grokBot.onOpen();
	await app.settle();
	assert.deepEqual(released, []);
	app.sidebar().onSettings();
	await app.settle();
	app.node((node) => node.type?.name === "SettingsPage").props.onChange({ grokBotWindow: false });
	await app.settle();
	assert.equal(shown(), undefined, "turning the setting off closes the view");
	assert.equal(app.sidebar().grokBot, undefined, "and removes the row when not signed in");
	assert.equal(released.length, 1, "and puts Grok Bot's window back on the desktop");
	app.unmount();
	console.log("PASS Grok Bot window setting: row without sign-in, its own view, and turning it off gives the window back");
}

async function checkGrokBotHook() {
	const app = harness();
	const status = { ok: true, signedIn: true, keyring: true, signingIn: false, connection: "live", bots: [{ agentId: "bot-a", name: "First Bot" }, { agentId: "bot-b", name: "Second Bot" }], live: {} };
	const history = [];
	const sends = [];
	let finishStatus;
	app.api.grokBotStatus = () => new Promise((resolve) => { finishStatus = resolve; });
	app.api.grokBotHistory = async (...args) => { history.push(args); return { ok: true, rows: [] }; };
	app.api.grokBotSend = async (input) => { sends.push(input); return { ok: false, unknown: true, error: "It may have been sent. Check the chat before sending again." }; };
	app.api.grokBotStop = async () => ({ ok: true, hadActiveRun: false });
	await app.settle();
	app.emit({ type: "grokbot-status", status });
	finishStatus({ ...status, signedIn: false, connection: "off", bots: [] });
	await app.settle();
	assert.ok(app.sidebar().grokBot, "the mount read cannot overwrite a newer status event");
	const view = () => app.node((node) => node.type === "GrokBotView");
	const bot = () => view().props.bot;
	app.sidebar().grokBot.onOpen();
	await app.settle();
	assert.equal(bot().selectedId, "bot-a");
	same(history[0], ["bot-a", undefined], "the selected Bot loads its latest history");
	bot().setDraft("Keep A");
	bot().setSelectedId("bot-b");
	await app.settle();
	bot().setDraft("Keep B");
	bot().setSelectedId("bot-a");
	await app.settle();
	assert.equal(bot().draft, "Keep A", "Bot drafts are separate");
	view().props.onClose();
	await app.settle();
	app.sidebar().grokBot.onOpen();
	await app.settle();
	assert.equal(bot().draft, "Keep A", "closing the view keeps its draft");
	await bot().send();
	await app.settle();
	assert.equal(bot().draft, "Keep A", "an uncertain send retains its draft");
	await bot().send();
	await app.settle();
	assert.match(sends[0].messageId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
	assert.equal(sends[1].messageId, sends[0].messageId, "retrying unchanged text reuses its nonce");
	bot().setDraft("Changed A");
	await bot().send();
	await app.settle();
	assert.notEqual(sends[2].messageId, sends[0].messageId, "edited text gets another nonce");
	await bot().stop();
	await app.settle();
	assert.equal(bot().note, "Grok Bot was not running.", "Stop does not claim an inactive run was stopped");
	let finishSend;
	app.api.grokBotSend = () => new Promise((resolve) => { finishSend = resolve; });
	bot().setDraft("In flight at sign-out");
	const pendingSend = bot().send();
	await app.settle();
	app.emit({ type: "grokbot-status", status: { ...status, signedIn: false, connection: "off", bots: [], live: {} } });
	await app.settle();
	finishSend({ ok: false, error: "Late old-account result" });
	await pendingSend;
	app.emit({ type: "grokbot-status", status });
	await app.settle();
	app.sidebar().grokBot.onOpen();
	await app.settle();
	assert.equal(bot().draft, "", "sign-out clears drafts");
	assert.equal(Object.values(bot().state.pending).flat().length, 0, "a late send result cannot restore cleared pending messages");
	assert.equal(bot().note, "", "a late send result cannot restore a cleared note");
	bot().setSelectedId("bot-b");
	await app.settle();
	assert.equal(bot().draft, "", "sign-out clears every Bot draft");
	app.unmount();
	console.log("PASS Grok Bot hook: status races, per-Bot drafts, uncertain retry nonces, honest Stop and sign-out cleanup");
}

async function checkGrokBotHistoryPages() {
	const page = (start, count) => Array.from({ length: count }, (_, index) => ({ seq: String(start + index), updatedSeq: String(start + index), entryId: `entry-${start + index}`, entryKind: "message", body: { role: "user", content: `Message ${start + index}` } }));
	const fixture = async (pages) => {
		const app = harness();
		const cursors = [];
		app.api.grokBotStatus = async () => ({ ok: true, signedIn: true, keyring: true, signingIn: false, connection: "live", bots: [{ agentId: "bot-a", name: "First Bot" }], live: {} });
		app.api.grokBotHistory = async (agentId, before) => { assert.equal(agentId, "bot-a"); cursors.push(before); return { ok: true, rows: pages.shift() }; };
		await app.settle();
		app.sidebar().grokBot.onOpen();
		await app.settle();
		return { app, cursors, bot: () => app.node((node) => node.type === "GrokBotView").props.bot };
	};
	for (const count of [0, 99]) {
		const { app, bot } = await fixture([page(1, count)]);
		assert.equal(bot().rows.length, count);
		assert.equal(bot().hasEarlier, false, "an initial short page has no earlier-page action");
		app.unmount();
	}
	for (const lastCount of [0, 17]) {
		const { app, bot, cursors } = await fixture([page(201, 100), page(101, 100), page(84, lastCount)]);
		assert.equal(bot().hasEarlier, true);
		assert.equal(bot().state.beforeSeq["bot-a"], "201");
		await bot().loadEarlier();
		await app.settle();
		assert.equal(bot().rows.length, 200, "the second full page merges with the first");
		assert.equal(bot().hasEarlier, true);
		assert.equal(bot().state.beforeSeq["bot-a"], "101");
		await bot().loadEarlier();
		await app.settle();
		same(cursors, [undefined, "201", "101"], "each earlier request advances from the last page cursor");
		assert.equal(bot().rows.length, 200 + lastCount, "a partial or empty final page preserves accumulated rows");
		assert.equal(bot().rows[0].seq, lastCount ? "84" : "101");
		assert.equal(bot().rows.at(-1).seq, "300");
		assert.equal(bot().state.beforeSeq["bot-a"], lastCount ? "84" : undefined);
		assert.equal(bot().hasEarlier, false, "a partial or empty final page removes the earlier-page action");
		app.unmount();
	}
	const { app, bot } = await fixture([page(201, 100), page(201, 100)]);
	await bot().loadEarlier();
	await app.settle();
	assert.equal(bot().rows.length, 100);
	assert.equal(bot().hasEarlier, false, "a full page with an unchanged cursor cannot offer another identical request");
	app.unmount();
	console.log("PASS Grok Bot history pages: full-page pagination, partial and empty endings, merged rows and cursor progress");
}

async function checkGrokBotAuthResults() {
	const app = harness();
	const status = { ok: true, signedIn: true, keyring: true, signingIn: false, connection: "live", bots: [], live: {} };
	app.api.grokBotStatus = async () => status;
	const signedOut = () => app.emit({ type: "grokbot-status", status: { ...status, signedIn: false, connection: "off" } });
	app.api.grokBotSignOut = async () => { signedOut(); return { ok: false, error: "The saved Grok Bot sign-in couldn't be removed." }; };
	await app.settle();
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	const bot = () => app.node((node) => node.type?.name === "SettingsPage").props.grokBot;
	await bot().signOut();
	await app.settle();
	assert.equal(bot().note, "The saved Grok Bot sign-in couldn't be removed.", "its own signed-out event must not hide a failed token removal");
	app.emit({ type: "grokbot-status", status });
	await app.settle();
	app.api.grokBotSignIn = async () => { signedOut(); return { ok: false, error: "The previous sign-in couldn't be removed." }; };
	await bot().signIn();
	await app.settle();
	assert.equal(bot().note, "The previous sign-in couldn't be removed.", "replacement sign-in failures remain visible after clearing the old account");
	let finishOld;
	app.api.grokBotSignIn = () => new Promise((resolve) => { finishOld = resolve; });
	const old = bot().signIn();
	app.api.grokBotCancelSignIn = async () => ({ ok: false, error: "Current cancellation failure" });
	await bot().cancelSignIn();
	await app.settle();
	finishOld({ ok: false, error: "Old sign-in failure" });
	await old;
	await app.settle();
	assert.equal(bot().note, "Current cancellation failure", "an older auth result cannot overwrite a newer auth action");
	app.unmount();
	console.log("PASS Grok Bot auth results: removal and replacement failures stay visible; superseded results are ignored");
}

function checkGrokBotEmptyRoster() {
	const app = harness();
	for (const signedIn of [false, true]) {
		for (const connection of ["off", "reconnecting", "live", "expired", "problem"]) {
			for (const hasBots of [false, true]) {
				const bot = { status: { signedIn, connection, bots: hasBots ? [{ agentId: "bot-a", name: "First Bot" }] : [], live: {} }, selectedId: "", rows: [], pending: [], state: { notes: {} }, draft: "", note: "", answering: {} };
				const tree = app.grokBotView({ bot, onClose() {} });
				assert.equal(textOf(tree).includes("There are no Bots on this account."), signedIn && connection === "live" && !hasBots, `empty roster notice: signedIn=${signedIn}, connection=${connection}, hasBots=${hasBots}`);
			}
		}
	}
	app.unmount();
	console.log("PASS Grok Bot empty roster notice waits for a live connection and an empty roster");
}

function checkGrokBotConnectorCards() {
	const app = harness();
	const fixtures = [
		[{ connector: "Gmail", serverId: "gmail", variant: "connect", type: "connector" }, "Gmail"],
		[{ type: "scm-connect", provider: "GitHub" }, "GitHub"],
		[{ type: "scm-connect" }, "a source control account"],
	];
	for (const [message, target] of fixtures) {
		for (const laterReply of [false, true]) {
			const rows = [{ seq: "1", updatedSeq: "1", entryId: "card-one", entryKind: "send-message", body: { kind: "send-message", message } }];
			if (laterReply) { rows.push({ seq: "2", updatedSeq: "2", entryId: "reply-one", entryKind: "send-message", body: { kind: "send-message", message: { type: "text", content: "Here is a later reply." } } }); }
			const bot = { status: { signedIn: true, connection: "live", bots: [{ agentId: "bot-a", name: "First Bot" }], live: {} }, selectedId: "bot-a", rows, pending: [], state: { notes: {} }, draft: "", note: "", answering: {} };
			app.grokBotView({ bot, onClose() {} });
			const card = app.node((node) => node.type === "article");
			assert.equal(textOf(card), `Grok Bot asked you to connect ${target}. If you haven't yet, do it in the Grok Bot app. This app can't show that card.`, `${message.type} is informative regardless of a later Bot reply`);
			assert.doesNotMatch(textOf(card), /Handled|waiting|connector|scm-connect/, "connector cards do not infer completion, waiting or expose their raw type");
		}
	}
	app.unmount();
	console.log("PASS Grok Bot connector cards keep informative service/provider wording with or without later replies");
}

function checkGrokBotUnsupportedCards() {
	const app = harness();
	const fixtures = [
		[{ type: "virtual-card-approval", approval: { title: "Hotel booking", status: "pending" } }, "Virtual card purchase: Hotel booking. Use the Grok Bot app to respond."],
		[{ type: "virtual-card-approval", approval: { title: "Hotel booking", status: "approved" } }, "Virtual card purchase: Hotel booking. Handled in Grok Bot."],
		[{ type: "widget", widget: { ruleChange: { kind: "add", effect: "ask_first", text: "Send email" }, prompt: "Save this rule?", options: [{ label: "Yes", value: "yes" }] } }, "Add approval rule: Ask first: Send email. Use the Grok Bot app to respond."],
	];
	for (const [message, expected] of fixtures) {
		const rows = [{ seq: "1", updatedSeq: "1", entryId: "card-one", entryKind: "send-message", body: { kind: "send-message", message } }];
		const bot = { status: { signedIn: true, connection: "live", bots: [{ agentId: "bot-a", name: "First Bot" }], live: {} }, selectedId: "bot-a", rows, pending: [], state: { notes: {} }, draft: "", note: "", answering: {} };
		app.grokBotView({ bot, onClose() {} });
		const card = app.node((node) => node.type === "article");
		const note = app.nodes(card).find((node) => node.props.className === "note message-text");
		assert.equal(note?.props.children, expected, "unsupported cards render their description as plain note text");
		assert.equal(textOf(card), expected, "the card's own completion field controls its wording");
		assert.equal(app.nodes(card).some((node) => ["button", "a", "input", "select", "textarea"].includes(node.type)), false, "unsupported cards add no action controls, including rule widgets with options");
	}
	app.unmount();
	console.log("PASS Grok Bot unsupported cards render plain notes, own-field completion wording and no action controls");
}

async function checkPrCreateFolderRace() {
	const app = await composerWindow();
	let resolveCreate;
	app.api.prCreate = () => new Promise((resolve) => { resolveCreate = resolve; });
	const creating = app.node((node) => node.type === "SessionRail").props.onCreatePr();
	const original = app.model().session.folder;
	app.pickedFolders.push("C:/other-repository");
	app.node((node) => node.props.label === app.model().session.project).props.onClick();
	app.render();
	button(app, "Choose a folder").props.onClick();
	await app.settle();
	assert.notEqual(app.model().session.folder, original, "the folder change lands while the pull request is still being created");
	resolveCreate({ ok: true, url: "https://github.com/owner/repo/pull/12" });
	await creating;
	await app.settle();
	assert.equal(app.model().session.prWatch, undefined, "a pull request created from the old folder is not attached after the folder changes");
	assert.equal(button(app, "Ask Grok to fix"), undefined, "Ask Grok to fix is absent when that pull request is not this folder's");
	assert.equal(app.sends.some((item) => String(item.text).includes("gh pr checks 12")), false, "Ask Grok to fix does not send the old folder's pull request");
	app.unmount();
	console.log("PASS PR create does not attach to a folder chosen while it was in flight");
}

async function checkSideQuestionRetry() {
	const app = await composerWindow();
	const id = app.model().session.id;
	const finish = async (uiSessionId) => {
		app.emit({ type: "done", uiSessionId, turnId: app.sends.at(-1).turnId });
		await app.settle();
	};
	sendPrompt(app, "context one");
	await app.settle();
	await finish(id);
	sendPrompt(app, "/btw first side");
	await app.settle();
	await finish(`side-${id}`);
	sendPrompt(app, "context two");
	await app.settle();
	await finish(id);
	const originalSend = app.api.send;
	app.api.send = async (input) => {
		app.sends.push(input);
		return { ok: false, error: "Grok could not start." };
	};
	sendPrompt(app, "/btw failed side");
	await app.settle();
	const failed = app.sends.at(-1).text;
	app.api.send = originalSend;
	sendPrompt(app, "/btw retry side");
	await app.settle();
	const retry = app.sends.at(-1).text;
	const context = (text) => text.split("Side question:")[0];
	assert.equal(context(failed), context(retry), "retrying a failed side question sends the same main-chat context");
	assert.ok(failed.includes("User: context two") && retry.includes("User: context two"), "the failed try and the retry both include the main message added after the side chat started");
	app.unmount();
	console.log("PASS a failed side question does not advance the main-chat cursor");
}

function promptValue(app) {
	return app.node((node) => node.props["aria-label"] === "Prompt").props.value;
}

function attachChip(app, title) {
	return app.node((node) => node.props.className === "attach-chip" && node.props.title === title);
}

async function addFiles(app, paths) {
	app.node((node) => node.props.label === "+").props.onClick();
	app.render();
	app.pickedFiles.push(paths);
	button(app, "Add files or photos").props.onClick();
	await app.settle();
}

async function checkWorktreeDraftDuringCreate() {
	const kept = harness();
	await kept.settle();
	let finishSame;
	kept.api.addWorktree = () => new Promise((resolve) => { finishSame = resolve; });
	kept.sidebar().onNew();
	await kept.settle();
	const formId = kept.model().session.id;
	worktreeInput(kept).props.onChange({ target: { checked: true } });
	kept.render();
	await addFiles(kept, ["C:\\notes\\first.md"]);
	sendPrompt(kept, "original request");
	await kept.settle();
	typePrompt(kept, "newer draft while creating");
	await addFiles(kept, ["C:\\notes\\during.md"]);
	finishSame({ ok: true, folder: "C:\\project\\.grok\\worktrees\\original-request", branch: "grok/original-request" });
	await kept.settle();
	assert.equal(kept.sends.at(-1).text, "original request", "the message already sent stays the original request");
	same(kept.sends.at(-1).attachments, ["C:\\notes\\first.md"], "only the attachments selected for that send go with it");
	assert.equal(promptValue(kept), "newer draft while creating", "text typed while the worktree is created stays in the composer");
	assert.equal(attachChip(kept, "C:\\notes\\first.md"), undefined, "the sent attachment leaves the composer");
	assert.ok(attachChip(kept, "C:\\notes\\during.md"), "an attachment added while the worktree is created stays");
	assert.equal(savedHistory(kept).composerDrafts[formId], "newer draft while creating", "the newer draft is saved with the session");
	same(savedHistory(kept).attachments[formId], ["C:\\notes\\during.md"], "the attachment added during creation is saved with the session");
	kept.unmount();

	const other = harness();
	await other.settle();
	let finishOther;
	other.api.addWorktree = () => new Promise((resolve) => { finishOther = resolve; });
	other.sidebar().onNew();
	await other.settle();
	worktreeInput(other).props.onChange({ target: { checked: true } });
	other.render();
	const sendsBefore = other.sends.length;
	sendPrompt(other, "original request");
	await other.settle();
	typePrompt(other, "");
	other.sidebar().onNew();
	await other.settle();
	typePrompt(other, "newer unsent draft");
	await addFiles(other, ["C:\\notes\\second.md"]);
	finishOther({ ok: true, folder: "C:\\project\\.grok\\worktrees\\original-request", branch: "grok/original-request" });
	await other.settle();
	assert.equal(other.sends.length, sendsBefore + 1, "the original request is sent once");
	assert.equal(other.sends.at(-1).text, "original request");
	assert.ok(other.node((node) => node.props.className === "new-page"), "the form opened while the worktree was created stays open");
	assert.equal(promptValue(other), "newer unsent draft", "its unsent text is still there");
	assert.ok(attachChip(other, "C:\\notes\\second.md"), "its unsent attachment is still there");
	assert.ok(other.sidebar().sessions.some((item) => item.worktreeFolder === "C:\\project\\.grok\\worktrees\\original-request"), "the created worktree session is kept");
	other.unmount();
	console.log("PASS a newer draft survives worktree creation, including a form opened during it");
}

async function checkSidebarTabOrder() {
	const pinned = await composerWindow();
	const older = pinned.model().session.id;
	const middle = await startSession(pinned, "Beta chat");
	const newest = await startSession(pinned, "Gamma chat");
	pinned.sidebar().onPin(middle);
	await pinned.settle();
	assert.equal(pinned.model().session.id, newest);
	pinned.key({ key: "Tab", ctrlKey: true });
	await pinned.settle();
	assert.equal(pinned.model().session.id, older, "Ctrl+Tab follows the sidebar, so a pinned session is not the next row");
	pinned.key({ key: "Tab", shiftKey: true, ctrlKey: true });
	await pinned.settle();
	assert.equal(pinned.model().session.id, newest, "Ctrl+Shift+Tab walks that sidebar order backward");
	pinned.unmount();

	const searched = await composerWindow();
	const first = searched.model().session.id;
	const hidden = await startSession(searched, "Middle only");
	const last = await startSession(searched, "Saved end");
	searched.sidebar().onQuery("Saved");
	await searched.settle();
	assert.equal(searched.model().session.id, last);
	searched.key({ key: "Tab", ctrlKey: true });
	await searched.settle();
	assert.equal(searched.model().session.id, first, "Ctrl+Tab skips a session the search hides");
	assert.notEqual(searched.model().session.id, hidden);
	searched.key({ key: "Tab", shiftKey: true, ctrlKey: true });
	await searched.settle();
	assert.equal(searched.model().session.id, last, "Ctrl+Shift+Tab also skips the hidden session");
	searched.unmount();

	const grouped = await composerWindow();
	const home = grouped.model().session;
	grouped.sidebar().onNewIn({ folder: "C:/other-project", project: "other-project", branch: "main", worktree: "other-project", environment: "Local" });
	await grouped.settle();
	sendPrompt(grouped, "Other project chat");
	await grouped.settle();
	const away = grouped.model().session.id;
	grouped.sidebar().onNewIn({ folder: home.folder, project: home.project, branch: home.branch, worktree: home.worktree, environment: "Local" });
	await grouped.settle();
	sendPrompt(grouped, "Home again");
	await grouped.settle();
	const homeAgain = grouped.model().session.id;
	assert.notEqual(homeAgain, away);
	const otherKey = "C:/other-project".replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
	grouped.storage.set("grok-code.sidebar.v1", JSON.stringify({ collapsedProjects: [otherKey] }));
	grouped.key({ key: "Tab", ctrlKey: true });
	await grouped.settle();
	assert.equal(grouped.model().session.id, home.id, "Ctrl+Tab skips a session in a collapsed project");
	assert.notEqual(grouped.model().session.id, away);
	grouped.key({ key: "Tab", shiftKey: true, ctrlKey: true });
	await grouped.settle();
	assert.equal(grouped.model().session.id, homeAgain, "Ctrl+Shift+Tab skips the collapsed project too");
	grouped.unmount();
	console.log("PASS Ctrl+Tab follows the sidebar and skips sessions it hides");
}

async function main() {
	checkGrokBotUnsupportedCards();
	checkGrokBotConnectorCards();
	checkGrokBotEmptyRoster();
	await checkGrokBotNavigation();
	await checkGrokBotWindowSetting();
	await checkGrokBotHook();
	await checkGrokBotHistoryPages();
	await checkGrokBotAuthResults();
	checkCloudModels();
	await checkCloudSend();
	await checkCloudModelRetry();
	await checkCloudReplay();
	await checkCloudWindows();
	await checkMachineDraft();
	await checkMachineSend();
	await checkMachineBranch();
	await checkMachineSettingsHelp();
	await checkSignInProfile();
	await checkSignInSettings();
	await checkPaneLayout();
	await checkNarrowWindow();
	await require("./test-saved-prompts.cjs")();
	await require("./test-customize-renderer.cjs")({ harness, button, textOf });
	await require("./test-mermaid-math.cjs")();
	await checkSavedPromptIntegration();
	const codeBlocks = harness();
	for (const lang of ["bash", "sh", "shell", "zsh", "cmd", "bat", "console", "powershell", "pwsh", "ps1", "ps"]) {
		codeBlocks.markdown({ text: `\`\`\`${lang}\nWrite-Output 'hello'\n\`\`\``, onCopy() {}, onRun() {} });
		assert.ok(button(codeBlocks, "Copy"), `${lang} has Copy`);
		assert.equal(!!button(codeBlocks, "Run"), ["powershell", "pwsh", "ps1", "ps"].includes(lang), `${lang} only has Run for PowerShell`);
	}
	await check();
	await checkInboundTurns();
	await checkRoutineFire();
	await checkRoutineOpen();
	await checkOpenAtSignInRow();
	await checkQueue();
	await checkQueueRelaunch();
	await checkQueueFailedClose();
	await checkQueueWindowMerge();
	await checkQueueAcrossWindows();
	await checkQueueValidationAndEdit();
	await checkConversationActionsAndView();
	await checkTurnIds();
	await checkTurnAnnouncements();
	await checkFailedSession();
	await checkInterrupted();
	await checkSessionOrder();
	await checkRemoteSendSettings();
	await checkRemoteDeletion();
	await checkLostSession();
	await checkModeEvents();
	await checkAnswers();
	await checkSavedSize();
	await checkGrokState();
	await checkSlashCommands();
	await checkLimitMeter();
	await checkToolRows();
	await checkFixBrief();
	await checkRoutineBatchB();
	await checkTerminalSelection();
	await checkBrowserControl();
	await checkNativeTerminalRouting();
	await checkEditorFlush();
	await checkPlanResumeMode();
	await checkFirstLaunch();
	await checkSessionModel();
	await checkSettingsSaveFailure();
	await checkCleanAutoArchive();
	await checkDirtyAutoArchive();
	await checkBusyAutoArchive();
	await checkTurnStartsDuringAutoArchive();
	await checkUnarchiveAfterAutoArchive();
	await checkRememberedAccount();
	await checkSettingsBlocksShortcuts();
	await checkUiConfiguration();
	await checkSideDrafts();
	await checkComposerIme();
	await checkComposerDraftRelaunch();
	await checkNewSessionDraftRelaunch();
	await checkNewSessionAttachmentDraftRelaunch();
	await checkReplacedNewSessionDraft();
	await checkInvalidHistoryBackup();
	await checkSideQuestionRetry();
	await checkWorktreeDraftDuringCreate();
	await checkSidebarTabOrder();
	await checkKeptNewSessionForm();
	await checkSentComposerDraft();
	await checkComposerDraftMerge();
	await checkDeletedComposerDraft();
	await checkComposerDraftDebounce();
	await checkNativeTasksAndTitles();
	await checkManualTitleAcrossWindows();
	await checkMessageDatesAndMarkdown();
	await checkPromptPredictions();
	await checkPromptPoints();
	await checkRewindCut();
	await checkRewindGuardsAndQueue();
	await checkRewindSessionChanges();
	await checkFork();
	await checkSteer();
	await checkBackgroundReports();
	await checkBackgroundReportPlacement();
	await checkRestoredBackgroundTools();
	await checkStreamHistorySaves();
	await checkResizeChurn();
	await checkColumnWidths();
	await checkHiddenSidebarProjectReveal();
	await checkSmallUiBatch();
	await checkRefreshScopes();
	await checkHeaderBranch();
	await checkSavedThinkingAndLegacySettings();
	await checkBackgroundWorkHistory();
	await checkColdChats();
	await checkTaskDetails();
	await checkLongMessages();
	await checkReadOnlyMessages();
	await checkEditDiffs();
	await checkSplitDiffs();
	await checkSetupSheet();
	await checkFileLinkIndex();
	await checkFileListIdentityAndLimit();
	await checkModeRestartWarnings();
	await checkSlashModeRoute();
	await checkBackForward();
	await checkLateToolRow();
	await checkCommitButtons();
	await checkDirectCommitBridge();
	await checkRevertHunkBridge();
	await checkReviewWorkspace();
	await checkProgressiveChanges();
	await checkEditorLanguagesAndSettings();
	await checkCodeEditorIntegration();
	await checkConfirmHostAndQueue();
	await checkConfirmActions();
	checkRailPrMenu();
	await checkPrWatch();
	await checkPrCreateFolderRace();
	await checkPrWatchWindows();
	await checkAppUpdates();
	await checkSharedFolder();
	await checkMissingSessionFolder();
	await checkDisconnectChoice();
	await checkContextFromChat();
	await checkCliSession();
	await checkLoops();
	await checkSandbox();
	console.log("Renderer turn and tool-row checks passed: parallel sessions, per-session drafts, queue and Send now, side chat, turn ids, interrupted replies, session order and delete, lost Grok sessions, mode events and folder modes, plan/question/always answers, saved history size, Grok commands/MCP/usage/attachments/settings, and tool rows.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
