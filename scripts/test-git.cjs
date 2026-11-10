const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { execFileSync, spawn } = require("child_process");
const { readDiff, revertHunk, FILTER_NOT_OFF } = require("../electron/diff.cjs");
const { branchInfo, readScopedDiff, readChanges, listCommits, repoFiles, prStatus, prCreate, commitFiles, prMergeWhenReady, addWorktree, restoreWorktree, removeWorktree, gitSecuritySnapshot, bundledGitDir } = require("../electron/git.cjs");

// Never let gh resolve a real GitHub repository from the environment; the temp origin is a local bare repo.
delete process.env.GH_REPO;
delete process.env.GH_HOST;

// macOS puts the temp folder behind the /var symlink and the GitHub Windows runner names it with a short 8.3 name (RUNNER~1),
// while git reports real, full paths. The native realpath resolves both.
const tempBase = path.resolve(fs.realpathSync.native(os.tmpdir()),process.env.CODEX_THREAD_ID || "grokcode-git");
fs.mkdirSync(tempBase, { recursive: true });
const root = fs.mkdtempSync(path.join(tempBase, "git-"));
const origin = path.join(root, "origin.git");
const repo = path.join(root, "repo");
const prRepositoryData = { id: "repository-id", nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", defaultBranchRef: { name: "main" } };
const prRepositoryJson = JSON.stringify(prRepositoryData);

function git(args, cwd = repo) {
	return execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", stdio: "pipe" });
}

function write(file, text, folder = repo) {
	fs.writeFileSync(path.join(folder, file), text);
}

function commit(message) {
	git(["add", "--all"]);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", message]);
}

function paths(snapshot) {
	return snapshot.files.map((file) => file.path).sort();
}

function stubGitHub(reply, beforeGit) {
	const calls = [];
	const file = path.resolve(__dirname, "../electron/git.cjs");
	const localRequire = createRequire(file);
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(file, "utf8"), {
		module, Buffer, process, setTimeout, clearTimeout,
		require(name) {
			if (name !== "child_process") { return localRequire(name); }
			return { spawn(command, args, options) {
				if (command !== "gh") { beforeGit?.(args); return spawn(command, args, options); }
				calls.push(args);
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = () => {};
				process.nextTick(() => {
					const result = reply(args, options);
					if (result.out) { child.stdout.emit("data", Buffer.from(result.out)); }
					if (result.err) { child.stderr.emit("data", Buffer.from(result.err)); }
					child.emit("close", result.code ?? 0);
				});
				return child;
			} };
		},
	});
	return { api: module.exports, calls };
}

async function checkTruncatedRepoFiles() {
	const file = path.resolve(__dirname, "../electron/git.cjs");
	const localRequire = createRequire(file);
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(file, "utf8"), {
		module, Buffer, process, setTimeout, clearTimeout,
		require(name) {
			if (name !== "child_process") { return localRequire(name); }
			return { spawn(_command, args) {
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = () => {};
				process.nextTick(() => {
					if (args.includes("--deleted")) {
						child.stdout.emit("data", Buffer.from("gone.txt\0"));
						child.emit("close", 0);
					} else {
						child.stdout.emit("data", Buffer.from(`kept.txt\0gone.txt\0${"duplicate.txt\0".repeat(16000)}partial`));
						child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024));
						child.emit("close", -1);
					}
				});
				return child;
			} };
		},
	});
	const listed = await module.exports.repoFiles(repo);
	assert.equal(listed.truncated, true);
	assert.deepEqual(Array.from(listed.files), ["kept.txt", "duplicate.txt"], "truncation keeps complete names, removes deletions and duplicates, and drops the partial tail despite a nonzero exit");
	console.log("PASS repository files: the larger byte limit preserves complete names when git is stopped");
}

async function checkTruncatedDiffCounts() {
	const folder = path.join(root, "diff-counts");
	git(["init", "--quiet", "-b", "main", folder], root);
	git(["config", "core.autocrlf", "false"], folder);
	git(["config", "user.name", "GrokCode test"], folder);
	git(["config", "user.email", "test@example.invalid"], folder);
	for (const file of ["a-large.txt", "b-large.txt", "z-later.txt"]) { write(file, "", folder); }
	write("m-rename.txt", "rename line\n".repeat(20), folder);
	write("n-binary.bin", Buffer.from([0, 1, 2]), folder);
	git(["add", "--all"], folder);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "Diff count fixtures"], folder);
	const reset = () => git(["restore", "--staged", "--worktree", "--", "."], folder);
	const counts = (snapshot, name) => {
		const file = snapshot.files.find((item) => item.path === name);
		assert.ok(file, name);
		return [file.additions, file.deletions];
	};
	const leftOut = (snapshot, name) => snapshot.files.find((item) => item.path === name)?.hunks.some((hunk) => hunk.lines.some((line) => line.text === "Diff content was left out."));

	write("a-large.txt", "added\n".repeat(900), folder);
	write("z-later.txt", "later\n", folder);
	const later = await readDiff(folder);
	assert.equal(later.ok, true);
	assert.equal(later.truncated, true);
	assert.deepEqual(counts(later, "a-large.txt"), [900, 0]);
	assert.deepEqual(counts(later, "z-later.txt"), [1, 0]);
	assert.equal(leftOut(later, "z-later.txt"), true);
	assert.equal(later.files.find((file) => file.path === "a-large.txt").hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), 700, "the patch preview remains capped");
	console.log("PASS diff counts: a file after the 700-line cutoff keeps its counts and left-out label");

	reset();
	write("a-large.txt", "first\n".repeat(801), folder);
	write("b-large.txt", "second\n".repeat(802), folder);
	const large = await readDiff(folder);
	assert.equal(large.ok, true);
	assert.equal(large.truncated, true);
	assert.deepEqual(counts(large, "a-large.txt"), [801, 0]);
	assert.deepEqual(counts(large, "b-large.txt"), [802, 0]);
	assert.equal(leftOut(large, "b-large.txt"), true);
	console.log("PASS diff counts: two files over 700 lines retain complete counts");

	reset();
	write("a-large.txt", `${"x".repeat(200000)}\n`, folder);
	write("z-later.txt", "after the byte cutoff\n", folder);
	const bytes = await readDiff(folder);
	assert.equal(bytes.ok, true);
	assert.equal(bytes.truncated, true);
	assert.deepEqual(counts(bytes, "a-large.txt"), [1, 0]);
	assert.deepEqual(counts(bytes, "z-later.txt"), [1, 0]);
	assert.equal(leftOut(bytes, "z-later.txt"), true);
	console.log("PASS diff counts: the byte cutoff keeps later counts and reports omitted content");

	reset();
	git(["mv", "m-rename.txt", "m-renamed name.txt"], folder);
	write("m-renamed name.txt", `${"rename line\n".repeat(20)}extra\n`, folder);
	write("n-binary.bin", Buffer.from([0, 3, 4]), folder);
	git(["add", "--all"], folder);
	const small = await readDiff(folder);
	assert.equal(small.ok, true);
	assert.equal(small.truncated, false);
	assert.deepEqual(counts(small, "m-renamed name.txt"), [1, 0]);
	assert.equal(small.files.find((file) => file.path === "m-renamed name.txt").from, "m-rename.txt", "a rename with edits keeps its old path");
	assert.equal(small.files.find((file) => file.path === "n-binary.bin").from, undefined);
	assert.deepEqual(counts(small, "n-binary.bin"), [undefined, undefined]);
	assert.ok(small.files.find((file) => file.path === "n-binary.bin").hunks.some((hunk) => hunk.lines.some((line) => line.text === "Binary file")));
	write("a-large.txt", "rename cutoff\n".repeat(900), folder);
	git(["add", "--all"], folder);
	write("n-binary.bin", Buffer.from([0, 5, 6]), folder);
	const renamed = await readDiff(folder);
	assert.equal(renamed.ok, true);
	assert.equal(renamed.truncated, true);
	assert.deepEqual(counts(renamed, "m-renamed name.txt"), [1, 0]);
	assert.ok(renamed.files.find((file) => file.path === "m-renamed name.txt").hunks.some((hunk) => hunk.lines.some((line) => line.text === "Renamed from m-rename.txt")));
	assert.deepEqual(counts(renamed, "n-binary.bin"), [undefined, undefined]);
	assert.equal(renamed.files.some((file) => file.path === "m-rename.txt"), false);
	write("m-renamed name.txt", "edited after the rename was staged\n", folder);
	const editedRename = await readDiff(folder);
	assert.equal(editedRename.files.find((file) => file.path === "m-renamed name.txt").from, "m-rename.txt", "a staged rename with unstaged edits keeps its old path");
	const changes = { cwd: folder, scope: "uncommitted" };
	const renameList = await readChanges(changes);
	assert.equal(renameList.ok, true);
	const rename = renameList.files.find((file) => file.path === "m-renamed name.txt");
	assert.equal(rename.from, "m-rename.txt");
	assert.deepEqual(counts(renameList, "m-renamed name.txt"), [2, 21]);
	assert.deepEqual(counts(renameList, "n-binary.bin"), [undefined, undefined]);
	const renamePatch = await readChanges({ ...changes, file: rename.path, from: rename.from });
	assert.deepEqual(paths(renamePatch), [rename.path]);
	assert.equal(renamePatch.files[0].from, rename.from);
	console.log("PASS diff counts: NUL-delimited rename paths retain counts and binary counts stay absent");

	reset();
	write("a-large.txt", "staged\n".repeat(900), folder);
	git(["add", "a-large.txt"], folder);
	write("a-large.txt", `${"staged\n".repeat(900)}${"unstaged\n".repeat(900)}`, folder);
	const mixed = await readDiff(folder);
	assert.equal(mixed.ok, true);
	assert.equal(mixed.truncated, true);
	assert.deepEqual(counts(mixed, "a-large.txt"), [1800, 0]);
	assert.ok(mixed.files.find((file) => file.path === "a-large.txt").hunks.some((hunk) => hunk.loc.startsWith("Staged ")));
	console.log("PASS diff counts: staged and unstaged truncated runs add their complete counts");

	for (let index = 0; index < 42; index++) { write(`later-${index}.txt`, "+literal\n".repeat(100), folder); }
	const inventory = await readChanges(changes);
	assert.equal(inventory.ok, true);
	assert.equal(inventory.files.length, 43);
	assert.ok(inventory.files.every((file) => file.hunks.length === 0), "inventory carries no patch bodies");
	assert.deepEqual(counts(inventory, "a-large.txt"), [1800, 0]);
	const late = await readChanges({ ...changes, file: "later-9.txt", full: true });
	assert.deepEqual(paths(late), ["later-9.txt"]);
	assert.equal(late.files[0].hunks[0].lines.length, 100);
	assert.equal(late.files[0].hunks[0].lines[0].text, "+literal");
	const preview = await readChanges({ ...changes, file: "a-large.txt" });
	assert.equal(preview.files[0].truncated, true);
	assert.equal(preview.files[0].additions, undefined, "a preview cannot replace the inventory count with a partial count");
	const full = await readChanges({ ...changes, file: "a-large.txt", full: true });
	assert.equal(full.files[0].truncated, undefined);
	assert.deepEqual(counts(full, "a-large.txt"), [1800, 0]);
	const complete = full.files[0].hunks.find((hunk) => hunk.revertible);
	assert.ok(complete, "the full working hunk is revertible");
	assert.equal((await revertHunk(folder, "a-large.txt", complete)).ok, true, "the host revalidates a hunk beyond the old preview limit");
	console.log("PASS progressive changes: full inventory, literal text, bounded previews, later files and full-hunk revalidation");
}

function checkBundledGitDir() {
	const local = fs.mkdtempSync(path.join(tempBase, "bundled-"));
	try {
		assert.equal(bundledGitDir(""), "");
		assert.equal(bundledGitDir(path.join(local, "missing")), "");
		const versions = path.join(local, "grok", "git");
		for (const version of ["2.9.0.windows.1", "2.55.0.windows.5"]) {
			const dir = path.join(versions, version, "cmd");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "git.exe"), "");
		}
		fs.mkdirSync(path.join(versions, "9.0.0.windows.1", "cmd"), { recursive: true });
		assert.equal(bundledGitDir(local), path.join(versions, "2.55.0.windows.5", "cmd"));
	} finally {
		fs.rmSync(local, { recursive: true, force: true });
	}
	console.log("PASS bundledGitDir: newest folder that has git.exe; a missing root and an empty localAppData are blank");
}

async function checkDirectCommits() {
	const create = (name, files = { "a.txt": "base\n" }, born = true) => {
		const folder = path.join(root, name);
		git(["init", "--quiet", "-b", "main", folder], root);
		for (const [key, value] of [["user.name", "GrokCode test"], ["user.email", "test@example.invalid"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"], ["core.hooksPath", path.join(folder, ".git", "hooks")]]) { git(["config", key, value], folder); }
		for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); write(file, content, folder); }
		if (born) { git(["add", "--all"], folder); git(["commit", "--quiet", "-m", "Base"], folder); }
		return folder;
	};
	const hook = (folder, name, body) => fs.writeFileSync(path.join(folder, ".git", "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	const head = (folder) => git(["rev-parse", "HEAD"], folder).trim();
	const changed = (folder) => git(["show", "--pretty=format:", "--name-only", "HEAD"], folder).trim().split(/\r?\n/).sort();
	const sandboxGit = create("sandbox-git");
	const sandboxOrigin = path.join(root, "sandbox-origin.git");
	git(["init", "--quiet", "--bare", sandboxOrigin], root);
	git(["remote", "add", "origin", sandboxOrigin], sandboxGit);
	const commitEvents = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction", "pre-push"];
	const sandboxMarker = (event, source) => path.join(root, `sandbox-${event}-${source}`).replace(/\\/g, "/");
	for (const event of [...commitEvents, "post-checkout"]) {
		hook(sandboxGit, event, `printf ran >> '${sandboxMarker(event, "file")}'`);
		git(["config", `hook.sandbox-${event}.command`, `printf ran >> '${sandboxMarker(event, "config")}'`], sandboxGit);
		git(["config", `hook.sandbox-${event}.event`, event], sandboxGit);
	}
	let configuredHooks = false;
	try { configuredHooks = git(["hook", "list", "pre-commit"], sandboxGit).split(/\r?\n/).includes("sandbox-pre-commit"); } catch {}
	const assertHooks = (events, expected) => {
		for (const event of events) {
			assert.equal(fs.existsSync(sandboxMarker(event, "file")), expected, `file ${event}`);
			assert.equal(fs.existsSync(sandboxMarker(event, "config")), expected && configuredHooks, `config ${event}`);
			fs.rmSync(sandboxMarker(event, "file"), { force: true });
			fs.rmSync(sandboxMarker(event, "config"), { force: true });
		}
	};
	for (const hooks of [false, true]) {
		write("a.txt", `Commit with hooks ${hooks}\n`, sandboxGit);
		const upstreamChanges = [];
		const result = await commitFiles(sandboxGit, { paths: ["a.txt"], message: "Local sandbox commit", push: true, hooks, onUpstream: (branch) => upstreamChanges.push(branch) });
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(upstreamChanges, hooks ? [] : ["main"], "only the first push establishes the branch's upstream");
		assert.equal(git(["rev-parse", "refs/heads/main"], sandboxOrigin).trim(), head(sandboxGit));
		assertHooks(commitEvents, hooks);
	}
	git(["switch", "--quiet", "-c", "sandbox-pr"], sandboxGit);
	assertHooks(["post-checkout", "reference-transaction"], true);
	const pr = stubGitHub((args) => ({ out: args[0] === "repo" ? prRepositoryJson : "https://example.invalid/pull/1\n" }));
	const sandboxSubfolder = path.join(sandboxGit, "nested");
	fs.mkdirSync(sandboxSubfolder);
	const beforePush = await gitSecuritySnapshot(sandboxGit, true);
	for (const hooks of [false, true]) {
		const result = await pr.api.prCreate(sandboxSubfolder, { title: "Local test", hooks });
		assert.equal(result.ok, true, JSON.stringify(result));
		assertHooks(["pre-push"], hooks);
	}
	const afterPush = await gitSecuritySnapshot(sandboxGit, true);
	assert.notEqual(afterPush.config, beforePush.config);
	assert.equal(beforePush.upstream("sandbox-pr").established, false);
	assert.deepEqual(afterPush.upstream("sandbox-pr"), { config: beforePush.upstream("sandbox-pr").config, established: true });
	assert.deepEqual((await gitSecuritySnapshot(sandboxSubfolder, true)).upstream("sandbox-pr"), afterPush.upstream("sandbox-pr"), "a subfolder session recognizes the same upstream settings as the repository root");
	git(["config", "branch.sandbox-pr.pushRemote", "changed"], sandboxGit);
	assert.notEqual((await gitSecuritySnapshot(sandboxGit, true)).upstream("sandbox-pr").config, afterPush.upstream("sandbox-pr").config);
	git(["config", "--unset", "branch.sandbox-pr.pushRemote"], sandboxGit);
	let sandboxTree;
	for (const hooks of [false, true]) {
		sandboxTree = await addWorktree(sandboxGit, { name: `hooks-${hooks}`, prefix: "grok", hooks });
		assert.equal(sandboxTree.ok, true, JSON.stringify(sandboxTree));
		assertHooks(["post-checkout"], hooks);
		assert.equal((await removeWorktree(sandboxGit, sandboxTree.folder, { branch: sandboxTree.branch })).ok, true);
		const restored = await restoreWorktree(sandboxTree.folder, sandboxTree.branch, (_cwd, add) => add(hooks));
		assert.equal(restored.ok, true, JSON.stringify(restored));
		assertHooks(["post-checkout"], hooks);
	}
	console.log("PASS sandbox Git options: Commit and push, Create PR push, Add worktree and Restore worktree switch file and configured hooks on or off");

	git(["config", "extensions.worktreeConfig", "true"], sandboxGit);
	git(["config", "--worktree", "core.hooksPath", "custom-hooks"], sandboxTree.folder);
	const snapshotFolder = path.join(sandboxTree.folder, "nested");
	const customHooks = path.join(sandboxTree.folder, "custom-hooks");
	fs.mkdirSync(snapshotFolder);
	fs.mkdirSync(customHooks);
	const snapshot = async () => {
		const result = await gitSecuritySnapshot(snapshotFolder);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.match(result.config, /^[0-9a-f]{64}$/);
		assert.match(result.hooks, /^[0-9a-f]{64}$/);
		return result;
	};
	let prior = await snapshot();
	assert.deepEqual(await snapshot(), prior, "an unchanged linked worktree gives the same digests");
	const assertSnapshotChange = async (field) => {
		const next = await snapshot();
		assert.notEqual(next[field], prior[field], `changed ${field}`);
		assert.equal(next[field === "config" ? "hooks" : "config"], prior[field === "config" ? "hooks" : "config"]);
		prior = next;
	};
	fs.appendFileSync(path.join(sandboxGit, ".git", "config"), "\n# Common configuration changed\n");
	await assertSnapshotChange("config");
	git(["config", "--worktree", "review.worktree", "changed"], sandboxTree.folder);
	await assertSnapshotChange("config");
	const included = path.join(root, "sandbox-included.gitconfig");
	git(["config", "--file", included, "review.included", "initial"], sandboxGit);
	git(["config", "--worktree", "include.path", included], sandboxTree.folder);
	prior = await snapshot();
	git(["config", "--file", included, "review.included", "changed"], sandboxGit);
	await assertSnapshotChange("config");
	hook(sandboxGit, "pre-commit", "printf changed");
	await assertSnapshotChange("hooks");
	write("pre-commit", "#!/bin/sh\nexit 0\n", customHooks);
	await assertSnapshotChange("hooks");
	fs.truncateSync(path.join(customHooks, "pre-commit"), 9 * 1024 * 1024);
	assert.equal((await gitSecuritySnapshot(snapshotFolder)).ok, false, "oversized hooks produce an unavailable snapshot");
	console.log("PASS sandbox Git snapshots detect common, worktree and included config plus default and configured hooks");

	const partial = create("commit-partial", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "staged.txt": "staged\n" });
	const noChanges = await commitFiles(partial, { paths: ["a.txt"], message: "Nothing changed" });
	assert.equal(noChanges.ok, false);
	assert.match(noChanges.error, /^nothing to commit\b/);
	for (const file of ["a.txt", "b.txt", "c.txt", "staged.txt"]) { write(file, "changed\n", partial); }
	git(["add", "staged.txt"], partial);
	const selected = await commitFiles(partial, { paths: ["a.txt", "b.txt"], message: "Selected files\n\nDetails", expected: "main" });
	assert.equal(selected.ok, true, JSON.stringify(selected));
	assert.equal(selected.committed, true);
	assert.deepEqual(changed(partial), ["a.txt", "b.txt"]);
	assert.equal(git(["status", "--porcelain"], partial), " M c.txt\nM  staged.txt\n");
	assert.match(selected.message, /2 other changed files are not in this commit\.$/);
	console.log("PASS direct commit: selected working files only, other staged and unstaged changes preserved");

	const conflict = create("commit-conflict", { "sub/a.txt": "base\n", ".gitattributes": "sub/a.txt conflict-marker-size=5\n" });
	const sub = path.join(conflict, "sub");
	write("a.txt", "stashed\n", sub);
	git(["stash", "push", "--quiet"], conflict);
	write("a.txt", "upstream\n", sub);
	git(["commit", "-qam", "Upstream"], conflict);
	assert.throws(() => git(["stash", "pop", "--quiet"], conflict));
	const conflictHead = head(conflict);
	const indexConflict = git(["ls-files", "--unmerged"], conflict);
	assert.ok(indexConflict.includes("sub/a.txt"));
	assert.match(fs.readFileSync(path.join(sub, "a.txt"), "utf8"), /^<{5} /);
	const resolveCommit = { paths: ["a.txt"], message: "Resolve conflict" };
	assert.deepEqual(await commitFiles(sub, resolveCommit), { ok: false, error: "Resolve the conflict markers in a.txt before committing." });
	assert.equal(head(conflict), conflictHead);
	assert.equal(git(["ls-files", "--unmerged"], conflict), indexConflict);
	write("a.txt", "<<<<<\r\nresolved with one leftover marker\r\n", sub);
	assert.match((await commitFiles(sub, resolveCommit)).error, /Resolve the conflict markers/);
	write("a.txt", "resolved by hand\n", sub);
	assert.equal((await commitFiles(sub, resolveCommit)).ok, true);
	assert.equal(git(["show", "HEAD:sub/a.txt"], conflict), "resolved by hand\n");
	write("a.txt", "<<<<< Example\nfirst\n=====\nsecond\n>>>>> Example\n", sub);
	assert.equal((await commitFiles(sub, { ...resolveCommit, message: "Document conflict markers" })).ok, true);
	console.log("PASS direct commit checks markers on unmerged files, preserves the index when blocked, and allows resolutions and literal examples");

	const renamed = create("commit-rename", { "old.ts": "rename\n", "gone.txt": "gone\n" });
	git(["mv", "old.ts", "new.ts"], renamed);
	fs.unlinkSync(path.join(renamed, "gone.txt"));
	write("new.txt", "new\n", renamed);
	const moved = await commitFiles(renamed, { paths: ["old.ts", "new.ts", "gone.txt", "new.txt"], message: "Rename, add and delete" });
	assert.equal(moved.ok, true, JSON.stringify(moved));
	assert.deepEqual(git(["ls-tree", "--name-only", "HEAD"], renamed).trim().split(/\r?\n/).sort(), ["new.ts", "new.txt"]);
	assert.equal(git(["status", "--porcelain"], renamed), "");
	const privacy = create("commit-privacy", { ".env": "SECRET=fixture\n", ".gitignore": "" });
	write(".gitignore", ".env\n", privacy);
	git(["rm", "--cached", ".env"], privacy);
	const privacyHead = head(privacy);
	const privacyStatus = git(["status", "--porcelain"], privacy);
	const blocked = await commitFiles(privacy, { paths: [".env"], message: "Stop tracking secret" });
	assert.equal(blocked.error, ".env is staged to be deleted but is still on disk, so committing it here would commit the file. Commit it from a terminal.");
	assert.equal(head(privacy), privacyHead);
	assert.equal(git(["status", "--porcelain"], privacy), privacyStatus);
	const recreated = create("commit-recreated", { "old.ts": "old\n" });
	git(["mv", "old.ts", "new.ts"], recreated);
	write("old.ts", "recreated\n", recreated);
	const recreatedHead = head(recreated);
	const recreatedStatus = git(["status", "--porcelain"], recreated);
	assert.match((await commitFiles(recreated, { paths: ["old.ts", "new.ts"], message: "Rename" })).error, /^old\.ts is staged to be deleted but is still on disk/);
	assert.equal(head(recreated), recreatedHead);
	assert.equal(git(["status", "--porcelain"], recreated), recreatedStatus);
	console.log("PASS direct commit: untracked additions, renames and deletions; on-disk staged deletions refused without mutation");

	const mode = (folder, file, ref = "HEAD") => git(["ls-tree", ref, "--", file], folder).split(" ")[0];
	const executable = create("commit-executable", { "sub/add.sh": "add\n", "sub/drop.sh": "drop\n", "other.txt": "other\n" });
	git(["config", "core.fileMode", "false"], executable);
	git(["update-index", "--chmod=+x", "sub/drop.sh"], executable);
	git(["commit", "-qm", "Executable fixture"], executable);
	write("other.txt", "staged only\n", executable);
	git(["add", "other.txt"], executable);
	git(["update-index", "--chmod=+x", "sub/add.sh"], executable);
	git(["update-index", "--chmod=-x", "sub/drop.sh"], executable);
	write("mode-identity", "[committer]\n\tname = Active branch committer\n", path.join(executable, ".git"));
	git(["config", "includeIf.onbranch:main.path", "mode-identity"], executable);
	hook(executable, "prepare-commit-msg", `printf '\\nPrepared once\\n' >> "$1"`);
	hook(executable, "post-commit", "git rev-parse HEAD >> .git/mode-heads");
	const modeRemote = path.join(root, "mode-origin.git");
	git(["init", "--quiet", "--bare", modeRemote], root);
	git(["remote", "add", "origin", modeRemote], executable);
	const execSub = path.join(executable, "sub");
	const chmod = await commitFiles(execSub, { paths: ["add.sh", "drop.sh"], message: "Keep both executable changes", push: true });
	assert.equal(chmod.ok, true, JSON.stringify(chmod));
	assert.equal(mode(executable, "sub/add.sh"), "100755");
	assert.equal(mode(executable, "sub/drop.sh"), "100644");
	assert.equal(git(["status", "--porcelain"], executable), "M  other.txt\n");
	assert.equal(git(["show", "HEAD:other.txt"], executable), "other\n");
	assert.equal(git(["log", "-1", "--format=%an <%ae>%n%B"], executable).trim(), "GrokCode test <test@example.invalid>\nKeep both executable changes\n\nPrepared once");
	assert.equal(git(["rev-parse", "refs/heads/main"], modeRemote).trim(), head(executable));
	const [initialModeCommit, ...extraHookRuns] = fs.readFileSync(path.join(executable, ".git", "mode-heads"), "utf8").trim().split(/\r?\n/);
	assert.notEqual(initialModeCommit, head(executable), "the commit without the flags was not the one pushed");
	const identity = "--format=%an <%ae>%n%aI%n%cn <%ce>%n%B";
	assert.equal(git(["log", "-1", "--format=%cn"], executable).trim(), "Active branch committer");
	assert.equal(git(["log", "-1", identity], executable), git(["log", "-1", identity, initialModeCommit], executable));
	assert.deepEqual(extraHookRuns, [], "only the first commit runs the post-commit hook");
	git(["mv", "sub/add.sh", "sub/renamed script.sh"], executable);
	write("renamed script.sh", "edited after renaming\n", execSub);
	const modeRename = await commitFiles(execSub, { paths: ["add.sh", "renamed script.sh"], message: "Rename executable" });
	assert.equal(modeRename.ok, true, JSON.stringify(modeRename));
	assert.equal(mode(executable, "sub/renamed script.sh"), "100755");
	assert.equal(git(["show", "HEAD:sub/renamed script.sh"], executable), "edited after renaming\n");
	assert.equal(git(["status", "--porcelain"], executable), "M  other.txt\n");
	git(["mv", "sub/renamed script.sh", "sub/non-executable.sh"], executable);
	git(["update-index", "--chmod=-x", "sub/non-executable.sh"], executable);
	const nonExecutable = await commitFiles(execSub, { paths: ["renamed script.sh", "non-executable.sh"], message: "Rename and remove executable mode" });
	assert.equal(nonExecutable.ok, true, JSON.stringify(nonExecutable));
	assert.equal(mode(executable, "sub/non-executable.sh"), "100644");
	assert.equal(git(["status", "--porcelain"], executable), "M  other.txt\n");
	console.log("PASS direct commit retains both mode flips and renames, preserves unrelated stages and pushes the corrected commit");

	const modeFailure = create("commit-executable-failed");
	git(["config", "core.fileMode", "false"], modeFailure);
	git(["remote", "add", "origin", modeRemote], modeFailure);
	git(["update-index", "--chmod=+x", "a.txt"], modeFailure);
	hook(modeFailure, "post-commit", "touch .git/refs/heads/main.lock");
	const pushedMode = git(["rev-parse", "refs/heads/main"], modeRemote);
	const failedMode = await commitFiles(modeFailure, { paths: ["a.txt"], message: "Keep mode if the index can be written", push: true });
	assert.equal(failedMode.ok, false);
	assert.equal(failedMode.committed, true);
	assert.ok(head(modeFailure).startsWith(failedMode.sha));
	assert.match(failedMode.error, /staged executable modes could not be included/);
	assert.equal(mode(modeFailure, "a.txt"), "100644");
	assert.equal(git(["rev-parse", "refs/heads/main"], modeRemote), pushedMode, "the uncorrected commit was never pushed");
	const movedMode = create("commit-executable-moved");
	git(["config", "core.fileMode", "false"], movedMode);
	git(["remote", "add", "origin", modeRemote], movedMode);
	git(["update-index", "--chmod=+x", "a.txt"], movedMode);
	const originalHead = head(movedMode);
	hook(movedMode, "post-commit", "git rev-parse HEAD > .git/mode-head\ngit reset --soft HEAD^");
	const movedResult = await commitFiles(movedMode, { paths: ["a.txt"], message: "Leave the moved HEAD alone", push: true });
	const first = fs.readFileSync(path.join(movedMode, ".git", "mode-head"), "utf8").trim();
	assert.equal(movedResult.ok, false);
	assert.equal(movedResult.committed, true);
	assert.ok(first.startsWith(movedResult.sha));
	assert.match(movedResult.error, /checkout changed after committing/);
	assert.equal(head(movedMode), originalHead);
	assert.equal(mode(movedMode, "a.txt", first), "100644");
	assert.equal(git(["rev-parse", "refs/heads/main"], modeRemote), pushedMode);
	console.log("PASS blocked amend and moved HEAD report the commit without the flag and withhold the push");
	const race = create("commit-executable-race");
	git(["config", "core.fileMode", "false"], race);
	git(["remote", "add", "origin", modeRemote], race);
	git(["update-index", "--chmod=+x", "a.txt"], race);
	let concurrent;
	const raced = stubGitHub(() => { throw new Error("GitHub is not part of this commit"); }, (args) => {
		assert.ok(!args.includes("push"), "a losing correction never starts a push");
		if (!args.includes("update-ref") || !args.includes("refs/heads/main")) { return; }
		write("concurrent.txt", "Independently committed content\n", race);
		git(["add", "concurrent.txt"], race);
		git(["commit", "-qm", "Concurrent actor commit"], race);
		concurrent = head(race);
	});
	const racedResult = await raced.api.commitFiles(race, Object.assign(Object.create(null), { paths: ["a.txt"], message: "Keep executable mode", push: true }));
	assert.ok(concurrent, `another commit landed immediately before the ref update: ${JSON.stringify(racedResult)}`);
	assert.equal(racedResult.ok, false);
	assert.equal(racedResult.committed, true);
	assert.match(racedResult.error, /staged executable modes could not be included/);
	assert.equal(head(race), concurrent);
	assert.equal(git(["show", "HEAD:concurrent.txt"], race), "Independently committed content\n");
	assert.equal(git(["status", "--porcelain"], race), "");
	const original = git(["rev-parse", "HEAD^"], race).trim();
	assert.ok(original.startsWith(racedResult.sha));
	assert.equal(mode(race, "a.txt", original), "100644");
	assert.equal(git(["rev-parse", "refs/heads/main"], modeRemote), pushedMode);
	console.log("PASS atomic mode correction keeps a concurrent commit and withholds the push");

	const refused = create("commit-hook-refused");
	write("new.txt", "new\n", refused);
	hook(refused, "pre-commit", "echo 'lint refused'\nexit 1");
	const refusedHead = head(refused);
	const refusal = await commitFiles(refused, { paths: ["new.txt"], message: "Hook fails" });
	assert.equal(refusal.error, "lint refused");
	assert.equal(head(refused), refusedHead);
	assert.equal(git(["status", "--porcelain"], refused), "?? new.txt\n", "intent-to-add is rolled back after a failed hook");
	fs.unlinkSync(path.join(refused, ".git", "hooks", "pre-commit"));
	assert.equal((await commitFiles(refused, { paths: ["new.txt"], message: "Retry" })).ok, true, "a hook failure releases the repository lock");
	const silent = create("commit-hook-silent");
	git(["config", "core.autocrlf", "true"], silent);
	write("new.txt", "LF only\n", silent);
	hook(silent, "pre-commit", "exit 1");
	assert.equal((await commitFiles(silent, { paths: ["new.txt"], message: "Silent hook" })).error, "Git failed.", "CRLF warnings are not the failure reason");
	const glob = create("commit-hook-glob", { "checked.js": "old\n" });
	write("checked.js", "new\n", glob);
	hook(glob, "pre-commit", "printf '%s' \"$GIT_LITERAL_PATHSPECS\" > .git/literal-seen\ngit diff --cached --name-only -- '*.js' > .git/js-seen");
	assert.equal((await commitFiles(glob, { paths: ["checked.js"], message: "Hooks use their globs" })).ok, true);
	assert.equal(fs.readFileSync(path.join(glob, ".git", "literal-seen"), "utf8"), "");
	assert.equal(fs.readFileSync(path.join(glob, ".git", "js-seen"), "utf8"), "checked.js\n");
	console.log("PASS direct commit hooks: failures roll back intent, silent CRLF warnings filtered, hook glob semantics preserved");

	const literal = create("commit-literal", { "[ab].txt": "old\n", "-x.txt": "old\n", "a.txt": "old\n", "b.txt": "old\n" });
	for (const file of ["[ab].txt", "-x.txt", "a.txt", "b.txt"]) { write(file, "changed\n", literal); }
	assert.equal((await commitFiles(literal, { paths: ["[ab].txt", "-x.txt"], message: "Literal names" })).ok, true);
	assert.deepEqual(changed(literal), ["-x.txt", "[ab].txt"]);
	assert.equal(git(["diff", "--name-only"], literal), "a.txt\nb.txt\n");
	const nested = create("commit-subfolder", { "nested/a.txt": "old\n", "outside.txt": "old\n" });
	write("nested/a.txt", "changed\n", nested);
	write("outside.txt", "changed\n", nested);
	assert.equal((await commitFiles(path.join(nested, "nested"), { paths: ["./a.txt"], message: "Relative to session" })).ok, true);
	assert.deepEqual(changed(nested), ["nested/a.txt"]);
	assert.equal(git(["diff", "--name-only"], nested), "outside.txt\n");
	console.log("PASS direct commit paths: bracket and leading-dash literals, normalized subfolder-relative paths");

	const invalidFolder = create("commit-invalid");
	const invalidHead = head(invalidFolder);
	const file = path.resolve(__dirname, "../electron/git.cjs");
	const localRequire = createRequire(file);
	const loaded = { exports: {} };
	let invalidSpawns = 0;
	vm.runInNewContext(fs.readFileSync(file, "utf8"), { module: loaded, Object, process, require(name) {
		if (name === "child_process") { return { spawn() { invalidSpawns++; throw new Error("Invalid input must not call git"); } }; }
		return localRequire(name);
	} });
	const valid = { paths: ["a.txt"], message: "Message" };
	for (const options of [null, [], "invalid", new Date(), { ...valid, paths: [] }, { ...valid, paths: ["../outside"] }, { ...valid, paths: [path.resolve(invalidFolder, "a.txt")] }, { ...valid, paths: ["bad\0name"] }, { ...valid, paths: ["bad\nname"] }, { ...valid, paths: ["bad\rname"] }, { ...valid, paths: [""] }, { ...valid, paths: [42] }, { ...valid, paths: Array(1001).fill("a.txt") }, { ...valid, message: "" }, { ...valid, message: " \n " }, { ...valid, message: "bad\0message" }, { ...valid, message: "x".repeat(10001) }, { ...valid, push: "yes" }]) {
		assert.equal((await loaded.exports.commitFiles(invalidFolder, options)).ok, false);
	}
	assert.equal(invalidSpawns, 0, "pure invalid-input checks run before the git repository probe");
	assert.equal(head(invalidFolder), invalidHead);
	write("a.txt", "changed\n", invalidFolder);
	assert.equal((await commitFiles(invalidFolder, { ...valid, expected: "feature" })).error, "The checkout changed to main. Refresh, then commit again.");
	assert.equal(head(invalidFolder), invalidHead);
	git(["checkout", "--quiet", "--detach"], invalidFolder);
	assert.equal((await commitFiles(invalidFolder, { ...valid, push: true })).error, "Switch to a branch before pushing.");
	assert.equal(head(invalidFolder), invalidHead);
	console.log("PASS direct commit validation: invalid options/paths/messages without git calls, stale branch and detached push refusals");

	const merging = create("commit-merge");
	git(["checkout", "--quiet", "-b", "other"], merging);
	write("a.txt", "other\n", merging);
	git(["add", "a.txt"], merging); git(["commit", "--quiet", "-m", "Other"], merging);
	git(["checkout", "--quiet", "main"], merging);
	write("a.txt", "main\n", merging);
	git(["add", "a.txt"], merging); git(["commit", "--quiet", "-m", "Main"], merging);
	assert.throws(() => git(["merge", "other"], merging));
	write("a.txt", "resolved\n", merging);
	git(["add", "a.txt"], merging);
	const mergingHead = head(merging);
	const mergingStatus = git(["status", "--porcelain"], merging);
	assert.match((await commitFiles(merging, { paths: ["a.txt"], message: "Partial merge" })).error, /cannot do a partial commit during a merge\./);
	assert.equal(head(merging), mergingHead);
	assert.equal(git(["status", "--porcelain"], merging), mergingStatus);
	console.log("PASS direct commit merge: resolved merge refuses a partial commit without changing HEAD or index");

	const remote = path.join(root, "commit-origin.git");
	git(["init", "--quiet", "--bare", remote], root);
	const pushing = create("commit-push");
	git(["remote", "add", "origin", remote], pushing);
	hook(pushing, "pre-push", "printf ran >> .git/push-seen");
	for (const version of ["first", "second"]) {
		write("a.txt", `${version}\n`, pushing);
		const pushed = await commitFiles(pushing, { paths: ["a.txt"], message: version, push: true });
		assert.equal(pushed.ok, true, JSON.stringify(pushed));
		assert.equal(git(["rev-parse", "refs/heads/main"], remote).trim(), head(pushing));
		assert.equal(pushed.message, `Committed ${pushed.sha} and pushed main.`);
	}
	assert.equal(fs.readFileSync(path.join(pushing, ".git", "push-seen"), "utf8"), "ranran", "both push forms run the real pre-push hook");
	const pushFailure = create("commit-push-failed");
	git(["remote", "add", "origin", path.join(root, "missing-origin.git")], pushFailure);
	write("a.txt", "changed\n", pushFailure);
	const notPushed = await commitFiles(pushFailure, { paths: ["a.txt"], message: "Kept locally", push: true });
	assert.equal(notPushed.ok, false);
	assert.equal(notPushed.committed, true);
	assert.ok(head(pushFailure).startsWith(notPushed.sha));
	assert.match(notPushed.error, /^Committed .+, but the push failed:/);
	assert.equal(git(["log", "-1", "--format=%s"], pushFailure).trim(), "Kept locally");
	console.log("PASS direct commit push: local bare origin with/without upstream, pre-push hooks and preserved commit on offline failure");

	const timeoutRepo = create("commit-timeout");
	git(["remote", "add", "origin", remote], timeoutRepo);
	const node = process.execPath.replace(/\\/g, "/");
	hook(timeoutRepo, "post-commit", `"${node}" -e 'setTimeout(() => {}, 5000)' &`);
	hook(timeoutRepo, "pre-push", "printf ran > .git/push-seen");
	write("a.txt", "changed\n", timeoutRepo);
	const landed = await commitFiles(timeoutRepo, { paths: ["a.txt"], message: "Landed before timeout", push: true }, { timeout: 1200 });
	assert.equal(landed.ok, false, JSON.stringify(landed));
	assert.equal(landed.committed, true, JSON.stringify(landed));
	assert.ok(head(timeoutRepo).startsWith(landed.sha));
	assert.match(landed.error, /but git did not finish cleanly: Git timed out\./);
	assert.match(landed.error, /Git was stopped\./);
	assert.equal(git(["log", "-1", "--format=%s"], timeoutRepo).trim(), "Landed before timeout");
	assert.equal(fs.existsSync(path.join(timeoutRepo, ".git", "push-seen")), false, "a timed-out commit never starts its optional push");
	console.log("PASS direct commit timeout: post-commit background stdout reports landed HEAD honestly and never pushes");

	const locked = create("commit-lock", { "a.txt": "base\n", "nested/b.txt": "base\n" });
	hook(locked, "pre-commit", `printf started > .git/commit-started\n"${node}" -e 'setTimeout(() => {}, 1000)'`);
	write("a.txt", "changed\n", locked);
	const running = commitFiles(locked, { paths: ["a.txt"], message: "First" });
	const marker = path.join(locked, ".git", "commit-started");
	for (let attempt = 0; !fs.existsSync(marker) && attempt < 100; attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); }
	assert.equal(fs.existsSync(marker), true, "the first commit reached its hook");
	assert.equal((await commitFiles(path.join(locked, "nested"), { paths: ["b.txt"], message: "Second" })).error, "A commit is already running in this repository.");
	assert.equal((await running).ok, true);
	fs.unlinkSync(path.join(locked, ".git", "hooks", "pre-commit"));
	write("a.txt", "again\n", locked);
	assert.equal((await commitFiles(locked, { paths: ["a.txt"], message: "After release" })).ok, true);
	console.log("PASS direct commit lock: concurrent subfolder commit refused, successful completion releases the repository");

	const unborn = create("commit-unborn", { "new.txt": "new\n" }, false);
	hook(unborn, "pre-commit", "echo 'first refused' >&2\nexit 1");
	assert.equal((await commitFiles(unborn, { paths: ["new.txt"], message: "First" })).error, "first refused");
	assert.equal(git(["status", "--porcelain"], unborn), "?? new.txt\n", "rollback also works before the first HEAD exists");
	fs.unlinkSync(path.join(unborn, ".git", "hooks", "pre-commit"));
	assert.equal((await commitFiles(unborn, { paths: ["new.txt"], message: "First" })).ok, true);
	const long = create("commit-long");
	const longPaths = Array.from({ length: 1000 }, (_, index) => `long-${String(index).padStart(4, "0")}-${"x".repeat(76)}.txt`);
	for (const file of longPaths) { write(file, "new\n", long); }
	const longCommit = await commitFiles(long, { paths: longPaths, message: "1000 long paths" });
	assert.equal(longCommit.ok, true, JSON.stringify(longCommit));
	assert.equal(git(["ls-tree", "--name-only", "HEAD"], long).trim().split(/\r?\n/).length, 1001);
	assert.equal(git(["status", "--porcelain"], long), "");
	console.log("PASS direct commit scale: unborn branch rollback/commit and 1000 long file paths");
}

async function checkHunkReverts() {
	const create = (name, files, autocrlf = "false") => {
		const folder = path.join(root, name);
		git(["init", "--quiet", "-b", "main", folder], root);
		for (const [key, value] of [["user.name", "GrokCode test"], ["user.email", "test@example.invalid"], ["core.autocrlf", autocrlf], ["commit.gpgsign", "false"], ["core.hooksPath", os.devNull]]) { git(["config", key, value], folder); }
		for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); write(file, content, folder); }
		git(["add", "--all"], folder);
		git(["commit", "--quiet", "-m", "Hunk fixtures"], folder);
		return folder;
	};
	const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1).padStart(2, "0")}`);
	const base = `${lines.join("\n")}\n`;
	const both = base.replace("line 04", "first edit").replace("line 25", "second edit");
	const hunks = async (folder, file = "sample.txt") => (await readDiff(folder)).files.find((entry) => entry.path === file).hunks;
	const choice = create("hunk-choice", { "sample.txt": base });
	write("sample.txt", both, choice);
	let shown = await hunks(choice);
	assert.equal(shown.length, 2);
	assert.ok(shown.every((hunk) => hunk.revertible === true));
	const indexBefore = fs.readFileSync(path.join(choice, ".git", "index"));
	assert.equal((await revertHunk(choice, "sample.txt", shown[1])).ok, true);
	assert.equal(fs.readFileSync(path.join(choice, "sample.txt"), "utf8"), base.replace("line 04", "first edit"));
	assert.deepEqual(fs.readFileSync(path.join(choice, ".git", "index")), indexBefore, "the raw index bytes are untouched");
	write("sample.txt", both, choice);
	shown = await hunks(choice);
	assert.equal((await revertHunk(choice, "sample.txt", shown[0])).ok, true);
	assert.equal(fs.readFileSync(path.join(choice, "sample.txt"), "utf8"), base.replace("line 25", "second edit"));
	console.log("PASS hunk revert selection: either of two hunks restores alone and index bytes stay unchanged");

	const crlfBase = base.replace(/\n/g, "\r\n");
	const endings = create("hunk-line-endings-only", { "sample.txt": base });
	write("sample.txt", crlfBase, endings);
	assert.deepEqual(await revertHunk(endings, "sample.txt", (await hunks(endings))[0]), { ok: false, error: "This change cannot be reverted on its own. Use Revert file instead." });
	assert.equal(fs.readFileSync(path.join(endings, "sample.txt"), "utf8"), crlfBase);
	console.log("PASS hunk revert reports a no-op for line-ending-only changes");
	const crlf = create("hunk-crlf", { "sample.txt": crlfBase }, "true");
	assert.equal(git(["show", ":sample.txt"], crlf).includes("\r"), false, "autocrlf stores LF in the index");
	write("sample.txt", crlfBase.replace("line 04", "first edit").replace("line 25", "second edit"), crlf);
	assert.equal((await revertHunk(crlf, "sample.txt", (await hunks(crlf))[1])).ok, true);
	assert.deepEqual(fs.readFileSync(path.join(crlf, "sample.txt")), Buffer.from(crlfBase.replace("line 04", "first edit")), "every retained byte including each CRLF is preserved");
	const mixedBase = lines.map((line, index) => `${line}${index % 2 ? "\n" : "\r\n"}`).join("");
	const mixed = create("hunk-mixed", { "sample.txt": mixedBase });
	write("sample.txt", mixedBase.replace("line 04", "first edit").replace("line 25", "second edit"), mixed);
	assert.equal((await revertHunk(mixed, "sample.txt", (await hunks(mixed))[1])).ok, true);
	assert.deepEqual(fs.readFileSync(path.join(mixed, "sample.txt")), Buffer.from(mixedBase.replace("line 04", "first edit")), "mixed endings outside the selected edit are byte-for-byte unchanged");
	const noEndBase = lines.join("\n");
	const noEnd = create("hunk-no-ending", { "sample.txt": noEndBase });
	write("sample.txt", noEndBase.replace("line 04", "first edit").replace("line 30", "last edit"), noEnd);
	assert.equal((await revertHunk(noEnd, "sample.txt", (await hunks(noEnd)).at(-1))).ok, true);
	assert.deepEqual(fs.readFileSync(path.join(noEnd, "sample.txt")), Buffer.from(noEndBase.replace("line 04", "first edit")), "restoring the final line keeps its absent EOF newline");
	console.log("PASS hunk revert bytes: autocrlf CRLF, mixed line endings and no newline at EOF");
	const legacy = create("hunk-legacy-index", { "sample.txt": Buffer.from(base.replace("line 25", "caf\xe9"), "latin1") });
	const converted = Buffer.from(base.replace("line 25", "caf\u00e9 updated"), "utf8");
	write("sample.txt", converted, legacy);
	const legacyHunk = (await hunks(legacy))[0];
	assert.equal((await revertHunk(legacy, "sample.txt", legacyHunk)).ok, false, "legacy index bytes must never be decoded into replacement characters and saved");
	assert.deepEqual(fs.readFileSync(path.join(legacy, "sample.txt")), converted);
	console.log("PASS hunk revert encoding: a legacy-encoded index refuses without rewriting the UTF-8 working file");

	const nested = create("hunk-subfolder", { "nested/sample.txt": base, "outside.txt": "keep\n" });
	write("nested/sample.txt", both, nested);
	const sessionFolder = path.join(nested, "nested");
	assert.equal((await revertHunk(sessionFolder, "sample.txt", (await hunks(sessionFolder))[1])).ok, true);
	assert.equal(fs.readFileSync(path.join(nested, "nested/sample.txt"), "utf8"), base.replace("line 04", "first edit"));
	assert.equal(fs.readFileSync(path.join(nested, "outside.txt"), "utf8"), "keep\n");
	const stale = create("hunk-stale", { "sample.txt": base });
	write("sample.txt", both, stale);
	const old = (await hunks(stale))[1];
	const changedText = both.replace("second edit", "later edit");
	write("sample.txt", changedText, stale);
	assert.equal((await revertHunk(stale, "sample.txt", old)).error, "This change is no longer in the file. Refresh, then try again.");
	assert.equal(fs.readFileSync(path.join(stale, "sample.txt"), "utf8"), changedText);
	const current = (await hunks(stale))[1];
	assert.equal((await revertHunk(stale, "sample.txt", { ...current, lines: current.lines.map((line) => ({ ...line, text: "forged" })) })).ok, false, "the host checks line content as well as id and location");
	assert.equal(fs.readFileSync(path.join(stale, "sample.txt"), "utf8"), changedText);
	console.log("PASS hunk revert freshness: subfolder paths resolve correctly, stale or forged content never writes");

	const staged = create("hunk-staged", { "sample.txt": base });
	const stagedText = base.replace("line 04", "staged edit");
	write("sample.txt", stagedText, staged);
	git(["add", "sample.txt"], staged);
	write("sample.txt", stagedText.replace("line 25", "working edit"), staged);
	const stagedHunks = await hunks(staged);
	const stagedOnly = stagedHunks.find((hunk) => hunk.loc.startsWith("Staged "));
	const workingOnly = stagedHunks.find((hunk) => hunk.revertible === true);
	assert.equal(stagedOnly.revertible, undefined);
	assert.ok(workingOnly);
	const stagedIndex = fs.readFileSync(path.join(staged, ".git", "index"));
	const stagedPatch = git(["diff", "--cached"], staged);
	assert.equal((await revertHunk(staged, "sample.txt", { ...stagedOnly, revertible: true })).ok, false, "renderer metadata cannot authorize a staged hunk");
	assert.equal((await revertHunk(staged, "sample.txt", workingOnly)).ok, true);
	assert.equal(fs.readFileSync(path.join(staged, "sample.txt"), "utf8"), stagedText);
	assert.deepEqual(fs.readFileSync(path.join(staged, ".git", "index")), stagedIndex);
	assert.equal(git(["diff", "--cached"], staged), stagedPatch);
	console.log("PASS hunk revert staging: working changes return to index content while staged hunks and index bytes remain intact");

	const filtered = create("hunk-filtered", { "sample.txt": base });
	write("sample.txt", both, filtered);
	write(".gitattributes", "sample.txt filter=unsafe\n", filtered);
	const marker = path.join(root, "hunk-filter-ran");
	const driver = path.join(root, "hunk-filter.cjs");
	fs.writeFileSync(driver, `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);`);
	git(["config", "filter.unsafe.clean", `node "${driver.replace(/\\/g, "/")}"`], filtered);
	const filteredHunks = await hunks(filtered);
	assert.ok(filteredHunks.every((hunk) => hunk.revertible !== true));
	assert.equal((await revertHunk(filtered, "sample.txt", { ...filteredHunks[0], revertible: true })).error, "This file uses a Git filter. Revert it from a terminal.");
	assert.equal(fs.existsSync(marker), false, "neither the diff nor the refusal runs the local filter");
	assert.equal(fs.readFileSync(path.join(filtered, "sample.txt"), "utf8"), both);
	const outside = path.join(root, "hunk-outside");
	fs.mkdirSync(outside);
	write("outside.txt", "outside\n", outside);
	const link = path.join(choice, "outside-link");
	fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
	assert.equal((await revertHunk(choice, "outside-link/outside.txt", shown[0])).ok, false);
	assert.equal((await revertHunk(choice, "../hunk-outside/outside.txt", shown[0])).ok, false);
	assert.equal((await revertHunk(path.join(root, "no-folder"), "sample.txt", shown[0])).ok, false);
	assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "outside\n");
	console.log("PASS hunk revert refusals: effective filters never execute, escaped symlinks and outside/missing folders cannot write");

	const unsupported = create("hunk-unsupported", { "sample.txt": base, "binary.bin": Buffer.from([0, 1, 2]) });
	write("new.txt", "untracked\n", unsupported);
	write("binary.bin", Buffer.from([0, 3, 4]), unsupported);
	write("sample.txt", `${"new line\n".repeat(900)}`, unsupported);
	const unsupportedDiff = await readDiff(unsupported);
	assert.ok(unsupportedDiff.files.every((file) => file.hunks.every((hunk) => hunk.revertible !== true)), "untracked, binary and incomplete hunks expose no action");
	for (const file of unsupportedDiff.files) { assert.equal((await revertHunk(unsupported, file.path, { ...file.hunks[0], revertible: true })).ok, false); }
	const superFolder = create("hunk-super", { "base.txt": "base\n" });
	const subFolder = create("hunk-super/sub", { "sub.txt": "old\n" });
	const oldCommit = git(["rev-parse", "HEAD"], subFolder).trim();
	git(["update-index", "--add", "--cacheinfo", `160000,${oldCommit},sub`], superFolder);
	git(["commit", "--quiet", "-m", "Submodule link"], superFolder);
	write("sub.txt", "new\n", subFolder);
	git(["add", "sub.txt"], subFolder);
	git(["commit", "--quiet", "-m", "Submodule change"], subFolder);
	const subDiff = (await readDiff(superFolder)).files.find((file) => file.path === "sub");
	assert.ok(subDiff);
	assert.ok(subDiff.hunks.every((hunk) => hunk.revertible !== true));
	assert.equal((await revertHunk(superFolder, "sub", subDiff.hunks[0])).ok, false);
	console.log("PASS hunk revert eligibility: staged, untracked, binary, truncated and submodule hunks cannot opt themselves in");
}

async function checkPrHeads() {
	const folder = path.join(root, "pr-heads");
	const remoteFolder = path.join(root, "pr-heads-origin's.git");
	git(["init", "--quiet", "-b", "main", folder], root);
	git(["init", "--quiet", "--bare", remoteFolder], root);
	git(["config", "user.name", "GrokCode test"], folder);
	git(["config", "user.email", "test@example.invalid"], folder);
	git(["remote", "add", "origin", remoteFolder], folder);
	git(["remote", "add", "upstream", remoteFolder], folder);
	git(["remote", "add", "grok-pr-target", remoteFolder], folder);
	write("data.txt", "base\n", folder);
	git(["add", "--all"], folder);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "Base"], folder);
	const initial = git(["rev-parse", "HEAD"], folder).trim();
	write("data.txt", "upstream base\n", folder);
	git(["commit", "--quiet", "--no-gpg-sign", "-am", "Already upstream"], folder);
	const remoteBase = git(["rev-parse", "HEAD"], folder).trim();
	for (const name of ["main", "release"]) { git(["update-ref", `refs/remotes/upstream/${name}`, remoteBase], folder); }
	git(["switch", "--quiet", "-c", "pinned-feature"], folder);
	git(["update-ref", "refs/heads/main", initial], folder);
	write("data.txt", "first\n", folder);
	git(["add", "--all"], folder);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "First subject", "-m", "First body"], folder);
	git(["tag", "pinned-feature", initial], folder);
	git(["update-ref", "refs/remotes/origin/main", git(["rev-parse", "HEAD"], folder).trim()], folder);
	const included = path.join(root, "pr-conditional-config");
	fs.writeFileSync(included, "[review]\n\tconditional = retained\n");
	git(["config", `includeIf.gitdir:${path.join(folder, ".git").replace(/\\/g, "/")}.path`, included], folder);
	const inheritedParameters = process.env.GIT_CONFIG_PARAMETERS;
	const quotedRemote = `'${remoteFolder.replace(/'/g, "'\\''")}'`;
	process.env.GIT_CONFIG_PARAMETERS = `${inheritedParameters || ""} 'remote.origin.url'=${quotedRemote} 'remote.upstream.url'=${quotedRemote} 'remote.upstream.gh-resolved'='base' 'review.commandScope'='retained'`.trim();
	let baseRepository;
	let headRepository;
	let fetchRepository;
	let baseFetch;
	let pushTarget;
	const configure = (host, headName, target, fetch = `https://${host}/team/project.git`) => {
		baseRepository = { id: "base-id", nameWithOwner: "team/project", url: `https://${host}/team/project`, defaultBranchRef: { name: "main" } };
		headRepository = { ...baseRepository, id: headName === "team/project" ? "base-id" : "fork-id", nameWithOwner: headName, url: `https://${host}/${headName}` };
		fetchRepository = headRepository.id === baseRepository.id ? baseRepository : { ...baseRepository, id: "fetch-id", nameWithOwner: "fetcher/project", url: `https://${host}/fetcher/project` };
		baseFetch = fetch;
		pushTarget = target;
		git(["config", "test.pr-push", target], folder);
		git(["config", "test.pr-remotes", `upstream\t${fetch} (fetch)\norigin\t${target} (fetch)`], folder);
	};
	const field = (args, name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
	const metadataReads = [];
	const client = (createReply) => stubGitHub((args, options) => {
		if (args[0] === "repo") {
			if (args.includes("defaultBranchRef")) { return { out: "main\n" }; }
			let answer = baseRepository;
			if (options.env.GH_REPO === "") {
				const listed = execFileSync("git", ["config", "--null", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], { cwd: folder, env: options.env, encoding: "utf8", windowsHide: true });
				const remotes = new Map();
				for (const record of listed.split("\0").filter(Boolean)) {
					const split = record.indexOf("\n");
					const key = /^remote\.(.*)\.(url|gh-resolved)$/.exec(record.slice(0, split));
					if (!key) { continue; }
					const remote = remotes.get(key[1]) || {};
					const value = record.slice(split + 1);
					// Git before 2.46 keeps the first URL when later entries are empty.
					if (key[2] === "url" && value && !remote.url) { remote.url = value; }
					if (key[2] === "gh-resolved") { remote.resolved = value; }
					remotes.set(key[1], remote);
				}
				const selected = [...remotes].find(([, entry]) => entry.resolved === "base");
				const target = selected?.[1].url;
				const nativeRemotes = execFileSync("git", ["remote", "-v"], { cwd: folder, env: options.env, encoding: "utf8", windowsHide: true });
				metadataReads.push({
					target,
					nativeTarget: nativeRemotes.split(/\r?\n/).includes(`${selected?.[0]}\t${target} (fetch)`),
					conditional: execFileSync("git", ["config", "--get", "review.conditional"], { cwd: folder, env: options.env, encoding: "utf8", windowsHide: true }).trim(),
					commandScope: execFileSync("git", ["config", "--get", "review.commandScope"], { cwd: folder, env: options.env, encoding: "utf8", windowsHide: true }).trim(),
				});
				answer = target === baseFetch ? baseRepository : target === pushTarget ? headRepository : fetchRepository;
			}
			return { out: JSON.stringify(answer) };
		}
		if (args.includes("--paginate")) { return { out: "" }; }
		if (createReply !== undefined) { return typeof createReply === "function" ? createReply(args) : createReply; }
		const selected = args.includes("--head") ? args[args.indexOf("--head") + 1]
			: `${(field(args, "headRepository") === "fork-id" ? headRepository : fetchRepository).nameWithOwner.split("/")[0]}:${field(args, "branch")}`;
		return { out: `https://example.invalid/pull/25?head=${selected}\n` };
	}, (args) => {
		const at = args.indexOf("remote");
		if (at < 0) { return; }
		if (args[at + 1] === "get-url") { args.splice(at, args.length - at, "config", "--get", "test.pr-push"); }
		if (args[at + 1] === "-v") { args.splice(at, args.length - at, "config", "--get", "test.pr-remotes"); }
	});
	configure("github.com", "team/project", remoteFolder);
	const lateSwitch = client((args) => {
		git(["switch", "--quiet", "main"], folder);
		const selected = args.includes("--head") ? args[args.indexOf("--head") + 1] : git(["branch", "--show-current"], folder).trim();
		return { out: `https://example.invalid/pull/25?head=${selected}\n` };
	});
	const lateResult = await lateSwitch.api.prCreate(folder, {});
	assert.equal(lateResult.ok, true, JSON.stringify(lateResult));
	assert.equal(lateResult.url, "https://example.invalid/pull/25?head=pinned-feature");
	const sameArgs = lateSwitch.calls.find((args) => args[0] === "pr");
	assert.equal(sameArgs[sameArgs.indexOf("--repo") + 1], baseRepository.url);
	assert.equal(sameArgs[sameArgs.indexOf("--base") + 1], "main");
	assert.equal(field(sameArgs, "--title"), "First subject");
	assert.equal(field(sameArgs, "--body"), "First body");
	git(["switch", "--quiet", "pinned-feature"], folder);
	console.log("PASS prCreate pinned head: a late checkout switch and matching tag preserve the pushed branch, repository and generated single-commit title/body");

	configure("github.com", "contributor/project", "https://github.com/contributor/project.git");
	const userFork = client();
	const forkResult = await userFork.api.prCreate(folder, {});
	assert.equal(forkResult.ok, true);
	assert.equal(forkResult.url, "https://example.invalid/pull/25?head=contributor:pinned-feature", "Git 2.39's additive URLs must not substitute the fetch repository for the push destination");
	const userCreate = userFork.calls.find((args) => args[0] === "pr");
	assert.equal(userCreate[userCreate.indexOf("--head") + 1], "contributor:pinned-feature", "Git 2.39's additive URL behavior cannot substitute the fetch repository for the push destination");
	assert.equal(field(userCreate, "--title"), "First subject", "a stale local base cannot add commits already in the remote base");
	assert.equal(field(userCreate, "--body"), "First body");
	git(["branch", "-D", "main"], folder);
	const missingLocalBase = client();
	assert.equal((await missingLocalBase.api.prCreate(folder, {})).ok, true, "a fork PR uses its remote base when the local base branch is missing");
	assert.equal(field(missingLocalBase.calls.find((args) => args[0] === "pr"), "--title"), "First subject");
	write("data.txt", "second\n", folder);
	git(["add", "--all"], folder);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "Second subject", "-m", "Second body"], folder);
	configure("enterprise.invalid:8443", "contributor/project", "git@enterprise-work:contributor/project.git", "git@enterprise-work:team/project.git");
	git(["config", "branch.pinned-feature.gh-merge-base", "release"], folder);
	const enterpriseFork = client();
	assert.equal((await enterpriseFork.api.prCreate(folder, { draft: true })).ok, true);
	const enterpriseCreate = enterpriseFork.calls.find((args) => args[0] === "pr");
	assert.equal(enterpriseCreate[enterpriseCreate.indexOf("--repo") + 1], baseRepository.url);
	assert.equal(enterpriseCreate[enterpriseCreate.indexOf("--head") + 1], "contributor:pinned-feature");
	assert.equal(enterpriseCreate[enterpriseCreate.indexOf("--base") + 1], "release");
	assert.equal(field(enterpriseCreate, "--title"), "pinned feature");
	assert.equal(field(enterpriseCreate, "--body"), "- **First subject**\n- **Second subject**\n");
	assert.equal(enterpriseCreate.includes("--draft"), true);
	const explicit = client();
	assert.equal((await explicit.api.prCreate(folder, { title: "Chosen title", body: "Chosen body", draft: true })).ok, true);
	const explicitCreate = explicit.calls.find((args) => args[0] === "pr");
	assert.equal(field(explicitCreate, "--title"), "Chosen title");
	assert.equal(field(explicitCreate, "--body"), "Chosen body");
	assert.equal(explicitCreate.includes("--draft"), true);
	const duplicate = client({ code: 1, err: "A pull request already exists: https://example.invalid/pull/24\n" });
	assert.equal((await duplicate.api.prCreate(folder, { title: "Chosen" })).url, "https://example.invalid/pull/24");
	const emptyUrl = client({ out: "null\n" });
	assert.equal((await emptyUrl.api.prCreate(folder, { title: "Chosen" })).ok, false);
	assert.equal(metadataReads.every((entry) => entry.conditional === "retained" && entry.commandScope === "retained"), true, "native repository lookup preserves conditional and inherited Git configuration");
	assert.equal(metadataReads.every((entry) => entry.nativeTarget), true, "gh's native remote listing includes the marked target alongside the original remotes");
	if (inheritedParameters === undefined) { delete process.env.GIT_CONFIG_PARAMETERS; } else { process.env.GIT_CONFIG_PARAMETERS = inheritedParameters; }
	console.log("PASS prCreate forks: Git 2.39 URL semantics, distinct push/fetch repositories, stale or missing local base, SSH aliases, enterprise hosts, title/body, draft and URL results");
}

async function main() {
	await checkPrHeads();
	await checkHunkReverts();
	await checkDirectCommits();
	checkBundledGitDir();
	await checkTruncatedRepoFiles();
	await checkTruncatedDiffCounts();
	git(["init", "--quiet", "--bare", origin], root);
	git(["init", "--quiet", "-b", "main", repo], root);
	git(["config", "core.autocrlf", "false"]);
	git(["config", "user.name", "GrokCode test"]);
	git(["config", "user.email", "test@example.invalid"]);
	write("base.txt", "base\n");
	write("keep.txt", "keep\n");
	commit("Base");
	git(["remote", "add", "origin", origin]);
	git(["push", "--quiet", "-u", "origin", "main"]);
	git(["remote", "set-head", "origin", "main"]);
	git(["checkout", "--quiet", "-b", "feature"]);
	write("feature.txt", "feature\n");
	commit("Feature work");
	const featureSha = git(["rev-parse", "HEAD"]).trim();
	write("keep.txt", "keep dirty\n");
	write("untracked.txt", "untracked\n");

	const info = await branchInfo(repo);
	assert.deepEqual(info, { ok: true, repo: true, branch: "feature", base: "main", ahead: 1, behind: 0, upstream: null });
	assert.deepEqual(await branchInfo(origin), { ok: true, repo: false });
	console.log("PASS branchInfo: feature branch, origin/HEAD base main, ahead 1; a folder with no work tree reports repo:false");
	git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"]);
	assert.deepEqual(await branchInfo(repo), info, "a missing origin/HEAD target falls back to local main");
	assert.deepEqual(paths(await readScopedDiff(repo, "branch")), ["feature.txt", "keep.txt", "untracked.txt"]);
	git(["remote", "set-head", "origin", "main"]);

	const uncommitted = await readScopedDiff(repo, "uncommitted");
	assert.equal(uncommitted.ok, true);
	assert.deepEqual(paths(uncommitted), ["keep.txt", "untracked.txt"]);
	console.log("PASS readScopedDiff uncommitted: only the uncommitted and untracked files");

	const branch = await readScopedDiff(repo, "branch");
	assert.equal(branch.ok, true);
	assert.equal(branch.truncated, false);
	assert.deepEqual(paths(branch), ["feature.txt", "keep.txt", "untracked.txt"]);
	const keep = branch.files.find((file) => file.path === "keep.txt").hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
	assert.deepEqual(keep, ["del:keep", "add:keep dirty"]);
	assert.ok(branch.files.every((file) => file.hunks.every((hunk) => typeof hunk.id === "string" && hunk.id.startsWith(`${file.path}:`))));
	console.log("PASS readScopedDiff branch: committed, uncommitted and untracked changes since the merge-base, with hunk ids");

	const single = await readScopedDiff(repo, featureSha.slice(0, 10));
	assert.equal(single.ok, true);
	assert.deepEqual(paths(single), ["feature.txt"]);
	assert.deepEqual(single.files[0].hunks[0].lines, [{ kind: "add", text: "feature" }]);
	console.log("PASS readScopedDiff sha: only that commit's change");
	for (const [scope, expected] of [["uncommitted", uncommitted], ["branch", branch], [featureSha, single]]) {
		const listing = await readChanges({ cwd: repo, scope });
		assert.equal(listing.ok, true, listing.error);
		assert.deepEqual(paths(listing), paths(expected));
	}
	const nested = path.join(repo, "nested");
	fs.mkdirSync(nested);
	write(" [test].txt", "literal\n", nested);
	assert.deepEqual(paths(await readChanges({ cwd: nested, scope: "branch" })), [" [test].txt"]);
	const nestedPatch = await readChanges({ cwd: nested, scope: "branch", file: " [test].txt" });
	assert.deepEqual(paths(nestedPatch), [" [test].txt"]);
	assert.equal((await readChanges({ cwd: nested, scope: "branch", file: "../keep.txt" })).ok, false);
	fs.unlinkSync(path.join(nested, " [test].txt"));
	fs.rmdirSync(nested);
	console.log("PASS progressive changes scopes: uncommitted, branch, commit and literal paths relative to the session folder");

	for (const scope of ["nope", "", undefined, "zzzzzzz", "abc12", "--all", "HEAD"]) {
		const rejected = await readScopedDiff(repo, scope);
		assert.equal(rejected.ok, false, String(scope));
		assert.ok(rejected.error);
	}
	assert.deepEqual(await readScopedDiff(repo, "deadbeefdeadbeef"), { ok: false, error: "That commit was not found." });
	console.log("PASS readScopedDiff: bad scopes, malformed SHAs and unknown commits are rejected");

	const listed = await listCommits(repo);
	assert.equal(listed.ok, true);
	assert.equal(listed.commits.length, 1);
	assert.equal(listed.commits[0].sha, featureSha);
	assert.equal(listed.commits[0].subject, "Feature work");
	assert.ok(featureSha.startsWith(listed.commits[0].short));
	assert.ok(!Number.isNaN(Date.parse(listed.commits[0].when)));
	console.log("PASS listCommits: the feature commit since base");

	const one = await addWorktree(repo, { name: "one", prefix: "grok" });
	assert.equal(one.ok, true, JSON.stringify(one));
	assert.equal(one.branch, "grok/one");
	assert.equal(one.folder, path.join(repo, ".grok", "worktrees", "one"));
	assert.ok(fs.existsSync(path.join(one.folder, "feature.txt")));
	assert.equal(git(["rev-parse", "--verify", "refs/heads/grok/one"]).trim(), featureSha);
	const two = await addWorktree(repo, { name: "two", prefix: "grok" });
	assert.equal(two.ok, true, JSON.stringify(two));
	const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split(/\r?\n/);
	assert.equal(exclude.filter((line) => line === ".grok/worktrees/").length, 1);
	assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
	assert.ok(!git(["status", "--porcelain"]).includes(".grok"));
	console.log("PASS addWorktree: folder and branch created; info/exclude line written once; .gitignore untouched");

	const infoDir = path.join(repo, ".git", "info");
	const savedInfo = `${infoDir}-saved`;
	const outsideInfo = path.join(root, "outside-info");
	const rejectedExclude = { ok: false, error: "Git info/exclude must be a regular file inside the repository's Git folder." };
	const excludeTest = { name: "unsafe-exclude", prefix: "grok" };
	fs.mkdirSync(outsideInfo);
	write("exclude", "# outside the Git folder\n", outsideInfo);
	fs.renameSync(infoDir, savedInfo);
	fs.symlinkSync(outsideInfo, infoDir, process.platform === "win32" ? "junction" : "dir");
	assert.deepEqual(await addWorktree(repo, excludeTest), rejectedExclude);
	assert.equal(fs.readFileSync(path.join(outsideInfo, "exclude"), "utf8"), "# outside the Git folder\n");
	fs.unlinkSync(infoDir);
	fs.renameSync(savedInfo, infoDir);
	console.log("PASS addWorktree: refuses an info directory that resolves outside the Git folder");

	const excludePath = path.join(infoDir, "exclude");
	const savedExclude = `${excludePath}-saved`;
	fs.renameSync(excludePath, savedExclude);
	let symlinkCreated = false;
	try {
		fs.symlinkSync(savedExclude, excludePath, "file");
		symlinkCreated = true;
	} catch (error) {
		if (process.platform !== "win32" || error.code !== "EPERM") { throw error; }
		console.log("SKIP addWorktree: file symlink creation requires Windows developer mode or elevation");
	}
	if (symlinkCreated) {
		assert.deepEqual(await addWorktree(repo, excludeTest), rejectedExclude);
		fs.unlinkSync(excludePath);
		console.log("PASS addWorktree: refuses an exclude symlink even inside the Git folder");
	}
	fs.renameSync(savedExclude, excludePath);

	const hardlinkTarget = path.join(outsideInfo, "hardlink-target");
	fs.writeFileSync(hardlinkTarget, "# shared file outside the Git folder\n");
	fs.renameSync(excludePath, savedExclude);
	fs.linkSync(hardlinkTarget, excludePath);
	assert.equal(fs.statSync(excludePath).nlink, 2);
	assert.deepEqual(await addWorktree(repo, excludeTest), { ok: false, error: "Git info/exclude has more than one link and cannot be updated safely." });
	assert.equal(fs.readFileSync(hardlinkTarget, "utf8"), "# shared file outside the Git folder\n");
	fs.unlinkSync(excludePath);
	fs.renameSync(savedExclude, excludePath);
	console.log("PASS addWorktree: refuses a hardlinked exclude without modifying the shared file");

	for (const bad of [{ name: "bad name", prefix: "grok" }, { name: "-x", prefix: "grok" }, { name: "ok", prefix: "a/b" }, { name: "x".repeat(41), prefix: "grok" }, { prefix: "grok" }, null]) {
		const rejected = await addWorktree(repo, bad);
		assert.equal(rejected.ok, false, JSON.stringify(bad));
		assert.ok(rejected.error);
	}
	assert.deepEqual(await addWorktree(repo, { name: "one", prefix: "other" }), { ok: false, error: "A worktree with that name already exists." });
	console.log("PASS addWorktree: invalid names and an existing folder are rejected");

	write("dirty.txt", "work in progress\n", one.folder);
	git(["config", "status.showUntrackedFiles", "no"]);
	assert.deepEqual(await removeWorktree(repo, one.folder), { ok: false, dirty: true, error: "This worktree has uncommitted changes." });
	git(["config", "--unset", "status.showUntrackedFiles"]);
	assert.ok(fs.existsSync(path.join(one.folder, "dirty.txt")));
	assert.deepEqual(await removeWorktree(one.folder, one.folder), { ok: false, dirty: true, error: "This worktree has uncommitted changes." }, "a worktree session can start from its own folder");
	assert.deepEqual(await removeWorktree(one.folder, one.folder, { force: true }), { ok: true, dirty: true }, "git runs from the main checkout, so the session's own worktree is removed");
	assert.equal(fs.existsSync(one.folder), false);
	assert.deepEqual(await removeWorktree(repo, two.folder), { ok: false, dirty: true, error: "The session branch could not be verified." });
	assert.deepEqual(await removeWorktree(repo, two.folder, { branch: two.branch, beforeRemove: () => false }), { ok: false, skipped: true });
	assert.equal(fs.existsSync(two.folder), true, "cancelled automatic removal leaves a clean worktree intact");
	assert.deepEqual(await removeWorktree(repo, two.folder, { branch: two.branch }), { ok: true, dirty: false });
	assert.equal(fs.existsSync(two.folder), false);
	const restored = await restoreWorktree(two.folder, two.branch);
	assert.equal(restored.ok, true, JSON.stringify(restored));
	assert.equal(fs.existsSync(two.folder), true);
	assert.equal(git(["branch", "--show-current"], two.folder).trim(), two.branch);
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, true, "an archived worktree left on disk can be reopened");
	const wrongBranch = { ok: false, dirty: true, error: "This worktree is not on its session branch." };
	git(["switch", "--quiet", "--detach"], two.folder);
	git(["commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "Detached work"], two.folder);
	const detachedHead = git(["rev-parse", "HEAD"], two.folder);
	assert.deepEqual(await removeWorktree(repo, two.folder, { branch: two.branch }), wrongBranch);
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, true);
	assert.equal(git(["rev-parse", "HEAD"], two.folder), detachedHead, "unarchive reuses the surviving detached HEAD");
	git(["switch", "--quiet", "-c", "switched-worktree"], two.folder);
	assert.deepEqual(await removeWorktree(two.folder, two.folder, { branch: two.branch }), wrongBranch);
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, true);
	assert.equal(git(["branch", "--show-current"], two.folder).trim(), "switched-worktree", "unarchive reuses the surviving branch");
	git(["switch", "--quiet", two.branch], two.folder);
	console.log("PASS archive and restore preserve clean worktrees on detached HEAD or another branch");
	assert.ok(path.resolve(two.folder).startsWith(`${path.resolve(root)}${path.sep}`));
	for (const entry of fs.readdirSync(two.folder)) {
		fs.rmSync(path.join(two.folder, entry), { recursive: true, force: true });
	}
	write("leftover.txt", "keep this work\n", two.folder);
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, false, "restoration refuses a nonempty half-deleted worktree");
	assert.equal(fs.readFileSync(path.join(two.folder, "leftover.txt"), "utf8"), "keep this work\n");
	fs.rmSync(path.join(two.folder, "leftover.txt"));
	const recovered = await restoreWorktree(two.folder, two.branch);
	assert.equal(recovered.ok, true, JSON.stringify(recovered));
	assert.equal(fs.existsSync(path.join(two.folder, ".git")), true, "a half-deleted worktree regains its git link");
	assert.equal((await branchInfo(two.folder)).branch, two.branch, "a restored worktree uses the session branch");
	fs.rmSync(two.folder, { recursive: true, force: true });
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, true, "a missing folder with a stale registration is restored");
	assert.equal(git(["branch", "--show-current"], two.folder).trim(), two.branch);
	assert.equal((await removeWorktree(repo, two.folder, { branch: two.branch })).ok, true);
	git(["branch", "-D", two.branch]);
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, false, "a deleted branch is not replaced with a new one");
	assert.equal(fs.existsSync(two.folder), false);
	assert.equal((await removeWorktree(repo, repo, { force: true })).ok, false, "the main checkout is never removed");
	assert.ok(fs.existsSync(path.join(repo, "base.txt")));
	console.log("PASS removeWorktree: refuses when dirty, removes with force, removes clean, never removes the main checkout");
	console.log("PASS restoreWorktree: recreates the existing branch, reopens an existing folder and refuses a deleted branch");

	const ignoredTree = await addWorktree(repo, { name: "ignored", prefix: "grok" });
	assert.equal(ignoredTree.ok, true, JSON.stringify(ignoredTree));
	fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env\nnode_modules/\n");
	write(".env", "SECRET=test\n", ignoredTree.folder);
	const blocked = await removeWorktree(repo, ignoredTree.folder);
	assert.equal(blocked.ok, false);
	assert.equal(blocked.dirty, true);
	assert.deepEqual(blocked.ignored, [".env"]);
	fs.rmSync(path.join(ignoredTree.folder, ".env"));
	fs.mkdirSync(path.join(ignoredTree.folder, "node_modules"));
	write("node_modules/cache", "regenerable\n", ignoredTree.folder);
	assert.deepEqual(await removeWorktree(repo, ignoredTree.folder, { branch: ignoredTree.branch }), { ok: true, dirty: false });
	console.log("PASS ignored archive files: .env blocks removal and is named; node_modules alone is removed");

	const prAnswer = {
		number: 42, title: "A pull request", url: "https://example.invalid/pull/42", state: "OPEN", author: { login: "owner" },
		statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }],
		comments: [
			{ author: { login: "owner" }, createdAt: "2026-11-06T10:00:00Z", body: "private own reply" },
			{ author: { login: "hidden" }, createdAt: "2026-11-06T10:01:00Z", isMinimized: true, body: "private minimized comment" },
			{ author: { login: "octocat" }, createdAt: "2026-11-06T10:02:00Z", isMinimized: false, body: "private comment" },
		],
		reviews: [
			{ author: { login: "owner" }, submittedAt: "2026-11-06T10:03:00Z", state: "COMMENTED", body: "private own review" },
			...["APPROVED", "DISMISSED", "PENDING"].map((state) => ({ author: { login: "reviewer" }, submittedAt: "2026-11-06T10:04:00Z", state, body: "private excluded review" })),
			{ author: { login: "reviewer" }, submittedAt: "2026-11-06T10:05:00Z", state: "COMMENTED", body: "" },
			{ author: { login: "octocat" }, submittedAt: "2026-11-06T10:06:00Z", state: "CHANGES_REQUESTED", body: "private requested change" },
		],
	};
	const statusStub = stubGitHub(() => ({ out: JSON.stringify(prAnswer) }));
	const status = await statusStub.api.prStatus(repo, 42);
	const fields = "number,title,url,state,isDraft,mergeable,autoMergeRequest,statusCheckRollup,author,comments,reviews";
	const jq = ".comments |= map({author, createdAt, isMinimized}) | .reviews |= map({author, submittedAt, state})";
	assert.deepEqual(JSON.parse(JSON.stringify(statusStub.calls)), [["pr", "view", "42", "--json", fields, "--jq", jq]], "the watch reads the selected PR and requests feedback metadata without bodies");
	assert.deepEqual(JSON.parse(JSON.stringify(status.pr.feedback)), [
		{ at: "2026-11-06T10:02:00Z", who: "octocat", kind: "comment" },
		{ at: "2026-11-06T10:05:00Z", who: "reviewer", kind: "review" },
		{ at: "2026-11-06T10:06:00Z", who: "octocat", kind: "review" },
	], "own replies, minimized comments and excluded review states stay out; empty COMMENTED reviews count");
	assert.equal(status.pr.checks[0].state, "fail", "check rollups keep their existing shape");
	assert.equal(JSON.stringify(status).includes("private"), false, "comment and review bodies never leave the main process");
	await statusStub.api.prStatus(repo, 0);
	assert.deepEqual([...statusStub.calls.at(-1)], ["pr", "view", "--json", fields, "--jq", jq], "an invalid PR number keeps the current-branch behavior");
	console.log("PASS prStatus feedback: selected number, JSON fields, filtered author and review metadata without bodies");

	const staleHead = stubGitHub(() => { throw new Error("gh must not run for a stale displayed branch"); });
	assert.equal((await staleHead.api.prCreate(repo, { title: "Test", expected: "other" })).error, "The checkout changed to feature. Refresh, then create the pull request again.");
	assert.equal(git(["ls-remote", "origin", "refs/heads/feature"]).trim(), "", "a stale displayed branch is not pushed");
	for (const [reply, error] of [
		[{ out: JSON.stringify({ ...prRepositoryData, defaultBranchRef: { name: "feature" } }) }, "Switch to a branch before creating a pull request."],
		[{ code: 1, err: "error: repository unavailable\n" }, "repository unavailable"],
		[{ code: 4, err: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n" }, "To get started with GitHub CLI, please run:  gh auth login"],
		[{ out: JSON.stringify({ ...prRepositoryData, defaultBranchRef: null }) }, "GitHub did not say which branch is the default, so nothing was pushed."],
		[{ out: "" }, "GitHub did not return the repository details."],
	]) {
		const guarded = stubGitHub(() => reply);
		assert.equal((await guarded.api.prCreate(repo, { title: "Test" })).error, error);
		assert.equal(JSON.stringify(guarded.calls), JSON.stringify([["repo", "view", "--json", "id,nameWithOwner,url,defaultBranchRef"]]));
		assert.equal(git(["ls-remote", "origin", "refs/heads/feature"]).trim(), "", "the default branch check refuses before pushing");
	}
	console.log("PASS prCreate: stale displayed heads, the remote default branch, and missing or failed default-branch answers refuse before push");

	const prePushHook = path.join(repo, ".git", "hooks", "pre-push");
	fs.writeFileSync(prePushHook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const rejectedPush = stubGitHub((args) => {
		if (args[0] === "repo") { return { out: prRepositoryJson }; }
		throw new Error("gh pr create must not run after a rejected push");
	});
	assert.equal((await rejectedPush.api.prCreate(repo, { title: "Test" })).ok, false);
	assert.equal(git(["ls-remote", "origin", "refs/heads/feature"]).trim(), "", "a failed pre-push hook keeps the branch off origin");
	const prePushMarker = path.join(root, "pre-push-ran.txt").replace(/\\/g, "/");
	fs.writeFileSync(prePushHook, `#!/bin/sh\nprintf ran >> '${prePushMarker}'\nexit 0\n`, { mode: 0o755 });
	for (const [label, result] of [["prStatus", await prStatus(repo)], ["prCreate", await prCreate(repo, { title: "Test" })], ["prMergeWhenReady", await prMergeWhenReady(repo, 12)]]) {
		assert.equal(result.ok, false, label);
		assert.equal(typeof result.error, "string", label);
		assert.ok(result.error.length > 0 && result.error.length <= 300 && !result.error.includes("\n"), label);
	}
	assert.equal(git(["ls-remote", "origin", "refs/heads/feature"]).trim(), "", "prCreate cannot identify a GitHub default branch, so nothing is pushed");
	console.log("PASS prStatus/prCreate/prMergeWhenReady: clean ok:false against a non-GitHub remote; nothing pushed");

	const createSuccess = stubGitHub((args) => ({ out: args[0] === "repo" ? prRepositoryJson : "https://example.invalid/pull/12\n" }));
	const created = await createSuccess.api.prCreate(repo, { title: "Test" });
	assert.equal(created.ok, true);
	assert.equal(git(["rev-parse", "--verify", "refs/heads/feature"], origin).trim(), featureSha, "prCreate pushed the branch to the local origin");
	assert.equal(created.message, "Pull request opened. 2 uncommitted files are not in this pull request.");
	assert.equal(fs.existsSync(prePushMarker), true, "Create PR runs the successful pre-push hook");
	fs.rmSync(prePushHook);
	console.log("PASS prCreate: pre-push hooks can refuse the push and run on a successful push");

	git(["switch", "--quiet", "-c", "checked-pr"]);
	git(["tag", "checked-pr"]);
	const displayedHead = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	assert.equal(displayedHead, "heads/checked-pr", "a matching tag causes the renderer's branch name to be qualified");
	const racedCreate = stubGitHub((args, options) => {
		if (args[0] !== "repo") { return { out: "https://example.invalid/pull/13\n" }; }
		if (options.env.GH_REPO !== "") { git(["switch", "--quiet", "-c", "other-pr"]); }
		return { out: prRepositoryJson };
	});
	const racedPr = await racedCreate.api.prCreate(repo, { title: "Test", expected: displayedHead });
	assert.equal(racedPr.ok, true, JSON.stringify(racedPr));
	const racedArgs = racedCreate.calls.find((args) => args[0] === "pr");
	assert.equal(racedArgs[racedArgs.indexOf("--head") + 1], "checked-pr");
	assert.equal(git(["rev-parse", "--verify", "refs/heads/checked-pr"], origin).trim(), featureSha);
	assert.equal(git(["ls-remote", "origin", "refs/heads/other-pr"]).trim(), "");
	git(["switch", "--quiet", "feature"]);
	console.log("PASS prCreate: a checkout change during the GitHub lookup pushes and opens only the checked branch");

	const createFailure = stubGitHub((args) => (args[0] === "repo" ? { out: prRepositoryJson } : { code: 1, err: "error: a pull request could not be created\nmore details\n" }));
	const failed = await createFailure.api.prCreate(repo, { title: "Test" });
	assert.equal(failed.error, "The branch was pushed, but the pull request was not created: a pull request could not be created");
	git(["remote", "remove", "origin"]);
	const noOrigin = await createSuccess.api.prCreate(repo, { title: "Test" });
	assert.equal(noOrigin.ok, false);
	assert.match(noOrigin.error, /origin/);
	git(["remote", "add", "origin", origin]);
	console.log("PASS prCreate: uncommitted files are named by count; post-push failure says pushed; push failure shows the fatal line");

	const mergeStub = (allowed, view, after) => stubGitHub((args) => {
		if (args.at(-1) === "state,autoMergeRequest") { return after; }
		return { out: args[0] === "repo" ? JSON.stringify(allowed) : args[1] === "view" ? JSON.stringify(view) : "" };
	});
	for (const [allowed, method] of [
		[{ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }, "--squash"],
		[{ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true }, "--merge"],
		[{ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true }, "--rebase"],
		[{ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false }, null],
	]) {
		const stub = mergeStub(allowed, { state: "OPEN", mergeStateStatus: "BLOCKED" }, { out: JSON.stringify({ state: "OPEN", autoMergeRequest: {} }) });
		const result = await stub.api.prMergeWhenReady(repo, 42);
		if (method) {
			assert.equal(result.ok, true);
			assert.equal(JSON.stringify(stub.calls[1]), JSON.stringify(["pr", "view", "42", "--json", "state,mergeStateStatus"]));
			assert.equal(JSON.stringify(stub.calls[2]), JSON.stringify(["pr", "merge", "42", "--auto", method]));
			assert.equal(JSON.stringify(stub.calls[3]), JSON.stringify(["pr", "view", "42", "--json", "state,autoMergeRequest"]));
			assert.match(result.message, /^Auto-merge is on/, "GitHub waits on BLOCKED, so gh turns on auto-merge");
		} else {
			assert.equal(result.error, "This repository allows no merge method the app can use.");
			assert.equal(stub.calls.length, 1);
		}
	}
	const invalidMerge = stubGitHub(() => { throw new Error("gh must not run for an invalid selector"); });
	for (const number of [undefined, 0, -1, 1.5, "42"]) {
		assert.equal((await invalidMerge.api.prMergeWhenReady(repo, number)).ok, false);
	}
	console.log("PASS prMergeWhenReady: selects PR 42 and prefers squash, then merge, then rebase; refuses invalid selectors or no methods");

	const mergeWith = async (view, after = { out: '{"state":"MERGED"}' }) => {
		const stub = mergeStub({ squashMergeAllowed: true }, view, after);
		const result = await stub.api.prMergeWhenReady(repo, 42);
		return { result: { ...result }, merges: stub.calls.filter((args) => args[1] === "merge").map((args) => args.join(" ")) };
	};
	assert.deepEqual(await mergeWith({ state: "OPEN", mergeStateStatus: "UNSTABLE" }), { result: { ok: false, error: "Checks are not passing, and this repository does not require them, so GitHub would merge now. Merge after the checks pass." }, merges: [] }, "gh would merge at once while checks that are not required fail or run");
	assert.deepEqual(await mergeWith({ state: "OPEN", mergeStateStatus: "CLEAN" }), { result: { ok: true, message: "Merged." }, merges: ["pr merge 42 --auto --squash"] });
	assert.deepEqual(await mergeWith({ state: "CLOSED", mergeStateStatus: "CLEAN" }), { result: { ok: false, error: "This pull request is not open." }, merges: [] });
	assert.deepEqual(await mergeWith({ state: "OPEN", mergeStateStatus: "DIRTY" }), { result: { ok: false, error: "GitHub cannot merge this pull request yet (dirty)." }, merges: [] });
	for (const [mergeStateStatus, word] of [["UNKNOWN", "unknown"], ["BEHIND", "behind"], ["DRAFT", "draft"], [undefined, "unknown"]]) {
		assert.deepEqual(await mergeWith({ state: "OPEN", mergeStateStatus }), { result: { ok: false, error: `GitHub cannot merge this pull request yet (${word}).` }, merges: [] }, String(mergeStateStatus));
	}
	assert.deepEqual(await mergeWith({ state: "MERGED", mergeStateStatus: "CLEAN" }), { result: { ok: false, error: "This pull request is not open." }, merges: [] });
	assert.deepEqual(await mergeWith({ state: "OPEN", mergeStateStatus: "HAS_HOOKS" }), { result: { ok: true, message: "Merged." }, merges: ["pr merge 42 --auto --squash"] });
	for (const after of [{ out: '{"state":"OPEN","autoMergeRequest":null}' }, { out: "invalid" }, { code: 1, err: "Status unavailable" }]) {
		assert.deepEqual(await mergeWith({ state: "OPEN", mergeStateStatus: "CLEAN" }, after), { result: { ok: true, message: "Merge command completed. Refresh to check the pull request." }, merges: ["pr merge 42 --auto --squash"] });
	}
	const autoMergeOff = "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)";
	const refused = stubGitHub((args) => (args[1] === "merge" ? { code: 1, err: `${autoMergeOff}\n` } : { out: JSON.stringify(args[0] === "repo" ? { squashMergeAllowed: true } : { state: "OPEN", mergeStateStatus: "BLOCKED" }) }));
	assert.deepEqual({ ...await refused.api.prMergeWhenReady(repo, 42) }, { ok: false, error: autoMergeOff });
	console.log("PASS prMergeWhenReady: reports auto-merge or Merged from the follow-up state, stays neutral when unconfirmed, and preserves the existing merge guards");

	const ghDirs = (process.env.PATH || "").split(path.delimiter).filter((dir) => dir && fs.existsSync(path.join(dir, process.platform === "win32" ? "gh.exe" : "gh")));
	const savedPath = process.env.PATH;
	try {
		const kept = savedPath.split(path.delimiter).filter((dir) => !ghDirs.includes(dir));
		// Ubuntu keeps gh and git together in /usr/bin, so hiding gh hides git too; git gets a folder of its own there.
		const gitName = process.platform === "win32" ? "git.exe" : "git";
		const shared = ghDirs.find((dir) => fs.existsSync(path.join(dir, gitName)));
		if (shared) {
			const gitOnly = path.join(root, "git-only");
			fs.mkdirSync(gitOnly);
			fs.symlinkSync(path.join(shared, gitName), path.join(gitOnly, gitName));
			kept.unshift(gitOnly);
		}
		process.env.PATH = kept.join(path.delimiter);
		assert.deepEqual(await prStatus(repo), { ok: false, error: "GitHub CLI (gh) is not installed." });
		assert.deepEqual(await prCreate(repo, { title: "Test" }), { ok: false, error: "GitHub CLI (gh) is not installed." });
	} finally {
		process.env.PATH = savedPath;
	}
	console.log("PASS prStatus: missing gh gives the install message");

	git(["checkout", "--quiet", "main"]);
	assert.deepEqual(await prCreate(repo, {}), { ok: false, error: "Switch to a branch before creating a pull request." });
	console.log("PASS prCreate: refuses on the base branch");

	const marker = path.join(root, "helper-ran.txt").replace(/\\/g, "/");
	const helper = path.join(root, "helper.js").replace(/\\/g, "/");
	fs.writeFileSync(helper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(marker)}, "ran\\n"); if (process.argv[2] && fs.existsSync(process.argv[2])) { process.stdout.write(fs.readFileSync(process.argv[2])); }`);
	write(".gitattributes", "*.evil diff=evil\n");
	write("x.evil", "one\n");
	commit("evil driver");
	write("x.evil", "two\n");
	git(["config", "diff.evil.textconv", `node ${helper}`]);
	git(["config", "core.fsmonitor", `node ${helper}`]);
	git(["diff"]);
	assert.ok(fs.existsSync(marker), "plain git runs the repo's helper, so the check below means something");
	fs.rmSync(marker);
	const repoListing = await repoFiles(repo);
	assert.ok(repoListing.files.includes("base.txt"), "the hardened repository listing returns tracked files");
	assert.equal(fs.existsSync(marker), false, "the repository listing never runs core.fsmonitor");
	assert.equal((await readScopedDiff(repo, "uncommitted")).ok, true);
	await branchInfo(repo);
	const extra = await addWorktree(repo, { name: "three", prefix: "grok" });
	await removeWorktree(repo, extra.folder, { force: true });
	assert.equal(fs.existsSync(marker), false, "the app never runs a repo's textconv or fsmonitor program");
	git(["config", "--unset", "diff.evil.textconv"]);
	git(["config", "--unset", "core.fsmonitor"]);
	console.log("PASS repo config: textconv and fsmonitor helpers do not run");

	write("x.empty", "empty\n");
	write("x.line", "line\n");
	commit("Filter driver files");
	const filteredTree = await addWorktree(repo, { name: "filtered", prefix: "grok" });
	assert.equal(filteredTree.ok, true, JSON.stringify(filteredTree));
	const configFile = path.join(repo, ".git", "config");
	const attributesFile = path.join(repo, ".gitattributes");
	const savedConfig = fs.readFileSync(configFile);
	const savedAttributes = fs.readFileSync(attributesFile);
	const latinMarker = path.join(root, "latin-filter-ran.txt").replace(/\\/g, "/");
	const latinHelper = path.join(root, "latin-filter.cjs").replace(/\\/g, "/");
	fs.writeFileSync(latinHelper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(latinMarker)}, "ran\\n"); process.stdout.write(fs.readFileSync(0));`);
	fs.appendFileSync(configFile, Buffer.concat([Buffer.from("[filter \"x"), Buffer.from([0xe9]), Buffer.from(`"]\n\tclean = ${JSON.stringify(`node "${latinHelper}"`)}\n`)]));
	fs.appendFileSync(attributesFile, Buffer.concat([Buffer.from("*.evil filter=x"), Buffer.from([0xe9]), Buffer.from("\n")]));
	write("x.evil", "latin\n");
	git(["diff"]);
	assert.equal(fs.existsSync(latinMarker), true, "plain git runs a local filter whose name is not valid UTF-8");
	fs.rmSync(latinMarker);
	assert.deepEqual(await readDiff(repo), { ok: false, error: FILTER_NOT_OFF });
	assert.deepEqual(await readScopedDiff(repo, "branch"), { ok: false, error: FILTER_NOT_OFF });
	assert.deepEqual(await removeWorktree(repo, filteredTree.folder), { ok: false, error: FILTER_NOT_OFF });
	assert.equal(fs.existsSync(latinMarker), false, "refresh and archive refuse a filter they cannot name instead of running it");
	fs.writeFileSync(configFile, savedConfig);
	fs.writeFileSync(attributesFile, savedAttributes);
	console.log("PASS repo config: a local filter whose name is not valid UTF-8 makes refresh and archive refuse");

	const filterMarker = path.join(root, "filter-ran.txt").replace(/\\/g, "/");
	const hookMarker = path.join(root, "hook-ran.txt").replace(/\\/g, "/");
	const filterHelper = path.join(root, "filter.cjs").replace(/\\/g, "/");
	fs.writeFileSync(filterHelper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(filterMarker)}, "ran\\n"); process.stdout.write(fs.readFileSync(0));`);
	const equalsMarker = path.join(root, "equals-filter-ran.txt").replace(/\\/g, "/");
	const equalsHelper = path.join(root, "equals-filter.cjs").replace(/\\/g, "/");
	fs.writeFileSync(equalsHelper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(equalsMarker)}, "ran\\n"); process.stdout.write(fs.readFileSync(0));`);
	const equalsProcess = path.join(root, "equals-process.cjs").replace(/\\/g, "/");
	fs.writeFileSync(equalsProcess, `require("fs").appendFileSync(${JSON.stringify(equalsMarker)}, "process ran\\n");`);
	const emptyMarker = path.join(root, "empty-filter-ran.txt").replace(/\\/g, "/");
	const emptyHelper = path.join(root, "empty-filter.cjs").replace(/\\/g, "/");
	fs.writeFileSync(emptyHelper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(emptyMarker)}, "ran\\n"); process.stdout.write(fs.readFileSync(0));`);
	const hookFile = path.join(repo, ".git", "hooks", "post-index-change");
	fs.writeFileSync(hookFile, `#!/bin/sh\nprintf ran >> '${hookMarker}'\n`, { mode: 0o755 });
	const configHookMarker = path.join(root, "config-hook-ran.txt").replace(/\\/g, "/");
	git(["config", "hook.planted.command", `printf ran >> '${configHookMarker}'`]);
	git(["config", "hook.planted.event", "post-index-change"]);
	const lineMarker = path.join(root, "line-filter-ran.txt").replace(/\\/g, "/");
	const lineHelper = path.join(root, "line-filter.cjs").replace(/\\/g, "/");
	fs.writeFileSync(lineHelper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(lineMarker)}, "ran\\n"); process.stdout.write(fs.readFileSync(0));`);
	write(".gitattributes", "*.evil filter=evil\n*.txt filter=a=b\n*.empty filter=\n*.line filter=x\u2028y\n");
	git(["config", "filter.evil.clean", `node "${filterHelper}" "decoy.clean value"`]);
	git(["config", "filter.a=b.clean", `node "${equalsHelper}"`]);
	git(["config", "filter.a=b.smudge", `node "${equalsHelper}"`]);
	fs.appendFileSync(configFile, `[filter ""]\n\tclean = ${JSON.stringify(`node "${emptyHelper}"`)}\n\tsmudge = ${JSON.stringify(`node "${emptyHelper}"`)}\n`);
	fs.appendFileSync(configFile, `[filter "x\u2028y"]\n\tclean = ${JSON.stringify(`node "${lineHelper}"`)}\n`);
	write("x.evil", "three\n");
	write("x.empty", "empty change\n");
	write("x.line", "line change\n");
	fs.utimesSync(path.join(repo, "base.txt"), 1000, 1000);
	git(["diff"]);
	assert.equal(fs.existsSync(filterMarker), true, "plain git runs the local clean filter");
	assert.equal(fs.existsSync(equalsMarker), true, "plain git runs the local filter named a=b");
	assert.equal(fs.existsSync(emptyMarker), true, "plain git runs the local filter with an empty name");
	assert.equal(fs.existsSync(hookMarker), true, "plain git runs post-index-change");
	// Hooks set in config are new in git (2.53 has none, 2.55 does); with an older git there is nothing for the app to turn off.
	let configHooks = false;
	try { configHooks = git(["hook", "list", "post-index-change"]).split(/\r?\n/).includes("planted"); } catch {}
	if (configHooks) { assert.equal(fs.existsSync(configHookMarker), true, "plain git runs a post-index-change hook set in config"); }
	assert.equal(fs.existsSync(lineMarker), true, "plain git runs a local filter whose name holds U+2028");
	fs.rmSync(configHookMarker, { force: true });
	fs.rmSync(lineMarker);
	fs.rmSync(filterMarker);
	fs.rmSync(equalsMarker);
	fs.rmSync(emptyMarker);
	fs.rmSync(hookMarker);
	// Set only now: plain git stops when a required driver's process fails, so the app must turn required off.
	// The process comes after the plain run too: it exits before git's handshake, which Windows git survives and git on Linux does not.
	git(["config", "filter.a=b.process", `node "${equalsProcess}"`]);
	git(["config", "filter.a=b.required", "true"]);
	write("x.evil", "four\n");
	write("keep.txt", "keep a=b\n");
	write(".gitattributes", "*.evil filter=evil\n*.txt filter=a=b\n*.empty filter=\n*.line filter=x\u2028y\n", filteredTree.folder);
	write("x.evil", "worktree change\n", filteredTree.folder);
	write("keep.txt", "worktree a=b\n", filteredTree.folder);
	fs.utimesSync(path.join(repo, "base.txt"), 2000, 2000);
	assert.equal((await readDiff(repo)).ok, true);
	fs.utimesSync(path.join(repo, "base.txt"), 3000, 3000);
	assert.equal((await readScopedDiff(repo, "branch")).ok, true);
	fs.utimesSync(path.join(filteredTree.folder, "base.txt"), 4000, 4000);
	fs.utimesSync(path.join(filteredTree.folder, "x.empty"), 4000, 4000);
	assert.equal((await removeWorktree(repo, filteredTree.folder)).dirty, true);
	assert.equal(fs.existsSync(filterMarker), false, "refresh and archive status do not run a local filter");
	assert.equal(fs.existsSync(equalsMarker), false, "refresh and archive status do not run a local filter whose name holds =");
	assert.equal(fs.existsSync(emptyMarker), false, "refresh and archive status do not run a local filter with an empty name");
	assert.equal(fs.existsSync(hookMarker), false, "os.devNull disables hooks on this platform");
	assert.equal(fs.existsSync(configHookMarker), false, "refresh and archive status do not run a hook set in config");
	assert.equal(fs.existsSync(lineMarker), false, "refresh and archive status do not run a local filter whose name holds U+2028");
	assert.equal((await removeWorktree(repo, filteredTree.folder, { force: true })).ok, true);
	git(["config", "--remove-section", "filter."]);
	git(["config", "--remove-section", "filter.x\u2028y"]);
	git(["config", "--remove-section", "hook.planted"]);
	git(["config", "--unset", "filter.evil.clean"]);
	const globalConfig = path.join(root, "global.gitconfig");
	const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
	try {
		process.env.GIT_CONFIG_GLOBAL = globalConfig;
		git(["config", "--global", "filter.evil.clean", `node "${filterHelper}"`]);
		write("x.evil", "five\n");
		assert.equal((await readDiff(repo)).ok, true);
		assert.equal(fs.existsSync(filterMarker), true, "global clean filters remain enabled");
	} finally {
		if (savedGlobal === undefined) { delete process.env.GIT_CONFIG_GLOBAL; } else { process.env.GIT_CONFIG_GLOBAL = savedGlobal; }
	}
	fs.rmSync(filterMarker);
	git(["config", "extensions.worktreeConfig", "true"]);
	git(["config", "--worktree", "filter.evil.clean", `node "${filterHelper}"`]);
	write("x.evil", "six\n");
	assert.equal((await readDiff(repo)).ok, true);
	assert.equal(fs.existsSync(filterMarker), false, "worktree-scope clean filters are suppressed too");
	console.log("PASS repo config: refresh/archive suppress post-index-change and local/worktree filters, drivers named a=b or with an empty name included, while preserving global filters");

	const signed = path.join(root, "signed");
	git(["init", "--quiet", "-b", "main", signed], root);
	git(["config", "user.name", "GrokCode test"], signed);
	git(["config", "user.email", "test@example.invalid"], signed);
	write("signed.txt", "signed\n", signed);
	git(["add", "--all"], signed);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "Signed"], signed);
	const signature = "gpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n";
	const signedSha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: signed, input: git(["cat-file", "commit", "HEAD"], signed).replace("\n\n", `\n${signature}\n`), windowsHide: true, encoding: "utf8" }).trim();
	git(["update-ref", "HEAD", signedSha], signed);
	const gpgMarker = path.join(root, "gpg-ran.txt").replace(/\\/g, "/");
	const gpgProgram = path.join(root, "gpg.sh").replace(/\\/g, "/");
	fs.writeFileSync(gpgProgram, `#!/bin/sh\nprintf ran >> '${gpgMarker}'\n`, { mode: 0o755 });
	git(["config", "log.showSignature", "true"], signed);
	git(["config", "gpg.program", gpgProgram], signed);
	git(["log", "-z", "--max-count=30", "--format=%H%x1f%h%x1f%s%x1f%cI", "HEAD"], signed);
	assert.equal(fs.existsSync(gpgMarker), true, "plain git log runs the repo's gpg.program on a signed commit");
	fs.rmSync(gpgMarker);
	const signedList = await listCommits(signed);
	assert.equal(signedList.ok, true, JSON.stringify(signedList));
	assert.deepEqual(signedList.commits.map((entry) => entry.sha), [signedSha]);
	assert.match(signedList.commits[0].sha, /^[0-9a-f]{40}$/);
	const signedShow = await readScopedDiff(signed, signedSha);
	assert.equal(signedShow.ok, true, JSON.stringify(signedShow));
	assert.deepEqual(paths(signedShow), ["signed.txt"]);
	assert.equal(fs.existsSync(gpgMarker), false, "the commit list and a commit diff never verify a signature");
	console.log("PASS repo config: log.showSignature does not run gpg.program from the commit list or a commit diff");

	const subSource = path.join(root, "sub-source");
	const superRepo = path.join(root, "super");
	for (const folder of [subSource, superRepo]) {
		git(["init", "--quiet", "-b", "main", folder], root);
		git(["config", "user.name", "GrokCode test"], folder);
		git(["config", "user.email", "test@example.invalid"], folder);
	}
	write(".gitattributes", "data.txt filter=x\n", subSource);
	write("data.txt", "data\n", subSource);
	git(["add", "--all"], subSource);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "Submodule"], subSource);
	git(["-c", "protocol.file.allow=always", "submodule", "add", subSource, "sub"], superRepo);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "Add submodule"], superRepo);
	const subMarker = path.join(root, "sub-filter-ran.txt").replace(/\\/g, "/");
	const subHelper = path.join(root, "sub-filter.cjs").replace(/\\/g, "/");
	fs.writeFileSync(subHelper, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(subMarker)}, "ran\\n"); process.stdout.write(fs.readFileSync(0));`);
	git(["config", "filter.x.clean", `node "${subHelper}"`], path.join(superRepo, "sub"));
	const subData = path.join(superRepo, "sub", "data.txt");
	fs.utimesSync(subData, 5000, 5000);
	git(["diff"], superRepo);
	assert.equal(fs.existsSync(subMarker), true, "plain git diff runs status in the submodule, which runs the submodule's own filter");
	fs.rmSync(subMarker);
	fs.utimesSync(subData, 6000, 6000);
	assert.equal((await readDiff(superRepo)).ok, true);
	fs.utimesSync(subData, 7000, 7000);
	assert.equal((await readScopedDiff(superRepo, "branch")).ok, true);
	assert.equal(fs.existsSync(subMarker), false, "refresh does not check a submodule for uncommitted changes, so its own filters stay off");
	console.log("PASS repo config: refresh does not run a submodule's own filter");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	assert.equal(path.dirname(root), tempBase);
	assert.ok(path.basename(root).startsWith("git-"));
	fs.rmSync(root, { recursive: true, force: true });
});
