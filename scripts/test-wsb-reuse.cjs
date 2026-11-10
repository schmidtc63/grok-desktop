const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

async function checkVmReuse() {
	const file = path.resolve(__dirname, "../electron/sandbox.cjs");
	const module = { exports: {} };
	const machines = new Map();
	let active = "";
	let starts = 0;
	class FakeSocket extends EventEmitter {
		constructor() {
			super();
			this.readyState = 1;
			setImmediate(() => {
				this.emit("open");
				setImmediate(() => this.emit("message", { data: "ready" }));
			});
		}
		addEventListener(event, callback) { this.on(event, callback); }
		close() { this.emit("close"); }
	}
	vm.runInNewContext(fs.readFileSync(file, "utf8"), {
		module, Buffer, process, WebSocket: FakeSocket, setTimeout, clearTimeout, setImmediate,
		require(name) {
			if (name !== "child_process") { return require(name); }
			return {
				spawnSync: () => ({ status: 0, stdout: "" }),
				spawn(command, [verb, ...args]) {
					assert.equal(command, "wsb");
					const child = new EventEmitter();
					child.stdout = new EventEmitter();
					child.stderr = new EventEmitter();
					child.stdin = new EventEmitter();
					child.stdin.end = () => {};
					setImmediate(() => {
						const option = (flag) => args[args.indexOf(flag) + 1];
						const id = option("--id");
						if (verb === "start") {
							assert.equal(active, "", "the old VM must stop before starting its replacement");
							active = `00000000-0000-0000-0000-${String(++starts).padStart(12, "0")}`;
							machines.set(active, new Set());
							child.stdout.emit("data", active);
						} else if (verb === "stop") {
							assert.equal(id, active);
							active = "";
						} else {
							assert.equal(id, active);
							if (verb === "share") { machines.get(id).add(option("-f")); }
							if (verb === "ip") { child.stdout.emit("data", "127.0.0.1"); }
						}
						child.emit("close", 0);
					});
					return child;
				},
			};
		},
	}, { filename: file });
	const sandbox = module.exports;
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wsb-reuse-"));
	sandbox.setDataDir(scratch);
	const options = { platform: "win32", grokExe: "C:\\grok\\grok.exe", owner: "one" };
	const oldFolder = "C:\\projects\\old";
	const newFolder = "C:\\projects\\new";
	const oldTools = "C:\\old-tools";
	async function start(cwd, mappedFolders, side = false) {
		const target = sandbox.targetFor({ option: "windows-sandbox", mappedFolders }, cwd, { ...options, side });
		const { child } = target.launch(["agent", "stdio"], {});
		let error = "";
		child.stderr.on("data", (chunk) => { error += chunk; });
		await Promise.race([
			once(child.stdout, "data"),
			once(child, "exit").then(() => { throw new Error(error || "Grok exited before its fake socket opened"); }),
		]);
		return child;
	}
	try {
		const main = await start(oldFolder, [oldTools]);
		const side = await start(oldFolder, [oldTools], true);
		const oldVm = active;
		assert.equal(starts, 1, "the same session and mounts can share one VM");
		assert.ok(machines.get(oldVm).has(oldFolder) && machines.get(oldVm).has(oldTools));
		main.kill();
		const moved = await start(newFolder, [oldTools]);
		assert.notEqual(active, oldVm, "moving the session requires a fresh VM even with a side chat open");
		assert.equal(side.done, true);
		assert.ok(machines.get(active).has(newFolder));
		assert.equal(machines.get(active).has(oldFolder), false);
		const movedVm = active;
		moved.kill();
		const toolsRemoved = await start(newFolder, []);
		assert.notEqual(active, movedVm, "removing a tool mount requires a fresh VM without a folder change");
		assert.ok(machines.get(active).has(newFolder));
		assert.equal(machines.get(active).has(oldTools), false);
		await assert.rejects(start(newFolder, [oldTools], true), /main session is changing its Windows Sandbox/);
		assert.equal(toolsRemoved.done, false, "a stale side chat must not replace the main session's VM");
		assert.equal(starts, 3);
		toolsRemoved.kill();
	} finally {
		for (const child of sandbox.wsbClients) { child.kill(); }
		sandbox.shutdown();
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

checkVmReuse().then(() => console.log("Windows Sandbox reuse tests passed"), (error) => {
	console.error(error);
	process.exitCode = 1;
});
