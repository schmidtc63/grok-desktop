const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

let hooks;
const react = {
	Fragment: "fragment",
	useState(initial) {
		if (!hooks) { return [typeof initial === "function" ? initial() : initial, () => {}]; }
		const current = hooks;
		const index = current.cursor++;
		if (!(index in current.values)) { current.values[index] = typeof initial === "function" ? initial() : initial; }
		return [current.values[index], (next) => { current.values[index] = typeof next === "function" ? next(current.values[index]) : next; }];
	},
	useRef(value) {
		if (!hooks) { return { current: value }; }
		const index = hooks.cursor++;
		if (!(index in hooks.values)) { hooks.values[index] = { current: value }; }
		return hooks.values[index];
	},
	useMemo(fn) { return fn(); },
	useEffect(run, dependencies) {
		if (!hooks) { return; }
		const current = hooks;
		const index = current.cursor++;
		const previous = current.values[index];
		if (!previous || !dependencies || dependencies.some((value, offset) => value !== previous.dependencies[offset])) {
			current.effects.push(() => {
				previous?.cleanup?.();
				current.values[index] = { dependencies, cleanup: run() };
			});
		}
	},
};
react.useLayoutEffect = react.useEffect;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });

// A test that needs to see the confirm questions passes the confirm module the component should share.
function load(name, globals = {}, confirm) {
	const file = path.join(__dirname, "..", "src", name);
	const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
	const module = { exports: {} };
	const imports = (id) => {
		if (id === "react") { return react; }
		if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
		if (id === "./confirm") { return confirm ?? load("confirm.ts", globals); }
		if (id === "./data") { return load("data.ts", globals); }
		if (id === "./sandbox") { return load("sandbox.ts", globals); }
		if (id === "./Icon") { return load("Icon.tsx", globals); }
		if (id === "./PaneActions") { return load("PaneActions.tsx", globals); }
		if (id === "./PopupMenu") { return { PopupMenu: (props) => jsx("div", { role: "menu", ...props }) }; }
		if (id === "./Markdown") { return { Markdown: (props) => jsx("markdown", props) }; }
		if (id === "./CodeEditorLoader") { return { CodeEditorLoader: (props) => jsx("code-editor", props) }; }
		throw new Error(`Unexpected import ${id}`);
	};
	vm.runInNewContext(source, { require: imports, module, exports: module.exports, ...globals }, { filename: file });
	return module.exports;
}

// Expand function components and return every host element plus all text.
function flatten(node, out = { elements: [], text: [] }) {
	if (node === null || node === undefined || typeof node === "boolean") { return out; }
	if (Array.isArray(node)) { node.forEach((child) => flatten(child, out)); return out; }
	if (typeof node === "string" || typeof node === "number") { out.text.push(String(node)); return out; }
	if (typeof node.type === "function") {
		if (!hooks || node.key === undefined) { return flatten(node.type(node.props), out); }
		const parent = hooks;
		const index = parent.cursor++;
		const previous = parent.values[index];
		hooks = previous?.key === node.key ? previous : { key: node.key, values: [] };
		parent.values[index] = hooks;
		hooks.cursor = 0;
		hooks.effects = [];
		try {
			flatten(node.type(node.props), out);
			parent.effects.push(...hooks.effects);
			return out;
		} finally {
			hooks = parent;
		}
	}
	out.elements.push(node);
	return flatten(node.props.children, out);
}

function renderer(component, props) {
	const state = { cursor: 0, values: [], effects: [] };
	return () => {
		hooks = state;
		state.cursor = 0;
		state.effects = [];
		try {
			const tree = flatten(component(props));
			state.effects.forEach((run) => run());
			return tree;
		} finally {
			hooks = undefined;
		}
	};
}

let failures = 0;
function check(label, fn) {
	try {
		fn();
		console.log(`PASS ${label}`);
	} catch (error) {
		failures++;
		console.log(`FAIL ${label}: ${error.message}`);
	}
}

async function checkAsync(label, fn) {
	let timer;
	try {
		await Promise.race([Promise.resolve().then(fn), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Check did not settle")), 5000); })]);
		console.log(`PASS ${label}`);
	} catch (error) {
		failures++;
		console.log(`FAIL ${label}: ${error.message}`);
	} finally {
		clearTimeout(timer);
	}
}

const { numberLines, checksSummary, DiffPane } = load("DiffPane.tsx");
const { SessionRail } = load("SessionRail.tsx");
const filesPane = load("FilesPane.tsx");
const { shouldAutoSave, FilesPane } = filesPane;
const { fromFile } = filesPane;

check("PopupMenu moves focus with arrows, dismisses on Escape, and preserves action focus", () => {
	const pending = [];
	const { PopupMenu } = load("PopupMenu.tsx", { queueMicrotask: (run) => pending.push(run) });
	const body = {};
	const document = { body, activeElement: body };
	const menu = {
		isConnected: true,
		ownerDocument: document,
		querySelectorAll: () => [first, disabled, nested, last],
		contains: (item) => [menu, first, disabled, nested, last].includes(item),
	};
	function control(owner, disabled = false) {
		return { isConnected: true, closest: () => owner, matches: () => disabled, focus() { document.activeElement = this; } };
	}
	const first = control(menu);
	const last = control(menu);
	const disabled = control(menu, true);
	const nested = control({});
	const opener = control(null);
	const destination = control(null);
	for (const nextFocus of [body, destination]) {
		menu.isConnected = true;
		opener.focus();
		const state = { cursor: 0, values: [], effects: [] };
		let node;
		hooks = state;
		try {
			node = PopupMenu({ opener, onDismiss: () => { menu.isConnected = false; document.activeElement = nextFocus; } });
			node.props.ref.current = menu;
			state.effects.forEach((run) => run());
		} finally {
			hooks = undefined;
		}
		function press(key) {
			let prevented = false;
			let stopped = false;
			node.props.onKeyDown({ key, currentTarget: menu, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
			assert.ok(prevented && stopped);
		}
		assert.equal(document.activeElement, first);
		press("ArrowDown");
		assert.equal(document.activeElement, last);
		press("ArrowDown");
		assert.equal(document.activeElement, first);
		press("ArrowUp");
		assert.equal(document.activeElement, last);
		press("Escape");
		assert.equal(menu.isConnected, false);
		state.values.forEach((value) => value.cleanup?.());
		pending.splice(0).forEach((run) => run());
		assert.equal(document.activeElement, nextFocus === body ? opener : destination);
	}
});

check("PopupMenu fits top and bottom anchors into a short viewport", () => {
	const { PopupMenu } = load("PopupMenu.tsx");
	for (const [className, top, bottom, margin] of [["row-pop", 210, 390, "marginTop"], ["pop up", -40, 140, "marginBottom"]]) {
		let resize;
		const view = {
			innerHeight: 320,
			addEventListener(_name, handler) { resize = handler; },
			removeEventListener(_name, handler) { if (resize === handler) { resize = undefined; } },
		};
		const menu = {
			ownerDocument: { defaultView: view },
			matches: () => true,
			classList: { contains: (name) => className.split(" ").includes(name) },
			style: {},
			getBoundingClientRect: () => ({ top, bottom }),
		};
		const state = { cursor: 0, values: [], effects: [] };
		hooks = state;
		try {
			PopupMenu({ className, focusOnOpen: false }).props.ref.current = menu;
			state.effects.forEach((run) => run());
		} finally {
			hooks = undefined;
		}
		assert.equal(menu.style[margin], margin === "marginTop" ? "-78px" : "-48px");
		view.innerHeight = 500;
		resize();
		assert.equal(menu.style[margin], margin === "marginTop" ? "" : "-48px");
		state.values[2].cleanup();
		assert.equal(resize, undefined);
	}
});

const hunk = {
	id: "h1",
	loc: "@@ -10,3 +10,4 @@ function demo()",
	lines: [
		{ kind: "context", text: "a" },
		{ kind: "del", text: "b" },
		{ kind: "add", text: "c" },
		{ kind: "add", text: "d" },
		{ kind: "context", text: "e" },
	],
};

check("numberLines numbers a normal hunk", () => {
	const rows = numberLines(hunk).map((row) => [row.kind, row.oldLine, row.newLine, row.text]);
	assert.deepEqual(rows, [
		["context", 10, 10, "a"],
		["del", 11, undefined, "b"],
		["add", undefined, 11, "c"],
		["add", undefined, 12, "d"],
		["context", 12, 13, "e"],
	]);
});

check("numberLines numbers a staged hunk", () => {
	assert.equal(numberLines({ ...hunk, loc: `Staged ${hunk.loc}` })[0].oldLine, 10);
});

check("numberLines leaves a labelled hunk unnumbered", () => {
	const rows = numberLines({ id: "h2", loc: "New file", lines: [{ kind: "add", text: "x" }, { kind: "add", text: "y" }] });
	assert.equal(rows.length, 2);
	rows.forEach((row) => {
		assert.equal(row.oldLine, undefined);
		assert.equal(row.newLine, undefined);
		assert.equal(row.kind, "add");
	});
	assert.equal(rows[1].text, "y");
});

check("checksSummary counts check states in order", () => {
	const checks = [{ name: "a", state: "fail" }, { name: "b", state: "pass" }, { name: "c", state: "run" }, { name: "d", state: "pass" }];
	assert.equal(checksSummary(checks), "2 passed · 1 running · 1 failed");
	assert.equal(checksSummary([]), "No checks");
});

const ok = { autoSave: true, dirty: true, conflict: false, readOnly: false, saving: false };
check("shouldAutoSave fires for a dirty clean-state draft", () => assert.equal(shouldAutoSave(ok), true));
check("shouldAutoSave waits when auto save is off", () => assert.equal(shouldAutoSave({ ...ok, autoSave: false }), false));
check("shouldAutoSave waits when nothing changed", () => assert.equal(shouldAutoSave({ ...ok, dirty: false }), false));
check("shouldAutoSave waits on a disk conflict", () => assert.equal(shouldAutoSave({ ...ok, conflict: true }), false));
check("shouldAutoSave waits on a view-only file", () => assert.equal(shouldAutoSave({ ...ok, readOnly: true }), false));
check("shouldAutoSave waits while a save runs", () => assert.equal(shouldAutoSave({ ...ok, saving: true }), false));

check("Markdown links resolve from the document and preserve line targets and literal base names", () => {
	for (const [file, href, expected] of [
		["docs/a.md", "b.md", "docs/b.md"],
		["docs/a.md", "b.md:42", "docs/b.md:42"],
		["docs/sub/a.md", "../c.md#x", "docs/c.md"],
		["docs/100%/a.md", "next.md", "docs/100%/next.md"],
		["docs/x#y/a.md", "next.md", "docs/x#y/next.md"],
		["docs/a.md", "https://example.test/a", "https://example.test/a"],
		["docs/a.md", "#top", "#top"],
		["docs/a.md", "C:/x.md", "C:/x.md"],
		["docs/a.md", "C:\\x.md", "C:\\x.md"],
	]) {
		assert.equal(fromFile(file, href), expected);
	}
});

const noop = () => {};
const asyncOk = async () => ({ ok: true });
const diffProps = {
	viewed: {}, onViewed() {},
	snapshot: { ok: true, files: [{ path: "src/a.ts", additions: 2, deletions: 1, hunks: [hunk] }] },
	scope: "branch", onScope: noop, commits: [{ sha: "abc123", short: "abc123", subject: "Fix" }],
	selectedFile: "src/a.ts", onSelectFile: noop, onRefresh: noop, onRevert: asyncOk, onRevertHunk: asyncOk, onCommit: asyncOk, busy: false,
	comments: [{ id: "c1", file: "src/a.ts", line: 11, side: "new", text: "Why?" }],
	onAddComment: noop, onRemoveComment: noop, onSendComments: noop,
	branch: { branch: "feature", base: "main", ahead: 2 }, pr: null,
	onCreatePr: asyncOk, onMergeWhenReady: asyncOk, onOpenFile: noop, onFileMenu: noop, onClose: noop,
};

check("Changes leaves commit scope when the selected commit disappears from refreshed history", () => {
	const scopes = [];
	const props = { ...diffProps, scope: diffProps.commits[0].sha, onScope: (scope) => scopes.push(scope) };
	const render = renderer(DiffPane, props);
	render();
	assert.deepEqual(scopes, []);
	props.commits = [{ sha: "def456", short: "def456", subject: "Amended" }];
	render();
	assert.deepEqual(scopes, ["uncommitted"]);
});

check("DiffPane renders gutter numbers, line comments, Create PR and the send bar", () => {
	const tree = flatten(DiffPane(diffProps));
	const text = tree.text.join("");
	const nums = tree.elements.filter((el) => el.props.className === "dp-num").map((el) => el.props.children);
	assert.deepEqual(nums.slice(0, 4), [10, 10, 11, ""]);
	assert.ok(tree.elements.some((el) => el.props["aria-label"] === "Comment on line 11"));
	assert.ok(tree.elements.some((el) => el.props["aria-label"] === "Remove comment"));
	assert.ok(text.includes("Why?"));
	assert.ok(text.includes("Create PR"));
	assert.ok(text.includes("1 comment"));
	assert.ok(text.includes("Send to Grok (Ctrl+Enter)"));
	assert.ok(!text.includes("Accept") && !text.includes("Reject"));
});

check("Revert is available only in Uncommitted changes", () => {
	const { DiffPane: MenuPane } = load("DiffPane.tsx", { window: { innerWidth: 800 } });
	for (const scope of ["abc123", "branch", "uncommitted"]) {
		const render = renderer(MenuPane, { ...diffProps, scope });
		render().elements.find((node) => node.props["aria-label"] === "Changes menu" && node.type === "button").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 400 }) } });
		const item = render().elements.find((node) => node.props.role === "menuitem" && flatten(node).text.join("").startsWith("Revert file…"));
		assert.equal(item.props.disabled, scope !== "uncommitted");
		const reason = flatten(item).elements.find((node) => node.props.className === "menu-reason");
		assert.equal(reason?.props.children, scope !== "uncommitted" ? "Switch to Uncommitted changes to revert a file" : undefined);
	}
});

check("Hunk revert appears only for eligible working-tree changes in Uncommitted scope", () => {
	const hunks = [
		{ ...hunk, revertible: true },
		{ ...hunk, id: "staged", loc: `Staged ${hunk.loc}`, revertible: false },
		{ ...hunk, id: "new", loc: "New file", revertible: false },
		{ ...hunk, id: "binary", loc: "Binary file", revertible: false },
		{ ...hunk, id: "submodule", loc: "Submodule", revertible: false },
		{ ...hunk, id: "legacy" },
	];
	for (const scope of ["uncommitted", "branch", "abc123"]) {
		const tree = flatten(DiffPane({ ...diffProps, scope, snapshot: { ok: true, files: [{ path: "src/a.ts", hunks }] } }));
		assert.equal(tree.elements.filter((el) => el.type === "button" && el.props.children === "Revert this change").length, scope === "uncommitted" ? 1 : 0);
	}
});

check("DiffPane shows an existing pull request with state and checks", () => {
	const pr = { number: 7, title: "Fix tax", url: "https://example.test/pull/7", state: "OPEN", isDraft: true, autoMerge: false, checks: [{ name: "a", state: "pass" }, { name: "b", state: "run" }] };
	const text = flatten(DiffPane({ ...diffProps, pr, comments: [] })).text.join("");
	assert.ok(text.includes("PR #7 Fix tax"));
	assert.ok(text.includes("Draft"));
	assert.ok(text.includes("1 passed · 1 running"));
	assert.ok(!text.includes("Send to Grok"));
});

check("Ctrl+Enter adds the draft before sending the updated comments", () => {
	const calls = [];
	const props = {
		...diffProps, comments: [],
		onAddComment: (comment) => { calls.push("add"); props.comments = [{ id: "sent", ...comment }]; },
		onSendComments: () => calls.push(`send:${props.comments.at(-1).text}`),
	};
	const render = renderer(DiffPane, props);
	let tree = render();
	tree.elements.find((node) => node.props["aria-label"] === "Comment on line 10").props.onClick();
	tree = render();
	tree.elements.find((node) => node.type === "textarea").props.onChange({ target: { value: "Why?" } });
	tree = render();
	tree.elements.find((node) => node.type === "textarea").props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
	assert.deepEqual(calls, ["add"]);
	render();
	assert.deepEqual(calls, ["add", "send:Why?"]);
	render();
	assert.equal(calls.length, 2, "the comment sends once");
});

const pickFiles = ["src/a.ts", "src/b.ts", "src/c.ts"].map((file) => ({ path: file, additions: 1, deletions: 0, hunks: [hunk] }));
const pickProps = { ...diffProps, scope: "uncommitted", comments: [], snapshot: { ok: true, files: pickFiles } };
const pickBoxes = (tree) => tree.elements.filter((el) => /^Include .+ in the commit$/.test(el.props["aria-label"] ?? ""));
const pickBox = (tree, file) => pickBoxes(tree).find((el) => el.props["aria-label"] === `Include ${file} in the commit`);
const commitButton = (tree, label) => tree.elements.find((el) => el.type === "button" && el.props.children === label);
const commitModal = (tree) => tree.elements.find((el) => el.props.role === "dialog");
const modalTree = (tree) => flatten(commitModal(tree));
const modalButton = (tree, label) => commitButton(modalTree(tree), label);

function commitRig(props) {
	const asks = [];
	const requests = [];
	const commits = [];
	let refreshes = 0;
	const shown = { ...props, onAskGrok: (text) => requests.push(text), onCommit: (input) => { commits.push(JSON.parse(JSON.stringify(input))); return props.onCommit(input); }, onRefresh: () => { refreshes++; props.onRefresh(); } };
	const render = renderer(DiffPane, shown);
	const open = (label) => {
		commitButton(render(), label).props.onClick();
		asks.push({ title: commitModal(render()).props["aria-label"] });
	};
	return {
		props: shown, render, asks, requests, commits, open,
		refreshes: () => refreshes,
		message: (text) => modalTree(render()).elements.find((el) => el.props["aria-label"] === "Commit message").props.onChange({ target: { value: text } }),
		toggle: (file) => pickBox(render(), file).props.onChange(),
		async press(label) {
			open(label);
			modalButton(render(), "Ask Grok to commit").props.onClick();
			await new Promise((resolve) => setImmediate(resolve));
			return { ask: asks.at(-1), request: requests.at(-1) };
		},
	};
}

function hunkRig(change, reply = asyncOk) {
	const confirms = load("confirm.ts");
	const asks = [];
	const calls = [];
	let refreshes = 0;
	confirms.setConfirmHost((pending) => asks.push(pending));
	const props = {
		...diffProps, scope: "uncommitted", comments: [],
		snapshot: { ok: true, files: [{ path: "src/a.ts", hunks: [change] }] },
		onRevertHunk: (file, selected) => { calls.push([file, selected]); return reply(); },
		onRefresh: () => { refreshes++; },
	};
	const render = renderer(load("DiffPane.tsx", {}, confirms).DiffPane, props);
	return { props, render, asks, calls, refreshes: () => refreshes, press: () => commitButton(render(), "Revert this change").props.onClick() };
}

check("Commit dialog names the count, focuses the message and keeps Ask Grok available while busy", () => {
	const rig = commitRig(pickProps);
	for (const label of ["Commit", "Commit and push"]) {
		rig.open(label);
		const tree = rig.render();
		const modal = commitModal(tree);
		assert.equal(modal.props["aria-modal"], "true");
		assert.equal(modal.props["aria-label"], `Commit 3 files${label === "Commit and push" ? " and push" : ""}?`);
		assert.ok(modalTree(tree).text.join("").includes("Only the checked files listed in the pane will be committed. Other changes stay uncommitted."));
		const field = modalTree(tree).elements.find((el) => el.props["aria-label"] === "Commit message");
		assert.equal(field.type, "textarea");
		assert.equal(field.props.value, "");
		assert.equal(field.props.autoFocus, true);
		assert.equal(modalButton(tree, label).props.disabled, true);
		assert.equal(modalButton(tree, label).props.className.includes("danger"), label === "Commit and push");
		assert.deepEqual(modalTree(tree).elements.filter((el) => el.type === "button").map((el) => el.props.children), ["Cancel", "Ask Grok to commit", label]);
		rig.message(" \n\t ");
		assert.equal(modalButton(rig.render(), label).props.disabled, true);
		rig.message("Use the direct route");
		assert.equal(modalButton(rig.render(), label).props.disabled, false);
		rig.props.busy = true;
		assert.equal(modalButton(rig.render(), label).props.disabled, true);
		assert.equal(modalButton(rig.render(), "Ask Grok to commit").props.disabled, false);
		assert.ok(modalTree(rig.render()).text.join("").includes("Grok is still working. Wait for the turn to end, or ask Grok to commit."));
		modalButton(rig.render(), "Ask Grok to commit").props.onClick();
		assert.equal(commitModal(rig.render()), undefined);
		rig.props.busy = false;
	}
	assert.equal(rig.requests.length, 2);
	assert.deepEqual(rig.commits, []);
});

check("File checkboxes appear only where the commit buttons appear, all checked", () => {
	const tree = flatten(DiffPane(pickProps));
	assert.ok(commitButton(tree, "Commit") && commitButton(tree, "Commit and push"));
	assert.deepEqual(pickBoxes(tree).map((el) => el.props["aria-label"]), pickFiles.map((file) => `Include ${file.path} in the commit`));
	assert.ok(pickBoxes(tree).every((el) => el.type === "input" && el.props.type === "checkbox" && el.props.checked === true));
	for (const changed of [{ scope: "branch" }, { scope: "abc123" }, { snapshot: { ok: true, files: [] } }, { snapshot: { ok: true, repo: false, files: pickFiles } }, { snapshot: { ok: false, files: pickFiles } }]) {
		const other = flatten(DiffPane({ ...pickProps, ...changed }));
		assert.equal(commitButton(other, "Commit"), undefined, JSON.stringify(Object.keys(changed)));
		assert.equal(pickBoxes(other).length, 0, JSON.stringify(Object.keys(changed)));
	}
});

check("Conflicted files start unchecked and can be checked explicitly in either changes list", () => {
	const [file, ...others] = pickFiles;
	for (const progressive of [false, true]) {
		const props = { ...pickProps, progressive, snapshot: { ok: true, files: [{ ...file, conflicted: true }, ...others] } };
		const render = renderer(DiffPane, props);
		let tree = render();
		assert.deepEqual(pickBoxes(tree).map((box) => box.props.checked), [false, true, true]);
		pickBox(tree, file.path).props.onChange();
		assert.equal(pickBox(render(), file.path).props.checked, true);
		props.snapshot = pickProps.snapshot;
		render();
		props.snapshot = { ok: true, files: [{ ...file, conflicted: true }, ...others] };
		tree = render();
		assert.equal(pickBox(tree, file.path).props.checked, false);
	}
});

check("Paged changes reveal unchecked files and bulk inclusion affects only listed files", () => {
	const files = Array.from({ length: 84 }, (_, index) => ({ path: `file-${index + 1}.txt`, hunks: [] }));
	const render = renderer(DiffPane, { ...pickProps, progressive: true, snapshot: { ok: true, files } });
	const master = (tree) => flatten(tree.elements.find((node) => node.props.className === "dp-include-all")).elements.find((node) => node.type === "input");
	let tree = render();
	assert.ok(tree.text.join("").includes("Showing 40 of 84 changed files."));
	assert.equal(pickBoxes(tree).length, 40);
	assert.equal(master(tree).props.checked, true);
	pickBox(tree, files[0].path).props.onChange();
	commitButton(render(), "Show more files").props.onClick();
	tree = render();
	assert.ok(tree.text.join("").includes("Showing 80 of 84 changed files."));
	assert.equal(pickBoxes(tree).length, 80);
	assert.equal(pickBox(tree, files[0].path).props.checked, false);
	assert.equal(pickBox(tree, files[39].path).props.checked, true);
	assert.equal(pickBox(tree, files[40].path).props.checked, false);
	let focused = false;
	tree.elements.find((node) => node.type === "button" && node.props.title === files[40].path).props.ref({ focus: () => { focused = true; } });
	assert.equal(focused, true);
	assert.ok(tree.elements.some((node) => node.props.title === files[0].path && node.props.className === "file-row on"));
	const checkbox = {};
	master(tree).props.ref(checkbox);
	assert.equal(checkbox.indeterminate, true);
	master(tree).props.onChange();
	commitButton(render(), "Show more files").props.onClick();
	tree = render();
	assert.equal(pickBox(tree, files[79].path).props.checked, true);
	assert.equal(pickBox(tree, files[80].path).props.checked, false);
	commitButton(tree, "Commit").props.onClick();
	assert.equal(commitModal(render()).props["aria-label"], "Commit 80 files?");
});

check("A cut patch can be stopped, retried, and marked viewed only when complete", () => {
	const file = { path: "src/a.ts", hunks: [] };
	const line = { ...hunk, lines: [{ kind: "add", text: "- literal content" }] };
	const calls = [];
	const props = {
		...diffProps, progressive: true, loadingFile: true, snapshot: { ok: true, files: [file] }, viewed: {},
		onStopLoad: () => calls.push("stop"), onLoadFull: () => calls.push("load"),
		onViewed: (name, fingerprint) => { props.viewed[name] = fingerprint; calls.push(fingerprint); },
	};
	const render = renderer(DiffPane, props);
	const viewed = (tree) => tree.elements.find((node) => node.props.className === "texty dp-viewed-toggle");
	commitButton(render(), "Stop loading").props.onClick();
	props.loadingFile = false;
	props.fileError = "The diff timed out.";
	let tree = render();
	assert.equal(tree.elements.find((node) => node.props.role === "alert").props.children, "The diff timed out.");
	commitButton(tree, "Retry diff").props.onClick();
	props.fileError = undefined;
	props.snapshot = { ok: true, files: [{ ...file, patchLoaded: true, truncated: true, hunks: [line] }] };
	tree = render();
	assert.equal(viewed(tree).props.disabled, true);
	assert.equal(tree.elements.find((node) => node.props.className === "dp-text").props.children, "- literal content");
	assert.equal(tree.elements.find((node) => node.props["aria-label"] === "Added line").props.children, "+");
	commitButton(tree, "Load full diff for this file").props.onClick();
	props.snapshot = { ok: true, files: [{ ...file, patchLoaded: true, hunks: [line] }] };
	viewed(render()).props.onClick();
	assert.equal(viewed(render()).props["aria-pressed"], true);
	viewed(render()).props.onClick();
	assert.equal(viewed(render()).props["aria-pressed"], false);
	assert.deepEqual(calls, ["stop", "load", "load", line.id, null]);
});

check("Clicking a file checkbox does not select or open the file row", () => {
	const calls = [];
	const render = renderer(DiffPane, { ...pickProps, onSelectFile: (file) => calls.push(`select:${file}`), onOpenFile: (file) => calls.push(`open:${file}`) });
	const rows = render().elements.filter((el) => el.type === "button" && /^file-row/.test(el.props.className ?? ""));
	assert.equal(rows.length, 3);
	rows.forEach((row) => assert.ok(!flatten(row.props.children).elements.some((el) => el.type === "input"), "the checkbox sits beside the row button, not inside it"));
	pickBox(render(), "src/b.ts").props.onChange();
	assert.deepEqual(calls, []);
	assert.equal(pickBox(render(), "src/b.ts").props.checked, false);
	rows[1].props.onClick();
	assert.deepEqual(calls, ["select:src/b.ts"], "the row itself still selects");
});

check("Both commit buttons are disabled while no file is checked", () => {
	const render = renderer(DiffPane, pickProps);
	pickFiles.forEach((file) => pickBox(render(), file.path).props.onChange());
	for (const label of ["Commit", "Commit and push"]) {
		assert.equal(commitButton(render(), label).props.disabled, true);
		assert.equal(commitButton(render(), label).props.title, "Check at least one file.");
	}
	pickBox(render(), "src/c.ts").props.onChange();
	for (const label of ["Commit", "Commit and push"]) {
		assert.equal(commitButton(render(), label).props.disabled, false);
		assert.equal(commitButton(render(), label).props.title, undefined);
	}
});

check("Review shows the same checkboxes and state, and leaves the side-pane scroll layout", () => {
	const render = renderer(DiffPane, pickProps);
	const body = (tree) => tree.elements.find((el) => /^pane-bd/.test(el.props.className ?? ""));
	pickBox(render(), "src/b.ts").props.onChange();
	assert.equal(body(render()).props.className, "pane-bd dp-side");
	render().elements.find((el) => el.props["aria-label"] === "Review in a large view").props.onClick();
	const tree = render();
	assert.equal(body(tree).props.className, "pane-bd");
	assert.deepEqual(pickBoxes(tree).map((el) => el.props.checked), [true, false, true]);
	assert.ok(commitButton(tree, "Commit"));
});

check("The workspace owns Changes expansion and movement without remounting its review", () => {
	const { DiffPane: WorkspacePane } = load("DiffPane.tsx", { window: { innerWidth: 800 } });
	let moved = 0;
	const layout = { expanded: false, onToggleExpand() { layout.expanded = !layout.expanded; }, moveLater() { moved++; } };
	const render = renderer(WorkspacePane, { ...pickProps, layout });
	const button = (label) => render().elements.find((el) => el.type === "button" && el.props["aria-label"] === label);
	pickBox(render(), "src/b.ts").props.onChange();
	button("Expand Changes").props.onClick();
	assert.ok(render().elements.some((el) => el.props.className === "pane dp-review"));
	assert.ok(!render().elements.some((el) => el.props.className === "fp-backdrop"));
	assert.equal(pickBox(render(), "src/b.ts").props.checked, false);
	button("Changes menu").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 400 }) } });
	const menu = render().elements.filter((el) => el.props.role === "menuitem");
	assert.equal(menu.find((el) => flatten(el).text.join("").startsWith("Move earlier")).props.disabled, true);
	menu.find((el) => flatten(el).text.join("") === "Move later").props.onClick();
	assert.equal(moved, 1);
	assert.equal(button("Changes menu").props["aria-expanded"], false);
	button("Return Changes to the side").props.onClick();
	assert.ok(render().elements.some((el) => el.props.className === "pane-bd dp-side"));
});

const railProps = {
	session: { folder: "C:/project", branch: "feature", environment: "Local" },
	diff: { ok: true, files: [] }, branch: { ok: true, branch: "feature", base: "main", ahead: 1 },
	pr: { ok: true, pr: null }, recentUsd: null,
	onOpenDiff: noop, onCompact: noop, onOpenUrl: noop, onCreatePr: asyncOk, onMergeWhenReady: asyncOk,
};
check("SessionRail labels all-skipped checks as skipped", () => {
	const pr = { number: 7, title: "Fix", state: "OPEN", url: "https://example.test/pull/7", checks: [{ name: "conditional", state: "skip" }] };
	const text = flatten(SessionRail({ ...railProps, pr: { ok: true, pr } })).text.join("");
	assert.ok(text.includes("Checks skipped"));
	assert.ok(!text.includes("Checks passed"));
	pr.checks[0].state = "pass";
	assert.ok(flatten(SessionRail({ ...railProps, pr: { ok: true, pr } })).text.join("").includes("Checks passed"));
});

check("Create PR reports uncommitted files in both panes", () => {
	const message = "Pull request opened. 2 uncommitted files are not in this pull request.";
	const onCreatePr = () => ({ then(run) { run({ ok: true, message, url: "https://example.test/pull/7" }); return { finally: (done) => done() }; } });
	for (const [component, props] of [[DiffPane, diffProps], [SessionRail, railProps]]) {
		const render = renderer(component, { ...props, onCreatePr });
		render().elements.find((node) => node.type === "button" && node.props.children === "Create PR").props.onClick();
		assert.ok(render().text.join("").includes(message));
	}
});

check("The Changes pane offers Create PR again after switching branches", () => {
	const onCreatePr = () => ({ then(run) { run({ ok: true, url: "https://example.test/pull/7" }); return { finally: (done) => done() }; } });
	const props = { ...diffProps, onCreatePr };
	const render = renderer(DiffPane, props);
	commitButton(render(), "Create PR").props.onClick();
	assert.match(render().text.join(""), /Opened #7/);
	props.branch = { ...props.branch, branch: "next-feature" };
	const tree = render();
	assert.ok(commitButton(tree, "Create PR"));
	assert.doesNotMatch(tree.text.join(""), /Opened #7/);
});

check("Merge when ready shows the message the merge reports", () => {
	const { DiffPane: MenuPane } = load("DiffPane.tsx", { window: { innerWidth: 800 } });
	const pr = { number: 7, title: "Fix tax", url: "https://example.test/pull/7", state: "OPEN", isDraft: false, autoMerge: false, checks: [] };
	const onMergeWhenReady = () => ({ then(run) { run({ ok: true, message: "Merged." }); return { finally: (done) => done() }; } });
	const render = renderer(MenuPane, { ...diffProps, pr, comments: [], onMergeWhenReady });
	render().elements.find((node) => node.type === "button" && node.props["aria-label"] === "Pull request menu").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 400 }) } });
	render().elements.find((node) => node.props.role === "menuitem" && flatten(node).text.join("") === "Merge when ready").props.onClick();
	assert.ok(render().text.join("").includes("Merged."));
});

check("FilesPane saves edits typed during a save after that save succeeds, without retrying failures", () => {
	const timers = new Map();
	let nextTimer = 0;
	let saves = 0;
	const { FilesPane: TimedFilesPane } = load("FilesPane.tsx", { window: {
		setTimeout(run) { const id = ++nextTimer; timers.set(id, run); return id; },
		clearTimeout(id) { timers.delete(id); },
	} });
	const props = {
		files: { status: "ready", files: ["a.txt"] }, file: "a.txt", onSelectFile: noop, lineTick: 0,
		open: { status: "ready", text: "base", version: "v1" },
		draft: { text: "first edit", baseText: "base", version: "v1", saving: false },
		readOnly: false, autoSave: true, onAutoSave: noop, onEdit: noop, onSave: () => { saves++; }, onCancel: noop,
		conflict: false, onOverride: noop, onDiscard: noop, onClearRecovery: noop, onFileMenu: noop, onClose: noop,
	};
	const render = renderer(TimedFilesPane, props);
	const fire = () => {
		assert.equal(timers.size, 1);
		const [id, run] = timers.entries().next().value;
		timers.delete(id);
		run();
	};
	render();
	fire();
	props.draft = { ...props.draft, saving: true };
	const savingTree = render();
	assert.equal(savingTree.elements.find((node) => node.props["aria-label"] === "File text").props.readOnly, false);
	props.draft = { ...props.draft, text: "second edit" };
	render();
	assert.equal(timers.size, 0, "typing during a save does not start an overlapping save");
	props.draft = { ...props.draft, baseText: "first edit", version: "v2", saving: false };
	render();
	fire();
	assert.equal(saves, 2, "the successful save re-arms auto save for the later text");
	props.draft = { ...props.draft, saving: true, text: "third edit" };
	render();
	props.draft = { ...props.draft, saving: false };
	render();
	assert.equal(timers.size, 0, "a failed save with the same base does not retry in a loop");
});

check("FilesPane renders the conflict banner and view-only note", () => {
	const props = {
		files: { status: "ready", files: ["a.txt", "b.txt"] }, file: "a.txt", onSelectFile: noop, lineTick: 0,
		open: { status: "ready", text: "one\ntwo\nthree", version: "v1" },
		draft: { text: "one\ntwo\nthree!", baseText: "one\ntwo\nthree", version: "v1" },
		readOnly: true, autoSave: false, onAutoSave: noop, onEdit: noop, onSave: noop, onCancel: noop,
		conflict: true, onOverride: noop, onDiscard: noop, onClearRecovery: noop, onFileMenu: noop, onClose: noop,
	};
	const tree = flatten(FilesPane(props));
	const text = tree.text.join("");
	assert.ok(text.includes("This file changed on disk."));
	assert.ok(text.includes("Override") && text.includes("Discard"));
	assert.ok(text.includes("This file is view-only here."));
	const box = tree.elements.find((el) => el.props["aria-label"] === "File text");
	assert.equal(box.props.readOnly, true);
	assert.equal(box.props.value, "one\ntwo\nthree!");
});

check("FilesPane previews Markdown drafts and switches to Source for edits and line targets", () => {
	const links = [];
	const props = {
		files: { status: "ready", files: ["docs/a.md"] }, file: "docs/a.md", onSelectFile: noop, lineTick: 0,
		open: { status: "ready", text: "# Original", version: "v1" },
		draft: { text: "# Edited", baseText: "# Original", version: "v1" },
		readOnly: false, autoSave: false, onAutoSave: noop, onEdit: noop, onSave: noop, onCancel: noop,
		conflict: false, onOverride: noop, onDiscard: noop, onClearRecovery: noop, onFileMenu: noop, onLink: (href) => links.push(href), onClose: noop,
	};
	const render = renderer(FilesPane, props);
	let tree = render();
	const markdown = tree.elements.find((node) => node.type === "markdown");
	assert.equal(markdown.props.text, "# Edited");
	assert.ok(!tree.elements.some((node) => node.type === "code-editor"));
	markdown.props.onLink("b.md:42", {});
	markdown.props.onLink("#heading", {});
	assert.deepEqual(links, ["docs/b.md:42"]);
	tree.elements.find((node) => node.props.children === "Edit").props.onClick();
	tree = render();
	assert.equal(tree.elements.find((node) => node.type === "code-editor").props.value, "# Edited");
	tree.elements.find((node) => node.props.children === "Preview").props.onClick();
	assert.ok(render().elements.some((node) => node.type === "markdown"));
	props.line = 2;
	props.lineTick++;
	render();
	tree = render();
	assert.ok(tree.elements.some((node) => node.type === "code-editor"));
	assert.ok(!tree.elements.some((node) => node.type === "markdown"));
});

function previewProps(file) {
	return {
		files: { status: "ready", files: [file] }, file, docKey: JSON.stringify(["session", "C:/repo", file]), fileTypes: {}, onSelectFile: noop, lineTick: 0,
		open: { status: "ready", text: "on disk", version: "v1" },
		draft: undefined, readOnly: false, autoSave: false, onAutoSave: noop, onEdit: noop, onSave: noop, onCancel: noop,
		conflict: false, onOverride: noop, onDiscard: noop, onClearRecovery: noop, onFileMenu: noop, onLink: noop, onClose: noop,
	};
}

check("FilesPane previews the current SVG draft as an image and offers Edit", () => {
	const props = previewProps("drawing.svg");
	props.draft = { text: '<svg xmlns="http://www.w3.org/2000/svg"><text>draft & text</text></svg>', baseText: "on disk", version: "v1" };
	const render = renderer(FilesPane, props);
	let tree = render();
	const img = tree.elements.find((node) => node.type === "img");
	assert.equal(img.props.src, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.draft.text)}`);
	assert.equal(img.props.alt, props.file);
	tree.elements.find((node) => node.props.children === "Edit").props.onClick();
	tree = render();
	assert.equal(tree.elements.find((node) => node.type === "code-editor").props.value, props.draft.text);
	assert.ok(!tree.elements.some((node) => node.type === "img"));
});

check("FilesPane opens HTML in the editor and previews its draft in a restricted iframe", () => {
	for (const file of ["index.html", "index.htm"]) {
		const props = previewProps(file);
		props.draft = { text: '<html><script>alert(1)</script><p>draft</p></html>', baseText: "on disk", version: "v1" };
		const render = renderer(FilesPane, props);
		let tree = render();
		assert.ok(tree.elements.some((node) => node.type === "code-editor"));
		assert.ok(!tree.elements.some((node) => node.type === "iframe"));
		tree.elements.find((node) => node.props.children === "Preview").props.onClick();
		tree = render();
		const iframe = tree.elements.find((node) => node.type === "iframe");
		assert.equal(iframe.props.title, file);
		assert.equal(iframe.props.sandbox, "");
		assert.equal(iframe.props.srcDoc, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">${props.draft.text}`);
		assert.ok(tree.text.join("").includes("Scripts are off, and the page loads nothing from the network or from other files."));
		Object.assign(props, previewProps("other.html"));
		assert.ok(!render().elements.some((node) => node.type === "iframe"), "another HTML file starts in the editor immediately");
	}
});

check("FilesPane offers default apps only for allowlisted binary documents and media", () => {
	for (const extension of ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "mp3", "wav", "mp4", "mov", "webm", "exe", "bat", "cmd", "ps1", "vbs", "js", "lnk"]) {
		const props = previewProps(`file.${extension}`);
		props.open = { status: "ready", binary: true };
		const tree = flatten(FilesPane(props));
		const allowed = !["exe", "bat", "cmd", "ps1", "vbs", "js", "lnk"].includes(extension);
		assert.equal(tree.elements.some((node) => node.props.children === "Open in default app"), allowed, extension);
	}
});

async function main() {
	await checkAsync("FilesPane loads images, shows dimensions and bytes, and reloads a changed version", async () => {
		const calls = [];
		const dataUrl = "data:image/png;base64,cG5n";
		const { FilesPane: ImagePane } = load("FilesPane.tsx", { window: { grokCode: { readImage: async (...args) => { calls.push(args); return { ok: true, dataUrl, bytes: 68 }; } } } });
		const props = previewProps("picture.PNG");
		props.open = { status: "ready", binary: true, version: "v1" };
		const render = renderer(ImagePane, props);
		render();
		await Promise.resolve();
		let tree = render();
		assert.deepEqual(calls, [["C:/repo", "picture.PNG"]]);
		const img = tree.elements.find((node) => node.type === "img");
		assert.equal(img.props.src, dataUrl);
		img.props.onLoad({ currentTarget: { naturalWidth: 1200, naturalHeight: 800 } });
		assert.ok(render().text.join("").includes("1200 × 800 · 68 bytes"));
		props.open = { ...props.open, version: "v2" };
		tree = render();
		assert.ok(!tree.elements.some((node) => node.type === "img"), "the old image is hidden while the changed version loads");
		await Promise.resolve();
		assert.equal(render().elements.find((node) => node.type === "img").props.src, dataUrl);
		assert.equal(calls.length, 2);
	});

	await checkAsync("FilesPane ignores an image result after another file is selected", async () => {
		const pending = new Map();
		const { FilesPane: ImagePane } = load("FilesPane.tsx", { window: { grokCode: { readImage: (_cwd, file) => new Promise((resolve) => pending.set(file, resolve)) } } });
		const props = previewProps("first.png");
		props.open = { status: "ready", binary: true, version: "v1" };
		const render = renderer(ImagePane, props);
		render();
		Object.assign(props, previewProps("second.png"), { open: { status: "ready", binary: true, version: "v1" } });
		render();
		pending.get("second.png")({ ok: true, dataUrl: "data:image/png;base64,c2Vjb25k", bytes: 6 });
		await Promise.resolve();
		assert.equal(render().elements.find((node) => node.type === "img").props.src, "data:image/png;base64,c2Vjb25k");
		pending.get("first.png")({ ok: true, dataUrl: "data:image/png;base64,Zmlyc3Q=", bytes: 5 });
		await Promise.resolve();
		assert.equal(render().elements.find((node) => node.type === "img").props.src, "data:image/png;base64,c2Vjb25k");
	});

	await checkAsync("FilesPane shows image read and decode errors in a note", async () => {
		let result = { ok: false, error: "That image is too large to show here." };
		const { FilesPane: ImagePane } = load("FilesPane.tsx", { window: { grokCode: { readImage: async () => result } } });
		const props = previewProps("broken.png");
		props.open = { status: "ready", binary: true, version: "v1" };
		const render = renderer(ImagePane, props);
		render();
		await Promise.resolve();
		assert.ok(render().text.join("").includes(result.error));
		result = { ok: true, dataUrl: "data:image/png;base64,aW52YWxpZA==", bytes: 7 };
		props.open.version = "v2";
		render();
		await Promise.resolve();
		render().elements.find((node) => node.type === "img").props.onError();
		assert.ok(render().text.join("").includes("That image could not be shown."));
	});

	await checkAsync("FilesPane opens an allowlisted file in its session folder and reports host errors", async () => {
		const calls = [];
		const { FilesPane: DocumentPane } = load("FilesPane.tsx", { window: { grokCode: { openIn: async (payload) => { calls.push(payload); return { ok: false, error: "No default app is available." }; } } } });
		const props = previewProps("report.pdf");
		props.open = { status: "ready", binary: true };
		const render = renderer(DocumentPane, props);
		render().elements.find((node) => node.props.children === "Open in default app").props.onClick();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].target, "explorer");
		assert.equal(calls[0].cwd, "C:/repo");
		assert.equal(calls[0].file, "report.pdf");
		assert.ok(render().text.join("").includes("No default app is available."));
	});

	await checkAsync("Revert asks for the captured file and restores it only on yes", async () => {
		for (const yes of [false, true]) {
			const questions = [];
			const reverted = [];
			const { DiffPane: ConfirmPane } = load("DiffPane.tsx", { window: { innerWidth: 800, confirm: (question) => { questions.push(question); return yes; } } });
			const props = {
				...diffProps, scope: "uncommitted", comments: [],
				snapshot: { ok: true, files: [...diffProps.snapshot.files, { path: "src/b.ts", hunks: [] }] },
				onRevert: async (file) => { reverted.push(file); return { ok: true }; },
			};
			const render = renderer(ConfirmPane, props);
			render().elements.find((node) => node.type === "button" && node.props["aria-label"] === "Changes menu").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 400 }) } });
			render().elements.find((node) => node.props.role === "menuitem" && flatten(node).text.join("") === "Revert file…").props.onClick();
			assert.deepEqual(questions, ["Revert src/a.ts?\n\nThis puts the file back as it was at the last commit. This cannot be undone."]);
			assert.deepEqual(reverted, [], "revert waits for the answer promise");
			props.selectedFile = "src/b.ts";
			assert.ok(!render().elements.some((node) => node.props.role === "menu"), "the menu closes before asking");
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(reverted, yes ? ["src/a.ts"] : []);
			assert.equal(render().text.join("").includes("Restored src/a.ts to the last commit."), yes);
		}
	});
	await checkAsync("Hunk revert confirms the exact range and captures the file and hunk until the reply", async () => {
		const change = { ...hunk, revertible: true };
		let finish;
		const rig = hunkRig(change, () => new Promise((resolve) => { finish = resolve; }));
		rig.press();
		const ask = rig.asks[0];
		assert.equal(ask.title, "Revert this change?");
		assert.equal(ask.body, "Lines 10-13 of src/a.ts go back to how they are in the index. The app can't undo this.");
		assert.equal(ask.ok, "Revert");
		assert.equal(ask.danger, true);
		assert.deepEqual(rig.calls, []);
		ask.resolve(false);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(rig.calls, [], "Cancel leaves the file alone");
		assert.equal(rig.refreshes(), 0);
		rig.press();
		rig.props.selectedFile = "src/b.ts";
		rig.props.snapshot = { ok: true, files: [{ path: "src/b.ts", hunks: [{ ...change, id: "later", loc: "@@ -1 +1 @@" }] }] };
		rig.asks[1].resolve(true);
		await Promise.resolve();
		assert.equal(rig.calls.length, 1);
		assert.equal(rig.calls[0][0], "src/a.ts");
		assert.equal(rig.calls[0][1], change, "the confirmation sends the original hunk content");
		assert.equal(commitButton(rig.render(), "Revert this change").props.disabled, true);
		assert.equal(rig.refreshes(), 0, "refresh waits for the host reply");
		finish({ ok: true });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(rig.refreshes(), 1);
		assert.ok(rig.render().text.join("").includes("Restored this change in src/a.ts to its indexed version."));
	});
	await checkAsync("Hunk revert reports failures and refreshes, and deletion-only ranges name their insertion anchor", async () => {
		for (const result of [{ ok: false, error: "This change is no longer in the file. Refresh, then try again." }, null]) {
			const rig = hunkRig({ ...hunk, revertible: true }, async () => { if (!result) { throw new Error("Bridge closed"); } return result; });
			rig.press();
			rig.asks[0].resolve(true);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(rig.refreshes(), 1);
			assert.ok(rig.render().text.join("").includes(result?.error ?? "That change could not be restored."));
			assert.equal(commitButton(rig.render(), "Revert this change").props.disabled, false);
		}
		for (const start of [0, 10]) {
			const rig = hunkRig({ ...hunk, revertible: true, loc: `@@ -${start + 1},2 +${start},0 @@`, lines: [{ kind: "del", text: "removed" }] });
			rig.press();
			assert.equal(rig.asks[0].body, `Lines ${start}-${start} of src/a.ts go back to how they are in the index. The app can't undo this. The deleted lines are restored ${start === 0 ? "before the first line" : "after line 10"}.`);
			rig.asks[0].resolve(false);
		}
	});
	await checkAsync("Commit and Commit and push name the checked files, even when every file is checked", async () => {
		const fixed = [
			{ title: "Commit 3 files?" },
			{ title: "Commit 3 files and push?" },
		];
		const fixedRequests = [
			"Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `src/a.ts`, `src/b.ts`, `src/c.ts`. Don't push.",
			"Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `src/a.ts`, `src/b.ts`, `src/c.ts`. Then push the branch.",
		];
		const rig = commitRig(pickProps);
		await rig.press("Commit");
		await rig.press("Commit and push");
		assert.deepEqual(rig.asks, fixed);
		assert.deepEqual(rig.requests, fixedRequests);

		rig.toggle("src/b.ts");
		assert.equal(pickBox(rig.render(), "src/b.ts").props.checked, false);
		await rig.press("Commit");
		assert.equal(pickBox(rig.render(), "src/b.ts").props.checked, true, "after a commit request the files left out start checked again");
		rig.toggle("src/b.ts");
		await rig.press("Commit and push");
		assert.deepEqual(rig.asks.slice(2), [
			{ title: "Commit 2 files?" },
			{ title: "Commit 2 files and push?" },
		]);
		assert.deepEqual(rig.requests.slice(2), [
			"Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `src/a.ts`, `src/c.ts`. Don't push.",
			"Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `src/a.ts`, `src/c.ts`. Then push the branch.",
		]);

		rig.toggle("src/a.ts");
		rig.toggle("src/b.ts");
		assert.equal((await rig.press("Commit")).ask.title, "Commit 1 file?");
		assert.ok(rig.requests.at(-1).includes(": `src/c.ts`. Don't push."));

		const before = rig.asks.length;
		await rig.press("Commit");
		await rig.press("Commit and push");
		assert.deepEqual(rig.asks.slice(before), fixed, "with every file checked again, the fixed questions return");
		assert.deepEqual(rig.requests.slice(before), fixedRequests, "with every file checked again, every file is named");
	});
	await checkAsync("A file that appears later is included, and an unchecked file that left the list counts for nothing", async () => {
		const rig = commitRig(pickProps);
		rig.toggle("src/b.ts");
		rig.props.snapshot = { ok: true, files: [...pickFiles, { path: "src/d.ts", additions: 1, deletions: 0, hunks: [hunk] }] };
		assert.equal(pickBox(rig.render(), "src/d.ts").props.checked, true);
		const added = await rig.press("Commit");
		assert.equal(added.ask.title, "Commit 3 files?");
		assert.ok(added.request.includes(": `src/a.ts`, `src/c.ts`, `src/d.ts`. Don't push."));
		rig.props.snapshot = { ok: true, files: [pickFiles[0], pickFiles[2]] };
		const gone = await rig.press("Commit and push");
		assert.equal(gone.ask.title, "Commit 2 files and push?");
		assert.equal(gone.request, "Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `src/a.ts`, `src/c.ts`. Then push the branch.");
	});
	await checkAsync("A renamed file is named by its old and new path", async () => {
		const renamed = { path: "src/new.ts", from: "src/old.ts", additions: 0, deletions: 0, hunks: [hunk] };
		const rig = commitRig({ ...pickProps, snapshot: { ok: true, files: [renamed, ...pickFiles] } });
		rig.toggle("src/b.ts");
		assert.ok(pickBox(rig.render(), "src/new.ts"), "the row is labelled with the new path");
		const asked = await rig.press("Commit");
		assert.equal(asked.ask.title, "Commit 3 files?");
		assert.equal(asked.request, "Commit only these files in this repository with a clear commit message, and leave the other changes uncommitted: `src/old.ts`, `src/new.ts`, `src/a.ts`, `src/c.ts`. Don't push.");
	});
	await checkAsync("Direct commit captures checked rename paths, trims the message and locks the dialog until it refreshes", async () => {
		const renamed = { path: "src/new.ts", from: "src/old.ts", hunks: [hunk] };
		for (const push of [false, true]) {
			let finish;
			const rig = commitRig({ ...pickProps, snapshot: { ok: true, files: [renamed, ...pickFiles] }, onCommit: () => new Promise((resolve) => { finish = resolve; }) });
			rig.toggle("src/b.ts");
			const label = push ? "Commit and push" : "Commit";
			rig.open(label);
			rig.props.snapshot = { ok: true, files: [...pickFiles, { path: "later.ts", hunks: [] }] };
			rig.toggle("src/a.ts");
			rig.message("  Summary\n\nDetails  ");
			modalButton(rig.render(), label).props.onClick();
			assert.deepEqual(rig.commits, [{ paths: ["src/old.ts", "src/new.ts", "src/a.ts", "src/c.ts"], message: "Summary\n\nDetails", push }]);
			let tree = rig.render();
			assert.ok(modalButton(tree, push ? "Pushing…" : "Committing…"));
			assert.ok(modalTree(tree).elements.filter((el) => el.type === "button").every((el) => el.props.disabled));
			assert.equal(modalTree(tree).elements.find((el) => el.type === "textarea").props.disabled, true);
			let stopped = false;
			tree.elements.find((el) => el.props["data-commit-dialog"]).props.onKeyDown({ key: "Escape", nativeEvent: {}, preventDefault() {}, stopPropagation() { stopped = true; } });
			assert.equal(stopped, true);
			assert.ok(commitModal(rig.render()), "Escape cannot close an in-flight commit");
			assert.equal(rig.refreshes(), 0);
			finish({ ok: true, committed: true, message: "Host commit result." });
			await new Promise((resolve) => setImmediate(resolve));
			tree = rig.render();
			assert.equal(commitModal(tree), undefined);
			assert.equal(rig.refreshes(), 1);
			assert.ok(pickBoxes(tree).every((el) => el.props.checked), "a landed commit clears exclusions");
			assert.ok(!tree.text.join("").includes("Host commit result."), "the pane leaves commit result notices to App");
		}
	});
	await checkAsync("A failed commit keeps the draft and shows the error, while a landed push failure closes the dialog", async () => {
		for (const outcome of [{ ok: false, error: "Hook refused." }, { ok: false, committed: true, error: "Push refused." }, null]) {
			const rig = commitRig({ ...pickProps, onCommit: async () => { if (!outcome) { throw new Error("Bridge closed."); } return outcome; } });
			rig.toggle("src/b.ts");
			rig.open("Commit and push");
			rig.message("Summary");
			modalButton(rig.render(), "Commit and push").props.onClick();
			await new Promise((resolve) => setImmediate(resolve));
			const tree = rig.render();
			assert.equal(pickBox(tree, "src/b.ts").props.checked, outcome?.committed === true);
			assert.equal(rig.refreshes(), 1, "every host result or rejection refreshes the pane");
			if (outcome?.committed) {
				assert.equal(commitModal(tree), undefined);
			} else {
				const alert = () => modalTree(rig.render()).elements.find((el) => el.props.role === "alert");
				assert.equal(modalTree(tree).elements.find((el) => el.type === "textarea").props.value, "Summary");
				assert.equal(alert().props.children, outcome?.error ?? "The commit could not be checked. Refresh to see what happened.");
				modalButton(tree, "Commit and push").props.onClick();
				assert.equal(alert(), undefined, "a retry clears the previous error");
				await new Promise((resolve) => setImmediate(resolve));
				assert.ok(alert());
				rig.message("New summary");
				assert.equal(alert(), undefined, "editing clears the previous error");
			}
		}
	});
	await checkAsync("Sandbox commit explains host limits and the hook opt-in resets each time", async () => {
		const rig = commitRig({ ...pickProps, sandboxGit: true, onCommit: async () => ({ ok: true, committed: true }) });
		for (const hooks of [true, false]) {
			rig.open("Commit and push");
			const modal = modalTree(rig.render());
			assert.match(modal.text.join(""), /Git hooks are off by default.*\.grok.*\.mcp\.json.*Dev server Start/);
			assert.match(modal.text.join(""), /With hooks off, a push can skip uploading Git LFS files/);
			const checkbox = modal.elements.find((el) => el.type === "input" && el.props.type === "checkbox");
			assert.equal(checkbox.props.checked, false);
			if (hooks) { checkbox.props.onChange({ target: { checked: true } }); }
			rig.message("Review changes");
			modalButton(rig.render(), "Commit and push").props.onClick();
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(rig.commits.at(-1).sandbox, true);
			assert.equal(rig.commits.at(-1).hooks, hooks);
		}
	});
	await checkAsync("Commit dialog keys stay isolated from review, comment-send and window shortcuts", async () => {
		let sentComments = 0;
		let windowKeys = 0;
		const rig = commitRig({ ...pickProps, busy: true, comments: diffProps.comments, onSendComments: () => { sentComments++; } });
		rig.render().elements.find((el) => el.props["aria-label"] === "Review in a large view").props.onClick();
		const key = (value, ctrlKey = false) => {
			const tree = rig.render();
			let stopped = false;
			const event = { key: value, ctrlKey, nativeEvent: {}, target: { tagName: "TEXTAREA" }, preventDefault() {}, stopPropagation() { stopped = true; } };
			tree.elements.find((el) => el.props["data-commit-dialog"]).props.onKeyDown(event);
			if (!stopped) { tree.elements.find((el) => el.type === "section").props.onKeyDown(event); }
			if (!stopped) { windowKeys++; }
			assert.equal(stopped, true);
		};
		rig.open("Commit");
		key("x");
		key("Enter", true);
		assert.equal(sentComments, 0);
		assert.deepEqual(rig.commits, []);
		key("Escape");
		assert.equal(commitModal(rig.render()), undefined);
		assert.ok(rig.render().elements.some((el) => el.props.className === "pane fp-expanded dp-review"), "Escape closes the dialog and leaves review mode open");
		rig.props.busy = false;
		rig.open("Commit");
		rig.message("Keyboard commit");
		key("Enter", true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(rig.commits.length, 1);
		assert.equal(sentComments, 0);
		assert.equal(windowKeys, 0);
	});
	if (failures > 0) {
		console.log(`${failures} check(s) failed`);
		process.exitCode = 1;
		return;
	}
	console.log("All diff and files pane checks passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
