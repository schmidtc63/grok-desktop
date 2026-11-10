const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { transformSync } = require("esbuild");

const source = fs.readFileSync(path.join(__dirname, "../src/grok-bot-rows.ts"), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
const target = { exports: {} };
vm.runInNewContext(compiled, { module: target, exports: target.exports, crypto: { randomUUID }, Date, Set, Map, URL });
const { describeRow, createGrokBotState, reduceGrokBot, messageIdFor, statusLine, showStop, historyBeforeSeq } = target.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const row = (entryKind, body, seq = "1", extra = {}) => ({ entryKind, body, seq, updatedSeq: seq, entryId: `row-${seq}`, ...extra });
const reply = (type, message = {}, body = {}) => row("send-message", { kind: "send-message", message: { type, ...message }, ...body });

assert.deepEqual(plain(describeRow(row("message", { role: "user", content: "Hello" }))), { kind: "message", side: "user", text: "Hello" });
assert.equal(describeRow(row("message", { role: "user", content: "Research", fromAgent: { id: "helper", name: "Researcher" } })).label, "From Researcher");
assert.equal(describeRow(row("message", { role: "user", content: "Research", fromAgent: { id: "helper", name: "Researcher" } })).side, "grok");
assert.equal(describeRow(row("message", { role: "assistant", content: "Investigate", toAgent: { id: "helper", name: "Researcher" } })).label, "To Researcher");
assert.match(describeRow(row("user-attachment", { file_name: "report.txt" })).text, /You attached report.txt/);
assert.equal(describeRow(reply("text", { content: "# Reply" })).text, "# Reply");
assert.match(describeRow(reply("text", { content: "Reply", cards: [] })).note, /cards this app can't show/);
assert.deepEqual(plain(describeRow(reply("attachment", { file_name: "report.txt" }))), { kind: "attachment", side: "grok", text: "report.txt" });
assert.match(describeRow(reply("visualization", { title: "Chart" })).text, /Chart.*Open Grok Bot/);
const question = { prompt: "Which?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no", style: "secondary" }], allowCustom: true };
assert.equal(describeRow(reply("widget", { widget: question })).options.length, 2);
assert.equal(describeRow(reply("widget", { widget: question }, { respondedValue: "yes" })).answer, "yes");
assert.equal(describeRow(reply("widget", { widget: question }, { widgetDismissed: true })).answer, "Dismissed");
assert.equal(describeRow(reply("widget", { widget: question }, { widgetSkipped: true })).answer, "Skipped");
assert.equal(describeRow(reply("widget", { widget: question }, { respondedValue: "" })).closed, true);
assert.equal(describeRow(reply("widget", { widget: question }, { respondedValue: "yes" })).options.length, 0);
assert.equal(describeRow(reply("widget", { widget: { ...question, ruleChange: {} } })).text, "Change approval rule: Which? Use the Grok Bot app to respond.");
assert.match(describeRow(reply("widget", { widget: { prompt: "Answer", options: [] } })).note, /Open Grok Bot to answer/);

const cards = ["secret-request", "auto-review-approval", "local-tool-permission", "connector-grant", "user-form", "credential-request", "virtual-card-approval", "cookie-origin-approval", "meeting-join-consent", "mobile-tool-permission", "appearance-picker", "email-offer"];
for (const type of cards) {
	assert.match(describeRow(reply(type)).text, /Use the Grok Bot app to respond/);
	assert.equal(describeRow(reply(type, { approval: { status: "approved" } })).closed, true);
	assert.match(describeRow(reply(type, { approval: { status: "approved" } })).text, /Handled in Grok Bot\.$/);
	assert.equal(describeRow(reply(type, { status: "pending", approval: { status: "approved" } })).closed, false);
}
const cardCases = [
	["secret-request", { secretRequest: { label: "Service key", value: "private-value" } }, {}, "Provide a secret: Service key", "Provide a secret"],
	["auto-review-approval", { approval: { summary: "Send the report", command: "private-command" } }, {}, "Review request: Send the report", "Review an approval request"],
	["auto-review-approval", { approval: { summaryCopy: { kind: "phone_call", params: { destination: "+1 555 0100", request: "Book a table" } } } }, { approval: { summaryCopy: { kind: "phone_call" } } }, "Approve a phone call to +1 555 0100: Book a table", "Approve a phone call to a phone number"],
	["auto-review-approval", { approval: { surface: "bot_share", command: JSON.stringify({ name: "Research helper", visibility: "private", body: "private-body" }) } }, { approval: { surface: "bot_share" } }, 'Share a Bot template "Research helper" (private)', "Share a Bot template"],
	["local-tool-permission", { ask: { action: "Read a file", target: "Documents/report.txt" } }, {}, "Allow a local action: Read a file: Documents/report.txt", "Allow a local action"],
	["connector-grant", { ask: { serverName: "Gmail" } }, {}, "Allow Gmail for this turn", "Allow a connected app for this turn"],
	["user-form", { formRequest: { title: "Delivery details", fields: [{ value: "private-one" }, {}, {}] } }, {}, 'Secure form "Delivery details", 3 fields', "Secure form"],
	["credential-request", { credentialRequest: { targetSite: "https://user:private-password@example.com/session/private-path?token=private-query#private-fragment", purpose: "Check an order" } }, {}, "Use a saved login for example.com: Check an order", "Use a saved login"],
	["credential-request", { credentialRequest: { kind: "brokered-login", goal: "Sign in to work sites", entries: [{ website: "https://work.example.com/private-path?session=private-query" }, { website: "mail.example.com/path#private-fragment" }, null] } }, { credentialRequest: { kind: "brokered-login" } }, "Sign in to work sites (work.example.com, mail.example.com)", "Use saved logins"],
	["virtual-card-approval", { approval: { title: "Hotel booking" } }, {}, "Virtual card purchase: Hotel booking", "Virtual card purchase"],
	["cookie-origin-approval", { approval: { requestId: "private-request", status: "pending" } }, {}, "Use your browser sign-ins", "Use your browser sign-ins"],
	["meeting-join-consent", { approval: { requestId: "private-request", status: "pending" } }, {}, "Ask meeting participants before the Bot joins", "Ask meeting participants before the Bot joins"],
	["mobile-tool-permission", { permission: { toolId: "calendar", machineLabel: "My phone" } }, {}, "Allow phone access: calendar (My phone)", "Allow phone access"],
	["appearance-picker", { extra: "private-unknown" }, {}, "Choose the Bot's appearance", "Choose the Bot's appearance"],
	["email-offer", { email: "helper@example.com", site: "https://user:private-password@shop.example.com/session/private-path?token=private-query#private-fragment" }, {}, "Use an email address for the Bot: helper@example.com (for shop.example.com)", "Use an email address for the Bot"],
	["widget", { widget: { ruleChange: { kind: "add", effect: "ask_first", text: "Send email" } } }, { widget: { ruleChange: {} } }, "Add approval rule: Ask first: Send email", "Change approval rule"],
	["widget", { widget: { ruleChange: { kind: "delete", effect: "allow", text: "Read files" } } }, { widget: { ruleChange: { kind: "delete" } } }, "Remove approval rule: Allow without asking: Read files", "Remove approval rule"],
	["widget", { widget: { ruleChange: { kind: "update", effect: "ask_first", text: "Send email", replaces: "Send messages" } } }, { widget: { ruleChange: { kind: "update" } } }, 'Update approval rule: Ask first: Send email (replaces "Send messages")', "Update approval rule"],
];
for (const [type, details, missing, expected, fallback] of cardCases) {
	for (const [message, request] of [[details, expected], [missing, fallback]]) {
		const description = plain(describeRow(reply(type, message)));
		assert.deepEqual(description, { kind: "note", side: "grok", text: `${request}. Use the Grok Bot app to respond.`, closed: false }, `${type} describes supplied or absent details`);
		assert.equal(description.text.includes(type), false, `${type} does not expose its raw type`);
		assert.doesNotMatch(description.text, /private-(?:value|command|body|one|password|path|query|fragment|request|unknown)|\n|undefined|\[object Object\]/);
	}
}
assert.equal(describeRow(reply("auto-review-approval", { approval: { reason: "Confirm the booking." } })).text, "Review request: Confirm the booking. Use the Grok Bot app to respond.");
assert.equal(describeRow(reply("secret-request", { secretRequest: { label: "  Service\n  key  " } })).text, "Provide a secret: Service key. Use the Grok Bot app to respond.");
for (const command of ["not JSON", "null", "[]", "123"]) {
	assert.equal(describeRow(reply("auto-review-approval", { approval: { surface: "bot_share", command } })).text, "Share a Bot template. Use the Grok Bot app to respond.");
}
for (const site of ["user:private-password@bad host/path?private-query", "https://", "javascript:private-value", "/relative/private-path", null, {}]) {
	assert.equal(describeRow(reply("credential-request", { credentialRequest: { targetSite: site } })).text, "Use a saved login. Use the Grok Bot app to respond.");
	assert.equal(describeRow(reply("email-offer", { site })).text, "Use an email address for the Bot. Use the Grok Bot app to respond.");
}
for (const [count, label] of [[0, "0 fields"], [1, "1 field"]]) {
	assert.equal(describeRow(reply("user-form", { formRequest: { fields: Array(count).fill({}) } })).text, `Secure form, ${label}. Use the Grok Bot app to respond.`);
}
for (const type of cards) {
	assert.doesNotThrow(() => describeRow(reply(type, { approval: null, ask: [], secretRequest: false, formRequest: { title: {}, fields: "missing" }, credentialRequest: { kind: "brokered-login", entries: {} }, permission: 1, email: {}, site: false })));
}
assert.equal(describeRow(reply("widget", { widget: { ruleChange: { kind: "new-kind", effect: "new-effect", text: "Review purchases" } } }, { respondedValue: "yes" })).text, "Change approval rule: Review purchases. Handled in Grok Bot.");
for (const [type, field, value] of [["secret-request", "secretProvided", true], ["user-form", "formResolution", "done"], ["user-form", "widgetDismissed", true], ["credential-request", "credentialResolution", "approved"], ["credential-request", "credentialResolution", "denied"], ["credential-request", "credentialResolution", "failed"], ["appearance-picker", "respondedValue", "blue"], ["email-offer", "respondedValue", "yes"]]) {
	assert.equal(describeRow(reply(type, {}, { [field]: value })).closed, true);
}
for (const value of ["retryable", "filling"]) { assert.equal(describeRow(reply("credential-request", {}, { credentialResolution: value })).closed, false); }
assert.equal(describeRow(reply("email-offer", { replaced: true })).closed, true);
for (const [type, message, name] of [["connector", { connector: "Gmail", variant: "connect", serverId: "gmail" }, "Gmail"], ["scm-connect", { provider: "github" }, "github"], ["connector", {}, "an account"], ["scm-connect", {}, "a source control account"]]) {
	assert.deepEqual(plain(describeRow(reply(type, message))), { kind: "note", side: "grok", text: `Grok Bot asked you to connect ${name}. If you haven't yet, do it in the Grok Bot app. This app can't show that card.` });
}
assert.equal(describeRow(row("event", { event: { type: "name-changed", from: "Old", to: "New" } })).text, "Renamed from Old to New");
assert.equal(describeRow(row("event", { event: { type: "other" } })).text, "Event: other");
assert.match(describeRow(row("send-message", undefined, "1", { stored: true })).text, /stored separately/);
assert.equal(describeRow(reply("new-card")).text, "This app can't show this item yet. Open Grok Bot to see it.");
assert.match(describeRow(row("voice-call", {})).text, /can't show this item/);
console.log("PASS Grok Bot rows cover messages, delegation, files, widgets, per-card closure and unsupported items");

let state = createGrokBotState();
const signedIn = { ...state.status, signedIn: true, keyring: true, connection: "live", bots: [{ agentId: "bot", name: "Bot" }] };
state = reduceGrokBot(state, { type: "grokbot-status", status: signedIn }, 100000);
state = reduceGrokBot(state, { type: "grokbot-history", agentId: "bot", rows: [row("message", { content: "new" }, "9007199254740994"), row("message", { content: "old" }, "9007199254740993")] });
assert.deepEqual(plain(state.rows.bot.map((item) => item.seq)), ["9007199254740993", "9007199254740994"]);
assert.equal(state.beforeSeq.bot, "9007199254740993");
state = reduceGrokBot(state, { type: "grokbot-rows", agentId: "bot", rows: [row("message", { content: "updated" }, "9007199254740993", { updatedSeq: "9007199254740995" }), row("message", { content: "ancient update" }, "1", { updatedSeq: "9007199254740996" })] });
state = reduceGrokBot(state, { type: "grokbot-rows", agentId: "bot", rows: [row("message", { content: "stale" }, "9007199254740993")] });
assert.equal(state.rows.bot[1].body.content, "updated");
assert.equal(state.beforeSeq.bot, "9007199254740993", "streamed old updates do not move the history cursor");
state = reduceGrokBot(state, { type: "grokbot-history", agentId: "bot", rows: [row("message", { content: "page" }, "12"), row("message", { content: "page" }, "10")] });
assert.equal(state.beforeSeq.bot, "10", "cursor belongs to the last page, not the oldest cached row");
assert.equal(historyBeforeSeq([]), undefined);
state = reduceGrokBot(state, { type: "grokbot-rows", agentId: "bot", rows: [], deletes: ["row-12"] });
assert.equal(state.rows.bot.some((item) => item.entryId === "row-12"), false);
state = reduceGrokBot(state, { type: "grokbot-reset", agentId: "bot", rows: [row("message", { content: "reset" }, "4", { entryId: undefined })] });
assert.equal(state.rows.bot.length, 1);
assert.equal(state.beforeSeq.bot, "4");
state = reduceGrokBot(state, { type: "grokbot-rows", agentId: "bot", rows: [row("message", { content: "reset updated" }, "4", { entryId: undefined, updatedSeq: "5" })] });
assert.equal(state.rows.bot.length, 1);
assert.equal(state.rows.bot[0].body.content, "reset updated");
console.log("PASS Grok Bot rows merge large sequences, updates, deletion, resets and page-owned history cursors");

const firstId = messageIdFor(state, "bot", "Hello", () => "first");
state = reduceGrokBot(state, { type: "grokbot-send", agentId: "bot", messageId: firstId, text: "Hello", at: 1000 });
state = reduceGrokBot(state, { type: "grokbot-send-result", agentId: "bot", messageId: firstId, ok: false, error: "Not sent" });
assert.equal(messageIdFor(state, "bot", "Hello", () => "new"), "first");
assert.equal(messageIdFor(state, "bot", "Different", () => "new"), "new");
assert.equal(state.pending.bot[0].error, "Not sent");
state = reduceGrokBot(state, { type: "grokbot-send", agentId: "bot", messageId: firstId, text: "Hello", at: 10000 });
assert.equal(state.pending.bot.length, 1);
state = reduceGrokBot(state, { type: "grokbot-send-result", agentId: "bot", messageId: firstId, ok: true });
state = reduceGrokBot(state, { type: "grokbot-tick", now: 60999 });
assert.equal(state.pending.bot[0].error, undefined);
state = reduceGrokBot(state, { type: "grokbot-tick", now: 61000 });
assert.match(state.pending.bot[0].error, /Not confirmed yet/);
state = reduceGrokBot(state, { type: "grokbot-rows", agentId: "bot", rows: [row("message", { role: "user", content: "Hello", clientNonce: firstId }, "6")] });
assert.equal(state.pending.bot.length, 0);
assert.equal(state.lastSend.bot, undefined);
assert.equal(messageIdFor(state, "bot", "Hello", () => "new"), "new");
console.log("PASS Grok Bot pending copies reconcile echoes, time out honestly and reuse uncertain send IDs");

state = reduceGrokBot(state, { type: "grokbot-live", agentId: "bot", running: false, outcome: "error", turnId: "failed-one", settledAtMs: 99000 }, 100000);
assert.equal(state.notes.bot, "That turn didn't finish.");
state = reduceGrokBot(state, { type: "grokbot-send", agentId: "bot", messageId: "later", text: "Next", at: 100000 });
assert.equal(state.notes.bot, "");
state = reduceGrokBot(state, { type: "grokbot-live", agentId: "bot", outcome: "error", turnId: "failed-one", settledAtMs: 99000 }, 100000);
assert.equal(state.notes.bot, "", "the same failed turn cannot restore a cleared note");
state = reduceGrokBot(state, { type: "grokbot-live", agentId: "bot", outcome: "error", turnId: "too-old", settledAtMs: 40000 }, 100000);
assert.equal(state.notes.bot, "");
state = reduceGrokBot(state, { type: "grokbot-live", agentId: "bot", outcome: "cancelled", turnId: "cancelled", settledAtMs: 99000 }, 100000);
assert.equal(state.notes.bot, "");
state = reduceGrokBot(state, { type: "grokbot-failed", agentId: "bot", summary: "Service unavailable." });
assert.equal(state.notes.bot, "That turn didn't finish. Service unavailable.");
state = reduceGrokBot(state, { type: "grokbot-status", status: { ...signedIn, live: { other: { running: true, detail: "Checking" } } } });
assert.equal(state.status.live.other.running, true);
state = reduceGrokBot(state, { type: "grokbot-status", status: { ...signedIn, signedIn: false, live: {}, bots: [], connection: "off" } });
for (const key of ["rows", "pending", "lastSend", "notes", "beforeSeq", "failedTurns"]) { assert.equal(Object.keys(state[key]).length, 0); }
console.log("PASS Grok Bot failure notes are current and sign-out clears all account conversation state");

for (const snapshot of [false, true]) {
	for (const detailedFirst of [false, true]) {
		const settlement = { outcome: "error", turnId: "failed-detail", settledAtMs: 99000 };
		const settled = snapshot ? { type: "grokbot-status", status: { ...signedIn, live: { bot: settlement } } } : { type: "grokbot-live", agentId: "bot", ...settlement };
		const detailed = { type: "grokbot-failed", agentId: "bot", summary: "Service unavailable." };
		let failure = createGrokBotState();
		for (const event of detailedFirst ? [detailed, settled] : [settled, detailed]) { failure = reduceGrokBot(failure, event, 100000); }
		assert.equal(failure.notes.bot, "That turn didn't finish. Service unavailable.", "settlement and detailed failure keep the summary in either arrival order");
		failure = reduceGrokBot(failure, { type: "grokbot-send", agentId: "bot", messageId: "next-turn", text: "Next", at: 100000 });
		assert.equal(failure.notes.bot, "", "the next send clears the detailed failure");
		failure = reduceGrokBot(failure, settled, 100000);
		assert.equal(failure.notes.bot, "", "a repeated settlement cannot restore the cleared failure");
	}
}
console.log("PASS Grok Bot detailed failures survive live and snapshot settlements in either arrival order");

for (const snapshot of [false, true]) {
	const liveEvent = (live) => snapshot ? { type: "grokbot-status", status: { ...signedIn, live: { bot: live } } } : { type: "grokbot-live", agentId: "bot", ...live };
	const failed = { running: false, outcome: "error", turnId: "retry-one", settledAtMs: 99000 };
	let retry = reduceGrokBot(createGrokBotState(), liveEvent(failed), 100000);
	retry = reduceGrokBot(retry, { type: "grokbot-failed", agentId: "bot", summary: "Retry this request." }, 100000);
	retry = reduceGrokBot(retry, liveEvent({ ...failed, running: true }), 100000);
	assert.equal(retry.notes.bot, "", "running clears the failure without a send from this app");
	retry = reduceGrokBot(retry, liveEvent(failed), 100000);
	assert.equal(retry.notes.bot, "", "a repeated settled failure cannot bring the cleared note back");
	retry = reduceGrokBot(retry, liveEvent({ ...failed, running: true, turnId: "retry-two" }), 100000);
	assert.equal(retry.notes.bot, "", "a retry carrying a newly observed failed attempt stays clear");
	retry = reduceGrokBot(retry, liveEvent({ ...failed, turnId: "retry-two" }), 100000);
	assert.equal(retry.notes.bot, "", "the running frame records its settlement for replay suppression");
	retry = reduceGrokBot(retry, liveEvent({ running: false, outcome: "success", turnId: "recovered", settledAtMs: 100000 }), 100001);
	assert.equal(retry.notes.bot, "", "a later successful reply keeps the failure cleared");
	for (const detailedFirst of [false, true]) {
		const finalError = liveEvent({ ...failed, turnId: "final-failure", settledAtMs: 100001 });
		const detail = { type: "grokbot-failed", agentId: "bot", summary: "The service stopped retrying." };
		let final = retry;
		for (const event of detailedFirst ? [detail, finalError] : [finalError, detail]) { final = reduceGrokBot(final, event, 100002); }
		assert.equal(final.notes.bot, "That turn didn't finish. The service stopped retrying.", "the terminal failure retains its summary after retries");
	}
}
console.log("PASS Grok Bot running updates clear stale failures while final summaries and replay suppression remain intact");

for (const [live, expected] of [[{}, ""], [{ running: true }, "Working…"], [{ running: true, detail: "Checking" }, "Checking"], [{ running: false, detail: "Old" }, ""], [{ running: true, composing: true }, "Writing…"], [{ running: true, retrying: true }, "Retrying…"], [{ waiting: true, retrying: true }, "Waiting for you in Grok Bot."]]) {
	assert.equal(statusLine(live, "live"), expected);
}
assert.match(statusLine({ running: true, detail: "Old" }, "reconnecting"), /Reconnecting/);
assert.match(statusLine({ running: true }, "expired"), /sign-in ended/);
assert.match(statusLine({ running: true }, "problem"), /Cursor may have changed/);
assert.equal(showStop({ running: true }, "live"), true);
assert.equal(showStop({}, "live"), false);
assert.equal(showStop({}, "problem"), true);
assert.equal(showStop({ running: true }, "reconnecting"), false);
assert.equal(showStop({ running: true }, "expired"), false);
console.log("PASS Grok Bot status precedence is truthful and Stop follows the approved availability rule");
