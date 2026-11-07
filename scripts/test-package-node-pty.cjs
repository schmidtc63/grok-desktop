const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packageNodePty } = require("./package-node-pty.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pty-package-"));
const files = (folder, relative = "") => fs.readdirSync(path.join(folder, relative), { withFileTypes: true }).flatMap((entry) => {
	const file = path.join(relative, entry.name);
	return entry.isDirectory() ? files(folder, file) : [file.split(path.sep).join("/")];
});
try {
	for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]]) {
		const app = path.join(root, `${platform}-${arch}`);
		const target = packageNodePty(app, platform, arch);
		const copied = files(target);
		assert.deepEqual(fs.readdirSync(path.join(target, "prebuilds")), [`${platform}-${arch}`]);
		assert.ok(copied.includes(`prebuilds/${platform}-${arch}/pty.node`));
		assert.ok(copied.includes("lib/index.js") && copied.includes("LICENSE") && copied.includes("package.json"));
		assert.ok(!copied.some((file) => /\.pdb$|\.test\.js$|\.map$/.test(file)), "debug files and tests are left out");
		assert.equal(fs.existsSync(path.join(target, "build")), false, "a foreign local build cannot override the selected prebuild");
		if (platform === "win32") {
			for (const file of ["conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"]) { assert.ok(copied.includes(`prebuilds/win32-x64/${file}`), file); }
			for (const file of ["lib/conpty_console_list_agent.js", "lib/windowsConoutConnection.js", "lib/worker/conoutSocketWorker.js", "lib/shared/conout.js"]) { assert.ok(copied.includes(file), file); }
		} else {
			assert.ok(copied.includes(`prebuilds/darwin-${arch}/spawn-helper`));
			if (process.platform !== "win32") { assert.equal(fs.statSync(path.join(target, `prebuilds/darwin-${arch}/spawn-helper`)).mode & 0o777, 0o755); }
		}
		const installed = path.resolve(__dirname, "../node_modules/node-pty");
		for (const file of copied) { assert.deepEqual(fs.readFileSync(path.join(target, file)), fs.readFileSync(path.join(installed, file)), file); }
		assert.throws(() => packageNodePty(app, platform, arch), /already exists/, "an existing package is never overwritten");
	}
	console.log("PASS terminal packaging: installed Windows/Mac runtimes keep only matching prebuilds and all helper files");

	const source = path.join(root, "linux-source");
	fs.mkdirSync(source);
	for (const [file, text] of Object.entries({ "package.json": '{"name":"node-pty","main":"lib/index.js"}', LICENSE: "MIT", "lib/index.js": "runtime", "lib/utils.js": "loader", "lib/example.test.js": "test", "build/Release/pty.node": "compiled Linux native", "build/Release/obj.target/pty.o": "object", "prebuilds/win32-x64/pty.node": "foreign" })) {
		fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
		fs.writeFileSync(path.join(source, file), text);
	}
	const linux = packageNodePty(path.join(root, "linux"), "linux", "x64", source);
	assert.deepEqual(files(linux).sort(), ["LICENSE", "build/Release/pty.node", "lib/index.js", "lib/utils.js", "package.json"].sort());
	assert.equal(fs.readFileSync(path.join(linux, "build/Release/pty.node"), "utf8"), "compiled Linux native");
	fs.unlinkSync(path.join(source, "build/Release/pty.node"));
	assert.throws(() => packageNodePty(path.join(root, "missing"), "linux", "x64", source), /missing build\/Release\/pty\.node/, "Linux must supply its compiled native module");
	assert.equal(fs.existsSync(path.join(root, "missing")), false, "incomplete input is refused before creating a package");
	assert.throws(() => packageNodePty(path.join(root, "bad"), "linux", "arm64", source), /Unsupported/);
	console.log("PASS terminal packaging: Linux includes its compiled runtime only and refuses a missing native build");
} finally {
	assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
	assert.ok(path.basename(root).startsWith("codex-pty-package-"));
	fs.rmSync(root, { recursive: true, force: true });
}
