/**
 * Shared import-pipeline foundation, extracted from imports.ts.
 *
 * Leaf module: context/budget types, token constants, error factory, ANSI
 * regex, md-command detector, command timeout. Imports NO kind module —
 * kinds import this, never each other.
 */

import { MAX_INPUT_SIZE } from "./limits";
import { ImportError } from "./errors";
import { getProcessManager } from "./process-manager";

/** Track files being processed to detect circular imports */
export type ImportStack = Set<string>;

/** Track resolved import paths for introspection */
export type ResolvedImportsTracker = string[];

/**
 * Import context for passing runtime dependencies
 * Used to inject environment variables and track resolved imports
 */
export interface ImportContext {
  /** Environment variables (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** Shared across recursive content expansion, independent per top-level render. */
  budget?: ImportBudget;
  /** Caller URL policy; a flow cannot relax it via child _env. */
  policyEnv?: Record<string, string | undefined>;
  /** Track resolved imports for ExecutionPlan */
  resolvedImports?: ResolvedImportsTracker;
  /**
   * Working directory for command execution (!`cmd` inlines).
   * When set, commands run in this directory instead of the agent file's directory.
   * This allows agents in ~/.mdflow to execute commands in the user's invocation directory.
   */
  invocationCwd?: string;
  /**
   * Template variables for substitution in inline commands (!`cmd`).
   * When provided, {{ _varname }} patterns in command strings are substituted
   * before execution, allowing dynamic command construction.
   */
  templateVars?: Record<string, string>;
  /**
   * Dry-run mode: when true, commands are not executed.
   * Instead, a placeholder message is returned showing what would have been executed.
   */
  dryRun?: boolean;
  /**
   * Internal cache of resolved project root for path traversal checks.
   * This keeps path policy stable across recursive import expansion.
   */
  _projectRoot?: string;
  /**
   * Optional token budget for first-class context providers (e.g. @git:diff, @tree).
   * When set, provider output falls back to summary mode/truncation to stay in budget.
   */
  _context_budget_tokens?: number;
}

/** Limits fan-out as well as individual reads. Charge before descending or
 * allocating another batch; repeated imports consume the same allowance. */
export class ImportBudget {
  private remainingActions = 1024;
  private remainingBytes = MAX_INPUT_SIZE;
  actions(n: number, depth: number): void {
    this.remainingActions -= n;
    if (depth > 64 || this.remainingActions < 0) throw new ImportError("Import graph exceeds 64 levels or 1024 actions", { errorCode: "INPUT_LIMIT_EXCEEDED" });
  }
  bytes(n: number): void {
    this.remainingBytes -= n;
    if (this.remainingBytes < 0) throw new ImportError("Cumulative imported data exceeds 10MB limit", { errorCode: "INPUT_LIMIT_EXCEEDED" });
  }
}

/** Maximum token count before error (approx 4 chars per token) */
export const MAX_TOKENS = 100_000;
/** Warning threshold for high token count */
export const WARN_TOKENS = 50_000;
export const CHARS_PER_TOKEN = 4;
export const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

/** Default command execution timeout in milliseconds (30 seconds) */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Get command timeout from ProcessManager or use default
 */
export function getCommandTimeout(): number {
  try {
    return getProcessManager().timeouts.commandTimeout;
  } catch {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
}

/** Maximum command output size in characters (~25k tokens) */
export const MAX_COMMAND_OUTPUT_SIZE = 100_000;

export function createImportError(
  message: string,
  errorCode: "IMPORT_FILE_NOT_FOUND" | "IMPORT_FILE_READ_FAILED" | "IMPORT_BINARY_FILE" | "IMPORT_CIRCULAR_DEPENDENCY" | "IMPORT_COMMAND_FAILED" | "IMPORT_URL_FETCH_FAILED",
  context: Record<string, string | number | boolean | null | undefined>,
  cause?: unknown
): ImportError {
  return new ImportError(message, {
    errorCode,
    context,
    cause,
  });
}

/** Regex to strip ANSI escape codes from command output */
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_REGEX = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

const MD_FILE_COMMAND_PATTERN = /^(~?\.?\.?\/)?[^\s]+\.md(\s|$)/;

/**
 * Check if a command looks like a markdown file that should be run with `mdflow`
 */
export function isMarkdownFileCommand(command: string): boolean {
  return MD_FILE_COMMAND_PATTERN.test(command.trim());
}
