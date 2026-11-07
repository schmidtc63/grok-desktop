const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function harness(name, exportName, props) {
	const state = { cursor: 0, values: [], effects: [], dirty: false };
	const modules = new Map();
	const jsx = (type, attributes, key) => ({ type, props: attributes ?? {}, key });
	const react = {
		Fragment: "fragment",
		createElement: (type, attributes, ...children) => jsx(type, { ...attributes, children: children.length > 1 ? children : children[0] }),
		useState(initial) {
			const index = state.cursor++;
			if (!(index in state.values)) { state.values[index] = { value: typeof initial === "function" ? initial() : initial }; }
			return [state.values[index].value, (next) => {
				const value = typeof next === "function" ? next(state.values[index].value) : next;
				if (!Object.is(value, state.values[index].value)) { state.values[index].value = value; state.dirty = true; }
			}];
		},
		useRef(current) {
			const index = state.cursor++;
			if (!(index in state.values)) { state.values[index] = { current }; }
			return state.values[index];
		},
		useMemo(run, dependencies) {
			const index = state.cursor++;
			const previous = state.values[index];
			if (!previous || dependencies.some((value, offset) => value !== previous.dependencies[offset])) { state.values[index] = { value: run(), dependencies }; }
			return state.values[index].value;
		},
		useEffect(run, dependencies) {
			const index = state.cursor++;
			const previous = state.values[index];
			if (!previous || !dependencies || dependencies.some((value, offset) => value !== previous.dependencies[offset])) {
				state.effects.push(() => { previous?.cleanup?.(); state.values[index] = { dependencies, cleanup: run() }; });
			}
		},
	};
	react.useLayoutEffect = react.useEffect;
	react.useCallback = (run, dependencies) => react.useMemo(() => run, dependencies);
	function load(fileName) {
		if (modules.has(fileName)) { return modules.get(fileName); }
		const file = path.join(__dirname, "..", "src", fileName);
		const source = transformSync(fs.readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
		const module = { exports: {} };
		const imports = (id) => {
			if (id === "react") { return react; }
			if (id === "react/jsx-runtime") { return { jsx, jsxs: jsx, Fragment: "fragment" }; }
			if (id === "./saved-prompts") { return load("saved-prompts.ts"); }
			if (id === "./confirm") { return load("confirm.ts"); }
			throw new Error(`Unexpected import ${id}`);
		};
		vm.runInNewContext(source, { require: imports, module, exports: module.exports, crypto: { randomUUID: () => "new-prompt" } }, { filename: file });
		modules.set(fileName, module.exports);
		return module.exports;
	}
	function flatten(node, output = { elements: [], text: [] }) {
		if (node === null || node === undefined || typeof node === "boolean") { return output; }
		if (Array.isArray(node)) { node.forEach((child) => flatten(child, output)); return output; }
		if (typeof node === "string" || typeof node === "number") { output.text.push(String(node)); return output; }
		if (typeof node.type === "function") { return flatten(node.type(node.props), output); }
		output.elements.push(node);
		return flatten(node.props.children, output);
	}
	const component = name ? load(name)[exportName] : null;
	return {
		load,
		render() {
			let tree;
			for (let pass = 0; pass < 30; pass++) {
				state.cursor = 0;
				state.effects = [];
				state.dirty = false;
				tree = flatten(component(props));
				for (const effect of state.effects) { effect(); }
				if (!state.dirty) { return tree; }
			}
			throw new Error("Saved prompt component did not settle");
		},
		unmount() { for (const value of state.values) { value?.cleanup?.(); } },
	};
}

function labelled(tree, label) {
	const element = tree.elements.find((node) => node.props["aria-label"] === label);
	assert.ok(element, `Missing control: ${label}`);
	return element;
}

function button(tree, label) {
	const element = tree.elements.find((node) => node.type === "button" && node.props.children === label);
	assert.ok(element, `Missing button: ${label}`);
	return element;
}

function press(element, key) {
	let prevented = false;
	element.props.onKeyDown({ key, preventDefault() { prevented = true; }, stopPropagation() {} });
	return prevented;
}

function change(element, value) {
	const target = { value };
	element.props.onChange({ target, currentTarget: target });
}

function submit(tree, index = 0) {
	const form = tree.elements.filter((element) => element.type === "form")[index];
	assert.ok(form, "Missing form");
	form.props.onSubmit({ preventDefault() {} });
}

const examples = [
	{ id: "review", name: "Review diff", text: "Find BUGS in this diff." },
	{ id: "tests", name: "Write tests", text: "Add coverage for this file." },
];

async function main() {
	let failures = 0;
	async function check(label, run) {
		try {
			await run();
			console.log(`PASS saved prompts: ${label}`);
		} catch (error) {
			failures++;
			console.error(`FAIL saved prompts: ${label}`);
			console.error(error);
		}
	}
	const { normalizeSavedPrompts, promptNameError, filterSavedPrompts, insertSavedPrompt } = harness().load("saved-prompts.ts");
	await check("normalizes persisted prompts and rejects malformed records", () => {
		assert.equal(normalizeSavedPrompts(undefined).length, 0);
		assert.equal(normalizeSavedPrompts(null).length, 0);
		const restored = normalizeSavedPrompts([...examples, null, { id: "bad", name: "Broken" }, { id: "blank", name: " ", text: "body" }]);
		assert.deepEqual(Array.from(restored, (entry) => ({ ...entry })), examples);
	});
	await check("rejects blank and duplicate names and allows a prompt to keep its own name", () => {
		assert.ok(promptNameError(examples, ""));
		assert.ok(promptNameError(examples, "   "));
		assert.ok(promptNameError(examples, " review DIFF "));
		assert.equal(promptNameError(examples, "Review diff", "review"), "");
		assert.equal(promptNameError(examples, "New prompt"), "");
	});
	await check("searches both prompt names and text without case sensitivity", () => {
		assert.deepEqual(Array.from(filterSavedPrompts(examples, "review"), (entry) => entry.id), ["review"]);
		assert.deepEqual(Array.from(filterSavedPrompts(examples, "bugs"), (entry) => entry.id), ["review"]);
		assert.deepEqual(Array.from(filterSavedPrompts(examples, "COVERAGE"), (entry) => entry.id), ["tests"]);
		assert.equal(filterSavedPrompts(examples, "missing").length, 0);
		assert.equal(filterSavedPrompts(examples, "").length, 2);
	});
	await check("inserts at the cursor or replaces the selected text, preserving Unicode and newlines", () => {
		for (const [text, addition, start, end, expected, cursor] of [
			["hello", "X", 0, 0, "Xhello", 1],
			["hello", "X", 5, 5, "helloX", 6],
			["hello", "X", 1, 4, "hXo", 2],
			["A😀B", "one\ntwo", 1, 3, "Aone\ntwoB", 8],
			["", "saved text", 0, 0, "saved text", 10],
		]) {
			assert.deepEqual({ ...insertSavedPrompt(text, addition, start, end) }, { text: expected, cursor });
		}
	});
	await check("save dialog validates names and saves the composer text without inserting or sending", () => {
		const saved = [];
		const inserted = [];
		let closed = 0;
		const props = {
			prompts: examples, draft: "Review the current work.\nKeep the scope narrow.", mode: "save",
			onSave(name, text) {
				const error = promptNameError(examples, name);
				if (!error) { saved.push({ name: name.trim(), text }); }
				return error;
			},
			onInsert: (text) => inserted.push(text), onClose() { closed++; },
		};
		const picker = harness("SavedPromptPicker.tsx", "SavedPromptPicker", props);
		let tree = picker.render();
		assert.equal(labelled(tree, "Prompt name").props.autoFocus, true);
		assert.ok(button(tree, "Save prompt"));
		submit(tree);
		assert.equal(saved.length, 0);
		assert.equal(closed, 0);
		assert.ok(picker.render().elements.some((element) => element.props.role === "alert"));
		change(labelled(picker.render(), "Prompt name"), "review DIFF");
		submit(picker.render());
		assert.equal(saved.length, 0);
		assert.equal(closed, 0);
		change(labelled(picker.render(), "Prompt name"), "House rules");
		submit(picker.render());
		assert.deepEqual(saved, [{ name: "House rules", text: props.draft }]);
		assert.equal(closed, 1);
		assert.equal(inserted.length, 0);
		picker.unmount();
	});
	await check("insert picker filters names and bodies and supports ArrowUp, ArrowDown and Enter", () => {
		const inserted = [];
		let closed = 0;
		let saveCalls = 0;
		const props = { prompts: examples, draft: "unsent draft", mode: "insert", onSave() { saveCalls++; return ""; }, onInsert: (text) => inserted.push(text), onClose() { closed++; } };
		const picker = harness("SavedPromptPicker.tsx", "SavedPromptPicker", props);
		let tree = picker.render();
		assert.equal(labelled(tree, "Search saved prompts").props.autoFocus, true);
		assert.ok(tree.elements.some((element) => element.props.role === "listbox" && element.props["aria-label"] === "Saved prompts"));
		assert.equal(tree.elements.filter((element) => element.props.role === "option").length, 2);
		assert.equal(press(labelled(tree, "Search saved prompts"), "ArrowDown"), true);
		tree = picker.render();
		assert.equal(tree.elements.filter((element) => element.props.role === "option")[1].props["aria-selected"], true);
		assert.equal(press(labelled(tree, "Search saved prompts"), "ArrowUp"), true);
		tree = picker.render();
		assert.equal(tree.elements.filter((element) => element.props.role === "option")[0].props["aria-selected"], true);
		change(labelled(tree, "Search saved prompts"), "COVERAGE");
		tree = picker.render();
		assert.equal(tree.elements.filter((element) => element.props.role === "option").length, 1);
		assert.equal(press(labelled(tree, "Search saved prompts"), "Enter"), true);
		assert.deepEqual(inserted, [examples[1].text]);
		assert.equal(closed, 1);
		assert.equal(saveCalls, 0);
		picker.unmount();
	});
	await check("clicking a saved prompt inserts it once and closes the picker", () => {
		const inserted = [];
		let closed = 0;
		const picker = harness("SavedPromptPicker.tsx", "SavedPromptPicker", { prompts: examples, draft: "existing draft", mode: "insert", onSave() { throw new Error("Insert must not save"); }, onInsert: (text) => inserted.push(text), onClose() { closed++; } });
		picker.render().elements.find((element) => element.props.role === "option").props.onClick();
		assert.deepEqual(inserted, [examples[0].text]);
		assert.equal(closed, 1);
		picker.unmount();
	});
	await check("empty search results and Escape never submit the draft", () => {
		let closed = 0;
		let saveCalls = 0;
		const inserted = [];
		const picker = harness("SavedPromptPicker.tsx", "SavedPromptPicker", { prompts: examples, draft: "unsent draft", mode: "insert", onSave() { saveCalls++; return ""; }, onInsert: (text) => inserted.push(text), onClose() { closed++; } });
		change(labelled(picker.render(), "Search saved prompts"), "nothing matches");
		let tree = picker.render();
		assert.equal(tree.elements.filter((element) => element.props.role === "option").length, 0);
		press(labelled(tree, "Search saved prompts"), "Enter");
		assert.equal(closed, 0);
		tree = picker.render();
		assert.equal(press(tree.elements.find((element) => element.props.role === "dialog"), "Escape"), true);
		assert.equal(closed, 1);
		assert.equal(saveCalls, 0);
		assert.equal(inserted.length, 0);
		picker.unmount();
	});
	await check("settings rename and text edits land only on Save changes, and Delete removes only its prompt after a confirm", async () => {
		const changes = [];
		const asks = [];
		const props = { prompts: examples.map((prompt) => ({ ...prompt })), onChange(next) { changes.push(next); props.prompts = next; } };
		const manager = harness("SavedPromptsSettings.tsx", "SavedPromptsSettings", props);
		manager.load("confirm.ts").setConfirmHost((pending) => asks.push(pending));
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		change(labelled(manager.render(), "Name for Review diff"), "Review carefully");
		change(labelled(manager.render(), "Text for Review diff"), "Find actionable bugs.\nExplain the fixes.");
		assert.equal(changes.length, 0);
		submit(manager.render());
		assert.equal(changes.length, 1);
		assert.equal(props.prompts[0].id, "review");
		assert.equal(props.prompts[0].name, "Review carefully");
		assert.equal(props.prompts[0].text, "Find actionable bugs.\nExplain the fixes.");
		assert.equal(labelled(manager.render(), "Text for Review carefully").props.value, props.prompts[0].text);
		labelled(manager.render(), "Delete Write tests").props.onClick();
		assert.equal(asks.length, 1);
		assert.equal(asks[0].title, `Delete "Write tests"?`);
		assert.equal(asks[0].danger, true);
		asks[0].resolve(false);
		await settle();
		assert.equal(changes.length, 1);
		labelled(manager.render(), "Delete Write tests").props.onClick();
		asks[1].resolve(true);
		await settle();
		assert.equal(changes.length, 2);
		assert.deepEqual(Array.from(props.prompts, (prompt) => prompt.id), ["review"]);
		manager.unmount();
	});
	await check("settings reject blank or duplicate names and blank prompt text without changing saved data", () => {
		const changes = [];
		const props = { prompts: examples.map((prompt) => ({ ...prompt })), onChange(next) { changes.push(next); props.prompts = next; } };
		const manager = harness("SavedPromptsSettings.tsx", "SavedPromptsSettings", props);
		for (const name of ["", " WRITE TESTS "]) {
			change(labelled(manager.render(), "Name for Review diff"), name);
			submit(manager.render());
			assert.equal(changes.length, 0);
			assert.ok(manager.render().elements.some((element) => element.props.role === "alert"));
		}
		change(labelled(manager.render(), "Name for Review diff"), "Valid name");
		change(labelled(manager.render(), "Text for Review diff"), " \n ");
		submit(manager.render());
		assert.equal(changes.length, 0);
		assert.equal(props.prompts[0].name, examples[0].name);
		assert.equal(props.prompts[0].text, examples[0].text);
		change(labelled(manager.render(), "Text for Review diff"), "Valid body");
		submit(manager.render());
		assert.equal(changes.length, 1);
		assert.equal(props.prompts[0].name, "Valid name");
		assert.equal(props.prompts[0].text, "Valid body");
		manager.unmount();
	});
	if (failures) { throw new Error(`${failures} saved prompt check(s) failed`); }
	console.log("All saved prompt checks passed");
}

module.exports = main;
if (require.main === module) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
