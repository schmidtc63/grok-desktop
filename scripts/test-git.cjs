const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { branchInfo, readScopedDiff, listCommits, prStatus, prCreate, prMergeWhenReady, addWorktree, removeWorktree } = require("../electron/git.cjs");

// Never let gh resolve a real GitHub repository from the environment; the temp origin is a local bare repo.
delete process.env.GH_REPO;
delete process.env.GH_HOST;

const tempBase = path.join(require("os").tmpdir(), "grokcode-git");
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

async function main() {
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
	assert.deepEqual(await removeWorktree(repo, one.folder), { ok: false, dirty: true, error: "This worktree has uncommitted changes." });
	assert.ok(fs.existsSync(path.join(one.folder, "dirty.txt")));
	assert.deepEqual(await removeWorktree(one.folder, one.folder), { ok: false, dirty: true, error: "This worktree has uncommitted changes." }, "a worktree session can start from its own folder");
	assert.deepEqual(await removeWorktree(one.folder, one.folder, { force: true }), { ok: true, dirty: true }, "git runs from the main checkout, so the session's own worktree is removed");
	assert.equal(fs.existsSync(one.folder), false);
	assert.deepEqual(await removeWorktree(repo, two.folder), { ok: true, dirty: false });
	assert.equal(fs.existsSync(two.folder), false);
	assert.equal((await removeWorktree(repo, repo, { force: true })).ok, false, "the main checkout is never removed");
	assert.ok(fs.existsSync(path.join(repo, "base.txt")));
	console.log("PASS removeWorktree: refuses when dirty, removes with force, removes clean, never removes the main checkout");

	for (const [label, result] of [["prStatus", await prStatus(repo)], ["prCreate", await prCreate(repo, { title: "Test" })], ["prMergeWhenReady", await prMergeWhenReady(repo)]]) {
		assert.equal(result.ok, false, label);
		assert.equal(typeof result.error, "string", label);
		assert.ok(result.error.length > 0 && result.error.length <= 300 && !result.error.includes("\n"), label);
	}
	assert.equal(git(["rev-parse", "--verify", "refs/heads/feature"], origin).trim(), featureSha, "prCreate pushed the branch to the local origin");
	console.log("PASS prStatus/prCreate/prMergeWhenReady: clean ok:false against a non-GitHub remote; branch pushed only to the local origin");

	const ghDirs = (process.env.PATH || "").split(path.delimiter).filter((dir) => dir && fs.existsSync(path.join(dir, process.platform === "win32" ? "gh.exe" : "gh")));
	const savedPath = process.env.PATH;
	try {
		process.env.PATH = savedPath.split(path.delimiter).filter((dir) => !ghDirs.includes(dir)).join(path.delimiter);
		assert.deepEqual(await prStatus(repo), { ok: false, error: "GitHub CLI (gh) is not installed." });
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
	assert.equal((await readScopedDiff(repo, "uncommitted")).ok, true);
	await branchInfo(repo);
	const extra = await addWorktree(repo, { name: "three", prefix: "grok" });
	await removeWorktree(repo, extra.folder, { force: true });
	assert.equal(fs.existsSync(marker), false, "the app never runs a repo's textconv or fsmonitor program");
	git(["config", "--unset", "diff.evil.textconv"]);
	git(["config", "--unset", "core.fsmonitor"]);
	console.log("PASS repo config: textconv and fsmonitor helpers do not run");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	assert.equal(path.dirname(root), tempBase);
	assert.ok(path.basename(root).startsWith("git-"));
	fs.rmSync(root, { recursive: true, force: true });
});
