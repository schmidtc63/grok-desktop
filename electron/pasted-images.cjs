const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeAtomic } = require("../scripts/update-helper.cjs");

const IMAGE_NAME = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.png$/i;
const OLD_FOLDER = /^grok-code-paste-(?:[A-Za-z0-9]{6}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;

function createPastedImages({ getPath, platform, spawnSync }) {
	let folder;
	let pruned = false;
	const created = new Set();
	const key = (file) => platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
	function privateFolder() {
		const parent = getPath("userData");
		fs.mkdirSync(parent, { recursive: true });
		const target = path.join(parent, "pasted-images");
		if (fs.existsSync(target)) {
			if (!fs.lstatSync(target).isDirectory()) { throw new Error("The paste folder is unavailable."); }
			return target;
		}
		if (platform !== "win32") {
			fs.mkdirSync(target, { mode: 0o700 });
			return target;
		}
		const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const createPrivateFolder = `
			$ErrorActionPreference = 'Stop'
			$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
			$acl = [System.Security.AccessControl.DirectorySecurity]::new()
			$acl.SetAccessRuleProtection($true, $false)
			$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
			[System.IO.Directory]::CreateDirectory($env:GROK_PASTE_FOLDER, $acl) | Out-Null
		`;
		const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", createPrivateFolder], {
			env: { ...process.env, GROK_PASTE_FOLDER: target }, timeout: 5000, windowsHide: true,
		});
		if (result.status !== 0) { throw new Error("Could not create a private paste folder."); }
		return target;
	}
	function save(base64) {
		if (typeof base64 !== "string" || !base64 || base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) { return { ok: false, error: "That image could not be attached." }; }
		try {
			folder ??= privateFolder();
			const file = path.join(folder, `${crypto.randomUUID()}.png`);
			fs.writeFileSync(file, Buffer.from(base64, "base64"), { flag: "wx", mode: 0o600 });
			created.add(key(file));
			return { ok: true, path: file };
		} catch { return { ok: false, error: "That image could not be attached." }; }
	}
	function prune(raw, readColdChat, backup = null) {
		if (pruned) { return true; }
		const referenced = new Set(created);
		const keep = (files) => {
			if (files === undefined) { return; }
			if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) { throw new Error("Unreadable image references."); }
			for (const file of files) { referenced.add(key(file)); }
		};
		const messages = (items) => {
			if (!Array.isArray(items)) { throw new Error("Unreadable chat."); }
			for (const item of items) { keep(item.attachments); }
		};
		try {
			for (const saved of [raw, backup]) {
				if (saved === null) { continue; }
				const history = JSON.parse(saved);
				if (!history || !Array.isArray(history.sessions) || history.sessions.some((session) => !session || typeof session.id !== "string" || typeof session.folder !== "string")) { return false; }
				for (const files of Object.values(history.attachments ?? {})) { keep(files); }
				for (const items of Object.values(history.queued ?? {})) { messages(items); }
				for (const items of Object.values(history.extraChats ?? {})) { messages(items); }
				keep(history.newSessionDraft?.attachments);
				for (const session of history.sessions) {
					if (Object.hasOwn(history.extraChats ?? {}, session.id)) { continue; }
					const cold = readColdChat(session.id);
					if (cold === false) { return false; }
					if (cold !== null && cold !== undefined) { messages(JSON.parse(cold)); }
				}
			}
		} catch { return false; }
		pruned = true;
		const owned = (file) => {
			const stat = fs.lstatSync(file);
			return !stat.isSymbolicLink() && (platform === "win32" || stat.uid === process.getuid());
		};
		const sweep = (dir, old) => {
			try {
				if (!owned(dir) || !fs.lstatSync(dir).isDirectory()) { return; }
				for (const name of fs.readdirSync(dir)) {
					const file = path.join(dir, name);
					if (IMAGE_NAME.test(name) && owned(file) && fs.lstatSync(file).isFile() && !referenced.has(key(file))) { fs.rmSync(file); }
				}
				if (old && !fs.readdirSync(dir).length) { fs.rmdirSync(dir); }
			} catch {}
		};
		sweep(path.join(getPath("userData"), "pasted-images"), false);
		const legacy = [];
		const permissionsFile = path.join(getPath("userData"), "pasted-images", "legacy-permissions.json");
		let secured = new Set();
		if (platform === "win32") {
			try {
				const saved = JSON.parse(fs.readFileSync(permissionsFile, "utf8"));
				if (Array.isArray(saved) && saved.every((file) => typeof file === "string")) { secured = new Set(saved); }
			} catch {}
		}
		try {
			for (const name of fs.readdirSync(getPath("temp"))) {
				if (!name.startsWith("grok-code-paste-") || !IMAGE_NAME.test(name.slice("grok-code-paste-".length))) { continue; }
				const file = path.join(getPath("temp"), name);
				if (!owned(file) || !fs.lstatSync(file).isFile()) { continue; }
				const keep = referenced.has(key(file));
				if (platform === "win32") {
					if (!keep || !secured.has(key(file))) { legacy.push({ file, keep }); }
				}
				else if (keep) { fs.chmodSync(file, 0o600); }
				else { fs.rmSync(file); }
			}
		} catch {}
		if (legacy.length) {
			const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const cleanLegacyFiles = `
				$ErrorActionPreference = 'Stop'
				[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
				[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
				$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
				$secured = [System.Collections.Generic.List[string]]::new()
				foreach ($image in (ConvertFrom-Json ([Console]::In.ReadToEnd()))) {
					$security = [System.IO.File]::GetAccessControl($image.file)
					if ($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { continue }
					if ([System.IO.File]::GetAttributes($image.file) -band [System.IO.FileAttributes]::ReparsePoint) { continue }
					if ($image.keep) {
						$acl = [System.Security.AccessControl.FileSecurity]::new()
						$acl.SetAccessRuleProtection($true, $false)
						$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
						[System.IO.File]::SetAccessControl($image.file, $acl)
						$secured.Add($image.file)
					} else { [System.IO.File]::Delete($image.file) }
				}
				[Console]::Out.Write((ConvertTo-Json -InputObject $secured.ToArray() -Compress))
			`;
			const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", cleanLegacyFiles], { input: JSON.stringify(legacy), timeout: 5000, windowsHide: true });
			if (result.status === 0) {
				try {
					const changed = JSON.parse(String(result.stdout));
					if (Array.isArray(changed) && changed.every((file) => typeof file === "string") && changed.length) {
						for (const file of changed) { secured.add(key(file)); }
						folder ??= privateFolder();
						writeAtomic(permissionsFile, [...secured]);
					}
				} catch {}
			}
		}
		const roots = platform === "win32" ? [getPath("userData")] : [...new Set([getPath("userData"), getPath("temp")])];
		for (const root of roots) {
			try {
				for (const name of fs.readdirSync(root)) {
					if (OLD_FOLDER.test(name)) { sweep(path.join(root, name), true); }
				}
			} catch {}
		}
		return true;
	}
	return { save, prune };
}

module.exports = { createPastedImages };
