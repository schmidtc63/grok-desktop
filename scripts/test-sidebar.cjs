const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const states = [];
const effects = [];
const storage = new Map();
const listeners = new Map();
let cursor = 0;
let effectCursor = 0;
let pendingEffects = [];
const jsx = (type, props) => ({ type, props: props || {} });
const react = {
	useEffect(run, dependencies) {
		const index = effectCursor++;
		const previous = effects[index];
		if (!previous || dependencies.some((value, offset) => value !== previous.dependencies[offset])) {
			pendingEffects.push(() => {
				previous?.cleanup?.();
				effects[index] = { dependencies, cleanup: run() };
			});
		}
	},
	useState(initial) {
		const index = cursor++;
		if (!(index in states)) { states[index] = typeof initial === "function" ? initial() : initial; }
		return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
	},
};
const loaded = { exports: {} };
const source = transformSync(fs.readFileSync(path.join(__dirname, "../src/Sidebar.tsx"), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
vm.runInNewContext(source, {
	module: loaded,
	exports: loaded.exports,
	require: (name) => name === "react" ? react : { jsx, jsxs: jsx, Fragment: "fragment" },
	localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
	window: {
		innerHeight: 1000, innerWidth: 1400, confirm: () => confirmed,
		addEventListener: (name, listener) => listeners.set(name, listener),
		removeEventListener: (name, listener) => { if (listeners.get(name) === listener) { listeners.delete(name); } },
	},
});
let confirmed = true;
const sessions = [
	{ id: "first", title: "First chat", folder: "C:/project", project: "Project", branch: "main", environment: "Local", status: "idle", pinned: true, archived: false },
	{ id: "second", title: "Second chat", folder: "C:/project", project: "Project", branch: "main", environment: "Local", status: "idle", pinned: false, archived: false },
];
let opened;
const calls = [];
const props = {
	sessions,
	activeId: "first",
	query: "",
	activity: { first: "needs-you", second: "needs-you" },
	onQuery() {}, onSelect: (id) => calls.push(`select:${id}`), onNew() {}, onNewIn() {}, onPin() {}, onArchive() {}, onNotice: (text) => calls.push(`notice:${text}`),
	onRename: (id, title) => calls.push(`rename:${id}:${title}`), onDelete: (id) => calls.push(`delete:${id}`),
	onMarkUnread: (id, unread) => calls.push(`unread:${id}:${unread}`), onMarkCompleted: (id, done) => calls.push(`completed:${id}:${done}`),
	onMove: (id, section) => calls.push(`move:${id}:${section}`), onSettings() {}, onCollapse() {},
	onOpenWindow: (id) => { opened = id; },
};
function materialize(node) {
	if (!node || typeof node !== "object") { return node; }
	if (Array.isArray(node)) { return node.map(materialize); }
	if (typeof node.type === "function") { return materialize(node.type(node.props)); }
	return { ...node, props: { ...node.props, children: materialize(node.props.children) } };
}
function render() {
	cursor = 0;
	effectCursor = 0;
	pendingEffects = [];
	const tree = materialize(loaded.exports.Sidebar(props));
	pendingEffects.forEach((run) => run());
	return tree;
}
function findAll(node, predicate, found = []) {
	if (!node || typeof node !== "object") { return found; }
	if (Array.isArray(node)) { node.forEach((value) => findAll(value, predicate, found)); return found; }
	if (predicate(node)) { found.push(node); }
	findAll(node.props?.children, predicate, found);
	return found;
}
function text(node) {
	if (typeof node === "string") { return node; }
	if (Array.isArray(node)) { return node.map(text).join(" "); }
	return node?.props ? text(node.props.children) : "";
}
let tree = render();
assert.equal(findAll(tree, (node) => node.type === "small" && text(node) === "Needs you").length, 2, "pinned and project rows display live approvals despite idle stored status");
props.activity = {};
tree = render();
assert.equal(findAll(tree, (node) => node.type === "small" && text(node) === "Needs you").length, 0, "resolved approvals clear their row badge");
const secondRow = findAll(tree, (node) => node.props?.onContextMenu && text(node).includes("Second chat"))[0];
assert.ok(secondRow);
secondRow.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 30 }) } });
tree = render();
const openButton = findAll(tree, (node) => node.type === "button" && text(node) === "Open in a new window")[0];
assert.ok(openButton);
openButton.props.onClick();
assert.equal(opened, "second", "new-window action forwards its selected chat rather than the active chat");
const rowMenu = () => {
	tree = render();
	findAll(tree, (node) => node.props?.onContextMenu && text(node).includes("Second chat"))[0].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 30 }) } });
	tree = render();
};
const menuButton = (label) => findAll(tree, (node) => node.type === "button" && text(node).startsWith(label))[0];
rowMenu();
menuButton("Mark as unread").props.onClick();
rowMenu();
menuButton("Mark as completed").props.onClick();
rowMenu();
confirmed = false;
menuButton("Delete").props.onClick();
rowMenu();
confirmed = true;
menuButton("Delete").props.onClick();
assert.deepEqual(calls, ["unread:second:true", "completed:second:true", "delete:second"], "row actions reach App, and Delete asks first");
calls.length = 0;
props.activity = { second: "running" };
rowMenu();
menuButton("Delete").props.onClick();
assert.deepEqual(calls, ["notice:Stop this session before deleting it."], "a working session cannot be deleted");
props.activity = {};
calls.length = 0;
tree = render();
findAll(tree, (node) => node.type === "button" && node.props.className === "session-hit" && text(node).includes("Second chat"))[0].props.onClick({ ctrlKey: true });
assert.equal(opened, "second", "Ctrl+click opens the session in a new window");
assert.deepEqual(calls, [], "Ctrl+click does not also select it here");
rowMenu();
menuButton("Move to section").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, right: 200, bottom: 30 }) } });
tree = render();
menuButton("New section").props.onClick();
assert.match(calls.at(-1), /^move:second:sec-\d+$/, "New section from a row moves that session into it");
tree = render();
assert.ok(findAll(tree, (node) => node.props?.["aria-label"] === "Section name").length === 1, "a new section opens for naming");
const sessionsWithSection = sessions.map((item) => item.id === "second" ? { ...item, sectionId: calls.at(-1).split(":")[2] } : item);
props.sessions = sessionsWithSection;
tree = render();
findAll(tree, (node) => node.props?.["aria-label"] === "Section name")[0].props.onBlur({ target: { value: "Reviews" } });
tree = render();
assert.ok(findAll(tree, (node) => node.props?.className === "group-label" && text(node) === "Reviews").length === 1, "a renamed section groups its sessions");
storage.set("grok-code.sections.v1", JSON.stringify([{ id: "shared", name: "Shared reviews" }]));
listeners.get("storage")({ key: "grok-code.sections.v1" });
props.sessions = sessions.map((item) => item.id === "second" ? { ...item, sectionId: "shared" } : item);
tree = render();
assert.ok(findAll(tree, (node) => node.props?.className === "group-label" && text(node) === "Shared reviews").length === 1, "another window's sections reach this sidebar");
rowMenu();
menuButton("Move to section").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, right: 200, bottom: 30 }) } });
tree = render();
menuButton("New section").props.onClick();
render();
assert.ok(JSON.parse(storage.get("grok-code.sections.v1")).some((section) => section.id === "shared"), "adding a section preserves the other window's section");
effects.forEach((effect) => effect?.cleanup?.());
assert.equal(listeners.has("storage"), false, "the shared-section listener is removed on cleanup");
console.log("Sidebar row actions passed: unread, completed, delete with confirm, Ctrl+click window, sections.");
console.log("Sidebar regressions passed: live approval badges, selected new-window identity, cross-window sections.");
