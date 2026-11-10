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
	useRef(initial) {
		const index = cursor++;
		return states[index] ??= { current: initial };
	},
};
const loaded = { exports: {} };
const confirmModule = { exports: {} };
const source = transformSync(fs.readFileSync(path.join(__dirname, "../src/Sidebar.tsx"), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
const confirmSource = transformSync(fs.readFileSync(path.join(__dirname, "../src/confirm.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const dataModule = { exports: {} };
const dataSource = transformSync(fs.readFileSync(path.join(__dirname, "../src/data.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const sidebarModules = new Map([["./confirm", confirmModule], ["./data", dataModule]]);
react.useLayoutEffect = react.useEffect;
const context = vm.createContext({
	require: (name) => name === "react" ? react : sidebarModules.get(name)?.exports ?? { jsx, jsxs: jsx, Fragment: "fragment" },
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
vm.runInContext(`(function(module, exports) {\n${dataSource}\n})`, context)(dataModule, dataModule.exports);
for (const name of ["Icon", "PopupMenu"]) {
	const module = { exports: {} };
	const code = transformSync(fs.readFileSync(path.join(__dirname, `../src/${name}.tsx`), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
	vm.runInContext(`(function(module, exports) {\n${code}\n})`, context)(module, module.exports);
	sidebarModules.set(`./${name}`, module);
}
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
	chats: {},
	activeId: "first",
	query: "",
	activity: { first: "needs-you", second: "needs-you" },
	onQuery() {}, onSelect: (id, find) => calls.push(find ? `select:${id}:${find}` : `select:${id}`), onNew() {}, onNewIn() {}, onPin() {}, onArchive() {}, onNotice: (text) => calls.push(`notice:${text}`),
	onRename: (id, title) => calls.push(`rename:${id}:${title}`), onDelete: (id) => calls.push(`delete:${id}`),
	onMarkUnread: (id, unread) => calls.push(`unread:${id}:${unread}`), onMarkCompleted: (id, done) => calls.push(`completed:${id}:${done}`),
	onMove: (id, section) => calls.push(`move:${id}:${section}`), onSettings() {}, onRoutines: () => calls.push("routines"), onCollapse() {},
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
assert.equal(findAll(tree, (node) => node.props?.["aria-label"] === "New session in Project")[0].props.className, "side-icon project-add");
const search = findAll(tree, (node) => node.type === "button" && node.props["aria-label"] === "Search sessions")[0];
let searchFocused = false;
search.props.ref.current = { focus() { searchFocused = true; } };
search.props.onClick();
tree = render();
findAll(tree, (node) => node.type === "input" && node.props["aria-label"] === "Search sessions")[0].props.onKeyDown({ key: "Escape", stopPropagation() {} });
tree = render();
assert.equal(findAll(tree, (node) => node.type === "input" && node.props["aria-label"] === "Search sessions").length, 0);
assert.ok(searchFocused, "Escape returns focus to the sidebar search button");
const routinesButtons = findAll(tree, (node) => node.type === "button" && node.props["aria-label"] === "Routines");
assert.equal(routinesButtons.length, 1);
assert.equal(routinesButtons[0].props.className, "side-icon");
assert.equal(findAll(routinesButtons[0], (node) => node.type === "path" && node.props.d.startsWith("M8 2.5a5.5") && node.props.d.endsWith("2 1.3")).length, 1, "the Routines button shows the clock icon");
const tools = findAll(tree, (node) => node.props?.className === "side-tools")[0].props.children;
assert.equal(tools.indexOf(routinesButtons[0]) + 1, tools.indexOf(findAll(tree, (node) => node.type === "button" && node.props["aria-label"] === "Search sessions")[0]), "Routines sits just before the search button");
routinesButtons[0].props.onClick();
assert.deepEqual(calls.splice(0), ["routines"]);
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
function checkFailedState() {
	props.sessions = sessions.map((item) => item.id === "second" ? { ...item, failed: true, unread: true } : item);
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "dot failed").length, 1, "a failed session shows the failed dot before unread");
	assert.equal(findAll(tree, (node) => node.props?.className === "failed" && text(node) === "Stopped with an error").length, 1, "a failed row explains the error");
	props.activity = { second: "running" };
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "dot running").length, 1, "live activity takes precedence over a previous failure");
	assert.equal(findAll(tree, (node) => node.props?.className === "failed").length, 0);
	props.activity = {};
	function groupBy(label) {
		const event = { currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, right: 200, bottom: 30 }) } };
		tree = render();
		findAll(tree, (node) => node.type === "button" && node.props["aria-label"] === "Filter and group")[0].props.onClick(event);
		tree = render();
		findAll(tree, (node) => node.type === "button" && text(node).startsWith("Group by"))[0].props.onClick(event);
		tree = render();
		findAll(tree, (node) => node.props?.role === "menuitemradio" && text(node).trim() === label)[0].props.onClick();
		tree = render();
	}
	groupBy("State");
	assert.equal(findAll(tree, (node) => node.props?.className === "group-label" && text(node) === "Failed").length, 1, "state grouping includes Failed");
	assert.equal(findAll(tree, (node) => node.props?.className === "project-toggle").length, 0, "only project grouping has disclosure buttons");
	props.sessions = props.sessions.map((item) => item.id === "second" ? { ...item, completed: true } : item);
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "dot failed").length, 1, "completion keeps the failure visible");
	props.sessions = props.sessions.map((item) => item.id === "second" ? { ...item, failed: false } : item);
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "dot unread").length, 1, "completion keeps unread visible after the failure clears");
	props.sessions = props.sessions.map((item) => item.id === "second" ? { ...item, unread: false } : item);
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "dot completed").length, 1);
	assert.equal(findAll(tree, (node) => node.props?.className === "group-label" && text(node) === "Completed").length, 1);
	props.sessions = sessions;
	groupBy("Project");
	console.log("PASS sidebar state: live activity, failure, unread and completion precedence");
}
checkFailedState();

function remount() {
	effects.forEach((effect) => effect?.cleanup?.());
	effects.length = 0;
	states.length = 0;
	render();
	return render();
}

function checkProjectCollapse() {
	const toggle = () => findAll(tree, (node) => node.type === "button" && node.props.className === "project-toggle")[0];
	const rows = () => findAll(tree, (node) => node.props?.className === "session-hit");
	const dot = () => findAll(toggle(), (node) => node.props?.role === "img")[0];
	assert.equal(toggle().props["aria-expanded"], true);
	props.activity = { second: "running" };
	toggle().props.onClick();
	tree = render();
	assert.equal(toggle().props["aria-expanded"], false);
	assert.equal(rows().length, 1);
	assert.match(text(rows()[0]), /^First chat/, "pinned sessions stay visible when their project is collapsed");
	assert.equal(dot().props["aria-label"], "Working");
	assert.equal(dot().props.className, "dot running");
	props.activity = { second: "needs-you" };
	tree = render();
	assert.equal(dot().props["aria-label"], "Needs you");
	assert.equal(dot().props.className, "dot needs-you");
	const styles = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
	assert.match(styles, /\.group-head:not\(\.scheduled-head\) \.project-toggle \.dot\.needs-you\s*\{\s*border-radius: 0;\s*transform: rotate\(45deg\);/, "the project approval dot is a diamond, distinct from the round working dot");
	tree = remount();
	assert.equal(toggle().props["aria-expanded"], false, "a fresh sidebar restores the collapse from storage");
	props.query = "second";
	tree = render();
	assert.equal(toggle().props["aria-expanded"], true);
	assert.match(text(rows()[0]), /^Second chat/, "search can show a session in a collapsed project");
	props.query = "";
	tree = render();
	assert.equal(toggle().props["aria-expanded"], false, "clearing search restores the collapse");
	props.activeId = "second";
	render();
	tree = render();
	assert.equal(toggle().props["aria-expanded"], true, "switching to a hidden session opens its project");
	toggle().props.onClick();
	render();
	props.revealActiveOnMount = true;
	tree = remount();
	assert.equal(toggle().props["aria-expanded"], true, "a session switch while the sidebar was hidden opens its project on remount");
	toggle().props.onClick();
	tree = render();
	assert.equal(toggle().props["aria-expanded"], false, "a reveal on mount does not prevent collapsing again");
	toggle().props.onClick();
	delete props.revealActiveOnMount;
	props.activeId = "first";
	props.activity = {};
	tree = render();
	console.log("PASS project groups: disclosure, restart persistence, hidden activity, search and session switches");
}
checkProjectCollapse();

function checkChildSessions() {
	const viewKey = "grok-code.sidebar.v1";
	const originalView = storage.get(viewKey);
	const parent = { ...sessions[0], pinned: false };
	const child = { ...sessions[1], parentId: parent.id, folder: "C:/project-worktree", project: "Worktree" };
	const grandchild = { ...child, id: "third", title: "Third chat", parentId: child.id };
	const rowTitles = (root = tree) => findAll(root, (node) => node.props?.className === "session-hit").map((node) => node.props.title.split("\n")[0]);
	const nestedRows = () => findAll(tree, (node) => node.props?.className === "session-children").flatMap(rowTitles);
	const childToggle = () => findAll(tree, (node) => node.props?.className === "child-toggle")[0];
	const projectToggle = () => findAll(tree, (node) => node.props?.className === "project-toggle" && node.props.title === parent.folder)[0];
	const useView = (patch) => {
		storage.set(viewKey, JSON.stringify({ ...JSON.parse(storage.get(viewKey)), ...patch }));
		tree = remount();
	};
	props.sessions = [parent, child];
	tree = render();
	assert.deepEqual(rowTitles(), [parent.title, child.title]);
	assert.deepEqual(nestedRows(), [child.title], "a cross-folder worktree is nested under its parent");
	assert.equal(findAll(tree, (node) => node.props?.className === "project-toggle").length, 1, "the nested worktree does not create an empty project");
	props.sessions = [parent, child, grandchild];
	tree = render();
	assert.deepEqual(nestedRows(), [child.title], "grandchildren stay flat and visible");
	assert.ok(rowTitles().includes(grandchild.title));
	childToggle().props.onClick();
	props.activity = { second: "running" };
	tree = render();
	assert.equal(childToggle().props["aria-expanded"], false);
	assert.match(childToggle().props["aria-label"], /Working$/);
	props.activity = { second: "needs-you" };
	tree = remount();
	assert.deepEqual(rowTitles(), [parent.title, grandchild.title], "a parent's collapse survives a restart");
	assert.ok(findAll(childToggle(), (node) => node.props?.className === "dot needs-you").length, "a collapsed parent shows its child's approval dot");
	props.query = "second";
	tree = render();
	assert.deepEqual(rowTitles(), [child.title], "search finds a child with a collapsed and unmatched parent");
	props.query = "";
	tree = render();
	assert.equal(childToggle().props["aria-expanded"], false, "search preserves the collapse preference");
	projectToggle().props.onClick();
	tree = render();
	assert.ok(findAll(projectToggle(), (node) => node.props?.className === "dot needs-you").length, "a collapsed project carries its hidden child's approval dot");
	props.activeId = child.id;
	render();
	tree = render();
	assert.deepEqual(nestedRows(), [child.title], "switching to a nested worktree opens its actual project and parent");
	for (const groupBy of ["date", "state"]) {
		useView({ groupBy });
		assert.deepEqual(nestedRows(), []);
		assert.ok(rowTitles().includes(child.title), `${groupBy} grouping keeps child sessions as normal rows`);
	}
	useView({ groupBy: "project", status: "all" });
	props.sessions = [{ ...parent, archived: true }, child];
	tree = render();
	assert.deepEqual(nestedRows(), [], "a visible archived parent leaves its child flat");
	assert.ok(rowTitles().includes(child.title));
	props.sessions = [child];
	tree = render();
	assert.deepEqual(rowTitles(), [child.title], "deleting a parent leaves its child visible as a normal row");
	props.sessions = [{ ...parent, parentId: child.id }, child];
	tree = render();
	assert.equal(rowTitles().length, 2, "a cyclic link never hides either session");
	assert.deepEqual(nestedRows(), []);
	props.sessions = sessions;
	props.activeId = parent.id;
	props.activity = {};
	storage.set(viewKey, originalView);
	tree = remount();
	console.log("PASS child sessions: cross-folder nesting, one level, collapse, hidden activity, search, selection and flat fallbacks");
}
checkChildSessions();

function checkScheduled() {
	const viewKey = "grok-code.sidebar.v1";
	const originalView = storage.get(viewKey);
	const originalArchive = props.onArchive;
	const run = (id, routineId, title, minutesAgo, extra = {}) => ({ ...sessions[1], id, routineId, title, folder: `C:/routines/${routineId}`, project: "shared-folder", worktreeFolder: undefined, branch: "main", lastActivityAt: now - minutesAgo * 60000, ...extra });
	const older = run("a-old", "a", "Alpha · Nov 7", 90);
	const newer = run("a-new", "a", "Alpha · Nov 8", 30);
	const beta = run("b-new", "b", "Beta · gamma · Nov 8", 60);
	const head = () => findAll(tree, (node) => node.props?.className === "group-head scheduled-head")[0];
	const toggle = () => findAll(head(), (node) => node.type === "button")[0];
	const headDot = () => findAll(head(), (node) => node.props?.role === "img")[0]?.props["aria-label"];
	const rowsIn = () => findAll(tree, (node) => node.props?.className === "scheduled-rows").flatMap((box) => findAll(box, (node) => node.props?.className === "session-hit"));
	const names = () => rowsIn().map((row) => text(findAll(row, (node) => node.type === "b")[0]));
	const useRuns = (...list) => { props.sessions = [sessions[1], ...list]; tree = render(); };

	storage.set(viewKey, JSON.stringify({ groupBy: "project", collapsedProjects: [] }));
	useRuns(older, newer, beta);
	tree = remount();
	assert.equal(text(head()).trim(), "Scheduled");
	assert.equal(toggle().props["aria-expanded"], false, "a view saved before this section starts with it closed");
	assert.deepEqual(names(), []);
	assert.deepEqual(findAll(tree, (node) => node.props?.className === "project-toggle" && !findAll(head(), (inner) => inner === node).length).map((node) => node.props.title), [sessions[1].folder], "routine runs leave the project lists, and leave no empty heading");
	toggle().props.onClick();
	tree = render();
	assert.deepEqual(names(), ["Alpha", "Beta · gamma"], "one row per routine, named after it, whatever its folder is called");
	calls.length = 0;
	rowsIn()[0].props.onClick({});
	assert.deepEqual(calls, ["select:a-new"], "a row opens the routine's latest run");
	assert.equal(findAll(head(), (node) => node.props?.role === "img").length, 0, "an open heading leaves the dots to its rows");
	tree = remount();
	assert.deepEqual(names(), ["Alpha", "Beta · gamma"], "the open section survives a restart");
	toggle().props.onClick();
	tree = render();

	const dots = [
		[{}, { "a-new": "needs-you", "b-new": "running" }, "Needs you", "amber first"],
		[{ failed: true, unread: true }, { "b-new": "running" }, "Failed", "then an unread failure"],
		[{ unread: true }, { "b-new": "running" }, "Unread", "then an unread finish"],
		[{}, { "b-new": "running" }, "Working", "then a run still going"],
		[{ failed: true }, {}, undefined, "a failure that was read stops asking"],
		[{ completed: true }, {}, undefined, "a completed run asks for nothing"],
	];
	for (const [patch, activity, expected, why] of dots) {
		useRuns(older, { ...newer, ...patch }, beta);
		props.activity = activity;
		tree = render();
		assert.equal(headDot(), expected, why);
	}
	props.activity = {};
	useRuns({ ...older, failed: true, unread: true }, newer, beta);
	assert.equal(headDot(), undefined, "an older run's failure does not color the routine once a newer run came");
	useRuns(older, { ...newer, failed: true }, beta);
	toggle().props.onClick();
	tree = render();
	assert.equal(findAll(findAll(tree, (node) => node.props?.className === "scheduled-rows")[0], (node) => node.props?.className === "dot failed").length, 1, "a read failure still shows red on its row");
	useRuns(older, newer, beta);

	props.activity = { "a-old": "needs-you" };
	tree = render();
	assert.deepEqual(names(), ["Alpha", "Beta · gamma", "Alpha · Nov 7"], "an older run that needs you keeps its own dated row");
	props.activity = {};
	tree = render();

	toggle().props.onClick();
	tree = render();
	assert.equal(toggle().props["aria-expanded"], false);
	props.activeId = "a-old";
	render();
	tree = render();
	assert.equal(toggle().props["aria-expanded"], true, "opening a run from a notice or the history opens the section");
	assert.deepEqual(names(), ["Alpha", "Beta · gamma", "Alpha · Nov 7"], "the open older run has a row while it is on screen");
	assert.equal(findAll(tree, (node) => node.props?.className === "session active").length, 1);
	props.activeId = sessions[1].id;
	render();
	tree = render();
	assert.deepEqual(names(), ["Alpha", "Beta · gamma"], "and goes back to one row after");

	toggle().props.onClick();
	tree = render();
	props.query = "Nov 7";
	tree = render();
	assert.equal(toggle().props["aria-expanded"], true, "search looks inside a closed section");
	assert.deepEqual(names(), ["Alpha · Nov 7"], "search finds older runs, under their dated titles");
	toggle().props.onClick();
	props.query = "";
	tree = render();
	assert.equal(toggle().props["aria-expanded"], false, "search leaves the choice alone");
	toggle().props.onClick();
	tree = render();

	const menuFor = (index) => {
		findAll(findAll(tree, (node) => node.props?.className === "scheduled-rows")[0], (node) => node.props?.onContextMenu)[index].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 30 }), querySelector: () => null, focus() {} } });
		tree = render();
	};
	const menuItem = (label) => findAll(tree, (node) => node.type === "button" && node.props.role === "menuitem" && text(node).startsWith(label))[0];
	const archived = [];
	props.onArchive = (id) => archived.push(id);
	useRuns(older, newer, { ...run("a-pin", "a", "Alpha · Nov 6", 200), pinned: true }, { ...run("a-gone", "a", "Alpha · Nov 5", 300), archived: true }, beta);
	menuFor(0);
	assert.equal(menuItem("Rename"), undefined, "a routine's name is changed on the Routines page");
	assert.equal(menuItem("Move to section"), undefined, "a routine's runs stay in this section");
	menuItem("Archive all runs").props.onClick();
	assert.deepEqual(archived.sort(), ["a-new", "a-old"], "archiving a row clears the routine's other runs too, except pinned ones");
	tree = render();
	const rows = findAll(findAll(tree, (node) => node.props?.className === "scheduled-rows")[0], (node) => node.props?.className === "session-hit");
	assert.equal(rows[0].props.onDoubleClick, undefined, "a double click does not start a rename");
	assert.deepEqual(findAll(tree, (node) => node.props?.className === "session-hit" && node.props.title.startsWith("Alpha · Nov 6")).map((row) => text(findAll(row, (inner) => inner.type === "b")[0])), ["Alpha · Nov 6"], "a pinned run stays pinned under its dated title");

	archived.length = 0;
	storage.set(viewKey, JSON.stringify({ ...JSON.parse(storage.get(viewKey)), status: "archived", scheduledOpen: true }));
	useRuns({ ...older, archived: true }, { ...newer, archived: true }, beta);
	tree = remount();
	assert.deepEqual(names(), ["Alpha · Nov 8", "Alpha · Nov 7"], "the archive lists every run");
	menuFor(1);
	menuItem("Unarchive").props.onClick();
	assert.deepEqual(archived, ["a-old"], "and acts on one run");

	storage.set(viewKey, JSON.stringify({ groupBy: "project", collapsedProjects: [], scheduledOpen: true }));
	const parentRun = { ...newer };
	const child = { ...sessions[0], id: "child", title: "Child chat", pinned: false, parentId: parentRun.id, folder: "C:/elsewhere", project: "Elsewhere" };
	props.sessions = [parentRun, child];
	tree = remount();
	assert.deepEqual(names(), ["Alpha"]);
	assert.equal(findAll(tree, (node) => node.props?.className === "session-children").length, 0, "a chat started from a run stays visible on its own");
	assert.ok(findAll(tree, (node) => node.props?.className === "session-hit" && node.props.title.startsWith("Child chat")).length, "in its project");

	for (const groupBy of ["date", "state", "section", "none"]) {
		storage.set(viewKey, JSON.stringify({ groupBy, collapsedProjects: [], scheduledOpen: false }));
		useRuns(older, newer);
		tree = remount();
		assert.equal(toggle().props["aria-expanded"], false);
		assert.equal(findAll(tree, (node) => node.props?.className === "session-hit" && node.props.title.startsWith("Alpha")).length, 0, `${groupBy} grouping keeps runs in the section`);
	}
	props.sessions = sessions;
	tree = render();
	assert.equal(head(), undefined, "no routine runs, no section");
	props.sessions = [older];
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "note").length, 0, "a list of only routine runs is not called empty");

	props.sessions = sessions;
	props.activeId = "first";
	props.activity = {};
	props.onArchive = originalArchive;
	storage.set(viewKey, originalView);
	tree = remount();
	console.log("PASS scheduled section: one row per routine, heading dot order, restart, reveal, search, row actions and archive list");
}
checkScheduled();

const scroller =findAll(tree, (node) => node.props?.className === "session-scroll")[0];
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
const rowContext = { preventDefault() {}, stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 30 }), querySelector: () => null, focus() {} } };
secondRow.props.onContextMenu(rowContext);
tree = render();
const openButton = findAll(tree, (node) => node.type === "button" && text(node) === "Open in a new window")[0];
assert.ok(openButton);
openButton.props.onClick();
assert.equal(opened, "second", "new-window action forwards its selected chat rather than the active chat");
const rowMenu = () => {
	tree = render();
	findAll(tree, (node) => node.props?.onContextMenu && text(node).includes("Second chat"))[0].props.onContextMenu(rowContext);
	tree = render();
};
const menuButton = (label) => findAll(tree, (node) => node.type === "button" && text(node).startsWith(label))[0];
const popup = (label) => findAll(tree, (node) => node.props?.role === "menu" && node.props["aria-label"] === label)[0];
async function checkActions() {
	rowMenu();
	assert.equal(menuButton("Export as Markdown"), undefined, "export stays hidden until the session has a Grok id");
	sessions[1].agentSessionId = "agent-1";
	props.onExportMarkdown = (id, title) => calls.push(`export:${id}:${title}`);
	rowMenu();
	menuButton("Export as Markdown").props.onClick();
	assert.equal(calls.at(-1), "export:agent-1:Second chat", "export forwards the Grok session id and the title");
	calls.length = 0;
	delete sessions[1].agentSessionId;
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
	assert.equal(menuButton("Delete").props.disabled, true, "a working session cannot be deleted");
	assert.match(text(menuButton("Delete")), /Stop this session before deleting it\./);
	props.activity = {};
	calls.length = 0;
	tree = render();
	findAll(tree, (node) => node.type === "button" && node.props.className === "session-hit" && text(node).includes("Second chat"))[0].props.onClick({ ctrlKey: true });
	assert.equal(opened, "second", "Ctrl+click opens the session in a new window");
	assert.deepEqual(calls, [], "Ctrl+click does not also select it here");
	rowMenu();
	const cascadeEvent = { currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, right: 200, bottom: 30 }) }, preventDefault() {}, stopPropagation() {} };
	menuButton("Move to section").props.onKeyDown({ ...cascadeEvent, key: "ArrowRight" });
	tree = render();
	assert.equal(menuButton("Move to section").props["aria-expanded"], true, "ArrowRight opens the move submenu");
	popup("Move to section").props.onKeyDown({ ...cascadeEvent, key: "ArrowLeft" });
	tree = render();
	assert.equal(popup("Move to section"), undefined, "ArrowLeft dismisses the submenu");
	assert.ok(popup("Session actions"), "ArrowLeft leaves the parent menu open");
	menuButton("Move to section").props.onClick(cascadeEvent);
	tree = render();
	menuButton("New section").props.onClick();
	assert.match(calls.at(-1), /^move:second:sec-\d+$/, "New section from a row moves that session into it");
	tree = render();
	assert.ok(findAll(tree, (node) => node.props?.["aria-label"] === "Section name").length === 1, "a new section opens for naming");
	const sessionsWithSection = sessions.map((item) => item.id === "second" ? { ...item, sectionId: calls.at(-1).split(":")[2] } : item);
	props.sessions = sessionsWithSection;
	tree = render();
	const nameInput = findAll(tree, (node) => node.props?.["aria-label"] === "Section name")[0];
	nameInput.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, target: { blur() { assert.fail("IME Enter submitted the section name"); } } });
	nameInput.props.onBlur({ target: { value: "Reviews" } });
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
	const accountMenu = popup("Account");
	const updateAction = findAll(accountMenu, (node) => node.type === "button")[0];
	assert.equal(updateAction.props.children.join(""), "Update to 0.2.1…", "update is the first account action");
	updateAction.props.onClick();
	tree = render();
	assert.equal(calls.at(-1), "update");
	assert.equal(popup("Account"), undefined, "the account menu closes before opening the update");
	props.update = null;
	props.account = { email: "account@example.test" };
	props.signIn = "key";
	props.keySource = "env";
	tree = render();
	assert.ok(text(findAll(tree, (node) => node.props?.className === "who")[0]).includes("API key (XAI_API_KEY)"));
	findAll(tree, (node) => node.props?.className === "account-btn")[0].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 900, left: 10 }) } });
	tree = render();
	const keyMenu = popup("Account");
	assert.ok(text(keyMenu).includes("API key (XAI_API_KEY)"));
	assert.ok(text(keyMenu).includes("Remove XAI_API_KEY from your environment to stop using it."));
	const signOut = findAll(keyMenu, (node) => node.type === "button" && text(node).startsWith("Sign out"))[0];
	assert.equal(signOut.props.disabled, true);
	assert.match(text(signOut), /Set by XAI_API_KEY\./);
	props.account = null;
	props.signInMode = "key";
	props.keySource = "app";
	props.onSignOut = () => calls.push("remove key");
	tree = render();
	assert.ok(text(popup("Account")).includes("API key (saved in this app)"));
	props.signIn = "none";
	props.keyUnreadable = true;
	props.keyRejected = true;
	tree = render();
	const failedKeyMenu = popup("Account");
	assert.ok(text(failedKeyMenu).includes("The saved API key can't be read. Enter it again in Settings."));
	assert.ok(text(failedKeyMenu).includes("Grok rejected the API key, or couldn't reach xAI to check it."));
	assert.ok(!text(failedKeyMenu).includes("send a message"));
	const removeKey = findAll(failedKeyMenu, (node) => node.type === "button" && text(node).trim() === "Remove the API key")[0];
	assert.equal(removeKey.props.disabled, false);
	removeKey.props.onClick();
	assert.equal(calls.at(-1), "remove key");
	delete props.account;
	delete props.signIn;
	delete props.signInMode;
	delete props.keySource;
	delete props.keyUnreadable;
	delete props.keyRejected;
	delete props.onSignOut;
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "account-btn")[0].props["aria-label"], "Account and settings");
	assert.equal(findAll(tree, (node) => node.props?.className === "update-flag").length, 0);
	const hit = (title) => findAll(tree, (node) => node.type === "button" && node.props.className === "session-hit" && text(node).includes(title))[0];
	props.chats = { second: [{ id: "m1", role: "grok", text: "Done." }, { id: "m2", role: "user", text: "Please fix the  flaky\nlogin test in auth.ts" }] };
	props.query = " LOGIN ";
	tree = render();
	assert.equal(hit("First chat"), undefined, "a session without the text is hidden");
	assert.equal(text(findAll(hit("Second chat"), (node) => node.props?.className === "session-meta")[0]), "Please fix the flaky login test in auth.ts", "a message-text match shows where it matched");
	calls.length = 0;
	hit("Second chat").props.onClick({});
	assert.deepEqual(calls, ["select:second:LOGIN"], "opening a message-text match asks for Find with the search text");
	props.query = "second";
	tree = render();
	hit("Second chat").props.onClick({});
	assert.deepEqual(calls, ["select:second:LOGIN", "select:second"], "a title match opens the session without Find");
	props.query = "nothing like this";
	tree = render();
	assert.ok(findAll(tree, (node) => node.props?.className === "note" && text(node) === "No sessions match.").length === 1);
	assert.equal(loaded.exports.textHit([{ text: `${"x".repeat(40)} needle here` }], "needle"), `…${"x".repeat(23)} needle here`, "a match deep in a message is clipped from shortly before it");
	assert.equal(loaded.exports.textHit([{ text: "İstanbul" }], "zzz"), undefined);
	props.query = "";
	props.chats = {};
	props.loopCounts = { second: 2 };
	tree = render();
	let marks = findAll(tree, (node) => node.props?.className === "loop-count");
	assert.equal(marks.length, 1, "a row with loops shows one count");
	assert.equal(text(marks[0]), "2");
	assert.equal(marks[0].props.title, "2 scheduled loops");
	props.loopCounts = { second: 1 };
	tree = render();
	marks = findAll(tree, (node) => node.props?.className === "loop-count");
	assert.equal(marks[0].props.title, "1 scheduled loop");
	assert.equal(marks[0].props["aria-label"], "1 scheduled loop");
	props.loopCounts = undefined;
	tree = render();
	assert.equal(findAll(tree, (node) => node.props?.className === "loop-count").length, 0, "a row without loops has no count");
	const cliId = "01a19999-aaaa-7bbb-8ccc-ddddeeeeffff";
	props.onListCliSessions = async () => ({ ok: true, sessions: [{ id: cliId, title: "Fix the door", folder: "C:/work/app", lastActive: now - 60000 }] });
	props.onOpenCliSession = (id) => calls.push(`cli:${id}`);
	tree = render();
	const cliClick = { currentTarget: { getBoundingClientRect: () => ({ top: 10, left: 10, right: 80, bottom: 30 }) }, preventDefault() {}, stopPropagation() {} };
	const flush = async () => { for (let step = 0; step < 8; step += 1) { await Promise.resolve(); } };
	const cliButton = findAll(tree, (node) => node.props?.["aria-label"] === "Open CLI session")[0];
	assert.deepEqual(findAll(cliButton, (node) => node.type === "span").map(text), ["Open CLI session…", "CLI…"]);
	cliButton.props.onClick(cliClick);
	await flush();
	tree = render();
	const cliRow = findAll(tree, (node) => node.type === "button" && text(node).includes("Fix the door"))[0];
	assert.match(text(cliRow), /Fix the door\s+C:\/work\/app\s+· 1m/, "a CLI session shows its name, folder and age");
	cliRow.props.onClick();
	assert.equal(calls.at(-1), `cli:${cliId}`, "choosing a CLI session opens that id");
	props.onListCliSessions = async () => { throw new Error("disk"); };
	tree = render();
	findAll(tree, (node) => node.props?.["aria-label"] === "Open CLI session")[0].props.onClick(cliClick);
	await flush();
	tree = render();
	assert.equal(text(findAll(tree, (node) => node.props?.className === "meta").at(-1)), "Grok's sessions could not be read.");
	effects.forEach((effect) => effect?.cleanup?.());
	assert.equal(listeners.has("storage"), false, "the shared-section listener is removed on cleanup");
	assert.equal(intervals.size, 0, "activity refresh stops on cleanup");
	console.log("Sidebar row actions passed: unread, completed, delete with confirm, Ctrl+click window, sections.");
	console.log("Sidebar regressions passed: live approval badges, selected new-window identity, cross-window sections.");
	console.log("Sidebar activity passed: relative labels, worktree branch, minute refresh, arrow focus and cleanup.");
}

// The platform rules in data.ts, loaded as the preload reports each platform.
function checkPlatformRules() {
	const loadFor = (platform) => {
		const module = { exports: {} };
		vm.runInNewContext(`(function(module, exports) {\n${dataSource}\n})`, { window: { grokCode: { platform } } })(module, module.exports);
		return module.exports;
	};
	const key = (overrides) => ({ ctrlKey: false, metaKey: false, key: "n", code: "KeyN", ...overrides });
	const mac = loadFor("darwin");
	assert.equal(mac.modKey(key({ metaKey: true })), true, "Cmd+N on macOS");
	assert.equal(mac.modKey(key({ ctrlKey: true })), false, "Ctrl+N is not the shortcut on macOS");
	assert.equal(mac.modKey(key({ ctrlKey: true, key: "Tab", code: "Tab" })), true, "Ctrl+Tab stays Ctrl on macOS");
	assert.equal(mac.modKey(key({ ctrlKey: true, key: "`", code: "Backquote" })), true, "Ctrl+` stays Ctrl on macOS");
	assert.equal(mac.keyLabel("Ctrl+Shift+N"), "Cmd+Shift+N");
	assert.equal(mac.keyLabel("Ctrl+Shift+Tab"), "Ctrl+Shift+Tab");
	assert.equal(mac.keyLabel("Ctrl+`"), "Ctrl+`");
	assert.equal(mac.keyLabel("Ctrl+click opens it"), "Cmd+click opens it");
	assert.equal(mac.FILE_MANAGER, "Finder");
	assert.equal(mac.caseKey("/Users/A/Proj"), "/users/a/proj");
	const linux = loadFor("linux");
	assert.equal(linux.modKey(key({ ctrlKey: true })), true);
	assert.equal(linux.keyLabel("Ctrl+Shift+N"), "Ctrl+Shift+N");
	assert.equal(linux.caseKey("/home/u/Proj") === linux.caseKey("/home/u/proj"), false, "Linux keeps two folders that differ only by case apart");
	const windows = loadFor(undefined);
	assert.equal(windows.PLATFORM, "win32", "no preload platform behaves as Windows");
	assert.equal(windows.FILE_MANAGER, "File Explorer");
	assert.equal(windows.caseKey("C:\\Proj"), "c:\\proj");
	console.log("PASS platform rules: Cmd on macOS except Tab and backquote, labels, file manager names, and Linux path case");
}

checkPlatformRules();
void checkActions().catch((error) => { console.error(error); process.exitCode = 1; });
