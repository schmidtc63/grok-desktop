const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { transformSync } = require("esbuild");

const storageLocks = new WeakMap();
// App's child components render as named placeholders so a test can read the props App gives them.
const PLACEHOLDERS = {
	"./Panes": { PaneView: "PaneView", SideLog: "SideLog" },
	"./Sidebar": { Sidebar: "Sidebar" },
	"./SessionRail": { SessionRail: "SessionRail" },
	"./DiffPane": { DiffPane: "DiffPane" },
	"./FilesPane": { FilesPane: "FilesPane" },
	"./TerminalPane": { TerminalPane: "TerminalPane" },
	"./BrowserPane": { BrowserPane: "BrowserPane" },
};

function harness(storage = new Map(), search = "", clock = Date, timers = { setTimeout, clearTimeout }) {
	if (!storageLocks.has(storage)) {
		const tails = new Map();
		storageLocks.set(storage, {
			request(name, callback) {
				const result = (tails.get(name) ?? Promise.resolve()).then(callback);
				tails.set(name, result.catch(() => {}));
				return result;
			},
			async drain() { await Promise.all(tails.values()); },
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
	const confirms = [];
	let confirmAnswer = true;
	const windowEvents = new Map();
	const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
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
		decide: async (input) => { decisions.push(input); return { ok: true }; },
		pickFolder: async () => pickedFolders.shift() ?? null,
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
	const cache = {};
	const appDocument = { documentElement: { setAttribute() {}, removeAttribute() {} }, hasFocus: () => true, querySelectorAll: () => [] };
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
			if (!id.startsWith("./")) { return require(id); }
			const base = id.slice(2);
			return load(fs.existsSync(path.join(__dirname, "..", "src", `${base}.ts`)) ? `${base}.ts` : `${base}.tsx`);
		};
		vm.runInNewContext(source, {
			require: imports, module, exports: module.exports, crypto: { randomUUID },
			navigator: { locks }, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, HTMLElement: class {}, DOMException, Date: clock,
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
		storage, locks, sends, writes, historyWrites, settingsWrites, pickedFolders, forgotten, pickedFiles, allowedUpdates, newWindows, questionAnswers, planAnswers, decisions, cancels, confirms, files, api, settle, render, window: appWindow, document: appDocument,
		get confirmAnswer() { return confirmAnswer; },
		set confirmAnswer(value) { confirmAnswer = value; },
		windowEvent: (name, event = {}) => windowEvents.get(name)?.(event),
		beforeUnload: () => { const event = { prevented: false, returnValue: true, preventDefault() { this.prevented = true; } }; windowEvents.get("beforeunload")?.(event); return event; },
		storageEvent: (key) => windowEvents.get("storage")?.({ key }),
		key: (event) => windowEvents.get("keydown")({ preventDefault() {}, stopPropagation() {}, target: {}, ctrlKey: false, shiftKey: false, altKey: false, code: "", ...event }),
		ask: (question) => load("confirm.ts").askConfirm(question),
		confirmModule: () => load("confirm.ts"),
		fileHits: (text, known = [], tools = []) => load("Panes.tsx").mentionedFiles(text, tools, "C:/project", known),
		editRows: (diff) => load("Panes.tsx").editRows(diff),
		editorLanguages: () => load("editor-languages.ts"),
		editDiff: (props) => load("Panes.tsx").EditDiff(props),
		settingsView: (props) => { component = () => settingsTree(load("Settings.tsx").SettingsPage(props)); dirty = true; return render(); },
		messageTime: (message) => load("Panes.tsx").messageTime(message),
		sideCap: (width, collapsed) => load("App.tsx").sideCap(width, collapsed),
		markdown: (props) => { component = () => load("Markdown.tsx").Markdown(props); dirty = true; return render(); },
		view: (id, model) => { component = () => { const pane = load("Panes.tsx").PaneView({ id, model }); return pane.type(pane.props); }; dirty = true; return render(); },
		row: (props) => { component = () => load("Panes.tsx").ToolRow(props); dirty = true; return render(); },
		group: (props) => { component = () => load("Panes.tsx").ToolGroup(props); dirty = true; return render(); },
		rail: (props) => { component = () => load("SessionRail.tsx").SessionRail(props); dirty = true; return render(); },
		diffView: (props) => { component = () => load("DiffPane.tsx").DiffPane(props); dirty = true; return render(); },
		fileFingerprint: (file) => load("DiffPane.tsx").fileFingerprint(file),
		canMarkViewed: (file) => load("DiffPane.tsx").canMarkViewed(file),
		filesView: (props) => { component = () => load("FilesPane.tsx").FilesPane({ ...props, autoSave: false }); dirty = true; return render(); },
		message: (model, readOnly = false) => { component = () => { const pane = load("Panes.tsx").PaneView({ id: "chat", model }); const chat = pane.type(pane.props); const body = nodes(chat).find((node) => node.type.name === "MessageBody"); return body.type({ ...body.props, readOnly }); }; dirty = true; return render(); },
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
	assert.equal(sharedStorage.get("grok-code.history.v1"), undefined, "all persistence writes must wait for the shared exclusive lock");
	for (const appWindow of [firstWindow, secondWindow]) {
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
	let releaseDraftWrite;
	const heldDraftWrite = pendingDraft.locks.request("grok-code.history.v1", () => new Promise((resolve) => { releaseDraftWrite = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	pendingDraft.editor().onEdit("UNSAVED USER WORK");
	pendingDraft.render();
	assert.equal(pendingDraft.beforeUnload().prevented, false, "a close while the history lock is busy saves the draft itself");
	assert.match(pendingDraft.storage.get("grok-code.history.v1"), /UNSAVED USER WORK/, "the close wrote the draft before the lock freed");
	releaseDraftWrite();
	await heldDraftWrite;
	await pendingDraft.settle();
	assert.equal(pendingDraft.beforeUnload().prevented, false, "a durable draft permits normal close");
	const draftRemount = harness(pendingDraft.storage);
	await draftRemount.settle();
	assert.equal(draftRemount.editor().draft.text, "UNSAVED USER WORK", "normal reload restores user text");
	assert.equal(draftRemount.editor().draft.version, "a1", "recovered text retains its original disk version");
	pendingDraft.storage.failWrites = true;
	pendingDraft.editor().onEdit("QUOTA FAILURE DRAFT");
	await pendingDraft.settle();
	assert.equal(pendingDraft.beforeUnload().prevented, true, "quota failure cannot silently permit draft loss on close");
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

async function checkInterrupted() {
	const live = harness();
	await live.settle();
	const id = live.model().session.id;
	sendPrompt(live, "write a long answer");
	await live.settle();
	live.emit({ type: "chunk", uiSessionId: id, turnId: live.sends.at(-1).turnId, text: "first half" });
	await live.settle();
	assert.equal(live.model().messages.at(-1).pending, false);
	live.beforeUnload();
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
	const app = harness();
	await app.settle();
	const id = app.model().session.id;
	app.sidebar().onSelect(id);
	await app.settle();
	app.node((node) => node.props.label === "+").props.onClick();
	app.render();
	assert.ok(strings(app.render()).includes("Managed in Grok's configuration"), "with no MCP report the + menu says where connectors live");
	app.emit({ type: "mcp", servers: [{ name: "github", source: "user", status: "" }, { name: "linear", source: "project", status: "" }] });
	app.emit({ type: "mcp-status", name: "github", status: "connected" });
	app.emit({ type: "commands", commands: [{ name: "review", description: "Review the diff", hint: "" }, { name: "goal", description: "Set a goal", hint: "objective" }] });
	await app.settle();
	assert.ok(strings(app.render()).includes("2 MCP servers from Grok"));
	assert.ok(JSON.parse(app.storage.get("grok-code.commands.v1")).some((item) => item.name === "review"), "Grok's command list is cached for the next window");
	typePrompt(app, "/re");
	const commandNames = app.nodes(app.node((node) => node.props["aria-label"] === "Commands")).filter((node) => node.props.role === "option").map((node) => [node.props.children].flat()[0]);
	same(commandNames, ["/review"], "the / menu lists Grok's commands");
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
	typePrompt(app, "/go");
	pressEnter();
	app.render();
	assert.equal(app.node((node) => node.props["aria-label"] === "Prompt").props.value, "/goal ", "Enter on a command that takes input completes it");
	assert.equal(app.sends.length, 0);
	typePrompt(app, "/re");
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
	assert.ok(railText.includes("$0.25"), "the rail shows the session cost");
	const railProps = app.node((node) => node.type === "SessionRail").props;
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
	settingsPage.props.onChange({ appearance: "light", allowBypass: true });
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

	const gated = harness();
	await gated.settle();
	gated.key({ key: ",", ctrlKey: true });
	await gated.settle();
	gated.node((node) => node.type?.name === "SettingsPage").props.onChange({ allowBypass: false });
	await gated.settle();
	gated.key({ key: "Escape" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await gated.settle();
	sendPrompt(gated, "gated");
	await gated.settle();
	assert.equal(gated.sends.at(-1).mode, "Normal", "the old bypass switch does not change the Normal default");

	const twice = harness();
	await twice.settle();
	let finishWorktree;
	let worktreeCalls = 0;
	twice.api.addWorktree = () => { worktreeCalls += 1; return new Promise((resolve) => { finishWorktree = resolve; }); };
	twice.sidebar().onNew();
	await twice.settle();
	twice.node((node) => node.type === "input" && node.props.type === "checkbox" && node.props.title === undefined && typeof node.props.onChange === "function" && node.props.checked === false).props.onChange({ target: { checked: true } });
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
	app.key({ key: "Escape" });
	await app.settle();
	assert.deepEqual(app.cancels, [], "Escape that closes a menu does not stop Grok");
	app.key({ key: "Escape" });
	await app.settle();
	same(app.cancels, [id], "Escape with nothing open stops Grok");
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
	const approval = show({ id: "approve", kind: "command", title: "run_terminal_command", detail: "Waiting for you", waiting: true, command: long, summary: `${long.slice(0, 500)}…` });
	assert.ok(approval.nodes().some((node) => node.props.children === long), "a waiting approval shows the complete command");
	button(approval, "Deny").props.onClick();
	button(approval, "Always allow").props.onClick();
	const nativeApproval = show({ id: "native-permission:command", kind: "execute", title: "Run command", waiting: true });
	assert.ok(button(nativeApproval, "Deny") && button(nativeApproval, "Allow"), "native permission cards keep Deny and Allow");
	assert.equal(button(nativeApproval, "Always allow"), undefined, "native permission cards do not offer an unused remembered grant");
	button(approval, "Allow").props.onClick();
	assert.equal(decisions.join("|"), "approve:deny|approve:always|approve:allow");
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
	assert.equal(textOf(groupView.node((node) => node.props.className === "tool-head")), "▸Read 2 files, searched 1 time1 failed", "the group's row sums up its calls");
	assert.equal(groupRows(), 0, "the folded rows stay hidden");
	groupView.node((node) => node.props.className === "tool-head").props.onClick();
	assert.equal(groupRows(), 3, "opening the group shows its rows");
	const verboseView = harness();
	verboseView.group({ tools: groupTools.slice(0, 3), m: { ...groupedModel, view: "verbose" } });
	assert.equal(verboseView.nodes(verboseView.render()).filter((node) => node.type.name === "ToolRow").length, 3, "Verbose opens groups");
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
	assert.equal(app.beforeUnload().prevented, false, "a saved queue survives a close or reload");
	same(savedHistory(app).queued[firstId].map((item) => item.text), ["queued one", "queued two"], "the saved queue keeps message order");
	app.sidebar().onSelect(secondId);
	await app.settle();
	assert.deepEqual(queuedTexts(), [], "the queue belongs to its session");
	assert.equal(app.beforeUnload().prevented, false, "a saved queue in another session does not block closing");
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
	assert.equal(app.beforeUnload().prevented, false, "a held queue is saved too");
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
	assert.equal(app.beforeUnload().prevented, false, "with nothing queued and no unsaved file text, a close does not ask");

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
	assert.equal(app.beforeUnload().prevented, false, "a deleted session's held queue does not make a close ask");
}

async function checkFixBrief() {
	const settingsKey = "grok-code.settings.v1";
	const fresh = harness();
	await fresh.settle();
	assert.equal(JSON.parse(fresh.storage.get(settingsKey)).defaultMode, "Normal", "empty storage starts in Normal");
	const explicit = harness(new Map([[settingsKey, JSON.stringify({ defaultMode: "Always-approve", bypassDefaultApplied: false })]]));
	await explicit.settle();
	sendPrompt(explicit, "keep my saved setting");
	await explicit.settle();
	assert.equal(explicit.sends.at(-1).mode, "Always-approve", "an explicit saved default survives without the old migration flag");
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
		appWindow.api.stopSession = cancel;
		appWindow.api.removeWorktree = cancel;
		appWindow.sidebar().onArchive(appWindow.model().session.id);
		await appWindow.settle();
		assert.equal(appWindow.sends.length, 1, `archive holds the queued follow-up (${inWorktree ? "worktree" : "local"})`);
		assert.equal(appWindow.sidebar().sessions.find((item) => item.id === appWindow.sends[0].uiSessionId).archived, true);
	}

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

async function checkTerminalSelection() {
	const appWindow = harness();
	await appWindow.settle();
	let nextId = 0;
	const writes = [];
	appWindow.api.terminalOpen = async () => ({ ok: true, id: `tab-${++nextId}` });
	appWindow.api.terminalWrite = async (id, text) => { writes.push([id, text]); return { ok: true }; };
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
	browser().onNewTab();
	await appWindow.settle();
	const closed = browser().activeId;
	browser().onCloseTab(closed);
	await appWindow.settle();
	assert.ok(browser().activeId && browser().activeId !== closed, "closing the selected browser tab selects a remaining tab");
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
}

async function checkPlanResumeMode() {
	const plan = harness();
	plan.row({ tool: { id: "release-plan", kind: "plan", title: "Plan", detail: "Waiting for your approval", waiting: true, plan: "# Plan" }, m: { resumeMode: "Auto-review" } });
	assert.ok(button(plan, "Approve") && button(plan, "Keep planning") && button(plan, "Abandon"));
	assert.equal(textOf(plan.node((node) => node.type === "p" && node.props.className === "note")), "Approve or Abandon switches this session to Auto-review.");
}

async function checkFirstLaunch() {
	const app = harness();
	await app.settle();
	const placeholder = app.model().session.id;
	assert.ok(app.node((node) => node.props.className === "new-page"), "empty storage opens the New session form");
	assert.ok(app.node((node) => node.props["aria-label"] === "Folder"));
	assert.equal(app.sends.length, 0);
	sendPrompt(app, "first session");
	await app.settle();
	assert.equal(app.node((node) => node.props.className === "new-page"), undefined);
	assert.equal(app.sends.length, 1);
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
	app.storage.failWrites = true;
	app.node((node) => node.type?.name === "SettingsPage").props.onChange({ appearance: "light" });
	await app.settle();
	assert.equal(app.notice(), "Settings could not be saved. Changes last until the app closes.");
	assert.equal(app.node((node) => node.type?.name === "SettingsPage").props.settings.appearance, "light", "the failed save keeps the choice in memory");
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
	same(removals, [[session.folder, session.worktreeFolder, { force: false }]]);
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
	app.api.removeWorktree = async (...args) => { removals.push(args); if (args[2].force) { folderExists = false; } return { ok: false, dirty: true, error: "The worktree has uncommitted or ignored files." }; };
	await app.settle();
	const session = app.model().session;
	same(removals, [[session.folder, session.worktreeFolder, { force: false }]]);
	assert.equal(folderExists, true, "dirty worktree files stay on disk");
	assert.equal(savedHistory(app).sessions[0].archived, true, "a retained dirty worktree still archives");
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
	app.key({ key: ",", ctrlKey: true });
	await app.settle();
	app.key({ key: "Tab", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().session.id, second, "Ctrl+Tab does not switch the session hidden behind Settings");
	const findTick = app.model().findTick;
	app.key({ key: "f", ctrlKey: true });
	await app.settle();
	assert.equal(app.model().findTick, findTick, "Ctrl+F does not open conversation search behind Settings");
	app.key({ key: "Escape" });
	await app.settle();
	app.key({ key: "Tab", ctrlKey: true });
	await app.settle();
	assert.notEqual(app.model().session.id, second, "with Settings closed Ctrl+Tab switches again");
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

async function checkComposerDraftRelaunch() {
	const app = await composerWindow();
	const id = app.model().session.id;
	app.node((node) => node.props["aria-label"] === "Prompt").props.onChange({ target: { value: "Unsent text\nwith a second line" } });
	assert.equal(app.beforeUnload().prevented, false, "close flushes the latest message text even before the next render");
	assert.equal(savedHistory(app).composerDrafts[id], "Unsent text\nwith a second line");
	const relaunch = harness(app.storage);
	await relaunch.settle();
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "Unsent text\nwith a second line");
	assert.equal(relaunch.sends.length, 0, "restored text never sends itself");
	typePrompt(relaunch, "A newer unsaved message");
	relaunch.storage.failWrites = true;
	assert.equal(relaunch.beforeUnload().prevented, true, "failed history writes protect message drafts on close");
	relaunch.storage.failWrites = false;
	assert.equal(relaunch.beforeUnload().prevented, false);
}

async function checkNewSessionDraftRelaunch() {
	const app = await composerWindow();
	const original = app.model().session.id;
	app.sidebar().onNewIn({ folder: "C:/draft-project", project: "draft-project", branch: "feature/draft", worktree: "draft-project", environment: "Local" });
	await app.settle();
	const draftId = app.model().session.id;
	const worktree = () => app.node((node) => node.props.className === "toggle field-toggle").props.children[0];
	worktree().props.onChange({ target: { checked: true } });
	app.render();
	typePrompt(app, "Do this later");
	app.beforeUnload();
	const relaunch = harness(app.storage);
	await relaunch.settle();
	assert.ok(relaunch.node((node) => node.props.className === "new-page"));
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "Do this later");
	assert.equal(relaunch.node((node) => node.props["aria-label"] === "Folder").props.value, "c:/draft-project");
	assert.equal(relaunch.model().session.branch, "feature/draft");
	assert.equal(relaunch.node((node) => node.props.className === "toggle field-toggle").props.children[0].props.checked, true);
	assert.equal(relaunch.sidebar().sessions.some((item) => item.id === draftId), false, "the restored form is not a sidebar session");
	assert.equal(relaunch.sends.length, 0);
	const otherWindow = harness(app.storage);
	await otherWindow.settle();
	assert.equal(otherWindow.node((node) => node.props["aria-label"] === "Prompt").props.value, "Do this later");
	const restoredIds = [draftId, relaunch.model().session.id, otherWindow.model().session.id];
	assert.equal(new Set(restoredIds).size, 3, "each restore gets a fresh id, so two windows cannot send into one session");
	relaunch.sidebar().onSelect(original);
	await relaunch.settle();
	assert.equal(savedHistory(relaunch).newSessionDraft, undefined, "closing the form clears its saved slot");
	const first = harness();
	await first.settle();
	typePrompt(first, "First-launch draft");
	first.beforeUnload();
	const firstRelaunch = harness(first.storage);
	await firstRelaunch.settle();
	assert.equal(firstRelaunch.sidebar().sessions.length, 0, "a first-launch placeholder is not restored as a real session");
	assert.equal(firstRelaunch.node((node) => node.props["aria-label"] === "Prompt").props.value, "First-launch draft");
	sendPrompt(firstRelaunch, "First-launch draft");
	await firstRelaunch.settle();
	assert.equal(firstRelaunch.sidebar().sessions.length, 1);
	assert.equal(savedHistory(firstRelaunch).newSessionDraft, undefined, "sending the form clears its saved slot");
}

async function checkSentComposerDraft() {
	const app = await composerWindow();
	const id = app.model().session.id;
	typePrompt(app, "Send this draft");
	app.beforeUnload();
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
	app.beforeUnload();
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
	app.beforeUnload();
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
	app.beforeUnload();
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
	assert.equal(app.beforeUnload().prevented, true, "an unsaved queue protects close before React rerenders");
	app.storage.failWrites = false;
	assert.equal(app.beforeUnload().prevented, false);
	assert.equal(savedHistory(app).queued[id][0].text, "queued before the next render");
	const staged = await composerWindow();
	const stagedId = staged.model().session.id;
	const file = path.join(__dirname, "unsaved-staged.md");
	staged.storage.failWrites = true;
	stageAttachments(staged, [file]);
	assert.equal(staged.beforeUnload().prevented, true, "staged files alone protect a failed save before the next render");
	staged.storage.failWrites = false;
	assert.equal(staged.beforeUnload().prevented, false);
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
	finish({ ok: true });
	await app.settle();
	assert.equal(app.sends.length, 2, "ending the turn while steer is pending never sends that row again");
	sendPrompt(app, "Another running turn");
	await app.settle();
	for (const text of ["before", "failed steer", "after"]) { sendPrompt(app, text); await app.settle(); }
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
	app.node((node) => node.props.className === "toggle field-toggle").props.children[0].props.onChange({ target: { checked: true } });
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
	assert.equal(sizing.sideCap(1100, false), 426);
	assert.equal(sizing.sideCap(1100, true), 694);
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
	const viewed = () => view.node((node) => node.type === "input" && node.props.type === "checkbox");
	const section = () => view.node((node) => node.type === "section" && node.props["aria-label"] === "Changes");
	const sectionKey = (key, target = "SECTION") => section().props.onKeyDown({ key, altKey: true, defaultPrevented: false, target: { tagName: target }, preventDefault() {} });
	assert.equal(progress(), "0 of 3 viewed · more files were left out");
	assert.equal(button(view, "‹ Previous").props.disabled, true);
	const scrollers = [];
	// The side scroller's top is at 100; the diff's Previous / Next bar is 600 px above it, so the bar sits at scrollTop 300.
	const side = { scrollTop: 900, getBoundingClientRect: () => ({ top: 100 }) };
	let barTop = -500;
	view.node((node) => node.props.className === "dp-body").props.ref.current = { scrollTo: () => scrollers.push("diff"), getBoundingClientRect: () => ({ top: barTop }) };
	section().props.ref.current = { focus() {}, querySelector: () => side };
	button(view, "Next ›").props.onClick();
	await update();
	assert.equal(props().selectedFile, "b.txt");
	same(scrollers, ["diff"], "a new file resets the Review diff scroller");
	assert.equal(side.scrollTop, 300, "a reader below the bar in the side pane returns to the bar, not to the list");
	side.scrollTop = 0;
	barTop = 400;
	button(view, "‹ Previous").props.onClick();
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
	viewed().props.onChange();
	await update();
	assert.equal(props().viewed["a.txt"], "a-1");
	assert.equal(viewed().props.checked, true);
	assert.equal(progress(), "1 of 3 viewed · more files were left out");
	assert.ok(view.node((node) => node.props["aria-label"] === "Viewed"));
	viewed().props.onChange();
	await update();
	assert.equal(props().viewed["a.txt"], undefined, "unticking clears the file fingerprint");
	viewed().props.onChange();
	await update();
	snapshot.files[0] = ordinary("a.txt", "a-2");
	props().onRefresh();
	await update();
	assert.equal(viewed().props.checked, false, "a changed hunk loses Viewed");
	assert.equal(progress(), "0 of 3 viewed · more files were left out");

	const review = () => button(view, "Review in a large view");
	assert.equal(review().props["aria-pressed"], false);
	button(view, "Comment on line 1").props.onClick();
	view.render();
	view.node((node) => node.type === "textarea").props.onChange({ target: { value: "Retained draft" } });
	view.render();
	review().props.onClick();
	view.render();
	assert.equal(section().props.className, "pane fp-expanded dp-review");
	assert.ok(view.node((node) => node.props.className === "fp-backdrop"));
	assert.equal(view.node((node) => node.type === "textarea").props.value, "Retained draft");
	button(view, "Return Changes to the side").props.onClick();
	view.render();
	assert.equal(view.node((node) => node.type === "textarea").props.value, "Retained draft", "toggle retains the comment draft without a remount");
	review().props.onClick();
	view.render();
	let stopped = false;
	view.node((node) => node.type === "textarea").props.onKeyDown({ key: "Escape", nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() { stopped = true; } });
	view.render();
	assert.equal(stopped, true);
	assert.equal(view.node((node) => node.type === "textarea"), undefined);
	assert.equal(section().props.className, "pane fp-expanded dp-review", "comment Escape keeps the Review view");
	sectionKey("Escape");
	view.render();
	assert.equal(section().props.className, "pane");
	review().props.onClick();
	view.render();
	view.node((node) => node.props.className === "fp-backdrop").props.onClick();
	view.render();
	assert.equal(section().props.className, "pane");
	props().onSelectFile("conflict.txt");
	await update();
	assert.equal(viewed().props.disabled, true);
	assert.equal(button(view, "Next ›").props.disabled, true);
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

async function checkCommitButtons() {
	const commitText = "Commit the current uncommitted changes in this repository with a clear commit message. Don't push.";
	const pushText = "Commit the current uncommitted changes in this repository with a clear commit message, then push the branch.";
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
	view.confirmAnswer = false;
	for (const label of ["Commit", "Commit and push"]) {
		button(view, label).props.onClick();
		await view.settle();
		await app.settle();
		assert.equal(app.sends.length, initialSends, `${label} sends nothing when cancelled`);
	}
	view.confirmAnswer = true;
	button(view, "Commit").props.onClick();
	assert.equal(app.sends.length, initialSends, "Commit waits for the confirmation promise");
	assert.equal(view.confirms.at(-1), "Commit all uncommitted changes?\n\nGrok writes the commit message and commits. Nothing is pushed.");
	await view.settle();
	await app.settle();
	assert.equal(app.sends.at(-1).text, commitText, "the rendered Commit button sends the fixed request to this session");
	app.emit({ type: "done", uiSessionId: app.model().session.id, turnId: app.sends.at(-1).turnId });
	await app.settle();
	view.diffView(props());
	button(view, "Commit and push").props.onClick();
	assert.equal(app.sends.length, initialSends + 1, "Commit and push waits for the confirmation promise");
	assert.equal(view.confirms.at(-1), "Commit and push?\n\nGrok commits all uncommitted changes and pushes the branch to its remote.");
	await view.settle();
	await app.settle();
	assert.equal(app.sends.at(-1).text, pushText, "the rendered push button sends its exact fixed request");
	const sent = app.sends.length;
	view.diffView(props());
	button(view, "Commit").props.onClick();
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

async function checkTaskDetails() {
	const app = await composerWindow();
	const view = harness();
	const outputCalls = [];
	const transcriptCalls = [];
	const command = { id: "command-details", label: "Background ping", detail: "Command", running: true, info: { kind: "command", command: "ping -n 4 127.0.0.1", outputFile: "C:/logs/ping.log", exitCode: null, startedAt: 1000, endedAt: 0, status: "running" } };
	const model = { ...app.model(), tasks: [command], taskOutput: async (file) => { outputCalls.push(file); return { ok: true, text: outputCalls.length === 1 ? "First ping reply" : "Ping finished", truncated: true }; }, subagentTranscript: async (id) => { transcriptCalls.push(id); return { ok: true, messages: [{ id: "p", role: "user", text: "List files" }, { id: "r", role: "grok", text: "Found two files" }], truncated: true }; } };
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
	const agent = { id: "child-details", label: "Count files", detail: "Subagent", running: false, info: { kind: "agent", subagent: { id: "child", childSessionId: "child-session", agentType: "explore", model: "grok-4.7", status: "completed", output: "Found two files", durationMs: 2000, toolCalls: 1, tokensUsed: 42 } } };
	view.view("tasks", { ...model, tasks: [agent] });
	row().props.onClick();
	await view.settle();
	assert.equal(view.node((node) => node.type.name === "MessageBody").props.readOnly, true, "subagent results are observational");
	button(view, "Show transcript").props.onClick();
	await view.settle();
	assert.deepEqual(transcriptCalls, ["child-session"]);
	const block = view.node((node) => node.props.className === "task-transcript");
	assert.ok(block);
	assert.equal(view.nodes(block).filter((node) => node.type.name === "MessageBody").length, 2);
	assert.ok(view.nodes(block).filter((node) => node.type.name === "MessageBody").every((node) => node.props.readOnly), "every child transcript message is observational");
	row().props.onClick();
	view.render();
	assert.equal(row().props["aria-expanded"], false);
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

async function checkSetupSheet() {
	const healthy = { grok: { ok: true, signedIn: true, version: "1.0.70" }, git: { ok: true }, gh: { ok: true, signedIn: true }, install: "INSTALL GROK" };
	const setupNode = (app) => app.node((node) => node.type.name === "Setup");
	const good = harness();
	let checks = 0;
	good.api.readiness = async () => { checks++; return healthy; };
	await good.settle();
	assert.equal(setupNode(good), undefined, "healthy launch stays closed");
	assert.equal(checks, 1);
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
	setupNode(good).props.onCheck();
	await good.settle();
	assert.equal(checks, 3);
	assert.ok(setupNode(good), "healthy recheck keeps sheet open");
	const missing = harness();
	missing.api.readiness = async () => ({ ...healthy, grok: { ok: false, error: "Grok is not installed." } });
	await missing.settle();
	assert.ok(textOf(setupNode(missing).type(setupNode(missing).props)).includes("INSTALL GROK"));
	const signedOut = harness();
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
		const knownHit = known.find((file) => file.toLowerCase() === slash.toLowerCase());
		if (knownHit) { return knownHit; }
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
	const partialPathAt = (index) => /[^\s]+\/[^.\s]*\s+$/.test(text.slice(0, index).replace(/\\/g, "/"));
	for (const file of [...new Set([...known, ...found.keys()])].sort((left, right) => right.length - left.length)) {
		const root = "C:/project";
		const candidates = [root + "/" + file, (root + "/" + file).replace(/\//g, "\\"), file];
		const pattern = new RegExp("(?:^|[^\\w./\\\\:-])(" + candidates.map(escape).join("|") + ")(?=$|[^\\w./\\\\-])", "gi");
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
	const warned = (app) => app.nodes().filter((node) => node.props.className?.startsWith("mode-row") && textOf(node).includes("Restarts Grok"));
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
	rejected.api.send = async (input) => { rejected.sends.push(input); return { ok: false, error: "That folder is missing." }; };
	sendPrompt(rejected, "rejected before Grok");
	await rejected.settle();
	menu(rejected);
	same(warned(rejected).map((node) => node.props.children[0]), ["Auto-review", "Always-approve"], "rejected send preserves the previous accepted mode");
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
	const props = { ...first, docKey: "session-a:a.txt", file: "a.txt", line: 2, lineTick: 1 };
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
	for (const yes of [false, true]) {
		const archive = harness(new Map([["grok-code.history.v1", JSON.stringify(saved)]]));
		const removals = [];
		archive.api.removeWorktree = async (...args) => { removals.push(args); return { ok: false, dirty: true, ignored: [".env"] }; };
		await archive.settle();
		archive.sidebar().onArchive(target.id);
		await archive.settle();
		assert.equal(archive.sidebar().sessions.find(item => item.id === target.id).archived, false);
		assert.ok(textOf(archive.render()).includes(".env"));
		button(archive, yes ? "Archive anyway" : "Cancel").props.onClick();
		await archive.settle();
		assert.equal(archive.sidebar().sessions.find(item => item.id === target.id).archived, yes);
		same(removals, [[target.folder, target.worktreeFolder, { force: false }]]);
		assert.deepEqual(archive.confirms, []);
	}
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
	let dialog = app.node((node) => node.props.role === "alertdialog");
	assert.equal(dialog.props["aria-label"], "Update to version 0.2.1?");
	assert.ok(textOf(dialog).includes("N".repeat(1500)));
	assert.ok(!textOf(dialog).includes("OMITTED"), "notes stop at 1500 characters");
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

async function main() {
	const codeBlocks = harness();
	for (const lang of ["bash", "sh", "shell", "zsh", "cmd", "bat", "console", "powershell", "pwsh", "ps1", "ps"]) {
		codeBlocks.markdown({ text: `\`\`\`${lang}\nWrite-Output 'hello'\n\`\`\``, onCopy() {}, onRun() {} });
		assert.ok(button(codeBlocks, "Copy"), `${lang} has Copy`);
		assert.equal(!!button(codeBlocks, "Run"), ["powershell", "pwsh", "ps1", "ps"].includes(lang), `${lang} only has Run for PowerShell`);
	}
	await check();
	await checkQueue();
	await checkQueueRelaunch();
	await checkQueueFailedClose();
	await checkQueueWindowMerge();
	await checkQueueAcrossWindows();
	await checkQueueValidationAndEdit();
	await checkConversationActionsAndView();
	await checkTurnIds();
	await checkInterrupted();
	await checkSessionOrder();
	await checkLostSession();
	await checkModeEvents();
	await checkAnswers();
	await checkSavedSize();
	await checkGrokState();
	await checkToolRows();
	await checkFixBrief();
	await checkRoutineBatchB();
	await checkTerminalSelection();
	await checkEditorFlush();
	await checkPlanResumeMode();
	await checkFirstLaunch();
	await checkSessionModel();
	await checkSettingsSaveFailure();
	await checkCleanAutoArchive();
	await checkDirtyAutoArchive();
	await checkBusyAutoArchive();
	await checkUnarchiveAfterAutoArchive();
	await checkRememberedAccount();
	await checkSettingsBlocksShortcuts();
	await checkComposerDraftRelaunch();
	await checkNewSessionDraftRelaunch();
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
	await checkStreamHistorySaves();
	await checkResizeChurn();
	await checkSmallUiBatch();
	await checkRefreshScopes();
	await checkSavedThinkingAndLegacySettings();
	await checkBackgroundWorkHistory();
	await checkTaskDetails();
	await checkReadOnlyMessages();
	await checkEditDiffs();
	await checkSetupSheet();
	await checkFileLinkIndex();
	await checkFileListIdentityAndLimit();
	await checkModeRestartWarnings();
	await checkCommitButtons();
	await checkReviewWorkspace();
	await checkEditorLanguagesAndSettings();
	await checkCodeEditorIntegration();
	await checkConfirmHostAndQueue();
	await checkConfirmActions();
	await checkAppUpdates();
	console.log("Renderer turn and tool-row checks passed: parallel sessions, per-session drafts, queue and Send now, side chat, turn ids, interrupted replies, session order and delete, lost Grok sessions, mode events and folder modes, plan/question/always answers, saved history size, Grok commands/MCP/usage/attachments/settings, and tool rows.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
