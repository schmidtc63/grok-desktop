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
	const { lexMarkdown, mathHtml } = env.load("markdown-math.ts");
	const formulas = (source) => lexMarkdown(source).math.map(({ display, tex }) => ({ display, tex }));
	const prices = lexMarkdown("It costs $5 and $10");
	assert.equal(prices.math.length, 0, "dollar amounts stay text");
	assert.equal(prices.tokens[0].tokens[0].text, "It costs $5 and $10");
	const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
	same(formulas("Use $x$ here"), [{ display: false, tex: "x" }]);
	assert.equal(formulas("$x$2").length, 0, "a closing dollar followed by a digit stays text");
	assert.equal(formulas("$ x$ and $x $").length, 0, "spaces beside the dollars stay text");
	same(formulas("$$y+1$$"), [{ display: true, tex: "y+1" }]);
	same(formulas("$$\nx\n$$"), [{ display: true, tex: "\nx\n" }]);
	same(formulas("$$\nx\n\n- y\n$$"), [{ display: true, tex: "\nx\n\n- y\n" }]);
	assert.equal(formulas("$$x").length, 0, "an unclosed display formula stays text");
	assert.equal(formulas("$$x$").length, 0, "a display formula waits for its closing pair");
	same(formulas("\\(a+b\\)"), [{ display: false, tex: "a+b" }]);
	same(formulas("\\[c\\]"), [{ display: true, tex: "c" }]);
	assert.equal(formulas("\\(a").length, 0);
	same(formulas("use `$5` and $x$"), [{ display: false, tex: "x" }]);
	assert.equal(formulas("```\n$x$\n```\n").length, 0, "a code block keeps its dollars");
	assert.equal(formulas("    $x$\n").length, 0, "an indented code block keeps its dollars");
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

	const probabilityTable = "| Formula | Value |\n| --- | --- |\n| $P(A|B)$ | 0.5 |";
	same(formulas(probabilityTable), [{ display: false, tex: "P(A|B)" }]);
	const tableCells = env.walk(Markdown({ text: probabilityTable })).filter((node) => node.type === "td");
	assert.equal(tableCells.length, 2, "a formula pipe stays inside its table cell");
	assert.ok(env.walk(tableCells[0]).some((node) => node.props.dangerouslySetInnerHTML?.__html?.includes("katex")), "the table formula renders");
	assert.equal(env.textOf(tableCells[1]), "0.5", "the second table cell retains its value");

	const nestedCode = ["Write-Output '$x$'", "@'", "```", "$inside$", "```", probabilityTable, "'@"].join("\n");
	const nestedMarkdown = [
		"> - Example", ">", ">   ````powershell",
		...nestedCode.split("\n").map((line) => `>   ${line}`),
		">   ````", "", "Math $y$.",
	].join("\n");
	let copiedCode;
	let runCode;
	const nested = env.walk(Markdown({
		text: nestedMarkdown,
		onCopy(value) { copiedCode = value; },
		onRun(value) { runCode = value; },
	}));
	nested.find((node) => node.type === "button" && node.props.children === "Copy").props.onClick();
	nested.find((node) => node.type === "button" && node.props.children === "Run").props.onClick();
	assert.equal(copiedCode, nestedCode, "Copy preserves a fenced block inside a quote and list");
	assert.equal(runCode, nestedCode, "Run preserves the same fenced block");
	assert.ok(nested.some((node) => node.props.dangerouslySetInnerHTML?.__html?.includes("katex")), "math still renders beside nested code");

	const deepTex = `$${"{".repeat(3000)}x${"}".repeat(3000)}$`;
	const withDeepMath = Markdown({ text: `Before ${deepTex} after\n\n**Next message content**` });
	assert.ok(env.textOf(withDeepMath).includes(`Before ${deepTex} after`), "deep TeX falls back to its source text");
	assert.ok(env.walk(withDeepMath).some((node) => node.type === "strong" && env.textOf(node) === "Next message content"), "Markdown after deep TeX still renders");

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
	assert.ok(shown.some((node) => node.type === "iframe" && node.props.sandbox === "" && node.props.srcDoc.includes("<svg")));
	assert.equal(shown.find((node) => node.type === "iframe").props.style.colorScheme, "light", "the diagram frame keeps its transparent background in dark and light themes");
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
