const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const states = [];
const effects = [];
const storage = new Map();
const listeners = new Map();
const intervals = new Map();
let intervalId = 0;
let now = Date.now();
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
const confirmModule = { exports: {} };
const source = transformSync(fs.readFileSync(path.join(__dirname, "../src/Sidebar.tsx"), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
const confirmSource = transformSync(fs.readFileSync(path.join(__dirname, "../src/confirm.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const context = vm.createContext({
	require: (name) => name === "react" ? react : name === "./confirm" ? confirmModule.exports : { jsx, jsxs: jsx, Fragment: "fragment" },
	localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
	Date: class extends Date { static now() { return now; } },
	setInterval: (run, delay) => { const id = ++intervalId; intervals.set(id, { run, delay }); return id; },
	clearInterval: (id) => intervals.delete(id),
	window: {
		innerHeight: 1000, innerWidth: 1400, confirm: () => confirmed,
		addEventListener: (name, listener) => listeners.set(name, listener),
		removeEventListener: (name, listener) => { if (listeners.get(name) === listener) { listeners.delete(name); } },
	},
});
vm.runInContext(`(function(module, exports) {\n${confirmSource}\n})`, context)(confirmModule, confirmModule.exports);
vm.runInContext(`(function(module, exports) {\n${source}\n})`, context)(loaded, loaded.exports);
let confirmed = true;
const sessions = [
	{ id: "first", title: "First chat", folder: "C:/project", project: "Project", branch: "main", environment: "Local", status: "idle", pinned: true, archived: false, createdAt: now - 5 * 60000 },
	{ id: "second", title: "Second chat", folder: "C:/project", project: "Project", branch: "feature/sidebar", worktreeFolder: "C:/project-worktree", environment: "Local", status: "idle", pinned: false, archived: false, lastActivityAt: now - 3 * 60 * 60000 },
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
	update: null, onUpdate: () => calls.push("update"), recentUsd: null,
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
const ago = loaded.exports.ago;
assert.equal(ago(now - 30000, now), "now");
assert.equal(ago(now - 5 * 60000, now), "5m");
assert.equal(ago(now - 3 * 60 * 60000, now), "3h");
assert.equal(ago(now - 2 * 24 * 60 * 60000, now), new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(now - 2 * 24 * 60 * 60000));
assert.equal(ago(now - 10 * 24 * 60 * 60000, now), new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(now - 10 * 24 * 60 * 60000));
assert.equal(findAll(tree, (node) => node.type === "small" && text(node) === "Needs you").length, 2, "pinned and project rows display live approvals despite idle stored status");
props.activity = {};
tree = render();
assert.equal(findAll(tree, (node) => node.type === "small" && text(node) === "Needs you").length, 0, "resolved approvals clear their row badge");
assert.deepEqual(findAll(tree, (node) => node.props?.className === "session-meta").map(text), ["5m", "feature/sidebar · 3h"], "plain rows show time, and worktree rows also show the branch");
assert.ok(findAll(tree, (node) => node.props?.className === "session-hit")[0].props.title.endsWith(new Date(sessions[0].createdAt).toLocaleString()), "row hover includes the exact activity date");
assert.equal(intervals.size, 1, "sidebar has one label refresh interval");
assert.equal([...intervals.values()][0].delay, 60000);
now += 60000;
[...intervals.values()][0].run();
tree = render();
assert.equal(text(findAll(tree, (node) => node.props?.className === "session-meta")[0]), "6m", "activity labels refresh while the sidebar stays open");
const scroller = findAll(tree, (node) => node.props?.className === "session-scroll")[0];
let focused = 0;
let prevented = 0;
const buttons = [0, 1].map((index) => ({ matches: (selector) => selector === "button.session-hit", focus: () => { focused = index; } }));
const key = (value, target = buttons[focused]) => scroller.props.onKeyDown({ key: value, target, currentTarget: { querySelectorAll: () => buttons }, preventDefault: () => { prevented++; } });
key("ArrowUp");
assert.equal(focused, 0, "ArrowUp stops at the first row");
key("ArrowDown");
assert.equal(focused, 1, "ArrowDown focuses the next row");
key("ArrowDown");
assert.equal(focused, 1, "ArrowDown stops at the last row");
key("ArrowUp");
assert.equal(focused, 0, "ArrowUp focuses the previous row");
assert.equal(prevented, 4);
key("x");
key("ArrowDown", { matches: () => false });
assert.equal(prevented, 4, "other keys and rename inputs keep their own keyboard behavior");
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
async function checkActions() {
	rowMenu();
	menuButton("Mark as unread").props.onClick();
	rowMenu();
	menuButton("Mark as completed").props.onClick();
	rowMenu();
	confirmed = false;
	menuButton("Delete").props.onClick();
	await Promise.resolve();
	assert.deepEqual(calls, ["unread:second:true", "completed:second:true"], "cancelling Delete keeps the selected session");
	rowMenu();
	confirmed = true;
	menuButton("Delete").props.onClick();
	assert.deepEqual(calls, ["unread:second:true", "completed:second:true"], "Delete waits for its confirmation answer");
	await Promise.resolve();
	assert.deepEqual(calls, ["unread:second:true", "completed:second:true", "delete:second"], "row actions reach App, and Delete asks first");
	calls.length = 0;
	props.activity = { second: "running" };
	rowMenu();
	menuButton("Delete").props.onClick();
	await Promise.resolve();
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
	props.update = { latest: "0.2.1" };
	tree = render();
	const account = findAll(tree, (node) => node.props?.className === "account-btn")[0];
	assert.equal(account.props["aria-label"], "Account and settings, version 0.2.1 available");
	assert.equal(findAll(tree, (node) => node.props?.className === "update-flag")[0].props.children.join(""), "Update available · 0.2.1");
	account.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 900, left: 10 }) } });
	tree = render();
	const accountMenu = findAll(tree, (node) => node.props?.className === "row-pop account-menu")[0];
	const updateAction = findAll(accountMenu, (node) => node.type === "button")[0];
	assert.equal(updateAction.props.children.join(""), "Update to 0.2.1…", "update is the first account action");
	updateAction.props.onClick();
	tree = render();
	assert.equal(calls.at(-1), "update");
	assert.equal(findAll(tree, (node) => node.props?.className === "row-pop account-menu").length, 0, "the account menu closes before opening the update");
	props.update = null;
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "account-btn")[0].props["aria-label"], "Account and settings");
	assert.equal(findAll(tree, (node) => node.props?.className === "update-flag").length, 0);
	effects.forEach((effect) => effect?.cleanup?.());
	assert.equal(listeners.has("storage"), false, "the shared-section listener is removed on cleanup");
	assert.equal(intervals.size, 0, "activity refresh stops on cleanup");
	console.log("Sidebar row actions passed: unread, completed, delete with confirm, Ctrl+click window, sections.");
	console.log("Sidebar regressions passed: live approval badges, selected new-window identity, cross-window sections.");
	console.log("Sidebar activity passed: relative labels, worktree branch, minute refresh, arrow focus and cleanup.");
}

void checkActions().catch((error) => { console.error(error); process.exitCode = 1; });
