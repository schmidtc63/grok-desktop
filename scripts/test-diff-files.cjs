const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

// Hooks stub: enough to render a component once and read the element tree. Effects never run.
const react = {
	Fragment: "fragment",
	useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
	useRef(value) { return { current: value }; },
	useMemo(fn) { return fn(); },
	useEffect() {},
};
const jsx = (type, props) => ({ type, props: props ?? {} });

function load(name) {
	const file = path.join(__dirname, "..", "src", name);
	const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
	const module = { exports: {} };
	const imports = (id) => {
		if (id === "react") { return react; }
		if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
		throw new Error(`Unexpected import ${id}`);
	};
	vm.runInNewContext(source, { require: imports, module, exports: module.exports }, { filename: file });
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

const { numberLines, checksSummary, DiffPane } = load("DiffPane.tsx");
const filesPane = load("FilesPane.tsx");
const { shouldAutoSave, FilesPane } = filesPane;
// The vm realm has its own Object prototype; copy results into this realm so deepEqual compares values only.
const lineOffsets = (text, line) => ({ ...filesPane.lineOffsets(text, line) });

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

const lf = "alpha\nbeta\ngamma";
check("lineOffsets finds the first line", () => assert.deepEqual(lineOffsets(lf, 1), { start: 0, end: 5 }));
check("lineOffsets finds a middle line", () => assert.deepEqual(lineOffsets(lf, 2), { start: 6, end: 10 }));
check("lineOffsets finds the last line", () => assert.deepEqual(lineOffsets(lf, 3), { start: 11, end: 16 }));
check("lineOffsets clamps past the end to the last line", () => assert.deepEqual(lineOffsets(lf, 99), { start: 11, end: 16 }));
check("lineOffsets drops the CR of CRLF text", () => {
	const crlf = "alpha\r\nbeta\r\ngamma";
	assert.deepEqual(lineOffsets(crlf, 2), { start: 7, end: 11 });
	assert.equal(crlf.slice(7, 11), "beta");
	assert.deepEqual(lineOffsets(crlf, 3), { start: 13, end: 18 });
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

check("DiffPane shows an existing pull request with state and checks", () => {
	const pr = { number: 7, title: "Fix tax", url: "https://example.test/pull/7", state: "OPEN", isDraft: true, autoMerge: false, checks: [{ name: "a", state: "pass" }, { name: "b", state: "run" }] };
	const text = flatten(DiffPane({ ...diffProps, pr, comments: [] })).text.join("");
	assert.ok(text.includes("PR #7 Fix tax"));
	assert.ok(text.includes("Draft"));
	assert.ok(text.includes("1 passed · 1 running"));
	assert.ok(!text.includes("Send to Grok"));
});

check("FilesPane renders the conflict banner, gutter and view-only note", () => {
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
	const gutter = tree.elements.find((el) => el.props.className === "fp-gutter");
	assert.equal(gutter.props.children, "1\n2\n3");
	const box = tree.elements.find((el) => el.props["aria-label"] === "File text");
	assert.equal(box.props.readOnly, true);
	assert.equal(box.props.value, "one\ntwo\nthree!");
});

if (failures > 0) {
	console.log(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("All diff and files pane checks passed");
