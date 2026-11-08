export function redactKeys(text: string): string {
	return text.replace(/xai-[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
