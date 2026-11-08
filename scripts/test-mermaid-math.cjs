const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function loadSource() {
	const modules = new Map();
	const jsx = (type, attributes, key) => ({ type, props: attributes ?? {}, key });
	const react = {
		Fragment: "fragment",
		createElement: (type, attributes, ...children) => jsx(type, { ...attributes, children: children.length > 1 ? children : children[0] }),
		useState(initial) {
			const index = react.cursor++;
			if (!react.hooks[index]) { react.hooks[index] = { value: typeof initial === "function" ? initial() : initial }; }
			return [react.hooks[index].value, (update) => {
				const value = typeof update === "function" ? update(react.hooks[index].value) : update;
				if (!Object.is(react.hooks[index].value, value)) { react.hooks[index].value = value; react.dirty = true; }
			}];
		},
		useEffect(run, dependencies) {
			const index = react.cursor++;
			const previous = react.hooks[index];
			if (!previous || !dependencies || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
				react.effects.push(() => { previous?.cleanup?.(); react.hooks[index] = { dependencies, cleanup: run() }; });
			}
		},
		hooks: [],
		cursor: 0,
		effects: [],
		dirty: false,
	};
	const documentElement = {
		theme: "dark",
		getAttribute(name) { return name === "data-theme" ? this.theme : null; },
	};
	const bodyChildren = new Set();
	const document = {
		documentElement,
		body: { append(node) { bodyChildren.add(node); } },
		createElement() {
			return { style: {}, children: [], append(child) { this.children.push(child); }, remove() { bodyChildren.delete(this); } };
		},
	};
	const windowMock = {
		document,
		matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
	};
	function load(fileName) {
		if (modules.has(fileName)) { return modules.get(fileName); }
		const file = path.join(__dirname, "..", "src", fileName);
		const source = transformSync(fs.readFileSync(file, "utf8"), { loader: fileName.endsWith(".tsx") ? "tsx" : "ts", format: "cjs", jsx: "automatic" }).code;
		const module = { exports: {} };
		const imports = (id) => {
			if (id === "react") { return react; }
			if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
			if (id.endsWith(".css")) { return {}; }
			if (id === "./data") { return { PLATFORM: "win32" }; }
			if (id === "./markdown-math") { return load("markdown-math.ts"); }
			if (id === "./markdown-diagram") { return load("markdown-diagram.ts"); }
			if (!id.startsWith("./")) { return require(id); }
			throw new Error(`Unexpected import ${id}`);
		};
		vm.runInNewContext(source, {
			require: imports, module, exports: module.exports, document: windowMock.document, window: windowMock,
		}, { filename: file });
		modules.set(fileName, module.exports);
		return module.exports;
	}
	function walk(node, found = []) {
		if (!node || typeof node !== "object") { return found; }
		if (Array.isArray(node)) { node.forEach((child) => walk(child, found)); return found; }
		if (node.props) { found.push(node); walk(node.props.children, found); }
		return found;
	}
	function textOf(node) {
		if (node === null || node === undefined || typeof node === "boolean") { return ""; }
		if (typeof node === "string" || typeof node === "number") { return String(node); }
		if (Array.isArray(node)) { return node.map(textOf).join(""); }
		if (typeof node.type === "function") { return textOf(node.type(node.props)); }
		return textOf(node.props?.children);
	}
	return { load, react, walk, textOf, documentElement, document, bodyChildren };
}

function mount(env, Component, props) {
	let current = props;
	const render = () => {
		let tree;
		for (let pass = 0; pass < 20; pass += 1) {
			env.react.cursor = 0;
			env.react.effects = [];
			env.react.dirty = false;
			tree = Component(current);
			for (const effect of env.react.effects) { effect(); }
			if (!env.react.dirty) { return tree; }
		}
		throw new Error("diagram render did not settle");
	};
	return {
		render,
		setProps(next) { current = next; env.react.hooks = []; },
	};
}

async function settle(view) {
	for (let pass = 0; pass < 8; pass += 1) {
		view.render();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

module.exports = async function mermaidMathChecks() {
	const env = loadSource();
	const { stashMath, mathHtml } = env.load("markdown-math.ts");
	const prices = stashMath("It costs $5 and $10");
	assert.equal(prices.math.length, 0, "dollar amounts stay text");
	assert.equal(prices.text, "It costs $5 and $10");
	const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
	same(stashMath("Use $x$ here").math, [{ display: false, tex: "x" }]);
	assert.equal(stashMath("$x$2").math.length, 0, "a closing dollar followed by a digit stays text");
	assert.equal(stashMath("$ x$ and $x $").math.length, 0, "spaces beside the dollars stay text");
	same(stashMath("$$y+1$$").math, [{ display: true, tex: "y+1" }]);
	same(stashMath("$$\nx\n$$").math, [{ display: true, tex: "\nx\n" }]);
	assert.equal(stashMath("$$x").math.length, 0, "an unclosed display formula stays text");
	assert.equal(stashMath("$$x$").math.length, 0, "a display formula waits for its closing pair");
	same(stashMath("\\(a+b\\)").math, [{ display: false, tex: "a+b" }]);
	same(stashMath("\\[c\\]").math, [{ display: true, tex: "c" }]);
	assert.equal(stashMath("\\(a").math.length, 0);
	const coded = stashMath("use `$5` and $x$");
	same(coded.math, [{ display: false, tex: "x" }]);
	assert.ok(coded.text.includes("`$5`"), "a code span keeps its dollars");
	assert.equal(stashMath("```\n$x$\n```\n").math.length, 0, "a code block keeps its dollars");
	assert.equal(stashMath("    $x$\n").math.length, 0, "an indented code block keeps its dollars");
	const html = mathHtml("x", false);
	assert.equal(typeof html, "string");
	assert.ok(html.includes("katex"));
	assert.equal(typeof mathHtml("\\notacommand", false), "string", "a bad formula does not throw");

	const { Markdown } = env.load("Markdown.tsx");
	const rendered = Markdown({ text: "use `$5` and $x$" });
	const nodes = env.walk(rendered);
	const code = nodes.find((node) => node.type === "code");
	assert.equal(code.props.children, "$5");
	assert.equal(JSON.stringify(code).includes("katex"), false, "KaTeX stays out of the code span");
	assert.ok(nodes.some((node) => node.props.dangerouslySetInnerHTML?.__html?.includes("katex")), "inline math is drawn");

	const { fenceClosed, mermaidRuntime } = env.load("markdown-diagram.ts");
	const openRaw = "```mermaid\ngraph TD\nA-->B\n";
	const closedRaw = "```mermaid\ngraph TD\nA-->B\n```\n";
	assert.equal(fenceClosed(openRaw), false);
	assert.equal(fenceClosed(closedRaw), true);
	let draws = 0;
	let config = null;
	mermaidRuntime.load = async () => ({
		initialize(next) { config = next; },
		async render(id, source, container) {
			draws += 1;
			if (source.includes("bad")) {
				(container ?? env.document.body).append({ id: `d${id}` });
				throw new Error("draw failed");
			}
			return { svg: `<svg data-source="${source.length}"></svg>` };
		},
	});
	const { MermaidDiagram } = env.load("Markdown.tsx");
	const openView = mount(env, MermaidDiagram, { text: "graph TD\nA-->B", raw: openRaw });
	await settle(openView);
	assert.equal(draws, 0, "an open fence is not drawn");
	assert.equal(env.textOf(openView.render()).includes("This diagram could not be drawn."), false);

	env.react.hooks = [];
	const source = "graph TD\nA-->B";
	let copied = "";
	const view = mount(env, MermaidDiagram, { text: source, raw: closedRaw, onCopy(value) { copied = value; } });
	await settle(view);
	assert.equal(draws, 1, "a closed diagram is drawn once");
	assert.equal(config.startOnLoad, false);
	assert.equal(config.securityLevel, "strict");
	await settle(view);
	assert.equal(draws, 1, "rendering the same source again does not draw it");
	const shown = env.walk(view.render());
	assert.ok(shown.some((node) => node.props.dangerouslySetInnerHTML?.__html?.includes("<svg")));
	const codeButton = shown.find((node) => node.type === "button" && node.props.children === "Code");
	codeButton.props.onClick();
	const asCode = env.textOf(view.render());
	assert.ok(asCode.includes(source));
	const copyButton = env.walk(view.render()).find((node) => node.type === "button" && node.props.children === "Copy");
	copyButton.props.onClick();
	assert.equal(copied, source);

	env.react.hooks = [];
	const failed = mount(env, MermaidDiagram, { text: "bad graph", raw: "```mermaid\nbad graph\n```\n", onCopy() {} });
	await settle(failed);
	assert.equal(draws, 2);
	assert.equal(env.bodyChildren.size, 0, "a rejected diagram leaves no render container in the body");
	const failure = env.textOf(failed.render());
	assert.ok(failure.includes("This diagram could not be drawn."));
	assert.ok(failure.includes("bad graph"));
	await settle(failed);
	assert.equal(draws, 2, "a failed diagram is not drawn again");
	console.log("PASS mermaid and math: dollar rules, code spans, one draw per source, no draw before the fence, failure fallback and cleanup");
};
