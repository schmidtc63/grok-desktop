const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

const { outputFiles } = buildSync({
	stdin: {
		contents: 'export { Customize } from "./src/Customize"; export { SavedPromptsSettings } from "./src/SavedPromptsSettings"; export { settingsKey } from "./src/Settings"; export { setConfirmHost } from "./src/confirm";',
		resolveDir: path.resolve(__dirname, ".."),
	},
	bundle: true, write: false, format: "cjs", jsx: "automatic", external: ["react"],
});
const states = [];
let cursor = 0;
let effects = [];
const react = {
	lazy: () => () => null,
	useState(initial) {
		const index = cursor++;
		if (!(index in states)) { states[index] = typeof initial === "function" ? initial() : initial; }
		return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
	},
	useRef(initial) { return states[cursor++] ??= { current: initial }; },
	useEffect(run, dependencies) {
		const index = cursor++;
		if (!states[index] || dependencies.some((value, offset) => value !== states[index][offset])) {
			states[index] = dependencies;
			effects.push(run);
		}
	},
};
const jsx = (type, props) => ({ type, props });
function find(node, label) {
	if (!node || typeof node !== "object") { return undefined; }
	if (Array.isArray(node)) {
		for (const child of node) {
			const match = find(child, label);
			if (match) { return match; }
		}
		return undefined;
	}
	if (typeof node.type === "function") { return find(node.type(node.props), label); }
	return node.props["aria-label"] === label ? node : find(node.props.children, label);
}
const storage = new Map();
const inventory = { ok: true, plugins: [
	{ name: "Installed tool", marketplace: "Market", installed: true, enabled: true },
	{ name: "Available tool", marketplace: "Market", installed: false, enabled: true },
] };
const moduleUnderTest = { exports: {} };
vm.runInNewContext(outputFiles[0].text, {
	module: moduleUnderTest, exports: moduleUnderTest.exports,
	require(name) {
		if (name === "react") { return react; }
		assert.equal(name, "react/jsx-runtime");
		return { jsx, jsxs: jsx, Fragment: "fragment" };
	},
	window: { grokCode: { customize: async () => inventory } },
	localStorage: { getItem: (key) => storage.get(key) ?? null },
});
const { Customize, SavedPromptsSettings, settingsKey, setConfirmHost } = moduleUnderTest.exports;
function render(Component, props) {
	cursor = 0;
	effects = [];
	const tree = Component(props);
	for (const run of effects) { run(); }
	return tree;
}

async function check() {
	const props = { view: "plugins", folder: "", live: [], onRun() {} };
	render(Customize, props);
	await new Promise(setImmediate);
	let tree = render(Customize, props);
	assert.equal(find(find(tree, "Details for Installed tool"), "On").props.className, "ct-dot on");
	find(tree, "Discover").props.onClick();
	tree = render(Customize, props);
	const available = find(tree, "Details for Available tool");
	assert.ok(available);
	assert.equal(find(available, "On"), undefined);
	assert.equal(find(available, "Off"), undefined);
	console.log("PASS Discover plugins: available plugins have no status dot");

	states.length = 0;
	const remove = { id: "remove", name: "Remove", text: "Remove this." };
	const keep = { id: "keep", name: "Keep", text: "Before edit." };
	const edited = { ...keep, text: "Edited in another window." };
	const added = { id: "added", name: "Added", text: "Added in another window." };
	const save = (savedPrompts) => storage.set(settingsKey, JSON.stringify({ savedPrompts }));
	save([remove, keep]);
	let confirm;
	const unsubscribe = setConfirmHost((pending) => { confirm = pending.resolve; });
	tree = render(SavedPromptsSettings, { prompts: [remove, keep], onChange: save });
	find(tree, "Delete Remove").props.onClick();
	save([remove, edited, added]);
	confirm(true);
	await Promise.resolve();
	unsubscribe();
	assert.deepEqual(JSON.parse(storage.get(settingsKey)).savedPrompts, [edited, added], "delete preserves additions and edits even before a storage event reaches the renderer");
	console.log("PASS saved prompt delete: confirmation preserves the latest prompts from another window");
}

void check().catch((error) => { console.error(error); process.exitCode = 1; });
