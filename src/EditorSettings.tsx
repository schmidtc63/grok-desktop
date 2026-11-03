import { fileExtension, languageNames } from "./editor-languages";

export function EditorSettings({ fileTypes, onChange, extension, setExtension, newLanguage, setNewLanguage }: {
	fileTypes: Record<string, string>;
	onChange: (fileTypes: Record<string, string>) => void;
	extension: string;
	setExtension: (value: string) => void;
	newLanguage: string;
	setNewLanguage: (value: string) => void;
}) {
	return (
		<>
			<h3>File types</h3>
			<p className="meta">Each file uses the language its name suggests. Set a language here for an extension, or change one file from the picker in the editor.</p>
			{Object.entries(fileTypes).sort(([a], [b]) => a.localeCompare(b)).map(([ext, language]) => (
				<div className="set-row" key={ext}>
					<b>.{ext}</b>
					<span className="set-inline">
						<select aria-label={`Language for .${ext}`} value={language} onChange={(event) => onChange({ ...fileTypes, [ext]: event.target.value })}>
							{languageNames.map((name) => <option key={name} value={name}>{name}</option>)}
						</select>
						<button type="button" className="texty" onClick={() => {
							const next = { ...fileTypes };
							delete next[ext];
							onChange(next);
						}}>Remove</button>
					</span>
				</div>
			))}
			<div className="set-row">
				<input aria-label="New extension" placeholder=".ext" value={extension} onChange={(event) => setExtension(event.target.value)} />
				<span className="set-inline">
					<select aria-label="New language" value={newLanguage} onChange={(event) => setNewLanguage(event.target.value)}>
						{languageNames.map((name) => <option key={name} value={name}>{name}</option>)}
					</select>
					<button type="button" className="texty" disabled={fileExtension(extension) === null} onClick={() => {
						const ext = fileExtension(extension);
						if (!ext) { return; }
						onChange({ ...fileTypes, [ext]: newLanguage });
						setExtension("");
					}}>Add</button>
				</span>
			</div>
		</>
	);
}
