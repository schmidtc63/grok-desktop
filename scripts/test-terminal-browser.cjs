const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const jsx = (type, props) => ({ type, props: props ?? {} });
const react = {
	createElement: (type, props) => ({ type, props: props ?? {} }),
	useEffect() {},
	useLayoutEffect() {},
	useMemo: (fn) => fn(),
	useRef: (current) => ({ current }),
	useState: (initial) => [initial, () => {}],
};

function load(name) {
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
		throw new Error(`Unexpected import ${id}`);
	};
	vm.runInNewContext(source, { require: imports, module, exports: module.exports, URL }, { filename: file });
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
			this.innerText = localName;
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
	second.innerText = "y".repeat(800);
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
		assert.equal(picked.text.length, 500);
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
	if (failed > 0) {
		console.log(`${failed} check(s) failed`);
		process.exit(1);
	}
	console.log("All terminal and browser checks passed");
})();
