const fs = require("fs");
const path = require("path");
const { writeAtomic } = require("../scripts/update-helper.cjs");

// A session id becomes a file name, so anything that could leave the folder is refused.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Chats the renderer moved out of its history value, one JSON file per session.
function createColdChats(dir, fileSystem = fs) {
	const fileOf = (id) => (typeof id === "string" && SESSION_ID.test(id) ? path.join(dir, `${id}.json`) : "");
	return {
		// The file's text, null when there is no file, false when it can't be read.
		read(id) {
			const file = fileOf(id);
			if (!file) { return null; }
			try {
				return fileSystem.readFileSync(file, "utf8");
			} catch (error) {
				return error.code === "ENOENT" ? null : false;
			}
		},
		// True only once the whole chat is on disk.
		write(id, text) {
			const file = fileOf(id);
			if (!file || typeof text !== "string") { return false; }
			try {
				const messages = JSON.parse(text);
				if (!Array.isArray(messages)) { return false; }
				fileSystem.mkdirSync(dir, { recursive: true });
				writeAtomic(file, messages, fileSystem);
				return true;
			} catch {
				return false;
			}
		},
		remove(ids) {
			for (const id of Array.isArray(ids) ? ids : []) {
				const file = fileOf(id);
				if (!file) { continue; }
				// A deleted session stays in the history's deleted list, so the next start retries a file that can't be removed now.
				try {
					fileSystem.rmSync(file, { force: true });
					fileSystem.rmSync(`${file}.tmp`, { force: true });
				} catch {}
			}
		},
	};
}

module.exports = { createColdChats };
