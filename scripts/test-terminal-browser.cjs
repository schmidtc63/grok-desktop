const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const jsx = (type, props) => ({ type, props: props ?? {} });
let hooks;
const react = {
	createElement: (type, props) => ({ type, props: props ?? {} }),
	useEffect(run, dependencies) {
		if (!hooks) { return; }
		const state = hooks;
		const index = state.cursor++;
		const previous = state.values[index];
		if (!previous || !dependencies || dependencies.some((value, offset) => value !== previous.dependencies[offset])) {
			state.effects.push(() => {
				previous?.cleanup?.();
				state.values[index] = { dependencies, cleanup: run() };
			});
		}
	},
	useMemo: (fn) => fn(),
	useRef(current) {
		if (!hooks) { return { current }; }
		const index = hooks.cursor++;
		if (!(index in hooks.values)) { hooks.values[index] = { current }; }
		return hooks.values[index];
	},
	useState(initial) {
		if (!hooks) { return [typeof initial === "function" ? initial() : initial, () => {}]; }
		const state = hooks;
		const index = state.cursor++;
		if (!(index in state.values)) { state.values[index] = typeof initial === "function" ? initial() : initial; }
		return [state.values[index], (next) => { state.values[index] = typeof next === "function" ? next(state.values[index]) : next; }];
	},
};
react.useLayoutEffect = react.useEffect;

function load(name, globals = {}) {
	const file = path.join(__dirname, "..", "src", name);
	const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
	const module = { exports: {} };
	const imports = (id) => {
		if (id === "react") {
			return react;
		}
		if (id === "react/jsx-runtime") {
			return { jsx, jsxs: jsx, Fragment: "fragment" };
		}
		if (id === "@xterm/xterm") { return globals.xterm || { Terminal: class {} }; }
		if (id === "@xterm/addon-fit") { return globals.fitAddon || { FitAddon: class {} }; }
		if (id === "@xterm/xterm/css/xterm.css") { return {}; }
		if (id === "./Icon") { return load("Icon.tsx", globals); }
		if (id === "./PaneActions") { return load("PaneActions.tsx", globals); }
		if (id === "./PopupMenu") { return load("PopupMenu.tsx", globals); }
		if (id === "./data") {
			return load("data.ts", globals);
		}
		if (id === "./browserDiagnostics") {
			return load("browserDiagnostics.ts", globals);
		}
		throw new Error(`Unexpected import ${id}`);
	};
	vm.runInNewContext(source, { require: imports, module, exports: module.exports, URL, ...globals }, { filename: file });
	return module.exports;
}

const terminal = load("TerminalPane.tsx");
const { stripAnsi } = terminal;
// Copy into this realm: deepStrictEqual compares prototypes, and the vm context has its own Object.
const historyStep = (...args) => ({ ...terminal.historyStep(...args) });
const { PICKER_SCRIPT } = load("BrowserPane.tsx");

let failed = 0;
async function check(name, run) {
	try {
		await run();
		console.log(`PASS ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}`);
		console.log(error);
	}
}

// A tiny page for the picker: one window, an overlay sink, and elements with ids and siblings.
function fakePage() {
	const listeners = new Map();
	class Element {
		constructor(localName, parentElement, id = "", previousElementSibling = null) {
			this.nodeType = 1;
			this.localName = localName;
			this.parentElement = parentElement;
			this.id = id;
			this.previousElementSibling = previousElementSibling;
			this.style = {};
			this.outerHTML = `<${localName}>`;
			this.removed = false;
		}
		getBoundingClientRect() {
			return { left: 1, top: 2, width: 30, height: 40 };
		}
		appendChild(child) {
			this.child = child;
		}
		remove() {
			this.removed = true;
		}
	}
	const body = new Element("body", null);
	const app = new Element("div", body, "app");
	const first = new Element("p", app);
	const second = new Element("p", app, "", first);
	second.outerHTML = "x".repeat(5000);
	const page = {
		Element,
		CSS: { escape: (value) => value },
		document: { body, documentElement: body, createElement: (localName) => new Element(localName, null) },
		addEventListener: (name, fn, capture) => {
			assert.equal(capture, true);
			listeners.set(name, fn);
		},
		removeEventListener: (name, fn) => {
			if (listeners.get(name) === fn) {
				listeners.delete(name);
			}
		},
	};
	page.window = page;
	return { page, listeners, body, second };
}

function fakeEvent(target, key) {
	const event = { target, key, blocked: 0 };
	event.preventDefault = () => { event.blocked += 1; };
	event.stopPropagation = () => {};
	event.stopImmediatePropagation = () => {};
	return event;
}

// Renders TerminalPane with two tabs, the second active, and records onInterrupt calls.
function renderTerminal(running = true) {
	const interrupted = [];
	const tree = terminal.TerminalPane({
		tabs: [{ id: "one", title: "one", cwd: "C:\\one", running: true, output: "" }, { id: "two", title: "two", cwd: "C:\\two", running, output: "" }],
		activeId: "two",
		terminalScreenReader: false,
		onActivate() {},
		onNew() {},
		onCloseTab() {},
		onInput() {},
		onInterrupt: (id) => interrupted.push(id),
		onClose() {},
	});
	return { tree, interrupted };
}

function findNode(node, match) {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findNode(item, match);
			if (found) {
				return found;
			}
		}
		return null;
	}
	if (!node || typeof node !== "object") {
		return null;
	}
	return match(node) ? node : findNode(node.props.children, match);
}

function ctrlC(selectionStart, selectionEnd) {
	return Object.assign(fakeEvent(null, "c"), { ctrlKey: true, shiftKey: false, altKey: false, currentTarget: { selectionStart, selectionEnd } });
}

function findNodes(node, match, output = []) {
	if (Array.isArray(node)) {
		for (const child of node) { findNodes(child, match, output); }
	} else if (node && typeof node === "object") {
		if (match(node)) { output.push(node); }
		findNodes(node.props.children, match, output);
	}
	return output;
}

function textOf(node) {
	if (Array.isArray(node)) { return node.map(textOf).join(""); }
	if (typeof node === "string" || typeof node === "number") { return String(node); }
	return node && typeof node === "object" ? textOf(node.props.children) : "";
}

function browserHarness() {
	const diagnostics = load("browserDiagnostics.ts");
	const appended = [];
	const reports = [];
	let stops = 0;
	let resumes = 0;
	let networkListener;
	let unsubscribed = 0;
	const document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
	const { BrowserPane } = load("BrowserPane.tsx", {
		window: { grokCode: { browserTabs: async (payload) => { reports.push(JSON.parse(JSON.stringify(payload))); return { ok: true }; }, onBrowserProblem(listener) { networkListener = listener; return () => { unsubscribed++; networkListener = undefined; }; } } },
		document,
		Node: { COMMENT_NODE: 8 },
		NodeFilter: { SHOW_TEXT: 4, SHOW_COMMENT: 128 },
	});
	const state = { cursor: 0, values: [], effects: [] };
	const props = {
		uiSessionId: "session-one", controlEnabled: true, controlStopped: false,
		onStopControl() { stops++; props.controlStopped = true; }, onResumeControl() { resumes++; props.controlStopped = false; },
		tabs: [{ id: "one", url: "https://one.test/page?session=secret#private", title: "One" }, { id: "two", url: "https://two.test/", title: "Two" }],
		activeId: "one", keepCookies: true, linksInBuiltIn: true, devServers: [], selectTick: 0,
		onActivate(id) { props.activeId = id; }, onNewTab() {},
		onCloseTab(id) { props.tabs = props.tabs.filter((tab) => tab.id !== id); },
		onNavigate() {},
		onPageChanged(id, url, title) { props.tabs = props.tabs.map((tab) => tab.id === id ? { ...tab, url, title } : tab); },
		onKeepCookies() {}, onClearData() {}, onLinksInBuiltIn() {}, onStartServer() {}, onStopServer() {}, onStopAll() {}, onPicked() {}, onClose() {},
		onProblem(id, entry) { props.tabs = props.tabs.map((tab) => tab.id === id ? { ...tab, problems: diagnostics.addProblem(tab.problems ?? [], entry) } : tab); },
		onClearProblems(id) { props.tabs = props.tabs.map((tab) => tab.id === id ? { ...tab, problems: [] } : tab); },
		onDiagnostics(text) { appended.push(text); },
	};
	function render() {
		hooks = state;
		state.cursor = 0;
		state.effects = [];
		try {
			const tree = BrowserPane(props);
			for (const effect of state.effects) { effect(); }
			return tree;
		} finally {
			hooks = undefined;
		}
	}
	const views = new Map();
	const cleanups = [];
	for (const [offset, node] of findNodes(render(), (item) => item.type === "webview").entries()) {
		const listeners = new Map();
		const view = {
			url: props.tabs[offset].url,
			getURL() { return this.url; }, getTitle() { return props.tabs[offset]?.title ?? ""; }, getWebContentsId() { return 10 + offset; },
			getAttribute(name) { return name === "src" ? this.url : undefined; }, setAttribute(name, value) { if (name === "src") { this.url = value; } },
			addEventListener(name, listener) { listeners.set(name, listener); },
			removeEventListener(name, listener) { if (listeners.get(name) === listener) { listeners.delete(name); } },
			emit(type, details = {}) { Object.defineProperty(details, "type", { value: type, configurable: true }); listeners.get(type)?.(details); },
			listeners,
		};
		cleanups.push(node.props.ref(view));
		views.set(props.tabs[offset].id, view);
	}
	return {
		props, views, render, document, appended, reports, stops: () => stops, resumes: () => resumes,
		network(entry) { networkListener?.(entry); },
		problems(id) { return props.tabs.find((tab) => tab.id === id)?.problems ?? []; },
		unmount() {
			for (const cleanup of cleanups) { cleanup?.(); }
			for (const value of state.values) { value?.cleanup?.(); }
		},
		unsubscribed: () => unsubscribed,
	};
}

(async () => {
	await check("stripAnsi removes SGR colors", () => {
		assert.equal(stripAnsi("\x1b[31mred\x1b[0m and \x1b[1;32mbold green\x1b[m"), "red and bold green");
	});
	await check("stripAnsi removes erase-line", () => {
		assert.equal(stripAnsi("\x1b[2Kcleared\x1b[K"), "cleared");
	});
	await check("stripAnsi removes cursor hide and show", () => {
		assert.equal(stripAnsi("\x1b[?25lworking\x1b[?25h"), "working");
	});
	await check("stripAnsi removes OSC title (BEL and ST)", () => {
		assert.equal(stripAnsi("\x1b]0;Windows PowerShell\x07after\x1b]2;t\x1b\\ end"), "after end");
	});
	await check("stripAnsi keeps only the text after the last \\r", () => {
		assert.equal(stripAnsi("loading 10%\rloading 99%\ndone"), "loading 99%\ndone");
		assert.equal(stripAnsi("50%\r100%\r"), "100%");
		assert.equal(stripAnsi("a\r\nb"), "a\nb");
	});
	await check("stripAnsi leaves plain text unchanged", () => {
		const plain = "PS C:\\work> dir\n\n    Directory: C:\\work\n\tMode  LastWriteTime  [x] {y}";
		assert.equal(stripAnsi(plain), plain);
	});
	await check("historyStep up from a fresh line shows the newest entry", () => {
		assert.deepEqual(historyStep(["a", "b", "c"], 3, -1), { index: 2, value: "c" });
	});
	await check("historyStep up at the oldest entry stays there", () => {
		assert.deepEqual(historyStep(["a", "b", "c"], 0, -1), { index: 0, value: "a" });
		assert.deepEqual(historyStep([], 0, -1), { index: 0, value: "" });
	});
	await check("historyStep down from the newest entry returns to a fresh empty line", () => {
		assert.deepEqual(historyStep(["a", "b", "c"], 2, 1), { index: 3, value: "" });
		assert.deepEqual(historyStep(["a", "b", "c"], 3, 1), { index: 3, value: "" });
	});
	await check("TerminalPane Stop button interrupts the active tab and is hidden once it exits", () => {
		const { tree, interrupted } = renderTerminal();
		const stop = findNode(tree, (node) => node.type === "button" && node.props.children === "Stop");
		assert.equal(stop.props.title, "Stop the running command (Ctrl+C). The terminal stays open.");
		stop.props.onClick();
		assert.deepEqual(interrupted, ["two"]);
		assert.equal(findNode(renderTerminal(false).tree, (node) => node.type === "button" && node.props.children === "Stop"), null);
	});
	await check("TerminalPane Ctrl+C in the input interrupts the active tab only without a selection", () => {
		const { tree, interrupted } = renderTerminal();
		const input = findNode(tree, (node) => node.type === "input");
		const bare = ctrlC(4, 4);
		input.props.onKeyDown(bare);
		assert.deepEqual(interrupted, ["two"]);
		assert.equal(bare.blocked, 1);
		const selected = ctrlC(0, 4);
		input.props.onKeyDown(selected);
		assert.deepEqual(interrupted, ["two"]);
		assert.equal(selected.blocked, 0);
	});
	await check("PICKER_SCRIPT parses as JavaScript", () => {
		assert.equal(typeof PICKER_SCRIPT, "string");
		new vm.Script(PICKER_SCRIPT);
	});
	await check("PICKER_SCRIPT is an expression that yields a Promise", () => {
		assert.ok(PICKER_SCRIPT.startsWith("("));
		assert.ok(PICKER_SCRIPT.includes("new Promise"));
	});
	await check("PICKER_SCRIPT resolves the clicked element and removes its listeners and overlay", async () => {
		const { page, listeners, body, second } = fakePage();
		const result = new vm.Script(PICKER_SCRIPT).runInNewContext(page);
		assert.equal(listeners.size, 7);
		listeners.get("mousemove")(fakeEvent(second));
		assert.equal(body.child.style.display, "block");
		assert.equal(body.child.style.width, "30px");
		const press = fakeEvent(second);
		listeners.get("mousedown")(press);
		assert.equal(press.blocked, 1);
		const click = fakeEvent(second);
		listeners.get("click")(click);
		assert.equal(click.blocked, 1);
		const picked = await result;
		assert.equal(picked.selector, "#app > p:nth-of-type(2)");
		assert.equal(picked.html.length, 4000);
		assert.ok(!("text" in picked));
		assert.equal(listeners.size, 0);
		assert.equal(body.child.removed, true);
		assert.equal(page.__grokPickerStop, undefined);
	});
	await check("PICKER_SCRIPT resolves null on Escape and when a newer picker replaces it", async () => {
		const { page, listeners, body } = fakePage();
		const escaped = new vm.Script(PICKER_SCRIPT).runInNewContext(page);
		listeners.get("keydown")(fakeEvent(body, "a"));
		assert.equal(listeners.size, 7);
		listeners.get("keydown")(fakeEvent(body, "Escape"));
		assert.equal(await escaped, null);
		assert.equal(listeners.size, 0);
		const older = new vm.Script(PICKER_SCRIPT).runInNewContext(page);
		const newer = new vm.Script(PICKER_SCRIPT).runInNewContext(page);
		assert.equal(await older, null);
		assert.equal(listeners.size, 7);
		page.__grokPickerStop();
		assert.equal(await newer, null);
		assert.equal(listeners.size, 0);
	});
	await check("native terminal forwards raw input, fits, appends output, follows appearance and accessibility, and disposes", async () => {
		const instances = [];
		const resizes = [];
		const inputs = [];
		let paneCloses = 0;
		let tabFocused = 0;
		const terminalCss = fs.readFileSync(path.join(__dirname, "../src/terminal-browser.css"), "utf8");
		assert.doesNotMatch(terminalCss, /\.tp-native\s*\{[^}]*padding/, "the fit addon counts this padding as room for rows, which cuts off the last row");
		assert.match(terminalCss, /\.tp-native > \.xterm\s*\{[^}]*padding/);
		const resizeObservers = [];
		const appearanceObservers = [];
		const schemeListeners = new Map();
		const style = { "--code": "#100f0d", "--code-text": "#e7e1d6" };
		let accessibilityListener;
		class FakeTerminal {
			constructor(options) { this.options = options; this.writes = []; this.cols = 80; this.rows = 24; instances.push(this); }
			loadAddon(addon) { addon.term = this; }
			open(element) { this.element = element; }
			attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
			write(text) { this.writes.push(text); }
			onData(listener) { this.input = listener; return { dispose: () => { this.input = undefined; this.inputDisposed = true; } }; }
			focus() { this.focused = true; }
			reset() { this.resets = (this.resets ?? 0) + 1; }
			dispose() { this.disposed = true; }
		}
		class FakeFitAddon {
			fit() {
				this.term.fits = (this.term.fits ?? 0) + 1;
				this.term.cols = Math.floor(this.term.element.clientWidth / 10);
				this.term.rows = Math.floor(this.term.element.clientHeight / 20);
			}
		}
		class FakeResizeObserver {
			constructor(callback) { this.callback = callback; resizeObservers.push(this); }
			observe(target) { this.target = target; }
			disconnect() { this.disconnected = true; }
		}
		class FakeMutationObserver {
			constructor(callback) { this.callback = callback; appearanceObservers.push(this); }
			observe(target, options) { this.target = target; this.options = options; }
			disconnect() { this.disconnected = true; }
		}
		const { TerminalPane } = load("TerminalPane.tsx", {
			xterm: { Terminal: FakeTerminal }, fitAddon: { FitAddon: FakeFitAddon },
			ResizeObserver: FakeResizeObserver, MutationObserver: FakeMutationObserver,
			document: { documentElement: {} },
			window: {
				grokCode: {
					accessibilitySupport: async () => true,
					onEvent: (listener) => { accessibilityListener = listener; return () => { accessibilityListener = undefined; }; },
				},
				getComputedStyle: () => ({ getPropertyValue: (name) => style[name] ?? "" }),
				matchMedia: () => ({ addEventListener: (name, callback) => schemeListeners.set(name, callback), removeEventListener: (name, callback) => { if (schemeListeners.get(name) === callback) { schemeListeners.delete(name); } } }),
			},
		});
		const paneProps = { tabs: [{ id: "native", title: "Shell", cwd: "C:/project", running: true, backend: "pty", output: "ABCDEF", received: 6 }], activeId: "native", terminalScreenReader: false, onInput: (...args) => inputs.push(args), onResize: (...args) => resizes.push(args), onActivate() {}, onNew() {}, onCloseTab() {}, onInterrupt() {}, onClose() { paneCloses++; } };
		const renderWithHooks = (state, component, props, element) => {
			hooks = state;
			state.cursor = 0;
			state.effects = [];
			try {
				const tree = component(props);
				if (element) { tree.props.ref.current = element; }
				for (const effect of state.effects) { effect(); }
				return tree;
			} finally { hooks = undefined; }
		};
		const paneState = { values: [] };
		const renderPane = () => renderWithHooks(paneState, TerminalPane, paneProps);
		const findNative = (pane) => findNode(pane, (node) => typeof node.type === "function" && node.type.name === "NativeTerminal");
		const pane = renderPane();
		assert.equal(findNode(pane, (node) => node.type === "form"), null, "native tabs have no line-input form");
		assert.equal(findNative(pane), null, "xterm waits for the initial accessibility snapshot");
		await Promise.resolve();
		const native = findNative(renderPane());
		const props = { ...native.props };
		const element = { clientWidth: 1000, clientHeight: 600, closest(selector) {
			assert.equal(selector, ".tp-pane");
			return { querySelector(query) {
				assert.equal(query, ".tp-tab-name[aria-current='true']");
				return { focus() { tabFocused++; } };
			} };
		} };
		const state = { values: [] };
		const render = () => renderWithHooks(state, native.type, props, element);
		render();
		const term = instances[0];
		assert.equal(term.options.fontSize, 13);
		assert.equal(term.options.lineHeight, 1.45);
		assert.equal(term.options.fontFamily, 'Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace');
		assert.equal(term.options.screenReaderMode, true, "system detection enables support at construction");
		accessibilityListener({ type: "accessibility-support-changed", active: false });
		props.screenReaderMode = findNative(renderPane()).props.screenReaderMode;
		render();
		assert.equal(term.options.screenReaderMode, false, "the system can turn off support");
		paneProps.terminalScreenReader = true;
		props.screenReaderMode = findNative(renderPane()).props.screenReaderMode;
		render();
		assert.equal(term.options.screenReaderMode, true, "the setting enables support without detection");
		assert.equal(term.options.scrollback, 5000);
		assert.equal(term.focused, true);
		assert.deepEqual(resizes, [["native", 100, 30]]);
		assert.deepEqual(term.writes, ["ABCDEF"], "initial output is replayed once");
		term.input("\x1b[A\x03");
		assert.deepEqual(inputs, [["native", "\x1b[A\x03"]], "arrow keys and Ctrl+C stay raw");
		for (const [key, modifiers] of [["Tab", {}], ["r", { ctrlKey: true }]]) {
			const event = Object.assign(fakeEvent(element, key), { type: "keydown", ...modifiers });
			assert.equal(term.keyHandler(event), true, `${key} stays with xterm`);
			assert.equal(event.blocked, 0);
		}
		const leave = Object.assign(fakeEvent(element, "F6"), { type: "keydown", shiftKey: true });
		assert.equal(term.keyHandler(leave), false);
		assert.equal(leave.blocked, 1);
		assert.equal(tabFocused, 1, "Shift+F6 returns keyboard focus to the active terminal tab");
		const closePane = Object.assign(fakeEvent(element, "`"), { type: "keydown", ctrlKey: true, code: "Backquote" });
		assert.equal(term.keyHandler(closePane), false);
		assert.equal(closePane.blocked, 1);
		assert.equal(paneCloses, 1, "Ctrl+backtick closes the terminal pane");
		props.tab = { ...props.tab, output: "CDEFGH", received: 8 };
		props.onInput = (...args) => inputs.push(["updated", ...args]);
		props.onResize = (...args) => resizes.push(["updated", ...args]);
		render();
		render();
		assert.equal(instances.length, 1, "output, accessibility and callback changes do not recreate xterm");
		assert.deepEqual(term.writes, ["ABCDEF", "GH"], "received preserves new suffixes when the stored buffer is capped");
		term.input("x");
		assert.deepEqual(inputs.at(-1), ["updated", "native", "x"]);
		element.clientWidth = 800;
		element.clientHeight = 400;
		resizeObservers[0].callback();
		assert.deepEqual(resizes.at(-1), ["updated", "native", 80, 20]);
		const appearance = appearanceObservers[0];
		assert.ok(appearance.options.attributeFilter.includes("data-ui-config"));
		Object.assign(style, {
			"--code": "#f3f1ea", "--code-text": "#2b2722",
			"--terminal-font-size": "16px", "--terminal-line-height": "24px",
			"--terminal-font": "Courier, monospace", "--mono-font": "Cascadia Mono, monospace",
		});
		const previousFits = term.fits;
		appearance.callback();
		assert.equal(term.options.theme.background, style["--code"]);
		assert.equal(term.options.theme.foreground, style["--code-text"]);
		assert.equal(term.options.theme.cursor, style["--code-text"]);
		assert.equal(term.options.fontSize, 16);
		assert.equal(term.options.lineHeight, 1.5);
		assert.equal(term.options.fontFamily, style["--terminal-font"]);
		assert.equal(term.fits, previousFits + 1, "UI configuration changes refit the existing terminal");
		Object.assign(style, { "--terminal-font-size": "20px", "--terminal-line-height": "10px", "--terminal-font": "" });
		appearance.callback();
		assert.equal(term.options.fontSize, 20);
		assert.equal(term.options.lineHeight, 1);
		assert.equal(term.options.fontFamily, style["--mono-font"]);
		assert.equal(instances.length, 1);
		assert.deepEqual(term.writes, ["ABCDEF", "GH"]);
		assert.equal(schemeListeners.has("change"), true);
		for (const value of state.values) { value?.cleanup?.(); }
		for (const value of paneState.values) { value?.cleanup?.(); }
		assert.equal(accessibilityListener, undefined);
		assert.equal(resizeObservers[0].disconnected, true);
		assert.equal(appearanceObservers[0].disconnected, true);
		assert.equal(schemeListeners.size, 0);
		assert.equal(term.inputDisposed, true);
		assert.equal(term.disposed, true);
	});
	await check("browser element picks redact the page URL and markup before appending to the draft", async () => {
		const browser = browserHarness();
		const view = browser.views.get("one");
		view.url = "https://user:password@one.test/callback?token=query-secret#fragment-secret";
		function input(attributes) {
			return {
				getAttributeNames() { return Object.keys(attributes); },
				getAttribute(name) { return attributes[name]; },
				removeAttribute(name) { delete attributes[name]; },
				remove() { this.removed = true; },
				get html() { return this.removed ? "" : `<input${Object.entries(attributes).map(([name, value]) => ` ${name}="${value}"`).join("")}>`; },
			};
		}
		const hidden = input({ type: "HIDDEN", value: "hidden-secret" });
		const visible = input({ type: "password", value: "input-secret", "data-session": "attr-secret", id: "password", class: "bg-[url(https://one.test/callback?class-secret)]" });
		const text = { nodeType: 3, nodeValue: "See https://user:visible-password@one.test/help?visible-token=x#visible-fragment for details #help." };
		const rawHtml = `<form>${hidden.html}${visible.html}<p>${text.nodeValue}</p></form>`;
		const template = {
			content: { querySelectorAll(selector) {
				if (selector === "*") { return [hidden, visible].filter((element) => !element.removed); }
				assert.ok(selector.includes("input[type=hidden i]"));
				return [hidden];
			} },
			set innerHTML(html) { assert.equal(html, rawHtml); },
			get innerHTML() { return `<form>${hidden.html}${visible.html}<p>${text.nodeValue}</p></form>`; },
		};
		browser.document.createElement = (name) => {
			assert.equal(name, "template");
			return template;
		};
		browser.document.createTreeWalker = () => {
			const nodes = [text];
			return { nextNode() { this.currentNode = nodes.shift(); return this.currentNode; } };
		};
		view.executeJavaScript = async () => ({ selector: "form", html: rawHtml, text: "Sign in" });
		browser.props.onPicked = (pick) => browser.appended.push(`${pick.url}\n${pick.html}`);
		browser.props.selectTick = 1;
		browser.render();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(browser.appended, ['https://one.test/callback\n<form><input type="password" id="password"><p>See https://one.test/help for details #help.</p></form>']);
		browser.unmount();
	});
	await check("browser address follows a submitted navigation and redirect", () => {
		const browser = browserHarness();
		const addressInput = (tree) => findNode(tree, (node) => node.props["aria-label"] === "Address");
		const tree = browser.render();
		const address = addressInput(tree);
		const focused = { blur() { browser.document.activeElement = null; } };
		address.props.ref.current = focused;
		browser.document.activeElement = focused;
		address.props.onChange({ target: { value: "https://one.test/typed" } });
		browser.props.onNavigate = browser.props.onPageChanged;
		const form = findNode(browser.render(), (node) => node.type === "form");
		form.props.onSubmit(fakeEvent(focused, "Enter"));
		assert.equal(browser.document.activeElement, null);
		browser.render();
		assert.equal(addressInput(browser.render()).props.value, "https://one.test/typed");
		const view = browser.views.get("one");
		view.url = "https://redirect.test/actual";
		view.emit("did-navigate");
		browser.render();
		assert.equal(addressInput(browser.render()).props.value, "https://redirect.test/actual");
		browser.unmount();
	});
	await check("browser control reports real guests, sanitized evidence, active tab and unmount; Stop and resume stay explicit", () => {
		const browser = browserHarness();
		assert.equal(browser.reports.at(-1).uiSessionId, "session-one");
		assert.deepEqual(browser.reports.at(-1).tabs.map((tab) => [tab.id, tab.webContentsId, tab.url]), [["one", 10, "https://one.test/page"], ["two", 11, "https://two.test/"]]);
		assert.ok(browser.reports.at(-1).tabs.every((tab) => tab.problems.startsWith("Browser diagnostics\nPage: ")));
		assert.ok(!JSON.stringify(browser.reports).includes("secret"));
		browser.props.onActivate("two");
		browser.render();
		assert.equal(browser.reports.at(-1).activeId, "two");
		browser.views.get("two").url = "https://two.test/next?token=secret#private";
		browser.views.get("two").emit("dom-ready");
		assert.equal(browser.reports.at(-1).tabs[1].url, "https://two.test/next");
		browser.props.controlActivity = { text: "clicking a button", running: true };
		let tree = browser.render();
		const banner = findNode(tree, (node) => node.props.className === "bp-control");
		assert.ok(textOf(banner).includes("An already-sent action may still finish."));
		findNode(banner, (node) => node.type === "button" && node.props.children === "Stop").props.onClick();
		assert.equal(browser.stops(), 1);
		tree = browser.render();
		findNode(tree, (node) => node.props["aria-label"] === "Browser menu").props.onClick({ currentTarget: {} });
		tree = browser.render();
		findNode(tree, (node) => node.type === "button" && node.props.children === "Let Grok use this browser").props.onClick();
		assert.equal(browser.resumes(), 1);
		browser.props.controlEnabled = false;
		browser.render();
		assert.equal(browser.reports.at(-1).enabled, false);
		browser.unmount();
		assert.equal(browser.reports.at(-1).visible, false);
		assert.deepEqual(browser.reports.at(-1).tabs, []);
	});
	await check("hiding Browser retains guests, withdraws access and cancels the picker", async () => {
		const browser = browserHarness();
		const view = browser.views.get("one");
		const picks = [];
		const scripts = [];
		let resolvePick;
		view.executeJavaScript = (script) => {
			scripts.push(script);
			if (script === PICKER_SCRIPT) { return new Promise((resolve) => { resolvePick = resolve; }); }
			return Promise.resolve(null);
		};
		browser.props.onPicked = (pick) => picks.push(pick);
		const webviews = () => findNodes(browser.render(), (node) => node.type === "webview").map((node) => node.props.ref);
		const original = webviews();
		browser.props.selectTick += 1;
		browser.render();
		await Promise.resolve();
		assert.deepEqual(scripts, [PICKER_SCRIPT]);
		browser.props.visible = false;
		assert.deepEqual(webviews(), original, "the same webviews remain mounted while hidden");
		assert.equal(browser.reports.at(-1).visible, false);
		assert.deepEqual(browser.reports.at(-1).tabs, []);
		assert.deepEqual(scripts, [PICKER_SCRIPT, "window.__grokPickerStop?.()"]);
		view.url = "https://one.test/next";
		view.emit("did-navigate");
		assert.equal(browser.props.tabs[0].url, "https://one.test/next", "hidden navigation stays with its guest");
		assert.equal(browser.reports.at(-1).visible, false);
		resolvePick({ selector: "#stale", html: "<p>stale</p>", text: "stale" });
		browser.props.selectTick += 1;
		browser.render();
		browser.props.visible = true;
		assert.deepEqual(webviews(), original);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(picks, [], "a hidden pick cannot append to the prompt later");
		assert.equal(scripts.length, 2, "a picker request made while hidden cannot replay on show");
		assert.equal(browser.reports.at(-1).tabs[0].webContentsId, 10);
		browser.props.reporting = false;
		browser.props.visible = false;
		const reports = browser.reports.length;
		browser.render();
		view.emit("dom-ready");
		browser.unmount();
		assert.equal(browser.reports.length, reports, "a retained background guest cannot replace the window's report");
	});
	await check("browser agent Problems contain only the current live origin while the UI keeps earlier history", () => {
		const browser = browserHarness();
		const view = browser.views.get("one");
		view.url = "https://unapproved.test/account";
		view.emit("console-message", { level: 3, message: "Prior remote account private-value", sourceId: "https://unapproved.test/app.js" });
		view.url = "http://localhost:5173/";
		view.emit("console-message", { level: 3, message: "Current development failure", sourceId: "http://localhost:5173/app.js" });
		browser.props.onProblem("one", { kind: "console", message: "Same-origin source only", source: "http://localhost:5173/source.js" });
		browser.props.onProblem("one", { kind: "console", message: "Unknown origin private-value" });
		browser.props.onProblem("one", { kind: "console", message: "Other source private-value", source: "https://unapproved.test/source.js" });
		browser.render();
		const reported = () => browser.reports.at(-1).tabs.find((tab) => tab.id === "one").problems;
		assert.ok(reported().includes("Current development failure"));
		assert.ok(reported().includes("Same-origin source only"));
		assert.ok(!reported().includes("private-value"), "earlier, other-origin and unidentifiable evidence does not cross a site grant");
		assert.ok(browser.problems("one").some((entry) => entry.message.includes("Prior remote account private-value")), "the UI history is unchanged");
		view.getURL = () => { throw new Error("Guest not ready"); };
		view.emit("dom-ready");
		assert.ok(!reported().includes("Current development failure"), "a stale tab URL cannot establish the live consent origin");
		browser.unmount();
	});
	await check("browser diagnostics bound real console events to 100 entries and 500 message characters", () => {
		const browser = browserHarness();
		for (let index = 0; index < 105; index++) {
			browser.views.get("one").emit("console-message", { level: 3, message: `Problem ${index}: ${"x".repeat(700)}`, sourceId: "https://one.test/app.js", line: 9 });
		}
		const entries = browser.problems("one");
		assert.equal(entries.length, 100);
		assert.ok(entries[0].message.startsWith("Problem 5:"), "the oldest five entries are discarded");
		assert.ok(entries.at(-1).message.startsWith("Problem 104:"));
		assert.ok(entries.every((entry) => entry.message.length <= 500));
		browser.unmount();
	});
	await check("browser diagnostics count duplicate warnings and ignore informational messages and cancelled loads", () => {
		const browser = browserHarness();
		const view = browser.views.get("one");
		for (const level of [0, 1, "info", "debug"]) {
			view.emit("console-message", { level, message: "Informational output" });
		}
		view.emit("did-fail-load", { errorCode: -3, errorDescription: "ERR_ABORTED", validatedURL: "https://one.test/aborted?secret=yes#private" });
		assert.equal(browser.problems("one").length, 0);
		for (let index = 0; index < 3; index++) {
			view.emit("console-message", { level: 2, message: "A warning", sourceId: "https://one.test/app.js", line: 42 });
		}
		assert.equal(browser.problems("one").length, 1);
		assert.equal(browser.problems("one")[0].count, 3);
		assert.equal(browser.problems("one")[0].level, "warning");
		assert.equal(browser.problems("one")[0].line, 42);
		view.emit("console-message", { level: "error", message: "A modern error", sourceId: "https://one.test/modern.js", lineNumber: 12 });
		assert.equal(browser.problems("one").length, 2);
		assert.equal(browser.problems("one")[1].level, "error");
		assert.equal(browser.problems("one")[1].line, 12);
		const problemsButton = findNode(browser.render(), (node) => node.type === "button" && node.props["aria-label"] === "Problems for One");
		assert.ok(problemsButton);
		problemsButton.props.onClick();
		const panel = findNode(browser.render(), (node) => node.props["aria-label"] === "Browser problems");
		assert.ok(panel);
		assert.ok(textOf(panel).includes("×3"), "the repeated warning displays its occurrence count");
		assert.equal(findNodes(panel, (node) => node.type === "li").length, 2, "duplicates share one row");
		browser.unmount();
	});
	await check("browser diagnostics cap a 200,000-character console line before cleaning URLs", () => {
		const browser = browserHarness();
		const prefix = "Fetch failed: https://user:secret";
		const suffix = "@one.test/api after input cap";
		const message = prefix + "x".repeat(200_000 - prefix.length - suffix.length) + suffix;
		browser.views.get("one").emit("console-message", { level: 3, message });
		assert.equal(browser.problems("one")[0].message, "Fetch failed: [omitted URL]");
		browser.unmount();
	});
	await check("browser diagnostics strip URL secrets and omit body, header and cookie fields", () => {
		const browser = browserHarness();
		const event = {
			level: 3, message: "Fetch failed at https://one.test/api?messageToken=secret#private", sourceId: "https://user:password@one.test/app.js?sourceToken=secret#private", line: 7,
		};
		for (const field of ["requestBody", "responseBody", "headers", "cookies"]) {
			Object.defineProperty(event, field, { get() { throw new Error(`Read forbidden field ${field}`); }, enumerable: true });
		}
		browser.views.get("one").emit("console-message", event);
		const entry = browser.problems("one")[0];
		assert.equal(entry.source, "https://one.test/app.js");
		assert.equal(entry.url, "https://one.test/page");
		assert.ok(entry.message.includes("https://one.test/api"));
		const stored = JSON.stringify(entry);
		for (const secret of ["messageToken", "sourceToken", "session=", "private", "password", "requestBody", "responseBody", "headers", "cookies"]) {
			assert.ok(!stored.includes(secret), `${secret} is absent from stored diagnostics`);
		}
		findNode(browser.render(), (node) => node.props["aria-label"] === "Problems for One").props.onClick();
		findNode(browser.render(), (node) => node.type === "button" && node.props.children === "Add to prompt").props.onClick();
		assert.equal(browser.appended.length, 1);
		assert.ok(browser.appended[0].startsWith("Browser diagnostics\nPage: https://one.test/page\nCaptured: "));
		assert.match(browser.appended[0], /Captured: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n\n/);
		assert.ok(browser.appended[0].includes("https://one.test/app.js:7"));
		for (const secret of ["messageToken", "sourceToken", "session=", "private", "password", "requestBody", "responseBody", "headers", "cookies"]) {
			assert.ok(!browser.appended[0].includes(secret), `${secret} is absent from prompt text`);
		}
		browser.unmount();
	});
	await check("browser diagnostics strip bare endpoint, query-only and fragment-only secrets before storing or appending", () => {
		const browser = browserHarness();
		for (const target of ["api?access_token=example-secret#private", "?access_token=query-secret#query-fragment", "#fragment-secret", "https:\\/\\/one.test\\/api?escaped-secret#escaped-private"]) {
			browser.views.get("one").emit("console-message", { level: 3, message: `Request failed: ${target}`, sourceId: "source.js?source-secret#source-private", line: 1 });
		}
		const stored = JSON.stringify(browser.problems("one"));
		assert.ok(browser.problems("one").length > 0);
		for (const secret of ["access_token", "example-secret", "query-secret", "query-fragment", "fragment-secret", "escaped-secret", "escaped-private", "source-secret", "source-private"]) {
			assert.ok(!stored.includes(secret), `${secret} is absent from stored relative URL diagnostics`);
		}
		findNode(browser.render(), (node) => node.props["aria-label"] === "Problems for One").props.onClick();
		findNode(browser.render(), (node) => node.type === "button" && node.props.children === "Add to prompt").props.onClick();
		assert.equal(browser.appended.length, 1);
		for (const secret of ["access_token", "example-secret", "query-secret", "query-fragment", "fragment-secret", "escaped-secret", "escaped-private", "source-secret", "source-private"]) {
			assert.ok(!browser.appended[0].includes(secret), `${secret} is absent from the appended prompt`);
		}
		browser.unmount();
	});
	await check("browser diagnostics route network failures by guest id and retain earlier problems across navigation", () => {
		const browser = browserHarness();
		browser.network({ webContentsId: 999, url: "https://outside.test/", message: "Unrelated failure", at: 1711111111111 });
		assert.equal(browser.problems("one").length + browser.problems("two").length, 0);
		browser.network({ webContentsId: 11, url: "https://two.test/api?networkToken=secret#private", message: "HTTP 503", at: 1711111111111, headers: "header-secret", body: "body-secret", cookies: "cookie-secret" });
		assert.equal(browser.problems("one").length, 0);
		assert.equal(browser.problems("two").length, 1);
		assert.equal(browser.problems("two")[0].url, "https://two.test/api");
		assert.ok(!JSON.stringify(browser.problems("two")).includes("secret"));
		browser.views.get("one").emit("did-fail-load", { errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED", validatedURL: "https://one.test/missing?loadToken=secret#private" });
		assert.equal(browser.problems("one").length, 1);
		assert.equal(browser.problems("one")[0].url, "https://one.test/missing");
		browser.views.get("one").url = "https://one.test/next?navigationToken=secret#private";
		browser.views.get("one").emit("did-navigate", { isMainFrame: true, url: browser.views.get("one").url });
		const entries = browser.problems("one");
		assert.equal(entries.length, 2);
		assert.equal(entries[0].kind, "load");
		assert.equal(entries[1].kind, "navigation");
		assert.ok(entries[1].message.toLowerCase().includes("navigated to"));
		assert.ok(!JSON.stringify(entries).includes("secret"));
		assert.equal(browser.problems("two").length, 1, "another tab's log is retained independently");
		browser.unmount();
		assert.equal(browser.unsubscribed(), 1);
		assert.ok([...browser.views.values()].every((view) => view.listeners.size === 0), "unmount removes webview diagnostics listeners");
	});
	await check("browser diagnostics Clear affects only its tab and Add to prompt uses that tab's evidence", () => {
		const browser = browserHarness();
		browser.views.get("one").emit("console-message", { level: 3, message: "First tab failure", sourceId: "https://one.test/a.js", line: 1 });
		browser.views.get("two").emit("console-message", { level: 2, message: "Second tab warning", sourceId: "https://two.test/b.js", line: 2 });
		findNode(browser.render(), (node) => node.props["aria-label"] === "Problems for Two").props.onClick();
		findNode(browser.render(), (node) => node.type === "button" && node.props.children === "Add to prompt").props.onClick();
		assert.equal(browser.appended.length, 1);
		assert.ok(browser.appended[0].includes("Page: https://two.test/"));
		assert.ok(browser.appended[0].includes("Second tab warning"));
		assert.ok(!browser.appended[0].includes("First tab failure"));
		findNode(browser.render(), (node) => node.type === "button" && node.props.children === "Clear").props.onClick();
		assert.equal(browser.problems("two").length, 0);
		assert.equal(browser.problems("one").length, 1);
		browser.unmount();
	});
	if (failed > 0) {
		console.log(`${failed} check(s) failed`);
		process.exit(1);
	}
	console.log("All terminal and browser checks passed");
})();
