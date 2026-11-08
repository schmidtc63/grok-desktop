function redactKeys(text) {
	return text.replace(/xai-[A-Za-z0-9_-]{20,}/g, "[redacted]");
}

function heldTail(text) {
	const tail = /x(?:a(?:i(?:-[A-Za-z0-9_-]*)?)?)?$/.exec(text);
	return tail ? [text.slice(0, tail.index), tail[0]] : [text, ""];
}

function redactDeep(value) {
	if (typeof value === "string") { return redactKeys(value); }
	if (Array.isArray(value)) { return value.map(redactDeep); }
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
	}
	return value;
}

module.exports = { redactKeys, redactDeep, heldTail };
