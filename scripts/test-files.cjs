const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { execFileSync } = childProcess;
const { createHash } = require("crypto");
const { listFiles, readText, readImage, writeText, runCommand } = require("../electron/files.cjs");
const { readDiff, parseUnified, revertFile } = require("../electron/diff.cjs");

// macOS puts the temp folder behind the /var symlink and the GitHub Windows runner names it with a short 8.3 name (RUNNER~1),
// while the modules report git's real, full paths. The native realpath resolves both.
const tempBase = path.resolve(fs.realpathSync.native(os.tmpdir()),process.env.CODEX_THREAD_ID || "codex-grokcode-files");
fs.mkdirSync(tempBase, { recursive: true });
const root = fs.mkdtempSync(path.join(tempBase, "codex-files-"));
const depthRoot = fs.mkdtempSync(path.join(tempBase, "codex-depth-"));
const nativeExec = childProcess.execFileSync;
const nativeExecFile = childProcess.execFile;
const nativeWrite = fs.writeFileSync;
if (process.platform === "win32") {
	childProcess.execFile = (command, args, options, callback) => {
		if (options?.env?.GROK_SAVE_TEMP) {
			assert.equal(options.windowsHide, true);
			assert.equal(options.timeout, 8000);
			setImmediate(() => {
				try {
					if (args.at(-1).includes("CreateNew")) { nativeWrite(options.env.GROK_SAVE_TEMP, "", { flag: "wx" }); }
					else { fs.renameSync(options.env.GROK_SAVE_TEMP, options.env.GROK_SAVE_TARGET); }
					callback(null, "", "");
				} catch (error) { callback(error); }
			});
			return;
		}
		return nativeExecFile(command, args, options, callback);
	};
}

function git(args, cwd = root) {
	return execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", stdio: "pipe" });
}

function write(file, text) {
	fs.writeFileSync(path.join(root, file), text);
}

function read(file) {
	return fs.readFileSync(path.join(root, file), "utf8");
}

async function checkRepoFiles() {
	const folder = path.join(root, "codex-listing");
	fs.mkdirSync(folder);
	git(["init", "--quiet"], folder);
	git(["config", "core.autocrlf", "false"], folder);
	const put = (file, text = "file\n") => {
		const target = path.join(folder, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	};
	put(".gitignore", "ignored.txt\nignored-folder/\n");
	put("tracked.txt");
	put("deleted.txt");
	put("tracked-image.PNG");
	put("tracked-sheet.xlsx");
	put("tool.exe");
	put("vector.svg");
	const deep = "nested/one/two/three/four/five/six/seven/deep.txt";
	put(deep);
	git(["add", "--all"], folder);
	git(["-c", "user.name=GrokCode test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Listing"], folder);
	fs.unlinkSync(path.join(folder, "deleted.txt"));
	for (const name of ["untracked.txt", "space name.txt", "café.txt", "ignored.txt", "ignored-folder/visible.txt", "node_modules/pkg/index.js", "nested/dist/generated.txt", "untracked-image.png", "untracked-sheet.XLSX"]) { put(name); }
	const listed = await listFiles(folder);
	assert.equal(listed.ok, true);
	assert.equal(listed.truncated, false);
	assert.deepEqual(listed.files, [".gitignore", "tracked.txt", deep, "untracked.txt", "space name.txt", "café.txt", "vector.svg", "tracked-image.PNG", "tracked-sheet.xlsx", "untracked-image.png", "untracked-sheet.XLSX"].sort());
	assert.deepEqual((await listFiles(path.join(folder, "nested"))).files, [deep.slice("nested/".length)], "subfolder paths are relative to the chosen folder");
	assert.deepEqual((await listFiles(path.join(folder, "ignored-folder"))).files, ["visible.txt"], "an empty ignored git listing falls back to the walk");
	const plain = path.join(depthRoot, "codex-plain");
	fs.mkdirSync(plain);
	fs.writeFileSync(path.join(plain, "plain.txt"), "plain\n");
	for (const name of ["image.PNG", "sheet.xlsx", "vector.svg", "tool.exe"]) { fs.writeFileSync(path.join(plain, name), "file\n"); }
	assert.deepEqual((await listFiles(plain)).files, ["image.PNG", "plain.txt", "sheet.xlsx", "vector.svg"], "the walk includes previewable binaries case-insensitively and still skips executables");
	const outside = path.join(depthRoot, "codex-outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
	fs.symlinkSync(outside, path.join(plain, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
	const linked = path.join(depthRoot, "codex-linked-plain");
	fs.symlinkSync(plain, linked, process.platform === "win32" ? "junction" : "dir");
	assert.deepEqual((await listFiles(linked)).files, ["image.PNG", "plain.txt", "sheet.xlsx", "vector.svg"], "a linked root is listed without following a junction outside that root");
	const timed = await listFiles(plain, 0);
	assert.equal(timed.ok, true);
	assert.equal(timed.truncated, true, "a zero walk budget stops without throwing");
	assert.deepEqual(timed.files, []);
	const names = [];
	for (let index = 0; index < 5001; index++) {
		const name = `dir-${index % 10}/file-${String(index).padStart(4, "0")}-${"x".repeat(24)}.txt`;
		names.push(name);
		put(`many/${name}`);
	}
	const capped = await listFiles(path.join(folder, "many"));
	assert.equal(capped.ok, true);
	assert.equal(capped.truncated, true);
	assert.deepEqual(capped.files, names.sort().slice(0, 5000), "repository listings keep 5000 alphabetically sorted files beyond the old byte limit");
	const walkMany = path.join(plain, "many");
	fs.mkdirSync(walkMany);
	for (let index = 0; index < 6000; index++) { fs.writeFileSync(path.join(walkMany, `file-${String(index).padStart(4, "0")}.txt`), "file\n"); }
	const walkCapped = await listFiles(walkMany);
	assert.equal(walkCapped.ok, true);
	assert.equal(walkCapped.truncated, true);
	assert.equal(walkCapped.files.length, 5000, "the asynchronous walk keeps 5000 of 6000 text files");
	console.log("PASS repository and plain-folder files: ignores, binary extensions, SVG, containment, budgets and 5000-file caps");
}

async function main() {
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=", "base64");
	write("preview.PNG", png);
	assert.deepEqual(readImage(root, "preview.PNG"), { ok: true, dataUrl: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length });
	write("preview.ico", Buffer.from([0, 0, 1, 0]));
	assert.ok(readImage(root, "preview.ico").dataUrl.startsWith("data:image/x-icon;base64,"));
	write("preview.txt", "not an image");
	assert.equal(readImage(root, "preview.txt").error, "That file is not an image.");
	write("large-image.png", "");
	fs.truncateSync(path.join(root, "large-image.png"), 300 * 1024);
	const firstImage = readText(root, "large-image.png");
	assert.equal(firstImage.ok, true);
	assert.equal(firstImage.binary, true, "image metadata bypasses the editor's 200 KiB text limit");
	assert.equal(typeof firstImage.version, "string");
	fs.truncateSync(path.join(root, "large-image.png"), 20 * 1024 * 1024 + 1);
	assert.notEqual(readText(root, "large-image.png").version, firstImage.version);
	assert.equal(readImage(root, "large-image.png").error, "That image is too large to show here.");
	fs.unlinkSync(path.join(root, "large-image.png"));
	const outsideImage = path.join(depthRoot, "outside.png");
	fs.writeFileSync(outsideImage, png);
	assert.equal(readImage(root, path.relative(root, outsideImage)).error, "That file is not in this folder.");
	let linkedImage = false;
	try {
		fs.symlinkSync(outsideImage, path.join(root, "outside-link.png"), "file");
		linkedImage = true;
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EACCES") { throw error; }
		console.log("SKIP file symlink image check: platform permission unavailable");
	}
	if (linkedImage) {
		assert.equal(readImage(root, "outside-link.png").error, "That file is not in this folder.");
		fs.unlinkSync(path.join(root, "outside-link.png"));
	}
	console.log("PASS image reads: real PNG, ICO MIME, extension and size limits, binary metadata, outside paths and symlinks");

	git(["init", "--quiet"]);
	git(["config", "core.autocrlf", "false"]);
	write("report[1].txt", "selected original\n");
	write("report1.txt", "other original\n");
	write("binary.bin", Buffer.from([0, 1, 2]));
	write("old name.txt", "rename content\n");
	git(["add", "--all"]);
	git(["-c", "user.name=GrokCode test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);

	write("report[1].txt", "selected dirty\n");
	write("report1.txt", "other dirty\n");
	assert.equal((await revertFile(root, "report[1].txt")).ok, true);
	assert.equal(read("report[1].txt"), "selected original\n");
	assert.equal(read("report1.txt"), "other dirty\n");
	write("new.txt", "staged content\n");
	git(["add", "--", "new.txt"]);
	write("new.txt", "newer unstaged content\n");
	assert.equal((await revertFile(root, "new.txt")).ok, false);
	assert.equal(read("new.txt"), "newer unstaged content\n");
	assert.equal(git(["ls-files", "--", "new.txt"]).trim(), "new.txt");
	console.log("PASS CR01/CR15: literal revert preserves neighboring work and staged additions");

	const legacy = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
	write("legacy.txt", legacy);
	assert.equal(readText(root, "legacy.txt").ok, false);
	assert.equal((await writeText(root, "legacy.txt", "replacement", createHash("sha256").update(legacy).digest("hex"))).ok, false);
	assert.deepEqual(fs.readFileSync(path.join(root, "legacy.txt")), legacy);
	write("editor.txt", "\ufeffcafé\r\n");
	let loaded = readText(root, "editor.txt");
	assert.equal(loaded.ok, true);
	assert.equal(loaded.text, "\ufeffcafé\r\n");
	assert.equal(typeof loaded.version, "string");
	write("editor.txt", "agent changed it\n");
	assert.equal((await writeText(root, "editor.txt", "stale buffer", loaded.version)).ok, false);
	assert.equal(read("editor.txt"), "agent changed it\n");
	loaded = readText(root, "editor.txt");
	const pendingSave = writeText(root, "editor.txt", "fresh save\n", loaded.version);
	assert.equal(typeof pendingSave.then, "function", "saving yields while native work is pending");
	if (process.platform === "win32") { assert.equal(read("editor.txt"), "agent changed it\n", "the editor remains available before the async save completes"); }
	const saved = await pendingSave;
	assert.equal(saved.ok, true);
	assert.equal(readText(root, "editor.txt").version, saved.version);
	const originalWrite = fs.writeFileSync;
	const originalRename = fs.renameSync;
	const prior = read("editor.txt");
	try {
		fs.writeFileSync = (file, text, options) => {
			if (typeof file === "number") {
				originalWrite(file, "PARTIAL", "utf8");
				throw Object.assign(new Error("Injected storage exhaustion"), { code: "ENOSPC" });
			}
			return originalWrite(file, text, options);
		};
		assert.equal((await writeText(root, "editor.txt", "should not replace original", saved.version)).ok, false);
	} finally {
		fs.writeFileSync = originalWrite;
	}
	assert.equal(read("editor.txt"), prior, "a partial temporary write preserves original bytes");
	assert.equal(fs.readdirSync(root).some((name) => name.includes(".grok-save-")), false);
	if (process.platform === "win32") {
		const simulatedExec = childProcess.execFile;
		try {
			childProcess.execFile = (command, args, options, callback) => {
				if (options?.env?.GROK_SAVE_TEMP) { callback(Object.assign(new Error("Injected native staging failure"), { code: "EACCES" })); return; }
				return simulatedExec(command, args, options, callback);
			};
			assert.equal((await writeText(root, "editor.txt", "should not replace original", saved.version)).ok, false);
		} finally {
			childProcess.execFile = simulatedExec;
		}
		assert.equal(read("editor.txt"), prior, "failed secure staging preserves original bytes");
	}
	try {
		fs.renameSync = () => { throw Object.assign(new Error("Injected replacement failure"), { code: "EACCES" }); };
		assert.equal((await writeText(root, "editor.txt", "should not replace original", saved.version)).ok, false);
	} finally {
		fs.renameSync = originalRename;
	}
	assert.equal(read("editor.txt"), prior, "failed replacement preserves original bytes");
	assert.equal(fs.readdirSync(root).some((name) => name.includes(".grok-save-")), false);
	try {
		fs.writeFileSync = (file, text, options) => {
			const result = originalWrite(file, text, options);
			if (typeof file === "number") { originalWrite(path.join(root, "editor.txt"), "new concurrent edit\n", "utf8"); }
			return result;
		};
		assert.equal((await writeText(root, "editor.txt", "should not replace concurrent edit", saved.version)).ok, false);
	} finally {
		fs.writeFileSync = originalWrite;
	}
	assert.equal(read("editor.txt"), "new concurrent edit\n", "version is rechecked immediately before replacement");
	assert.equal(fs.readdirSync(root).some((name) => name.includes(".grok-save-")), false);
	assert.equal((await writeText(root, "editor.txt", "missing version")).ok, false);
	fs.unlinkSync(path.join(root, "editor.txt"));
	assert.equal((await writeText(root, "editor.txt", "deleted stale buffer", saved.version)).ok, false);
	assert.equal(fs.existsSync(path.join(root, "editor.txt")), false);
	console.log("PASS CR04/CR06: stale/missing saves and legacy encodings are rejected; UTF-8 save versions round-trip");

	const deepFolder = path.join(depthRoot, "one", "two", "three", "four", "five", "six", "seven");
	fs.mkdirSync(deepFolder, { recursive: true });
	fs.writeFileSync(path.join(deepFolder, "deep.txt"), "past the file tree limit\n");
	fs.mkdirSync(path.join(depthRoot, "z"));
	fs.writeFileSync(path.join(depthRoot, "z", "late.txt"), "after the deep folder\n");
	const deepFiles = await listFiles(depthRoot);
	assert.equal(deepFiles.ok, true);
	assert.equal(deepFiles.truncated, true, "a file below depth 6 triggers the left-out note");
	assert.equal(deepFiles.files.includes("one/two/three/four/five/six/seven/deep.txt"), false);
	assert.equal(deepFiles.files.includes("z/late.txt"), true, "folders after a too-deep one are still listed");
	console.log("PASS R19: the file tree reports files omitted beyond its depth limit");

	write("binary.bin", Buffer.from([0, 4, 5]));
	git(["mv", "--", "old name.txt", "renamed name.txt"]);
	let snapshot = await readDiff(root);
	assert.equal(snapshot.ok, true);
	assert.equal(snapshot.truncated, false);
	const binary = snapshot.files.find((file) => file.path === "binary.bin");
	const renamed = snapshot.files.find((file) => file.path === "renamed name.txt");
	assert.ok(binary);
	assert.ok(binary.hunks.some((hunk) => hunk.lines.some((line) => line.text === "Binary file")));
	assert.ok(renamed);
	assert.ok(renamed.hunks.some((hunk) => hunk.lines.some((line) => line.text === "Renamed from old name.txt")));
	const oldTextId = snapshot.files.find((file) => file.path === "report1.txt").hunks[0].id;
	const oldBinaryId = binary.hunks[0].id;
	write("report1.txt", "different dirty text\n");
	write("binary.bin", Buffer.from([0, 8, 9]));
	snapshot = await readDiff(root);
	assert.notEqual(snapshot.files.find((file) => file.path === "report1.txt").hunks[0].id, oldTextId);
	assert.notEqual(snapshot.files.find((file) => file.path === "binary.bin").hunks[0].id, oldBinaryId);
	console.log("PASS CR11/CR12: binary and rename changes remain visible; changed text/binary content gets new hunk IDs");
	write("large.txt", "a".repeat(50000));
	let large = (await readDiff(root)).files.find((file) => file.path === "large.txt");
	assert.equal(large.hunks[0].reviewable, false, "oversized contents cannot receive content review decisions");
	write("large.txt", "b".repeat(50000));
	large = (await readDiff(root)).files.find((file) => file.path === "large.txt");
	assert.equal(large.hunks[0].reviewable, false);
	write("unreadable.txt", "unreadable fixture\n");
	const originalRead = fs.readFileSync;
	try {
		fs.readFileSync = (file, options) => {
			if (file === path.join(root, "unreadable.txt")) { throw Object.assign(new Error("Injected unreadable file"), { code: "EACCES" }); }
			return originalRead(file, options);
		};
		const unreadable = (await readDiff(root)).files.find((file) => file.path === "unreadable.txt");
		assert.equal(unreadable.hunks[0].reviewable, false);
		assert.match(unreadable.hunks[0].lines[0].text, /could not be read/);
	} finally {
		fs.readFileSync = originalRead;
	}
	const conflictRoot = path.join(root, "codex-conflict");
	fs.mkdirSync(conflictRoot);
	git(["init", "--quiet"], conflictRoot);
	git(["config", "core.autocrlf", "false"], conflictRoot);
	// git merge needs an identity before it starts, and a CI runner or container has no global one.
	git(["config", "user.name", "GrokCode test"], conflictRoot);
	git(["config", "user.email", "test@example.invalid"], conflictRoot);
	const commit = (message) => git(["-c", "user.name=GrokCode test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-am", message], conflictRoot);
	fs.writeFileSync(path.join(conflictRoot, "conflict.txt"), "base\n");
	fs.writeFileSync(path.join(conflictRoot, "z-ordinary.txt"), "ordinary base\n");
	git(["add", "--all"], conflictRoot);
	commit("Base");
	const baseBranch = git(["branch", "--show-current"], conflictRoot).trim();
	git(["branch", "other"], conflictRoot);
	fs.writeFileSync(path.join(conflictRoot, "conflict.txt"), "ours\n");
	commit("Ours");
	git(["checkout", "--quiet", "other"], conflictRoot);
	fs.writeFileSync(path.join(conflictRoot, "conflict.txt"), "theirs\n");
	commit("Theirs");
	git(["checkout", "--quiet", baseBranch], conflictRoot);
	assert.throws(() => git(["merge", "--no-edit", "other"], conflictRoot));
	assert.equal((await listFiles(conflictRoot)).files.filter((file) => file === "conflict.txt").length, 1, "merge conflict stages list the file once");
	fs.writeFileSync(path.join(conflictRoot, "z-ordinary.txt"), "ordinary changed\n");
	const conflicted = await readDiff(conflictRoot);
	assert.equal(conflicted.ok, true);
	const conflict = conflicted.files.find((file) => file.path === "conflict.txt");
	assert.equal(conflict.hunks.length, 1, "staged and unstaged conflict metadata share one explicit notice");
	assert.ok(conflict.hunks.some((hunk) => hunk.lines.some((line) => /Unresolved merge conflict/.test(line.text))));
	assert.ok(conflict.hunks.every((hunk) => hunk.reviewable === false));
	const ordinary = conflicted.files.find((file) => file.path === "z-ordinary.txt");
	assert.ok(ordinary.hunks.some((hunk) => hunk.lines.some((line) => line.kind === "add" && line.text === "ordinary changed")), "mixed conflict output retains ordinary patch attribution");
	console.log("PASS R2-03/R2-04/R2-05: failed saves preserve originals; conflicts and unreviewable contents are explicit");

	const kindRoot = path.join(root, "codex-kinds");
	fs.mkdirSync(path.join(kindRoot, "mode b"), { recursive: true });
	git(["init", "--quiet"], kindRoot);
	git(["config", "core.autocrlf", "false"], kindRoot);
	git(["config", "diff.mnemonicPrefix", "true"], kindRoot);
	for (const name of ["a.txt", "b.txt", "z.txt", "mode b/run.sh"]) { fs.writeFileSync(path.join(kindRoot, name), `${name} original\n`); }
	git(["add", "--all"], kindRoot);
	git(["-c", "user.name=GrokCode test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Kinds"], kindRoot);
	const stageBlob = (name, text, mode = "100644") => {
		const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: kindRoot, input: text, encoding: "utf8" }).trim();
		git(["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `${mode},${blob},${name}`], kindRoot);
	};
	stageBlob("a.txt", "link-target", "120000");
	fs.writeFileSync(path.join(kindRoot, "b.txt"), "b.txt changed\n");
	fs.writeFileSync(path.join(kindRoot, "z.txt"), "z.txt changed\n");
	fs.writeFileSync(path.join(kindRoot, "café.txt"), "café.txt staged\n");
	git(["add", "--", "b.txt", "z.txt", "café.txt"], kindRoot);
	git(["update-index", "--chmod=+x", "--", "mode b/run.sh"], kindRoot);
	const quotedNames = ["tab\there.txt", "quote\"name.txt", "ctl\u0001x.txt"];
	for (const name of quotedNames) { stageBlob(name, `${name} staged\n`); }
	fs.writeFileSync(path.join(kindRoot, " lead.txt"), "space-led file\n");
	fs.writeFileSync(path.join(kindRoot, "lead.txt"), "plain file\n");
	const kinds = await readDiff(kindRoot);
	assert.equal(kinds.ok, true);
	assert.equal(kinds.truncated, false);
	assert.deepEqual(kinds.files.map((file) => file.path).sort(), [" lead.txt", "a.txt", "b.txt", "café.txt", "lead.txt", "mode b/run.sh", "z.txt", ...quotedNames].sort());
	const shown = (name) => kinds.files.find((file) => file.path === name).hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
	assert.deepEqual(shown("b.txt"), ["del:b.txt original", "add:b.txt changed"]);
	assert.deepEqual(shown("z.txt"), ["del:z.txt original", "add:z.txt changed"]);
	assert.deepEqual(shown("a.txt"), ["del:link-target", "add:a.txt original", "del:a.txt original", "add:link-target"], "both type-change halves stay on a.txt");
	assert.deepEqual(shown("café.txt"), ["add:café.txt staged"]);
	for (const name of quotedNames) { assert.deepEqual(shown(name), [`del:${name} staged`, `add:${name} staged`], JSON.stringify(name)); }
	assert.deepEqual([...new Set(shown("mode b/run.sh"))], ["context:File metadata changed."]);
	assert.deepEqual(shown(" lead.txt"), ["add:space-led file"]);
	assert.deepEqual(shown("lead.txt"), ["add:plain file"]);
	const octal = parseUnified(git(["-c", "core.quotepath=true", "diff", "--cached", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"], kindRoot), "Staged");
	assert.deepEqual(octal.files.map((file) => file.path).sort(), ["a.txt", "b.txt", "café.txt", "z.txt", ...quotedNames].sort(), "C-quoted and octal-escaped names decode to the real path");
	assert.equal(octal.files.find((file) => file.path === "a.txt").hunks.length, 2);
	console.log("PASS 6.3/6.5: diff blocks keep their own paths (type change, C-quoted, octal, mode-only, configured prefixes); untracked names keep leading spaces");

	const junctionRoot = path.join(root, "codex-junction");
	fs.mkdirSync(path.join(junctionRoot, "sub"), { recursive: true });
	fs.mkdirSync(path.join(junctionRoot, "gone"));
	git(["init", "--quiet"], junctionRoot);
	git(["config", "core.autocrlf", "false"], junctionRoot);
	fs.writeFileSync(path.join(junctionRoot, "sub", "a.txt"), "from HEAD\n");
	fs.writeFileSync(path.join(junctionRoot, "gone", "c.txt"), "restore me\n");
	git(["add", "--all"], junctionRoot);
	git(["-c", "user.name=GrokCode test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Junction"], junctionRoot);
	fs.rmSync(path.join(junctionRoot, "gone"), { recursive: true });
	assert.equal((await revertFile(junctionRoot, "gone/c.txt")).ok, true, "a file whose folder was deleted is still restorable");
	assert.equal(fs.readFileSync(path.join(junctionRoot, "gone", "c.txt"), "utf8"), "restore me\n");
	console.log("PASS 6.1: Revert still restores a tracked file whose folder was deleted");
	const linkedRepo = path.join(root, "codex-linked-repo");
	fs.symlinkSync(junctionRoot, linkedRepo, process.platform === "win32" ? "junction" : "dir");
	fs.writeFileSync(path.join(junctionRoot, "sub", "a.txt"), "changed through the link\n");
	const linkedChanges = await readDiff(linkedRepo);
	assert.equal(linkedChanges.ok, true);
	assert.ok(linkedChanges.files.some((file) => file.path === "sub/a.txt"), "a linked session folder shows its changed files");
	assert.equal((await revertFile(linkedRepo, "sub/a.txt")).ok, true);
	assert.equal(fs.readFileSync(path.join(junctionRoot, "sub", "a.txt"), "utf8"), "from HEAD\n", "Revert works through the session folder link");
	console.log("PASS P4: linked session folders show changes and allow Revert within the repository");
	if (process.platform === "win32") {
		const outsideRoot = path.join(root, "codex-outside");
		fs.mkdirSync(outsideRoot);
		fs.rmSync(path.join(junctionRoot, "sub"), { recursive: true });
		fs.symlinkSync(outsideRoot, path.join(junctionRoot, "sub"), "junction");
		assert.deepEqual(await revertFile(junctionRoot, "sub/a.txt"), { ok: false, error: "That file is not in this folder." });
		assert.equal(fs.existsSync(path.join(outsideRoot, "a.txt")), false, "Revert must not write through a junction");
		console.log("PASS 6.1 Windows: Revert refuses a deleted file behind a junction that leaves the folder");
	}
	if (process.platform === "win32" && process.argv.includes("--acl")) {
		const aclFile = path.join(root, "acl-target.txt");
		write("acl-target.txt", "private original");
		const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const inspect = (script, file = aclFile) => nativeExec(shell, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`], { windowsHide: true, timeout: 8000, encoding: "utf8", env: { ...process.env, GROK_TEST_FILE: file } }).trim();
		const initialSddl = inspect("$security = [Security.AccessControl.FileSecurity]::new(); $security.SetAccessRuleProtection($true, $false); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)); [IO.File]::SetAccessControl($env:GROK_TEST_FILE, $security); [IO.File]::GetAccessControl($env:GROK_TEST_FILE).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)");
		const accessScript = "$acl = [IO.File]::GetAccessControl($env:GROK_TEST_FILE); $acl.AreAccessRulesProtected; foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { [string]::Join(':', @($rule.IdentityReference.Value, [string][int]$rule.FileSystemRights, [string]$rule.AccessControlType, [string]$rule.IsInherited)) }";
		const initialAccess = inspect(accessScript);
		const simulatedExec = childProcess.execFile;
		let checkedStage = false;
		try {
			childProcess.execFile = nativeExecFile;
			fs.writeFileSync = (file, text, options) => {
				if (typeof file === "number") {
					const temporary = fs.readdirSync(root).find((name) => name.startsWith(".grok-save-"));
					const access = inspect(accessScript, path.join(root, temporary));
					assert.ok(access.startsWith("True"));
					assert.equal(access, initialAccess, "stage access rules match the private target before writing plaintext");
					assert.equal(fs.statSync(path.join(root, temporary)).size, 0);
					checkedStage = true;
				}
				return nativeWrite(file, text, options);
			};
			const loadedAcl = readText(root, "acl-target.txt");
			assert.equal((await writeText(root, "acl-target.txt", "private replacement", loadedAcl.version)).ok, true);
		} finally {
			fs.writeFileSync = nativeWrite;
			childProcess.execFile = simulatedExec;
		}
		assert.equal(checkedStage, true);
		assert.equal(inspect("[IO.File]::GetAccessControl($env:GROK_TEST_FILE).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)"), initialSddl, "native replacement preserves the exact original security descriptor");
		assert.equal(read("acl-target.txt"), "private replacement");
		assert.equal(fs.readdirSync(root).some((name) => name.includes(".grok-save-")), false);
		let checkedNativeVersion = false;
		try {
			childProcess.execFile = (command, args, options, callback) => {
				if (options?.env?.GROK_SAVE_VERSION) {
					nativeWrite(aclFile, "late concurrent edit");
					checkedNativeVersion = true;
				}
				return nativeExecFile(command, args, options, callback);
			};
			const loadedAcl = readText(root, "acl-target.txt");
			assert.equal((await writeText(root, "acl-target.txt", "must not replace late edit", loadedAcl.version)).ok, false);
		} finally {
			childProcess.execFile = simulatedExec;
		}
		assert.equal(checkedNativeVersion, true);
		assert.equal(read("acl-target.txt"), "late concurrent edit", "native child rechecks the version after its launch boundary");
		assert.equal(fs.readdirSync(root).some((name) => name.includes(".grok-save-")), false);
		console.log("PASS R2-03 actual Windows ACL/version: protected staging precedes plaintext, replacement retains descriptor, late edits reject");
	}

	await checkRepoFiles();

	// `echo` is Write-Output in PowerShell and a builtin in bash, so one command checks the shell of each platform.
	const echoed = await runCommand(root, "echo run-box-ok");
	assert.equal(echoed.ok, true, JSON.stringify(echoed));
	assert.equal(echoed.code, 0);
	assert.equal(echoed.output.trim(), "run-box-ok");
	console.log(`PASS the Run box runs a command in ${process.platform === "win32" ? "PowerShell" : "bash"}`);

	if (process.argv.includes("--terminal")) {
		const childFile = path.join(root, "codex-timeout-child.cjs");
		const marker = path.join(root, "codex-survived.txt");
		fs.writeFileSync(childFile, `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 23000);`);
		const escapePs = (text) => `'${text.replace(/'/g, "''")}'`;
		const escapeSh = (text) => `'${text.replace(/'/g, "'\\''")}'`;
		const started = Date.now();
		const result = await runCommand(root, process.platform === "win32" ? `& ${escapePs(process.execPath)} ${escapePs(childFile)}` : `${escapeSh(process.execPath)} ${escapeSh(childFile)}`);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.code, -1);
		assert.equal(result.timedOut, true);
		assert.match(result.output, /20-second limit/);
		assert.ok(Date.now() - started < 23000, "Timeout must settle before the child marker deadline");
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 24500 - (Date.now() - started))));
		assert.equal(fs.existsSync(marker), false, "Descendant must be stopped before it writes its marker");
		console.log("PASS CR10: real shell/Node descendant stopped at timeout without writing its delayed marker");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	childProcess.execFileSync = nativeExec;
	childProcess.execFile = nativeExecFile;
	assert.equal(path.dirname(root), tempBase);
	assert.ok(path.basename(root).startsWith("codex-files-"));
	fs.rmSync(root, { recursive: true, force: true });
	assert.equal(path.dirname(depthRoot), tempBase);
	assert.ok(path.basename(depthRoot).startsWith("codex-depth-"));
	fs.rmSync(depthRoot, { recursive: true, force: true });
});
