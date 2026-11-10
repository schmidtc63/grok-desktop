const assert = require("assert/strict");
const vm = require("vm");
const { randomFillSync } = require("crypto");
const { pageScript, sensitiveField } = require("../electron/browser-page.cjs");

function fixture() {
	let now = 1000;
	let navigationEpoch = 0;
	const timers = [];
	class FakeEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } }
	class EventTarget {
		constructor() { this.events = []; this.listeners = new Map(); }
		addEventListener(type, callback) {
			if (!this.listeners.has(type)) { this.listeners.set(type, new Set()); }
			this.listeners.get(type).add(callback);
		}
		removeEventListener(type, callback) { if (this.listeners.has(type)) { this.listeners.get(type).delete(callback); } }
		dispatchEvent(event) {
			this.events.push(event);
			for (const callback of this.listeners.get(event.type) || []) { callback(event); }
			if (this.onDispatch) { this.onDispatch(event); }
			return true;
		}
	}
	class Node extends EventTarget {
		constructor() { super(); this.children = []; this.events = []; this._text = ""; }
		get textContent() { return this._text + this.children.map((child) => child.textContent).join(" "); }
		set textContent(value) { this._text = String(value); this.children = []; }
		contains(node) {
			for (let current = node; current; current = current.parentElement) { if (current === this) { return true; } }
			return false;
		}
	}
	class CSSStyleDeclaration {
		constructor() { this.properties = new Map(); }
		getPropertyValue(name) { return (this.properties.get(name) || [""])[0]; }
		getPropertyPriority(name) { return (this.properties.get(name) || ["", ""])[1]; }
		setProperty(name, value, priority = "") { this.properties.set(name, [value === "3px solid rgb(255, 153, 0)" ? "rgb(255, 153, 0) solid 3px" : value, priority]); }
		removeProperty(name) { this.properties.delete(name); }
	}
	class Element extends Node {
		constructor(tag, attrs = {}, text = "") {
			super(); this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this._text = text; this.style = new CSSStyleDeclaration();
			this.isConnected = true; this.isContentEditable = Object.hasOwn(attrs, "contenteditable") && attrs.contenteditable !== "false";
			this.disabled = false; this.readOnly = false; this.labels = []; this._visible = true; this.clicks = 0; this.scrolls = 0;
			this.box = { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 };
		}
		get innerText() { return this._innerText === undefined ? this.textContent : this._innerText; }
		getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
		hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
		matches(selector) {
			if (selector === ":disabled") { return this.disabled; }
			return selector.split(",").some((part) => {
				const match = part.match(/^(\w+)?(?:\[([^\]]+)\])?$/);
				return match && (!match[1] || this.tagName.toLowerCase() === match[1]) && (!match[2] || this.hasAttribute(match[2]));
			});
		}
		querySelectorAll(selector) { return this.ownerDocument.elements.filter((el) => el !== this && this.contains(el) && el.matches(selector)); }
		checkVisibility() {
			for (let el = this; el; el = el.parentElement) { if (!el._visible) { return false; } }
			return true;
		}
		getBoundingClientRect() { return this.box; }
		scrollIntoView() { this.scrolls++; this.ownerDocument.lastScrolled = this; if (this.onScroll) { this.onScroll(); } }
		closest(tag) {
			for (let el = this; el; el = el.parentElement) { if (el.tagName.toLowerCase() === tag) { return el; } }
			return null;
		}
	}
	class HTMLElement extends Element { click() { this.clicks++; if (this.onClick) { this.onClick(); } } }
	class HTMLInputElement extends HTMLElement {
		get value() { return this._value || ""; }
		set value(value) { this._value = value; this.nativeSets = (this.nativeSets || 0) + 1; }
	}
	class HTMLTextAreaElement extends HTMLInputElement {}
	Object.defineProperty(HTMLTextAreaElement.prototype, "value", Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"));
	class HTMLSelectElement extends HTMLInputElement {
		get selectedIndex() { return this._selectedIndex; }
		set selectedIndex(value) { this._selectedIndex = value; this.value = this.options[value].value; }
	}
	Object.defineProperty(HTMLSelectElement.prototype, "value", Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"));
	class HTMLFormElement extends HTMLElement {
		get action() { return new URL(this.attrs.action || this.ownerDocument.location.href, this.ownerDocument.baseURI || this.ownerDocument.location.href).href; }
		get method() { return this.attrs.method || "get"; }
		get noValidate() { return this.hasAttribute("novalidate"); }
		reportValidity() { return this.ownerDocument.elements.every((el) => el.form !== this || !el.hasAttribute("required") || !!el.value); }
		requestSubmit() { this.submissions = (this.submissions || 0) + 1; }
	}
	class Document {
		constructor() { this.elements = []; this.body = this.add("body"); }
		add(tag, attrs = {}, text = "", parent = this.body) {
			const Type = { input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement, form: HTMLFormElement }[tag] || HTMLElement;
			const el = new Type(tag, attrs, text); el.ownerDocument = this; el.parentElement = parent || null;
			if (parent) { parent.children.push(el); }
			this.elements.push(el);
			if (tag === "select") { el.options = []; }
			return el;
		}
		querySelectorAll(selector) { this.queries = (this.queries || 0) + 1; return this.elements.filter((el) => el.isConnected && el.matches(selector)); }
		getElementById(id) { return this.elements.find((el) => el.attrs.id === id) || null; }
		elementFromPoint() { return this.hitOverride === undefined ? this.lastScrolled : this.hitOverride; }
	}
	class Window extends EventTarget { constructor() { super(); this.scrollBy = (options) => { this.scrolls.push(options); }; } }
	const document = new Document(), window = new Window(); window.scrolls = [];
	const context = vm.createContext({
		document, window, location: { href: "https://example.test/start?private=yes#secret" }, URL, crypto: { getRandomValues: (array) => randomFillSync(array) },
		Element, Node, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLFormElement, Document, Window,
		CSSStyleDeclaration, EventTarget, Event: FakeEvent, innerWidth: 800, innerHeight: 600,
		Date: class extends Date { static now() { return now; } }, setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
	});
	document.location = context.location;
	const plain = (value) => JSON.parse(JSON.stringify(value));
	const run = (op, args = {}) => plain(vm.runInContext(pageScript(op, { origin: new URL(context.location.href).origin, navigationEpoch, ...args }), context, { timeout: 1000 }));
	const actionArgs = (ref, extra = {}) => ({ ref, origin: new URL(context.location.href).origin, navigationEpoch, deadline: now + 5000, ...extra });
	const ref = (el) => run("snapshot").entries.find((entry) => entry.ref && context.__grokBrowserPageState.refs.get(entry.ref) === el).ref;
	const inspect = (el, extra = {}) => run("inspect", actionArgs(ref(el), extra));
	return { document, context, timers, run, actionArgs, ref, inspect, plain,
		add: (...args) => document.add(...args), setNow: (value) => { now = value; }, setEpoch: (value) => { navigationEpoch = value; },
		navigate: () => { context.document = new Document(); return context.document; } };
}

function check(name, test) { test(); console.log(`PASS ${name}`); }

check("fixed operations and argument serialization never execute caller code", () => {
	assert.throws(() => pageScript("eval", {}), /Unknown/);
	assert.throws(() => pageScript("snapshot", []), /object/);
	const f = fixture(), input = f.add("input", { name: "message" });
	const expectedMeta = f.inspect(input), text = '"); globalThis.injected = true; // </script>\u2028';
	f.run("fill", f.actionArgs(expectedMeta.ref, { text, expectedMeta }));
	assert.equal(input.value, text); assert.equal(f.context.injected, undefined);
});

check("shared classifier recognizes required sensitive metadata without matching shipping or ordinary labels", () => {
	for (const meta of [{ type: "password" }, { autocomplete: "section-a current-password" }, { autocomplete: "new-password" }, { autocomplete: "one-time-code" }, { autocomplete: "billing cc-number" },
		... ["Password", "password1", "PIN2", "one-time code", "2FA", "CVV", "cardNumber", "expiry", "IBAN", "routing number", "account_number", "SSN", "secret", "token", "apiKey"].map((label) => ({ label }))]) {
		assert.equal(sensitiveField(meta), true, JSON.stringify(meta));
	}
	for (const label of ["Shipping address", "Opinion", "County", "Username", "Search"]) { assert.equal(sensitiveField({ label }), false, label); }
});

check("snapshot hides sensitive values, cleans URLs and bounds names and values", () => {
	const f = fixture(), password = f.add("input", { type: "password", "aria-label": "Password" }); password.value = "saved-secret";
	const email = f.add("input", { "aria-label": "E".repeat(180) }); email.value = "a".repeat(250);
	f.add("a", { href: "https://user:password@example.test/docs?token=leak#hash" }, "Docs https://u:p@example.test/docs?token=leak#hash");
	const snapshot = f.run("snapshot");
	assert.equal(snapshot.url, "https://example.test/start");
	assert.equal(snapshot.entries[0].sensitive, true); assert.equal(snapshot.entries[0].value, undefined);
	assert.ok(snapshot.text.includes("sensitive, value hidden")); assert.ok(!JSON.stringify(snapshot).includes("saved-secret"));
	assert.equal(snapshot.entries[1].name.length, 120); assert.equal(snapshot.entries[1].value.length, 200);
	assert.equal(snapshot.entries[2].url, "https://example.test/docs"); assert.ok(!snapshot.text.includes("token=")); assert.ok(!snapshot.text.includes("u:p@"));
	assert.equal(f.inspect(password).value, undefined);
	const wrapper = f.add("section", { role: "form" }); f.add("div", { contenteditable: "true", "aria-label": "API key" }, "private-key-value", wrapper);
	assert.ok(!JSON.stringify(f.run("snapshot")).includes("private-key-value"), "ancestor names must not expose sensitive editable descendants");
	f.context.location.href = "http://example.test/insecure";
	assert.equal(f.run("snapshot").url, "http://example.test/insecure", "refs also work on HTTP contexts without crypto.randomUUID");
});

check("snapshot excludes hidden, aria-hidden, zero-sized and disconnected targets and caps output", () => {
	const f = fixture(); f.add("button", {}, "Visible");
	f.add("input", { type: "hidden" });
	const parent = f.add("div", { "aria-hidden": "true" }); f.add("button", {}, "Hidden ancestor", parent);
	f.add("button", { hidden: "" }, "Hidden attr"); f.add("button", {}, "Hidden CSS")._visible = false;
	f.add("button", {}, "Zero box").box.width = 0; f.add("button", {}, "Detached").isConnected = false;
	assert.equal(f.run("snapshot").entries.length, 1);
	for (let index = 0; index < 500; index++) { f.add("button", {}, `Button ${index}`); }
	for (const maxChars of [1, 1000, 16000, 50000]) {
		const result = f.run("snapshot", { maxChars }); assert.ok(result.entries.length <= 400);
		assert.ok(result.text.length <= Math.max(1000, Math.min(16000, maxChars))); assert.equal(result.truncated, true);
	}
});

check("read_text collapses whitespace, hides sensitive editable text and cleans URL credentials and queries", () => {
	const f = fixture(); f.document.body._innerText = "Welcome\n\n secret-value  https://u:p@example.test/docs?q=secret#hash  done";
	f.add("div", { contenteditable: "true", "aria-label": "API key" }, "secret-value");
	const result = f.run("read_text");
	assert.equal(result.text, "Welcome (sensitive value hidden) https://example.test/docs done");
	assert.equal(result.url, "https://example.test/start");
	f.document.body._innerText = "x".repeat(20000); assert.equal(f.run("read_text", { maxChars: 1000 }).text.length, 1000);
	for (const op of ["snapshot", "read_text"]) {
		const queuedFixture = fixture();
		const queued = pageScript(op, { origin: "https://example.test", navigationEpoch: 0 });
		queuedFixture.context.location.href = "https://unapproved.test/private";
		queuedFixture.document.body._innerText = "unapproved-private-text";
		assert.throws(() => vm.runInContext(queued, queuedFixture.context), /origin changed/);
		assert.equal(queuedFixture.document.queries, undefined); assert.equal(queuedFixture.context.__grokBrowserPageState, undefined);
	}
});

check("stale refs fail across detachment, documents, SPA routes, navigation epochs and pagehide restores", () => {
	const f = fixture(), button = f.add("button", {}, "Go"), ref = f.ref(button);
	button.isConnected = false; assert.throws(() => f.run("click", f.actionArgs(ref)), /stale/); assert.equal(button.clicks, 0);
	const newDocument = f.navigate(), newButton = newDocument.add("button", {}, "New");
	const newRef = f.run("snapshot").entries[0].ref; assert.notEqual(newRef, ref);
	assert.throws(() => f.run("click", f.actionArgs(ref)), /stale/); assert.equal(newButton.clicks, 0);
	assert.equal(f.context.window.listeners.get("pagehide").size, 1, "document replacement must replace the old listener");
	const spa = fixture(), reused = spa.add("button", {}, "Delete"), originalRef = spa.ref(reused);
	spa.context.location.href = "https://example.test/different-route";
	assert.throws(() => spa.run("click", spa.actionArgs(originalRef)), /stale/); assert.equal(reused.clicks, 0);
	const routeRef = spa.ref(reused); assert.notEqual(routeRef, originalRef);
	spa.setEpoch(2);
	assert.throws(() => spa.run("click", spa.actionArgs(routeRef)), /stale/, "A to B to A navigation must expire refs even when the final href is unchanged");
	const beforePagehide = spa.ref(reused);
	spa.context.window.dispatchEvent({ type: "pagehide", persisted: true });
	assert.equal(spa.context.__grokBrowserPageState.refs.size, 0);
	assert.throws(() => spa.run("click", spa.actionArgs(beforePagehide)), /stale/); assert.equal(reused.clicks, 0);
	const restoredRef = spa.ref(reused); assert.notEqual(restoredRef, beforePagehide);
	spa.run("click", spa.actionArgs(restoredRef)); assert.equal(reused.clicks, 1);
	for (let index = 0; index < 4; index++) { spa.context.location.href = `https://example.test/route-${index}`; spa.run("snapshot"); }
	assert.equal(spa.context.window.listeners.get("pagehide").size, 1, "route changes must not accumulate listeners");
});

check("expired and delayed queued actions refuse before DOM access or mutation", () => {
	const f = fixture(), button = f.add("button", {}, "Go"), ref = f.ref(button);
	const queued = pageScript("click", f.actionArgs(ref, { deadline: 1200 }));
	f.setNow(1200); f.context.location.href = "file:///not-allowed";
	assert.throws(() => vm.runInContext(queued, f.context), /deadline expired/); assert.equal(button.clicks, 0); assert.equal(button.scrolls, 0);
	for (const op of ["click", "fill", "select", "scroll", "highlight"]) { assert.throws(() => f.run(op, { deadline: 0 }), /deadline expired/); }
	assert.throws(() => f.run("click", { ref }), /deadline expired/);
});

check("origin, visibility and coverage are rechecked after scrolling and native click bypasses own wrappers", () => {
	const f = fixture(), button = f.add("button", {}, "Go"); let args = f.actionArgs(f.ref(button));
	f.context.location.href = "https://other.test/page"; assert.throws(() => f.run("click", args), /origin changed/); assert.equal(button.scrolls, 0);
	f.context.location.href = "https://example.test/start"; args = f.actionArgs(f.ref(button)); button.onScroll = () => { f.context.location.href = "https://other.test/page"; };
	assert.throws(() => f.run("click", args), /origin changed/); assert.equal(button.clicks, 0);
	f.context.location.href = "https://example.test/start"; button.onScroll = () => { button._visible = false; };
	assert.throws(() => f.run("click", args), /not visible/); assert.equal(button.clicks, 0);
	button._visible = true; button.onScroll = null; f.document.hitOverride = f.add("div", {}, "Overlay");
	assert.throws(() => f.run("click", args), /covered/); assert.equal(button.clicks, 0);
	f.document.hitOverride = f.add("span", {}, "child", button); button.click = () => { throw new Error("Page wrapper ran"); }; button.scrollIntoView = button.click;
	f.run("click", args); assert.equal(button.clicks, 1);
	button.disabled = true; assert.throws(() => f.run("click", args), /disabled/); assert.equal(button.clicks, 1);
});

check("highlight returns immediately, uses 400ms cleanup and preserves prior outline", () => {
	const f = fixture(), button = f.add("button", {}, "Go"); button.style.setProperty("outline", "1px solid blue", "important");
	const result = f.run("highlight", f.actionArgs(f.ref(button)));
	assert.equal(result.ok, true); assert.equal(button.style.getPropertyValue("outline"), "rgb(255, 153, 0) solid 3px");
	assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 400);
	f.timers.shift().callback(); assert.equal(button.style.getPropertyValue("outline"), "1px solid blue"); assert.equal(button.style.getPropertyPriority("outline"), "important");
	f.run("highlight", f.actionArgs(f.ref(button))); button.style.setProperty("outline", "2px solid green");
	f.timers.shift().callback(); assert.equal(button.style.getPropertyValue("outline"), "2px solid green"); assert.equal(button.clicks, 0);
});

check("fill uses native setters and bubbling input/change, then native requestSubmit", () => {
	const f = fixture(), form = f.add("form"), input = f.add("input", { name: "message" }, "", form); input.form = form;
	const expectedMeta = f.inspect(input, { submit: true }); input.value = "old";
	Object.defineProperty(input, "value", { get: () => input._value, set: () => { throw new Error("Own value setter"); } });
	input.dispatchEvent = () => { throw new Error("Own dispatch wrapper"); }; form.requestSubmit = input.dispatchEvent;
	f.run("fill", f.actionArgs(expectedMeta.ref, { expectedMeta, text: "new", submit: true }));
	assert.equal(input._value, "new"); assert.equal(input.nativeSets, 2); assert.equal(form.submissions, 1);
	assert.deepEqual(input.events.map((event) => [event.type, event.bubbles]), [["input", true], ["change", true]]);
	const textarea = f.add("textarea", { "aria-label": "Note" }), editable = f.add("div", { contenteditable: "true", "aria-label": "Note" });
	for (const el of [textarea, editable]) { const meta = f.inspect(el); f.run("fill", f.actionArgs(meta.ref, { expectedMeta: meta, text: "hello" })); }
	assert.equal(textarea.value, "hello"); assert.equal(editable.textContent, "hello");
});

check("fill leaves native action resolution and changes to request-level authorization", () => {
	const f = fixture(), form = f.add("form", { action: "submit?token=private" }), input = f.add("input", { name: "action" });
	input.form = form; f.document.baseURI = "https://destination.test/relative/";
	Object.defineProperty(form, "action", { value: input });
	const expectedMeta = f.inspect(input, { submit: true });
	const args = f.actionArgs(expectedMeta.ref, { expectedMeta, text: "private", submit: true });
	form.attrs.action = "https://unexpected.test/other";
	assert.equal(f.run("fill", args).ok, true);
	assert.equal(input.value, "private");
	form.attrs.action = "submit";
	input.onDispatch = () => { form.attrs.action = "https://unexpected.test/other"; };
	assert.equal(f.run("fill", args).ok, true);
	assert.equal(form.submissions, 2);
});

check("fill reports native form validation failure and honors novalidate", () => {
	const f = fixture(), form = f.add("form"), input = f.add("input", {}, "", form), required = f.add("input", { required: "" }, "", form);
	input.form = form; required.form = form;
	const expectedMeta = f.inspect(input, { submit: true });
	const args = f.actionArgs(expectedMeta.ref, { expectedMeta, text: "new", submit: true });
	assert.match(f.run("fill", args).error, /Form validation blocked submission/);
	assert.equal(input.value, "new");
	assert.equal(form.submissions, undefined);
	form.attrs.novalidate = "";
	assert.equal(f.run("fill", args).ok, true);
	assert.equal(form.submissions, 1);
});

check("fill refuses changed field metadata, missing sensitive approval and noneditable targets before mutation", () => {
	const f = fixture(), input = f.add("input", { name: "message" }); input.value = "original";
	const oldMeta = f.inspect(input); input.attrs.type = "password";
	assert.throws(() => f.run("fill", f.actionArgs(oldMeta.ref, { expectedMeta: oldMeta, sensitiveApproved: true, text: "secret" })), /details changed/);
	const sensitiveMeta = f.inspect(input);
	assert.throws(() => f.run("fill", f.actionArgs(oldMeta.ref, { expectedMeta: sensitiveMeta, text: "secret" })), /explicit approval/);
	assert.equal(input.value, "original"); f.run("fill", f.actionArgs(oldMeta.ref, { expectedMeta: sensitiveMeta, sensitiveApproved: true, text: "approved" }));
	assert.equal(input.value, "approved"); input.readOnly = true;
	const readonly = f.inspect(input); assert.throws(() => f.run("fill", f.actionArgs(readonly.ref, { expectedMeta: readonly, sensitiveApproved: true, text: "bad" })), /not editable/);
	assert.equal(input.value, "approved");
});

check("fill validation and missing forms refuse without partially changing the field", () => {
	const f = fixture(), input = f.add("input", { name: "message" }); input.value = "original"; const expectedMeta = f.inspect(input);
	for (const extra of [{ text: "x".repeat(2001) }, { text: "new", submit: "yes" }, { text: "new", submit: true }]) {
		assert.throws(() => f.run("fill", f.actionArgs(expectedMeta.ref, { expectedMeta, ...extra })), /Fill requires|no form/); assert.equal(input.value, "original");
	}
	input.onScroll = () => { input.attrs.autocomplete = "one-time-code"; };
	assert.throws(() => f.run("fill", f.actionArgs(expectedMeta.ref, { expectedMeta, text: "new" })), /details changed/); assert.equal(input.value, "original");
});

check("select matches labels and values with metadata, sensitive and disabled-option guards", () => {
	const f = fixture(), select = f.add("select", { name: "choice" });
	select.options = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Disabled", disabled: true }, { value: "a", label: "Duplicate value" }];
	const expectedMeta = f.inspect(select);
	for (const [option, expected] of [["Beta", "b"], ["a", "a"]]) {
		f.run("select", f.actionArgs(expectedMeta.ref, { expectedMeta, option })); assert.equal(select.value, expected);
	}
	assert.deepEqual(select.events.map((event) => event.type), ["input", "change", "input", "change"]);
	f.run("select", f.actionArgs(expectedMeta.ref, { expectedMeta, option: "Duplicate value" })); assert.equal(select.selectedIndex, 3);
	for (const option of ["missing", "Disabled"]) { assert.throws(() => f.run("select", f.actionArgs(expectedMeta.ref, { expectedMeta, option })), /unavailable/); assert.equal(select.value, "a"); }
	select.attrs.name = "SSN"; assert.throws(() => f.run("select", f.actionArgs(expectedMeta.ref, { expectedMeta, option: "a" })), /details changed/);
	const sensitiveMeta = f.inspect(select); assert.throws(() => f.run("select", f.actionArgs(sensitiveMeta.ref, { expectedMeta: sensitiveMeta, option: "b" })), /explicit approval/);
	f.run("select", f.actionArgs(sensitiveMeta.ref, { expectedMeta: sensitiveMeta, sensitiveApproved: true, option: "b" })); assert.equal(select.value, "b");
});

check("scroll is bounded, origin checked and supports validated refs without clicking", () => {
	const f = fixture(); f.run("scroll", f.actionArgs(undefined, { direction: "down", pages: 2 }));
	assert.deepEqual(f.plain(f.context.window.scrolls), [{ left: 0, top: 1200, behavior: "instant" }]);
	for (const pages of [0, 11, 1.5]) { assert.throws(() => f.run("scroll", f.actionArgs(undefined, { direction: "down", pages })), /1 to 10/); }
	assert.throws(() => f.run("scroll", f.actionArgs(undefined, { direction: "down", origin: "https://other.test" })), /origin changed/);
	const button = f.add("button", {}, "Go"); f.run("scroll", f.actionArgs(f.ref(button))); assert.equal(button.scrolls, 1); assert.equal(button.clicks, 0);
});

console.log("Browser page: 16 test groups passed.");
