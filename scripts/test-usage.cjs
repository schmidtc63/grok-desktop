const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { contextBreakdown, recentSpend, autoCompactPercent } = require("../electron/usage.cjs");

const tempBase = path.resolve(os.tmpdir(), process.env.CODEX_THREAD_ID || "grokcode-usage");
fs.mkdirSync(tempBase, { recursive: true });
const root = fs.mkdtempSync(path.join(tempBase, "sessions-"));
const id = "01a18843-d800-74f1-ab16-67f5d5375a3a";
const folder = path.join(root, encodeURIComponent("C:/project"), id);
fs.mkdirSync(folder, { recursive: true });

const entries = [
	{ type: "system", content: "s".repeat(370) },
	{ type: "user", content: [{ type: "text", text: `<user_info>${"r".repeat(170)}</user_info>` }] },
	{ type: "user", synthetic_reason: "system_reminder", content: [{ type: "text", text: `The following skills are available for use:\n${"k".repeat(700)}\nThe following workflows are available:\n${"w".repeat(300)}` }] },
	{ type: "user", synthetic_reason: "system_reminder", content: [{ type: "text", text: `MCP servers connected: ${"m".repeat(100)}` }] },
	{ type: "user", content: [{ type: "text", text: "a question" }] },
	{ type: "assistant", content: "an answer" },
];
fs.writeFileSync(path.join(folder, "chat_history.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
fs.writeFileSync(path.join(folder, "tool_definitions.json"), JSON.stringify([{ name: "read_file", description: "x".repeat(355) }], null, 4));

const result = contextBreakdown(id, root);
assert.equal(result.ok, true);
const lineLength = (index) => JSON.stringify(entries[index]).length;
const { skills, workflows, ...exact } = result.parts;
assert.deepEqual(exact, {
	systemPrompt: Math.round(lineLength(0) / 3.7),
	rules: Math.round(lineLength(1) / 3.7),
	mcp: Math.round(lineLength(3) / 3.7),
	tools: Math.round(JSON.stringify([{ name: "read_file", description: "x".repeat(355) }]).length / 3.7),
}, "each fixed part is measured from its own entry, and tools without the file's indenting");
assert.ok(Math.abs(skills + workflows - lineLength(2) / 3.7) <= 1, "skills and workflows share their one reminder");
assert.ok(Math.abs(workflows - 340 / 3.7) <= 3, "workflows are the reminder's last section");
assert.equal(contextBreakdown("../../etc", root).ok, false, "an id that is not a Grok session id never builds a path");
assert.equal(contextBreakdown("01a18843-0000-0000-0000-000000000000", root).ok, false, "a session Grok has not saved yet");
console.log("PASS contextBreakdown: fixed parts from Grok's session files; bad ids refused");

const now = Date.parse("2026-10-29T12:00:00Z");
fs.writeFileSync(path.join(folder, "usage.json"), JSON.stringify({ turns: [
	{ endedAt: "2026-10-28T23:30:14.379428700+00:00", costUsdTicks: 2.5e10 },
	{ endedAt: "2026-10-25T08:00:00+00:00", costUsdTicks: 1e10 },
	{ endedAt: "2026-10-20T08:00:00+00:00", costUsdTicks: 9e10 },
] }));
assert.deepEqual(recentSpend(now, root), { ok: true, usd: 3.5 }, "turns from the last seven days count, older ones do not");
console.log("PASS recentSpend: sums the last seven days of turn costs");

const config = path.join(root, "config.toml");
fs.writeFileSync(config, "[model.x]\nauto_compact_threshold_percent = 50\n\n[session]\nload_envrc = true\nauto_compact_threshold_percent = 90 # comment\n\n[tools]\n");
assert.equal(autoCompactPercent(config), 90, "the [session] value wins over a model's");
fs.writeFileSync(config, "[session]\nload_envrc = true\n");
assert.equal(autoCompactPercent(config), 85, "85 when unset");
assert.equal(autoCompactPercent(path.join(root, "missing.toml")), 85);
console.log("PASS autoCompactPercent: reads [session], defaults to 85");

fs.rmSync(root, { recursive: true, force: true });
