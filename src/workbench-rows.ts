/**
 * Pure home-list builders for the interactive md Flow Workbench.
 *
 * This module owns the home-list model: row ranking, status lookup, badges,
 * and result builders. No prompts or terminal rendering. Imported by
 * workbench.ts; re-exported there for existing importers.
 */

import { basename, relative } from "node:path";
import type { AgentFile } from "./cli";
import { flowCommand } from "./tips";
import type {
	WorkbenchConfig,
	WorkbenchFlowStatus,
	WorkbenchResult,
} from "./workbench";
import { rankWorkbenchFlows } from "./workbench-search";

export interface FlowRow {
	kind: "flow";
	file: AgentFile;
	score: number;
	matchIndices: number[];
	matchField?: "name" | "description" | "path" | "provenance";
	matchValue?: string;
}

export interface SetupRow {
	kind: "setup";
	id: "setup-project";
	label: string;
	description: string;
}

export type HomeRow = FlowRow | SetupRow;

const color = {
	reset: "\x1b[0m",
	bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
	dim: (value: string) => `\x1b[90m${value}\x1b[0m`,
	cyan: (value: string) => `\x1b[36m${value}\x1b[0m`,
	blue: (value: string) => `\x1b[34m${value}\x1b[0m`,
	green: (value: string) => `\x1b[32m${value}\x1b[0m`,
	yellow: (value: string) => `\x1b[33m${value}\x1b[0m`,
	red: (value: string) => `\x1b[31m${value}\x1b[0m`,
	inverse: (value: string) => `\x1b[7m${value}\x1b[27m`,
};

function projectPath(path: string, root: string): string {
	const display = relative(root, path);
	if (!display || display.startsWith("..")) return path;
	return display.split("\\").join("/");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandForFlow(
	commandName: string,
	path: string,
	root: string,
): string {
	return flowCommand(path, root, commandName);
}

export function statusFor(
	config: WorkbenchConfig,
	file: AgentFile,
	root: string,
): WorkbenchFlowStatus {
	const direct = config.statusFor?.(file);
	if (direct) return direct;
	const statuses = config.statuses;
	if (!statuses) return {};
	return (
		statuses[file.path] ??
		statuses[projectPath(file.path, root)] ??
		statuses[file.name] ??
		statuses[basename(file.path)] ??
		{}
	);
}

/** Pure helper used by the prompt and by terminal-demo fixtures. */
export function getWorkbenchRows(
	files: readonly AgentFile[],
	query: string,
): FlowRow[] {
	return rankWorkbenchFlows(files, query).map((ranked) => ({
		kind: "flow",
		file: ranked.file,
		score: ranked.score,
		matchIndices: ranked.match?.indices ?? [],
		...(ranked.match
			? { matchField: ranked.match.field, matchValue: ranked.match.value }
			: {}),
	}));
}

export function statusBadge(status: WorkbenchFlowStatus): string {
	const fragments: string[] = [];
	const open = status.evidence?.open ?? 0;
	if (open > 0) fragments.push(color.yellow(`${open} feedback`));

	const evalState = status.eval?.state;
	if (evalState === "passing" || evalState === "current")
		fragments.push(color.green("eval ✓"));
	else if (evalState === "failing") fragments.push(color.red("eval ×"));
	else if (evalState === "stale") fragments.push(color.yellow("eval stale"));
	else if (evalState === "missing") fragments.push(color.dim("needs proof"));

	const proposalState = status.proposal?.state;
	if (
		["verified", "verified_improvement", "regression_safe"].includes(
			proposalState ?? "",
		)
	) {
		fragments.push(color.cyan("proposal ready"));
	} else if (
		[
			"running",
			"planned",
			"drafting",
			"verifying",
			"applying",
			"rolling_back",
		].includes(proposalState ?? "")
	) {
		fragments.push(color.yellow("evolving…"));
	} else if (proposalState === "applied")
		fragments.push(color.green("applied"));
	else if (
		["blocked", "capability_rejected", "rejected", "inconclusive"].includes(
			proposalState ?? "",
		)
	) {
		fragments.push(color.red("blocked"));
	}
	return fragments.join(color.dim(" · "));
}

export function evidenceLine(status: WorkbenchFlowStatus): string {
	const evidence = status.evidence;
	if (evidence?.headline) return evidence.headline;
	const open = evidence?.open ?? 0;
	const total = evidence?.total ?? open;
	if (total === 0) return "No feedback recorded";
	const pieces = [`${open} open / ${total} total`];
	if (evidence?.covered !== undefined) {
		pieces.push(
			`${evidence.covered}/${open} open item${open === 1 ? "" : "s"} covered`,
		);
	}
	if ((evidence?.targeted ?? 0) > 0)
		pieces.push(`${evidence!.targeted} targeted`);
	return pieces.join(" · ");
}

export function evalLine(status: WorkbenchFlowStatus): string {
	const evaluation = status.eval;
	if (evaluation?.headline) return evaluation.headline;
	const state = evaluation?.state ?? "unknown";
	if (evaluation?.total !== undefined) {
		return `${evaluation.passed ?? 0}/${evaluation.total} passing · ${state}`;
	}
	if (state === "missing") return "No eval suite yet";
	return state === "unknown" ? "Proof status unknown" : state;
}

export function proposalLine(status: WorkbenchFlowStatus): string {
	const proposal = status.proposal;
	if (proposal?.headline) return proposal.headline;
	const state = proposal?.state ?? "none";
	if (state === "none") return "No proposal";
	return proposal?.runId ? `${state} · ${proposal.runId}` : state;
}

export function selectedFile(
	rows: HomeRow[],
	cursor: number,
): AgentFile | undefined {
	const row = rows[Math.min(cursor, Math.max(0, rows.length - 1))];
	return row?.kind === "flow" ? row.file : undefined;
}

export function resultForFlow(
	action: "run" | "dry-run" | "edit" | "evolve-plan" | "evolve-propose",
	file: AgentFile,
	config: WorkbenchConfig,
	root: string,
): WorkbenchResult {
	const commandName = config.commandName ?? "md";
	const base = commandForFlow(commandName, file.path, root);
	if (action === "run")
		return { action, effect: "ENGINE", command: base, file, path: file.path };
	if (action === "dry-run") {
		return {
			action,
			effect: "FREE",
			command: `${base} --_dry-run`,
			file,
			path: file.path,
		};
	}
	if (action === "edit") {
		return {
			action,
			effect: "LOCAL WRITE",
			command: `$EDITOR ${shellQuote(projectPath(file.path, root))}`,
			file,
			path: file.path,
		};
	}
	const evolveAction = action === "evolve-plan" ? "plan" : "propose";
	return {
		action,
		effect: action === "evolve-plan" ? "FREE" : "ENGINE",
		command: `${commandName} evolve ${evolveAction} ${shellQuote(projectPath(file.path, root))}`,
		file,
		path: file.path,
	};
}
