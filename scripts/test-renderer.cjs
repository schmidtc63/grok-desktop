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
	const windowEvents = new Map();
	const jsx = (type, props) => ({ type, props: props ?? {} });
	const react = {
		Fragment: "fragment",
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
	const cache = {};
	function load(name) {
		if (cache[name]) { return cache[name]; }
		const file = path.join(__dirname, "..", "src", name);
		const source = transformSync(fs.readFileSync(file, "utf8"), { loader: name.endsWith("tsx") ? "tsx" : "ts", format: "cjs", jsx: "automatic" }).code;
		const module = { exports: {} };
		const imports = (id) => {
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
			document: { documentElement: { setAttribute() {}, removeAttribute() {} }, hasFocus: () => true, querySelectorAll: () => [] },
			localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { if (storage.failWrites) { throw storage.failWrites === "quota" ? new DOMException("The quota has been exceeded.", "QuotaExceededError") : new Error("Quota exceeded"); } storage.set(key, value); if (key === "grok-code.history.v1") { historyWrites.push(value); } } },
			window: { grokCode: api, location: { search }, confirm: (message) => { confirms.push(message); return true; }, focus() {}, addEventListener: (event, callback) => windowEvents.set(event, callback), removeEventListener: (event) => windowEvents.delete(event) }, URL, URLSearchParams,
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
	return {
		storage, locks, sends, writes, historyWrites, pickedFolders, forgotten, pickedFiles, allowedUpdates, newWindows, questionAnswers, planAnswers, decisions, cancels, confirms, files, api, settle, render,
		beforeUnload: () => { const event = { prevented: false, returnValue: true, preventDefault() { this.prevented = true; } }; windowEvents.get("beforeunload")?.(event); return event; },
		storageEvent: (key) => windowEvents.get("storage")?.({ key }),
		key: (event) => windowEvents.get("keydown")({ preventDefault() {}, stopPropagation() {}, target: {}, ctrlKey: false, shiftKey: false, altKey: false, code: "", ...event }),
		fileHits: (text, known = [], tools = []) => load("Panes.tsx").mentionedFiles(text, tools, "C:/project", known),
		markdown: (props) => { component = () => load("Markdown.tsx").Markdown(props); dirty = true; return render(); },
		view: (id, model) => { component = () => { const pane = load("Panes.tsx").PaneView({ id, model }); return pane.type(pane.props); }; dirty = true; return render(); },
		row: (props) => { component = () => load("Panes.tsx").ToolRow(props); dirty = true; return render(); },
		group: (props) => { component = () => load("Panes.tsx").ToolGroup(props); dirty = true; return render(); },
		rail: (props) => { component = () => load("SessionRail.tsx").SessionRail(props); dirty = true; return render(); },
		filesView: (props) => { component = () => load("FilesPane.tsx").FilesPane({ ...props, autoSave: false }); dirty = true; return render(); },
		message: (model) => { component = () => { const pane = load("Panes.tsx").PaneView({ id: "chat", model }); const chat = pane.type(pane.props); const body = nodes(chat).find((node) => node.type.name === "MessageBody"); return body.type(body.props); }; dirty = true; return render(); },
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
		notice: () => [find((node) => node.props.className === "note composer-note")?.props.children].flat()[0],
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
	const option = (rows, label) => rows.node((node) => node.type === "button" && node.props["aria-pressed"] !== undefined && [node.props.children].flat()[0] === label);
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
	assert.equal(app.beforeUnload().prevented, true, "a close or reload asks first while a message is queued");
	app.sidebar().onSelect(secondId);
	await app.settle();
	assert.deepEqual(queuedTexts(), [], "the queue belongs to its session");
	assert.equal(app.beforeUnload().prevented, true, "a queue in another session also asks");
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
	app.nodes().filter((node) => node.props.className === "queued")[1].props.children[1].props.onClick();
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
	assert.equal(app.beforeUnload().prevented, true, "a queue that Stop holds is still unsent, so a close asks too");
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
	app.nodes().filter((node) => node.props.className === "queued")[0].props.children[2].props.onClick();
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

async function main() {
	const codeBlocks = harness();
	for (const lang of ["bash", "sh", "shell", "zsh", "cmd", "bat", "console", "powershell", "pwsh", "ps1", "ps"]) {
		codeBlocks.markdown({ text: `\`\`\`${lang}\nWrite-Output 'hello'\n\`\`\``, onCopy() {}, onRun() {} });
		assert.ok(button(codeBlocks, "Copy"), `${lang} has Copy`);
		assert.equal(!!button(codeBlocks, "Run"), ["powershell", "pwsh", "ps1", "ps"].includes(lang), `${lang} only has Run for PowerShell`);
	}
	await check();
	await checkQueue();
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
	console.log("Renderer turn and tool-row checks passed: parallel sessions, per-session drafts, queue and Send now, side chat, turn ids, interrupted replies, session order and delete, lost Grok sessions, mode events and folder modes, plan/question/always answers, saved history size, Grok commands/MCP/usage/attachments/settings, and tool rows.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
