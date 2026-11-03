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
		const index = hooks.cursor++;
		const previous = hooks.values[index];
		if (!previous || !dependencies || dependencies.some((value, offset) => value !== previous[offset])) { hooks.effects.push(run); }
		hooks.values[index] = dependencies;
	},
};
const jsx = (type, props) => ({ type, props: props ?? {} });

function load(name, globals = {}) {
	const file = path.join(__dirname, "..", "src", name);
	const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
	const module = { exports: {} };
	const imports = (id) => {
		if (id === "react") { return react; }
		if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
		if (id === "./confirm") { return load("confirm.ts", globals); }
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
	if (typeof node.type === "function") { return flatten(node.type(node.props), out); }
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
	snapshot: { ok: true, files: [{ path: "src/a.ts", additions: 2, deletions: 1, hunks: [hunk] }] },
	scope: "branch", onScope: noop, commits: [{ sha: "abc123", short: "abc123", subject: "Fix" }],
	selectedFile: "src/a.ts", onSelectFile: noop, onRefresh: noop, onRevert: asyncOk,
	comments: [{ id: "c1", file: "src/a.ts", line: 11, side: "new", text: "Why?" }],
	onAddComment: noop, onRemoveComment: noop, onSendComments: noop,
	branch: { branch: "feature", base: "main", ahead: 2 }, pr: null,
	onCreatePr: asyncOk, onMergeWhenReady: asyncOk, onOpenFile: noop, onFileMenu: noop, onClose: noop,
};

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
		const item = render().elements.find((node) => node.props.role === "menuitem" && node.props.children === "Revert file…");
		assert.equal(item.props.disabled, scope !== "uncommitted");
		assert.equal(item.props.title, scope !== "uncommitted" ? "Switch to Uncommitted changes to revert a file" : undefined);
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

check("Merge when ready shows the message the merge reports", () => {
	const { DiffPane: MenuPane } = load("DiffPane.tsx", { window: { innerWidth: 800 } });
	const pr = { number: 7, title: "Fix tax", url: "https://example.test/pull/7", state: "OPEN", isDraft: false, autoMerge: false, checks: [] };
	const onMergeWhenReady = () => ({ then(run) { run({ ok: true, message: "Merged." }); return { finally: (done) => done() }; } });
	const render = renderer(MenuPane, { ...diffProps, pr, comments: [], onMergeWhenReady });
	render().elements.find((node) => node.type === "button" && node.props["aria-label"] === "Pull request menu").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 400 }) } });
	render().elements.find((node) => node.props.role === "menuitem" && node.props.children === "Merge when ready").props.onClick();
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

async function main() {
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
			render().elements.find((node) => node.props.role === "menuitem" && node.props.children === "Revert file…").props.onClick();
			assert.deepEqual(questions, ["Revert src/a.ts?\n\nThis puts the file back as it was at the last commit. This cannot be undone."]);
			assert.deepEqual(reverted, [], "revert waits for the answer promise");
			props.selectedFile = "src/b.ts";
			assert.ok(!render().elements.some((node) => node.props.role === "menu"), "the menu closes before asking");
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(reverted, yes ? ["src/a.ts"] : []);
			assert.equal(render().text.join("").includes("Restored src/a.ts to the last commit."), yes);
		}
	});
	if (failures > 0) {
		console.log(`${failures} check(s) failed`);
		process.exitCode = 1;
		return;
	}
	console.log("All diff and files pane checks passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
