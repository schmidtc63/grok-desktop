import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { PLAIN_TEXT } from "./editor-defaults";

export { DEFAULT_FILE_TYPES, PLAIN_TEXT } from "./editor-defaults";
export const languageNames: string[] = [PLAIN_TEXT, ...languages.map((language) => language.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))];

export function fileExtension(input: string): string | null {
	const extension = input.trim().toLowerCase().replace(/^\.+/, "");
	return /^[a-z0-9_+-]{1,16}$/.test(extension) ? extension : null;
}

export function describe(name: string): LanguageDescription | null {
	return languages.find((language) => language.name === name) ?? null;
}

export function languageFor(file: string, fileTypes: Record<string, string>, picked?: string): string {
	if (picked && (picked === PLAIN_TEXT || describe(picked))) { return picked; }
	const base = file.split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	const extension = dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
	const configured = dot < 0 ? undefined : fileTypes[extension];
	if (configured && (configured === PLAIN_TEXT || describe(configured))) { return configured; }
	return LanguageDescription.matchFilename(languages, base)?.name
		?? LanguageDescription.matchFilename(languages, dot < 0 ? base : `${base.slice(0, dot + 1)}${extension}`)?.name
		?? PLAIN_TEXT;
}

export function indentOf(text: string, language: string): string {
	// ponytail: infer from leading whitespace; mixed styles use the smallest space indent or the tab majority.
	let tabs = 0;
	let spaces = 0;
	let smallest = 8;
	for (const line of text.split(/\r\n?|\n/)) {
		if (/^\s*\*/.test(line)) { continue; }
		if (line.startsWith("\t")) { tabs += 1; }
		else {
			const count = /^ +/.exec(line)?.[0].length ?? 0;
			if (count) { spaces += 1; smallest = Math.min(smallest, count); }
		}
	}
	if (!tabs && !spaces) { return language === "YAML" ? "  " : "\t"; }
	return tabs >= spaces ? "\t" : " ".repeat(Math.max(2, Math.min(8, smallest)));
}
