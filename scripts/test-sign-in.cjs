const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSignIn } = require("../electron/sign-in.cjs");

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sign-in-"));
const file = path.join(folder, "codex-sign-in.json");
const fakeKey = "test-not-a-key";
const ciphertext = Buffer.from("fake sealed bytes");
let encryptions = 0;
let decryptions = 0;
const storage = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "kwallet",
	encryptString(key) {
		assert.ok(key === fakeKey, "only the test key should reach encryption");
		encryptions++;
		return ciphertext;
	},
	decryptString(buffer) {
		assert.ok(buffer.equals(ciphertext), "decryption receives the decoded ciphertext");
		decryptions++;
		return fakeKey;
	},
};

function provider(platform = "win32", overrides = {}, fileSystem = fs) {
	return createSignIn({ file, platform, fs: fileSystem, safeStorage: { ...storage, ...overrides } });
}

function checkStatus(signIn, expected) {
	const actual = signIn.status();
	assert.ok(Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([name, value]) => actual[name] === value), "status returns only the expected flags");
}

try {
	const signIn = provider();
	checkStatus(signIn, { mode: "grok", hasKey: false, keyReadable: false, keyring: true });
	assert.equal(Object.keys(signIn.grokEnv()).length, 0);
	for (const input of [null, [], { mode: "other" }, { mode: "key" }, { mode: "key", key: "" }, { mode: "key", key: 5 }, { mode: "key", key: "x".repeat(513) }, { mode: "key", key: "two words" }, { mode: "key", key: "two\twords" }, { mode: "key", key: "test\0key" }, { mode: "key", key: fakeKey, baseUrl: "http://example.test" }, { mode: "key", key: fakeKey, baseUrl: "https://user:password@example.test" }]) {
		assert.equal(signIn.check(input).ok, false, "invalid profiles fail validation");
		assert.equal(signIn.save(input).ok, false, "invalid profiles cannot be saved");
	}
	for (const disabled of [provider("win32", { isEncryptionAvailable: () => false }), ...["basic_text", "unknown"].map((backend) => provider("linux", { getSelectedStorageBackend: () => backend }))]) {
		assert.equal(disabled.status().keyring, false);
		const result = disabled.save({ mode: "key", key: fakeKey });
		assert.equal(result.ok, false);
		assert.ok(result.error.includes("Set XAI_API_KEY") && !result.error.includes(fakeKey));
	}
	assert.equal(provider("linux").status().keyring, true);
	let keychainChecks = 0;
	const mac = provider("darwin", { isEncryptionAvailable: () => { keychainChecks++; return true; } });
	checkStatus(mac, { mode: "grok", hasKey: false, keyReadable: false, keyring: true });
	assert.equal(mac.check({ mode: "key", key: fakeKey }).ok, true);
	assert.equal(keychainChecks + decryptions, 0, "macOS status and validation leave the keychain alone until a secret is saved or read");
	assert.equal(encryptions, 0);
	assert.equal(fs.existsSync(file), false, "refusals leave no profile file");
	assert.equal(signIn.check({ mode: "key", key: fakeKey }).ok, true);
	assert.equal(encryptions, 0, "validation does not encrypt or write");
	assert.equal(fs.existsSync(file), false);

	assert.equal(signIn.save({ mode: "key", key: fakeKey }).ok, true);
	const saved = fs.readFileSync(file, "utf8");
	assert.ok(!saved.includes(fakeKey), "the file does not contain the plaintext key");
	const stored = JSON.parse(saved);
	assert.equal(stored.mode, "key");
	assert.ok(stored.key === ciphertext.toString("base64"), "the stored key is the base64 ciphertext");
	checkStatus(signIn, { mode: "key", hasKey: true, keyReadable: true, keyring: true });
	assert.ok(signIn.grokEnv().XAI_API_KEY === fakeKey, "Grok receives the decrypted key in key mode");
	assert.ok(decryptions >= 2);

	const unreadable = provider("win32", { decryptString() { throw new Error(fakeKey); } });
	checkStatus(unreadable, { mode: "key", hasKey: true, keyReadable: false, keyring: true });
	assert.equal(Object.keys(unreadable.grokEnv()).length, 0);
	assert.equal(unreadable.check({ mode: "key" }).ok, false);
	const encryptFailure = provider("win32", { encryptString() { throw new Error(fakeKey); } });
	const failedEncrypt = encryptFailure.save({ mode: "key", key: fakeKey });
	assert.ok(!JSON.stringify(failedEncrypt).includes(fakeKey), "native errors cannot expose the key");
	assert.equal(failedEncrypt.ok, false);
	assert.ok(fs.readFileSync(file, "utf8") === saved, "an encryption failure leaves the previous profile intact");
	const writeFailure = provider("win32", {}, { ...fs, renameSync() { throw new Error(fakeKey); } });
	const failedWrite = writeFailure.removeKey();
	assert.ok(!JSON.stringify(failedWrite).includes(fakeKey), "write errors cannot expose the key");
	assert.equal(failedWrite.ok, false);
	assert.ok(fs.readFileSync(file, "utf8") === saved, "a failed atomic write leaves the previous profile intact");

	assert.equal(signIn.save({ mode: "grok" }).ok, true);
	assert.equal(signIn.status().hasKey, true);
	assert.equal(Object.keys(signIn.grokEnv()).length, 0);
	assert.equal(signIn.save({ mode: "key" }).ok, true);
	assert.equal(encryptions, 1, "a saved key is kept without encrypting it again");
	assert.ok(fs.readFileSync(file, "utf8") === saved);
	assert.ok(signIn.grokEnv().XAI_API_KEY === fakeKey);
	assert.equal(signIn.removeKey().ok, true);
	checkStatus(signIn, { mode: "grok", hasKey: false, keyReadable: false, keyring: true });
	assert.equal(Object.keys(signIn.grokEnv()).length, 0);
	const removed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.ok(removed.mode === "grok" && removed.key === "", "the file no longer holds ciphertext");
	fs.writeFileSync(file, "{");
	checkStatus(signIn, { mode: "grok", hasKey: false, keyReadable: false, keyring: true });
	console.log("PASS sign-in storage: validation, encrypted writes, key reuse and removal, unavailable or unreadable keyring, and atomic failures");
} finally {
	for (const candidate of [file, `${file}.tmp`]) {
		if (fs.existsSync(candidate)) { fs.unlinkSync(candidate); }
	}
	fs.rmdirSync(folder);
}
