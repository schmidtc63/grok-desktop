const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { transformSync } = require("esbuild");

const src = path.join(__dirname, "../src");
const read = (file) => fs.readFileSync(path.join(src, file), "utf8");
const compiled = transformSync(read("ui-config.ts"), { loader: "ts", format: "cjs" }).code;
const catalogModule = { exports: {} };
new Function("module", "exports", compiled)(catalogModule, catalogModule.exports);
const {
	UI_SECTIONS, uiKeys, uiConfigCss, normalizeUiConfigs, uiConfigNameError, setUiValues,
	uiSampleSelector, uiColorHex, contrastRatio, installedFontNames,
} = catalogModule.exports;

assert.deepEqual(UI_SECTIONS.map(({ id }) => id), [
	"app", "sidebar", "title", "chat", "composer", "rail", "panes", "changes", "files",
	"terminal", "browser", "tasks", "menus", "new",
]);
const elements = UI_SECTIONS.flatMap((section) => section.elements);
const elementIds = elements.map(({ id }) => id);
assert.equal(new Set(elementIds).size, elementIds.length);
const keys = elements.flatMap((element) => element.controls.flatMap((control) => uiKeys(element, control)));
assert.equal(new Set(keys).size, keys.length);

const sources = fs.readdirSync(src).filter((file) => /\.(css|tsx)$/.test(file) && file !== "UiConfigSamples.tsx").map(read).join("\n");
const samples = [...read("UiConfigSamples.tsx").matchAll(/\bclassName="([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/));
const classes = (selector) => [...selector.matchAll(/\.([-\w]+)/g)].map((match) => match[1]);
for (const element of elements) {
	const selectors = [...element.selector, ...element.controls.flatMap((control) => control.selector ?? [])];
	for (const selector of selectors) {
		assert.doesNotMatch(selector, /::[-\w]+(?:\([^)]*\))?$/, selector);
		for (const name of classes(selector)) {
			assert.match(sources, new RegExp("(?<![-\\w])" + name + "(?![-\\w])"), selector);
		}
	}
	const sampleSelectors = element.sample ? [element.sample] : element.selector;
	for (const name of sampleSelectors.flatMap(classes)) {
		assert.ok(samples.includes(name), element.id + " sample needs ." + name);
	}
}
assert.ok(!samples.includes("pop"), "the sample must not enter App's menu search");
console.log("PASS UI configuration inventory: unique keys and valid app and sample classes");

const selectorsOf = (match) => elements.flatMap((element) => {
	const control = element.controls.find(match);
	return control ? control.selector ?? element.selector : [];
});
const sizeSelectors = selectorsOf(({ key }) => key === "size");
const fontSelectors = selectorsOf(({ kind }) => kind === "font");
const noFontControl = new Set([".cmd", ".ctx", ".term", ".context-preview", ".set-rules .set-row b"]);
const noSizeControl = new Set([
	":root", ".settings-page", ".ui-preview", ".pane-x", ".chat-empty::after",
	".settings-nav h2", ".settings-body h3", ".set-status", ".ct-header h2", ".ct-group-heading", ".ct-catalog h3",
	".mark", ".brand h1", ".brand p", ".status-filters button", ".side-tabs button", ".session-title strong", ".session-title span", ".msg .who", ".side-log .who", ".money", ".context-preview", ".code",
]);
for (const file of ["styles.css", "diff-files.css", "terminal-browser.css", "grok-bot.css"]) {
	const sheet = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
	for (const [, selectors, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const parts = selectors.split(",").map((part) => part.trim().replace(/\s+/g, " "));
		if (/(?:^|[\s;])font-family:\s*var\(--(?:mono|display)-font\)/.test(body)) {
			for (const selector of parts) {
				assert.ok(noFontControl.has(selector) || fontSelectors.some((entry) => entry.includes(selector)), `${selector} in ${file} needs a Font control`);
			}
		}
		const fontSize = /(?:^|[\s;])font-size:\s*([^;}]+)/.exec(body)?.[1].trim();
		if (!fontSize || fontSize === "inherit") { continue; }
		assert.match(fontSize, /--(?:text|mono|display)-scale/, `${selectors.trim()} in ${file} must follow a Whole app size`);
		if (/--(?:editor|terminal)-font-size/.test(fontSize)) { continue; }
		for (const selector of parts) {
			assert.ok(noSizeControl.has(selector) || sizeSelectors.some((entry) => entry.includes(selector)), `${selector} in ${file} needs a Text size control`);
		}
	}
}
for (const element of elements.filter(({ controls }) => controls.some(({ key }) => key === "size"))) {
	assert.ok(element.controls.some(({ kind }) => kind === "font"), `${element.id} has a Text size and needs a Font`);
}
console.log("PASS UI configuration text sizes: every fixed size follows a Whole app size, a Text size control reaches it, and each of those rows has a Font");

assert.equal(uiConfigCss({}), "");
const example = {
	"chat.reply.size": 16,
	"chat.userBubble.background.dark": "#112233",
	"app.backgrounds.bg.light": "#ffffff",
	"app.fonts.mono": "cascadia",
};
const css = uiConfigCss(example);
assert.equal(css, [
	':root, .ui-preview { --mono-font: "Cascadia Mono", Consolas, ui-monospace, Menlo, monospace; }',
	':root[data-theme="light"], :root[data-theme="light"] .ui-preview { --bg: #ffffff; }',
	"@media (prefers-color-scheme: light) { :root:not([data-theme]), :root:not([data-theme]) .ui-preview { --bg: #ffffff; } }",
	':where(:root[data-theme="dark"]) .user-bubble:where(:not(.settings-nav *, .settings-body *)) { --bubble: #112233; }',
	"@media (prefers-color-scheme: dark) { :where(:root:not([data-theme])) .user-bubble:where(:not(.settings-nav *, .settings-body *)) { --bubble: #112233; } }",
	".msg.grok > .md:where(:not(.settings-nav *, .settings-body *)) { font-size: 16px; }",
].join("\n"));
assert.ok(!css.includes("!important"));

const overlapping = {
	"changes.added.size": 24, "changes.added.font": "arial", "changes.removed.size": 25, "changes.removed.font": "tahoma", "changes.line.size": 14, "changes.line.font": "georgia",
	"chat.tableHead.size": 18, "chat.tableHead.font": "arial", "chat.table.size": 12, "chat.table.font": "georgia",
};
const overlappingCss = uiConfigCss(overlapping);
assert.equal(uiConfigCss(Object.fromEntries(Object.entries(overlapping).reverse())), overlappingCss, "the order values were saved in doesn't change the rules");
for (const [broad, narrow] of [[".dp-line", ".dp-add"], [".dp-line", ".dp-del"], [".md-table :is(th, td)", ".md-table th:"]]) {
	assert.ok(overlappingCss.lastIndexOf(broad) < overlappingCss.indexOf(narrow), `${narrow} must follow ${broad}, because they tie on specificity`);
}

const hostile = {
	"chat.userBubble.background.dark": "red;}body{display:none}",
	"app.backgrounds.bg.light": "#112233\n",
	"app.fonts.mono": "constructor",
	"chat.reply.size": 9999,
	"chat.reply.lineHeight": 19.5,
	"chat.h1.weight": NaN,
	"unknown.key": 10,
};
assert.equal(uiConfigCss(hostile), "");
assert.deepEqual(normalizeUiConfigs([{ id: "a", name: "Sample", values: hostile }]), [{ id: "a", name: "Sample", values: {} }]);
assert.deepEqual(normalizeUiConfigs(null), []);
assert.equal(uiConfigCss({ "app.fonts.textScale": 125 }), ":root, .ui-preview { --text-scale: 1.25; }");
for (const value of [79, 201, 100.5, "150"]) {
	assert.equal(uiConfigCss({ "app.fonts.monoScale": value }), "");
}

for (const key of ["app.fonts.mono", "files.editor.font", "terminal.text.font"]) {
	assert.match(uiConfigCss({ [key]: "local:Fira Code" }), /: "Fira Code", Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace; }$/, `${key} falls back to a code font`);
}
for (const key of ["app.fonts.text", "app.fonts.display", "chat.reply.font"]) {
	assert.match(uiConfigCss({ [key]: "local:O'Neil Sans" }), /: "O'Neil Sans", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }$/, `${key} falls back to a standard font`);
}
assert.notEqual(uiConfigCss({ "app.fonts.text": "local:ＭＳ ゴシック" }), "", "a family name can use any language");
for (const family of ['x"; } body { display: none } /*', "x\\", "x\nbody{}", "x\u0085", "x}", "x;", "x<style", "", "y".repeat(121)]) {
	assert.equal(uiConfigCss({ "app.fonts.mono": `local:${family}` }), "", `reject ${JSON.stringify(family)}`);
}
assert.deepEqual(normalizeUiConfigs([{ id: "a", name: "Sample", values: { "app.fonts.mono": 'local:x"', "chat.reply.font": "local:Hasklig" } }])[0].values, { "chat.reply.font": "local:Hasklig" });
assert.deepEqual(
	installedFontNames([{ family: "Hasklig" }, { family: "Fira Code" }, { family: "Fira Code" }, { family: 'Bad"Name' }]),
	["Fira Code", "Hasklig"],
);
assert.deepEqual(normalizeUiConfigs([
	{ id: "a", name: " Sample ", values: example },
	{ id: "a", name: "Another", values: {} },
	{ id: "b", name: "sAmPlE", values: {} },
	{ id: "c", name: " DeFaUlT ", values: {} },
	{ id: "d", name: " ", values: {} },
	{ id: "e", name: "x".repeat(81), values: {} },
	{ id: "", name: "Missing id", values: {} },
]), [{ id: "a", name: "Sample", values: example }]);
assert.equal(normalizeUiConfigs(Array.from({ length: 51 }, (_, id) => ({ id: String(id), name: "Name " + id, values: {} }))).length, 50);

const renamed = [{ id: "a", name: "Renamed", values: {} }];
assert.equal(uiConfigNameError(renamed, "renamed", "a"), "");
assert.notEqual(uiConfigNameError(renamed, "renamed"), "");
assert.equal(setUiValues(renamed, "b", example), renamed);
assert.deepEqual(setUiValues(renamed, "a", example), [{ id: "a", name: "Renamed", values: example }]);
console.log("PASS UI configuration data: theme rules, input validation, names, limits and value replacement");

const changesLine = elements.find((element) => element.id === "changes.line");
assert.equal(uiSampleSelector(changesLine), ".ui-preview .dp-line, .ui-preview .edit-side");
const menuItem = elements.find((element) => element.id === "menus.item");
assert.equal(uiSampleSelector(menuItem), ".ui-preview .row-pop button");
assert.ok(uiSampleSelector(menuItem, menuItem.controls.find((control) => control.kind === "color")).includes(".ui-preview .row-pop button:not(.danger)"));
assert.equal(uiSampleSelector(elements.find((element) => element.id === "app.text")), ".ui-preview");
assert.equal(uiSampleSelector(elements.find((element) => element.id === "files.editor")), ".ui-preview .ui-sample-editor");

assert.equal(contrastRatio("#000000", "#ffffff"), 21);
assert.ok(Math.abs(contrastRatio("#777777", "rgb(255, 255, 255)") - 4.48) < 0.01);
assert.ok(Number.isNaN(contrastRatio("#000000", "rgba(255, 255, 255, 0.5)")));
assert.equal(uiColorHex("rgba(10, 20, 30, 0.5)"), "#0a141e");
assert.equal(uiColorHex("color(display-p3 1 0 0)"), undefined);

const styles = read("styles.css");
assert.match(styles, /:root,\s*\.settings-page\s*\{[^}]*--text-scale:\s*1;\s*--mono-scale:\s*1;\s*--display-scale:\s*1;/);
assert.match(styles, /:root\[data-theme="light"\],\s*:root\[data-theme="light"\]\s+\.settings-page\s*\{/);
assert.match(styles, /:root:not\(\[data-theme\]\),\s*:root:not\(\[data-theme\]\)\s+\.settings-page\s*\{/);
assert.match(styles, /\.settings-page\s*\{[^}]*\bcolor:\s*var\(--text\)/);
console.log("PASS UI configuration preview: isolated targets, WCAG color math and Settings tokens");
