const path = require("path");

// Electron quotes each argument itself on Windows (FormatCommandLineString), so a command carries no quotes of its own.
function signInCommand({ isPackaged, execPath, appDir }) {
	return { path: execPath, args: isPackaged ? ["--at-sign-in"] : [appDir, "--build-if-stale", "--at-sign-in"] };
}

// The Desktop Entry spec quotes Exec in two layers: a quoted argument escapes ", `, $ and \, then the key file's string rule
// doubles every backslash, so a literal $ is \\$ in the file. A file with a bare \$ is an invalid escape to GLib.
function desktopEntry(command) {
	const quoted = [command.path, ...command.args].map((part) => `"${part.replace(/["`$\\]/g, "\\$&")}"`).join(" ");
	const exec = quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
	return `[Desktop Entry]\nType=Application\nName=Codewomplers Grok Desktop\nExec=${exec}\n`;
}

// The XDG spec says to ignore a relative or empty XDG_CONFIG_HOME.
function autostartFile(env, home) {
	const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
	return path.join(config, "autostart", "codewomplers-grok-desktop.desktop");
}

module.exports = { signInCommand, desktopEntry, autostartFile };
