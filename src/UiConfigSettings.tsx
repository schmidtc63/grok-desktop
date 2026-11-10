import { useEffect, useId, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import { diagramTheme } from "./markdown-diagram";
import type { AppSettings } from "./Settings";
import {
	applyUiConfig, contrastWarning, installedFontNames, LOCAL_FONT, MAX_UI_CONFIGS, setUiValues, tokenContrastWarnings, UI_FONTS, UI_SECTIONS, UI_WEIGHTS, uiColorHex,
	uiConfigCss, uiConfigNameError, uiKeys, uiSampleSelector, type UiControl, type UiElement, type UiTheme, type UiValues,
} from "./ui-config";
import { UI_SAMPLES } from "./UiConfigSamples";

const startingValues = new Map<string, UiValues>();
const emptyValues: UiValues = {};
let lastSave: boolean | null = null;

interface ControlProps {
	control: UiControl;
	input: {
		"aria-label": string;
		disabled: boolean;
		"data-ui-target": string;
		"data-ui-css": string;
		"data-ui-kind": UiControl["kind"];
	};
	stored?: string | number;
	computed: string;
	installed: string[] | null;
	onCommit: (value: string | number | undefined) => void;
	onPreview: (value: string | undefined) => void;
}

function NumberControl({ control, input, stored, computed, onCommit }: ControlProps) {
	const [draft, setDraft] = useState<string | null>(null);
	const rule = useId();
	useEffect(() => { setDraft(null); }, [stored]);
	const text = draft ?? (stored === undefined ? "" : String(stored));
	const number = /^\d+$/.test(text) ? Number(text) : NaN;
	const invalid = draft !== null && !(number >= control.min! && number <= control.max!);
	return (
		<>
			<input {...input} type="text" inputMode="numeric" placeholder={computed.replace(/px$/, "") || "Default"}
				value={text} aria-invalid={invalid || undefined} aria-describedby={invalid ? rule : undefined}
				onChange={(event) => {
					const next = event.currentTarget.value;
					setDraft(next);
					const value = /^\d+$/.test(next) ? Number(next) : NaN;
					if (value >= control.min! && value <= control.max! && value !== stored) { onCommit(value); }
				}} />
			{invalid && <small className="note bad" id={rule} role="status">Use a whole number from {control.min} to {control.max}.</small>}
		</>
	);
}

function ColorControl({ input, stored, computed, onCommit, onPreview }: ControlProps) {
	const start = (typeof stored === "string" ? stored : uiColorHex(computed)) ?? "#808080";
	const [color, setColor] = useState(start);
	const picker = useRef<HTMLInputElement>(null);
	const changed = useRef(false);
	const callbacks = useRef({ onCommit, onPreview });
	callbacks.current = { onCommit, onPreview };
	useEffect(() => { changed.current = false; setColor(start); }, [start]);
	useEffect(() => {
		const node = picker.current;
		if (!node) { return; }
		const commit = () => {
			if (!changed.current) { return; }
			changed.current = false;
			callbacks.current.onCommit(node.value);
		};
		node.addEventListener("change", commit);
		return () => {
			node.removeEventListener("change", commit);
			if (changed.current) { callbacks.current.onPreview(undefined); }
		};
	}, []);
	return (
		<>
			<input {...input} ref={picker} type="color" value={color} onInput={(event) => {
				const value = event.currentTarget.value;
				setColor(value);
				changed.current = value !== start;
				onPreview(changed.current ? value : undefined);
			}} />
			{stored === undefined && <small>Default</small>}
		</>
	);
}

export function UiValueControl(props: ControlProps) {
	const { control, input, stored, installed, onCommit } = props;
	if (control.kind === "px" || control.kind === "percent") { return <NumberControl {...props} />; }
	if (control.kind === "color") { return <ColorControl {...props} />; }
	const savedFont = typeof stored === "string" && stored.startsWith(LOCAL_FONT) ? stored.slice(LOCAL_FONT.length) : "";
	return (
		<select aria-label={input["aria-label"]} disabled={input.disabled} value={stored ?? ""}
			data-ui-target={input["data-ui-target"]} data-ui-css={input["data-ui-css"]} data-ui-kind={control.kind}
			onChange={(event) => {
				const value = event.currentTarget.value;
				onCommit(value === "" ? undefined : control.kind === "weight" ? Number(value) : value);
			}}>
			<option value="">Default</option>
			{control.kind === "font"
				? Object.entries(UI_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)
				: UI_WEIGHTS.map((weight) => <option key={weight}>{weight}</option>)}
			{savedFont && !installed?.includes(savedFont) && <option value={stored}>{installed ? `${savedFont} (not on this computer)` : savedFont}</option>}
			{control.kind === "font" && !!installed?.length && (
				<optgroup label="Installed on this computer">
					{installed.map((family) => <option key={family} value={`${LOCAL_FONT}${family}`}>{family}</option>)}
				</optgroup>
			)}
		</select>
	);
}

function sampleValue(sample: HTMLElement, element: UiElement, control: UiControl) {
	const node = document.querySelector(uiSampleSelector(element, control));
	if (!node || (node !== sample && !sample.contains(node))) { return ""; }
	const style = getComputedStyle(node);
	if (control.css === "border-color") {
		const side = ["top", "right", "bottom", "left"].find((edge) => parseFloat(style.getPropertyValue(`border-${edge}-width`)) > 0);
		if (side) { return style.getPropertyValue(`border-${side}-color`); }
	}
	const value = style.getPropertyValue(control.css).trim();
	if (control.kind === "percent") { return String(Math.round(Number(value) * 100)); }
	if (!value.endsWith("px") && control.kind === "px" && control.css.startsWith("--")) {
		const consumer = node.querySelector(".tp-out, .ui-sample-editor, .message-text, .md") ?? node;
		const computed = getComputedStyle(consumer);
		return control.key === "size" ? computed.fontSize : computed.lineHeight;
	}
	return value;
}

export function UiConfigSettings({ settings, onChange, onPeek, previewTheme, onPreviewTheme }: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => boolean;
	onPeek: (show: boolean) => void;
	previewTheme: UiTheme | null;
	onPreviewTheme: (theme: UiTheme | null) => void;
}) {
	const current = useRef(settings);
	current.current = settings;
	const { uiConfigs, activeUiConfig } = settings;
	const active = uiConfigs.find(({ id }) => id === activeUiConfig);
	const values = active?.values ?? emptyValues;
	const [sectionId, setSectionId] = useState<string>(UI_SECTIONS[0].id);
	const [elementId, setElementId] = useState("");
	const [naming, setNaming] = useState<{ id: string; text: string } | null>(null);
	const [nameError, setNameError] = useState("");
	const [saved, setSaved] = useState(() => lastSave);
	const [resetVersion, setResetVersion] = useState(0);
	const [computed, setComputed] = useState<Record<string, string>>({});
	const [warnings, setWarnings] = useState<string[]>([]);
	const [installedFonts, setInstalledFonts] = useState<string[] | null>(null);
	const preview = useRef<HTMLDivElement>(null);
	const theme = previewTheme ?? (diagramTheme() === "dark" ? "dark" : "light");
	const section = UI_SECTIONS.find(({ id }) => id === sectionId);
	const element = section?.elements.find(({ id }) => id === elementId);
	const Sample = section ? UI_SAMPLES[section.id] : undefined;
	const outline = element && section?.id !== "app" ? uiSampleSelector(element) : "";

	useEffect(() => {
		onPreviewTheme(diagramTheme() === "dark" ? "dark" : "light");
		const stopPeek = () => onPeek(false);
		window.addEventListener("blur", stopPeek);
		return () => {
			window.removeEventListener("blur", stopPeek);
			stopPeek();
			onPreviewTheme(null);
		};
	}, [onPeek, onPreviewTheme]);
	useEffect(() => {
		// Without the list, Font still offers the standard fonts.
		window.queryLocalFonts?.().then((fonts) => setInstalledFonts(installedFontNames(fonts))).catch(() => {});
	}, []);
	useEffect(() => {
		if (active && !startingValues.has(active.id)) { startingValues.set(active.id, active.values); }
	}, [active]);
	useEffect(() => {
		if (outline) { document.querySelector(outline)?.scrollIntoView({ block: "nearest" }); }
	}, [outline]);
	useEffect(() => {
		const sample = preview.current;
		if (!sample) { return; }
		setComputed(element ? Object.fromEntries(element.controls.map((control) => [control.key, sampleValue(sample, element, control)])) : {});
		if (section?.id === "app") {
			setWarnings(tokenContrastWarnings(sample));
		} else if (element && !element.noText && element.controls.some(({ css }) => css === "color" || css === "background-color" || css === "--bubble" || css === "--code" || css === "--code-text")) {
			const target = document.querySelector(uiSampleSelector(element));
			const warning = target ? contrastWarning(target) : "";
			setWarnings(warning ? [warning] : []);
		} else {
			setWarnings([]);
		}
	}, [element, section, values, previewTheme]);

	function save(patch: Partial<AppSettings>) {
		lastSave = onChange(patch);
		setSaved(lastSave);
	}

	function saveName(event: React.FormEvent) {
		event.preventDefault();
		if (!naming) { return; }
		const { uiConfigs: configs, activeUiConfig: selected } = current.current;
		const name = naming.text.trim();
		const error = uiConfigNameError(configs, name, naming.id || undefined);
		if (error) { setNameError(error); return; }
		if (naming.id) {
			if (configs.some(({ id }) => id === naming.id)) {
				save({ uiConfigs: configs.map((config) => config.id === naming.id ? { ...config, name } : config) });
			}
		} else {
			if (configs.length >= MAX_UI_CONFIGS) { setNameError(`You can save up to ${MAX_UI_CONFIGS} configurations.`); return; }
			const id = crypto.randomUUID();
			const copy = { ...configs.find((config) => config.id === selected)?.values };
			save({ uiConfigs: [...configs, { id, name, values: copy }], activeUiConfig: id });
		}
		setNaming(null);
	}

	async function deleteConfig(id: string, name: string) {
		const confirmed = await askConfirm({
			title: `Delete "${name}"?`, body: "This configuration is removed from every window and cannot be restored.",
			ok: "Delete", danger: true,
		});
		if (!confirmed) { return; }
		const latest = current.current;
		if (!latest.uiConfigs.some((config) => config.id === id)) { return; }
		startingValues.delete(id);
		save({
			uiConfigs: latest.uiConfigs.filter((config) => config.id !== id),
			...(latest.activeUiConfig === id ? { activeUiConfig: "" } : {}),
		});
	}

	function editValues(id: string, edit: (previous: UiValues) => UiValues) {
		const configs = current.current.uiConfigs;
		const config = configs.find((entry) => entry.id === id);
		if (config) { save({ uiConfigs: setUiValues(configs, id, edit(config.values)) }); }
	}

	function removeValues(id: string, keys: string[]) {
		editValues(id, (previous) => {
			const next = { ...previous };
			for (const key of keys) { delete next[key]; }
			return next;
		});
	}

	function resetValues(id: string, keys: string[]) {
		removeValues(id, keys);
		setResetVersion((version) => version + 1);
	}

	function selectControl(sectionLabel: string, item: UiElement, control: UiControl) {
		const keys = uiKeys(item, control);
		const key = keys[control.kind === "color" && theme === "dark" ? 1 : 0];
		const stored = values[key];
		const input = {
			"aria-label": `${sectionLabel}: ${item.label}: ${control.label}`,
			disabled: !active, "data-ui-target": uiSampleSelector(item, control), "data-ui-css": control.css, "data-ui-kind": control.kind,
		};
		return (
			<div className="set-row ui-control" key={key}>
				<b>{control.label}</b>
				<div className="set-inline">
					<UiValueControl key={`${activeUiConfig}:${resetVersion}`} control={control} input={input} stored={stored} computed={computed[control.key] ?? ""} installed={installedFonts}
						onCommit={(value) => {
							if (!active) { return; }
							if (value === undefined) { removeValues(active.id, [key]); }
							else { editValues(active.id, (previous) => ({ ...previous, [key]: value })); }
						}}
						onPreview={(value) => {
							const latest = current.current;
							const storedValues = latest.uiConfigs.find(({ id }) => id === latest.activeUiConfig)?.values ?? emptyValues;
							applyUiConfig(uiConfigCss(value === undefined || latest.activeUiConfig !== active?.id ? storedValues : { ...storedValues, [key]: value }));
						}} />
					<button className="texty" type="button" disabled={!active} aria-label={`Reset ${input["aria-label"]}`}
						onClick={() => { if (active) { resetValues(active.id, [key]); } }}>Reset</button>
				</div>
			</div>
		);
	}

	return (
		<div className="ui-split">
			<div className="settings-body">
				<h3>UI Configuration</h3>
				<p className="meta">Change fonts, sizes and colors. A configuration applies to every window.</p>
				<div className="ui-tools">
					<label htmlFor="ui-config-choice">Configuration</label>
					<select id="ui-config-choice" value={activeUiConfig} onChange={(event) => {
						setNaming(null);
						save({ activeUiConfig: event.currentTarget.value });
					}}>
						<option value="">Default</option>
						{uiConfigs.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
					</select>
					<button className="texty" type="button" disabled={uiConfigs.length >= MAX_UI_CONFIGS} onClick={() => { setNaming({ id: "", text: "" }); setNameError(""); }}>New…</button>
					<button className="texty" type="button" disabled={!active} onClick={() => {
						if (active) { setNaming({ id: active.id, text: active.name }); setNameError(""); }
					}}>Rename…</button>
					<button className="texty" type="button" disabled={!active} onClick={() => {
						if (active) { void deleteConfig(active.id, active.name); }
					}}>Delete</button>
					<span className={saved === false ? "set-status bad" : "set-status"} role="status">
						{saved === true ? "Saved" : saved === false ? "Not saved." : ""}
					</span>
					{saved === false && <button className="texty" type="button" onClick={() => save({
						uiConfigs: current.current.uiConfigs, activeUiConfig: current.current.activeUiConfig,
					})}>Try again</button>}
				</div>
				{uiConfigs.length >= MAX_UI_CONFIGS && <p className="note">You can save up to {MAX_UI_CONFIGS} configurations.</p>}
				{!active && <p className="meta">Default is the built-in look and can't be changed. Choose New… to start a configuration.</p>}
				{naming && (
					<form className="cz-form" aria-label="Configuration name" onSubmit={saveName}>
						<label htmlFor="ui-config-name">Name</label>
						<input id="ui-config-name" autoFocus value={naming.text} aria-invalid={!!nameError} aria-describedby={nameError ? "ui-config-name-error" : undefined}
							onChange={(event) => { setNaming({ ...naming, text: event.currentTarget.value }); setNameError(""); }} />
						<div className="ui-tools ui-name-actions">
							<button className="texty" type="submit">{naming.id ? "Save name" : "Create"}</button>
							<button className="texty" type="button" onClick={() => setNaming(null)}>Cancel</button>
						</div>
						{nameError && <p id="ui-config-name-error" className="note bad ui-name-actions" role="alert">{nameError}</p>}
					</form>
				)}
				<div className="ui-tools">
					<label htmlFor="ui-config-theme">Preview theme</label>
					<select id="ui-config-theme" value={theme} onChange={(event) => onPreviewTheme(event.currentTarget.value === "light" ? "light" : "dark")}>
						<option value="light">Light</option><option value="dark">Dark</option>
					</select>
					<button className="texty" type="button" disabled={!active} onClick={() => {
						if (!active) { return; }
						const start = startingValues.get(active.id);
						if (start) { editValues(active.id, () => start); setResetVersion((version) => version + 1); }
					}}>Revert</button>
					<button className="texty ui-peek" type="button"
						onPointerDown={(event) => {
							if (event.button !== 0) { return; }
							event.currentTarget.setPointerCapture(event.pointerId);
							onPeek(true);
						}}
						onPointerUp={() => onPeek(false)} onPointerCancel={() => onPeek(false)} onLostPointerCapture={() => onPeek(false)}
						onBlur={() => onPeek(false)}
						onKeyDown={(event) => {
							if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (!event.repeat) { onPeek(true); } }
						}}
						onKeyUp={(event) => {
							if (event.key === " " || event.key === "Enter") { event.preventDefault(); onPeek(false); }
						}}>Hold to see the app</button>
				</div>
				<p className="meta">Changes this window until you leave this page. Your Appearance setting stays as it is. Colors are kept separately for light and dark.</p>
				<p className="meta">If a configuration makes the app hard to read, choose View &gt; Use Default UI. Press Alt if the menu is hidden.</p>
				{!!installedFonts?.length && <p className="meta">Font also lists the fonts installed on this computer. After you install a font, restart the app to see it.</p>}
				{UI_SECTIONS.map((group) => {
					const keys = group.elements.flatMap((item) => item.controls.flatMap((control) => uiKeys(item, control)));
					const count = keys.filter((key) => Object.hasOwn(values, key)).length;
					return (
						<details className="ui-section" name="ui-section" key={group.id} open={group.id === sectionId}
							onToggle={(event) => {
								if (event.currentTarget.open) { setSectionId(group.id); }
								else { setSectionId((id) => id === group.id ? "" : id); }
							}}>
							<summary>{group.label}{count > 0 && <span className="meta"> {count} changed</span>}</summary>
							{group.help && <p className="meta">{group.help}</p>}
							<button className="texty ui-section-reset" type="button" disabled={!active} onClick={() => {
								if (active) { resetValues(active.id, keys); }
							}}>Reset section</button>
							{group.elements.map((item) => {
								const selected = item === element;
								const changed = item.controls.some((control) => uiKeys(item, control).some((key) => Object.hasOwn(values, key)));
								return (
									<details className="ui-element" name={`ui-element-${group.id}`} key={item.id} open={selected}
										onToggle={(event) => {
											if (event.currentTarget.open) { setElementId(item.id); }
											else { setElementId((id) => id === item.id ? "" : id); }
										}}>
										<summary>{item.label}{changed && <span className="ct-dot on" role="img" aria-label="Changed" />}</summary>
										{selected && item.controls.map((control) => selectControl(group.label, item, control))}
										{selected && section?.id !== "app" && warnings.map((warning) => <p className="note bad" key={warning} role="status">{warning}</p>)}
									</details>
								);
							})}
							{group === section && group.id === "app" && warnings.map((warning) => <p className="note bad" key={warning} role="status">{warning}</p>)}
						</details>
					);
				})}
			</div>
			<div className="ui-preview" role="region" aria-label="Sample" tabIndex={0} ref={preview}>
				<div className="ui-preview-sample" inert aria-hidden="true">
					{outline && <style>{`${outline} { outline: 2px solid var(--accent); outline-offset: -2px; }`}</style>}
					{Sample && <Sample />}
				</div>
			</div>
		</div>
	);
}
