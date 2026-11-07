export interface SavedPrompt {
	id: string;
	name: string;
	text: string;
}

export const MAX_SAVED_PROMPTS = 100;
export const MAX_PROMPT_NAME = 80;
export const MAX_PROMPT_TEXT = 32000;

export function promptNameError(prompts: SavedPrompt[], name: string, id?: string): string {
	const trimmed = name.trim();
	if (!trimmed) { return "Enter a name for this prompt."; }
	if (trimmed.length > MAX_PROMPT_NAME) { return `Use ${MAX_PROMPT_NAME} characters or fewer for the name.`; }
	if (prompts.some((prompt) => prompt.id !== id && prompt.name.toLowerCase() === trimmed.toLowerCase())) {
		return "A saved prompt already uses that name.";
	}
	return "";
}

export function normalizeSavedPrompts(value: unknown): SavedPrompt[] {
	if (!Array.isArray(value)) { return []; }
	const prompts: SavedPrompt[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() || item.id.length > 200 || typeof item.name !== "string" || typeof item.text !== "string") { continue; }
		if (ids.has(item.id) || promptNameError(prompts, item.name) || !item.text.trim() || item.text.length > MAX_PROMPT_TEXT) { continue; }
		prompts.push({ id: item.id, name: item.name.trim(), text: item.text });
		ids.add(item.id);
		if (prompts.length === MAX_SAVED_PROMPTS) { break; }
	}
	return prompts;
}

export function filterSavedPrompts(prompts: SavedPrompt[], query: string): SavedPrompt[] {
	const needle = query.trim().toLowerCase();
	return prompts.filter((prompt) => prompt.name.toLowerCase().includes(needle) || prompt.text.toLowerCase().includes(needle));
}

export function insertSavedPrompt(text: string, addition: string, start: number, end: number): { text: string; cursor: number } {
	const from = Math.min(text.length, Math.max(0, Number.isFinite(start) ? Math.trunc(start) : text.length));
	const to = Math.min(text.length, Math.max(from, Number.isFinite(end) ? Math.trunc(end) : from));
	return { text: text.slice(0, from) + addition + text.slice(to), cursor: from + addition.length };
}
