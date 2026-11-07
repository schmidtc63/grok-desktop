const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const file = path.join(__dirname, "../src/prWatch.ts");
const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "ts", format: "cjs" }).code;
const loaded = { exports: {} };
vm.runInNewContext(source, { module: loaded, exports: loaded.exports }, { filename: file });
const { prWatchStep, prAlertText, prFixPrompt } = loaded.exports;
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
const watch = { number: 12, failing: [], seenAt: "2026-11-06T10:00:00Z" };
const status = (checks = [], feedback = [], state = "OPEN") => ({ ok: true, pr: { number: 12, state, checks, feedback } });
const failed = { name: "build", state: "fail" };
const ciOnly = { failed: ["build", "test"], feedback: 0, from: [] };
const feedbackOnly = { failed: [], feedback: 2, from: ["octocat"] };
const both = { failed: ["build"], feedback: 1, from: ["octocat"] };

const first = prWatchStep(watch, status([failed]));
same(first.alert, { failed: ["build"], feedback: 0, from: [] }, "the first failing check alerts");
same(first.watch.alert, first.alert);
assert.equal(first.stop, false);
const repeated = prWatchStep(first.watch, status([failed]));
assert.equal(repeated.alert, undefined, "the same failure does not notify again");
same(repeated.watch.alert, first.alert, "an unhandled alert stays in the watch");
const passing = prWatchStep({ ...repeated.watch, alert: undefined }, status([{ ...failed, state: "pass" }]));
same(passing.watch.failing, []);
same(prWatchStep(passing.watch, status([failed])).alert, { failed: ["build"], feedback: 0, from: [] }, "a check that passes then fails alerts again");
for (const state of ["MERGED", "CLOSED"]) {
	same(prWatchStep(first.watch, status([], [], state)), { stop: true });
}
same(prWatchStep(first.watch, { ok: true, pr: null }), { stop: true });
const offline = prWatchStep(first.watch, { ok: false, error: "Offline" });
assert.equal(offline.watch, first.watch, "a network failure preserves the exact watch");
assert.equal(offline.alert, undefined);
assert.equal(offline.stop, false);
same(watch, { number: 12, failing: [], seenAt: "2026-11-06T10:00:00Z" }, "the input watch is unchanged");
console.log("PASS PR watch checks: first failure, repeat, pass/fail recurrence, stop and transient errors");

const old = { at: "2026-11-06T09:00:00Z", who: "older", kind: "comment" };
const equal = { at: watch.seenAt, who: "seen", kind: "comment" };
const newer = { at: "2026-11-06T10:01:00Z", who: "octocat", kind: "review" };
assert.equal(prWatchStep(watch, status([], [old, equal])).alert, undefined, "old and already seen feedback stay quiet");
const feedback = prWatchStep(watch, status([], [newer, old, equal]));
same(feedback.alert, { failed: [], feedback: 1, from: ["octocat"] });
assert.equal(feedback.watch.seenAt, newer.at, "the watch takes the newest timestamp regardless of order");
assert.equal(prWatchStep(feedback.watch, status([], [newer])).alert, undefined);
const pending = { ...first.watch, alert: { failed: ["test", "build"], feedback: 2, from: ["octocat"] } };
const newest = { at: "2026-11-06T10:02:00Z", who: "hubot", kind: "comment" };
const merged = prWatchStep(pending, status([failed, { name: "lint", state: "fail" }], [newest, newer]));
same(merged.alert, { failed: ["test", "build", "lint"], feedback: 4, from: ["octocat", "hubot"] }, "new events merge with the unhandled alert using unions and a feedback count");
same(merged.watch.alert, merged.alert);
assert.equal(merged.watch.seenAt, newest.at);
console.log("PASS PR watch feedback: timestamp cutoff, latest seen time and unhandled alert merging");

assert.equal(prAlertText(12, ciOnly), "PR #12: CI failed (build, test).");
assert.equal(prAlertText(12, feedbackOnly), "PR #12: 2 new review comments from octocat.");
assert.equal(prAlertText(12, both), "PR #12: CI failed (build) and 1 new review comment from octocat.");
const ending = "Tell me what you changed. Don't push until I've looked at it.";
const ci = "Pull request #12 has failing CI checks: build, test. Read the failures with `gh pr checks 12` and `gh run view <run id> --log-failed`, find the cause and fix it.";
const review = "Pull request #12 has new review feedback. Read it with `gh pr view 12 --comments` and the inline comments with `gh api repos/{owner}/{repo}/pulls/12/comments`, then address each point. Say which points you disagree with instead of changing them.";
assert.equal(prFixPrompt(12, ciOnly), `${ci} ${ending}`);
assert.equal(prFixPrompt(12, feedbackOnly), `${review} ${ending}`);
assert.equal(prFixPrompt(12, both), `${ci.replace("build, test", "build")}\n\n${review} ${ending}`);
console.log("PASS PR watch messages: exact CI, feedback and combined alert/fix prompt text");
