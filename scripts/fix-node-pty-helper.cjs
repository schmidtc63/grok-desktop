const fs = require("node:fs");

// node-pty 1.1.0 is published with its macOS helper not executable, so the Terminal pane can't start a shell when the app runs from source.
// package-node-pty.cjs sets the bit on the packaged app's copy. 1.2.0-beta.18 is published with the bit, so delete this once a stable release is too.
for (const arch of ["arm64", "x64"]) {
	const helper = `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`;
	// npm_config_build_from_source removes the prebuilds.
	if (fs.existsSync(helper)) { fs.chmodSync(helper, 0o755); }
}
