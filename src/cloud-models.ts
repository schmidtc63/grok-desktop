import type { CursorModel, CursorParam, CursorVariant } from "./types";

export function chooseVariant(model: CursorModel, params: CursorParam[] = [], paramId?: string, value?: string): CursorVariant | undefined {
	if (paramId === undefined) { return model.variants.find((variant) => variant.isDefault); }
	let choice: CursorVariant | undefined;
	let best = -1;
	for (const variant of model.variants) {
		if (!variant.params.some((param) => param.id === paramId && param.value === value)) { continue; }
		const score = variant.params.filter((param) => params.some((current) => current.id === param.id && current.value === param.value)).length;
		if (score > best) {
			choice = variant;
			best = score;
		}
	}
	return choice;
}

export function defaultVariant(models: CursorModel[]): (CursorVariant & { id: string }) | undefined {
	const model = models.find((item) => item.id === "grok-4.7") ?? models.find((item) => item.id === "default");
	const variant = model && chooseVariant(model);
	return model && variant ? { ...variant, id: model.id } : undefined;
}

export function sameCloudParams(a: CursorParam[], b: CursorParam[]) {
	return a.length === b.length && a.every((param) => b.some((other) => other.id === param.id && other.value === param.value));
}
