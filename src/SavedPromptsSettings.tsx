import { useState } from "react";
import { askConfirm } from "./confirm";
import { MAX_PROMPT_NAME, MAX_PROMPT_TEXT, promptNameError, type SavedPrompt } from "./saved-prompts";

function SavedPromptRow({ prompt, prompts, onChange }: { prompt: SavedPrompt; prompts: SavedPrompt[]; onChange: (prompts: SavedPrompt[]) => void }) {
	const [draft, setDraft] = useState<{ name: string; text: string } | null>(null);
	const [error, setError] = useState("");
	const name = draft?.name ?? prompt.name;
	const text = draft?.text ?? prompt.text;
	const changed = name !== prompt.name || text !== prompt.text;
	return (
		<section className="set-row" aria-label={`Saved prompt ${prompt.name}`}>
			<div style={{ flex: 1 }}>
				<form className="cz-form" onSubmit={(event) => {
					event.preventDefault();
					const issue = promptNameError(prompts, name, prompt.id) || (!text.trim() ? "Enter some prompt text." : text.length > MAX_PROMPT_TEXT ? `Use ${MAX_PROMPT_TEXT.toLocaleString()} characters or fewer for the prompt text.` : "");
					setError(issue);
					if (issue) { return; }
					onChange(prompts.map((item) => item.id === prompt.id ? { ...item, name: name.trim(), text } : item));
					setDraft(null);
				}}>
					<label htmlFor={`saved-prompt-name-${prompt.id}`}>Name</label>
					<input id={`saved-prompt-name-${prompt.id}`} aria-label={`Name for ${prompt.name}`} maxLength={MAX_PROMPT_NAME} value={name} onChange={(event) => { setDraft({ name: event.target.value, text }); setError(""); }} />
					<label htmlFor={`saved-prompt-text-${prompt.id}`}>Prompt text</label>
					<textarea id={`saved-prompt-text-${prompt.id}`} aria-label={`Text for ${prompt.name}`} rows={5} maxLength={MAX_PROMPT_TEXT} value={text} onChange={(event) => { setDraft({ name, text: event.target.value }); setError(""); }} />
					<span />
					<div className="set-inline">
						<button type="submit" className="texty" aria-label={`Save changes to ${prompt.name}`} disabled={!changed}>Save changes</button>
						<button type="button" className="texty" aria-label={`Delete ${prompt.name}`} onClick={() => {
							void askConfirm({ title: `Delete "${prompt.name}"?`, body: `This saved prompt is removed from every window and cannot be restored.`, ok: `Delete`, danger: true }).then((yes) => {
								if (yes) { onChange(prompts.filter((item) => item.id !== prompt.id)); }
							});
						}}>Delete</button>
					</div>
				</form>
				{error && <p className="note" role="alert">{error}</p>}
			</div>
		</section>
	);
}

export function SavedPromptsSettings({ prompts, onChange }: { prompts: SavedPrompt[]; onChange: (prompts: SavedPrompt[]) => void }) {
	return (
		<>
			<h3>Saved prompts</h3>
			<p className="meta">Save a prompt from the composer, then insert it in any session. Changes here apply across the app.</p>
			{prompts.length === 0 && <p className="meta">No saved prompts yet.</p>}
			{prompts.map((prompt) => <SavedPromptRow key={prompt.id} prompt={prompt} prompts={prompts} onChange={onChange} />)}
		</>
	);
}
