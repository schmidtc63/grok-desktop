const fs = require("node:fs");
const path = require("node:path");

function packageNodePty(appFolder, platform, arch, source = path.join(__dirname, "../node_modules/node-pty")) {
	if (!(platform === "linux" && arch === "x64") && !(platform === "win32" && arch === "x64") && !(platform === "darwin" && ["arm64", "x64"].includes(arch))) { throw new Error("Unsupported terminal package target."); }
	const nativeFolder = platform === "linux" ? "build/Release" : `prebuilds/${platform}-${arch}`;
	const required = platform === "win32" ? ["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"] : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"];
	for (const file of ["package.json", "LICENSE", "lib/index.js", ...required.map((name) => `${nativeFolder}/${name}`)]) {
		if (!fs.statSync(path.join(source, file), { throwIfNoEntry: false })?.isFile()) { throw new Error(`The ${platform}-${arch} terminal runtime is missing ${file}.`); }
	}
	const target = path.resolve(appFolder, "node_modules/node-pty");
	if (fs.existsSync(target)) { throw new Error(`The terminal package destination already exists: ${target}`); }
	const directory = (folder) => { fs.mkdirSync(folder, { recursive: true }); fs.chmodSync(folder, 0o755); };
	const copy = (relative, executable = false) => {
		const destination = path.join(target, relative);
		directory(path.dirname(destination));
		fs.copyFileSync(path.join(source, relative), destination);
		fs.chmodSync(destination, executable ? 0o755 : 0o644);
	};
	const tree = (relative, include) => {
		for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
			const file = path.join(relative, entry.name);
			if (entry.isDirectory()) { tree(file, include); } else if (entry.isFile() && include(entry.name)) { copy(file, entry.name === "spawn-helper" || /\.exe$/i.test(entry.name)); }
		}
	};
	directory(path.dirname(target));
	copy("package.json");
	copy("LICENSE");
	tree("lib", (name) => name.endsWith(".js") && !name.endsWith(".test.js"));
	for (const file of required) { copy(`${nativeFolder}/${file}`, file === "spawn-helper" || /\.exe$/i.test(file)); }
	return target;
}

if (require.main === module) {
	try {
		const [appFolder, platform, arch] = process.argv.slice(2);
		if (!appFolder) { throw new Error("Pass the packaged resources/app folder, platform and architecture."); }
		packageNodePty(appFolder, platform, arch);
		console.log(`Bundled node-pty for ${platform}-${arch}.`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

module.exports = { packageNodePty };
