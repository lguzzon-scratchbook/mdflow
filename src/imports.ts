import { realpathSync } from "fs";
import { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";
import { substituteTemplateVars } from "./template";
import { parseImports as parseImportsSafe, hasImportsInContent } from "./imports-parser";
import type { ImportAction } from "./imports-types";
import { injectImports } from "./imports-injector";

// Command-inline resolvers live in imports-command.ts; re-exported here so
// existing importers (prompt-render, runtime) keep working unchanged.
export {
  ParallelDashboard,
  processCommandInline,
  runImportProcess,
  processExecutableCodeFence,
} from "./imports-command";

// URL resolvers live in imports-url.ts; re-exported here so existing
// importers keep working unchanged.
export {
  URL_ALLOWLIST_ENV_KEYS,
  URL_BLOCKLIST_ENV_KEYS,
  readUrlPolicyList,
  isAllowedContentType,
  inferContentType,
  processUrlImport,
} from "./imports-url";

// Re-export pipeline components for direct access
export { parseImports, hasImportsInContent, isGlobPattern, parseLineRange, parseSymbolExtraction } from "./imports-parser";
export { injectImports, createResolvedImport } from "./imports-injector";
export type { ImportAction, ResolvedImport, SystemEnvironment } from "./imports-types";
export { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";

/**
 * Expand markdown imports, URL imports, and command inlines
 *
 * Supports multiple syntaxes:
 * - @~/path/to/file.md or @./relative/path.md - Inline file contents
 * - @./src/**\/*.ts - Glob patterns (respects .gitignore)
 * - @./file.ts:10-50 - Line range extraction
 * - @./file.ts#SymbolName - Symbol extraction (interface, function, class, type, const)
 * - @https://example.com/docs or @http://... - Fetch URL content (markdown/json only)
 * - @git:diff, @git:status, @git:log(20), @tree, @rg:pattern - First-class context providers
 * - !`command` - Execute command and inline stdout/stderr
 *
 * Imports are processed recursively, with circular import detection.
 * URL imports validate content type - only markdown and json are allowed.
 *
 * ## Pipeline Architecture
 *
 * The import system is split into three phases:
 * 1. **Parser** (pure): `parseImports()` - scans content, returns ImportActions
 * 2. **Resolver** (impure): resolves actions via I/O (files, URLs, commands)
 * 3. **Injector** (pure): `injectImports()` - stitches resolved content back
 *
 * This separation enables thorough unit testing of regex parsing and injection
 * without filesystem dependencies.
 */

export type {
  ImportStack,
  ResolvedImportsTracker,
  ImportContext,
} from "./imports-shared";
import type {
  ImportStack,
  ResolvedImportsTracker,
  ImportContext,
} from "./imports-shared";
export {
  ImportBudget,
  MAX_TOKENS,
  WARN_TOKENS,
  CHARS_PER_TOKEN,
  MAX_CHARS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  getCommandTimeout,
  MAX_COMMAND_OUTPUT_SIZE,
  createImportError,
  ANSI_ESCAPE_REGEX,
  isMarkdownFileCommand,
  isBinaryFile,
  isBinaryFileAsync,
  expandTilde,
  detectProjectRoot,
  getProjectRoot,
  canonicalCandidate,
  containedImportPath,
  resolveImportPath,
} from "./imports-shared";
import {
  ImportBudget,
} from "./imports-shared";
import {
  ParallelDashboard,
  processCommandInline,
  processExecutableCodeFence,
} from "./imports-command";
import { processProviderImport, processFileImport } from "./imports-file";
import { processUrlImport } from "./imports-url";


/**
 * Resolve a path to its canonical form (resolving symlinks)
 * This ensures that symlinks to the same file are detected as identical
 * for cycle detection purposes.
 *
 * @param filePath - The path to resolve
 * @returns The canonical (real) path, or the original path if resolution fails
 */
export function toCanonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    // File might not exist yet, or other error - return original path
    return filePath;
  }
}

export type ExecutableImport = Extract<ImportAction, { type: "command" | "executable_code_fence" }>;
export type ContentImport = Exclude<ImportAction, ExecutableImport>;

export function isExecutableImport(action: ImportAction): action is ExecutableImport {
  return action.type === "command" || action.type === "executable_code_fence";
}

export async function resolveContentAction(
  action: ContentImport, dir: string, stack: ImportStack, verbose: boolean, ctx: ImportContext,
): Promise<string> {
  switch (action.type) {
    case "url":
      ctx.resolvedImports?.push(action.url);
      return processUrlImport(action.url, verbose, ctx);
    case "provider": {
      ctx.resolvedImports?.push(action.original);
      const content = await processProviderImport(action, dir, verbose, ctx);
      ctx.budget?.bytes(Buffer.byteLength(content));
      return content;
    }
    case "glob": return processFileImport(action.pattern, dir, stack, verbose, ctx);
    case "symbol": return processFileImport(action.path + "#" + action.symbol, dir, stack, verbose, ctx);
    case "file": {
      const range = action.lineRange;
      return processFileImport(range ? action.path + ":" + range.start + "-" + range.end : action.path, dir, stack, verbose, ctx);
    }
  }
}

/** Runs already bound actions, never discovers executable syntax in rendered text. */
export async function executeImportActions(
  actions: ExecutableImport[], dir: string, verbose: boolean, ctx: ImportContext, limit = DEFAULT_CONCURRENCY_LIMIT,
) {
  const gate = new Semaphore(limit);
  const dashboard = actions.length && process.stderr.isTTY && !verbose ? new ParallelDashboard() : null;
  dashboard?.start();
  try {
    return await Promise.all(actions.map((action, i) => gate.run(async () => {
      const id = String(i);
      dashboard?.register(id, action.type === "command" ? action.command : "Code (" + action.language + ")");
      try {
        const content = action.type === "command"
          ? await processCommandInline(action.command, dir, verbose, ctx, chunk => dashboard?.update(id, chunk), !!dashboard)
          : await processExecutableCodeFence(action, dir, verbose, ctx);
        return { action, content };
      } finally { dashboard?.finish(id); }
    })));
  } finally { dashboard?.stop(); }
}

export async function expandContentImports(
  source: string, dir: string, stack: ImportStack = new Set(), verbose = false,
  ctx: ImportContext = {}, limit = DEFAULT_CONCURRENCY_LIMIT,
): Promise<string> {
  const gate = new Semaphore(limit);
  ctx = { ...ctx, budget: ctx.budget ?? new ImportBudget() };
  const actions = parseImportsSafe(source).filter(a => !isExecutableImport(a));
  ctx.budget!.actions(actions.length, stack.size);
  return injectImports(source, await Promise.all(actions.map(action => gate.run(async () => ({
    action, content: await resolveContentAction(action, dir, stack, verbose, ctx),
  })))));
}

/** Low-level expansion of authored source without whole-prompt Liquid rendering. */
export async function expandImports(
  source: string, dir: string, stack: ImportStack = new Set(), verbose = false,
  contextOrTracker: ImportContext | ResolvedImportsTracker = {}, limit = DEFAULT_CONCURRENCY_LIMIT,
): Promise<string> {
  const ctx: ImportContext = Array.isArray(contextOrTracker) ? { resolvedImports: contextOrTracker, budget: new ImportBudget() } : { ...contextOrTracker, budget: contextOrTracker.budget ?? new ImportBudget() };
  const actions = parseImportsSafe(source);
  ctx.budget!.actions(actions.length, stack.size);
  const gate = new Semaphore(limit);
  const [data, commands] = await Promise.all([
    Promise.all(actions.filter(a => !isExecutableImport(a)).map(action => gate.run(async () => ({
      action, content: await resolveContentAction(action, dir, stack, verbose, ctx),
    })))),
    executeImportActions(actions.filter(isExecutableImport).map(action => action.type === "command" && ctx.templateVars && Object.keys(ctx.templateVars).length
      ? { ...action, command: substituteTemplateVars(action.command, ctx.templateVars) } : action), dir, verbose, ctx, limit),
  ]);
  return injectImports(source, [...data, ...commands]);
}

export const hasImports = hasImportsInContent;
export const hasContentImports = (source: string) => parseImportsSafe(source).some(a => !isExecutableImport(a));
export const hasCommandImports = (source: string) => parseImportsSafe(source).some(isExecutableImport);
