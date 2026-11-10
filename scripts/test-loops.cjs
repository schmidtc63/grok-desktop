const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readSessionLoops } = require("../electron/loops.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-loops-test-"));
try {
	const sessionId = "10000000-0000-4000-8000-000000000001";
	const folder = path.join(root, "project", sessionId);
	const key = `xai-${"A".repeat(48)}`;
	const prefix = "s".repeat(195);
	const boundary = `${prefix}${key}`;
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "chat_history.jsonl"), "");
	fs.writeFileSync(path.join(folder, "resources_state.json"), JSON.stringify({
		"grok_build.Scheduler": { tasks: {
			complete: { prompt: `Check ${key}`, human_schedule: `Use ${key}` },
			truncated: { prompt: boundary, human_schedule: boundary },
		} },
	}));
	assert.deepStrictEqual(readSessionLoops(sessionId, root), {
		ok: true,
		loops: [
			{ id: "complete", prompt: "Check [redacted]", schedule: "Use [redacted]", nextFireAt: "" },
			{ id: "truncated", prompt: `${prefix}[reda`, schedule: `${prefix}[reda`, nextFireAt: "" },
		],
	});
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("Loop preview tests passed.");
