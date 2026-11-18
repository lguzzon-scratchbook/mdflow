import { basename } from "path";
import { levenshteinDistance } from "./command";
import { CommandError } from "./errors";
import { maskArgsArray } from "./secrets";
import type { WorkflowResult } from "./workflow";

/**
 * Interactive engines treat any positional prompt as a submitted first turn.
 * A blank interactive body therefore means no positional argument at all.
 */
/**
 * md's own underscore CLI flags, for did-you-mean hints when an ad-hoc
 * `--_var` flag goes unused. `--_dry_run` is one edit away from
 * `--_dry-run` — silently treating the typo as a template variable made md
 * RUN a flow the user asked to preview.
 */
const MD_UNDERSCORE_FLAGS = [
	"_allow-nested",
	"_append-system-prompt",
	"_command",
	"_context",
	"_cwd",
	"_dry-run",
	"_edit",
	"_hooks",
	"_interactive",
	"_isolated",
	"_no-cache",
	"_no-evolve",
	"_no-history",
	"_no-menu",
	"_quiet",
	"_resume",
	"_system-prompt",
	"_trust",
] as const;

/**
 * Warnings for CLI-provided template variables the flow never references.
 * Pure (returns lines) so tests can pin the exact behavior.
 */
export function unusedCliVarWarnings(
	adHocVars: Iterable<string>,
	referencedVars: Iterable<string>,
	inputNames: Iterable<string>,
): string[] {
	const referenced = new Set(referencedVars);
	const declared = new Set(inputNames);
	const warnings: string[] = [];
	for (const key of adHocVars) {
		if (referenced.has(key) || declared.has(key)) continue;
		let best: { flag: string; distance: number } | undefined;
		for (const flag of MD_UNDERSCORE_FLAGS) {
			const distance = levenshteinDistance(key, flag);
			if (!best || distance < best.distance) best = { flag, distance };
		}
		const hint =
			best && best.distance <= 2 ? ` Did you mean --${best.flag}?` : "";
		warnings.push(
			`Warning [UNUSED_VARIABLE_FLAG]: --${key} was provided but this flow never uses {{ ${key} }} — it had no effect.${hint}`,
		);
	}
	return warnings;
}

/**
 * Actionable fail-fast error for missing template variables in a run that
 * cannot prompt anywhere: name the exact flags to pass, and explain _stdin
 * separately — it comes from piped input, not a flag.
 */
export function missingVariablesMessage(
	filePath: string,
	missingVars: string[],
): string {
	const fileLabel = basename(filePath);
	const flagVars = missingVars.filter((v) => v !== "_stdin");
	const lines = [`Missing template variables: ${missingVars.join(", ")}`];
	if (flagVars.length > 0) {
		const flags = flagVars.map((v) => `--${v} "<value>"`).join(" ");
		lines.push(`Provide values as flags: md ${fileLabel} ${flags}`);
	}
	if (missingVars.includes("_stdin")) {
		lines.push(
			`{{ _stdin }} comes from piped input: <command> | md ${fileLabel}`,
		);
	}
	lines.push(
		"(In a terminal, md prompts for these instead of failing.)",
	);
	return lines.join("\n");
}

export function promptPositionals(
	prompt: string,
	interactive: boolean,
): string[] {
	return interactive && !prompt.trim() ? [] : [prompt];
}

export interface WorkbenchChildInvocation {
	executable: string;
	args: string[];
}

/** Build an argv-safe relaunch of the currently running mdflow entrypoint. */
export function buildWorkbenchChildInvocation(
	currentArgv: readonly string[],
	selectedFile: string,
	passthroughArgs: readonly string[],
): WorkbenchChildInvocation {
	const executable = currentArgv[0];
	const entrypoint = currentArgv[1];
	if (!executable || !entrypoint) {
		throw new CommandError(
			"Cannot launch the selected Workbench flow: the current mdflow executable or entrypoint is unavailable.",
			{
				errorCode: "COMMAND_EXECUTION_FAILED",
				context: {
					argvPrefix: currentArgv.slice(0, 2),
					selectedFile,
				},
			},
		);
	}

	return {
		executable,
		args: [entrypoint, selectedFile, ...passthroughArgs],
	};
}

export function definedEnvironment(
	environment: Record<string, string | undefined>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

export function getLastWorkflowOutput(result: WorkflowResult): string | undefined {
	for (let i = result.stepOrder.length - 1; i >= 0; i--) {
		const stepId = result.stepOrder[i];
		if (!stepId) continue;
		const step = result.steps[stepId];
		if (!step || step.skipped || step.exitCode !== 0) continue;
		if (step.stdout) return step.stdout;
	}
	return undefined;
}

/**
 * Format a command preview for the spinner message
 * Shows command + subcommands + key flags in a concise format
 * Sensitive values are masked to prevent accidental exposure
 */
export function formatCommandPreview(
	command: string,
	args: string[],
	maxLength = 60,
): string {
	// Mask sensitive values before building the preview
	const maskedArgs = maskArgsArray(args);

	// Build a representation: command subcommand flag1 flag2 ...
	const parts = [command];

	// First, add any leading non-flag args (subcommands like "exec")
	let i = 0;
	while (i < maskedArgs.length) {
		const arg = maskedArgs[i];
		if (!arg || arg.startsWith("-")) break;
		// Include subcommands (short non-flag args)
		if (arg.length <= 20) {
			parts.push(arg);
		}
		i++;
	}

	// Then add flags and their short values
	for (; i < maskedArgs.length; i++) {
		const arg = maskedArgs[i];
		if (!arg) continue;

		if (arg.startsWith("-")) {
			// It's a flag - add it
			parts.push(arg);
			// Check if next arg is a short value (not another flag)
			const nextArg = maskedArgs[i + 1];
			if (nextArg && !nextArg.startsWith("-") && nextArg.length <= 20) {
				parts.push(nextArg);
				i++;
			}
		}
	}

	let preview = parts.join(" ");

	// Truncate if too long
	if (preview.length > maxLength) {
		preview = preview.slice(0, maxLength - 3) + "...";
	}

	return preview;
}
