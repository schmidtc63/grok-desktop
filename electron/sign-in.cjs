const path = require("node:path");
const { writeAtomic } = require("../scripts/update-helper.cjs");

const NO_KEYRING = "This computer has no keyring the app can use, so the key can't be saved. Set XAI_API_KEY in your environment instead.";

function validKey(key) {
	return typeof key === "string" && key.length >= 1 && key.length <= 512 && !/\s/.test(key) && !key.includes("\0");
}

// ponytail: use synchronous safeStorage so Grok spawns stay synchronous. Move to async storage when spawn preparation can await it.
function keyringAvailable(safeStorage, platform) {
	// macOS always has a keychain, and asking opens it: an ad hoc signed update would then wait behind a keychain password prompt before its window opens.
	// So only a real save or read of a stored secret touches it.
	if (platform === "darwin") { return true; }
	try {
		if (!safeStorage.isEncryptionAvailable()) { return false; }
		if (platform !== "linux") { return true; }
		const backend = safeStorage.getSelectedStorageBackend();
		return backend !== "basic_text" && backend !== "unknown";
	} catch { return false; }
}

function decrypt(ciphertext, safeStorage, platform, available = keyringAvailable(safeStorage, platform)) {
	if (!ciphertext || !available) { return ""; }
	try {
		const key = safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
		return validKey(key) ? key : "";
	} catch { return ""; }
}

function createSignIn({ file, safeStorage, platform, fs }) {
	function read() {
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8"));
			if ((value?.mode === "grok" || value?.mode === "key") && typeof value.key === "string") { return value; }
		} catch {}
		return { mode: "grok", key: "" };
	}

	function check(input) {
		if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) => field !== "mode" && field !== "key") || (input.mode !== "grok" && input.mode !== "key")) {
			return { ok: false, error: "Choose Grok sign-in or an xAI API key." };
		}
		if (input.key !== undefined) {
			if (!validKey(input.key)) { return { ok: false, error: "Enter an API key of 1 to 512 characters with no spaces." }; }
			if (!keyringAvailable(safeStorage, platform)) { return { ok: false, error: NO_KEYRING }; }
		} else if (input.mode === "key" && !decrypt(read().key, safeStorage, platform)) {
			return { ok: false, error: "Enter an API key to use API-key mode." };
		}
		return { ok: true };
	}

	function write(mode, key) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeAtomic(file, { mode, key }, fs);
			return { ok: true };
		} catch { return { ok: false, error: "The sign-in choice couldn't be saved." }; }
	}

	function save(input) {
		const checked = check(input);
		if (!checked.ok) { return checked; }
		let ciphertext;
		try {
			ciphertext = input.key === undefined ? read().key : safeStorage.encryptString(input.key).toString("base64");
		} catch { return { ok: false, error: "The API key couldn't be encrypted." }; }
		return write(input.mode, ciphertext);
	}

	function removeKey() {
		return write("grok", "");
	}

	function status() {
		const { mode, key } = read();
		const keyring = keyringAvailable(safeStorage, platform);
		return { mode, hasKey: Boolean(key), keyReadable: Boolean(decrypt(key, safeStorage, platform, keyring)), keyring };
	}

	function grokEnv() {
		const profile = read();
		const key = profile.mode === "key" ? decrypt(profile.key, safeStorage, platform) : "";
		return key ? { XAI_API_KEY: key } : {};
	}

	return { check, save, removeKey, status, grokEnv };
}

module.exports = { createSignIn, decrypt, keyringAvailable, validKey };
