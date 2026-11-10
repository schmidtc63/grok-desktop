const OPERATIONS = new Set(["snapshot", "read_text", "inspect", "highlight", "click", "fill", "select", "scroll"]);

function sensitiveField(meta) {
	if (!meta || typeof meta !== "object") { return false; }
	if (String(meta.type || "").toLowerCase() === "password") { return true; }
	if (/(?:^|\s)(?:current-password|new-password|one-time-code|cc-\S+)(?:\s|$)/i.test(String(meta.autocomplete || ""))) { return true; }
	const words = [meta.name, meta.id, meta.label, meta.placeholder, meta.ariaLabel].map((value) => String(value || "")
		.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase()).join(" ");
	return /\b(?:password|passcode|pin|one\s*time\s*(?:code|password)|otp|2fa|cvv|cvc|card\s*(?:number|no)|expir(?:y|ation|ation\s*date)|iban|routing(?:\s*(?:number|no))?|account\s*(?:number|no)|ssn|social\s*security|secret|token|api\s*key)(?:\b|(?=\d))/.test(words);
}

function pageOperation(op, args, classify) {
	if (["click", "fill", "select", "scroll", "highlight"].includes(op)) {
		if (!Number.isFinite(args.deadline) || Date.now() >= args.deadline) { throw new Error("Browser action deadline expired; no action was performed."); }
	}
	const attr = (el, name) => Element.prototype.getAttribute.call(el, name) || "";
	const query = (root, selector) => Array.from((root === document ? Document.prototype.querySelectorAll : Element.prototype.querySelectorAll).call(root, selector));
	const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
	const safeUrl = (value) => {
		try {
			const url = new URL(value, location.href);
			return ["http:", "https:"].includes(url.protocol) ? url.origin + url.pathname : "";
		} catch { return ""; }
	};
	const cleanText = (value) => compact(value).replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeUrl(url));
	const currentUrl = () => safeUrl(location.href);
	const origin = () => new URL(location.href).origin;
	const assertOrigin = () => {
		if (typeof args.origin !== "string" || args.origin !== origin()) { throw new Error("The page origin changed; inspect the page and try again."); }
	};
	assertOrigin();
	if (!currentUrl()) { throw new Error("Browser control requires an HTTP or HTTPS page."); }
	const selector = "a[href],button,input,textarea,select,summary,[role],[contenteditable],h1,h2,h3,h4,h5,h6";
	const metaKeys = ["label", "name", "id", "type", "autocomplete", "placeholder", "ariaLabel", "editable", "tagName"];
	let state = globalThis.__grokBrowserPageState;
	if (!state || state.document !== document) {
		if (state && state.pagehide) { EventTarget.prototype.removeEventListener.call(window, "pagehide", state.pagehide); }
		state = { document, href: null, refs: new Map(), ids: new WeakMap() };
		state.pagehide = () => { state.href = null; state.refs.clear(); state.ids = new WeakMap(); };
		globalThis.__grokBrowserPageState = state;
		EventTarget.prototype.addEventListener.call(window, "pagehide", state.pagehide);
	}
	const syncRefs = () => {
		if (state.href !== location.href || state.navigationEpoch !== args.navigationEpoch) {
			state.href = location.href; state.navigationEpoch = args.navigationEpoch;
			state.prefix = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join("");
			state.next = 1; state.refs.clear(); state.ids = new WeakMap();
		}
	};
	syncRefs();
	const refFor = (el) => {
		let ref = state.ids.get(el);
		if (!ref) {
			ref = `e${state.prefix}-${state.next++}`;
			state.ids.set(el, ref);
			state.refs.set(ref, el);
		}
		return ref;
	};
	const visible = (el) => {
		if (!el || !el.isConnected || el.ownerDocument !== document || (el.tagName === "INPUT" && attr(el, "type").toLowerCase() === "hidden")) { return false; }
		for (let parent = el; parent; parent = parent.parentElement) {
			if (attr(parent, "aria-hidden").toLowerCase() === "true" || Element.prototype.hasAttribute.call(parent, "hidden")) { return false; }
		}
		if (!Element.prototype.checkVisibility.call(el, { checkOpacity: true, checkVisibilityCSS: true })) { return false; }
		const box = Element.prototype.getBoundingClientRect.call(el);
		return box.width > 0 && box.height > 0;
	};
	const metadata = (el) => {
		const tagName = el.tagName.toLowerCase();
		const inputType = attr(el, "type").toLowerCase() || "text";
		const disabled = Element.prototype.matches.call(el, ":disabled");
		const editable = !disabled && !el.readOnly && ((tagName === "input" && !["hidden", "file", "checkbox", "radio", "button", "submit", "reset", "image"].includes(inputType)) || tagName === "textarea" || tagName === "select" || el.isContentEditable);
		const labels = el.labels ? Array.from(el.labels).map((label) => label.innerText || label.textContent).join(" ") : "";
		const labelledBy = attr(el, "aria-labelledby").split(/\s+/).filter(Boolean).map((id) => {
			const label = Document.prototype.getElementById.call(document, id);
			return label ? label.innerText || label.textContent : "";
		}).join(" ");
		return {
			label: compact(labels || labelledBy || attr(el, "aria-label")),
			name: attr(el, "name"), id: attr(el, "id"), type: tagName === "input" ? inputType : tagName,
			autocomplete: attr(el, "autocomplete"), placeholder: attr(el, "placeholder"), ariaLabel: attr(el, "aria-label"),
			editable: !!editable, tagName,
		};
	};
	let hiddenValues;
	const pageText = (value) => {
		if (!hiddenValues) {
			hiddenValues = query(document, "input,textarea,select,[contenteditable]").filter((el) => classify(metadata(el)))
				.flatMap((el) => [el.value, el.textContent, el.innerText]).filter((text) => typeof text === "string" && text.length > 0).sort((a, b) => b.length - a.length);
		}
		let text = String(value || "");
		for (const hidden of hiddenValues) { text = text.split(hidden).join("(sensitive value hidden)"); }
		return cleanText(text);
	};
	const nameFor = (el, meta) => pageText(meta.label || meta.ariaLabel || meta.placeholder || attr(el, "title") || meta.name ||
		(!["input", "textarea", "select"].includes(meta.tagName) && !el.isContentEditable ? el.innerText || el.textContent : "") || meta.tagName).slice(0, 120);
	const roleFor = (el, meta) => attr(el, "role") || ({ a: "link", button: "button", textarea: "textbox", select: "combobox", summary: "button" }[meta.tagName]) ||
		(meta.tagName === "input" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button" }[meta.type] || "textbox") : (el.isContentEditable ? "textbox" : meta.tagName));
	const target = () => {
		assertOrigin();
		syncRefs();
		const el = typeof args.ref === "string" ? state.refs.get(args.ref) : null;
		if (!el || !el.isConnected || el.ownerDocument !== document) { throw new Error("This browser reference is stale; take a new snapshot."); }
		if (!visible(el)) { throw new Error("The target is not visible."); }
		return el;
	};
	const uncovered = (el) => {
		const box = Element.prototype.getBoundingClientRect.call(el);
		const left = Math.max(0, box.left), top = Math.max(0, box.top);
		const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
		if (right <= left || bottom <= top) { throw new Error("The target is outside the visible page."); }
		const hit = Document.prototype.elementFromPoint.call(document, (left + right) / 2, (top + bottom) / 2);
		if (!hit || (hit !== el && !Node.prototype.contains.call(el, hit))) { throw new Error("The target is covered by another element."); }
	};
	const preparedTarget = () => {
		const el = target();
		Element.prototype.scrollIntoView.call(el, { block: "center", inline: "center", behavior: "instant" });
		if (target() !== el) { throw new Error("This browser reference changed; take a new snapshot."); }
		uncovered(el);
		return el;
	};
	const approvedField = (el) => {
		const meta = metadata(el);
		if (!args.expectedMeta || metaKeys.some((key) => args.expectedMeta[key] !== meta[key])) { throw new Error("The field details changed; inspect the field and request approval again."); }
		if (classify(meta) && args.sensitiveApproved !== true) { throw new Error("This sensitive field requires explicit approval."); }
		if (!meta.editable) { throw new Error("The target is not editable."); }
		return meta;
	};
	const formFor = (el) => el.form || (el.isContentEditable && Element.prototype.closest.call(el, "form"));
	const limit = Number.isFinite(args.maxChars) ? Math.min(16000, Math.max(1000, Math.floor(args.maxChars))) : 12000;
	if (op === "snapshot") {
		const candidates = query(document, selector).filter(visible);
		const entries = [], lines = [];
		let length = 0;
		for (const el of candidates.slice(0, 400)) {
			const meta = metadata(el), sensitive = classify(meta);
			const entry = { ref: refFor(el), role: roleFor(el, meta), name: nameFor(el, meta), sensitive };
			let line = `[${entry.ref}] ${entry.role} ${JSON.stringify(entry.name)}`;
			if (["input", "textarea", "select"].includes(meta.tagName) || el.isContentEditable) {
				if (sensitive) { line += " (sensitive, value hidden)"; }
				else {
					entry.value = pageText(el.isContentEditable ? el.innerText : el.value).slice(0, 200);
					line += ` value=${JSON.stringify(entry.value)}`;
				}
			}
			if (meta.tagName === "a") {
				entry.url = safeUrl(attr(el, "href"));
				if (entry.url) { line += ` -> ${entry.url}`; }
			}
			if (length + line.length + 80 > limit) { break; }
			entries.push(entry); lines.push(line); length += line.length + 1;
		}
		const omitted = candidates.length - entries.length;
		if (omitted) { lines.push(`… ${omitted} more not shown`); }
		return { text: lines.join("\n").slice(0, limit), entries, url: currentUrl(), truncated: omitted > 0 };
	}
	if (op === "read_text") {
		const text = pageText(document.body ? document.body.innerText : "");
		return { text: text.slice(0, limit), url: currentUrl(), truncated: text.length > limit };
	}
	if (op === "inspect") {
		const el = target(), meta = metadata(el);
		return { ...meta, ref: args.ref, origin: origin(), sensitive: classify(meta) };
	}
	if (op === "scroll" && !args.ref) {
		assertOrigin();
		if (!["up", "down", "left", "right"].includes(args.direction) || (args.pages !== undefined && (!Number.isInteger(args.pages) || args.pages < 1 || args.pages > 10))) { throw new Error("Scroll requires a direction and 1 to 10 pages."); }
		const pages = args.pages || 1;
		window.scrollBy({ left: ["left", "right"].includes(args.direction) ? innerWidth * pages * (args.direction === "left" ? -1 : 1) : 0,
			top: ["up", "down"].includes(args.direction) ? innerHeight * pages * (args.direction === "up" ? -1 : 1) : 0, behavior: "instant" });
		return { ok: true, url: currentUrl() };
	}
	const el = preparedTarget();
	if (op === "highlight") {
		const style = el.style;
		const previous = CSSStyleDeclaration.prototype.getPropertyValue.call(style, "outline");
		const priority = CSSStyleDeclaration.prototype.getPropertyPriority.call(style, "outline");
		CSSStyleDeclaration.prototype.setProperty.call(style, "outline", "3px solid rgb(255, 153, 0)", "important");
		const applied = CSSStyleDeclaration.prototype.getPropertyValue.call(style, "outline");
		setTimeout(() => {
			if (CSSStyleDeclaration.prototype.getPropertyValue.call(style, "outline") === applied) {
				if (previous) { CSSStyleDeclaration.prototype.setProperty.call(style, "outline", previous, priority); }
				else { CSSStyleDeclaration.prototype.removeProperty.call(style, "outline"); }
			}
		}, 400);
	} else if (op === "click") {
		if (Element.prototype.matches.call(el, ":disabled")) { throw new Error("The target is disabled."); }
		HTMLElement.prototype.click.call(el);
	} else if (op === "fill") {
		const meta = approvedField(el);
		if (typeof args.text !== "string" || args.text.length > 2000 || (args.submit !== undefined && typeof args.submit !== "boolean")) { throw new Error("Fill requires text of at most 2000 characters and an optional submit flag."); }
		if (meta.tagName === "select") { throw new Error("Use select to change this field."); }
		const form = args.submit ? formFor(el) : null;
		if (args.submit && !form) { throw new Error("This field has no form to submit."); }
		if (el.isContentEditable) { Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set.call(el, args.text); }
		else {
			const proto = meta.tagName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value").set.call(el, args.text);
		}
		EventTarget.prototype.dispatchEvent.call(el, new Event("input", { bubbles: true, composed: true }));
		EventTarget.prototype.dispatchEvent.call(el, new Event("change", { bubbles: true }));
		if (args.submit) {
			target(); approvedField(el); uncovered(el);
			if (form !== formFor(el)) { return { error: "The field moved to another form. Take a new snapshot and request approval again." }; }
			const noValidate = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "noValidate").get.call(form);
			if (!noValidate && !HTMLFormElement.prototype.reportValidity.call(form)) { return { error: "Form validation blocked submission. Check the required fields and their values." }; }
			HTMLFormElement.prototype.requestSubmit.call(form);
		}
	} else if (op === "select") {
		const meta = approvedField(el);
		if (meta.tagName !== "select" || typeof args.option !== "string") { throw new Error("Select requires a select field and an option label or value."); }
		const options = Array.from(el.options);
		const option = options.find((item) => item.value === args.option) || options.find((item) => item.label === args.option || item.text === args.option);
		if (!option || option.disabled || (option.parentElement && option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled)) { throw new Error("That option is unavailable."); }
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex").set.call(el, options.indexOf(option));
		EventTarget.prototype.dispatchEvent.call(el, new Event("input", { bubbles: true, composed: true }));
		EventTarget.prototype.dispatchEvent.call(el, new Event("change", { bubbles: true }));
	}
	return { ok: true, url: currentUrl() };
}

function pageScript(op, args = {}) {
	if (!OPERATIONS.has(op)) { throw new Error("Unknown browser page operation."); }
	if (!args || typeof args !== "object" || Array.isArray(args)) { throw new Error("Browser page arguments must be an object."); }
	const data = JSON.stringify(args).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	return `(${pageOperation.toString()})(${JSON.stringify(op)},${data},${sensitiveField.toString()})`;
}

module.exports = { pageScript, sensitiveField };
