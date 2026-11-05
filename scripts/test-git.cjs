const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { execFileSync, spawn } = require("child_process");
const { readDiff, FILTER_NOT_OFF } = require("../electron/diff.cjs");
const { branchInfo, readScopedDiff, listCommits, repoFiles, prStatus, prCreate, prMergeWhenReady, addWorktree, restoreWorktree, removeWorktree, bundledGitDir } = require("../electron/git.cjs");

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

function stubGitHub(reply) {
	const calls = [];
	const file = path.resolve(__dirname, "../electron/git.cjs");
	const localRequire = createRequire(file);
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(file, "utf8"), {
		module, Buffer, process, setTimeout, clearTimeout,
		require(name) {
			if (name !== "child_process") { return localRequire(name); }
			return { spawn(command, args, options) {
				if (command !== "gh") { return spawn(command, args, options); }
				calls.push(args);
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = () => {};
				process.nextTick(() => {
					const result = reply(args);
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

async function main() {
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
	assert.deepEqual(await removeWorktree(repo, two.folder), { ok: true, dirty: false });
	assert.equal(fs.existsSync(two.folder), false);
	const restored = await restoreWorktree(two.folder, two.branch);
	assert.equal(restored.ok, true, JSON.stringify(restored));
	assert.equal(fs.existsSync(two.folder), true);
	assert.equal(git(["branch", "--show-current"], two.folder).trim(), two.branch);
	assert.equal((await restoreWorktree(two.folder, two.branch)).ok, true, "an archived worktree left on disk can be reopened");
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
	assert.equal((await removeWorktree(repo, two.folder)).ok, true);
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
	assert.deepEqual(await removeWorktree(repo, ignoredTree.folder), { ok: true, dirty: false });
	console.log("PASS ignored archive files: .env blocks removal and is named; node_modules alone is removed");

	const staleHead = stubGitHub(() => { throw new Error("gh must not run for a stale displayed branch"); });
	assert.equal((await staleHead.api.prCreate(repo, { title: "Test", expected: "other" })).error, "The checkout changed to feature. Refresh, then create the pull request again.");
	assert.equal(git(["ls-remote", "origin", "refs/heads/feature"]).trim(), "", "a stale displayed branch is not pushed");
	for (const [reply, error] of [
		[{ out: "feature\n" }, "Switch to a branch before creating a pull request."],
		[{ code: 1, err: "error: repository unavailable\n" }, "repository unavailable"],
		[{ out: "" }, "GitHub did not say which branch is the default, so nothing was pushed."],
	]) {
		const guarded = stubGitHub(() => reply);
		assert.equal((await guarded.api.prCreate(repo, { title: "Test" })).error, error);
		assert.equal(JSON.stringify(guarded.calls), JSON.stringify([["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]]));
		assert.equal(git(["ls-remote", "origin", "refs/heads/feature"]).trim(), "", "the default branch check refuses before pushing");
	}
	console.log("PASS prCreate: stale displayed heads, the remote default branch, and missing or failed default-branch answers refuse before push");

	const prePushHook = path.join(repo, ".git", "hooks", "pre-push");
	fs.writeFileSync(prePushHook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const rejectedPush = stubGitHub((args) => {
		if (args[0] === "repo") { return { out: "main\n" }; }
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

	const createSuccess = stubGitHub((args) => ({ out: args[0] === "repo" ? "main\n" : "https://example.invalid/pull/12\n" }));
	const created = await createSuccess.api.prCreate(repo, { title: "Test" });
	assert.equal(created.ok, true);
	assert.equal(git(["rev-parse", "--verify", "refs/heads/feature"], origin).trim(), featureSha, "prCreate pushed the branch to the local origin");
	assert.equal(created.message, "Pull request opened. 2 uncommitted files are not in this pull request.");
	assert.equal(fs.existsSync(prePushMarker), true, "Create PR runs the successful pre-push hook");
	fs.rmSync(prePushHook);
	console.log("PASS prCreate: pre-push hooks can refuse the push and run on a successful push");
	const createFailure = stubGitHub((args) => (args[0] === "repo" ? { out: "main\n" } : { code: 1, err: "error: a pull request could not be created\nmore details\n" }));
	const failed = await createFailure.api.prCreate(repo, { title: "Test" });
	assert.equal(failed.error, "The branch was pushed, but the pull request was not created: a pull request could not be created");
	git(["remote", "remove", "origin"]);
	assert.equal((await createSuccess.api.prCreate(repo, { title: "Test" })).error, "'origin' does not appear to be a git repository");
	git(["remote", "add", "origin", origin]);
	console.log("PASS prCreate: uncommitted files are named by count; post-push failure says pushed; push failure shows the fatal line");

	const mergeStub = (allowed, view) => stubGitHub((args) => ({ out: args[0] === "repo" ? JSON.stringify(allowed) : args[1] === "view" ? JSON.stringify(view) : "" }));
	for (const [allowed, method] of [
		[{ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }, "--squash"],
		[{ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true }, "--merge"],
		[{ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true }, "--rebase"],
		[{ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false }, null],
	]) {
		const stub = mergeStub(allowed, { state: "OPEN", mergeStateStatus: "BLOCKED" });
		const result = await stub.api.prMergeWhenReady(repo, 42);
		if (method) {
			assert.equal(result.ok, true);
			assert.equal(JSON.stringify(stub.calls[1]), JSON.stringify(["pr", "view", "42", "--json", "state,mergeStateStatus"]));
			assert.equal(JSON.stringify(stub.calls[2]), JSON.stringify(["pr", "merge", "42", "--auto", method]));
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

	const mergeWith = async (view) => {
		const stub = mergeStub({ squashMergeAllowed: true }, view);
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
	const autoMergeOff = "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)";
	const refused = stubGitHub((args) => (args[1] === "merge" ? { code: 1, err: `${autoMergeOff}\n` } : { out: JSON.stringify(args[0] === "repo" ? { squashMergeAllowed: true } : { state: "OPEN", mergeStateStatus: "BLOCKED" }) }));
	assert.deepEqual({ ...await refused.api.prMergeWhenReady(repo, 42) }, { ok: false, error: autoMergeOff });
	console.log("PASS prMergeWhenReady: auto-merge only when GitHub waits (BLOCKED), Merged. on CLEAN or HAS_HOOKS; refuses UNSTABLE, other or missing merge states and a closed or merged pull request; a failed merge shows gh's error line");

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
