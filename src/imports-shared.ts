/**
 * Shared import-pipeline foundation, extracted from imports.ts.
 *
 * Leaf module: context/budget types, token constants, error factory, ANSI
 * regex, md-command detector, command timeout. Imports NO kind module —
 * kinds import this, never each other.
 */

import { resolve, dirname, basename, join } from "path";
import { realpathSync, existsSync } from "fs";
import { homedir } from "os";
import { MAX_INPUT_SIZE } from "./limits";
import { ImportError } from "./errors";
import { getProcessManager } from "./process-manager";
import { sanitizePath } from "./security";

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

/**
 * File extensions that are known to be binary
 * These are checked first before content inspection
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".svg", ".tiff", ".tif",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".db", ".sqlite3",
  ".dat", ".data",
  ".DS_Store",
  ".wasm", ".pyc", ".class", ".o", ".a", ".lib",
]);

/** Size of buffer to check for binary content (8KB) */
const BINARY_CHECK_SIZE = 8192;

/**
 * Check if a file is binary based on extension or content
 *
 * @param filePath - Path to the file
 * @param content - Optional buffer to check (if already read)
 * @returns true if file appears to be binary
 */
export function isBinaryFile(filePath: string, content?: Buffer): boolean {
  const ext = filePath.toLowerCase().match(/\.[^./\\]+$/)?.[0] || "";
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  const base = filePath.split(/[/\\]/).pop() || "";
  if (base === ".DS_Store") {
    return true;
  }
  if (content) {
    const checkSize = Math.min(content.length, BINARY_CHECK_SIZE);
    for (let i = 0; i < checkSize; i++) {
      if (content[i] === 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a file is binary by reading its first bytes
 *
 * @param filePath - Path to the file
 * @returns true if file appears to be binary
 */
export async function isBinaryFileAsync(filePath: string): Promise<boolean> {
  if (isBinaryFile(filePath)) {
    return true;
  }
  let bytes: Uint8Array;
  try {
    const file = Bun.file(filePath);
    const buffer = await file.slice(0, BINARY_CHECK_SIZE).arrayBuffer();
    bytes = new Uint8Array(buffer);
  } catch (err) {
    throw createImportError(
      `Failed to inspect imported file "${filePath}" for binary content.`,
      "IMPORT_FILE_READ_FAILED",
      {
        filePath,
        suggestion: "Verify the file exists and is readable before importing it.",
      },
      err
    );
  }
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

const PROJECT_ROOT_MARKERS = [
  ".git",
  "package.json",
  "mdflow.config.yaml",
  ".mdflow.yaml",
  ".mdflow.json",
];

/**
 * Expand a path that may start with ~ to use home directory
 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return filePath.replace("~", homedir());
  }
  return filePath;
}

/**
 * Discover a project root for import path boundary checks.
 * Preference order:
 * 1. Nearest directory containing common project markers (.git/package.json/etc.)
 * 2. Starting directory when no marker exists.
 */
export function detectProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  let previous = "";
  while (current !== previous) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (existsSync(join(current, marker))) {
        return current;
      }
    }
    previous = current;
    current = dirname(current);
  }
  return resolve(startDir);
}

export function getProjectRoot(currentFileDir: string, importCtx?: ImportContext): string {
  if (importCtx?._projectRoot) {
    return importCtx._projectRoot;
  }
  const discovered = importCtx?.invocationCwd
    ? resolve(importCtx.invocationCwd)
    : detectProjectRoot(currentFileDir);
  if (importCtx) {
    importCtx._projectRoot = discovered;
  }
  return discovered;
}

/**
 * Resolve an import path relative to the current file's directory
 */
export function canonicalCandidate(path: string): string {
  try { return realpathSync(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw err;
    return join(canonicalCandidate(dirname(path)), basename(path));
  }
}

export function containedImportPath(root: string, path: string): string {
  return sanitizePath(realpathSync(root), canonicalCandidate(path));
}

export function resolveImportPath(importPath: string, currentFileDir: string, projectRoot: string): string {
  return containedImportPath(projectRoot, resolve(currentFileDir, expandTilde(importPath)));
}
