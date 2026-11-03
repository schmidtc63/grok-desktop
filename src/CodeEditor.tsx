import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, keymap } from "@codemirror/view";
import { foldGutter, indentOnInput, syntaxHighlighting, bracketMatching, foldKeymap, indentUnit } from "@codemirror/language";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { classHighlighter } from "@lezer/highlight";
import { describe, indentOf, languageFor, languageNames, PLAIN_TEXT } from "./editor-languages";

export interface CodeEditorProps {
	"aria-label": string;
	file: string;
	value: string;
	readOnly: boolean;
	fileTypes: Record<string, string>;
	language?: string;
	onLanguage: (name: string) => void;
	reveal?: { line: number; tick: number };
	onEdit: (text: string) => void;
}

const setup = [
	lineNumbers(),
	highlightActiveLineGutter(),
	highlightSpecialChars(),
	history(),
	foldGutter(),
	drawSelection(),
	dropCursor(),
	EditorState.allowMultipleSelections.of(true),
	indentOnInput(),
	bracketMatching(),
	closeBrackets(),
	autocompletion(),
	rectangularSelection(),
	crosshairCursor(),
	highlightActiveLine(),
	highlightSelectionMatches(),
	keymap.of([
		...closeBracketsKeymap,
		...defaultKeymap,
		...searchKeymap,
		...historyKeymap,
		...foldKeymap,
		...completionKeymap,
	]),
];

const theme = EditorView.theme({
	"&": { backgroundColor: "var(--input)", color: "var(--text)", fontSize: "12px" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "Consolas, \"Cascadia Mono\", ui-monospace, Menlo, monospace", lineHeight: "19px", overflow: "auto" },
	".cm-content": { padding: "10px 0", caretColor: "var(--accent)" },
	".cm-line": { padding: "0 10px" },
	".cm-gutters": { backgroundColor: "var(--code)", color: "var(--faint)", borderRight: "1px solid var(--line)" },
	".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
	".cm-selectionMatch, .cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)" },
	".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 40%, transparent)", outline: "1px solid var(--accent)" },
	"&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--hover)", outline: "1px solid var(--accent)" },
	"&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--hover)", outline: "1px solid var(--muted)" },
	".cm-foldPlaceholder": { backgroundColor: "var(--code)", color: "var(--muted)", border: "1px solid var(--line)" },
	".cm-panels": { backgroundColor: "var(--code)", color: "var(--text)" },
	".cm-panels-top": { borderBottom: "1px solid var(--line)" },
	".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
	".cm-textfield": { backgroundColor: "var(--input)", color: "var(--text)", border: "1px solid var(--line)" },
	".cm-button": { backgroundColor: "var(--hover)", backgroundImage: "none", color: "var(--text)", border: "1px solid var(--line)" },
	".cm-button:active": { backgroundColor: "var(--input)", backgroundImage: "none" },
	".cm-panel button[name=close]": { color: "var(--muted)" },
	".cm-tooltip": { backgroundColor: "var(--code)", color: "var(--text)", border: "1px solid var(--line)" },
	".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--hover)", color: "var(--text)" },
	".cm-completionDetail": { color: "var(--muted)" },
});

export function CodeEditor(props: CodeEditorProps) {
	const parent = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const readOnly = useRef(new Compartment());
	const indent = useRef(new Compartment());
	const language = useRef(new Compartment());
	const loaded = useRef<{ name: string; support: Extension }>({ name: PLAIN_TEXT, support: [] });
	const loadTick = useRef(0);
	const revealed = useRef<number | undefined>(undefined);
	const name = languageFor(props.file, props.fileTypes, props.language);
	const latest = useRef({ props, name });
	latest.current = { props, name };

	function build(doc: string, head: number): EditorState {
		const current = latest.current;
		return EditorState.create({
			doc,
			selection: { anchor: Math.min(head, doc.length) },
			extensions: [
				setup,
				keymap.of([indentWithTab]),
				syntaxHighlighting(classHighlighter),
				theme,
				EditorView.contentAttributes.of({ "aria-label": current.props["aria-label"] }),
				readOnly.current.of(EditorState.readOnly.of(current.props.readOnly)),
				indent.current.of(indentUnit.of(indentOf(doc, current.name))),
				language.current.of(loaded.current.name === current.name ? loaded.current.support : []),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) { latest.current.props.onEdit(update.state.doc.toString()); }
				}),
			],
		});
	}

	useEffect(() => {
		if (!parent.current) { return; }
		const editor = new EditorView({ state: build(latest.current.props.value, 0), parent: parent.current });
		view.current = editor;
		return () => {
			loadTick.current++;
			view.current = null;
			editor.destroy();
		};
	}, []);

	useLayoutEffect(() => {
		const editor = view.current;
		if (!editor) { return; }
		const next = props.value.replace(/\r\n?/g, "\n");
		if (next !== editor.state.doc.toString()) {
			const scroll = editor.scrollSnapshot();
			editor.setState(build(next, editor.state.selection.main.head));
			editor.dispatch({ effects: scroll });
		}
	});

	useLayoutEffect(() => {
		view.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(props.readOnly)) });
	}, [props.readOnly]);

	useEffect(() => {
		const editor = view.current;
		const request = ++loadTick.current;
		if (!editor) { return; }
		loaded.current = { name, support: [] };
		editor.dispatch({ effects: [indent.current.reconfigure(indentUnit.of(indentOf(editor.state.doc.toString(), name))), language.current.reconfigure([])] });
		if (name !== PLAIN_TEXT) {
			void describe(name)?.load().then((support) => {
				if (request !== loadTick.current || view.current !== editor || latest.current.name !== name) { return; }
				loaded.current = { name, support };
				editor.dispatch({ effects: language.current.reconfigure(support) });
			}).catch(() => {});
		}
		return () => { loadTick.current++; };
	}, [name]);

	useEffect(() => {
		const editor = view.current;
		const reveal = props.reveal;
		if (!editor || !reveal || revealed.current === reveal.tick) { return; }
		const line = editor.state.doc.line(Math.max(1, Math.min(reveal.line, editor.state.doc.lines)));
		editor.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "start" }) });
		editor.focus();
		revealed.current = reveal.tick;
	});

	return (
		<div className="ce-wrap">
			<div className="ce-host" ref={parent} />
			<select className="ce-lang" aria-label="Language" value={name} onChange={(event) => props.onLanguage(event.target.value)}>
				{languageNames.map((item) => <option key={item} value={item}>{item}</option>)}
			</select>
		</div>
	);
}
