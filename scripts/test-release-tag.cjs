const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-tag-"));
const checker = path.join(__dirname, "check-release-tag.cjs");
const git = (...args) => execFileSync("git", ["-c", `core.hooksPath=${os.devNull}`, ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
const check = (tag) => spawnSync(process.execPath, [checker], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: tag } });
const commit = (version) => {
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version }));
	git("add", "package.json");
	git("commit", "--quiet", "-m", version);
	return git("rev-parse", "HEAD");
};
const passes = (tag) => {
	const result = check(tag);
	assert.equal(result.status, 0, result.stderr);
};
const refuses = (tag, message) => {
	const result = check(tag);
	assert.equal(result.status, 1);
	assert.match(result.stderr, message);
};

try {
	git("init", "--quiet", "-b", "main");
	git("config", "user.name", "GrokCode test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "tag.gpgSign", "false");
	const base = commit("1.2.0");
	git("update-ref", "refs/remotes/origin/main", base);
	const stable = commit("1.3.0");
	git("update-ref", "refs/tags/v1.3.0", stable);
	git("update-ref", "refs/tags/v1.4.0", stable);
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "1.4.0" }));
	passes("v1.3.0");
	refuses("v1.4.0", /does not match package.json version 1\.3\.0/);
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "1.3.0" }));

	git("switch", "--quiet", "--detach", base);
	commit("1.4.0-rc.1");
	git("tag", "--annotate", "v1.4.0-rc.1", "-m", "Prerelease");
	passes("v1.4.0-rc.1");
	git("update-ref", "refs/remotes/origin/main", stable);
	refuses("v1.4.0-rc.1", /does not contain origin\/main/);
	refuses("v1.3.0", /checkout does not match v1\.3\.0/);
} finally {
	fs.rmSync(repo, { recursive: true, force: true });
}

const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/release-mac.yml"), "utf8").replace(/\r\n/g, "\n");
const releaseJob = (name) => {
	const body = workflow.split(`  ${name}:\n`)[1]?.split(/\n  \S/)[0];
	assert.ok(body, `The release workflow must have a ${name} job.`);
	return body;
};
for (const [name, runner] of [["mac", "macos-latest"], ["windows", "windows-latest"], ["linux", "ubuntu-24.04"]]) {
	const body = releaseJob(name);
	assert.ok(body.includes(`    runs-on: ${runner}\n`), `${name} must test on its own platform.`);
	assert.doesNotMatch(body, /^    (if|continue-on-error):/m, `${name} must run and fail the release when its tests fail.`);
	const test = body.split(/^      - /m).find((step) => /^run: npm test(?:\n|$)/.test(step));
	assert.ok(test, `${name} must run npm test before publication.`);
	assert.doesNotMatch(test, /^        (if|continue-on-error):/m, `${name}'s npm test must be unconditional and fail the job.`);
}
const publish = releaseJob("publish");
const needs = publish.match(/^    needs: \[([^\]]+)\]$/m);
assert.ok(needs, "Publication must declare its required platform jobs.");
assert.deepEqual(needs[1].split(",").map((name) => name.trim()).sort(), ["linux", "mac", "windows"]);
assert.match(publish, /^    if: startsWith\(github.ref, 'refs\/tags\/'\)$/m, "Publication must keep the default success gate for its required jobs.");

console.log("Release tag and platform test checks passed.");
