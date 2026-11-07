import { useRef, useState } from "react";
import { filterSavedPrompts, MAX_PROMPT_NAME, type SavedPrompt } from "./saved-prompts";

export function SavedPromptPicker({ prompts, draft, mode, onSave, onInsert, onClose }: {
	prompts: SavedPrompt[];
	draft: string;
	mode: "save" | "insert";
	onSave: (name: string, text: string) => string;
	onInsert: (text: string) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const [error, setError] = useState("");
	const dialog = useRef<HTMLDivElement>(null);
	const matches = filterSavedPrompts(prompts, query);
	const selected = Math.min(index, Math.max(0, matches.length - 1));
	function insert(prompt: SavedPrompt) {
		onInsert(prompt.text);
		onClose();
	}
	return (
		<div className="overlay" onClick={onClose}>
			<div ref={dialog} className="sheet saved-prompt-dialog" data-saved-prompts-dialog role="dialog" aria-modal="true" aria-label={mode === "save" ? "Save prompt" : "Saved prompts"} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
				if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
				if (event.key === "Tab") {
					const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []);
					const first = controls[0];
					const last = controls[controls.length - 1];
					if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
					if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
				}
			}}>
				<h2>{mode === "save" ? "Save prompt" : "Saved prompts"}</h2>
				{mode === "save" ? (
					<form onSubmit={(event) => {
						event.preventDefault();
						const message = onSave(name, draft);
						setError(message);
						if (!message) { onClose(); }
					}}>
						<label className="saved-prompt-field">Name<input aria-label="Prompt name" autoFocus value={name} maxLength={MAX_PROMPT_NAME} onChange={(event) => { setName(event.target.value); setError(""); }} /></label>
						<pre className="saved-prompt-preview">{draft}</pre>
						{error && <p className="note bad" role="alert">{error}</p>}
						<div className="actions"><button type="submit" className="yes">Save prompt</button><button type="button" onClick={onClose}>Cancel</button></div>
					</form>
				) : (
					<>
						<input className="saved-prompt-search" aria-label="Search saved prompts" role="combobox" aria-expanded="true" aria-controls="saved-prompt-results" aria-activedescendant={matches.length ? `saved-prompt-option-${selected}` : undefined} autoFocus value={query} placeholder="Search names and text" onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const next = matches.length ? (selected + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length : 0;
								setIndex(next);
								dialog.current?.querySelectorAll<HTMLElement>("[role='option']")[next]?.scrollIntoView?.({ block: "nearest" });
							}
							if (event.key === "Enter") { event.preventDefault(); if (matches[selected]) { insert(matches[selected]); } }
						}} />
						<div id="saved-prompt-results" className="saved-prompt-list" role="listbox" aria-label="Saved prompts">
							{matches.map((prompt, offset) => <button key={prompt.id} id={`saved-prompt-option-${offset}`} type="button" role="option" aria-label={prompt.name} aria-selected={offset === selected} className={offset === selected ? "item on" : "item"} onFocus={() => setIndex(offset)} onClick={() => insert(prompt)}><b>{prompt.name}</b><small>{prompt.text}</small></button>)}
							{!matches.length && <p className="meta">{prompts.length ? "No saved prompts match." : "No saved prompts yet. Save your composer text from the + menu."}</p>}
						</div>
						<div className="actions"><button type="button" onClick={onClose}>Cancel</button></div>
					</>
				)}
			</div>
		</div>
	);
}
