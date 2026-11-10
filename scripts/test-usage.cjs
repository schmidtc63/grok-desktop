const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { contextBreakdown, recentSpend, autoCompactPercent, taskOutput, subagentTranscript, listCliSessions, listCliProjectFolders, openCliSession } = require("../electron/usage.cjs");

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
const stale = path.join(path.dirname(folder), "01a10000-0000-0000-0000-000000000000", "usage.json");
fs.mkdirSync(path.dirname(stale));
fs.writeFileSync(stale, JSON.stringify({ turns: [{ endedAt: "2026-10-28T08:00:00+00:00", costUsdTicks: 5e10 }] }));
fs.utimesSync(stale, new Date(now - 8 * 864e5), new Date(now - 8 * 864e5));
assert.deepEqual(recentSpend(now, root), { ok: true, usd: 3.5 }, "turns from the last seven days count, older ones and files untouched for a week do not");
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
const fakeKey = `xai-${"a".repeat(80)}`;
fs.writeFileSync(log, "first\nsecond\n");
assert.deepEqual(taskOutput(log, outputRoot), { ok: true, text: "first\nsecond\n", truncated: false });
fs.writeFileSync(log, `first\n${fakeKey}\n`);
assert.equal(taskOutput(log, outputRoot).text === "first\n[redacted]\n", true, "task output masks key-shaped text");
fs.writeFileSync(log, `prefix${"x".repeat(200 * 1024)}`);
assert.deepEqual(taskOutput(log, outputRoot), { ok: true, text: "x".repeat(200 * 1024), truncated: true }, "only the last 200 KiB of output is returned");
const logLimit = 200 * 1024;
const head = "q".repeat(2048);
const logSuffix = `\n${"z".repeat(logLimit - fakeKey.length + 29 - 1)}`;
fs.writeFileSync(log, `${head}${fakeKey}${logSuffix}`);
const maskedTail = taskOutput(log, outputRoot);
assert.ok(maskedTail.ok && maskedTail.truncated, "truncation uses the original log limit");
assert.ok(maskedTail.text === `${head}[redacted]${logSuffix}`.slice(-logLimit), "the log tail masks a key whose prefix is before the original cut");
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
fs.writeFileSync(transcriptFile, [textChunk("agent_message_chunk", `Key:\n${fakeKey.slice(0, 14)}`), textChunk("agent_message_chunk", fakeKey.slice(14))].join("\n"));
assert.equal(subagentTranscript(id, root).messages[1].text === "Key:\n[redacted]", true, "replayed chunks are masked after joining");
fs.writeFileSync(transcriptFile, [textChunk("agent_thought_chunk", "t".repeat(21000)), record({ sessionUpdate: "tool_call", toolCallId: "large", rawInput: { command: "c".repeat(5000) } }), record({ sessionUpdate: "tool_call_update", toolCallId: "large", status: "failed", content: [{ type: "content", content: { type: "text", text: "o".repeat(2000) } }] })].join("\n"));
const clipped = subagentTranscript(id, root).messages[1];
assert.equal(clipped.thought.length, 20000);
assert.equal(clipped.tools[0].command.length, 4000);
assert.equal(clipped.tools[0].output.length, 1500);
assert.equal(clipped.tools[0].detail, "Failed");
const redacted = "[redacted]";
const prefix = (cap) => "z".repeat(cap - redacted.length);
const across = (cap) => `${prefix(cap)}${fakeKey} after`;
fs.writeFileSync(transcriptFile, [
	textChunk("agent_thought_chunk", `${prefix(20000)}${fakeKey.slice(0, 14)}`),
	textChunk("agent_thought_chunk", `${fakeKey.slice(14)} after`),
	record({
		sessionUpdate: "tool_call",
		toolCallId: "straddle",
		status: "completed",
		_meta: { "x.ai/tool": { label: across(80) } },
		rawInput: { description: across(300), command: across(4000) },
		locations: [{ path: across(1000) }],
		content: [{ type: "content", content: { type: "text", text: across(1500) } }],
	}),
].join("\n"));
const maskedTranscript = subagentTranscript(id, root).messages[1];
assert.ok(maskedTranscript.thought === `${prefix(20000)}${redacted}`, "joined thought is masked before cutting");
for (const [field, cap] of [["label", 80], ["description", 300], ["command", 4000], ["path", 1000], ["output", 1500]]) {
	assert.ok(maskedTranscript.tools[0][field] === `${prefix(cap)}${redacted}`, `tool ${field} is masked before cutting`);
}
fs.writeFileSync(transcriptFile, `${textChunk("agent_message_chunk", "head")}\n${"x".repeat(5 * 1024 * 1024)}\n${textChunk("agent_message_chunk", "tail")}\n`);
const tail = subagentTranscript(id, root);
assert.equal(tail.truncated, true);
assert.equal(tail.messages[1].text, "tail", "only the last 5 MiB is parsed and a partial first line is skipped");
fs.unlinkSync(transcriptFile);
assert.equal(subagentTranscript(id, root).ok, false, "missing updates fail softly");
console.log("PASS subagentTranscript: ordered replay, merged tool metadata, readonly fields and bounded tails");

const cliRoot = fs.mkdtempSync(path.join(tempBase, "cli-"));
const cliWork = fs.mkdtempSync(path.join(tempBase, "work-"));
const olderId = "01a18843-d800-74f1-ab16-67f5d5375a3a";
const newerId = "01a19999-aaaa-7bbb-8ccc-ddddeeeeffff";
const knownId = "01a17777-1111-7222-8333-444455556666";
function plant(sessionId, cwd, summary, lines) {
	const dir = path.join(cliRoot, encodeURIComponent(cwd), sessionId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
	fs.writeFileSync(path.join(dir, "chat_history.jsonl"), `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return dir;
}
const user = (text, extra = {}) => ({ type: "user", content: [{ type: "text", text }], ...extra });
const assistant = (text) => ({ type: "assistant", content: text });
plant(olderId, cliWork, { generated_title: "Older chat", info: { id: olderId, cwd: cliWork }, last_active_at: "2026-11-01T08:00:00.000000Z", head_branch: "main", current_model_id: "grok-4.6", reasoning_effort: "low" }, [
	user(`<user_info>rules</user_info><user_query>first question</user_query>`),
	user("ignored rules", { synthetic_reason: "system_reminder" }),
	assistant("first answer"),
]);
plant(newerId, cliWork, { generated_title: "  Fix\nthe door  ", info: { cwd: cliWork }, last_active_at: "2026-11-05T18:04:01.379428700Z", head_branch: "feature/cli", current_model_id: "grok-4.7", reasoning_effort: "high" }, [
	user("<user_info>secret rules</user_info><rules>more</rules>"),
	user("<user_query>open the door</user_query>"),
	{ type: "reasoning", content: "hidden" },
	{ type: "assistant", content: [{ type: "text", text: "Opened." }] },
	{ type: "tool_result", content: "tool output" },
]);
plant(knownId, cliWork, { generated_title: "Already open", info: { cwd: cliWork }, last_active_at: "2026-11-06T00:00:00Z" }, [user("already")]);
fs.mkdirSync(path.join(cliRoot, encodeURIComponent(cliWork), "not-a-session"));
const listed = listCliSessions([knownId.toUpperCase()], cliRoot);
assert.equal(listed.ok, true);
assert.deepEqual(listed.sessions.map((item) => item.id), [newerId, olderId], "newest first, and a session the app already has is left out");
assert.equal(listed.sessions[0].title, "Fix the door");
assert.equal(listed.sessions[0].folder, cliWork);
assert.equal(listed.sessions[0].lastActive, Date.parse("2026-11-05T18:04:01.379Z"));
const bare = path.join(cliRoot, encodeURIComponent("C:/plain"), "01a16666-2222-7333-8444-555566667777");
fs.mkdirSync(bare, { recursive: true });
fs.writeFileSync(path.join(bare, "chat_history.jsonl"), `${JSON.stringify(user("plain question"))}\n`);
const bareListed = listCliSessions([], cliRoot).sessions.find((item) => item.folder === "C:/plain");
assert.equal(bareListed.title, "CLI session", "a session without a summary still lists its folder");
assert.equal(listCliSessions([], path.join(cliRoot, "missing")).ok, false);
const titledId = "01a13333-4444-7555-8666-777788889999";
const titled = plant(titledId, cliWork, { generated_title: across(80), info: { cwd: cliWork } }, [user("hi")]);
assert.equal(listCliSessions([], cliRoot).sessions.find((item) => item.id === titledId).title, `${prefix(80)}${redacted}`, "a CLI title is masked before it is cut");
assert.equal(openCliSession(titledId, cliRoot).session.title, `${prefix(80)}${redacted}`);
fs.rmSync(titled, { recursive: true, force: true });
const opened = openCliSession(newerId, cliRoot);
assert.equal(opened.ok, true);
assert.equal(opened.truncated, false);
assert.equal(opened.session.folder, cliWork);
assert.equal(opened.session.branch, "feature/cli");
assert.equal(opened.session.model, "grok-4.7");
assert.equal(opened.session.effort, "high");
assert.deepEqual(opened.messages, [
	{ role: "user", text: "open the door" },
	{ role: "grok", text: "Opened." },
], "rules, reminders, reasoning and tool results stay out of the opened chat");
const historyFile = path.join(cliRoot, encodeURIComponent(cliWork), newerId, "chat_history.jsonl");
const before = fs.readFileSync(historyFile);
assert.equal(fs.readFileSync(historyFile).equals(before), true);
fs.writeFileSync(historyFile, `${JSON.stringify(assistant(`Key:\n${fakeKey}`))}\n`);
assert.equal(openCliSession(newerId, cliRoot).messages[0].text === "Key:\n[redacted]", true, "imported CLI chat masks key-shaped text");
const messageCap = 24;
fs.writeFileSync(historyFile, `${JSON.stringify(assistant(across(messageCap)))}\n`);
const maskedMessage = openCliSession(newerId, cliRoot, { messageCap });
assert.ok(maskedMessage.truncated && maskedMessage.messages[0].text === `${prefix(messageCap)}${redacted}…`, "CLI message is masked before cutting");
fs.writeFileSync(historyFile, before);
const goneFolder = "C:/no/such/cli-folder";
plant("01a15555-3333-7444-8555-666677778888", goneFolder, { info: { cwd: goneFolder }, generated_title: "Missing" }, [user("hi")]);
const refused = openCliSession("01a15555-3333-7444-8555-666677778888", cliRoot);
assert.equal(refused.ok, false);
assert.match(refused.error, /folder is gone/);
assert.equal(fs.existsSync(goneFolder), false, "refusing a missing folder does not create it");
assert.match(openCliSession("01a10000-0000-7000-8000-000000000000", cliRoot).error, /gone/);
assert.match(openCliSession("../secret", cliRoot).error, /gone/);
const huge = openCliSession(olderId, cliRoot, { messageCap: 4, totalCap: 4 });
assert.equal(huge.truncated, true);
assert.equal(huge.messages.at(-1).text.endsWith("…"), true);
const wide = plant("01a14444-5555-7666-8777-888899990000", cliWork, { info: { cwd: cliWork }, generated_title: "Wide" }, [user("keep"), assistant("tail")]);
fs.appendFileSync(path.join(wide, "chat_history.jsonl"), `${"x".repeat(80)}\n${JSON.stringify(assistant("tail"))}\n`);
const tailed = openCliSession("01a14444-5555-7666-8777-888899990000", cliRoot, { fileLimit: 40 });
assert.equal(tailed.truncated, true);
assert.equal(tailed.messages.at(-1).text, "tail");
assert.deepEqual(listCliProjectFolders(cliRoot), [], "first-run project suggestions omit temporary and missing CLI folders");
fs.rmSync(cliRoot, { recursive: true, force: true });
fs.rmSync(cliWork, { recursive: true, force: true });
console.log("PASS CLI sessions: newest first, known ids left out, transcript without rules, missing folder refused");

async function checkSavedDataWorker() {
	const vm = require("node:vm");
	const workerThreads = require("node:worker_threads");
	const file = require.resolve("../electron/session-data.cjs");
	const preload = path.join(root, "codex-slow-session-reads.cjs");
	fs.writeFileSync(preload, `const fs = require("fs");
const original = fs.readdirSync;
fs.readdirSync = function(folder, ...args) {
	if (folder === ${JSON.stringify(root)}) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
	return original.call(this, folder, ...args);
};
`);
	const loaded = { exports: {} };
	vm.runInNewContext(fs.readFileSync(file, "utf8"), {
		module: loaded, __filename: file,
		require(name) {
			if (name !== "worker_threads") { return require(name); }
			return { ...workerThreads, Worker: class extends workerThreads.Worker {
				constructor(script, options) { super(script, { ...options, execArgv: ["--require", preload] }); }
			} };
		},
	});
	let responsive = false;
	const reading = loaded.exports.readSessionData({ action: "spend", roots: [root] });
	setTimeout(() => { responsive = true; }, 0);
	const spent = await reading;
	assert.equal(responsive, true, "the main event loop runs while a saved-data filesystem read blocks its worker");
	assert.deepEqual(spent, recentSpend(Date.now(), root));
	assert.deepEqual(await loaded.exports.readSessionData({ action: "context", sessionId: id, roots: [root] }), contextBreakdown(id, root));
	console.log("PASS saved session worker: slow filesystem reads preserve event-loop progress and existing data results");
}

checkSavedDataWorker().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => fs.rmSync(root, { recursive: true, force: true }));
