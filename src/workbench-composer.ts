/**
 * Pure composer builders for the interactive md Flow Workbench.
 *
 * This module owns the new-flow spec and its exact CLI/shell renderings. No
 * prompts or terminal rendering. Imported by workbench.ts; re-exported there
 * for existing importers.
 */

import type { CreateLocation } from "./create";
import { draftFlowFromIntent, type FlowDraft } from "./workbench-model";

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Everything the composer collects before a flow is created. */
export interface NewFlowSpec {
	intent: string;
	slug: string;
	docs: string[];
	engine: string;
	model?: string;
	effort?: string;
	location?: CreateLocation;
	customDir?: string;
}

/** Comma-separated docs entries — commands keep their internal spaces. */
export function splitDocsInput(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** Exact args handed back to the CLI for a composer creation. */
export function newFlowArgs(spec: NewFlowSpec): string[] {
	const parts = [spec.intent, "--name", spec.slug, "--engine", spec.engine];
	if (spec.model) parts.push("--model", spec.model);
	if (spec.effort) parts.push("--effort", spec.effort);
	for (const doc of spec.docs) parts.push("--docs", doc);
	const location = spec.location ?? "project";
	if (location === "project") parts.push("--project");
	else if (location === "cwd") parts.push("--location", "cwd");
	else if (location === "user") parts.push("--global");
	else parts.push("--dir", spec.customDir?.trim() || ".");
	return parts;
}

/** Exact non-interactive shell equivalent of a composer creation. */
export function newFlowCommand(spec: NewFlowSpec, commandName = "md"): string {
	return [commandName, "create", ...newFlowArgs(spec).map(shellQuote)].join(
		" ",
	);
}

export function draftFromSpec(spec: NewFlowSpec): FlowDraft {
	return draftFlowFromIntent(spec.intent, {
		slug: spec.slug,
		docs: spec.docs,
		engine: spec.engine,
		...(spec.model ? { model: spec.model } : {}),
		...(spec.effort ? { effort: spec.effort } : {}),
	});
}
