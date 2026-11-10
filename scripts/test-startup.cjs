const assert = require("node:assert/strict");
const path = require("node:path");
const { signInCommand, desktopEntry, autostartFile } = require("../electron/startup.cjs");

assert.deepEqual(signInCommand({ isPackaged: true, execPath: "/opt/grok/grok", appDir: "/opt/grok/resources/app" }), { path: "/opt/grok/grok", args: ["--at-sign-in"] }, "an installed app starts itself with only the flag");
assert.deepEqual(signInCommand({ isPackaged: false, execPath: "C:/repo/electron.exe", appDir: "C:/my repo" }), { path: "C:/repo/electron.exe", args: ["C:/my repo", "--build-if-stale", "--at-sign-in"] }, "a source checkout matches the taskbar pin, with no quotes of its own");

const exec = (text) => /^Exec=(.*)$/m.exec(text)[1];
const plain = desktopEntry({ path: "/opt/grok/grok", args: ["--at-sign-in"] });
assert.equal(plain, "[Desktop Entry]\nType=Application\nName=Codewomplers Grok Desktop\nExec=\"/opt/grok/grok\" \"--at-sign-in\"\n");
assert.equal(exec(desktopEntry({ path: "/home/a b/grok", args: [] })), "\"/home/a b/grok\"", "a space stays inside the quotes");
assert.equal(exec(desktopEntry({ path: "/home/$USER/grok", args: [] })), "\"/home/\\\\$USER/grok\"", "a literal $ is \\\\$ in the file, as the spec says");
assert.equal(exec(desktopEntry({ path: "/home/100%/%u", args: [] })), "\"/home/100%%/%%u\"", "a percent is doubled, so %u is not a field code");
assert.equal(exec(desktopEntry({ path: "/a\"b`c\\d", args: [] })), "\"/a\\\\\"b\\\\`c\\\\\\\\d\"", "the other reserved characters follow the same two layers");
assert.equal(exec(desktopEntry({ path: "/home/a b/$x%/electron", args: ["/home/a b/$x%", "--build-if-stale", "--at-sign-in"] })), "\"/home/a b/\\\\$x%%/electron\" \"/home/a b/\\\\$x%%\" \"--build-if-stale\" \"--at-sign-in\"", "every part is quoted on its own");

const home = path.join(path.sep, "home", "chris");
const name = path.join("autostart", "codewomplers-grok-desktop.desktop");
const custom = path.join(path.sep, "tmp", "config");
assert.equal(autostartFile({ XDG_CONFIG_HOME: custom }, home), path.join(custom, name));
assert.equal(autostartFile({}, home), path.join(home, ".config", name), "with no XDG_CONFIG_HOME it is ~/.config");
assert.equal(autostartFile({ XDG_CONFIG_HOME: "" }, home), path.join(home, ".config", name), "an empty XDG_CONFIG_HOME counts as unset");
assert.equal(autostartFile({ XDG_CONFIG_HOME: "relative/config" }, home), path.join(home, ".config", name), "a relative XDG_CONFIG_HOME is ignored");

console.log("Startup checks passed: sign-in commands, Desktop Entry quoting and the autostart path.");
