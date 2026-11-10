const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const path = require("path");

async function readData({ action, roots, sessionId, file }) {
	const usage = require("./usage.cjs");
	if (action === "spend") {
		const spent = roots.map((root) => usage.recentSpend(Date.now(), root));
		const read = spent.filter((item) => item.ok);
		return read.length ? { ok: true, usd: read.reduce((total, item) => total + item.usd, 0) } : spent[0];
	}
	if (action === "output") {
		return usage.taskOutput(file, roots.find((root) => file.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)));
	}
	const root = usage.rootOf(sessionId, roots);
	if (action === "context") { return usage.contextBreakdown(sessionId, root); }
	if (action === "transcript") { return usage.subagentTranscript(sessionId, root); }
	if (action === "loops") { return require("./loops.cjs").readSessionLoops(sessionId, root); }
	if (action === "export") {
		return require("./export.cjs").exportMarkdown({ sessionId, file, home: root === roots[0] ? "" : path.dirname(root) });
	}
	throw new Error("Unknown saved session request.");
}

// WSL file operations can wait for a distribution to boot, including during a turn-end spend refresh.
function readSessionData(request) {
	return new Promise((resolve) => {
		let worker;
		try {
			worker = new Worker(__filename, { workerData: request });
		} catch {
			resolve({ ok: false, error: "Grok's saved session data could not be read." });
			return;
		}
		worker.once("message", resolve);
		worker.once("error", () => resolve({ ok: false, error: "Grok's saved session data could not be read." }));
		worker.once("exit", () => resolve({ ok: false, error: "Grok's saved session data could not be read." }));
	});
}

if (!isMainThread) {
	readData(workerData).then((result) => parentPort.postMessage(result), () => parentPort.postMessage({ ok: false, error: "Grok's saved session data could not be read." }));
}

module.exports = { readSessionData };
