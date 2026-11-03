const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { contextBreakdown, recentSpend, autoCompactPercent, taskOutput, subagentTranscript } = require("../electron/usage.cjs");

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

const outputRoot = path.join(root, "outputs");
fs.mkdirSync(outputRoot);
const log = path.join(outputRoot, "command.log");
fs.writeFileSync(log, "first\nsecond\n");
assert.deepEqual(taskOutput(log, outputRoot), { ok: true, text: "first\nsecond\n", truncated: false });
fs.writeFileSync(log, `prefix${"x".repeat(200 * 1024)}`);
assert.deepEqual(taskOutput(log, outputRoot), { ok: true, text: "x".repeat(200 * 1024), truncated: true }, "only the last 200 KiB of output is returned");
const outside = path.join(root, "outside.log");
fs.writeFileSync(outside, "outside");
const plainText = path.join(outputRoot, "note.txt");
fs.writeFileSync(plainText, "not a command log");
for (const file of [outside, plainText, path.join(outputRoot, "..", "outside.log"), path.join(outputRoot, "missing.log")]) { assert.equal(taskOutput(file, outputRoot).ok, false, file); }
const junction = path.join(outputRoot, "linked");
fs.symlinkSync(folder, junction, "junction");
fs.writeFileSync(path.join(folder, "external.log"), "outside through a junction");
assert.equal(taskOutput(path.join(junction, "external.log"), outputRoot).ok, false, "canonical containment refuses an outward junction");
console.log("PASS taskOutput: bounded log tail and canonical path/extension refusal");

const record = (update) => JSON.stringify({ timestamp: "2026-11-02T12:00:00Z", method: "session/update", params: { sessionId: id, update } });
const textChunk = (sessionUpdate, text) => record({ sessionUpdate, content: { type: "text", text } });
const transcriptFile = path.join(folder, "updates.jsonl");
const transcriptLines = [
	textChunk("user_message_chunk", "List "),
	textChunk("user_message_chunk", "files."),
	textChunk("agent_thought_chunk", "think"),
	textChunk("agent_thought_chunk", "ing"),
	textChunk("agent_message_chunk", "Before"),
	record({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "run_terminal_command", rawInput: { command: "Write-Output done", description: "Run check" }, _meta: { "x.ai/tool": { label: "Run Command" } }, waiting: true, questions: ["ignored"], plan: "ignored", point: { index: 1 } }),
	record({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", kind: "execute", title: "Readable command", locations: [{ path: "C:/child/a.ts" }], content: [{ type: "content", content: { type: "text", text: "initial output" } }] }),
	"not a JSON line",
	record({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }], rawOutput: { text: "do not display" } }),
	textChunk("agent_message_chunk", "After"),
	textChunk("agent_message_chunk", " work"),
];
fs.writeFileSync(transcriptFile, transcriptLines.join("\n"));
const transcript = subagentTranscript(id, root);
assert.equal(transcript.ok, true);
assert.equal(transcript.truncated, false);
assert.deepEqual(transcript.messages[0], { id: "subagent-prompt", role: "user", text: "List files." });
const work = transcript.messages[1];
assert.equal(work.text, "BeforeAfter work");
assert.equal(work.thought, "thinking");
assert.deepEqual(work.tools, [{ id: "tool-1", kind: "execute", title: "Readable command", detail: "Ran", label: "Run Command", description: "Run check", command: "Write-Output done", path: "C:/child/a.ts", output: "done" }], "all three updates retain the readable tool fields");
assert.deepEqual(work.parts, [{ kind: "text", text: "Before" }, { kind: "tool", id: "tool-1" }, { kind: "text", text: "After work" }]);
for (const field of ["waiting", "questions", "plan", "point", "rawOutput"]) { assert.equal(Object.hasOwn(work.tools[0], field), false, `${field} is not replayed`); }
assert.equal(Object.hasOwn(work, "point"), false);
assert.equal(subagentTranscript("../outside", root).ok, false);
assert.equal(subagentTranscript(id, path.join(root, "missing")).ok, false, "unavailable session roots fail softly");
fs.writeFileSync(transcriptFile, [textChunk("agent_thought_chunk", "t".repeat(21000)), record({ sessionUpdate: "tool_call", toolCallId: "large", rawInput: { command: "c".repeat(5000) } }), record({ sessionUpdate: "tool_call_update", toolCallId: "large", status: "failed", content: [{ type: "content", content: { type: "text", text: "o".repeat(2000) } }] })].join("\n"));
const clipped = subagentTranscript(id, root).messages[1];
assert.equal(clipped.thought.length, 20000);
assert.equal(clipped.tools[0].command.length, 4000);
assert.equal(clipped.tools[0].output.length, 1500);
assert.equal(clipped.tools[0].detail, "Failed");
fs.writeFileSync(transcriptFile, `${textChunk("agent_message_chunk", "head")}\n${"x".repeat(5 * 1024 * 1024)}\n${textChunk("agent_message_chunk", "tail")}\n`);
const tail = subagentTranscript(id, root);
assert.equal(tail.truncated, true);
assert.equal(tail.messages[1].text, "tail", "only the last 5 MiB is parsed and a partial first line is skipped");
fs.unlinkSync(transcriptFile);
assert.equal(subagentTranscript(id, root).ok, false, "missing updates fail softly");
console.log("PASS subagentTranscript: ordered replay, merged tool metadata, readonly fields and bounded tails");

fs.rmSync(root, { recursive: true, force: true });
