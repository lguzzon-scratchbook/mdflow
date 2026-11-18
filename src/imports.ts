import { resolve, dirname, relative, basename } from "path";
import { realpathSync, statSync } from "fs";
import { Glob } from "bun";
// Lazy-load heavy dependencies for cold start optimization
import { FileSizeLimitError, exceedsLimit } from "./limits";
import { estimateTokens, getContextLimit, countTokensAsync } from "./tokenizer";
import { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";
import { substituteTemplateVars } from "./template";
import { parseImports as parseImportsSafe, hasImportsInContent } from "./imports-parser";
import type { ImportAction, ProviderImportAction } from "./imports-types";
import { injectImports } from "./imports-injector";
import { ImportError, getErrorMessage } from "./errors";
import { runProvider, resolveContextProviderImport } from "./context-providers";

// Lazy-load ignore package (only needed for glob imports)
type IgnoreFactory = typeof import("ignore");
let _ignoreFactory: IgnoreFactory | null = null;
async function getIgnore(): Promise<IgnoreFactory> {
  if (!_ignoreFactory) {
    const mod = await import("ignore");
    _ignoreFactory = mod.default ?? mod;
  }
  return _ignoreFactory;
}

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
  createImportError,
  isBinaryFileAsync,
  expandTilde,
  getProjectRoot,
  containedImportPath,
  resolveImportPath,
} from "./imports-shared";
import {
  ParallelDashboard,
  processCommandInline,
  processExecutableCodeFence,
} from "./imports-command";
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

/**
 * Check if a path contains glob characters
 */
function isGlobPatternInternal(path: string): boolean {
  return path.includes("*") || path.includes("?") || path.includes("[");
}

/**
 * Parse import path for line range syntax: @./file.ts:10-50
 */
function parseLineRangeInternal(path: string): { path: string; start?: number; end?: number } {
  const match = path.match(/^(.+):(\d+)-(\d+)$/);
  if (match && match[1] && match[2] && match[3]) {
    return {
      path: match[1],
      start: parseInt(match[2], 10),
      end: parseInt(match[3], 10),
    };
  }
  return { path };
}

/**
 * Parse import path for symbol extraction: @./file.ts#SymbolName
 */
function parseSymbolExtractionInternal(path: string): { path: string; symbol?: string } {
  const match = path.match(/^(.+)#([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
  if (match && match[1] && match[2]) {
    return {
      path: match[1],
      symbol: match[2],
    };
  }
  return { path };
}

/**
 * Extract lines from content by range.
 * The END may run past EOF (a forgiving "to the end" range), but a START
 * beyond the file is an error: it selects nothing, and a flow that silently
 * imports empty context runs the engine with the evidence missing.
 */
function extractLines(content: string, start: number, end: number): string {
  const lines = content.split("\n");
  if (start > lines.length) {
    throw new Error(
      `Line range ${start}-${end} is out of range: the file has only ${lines.length} line${lines.length === 1 ? "" : "s"}`
    );
  }
  // Convert to 0-indexed, clamp the end to EOF
  const startIdx = Math.max(0, start - 1);
  const endIdx = Math.min(lines.length, end);
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Extract a symbol definition from TypeScript/JavaScript content
 * Supports: interface, type, function, class, const, let, var, enum
 */
function extractSymbol(content: string, symbolName: string): string {
  const lines = content.split("\n");

  // Patterns to match symbol declarations
  const patterns = [
    // interface Name { ... }
    new RegExp(`^(export\\s+)?interface\\s+${symbolName}\\s*(extends\\s+[^{]+)?\\{`),
    // type Name = ...
    new RegExp(`^(export\\s+)?type\\s+${symbolName}\\s*(<[^>]+>)?\\s*=`),
    // function Name(...) { ... }
    new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${symbolName}\\s*(<[^>]+>)?\\s*\\(`),
    // class Name { ... }
    new RegExp(`^(export\\s+)?(abstract\\s+)?class\\s+${symbolName}\\s*(extends\\s+[^{]+)?(implements\\s+[^{]+)?\\{`),
    // const/let/var Name = ...
    new RegExp(`^(export\\s+)?(const|let|var)\\s+${symbolName}\\s*(:[^=]+)?\\s*=`),
    // enum Name { ... }
    new RegExp(`^(export\\s+)?enum\\s+${symbolName}\\s*\\{`),
  ];

  let startLine = -1;
  let braceDepth = 0;
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";
  let foundDeclaration = false;

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    if (!currentLine) continue;
    const line = currentLine.trim();

    // Check if this line starts the symbol we're looking for
    if (startLine === -1) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          startLine = i;
          foundDeclaration = true;
          break;
        }
      }
    }

    if (startLine !== -1) {
      // Count braces/parens to find the end of the declaration
      for (let j = 0; j < currentLine.length; j++) {
        const char = currentLine[j];
        const prevChar = j > 0 ? currentLine[j - 1] : "";

        // Handle string literals
        if (!inString && (char === '"' || char === "'" || char === "`")) {
          inString = true;
          stringChar = char;
        } else if (inString && char === stringChar && prevChar !== "\\") {
          inString = false;
        }

        if (!inString) {
          if (char === "{") braceDepth++;
          else if (char === "}") braceDepth--;
          else if (char === "(") parenDepth++;
          else if (char === ")") parenDepth--;
        }
      }

      // Check if we've closed all braces (for block declarations)
      if (foundDeclaration && braceDepth === 0 && parenDepth === 0) {
        // For type aliases, we need to check for semicolon or end of statement
        const trimmedLine = currentLine.trim();
        const nextLine = lines[i + 1];
        if (trimmedLine.endsWith(";") || trimmedLine.endsWith("}") ||
            (i + 1 < lines.length && nextLine && !nextLine.trim().startsWith("."))) {
          return lines.slice(startLine, i + 1).join("\n");
        }
      }
    }
  }

  if (startLine !== -1) {
    // Return everything from start to end if we couldn't find proper closure
    return lines.slice(startLine).join("\n");
  }

  throw createImportError(
    `Symbol "${symbolName}" not found in imported file content.`,
    "IMPORT_FILE_READ_FAILED",
    {
      symbol: symbolName,
      suggestion: "Check the symbol name and ensure it is declared in the imported file.",
    }
  );
}

/**
 * Load .gitignore patterns from directory and parents
 * Lazy-loads the ignore package on first use
 */
async function loadGitignore(dir: string, projectRoot: string): Promise<ReturnType<Awaited<ReturnType<typeof getIgnore>>>> {
  const ignore = await getIgnore();
  const ig = ignore();

  // Always ignore common patterns
  ig.add([
    ".git",
    "node_modules",
    ".DS_Store",
    "*.log",
  ]);

  // Walk up to find .gitignore files
  let currentDir = dir;
  const root = realpathSync(projectRoot);

  while (true) {
    const gitignorePath = containedImportPath(root, resolve(currentDir, ".gitignore"));
    const file = Bun.file(gitignorePath);

    let gitignoreExists = false;
    try {
      gitignoreExists = await file.exists();
    } catch (err) {
      throw createImportError(
        `Failed to inspect ignore file "${gitignorePath}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          filePath: gitignorePath,
          suggestion: "Check read permissions for this directory and .gitignore file.",
        },
        err
      );
    }

    if (gitignoreExists) {
      try {
        if (!statSync(gitignorePath).isFile() || exceedsLimit(file.size)) throw new Error("expected a bounded, regular .gitignore file");
        const content = await file.text();
        ig.add(content.split("\n").filter(line => line.trim() && !line.startsWith("#")));
      } catch (err) {
        throw createImportError(
          `Failed to read ignore rules from "${gitignorePath}".`,
          "IMPORT_FILE_READ_FAILED",
          {
            filePath: gitignorePath,
            suggestion: "Ensure .gitignore is readable and encoded as UTF-8 text.",
          },
          err
        );
      }
    }

    // Stop at git root
    const gitDir = resolve(currentDir, ".git");
    let gitDirExists = false;
    try {
      gitDirExists = await Bun.file(gitDir).exists();
    } catch (err) {
      throw createImportError(
        `Failed while checking git root marker "${gitDir}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          filePath: gitDir,
          suggestion: "Verify directory permissions while resolving import glob roots.",
        },
        err
      );
    }

    if (gitDirExists || currentDir === root) {
      break;
    }

    currentDir = dirname(currentDir);
  }

  return ig;
}

function getContextProviderBudgetTokens(importCtx?: ImportContext): number | undefined {
  const budget = importCtx?._context_budget_tokens;
  if (budget === undefined || budget === null) {
    return undefined;
  }

  if (!Number.isFinite(budget)) {
    return undefined;
  }

  return Math.floor(budget);
}

type ProviderImportActionCompat = ProviderImportAction & {
  name?: string;
  subcommand?: string;
  arg?: string;
};

function getProviderInvocationSpec(
  action: ProviderImportAction
): { provider: string; argument?: string } {
  const compatAction = action as ProviderImportActionCompat;
  const compatArgument = compatAction.arg ?? compatAction.argument;
  const providerName = compatAction.name?.trim();
  const subcommand = compatAction.subcommand?.trim();

  if (providerName) {
    return {
      provider: subcommand ? `${providerName}:${subcommand}` : providerName,
      argument: compatArgument,
    };
  }

  return {
    provider: action.provider,
    argument: action.argument,
  };
}

async function processProviderImport(
  action: ProviderImportAction,
  currentFileDir: string,
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const providerCwd = importCtx?.invocationCwd ?? currentFileDir;
  const maxTokens = getContextProviderBudgetTokens(importCtx);
  const providerSpec = getProviderInvocationSpec(action);
  const providerAction: ProviderImportAction = {
    ...action,
    provider: providerSpec.provider as ProviderImportAction["provider"],
    argument: providerSpec.argument,
  };

  if (verbose) {
    console.error(`[imports] Expanding context provider: ${action.original}`);
  }

  try {
    if (providerCwd === process.cwd()) {
      return await runProvider(providerSpec.provider, providerSpec.argument, maxTokens);
    }

    return await resolveContextProviderImport(providerAction, {
      cwd: providerCwd,
      maxTokens,
    });
  } catch (err) {
    throw createImportError(
      `Failed to resolve context provider "${action.original}": ${getErrorMessage(err)}`,
      "IMPORT_COMMAND_FAILED",
      {
        provider: providerSpec.provider,
        providerArgument: providerSpec.argument,
        cwd: providerCwd,
        maxTokens,
        suggestion: "Verify provider syntax and ensure required binaries (git/rg/tree/find) are installed.",
      },
      err
    );
  }
}

/**
 * Format files as XML for LLM consumption
 */
function formatFilesAsXml(files: Array<{ path: string; content: string }>): string {
  return files.map(file => {
    const name = basename(file.path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "_$1") || "file";
    return `<${name} path="${file.path}">\n${file.content}\n</${name}>`;
  }).join("\n\n");
}

/**
 * Extract the static prefix from a glob pattern (everything before the first wildcard)
 * Returns the directory portion that can be resolved as a path.
 */
function extractGlobBaseDir(pattern: string, currentFileDir: string): string {
  // Find the first glob character
  const firstWildcard = Math.min(
    ...[pattern.indexOf('*'), pattern.indexOf('?'), pattern.indexOf('[')]
      .filter(i => i !== -1)
      .concat([pattern.length]) // fallback if no wildcards
  );

  // Get everything before the wildcard
  const staticPrefix = pattern.slice(0, firstWildcard);

  // Find the last directory separator in the static prefix
  const lastSlash = staticPrefix.lastIndexOf('/');
  const dirPart = lastSlash === -1 ? '' : staticPrefix.slice(0, lastSlash);

  // Resolve the directory part
  if (pattern.startsWith('/')) {
    return dirPart || '/';
  }
  return resolve(currentFileDir, dirPart || '.');
}

/**
 * Process a glob import pattern
 */
async function processGlobImport(
  pattern: string,
  currentFileDir: string,
  projectRoot: string,
  verbose: boolean,
  budget?: ImportBudget,
): Promise<string> {
  const resolvedPattern = expandTilde(pattern);

  // Calculate the actual base directory for the glob
  // This handles patterns like "../../**/*.rs" by resolving the static prefix
  const unsafeGlobBaseDir = extractGlobBaseDir(resolvedPattern, currentFileDir);
  let globBaseDir: string;
  try {
    globBaseDir = containedImportPath(projectRoot, unsafeGlobBaseDir);
  } catch (err) {
    throw createImportError(
      `Glob import "${pattern}" escapes project root "${projectRoot}".`,
      "IMPORT_FILE_READ_FAILED",
      {
        pattern,
        projectRoot,
        suggestion: "Keep glob imports within the current project root.",
      },
      err
    );
  }

  if (verbose) {
    console.error(`[imports] Glob pattern: ${resolvedPattern} (base: ${globBaseDir})`);
  }

  // Load gitignore from the glob's base directory, not the agent file's directory
  const ig = await loadGitignore(globBaseDir, projectRoot);

  // Collect matching files
  // Use the resolved base directory as cwd for proper pattern matching
  const glob = new Glob(resolvedPattern.startsWith("/") ? resolvedPattern : pattern.replace(/^\.\//, ""));
  const files: Array<{ path: string; content: string }> = [];

  const skippedBinaryFiles: string[] = [];

  try {
    for await (const file of glob.scan({ cwd: currentFileDir, absolute: true, onlyFiles: true })) {
      let safeFilePath: string;
      try {
        safeFilePath = containedImportPath(projectRoot, file);
      } catch (err) {
        throw createImportError(
          `Glob import "${pattern}" resolved a path outside project root.`,
          "IMPORT_FILE_READ_FAILED",
          {
            pattern,
            filePath: file,
            projectRoot,
            suggestion: "Adjust the glob pattern so it stays within project boundaries.",
          },
          err
        );
      }

      // Check gitignore - calculate relative path from the glob's base directory
      // This ensures paths don't start with "../" which the ignore package can't handle
      const relativePath = relative(globBaseDir, safeFilePath);

      // Skip paths that are still outside the glob base (shouldn't happen, but safety check)
      if (relativePath.startsWith('..')) {
        if (verbose) {
          console.error(`[imports] Skipping file outside glob base: ${file}`);
        }
        continue;
      }

      if (ig.ignores(relativePath)) {
        continue;
      }

      // Check if file is binary (skip with warning in glob imports)
      if (await isBinaryFileAsync(safeFilePath)) {
        skippedBinaryFiles.push(relativePath);
        continue;
      }

      const bunFile = Bun.file(safeFilePath);

      // Check individual file size before reading
      if (exceedsLimit(bunFile.size)) {
        throw new FileSizeLimitError(file, bunFile.size);
      }

      budget?.actions(1, 0);
      budget?.bytes(bunFile.size);
      try {
        const content = await bunFile.text();
        files.push({ path: relativePath, content });
      } catch (err) {
        throw createImportError(
          `Failed to read file "${file}" while expanding glob "${pattern}".`,
          "IMPORT_FILE_READ_FAILED",
          {
            filePath: safeFilePath,
            pattern,
            suggestion: "Check file permissions and encoding, then retry the import.",
          },
          err
        );
      }
    }
  } catch (err) {
    if (err instanceof ImportError || err instanceof FileSizeLimitError) {
      throw err;
    }
    throw createImportError(
      `Failed to expand glob import "${pattern}" from "${currentFileDir}".`,
      "IMPORT_FILE_READ_FAILED",
      {
        pattern,
        currentFileDir,
        suggestion: "Verify the glob path exists and that directories are readable.",
      },
      err
    );
  }

  // Log warning about skipped binary files
  if (skippedBinaryFiles.length > 0 && verbose) {
    console.error(`[imports] Skipped ${skippedBinaryFiles.length} binary file(s): ${skippedBinaryFiles.join(", ")}`);
  }

  // A glob that matched nothing usually means a typo'd pattern — the flow
  // would run with its context silently missing. Warn (not error: an
  // optional catch-all like @./docs/**/*.md can legitimately be empty).
  if (files.length === 0) {
    console.error(
      `Warning [GLOB_NO_MATCHES]: import glob "${pattern}" matched no files — the flow runs without that context.`
    );
  }

  // Sort by path for consistent ordering
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Get context limit (use env vars for model/limit override)
  const contextLimit = getContextLimit(
    process.env.MA_MODEL,
    Number(process.env.MA_CONTEXT_WINDOW) || undefined
  );

  // Use cheap token estimate first (chars / 4) for fast bailout
  const allContent = files.map((f) => f.content).join("\n");
  const estimatedTokens = estimateTokens(allContent);

  // Fast path: if estimate is well within limits, skip expensive tokenization
  let actualTokens: number;
  const needsAccurateCount = estimatedTokens > contextLimit * 0.7; // Near limit - need accurate count

  if (needsAccurateCount) {
    // Near the limit - do accurate count (lazy-loads tokenizer)
    actualTokens = await countTokensAsync(allContent);
  } else {
    // Well under limit - use estimate
    actualTokens = estimatedTokens;
  }

  // Always log glob expansion to stderr for visibility
  console.error(
    `[imports] Expanding ${pattern}: ${files.length} files (~${actualTokens.toLocaleString()} tokens${needsAccurateCount ? "" : " est"})`
  );

  // Error threshold - use dynamic context limit. MDFLOW_FORCE_CONTEXT is the
  // v3 name; MA_FORCE_CONTEXT remains as a legacy alias.
  const forceContext = process.env.MDFLOW_FORCE_CONTEXT || process.env.MA_FORCE_CONTEXT;
  if (actualTokens > contextLimit && !forceContext) {
    throw createImportError(
      `Glob import "${pattern}" would include ~${actualTokens.toLocaleString()} tokens (${files.length} files), ` +
      `which exceeds the ${contextLimit.toLocaleString()} token limit.`,
      "IMPORT_FILE_READ_FAILED",
      {
        pattern,
        tokenCount: actualTokens,
        contextLimit,
        suggestion: "Narrow the glob, or set MDFLOW_FORCE_CONTEXT=1 to override intentionally.",
      }
    );
  }

  // Warning threshold (50% of limit) - warn but don't error
  const warnThreshold = Math.floor(contextLimit * 0.5);
  if (actualTokens > warnThreshold && actualTokens <= contextLimit) {
    console.error(
      `[imports] Warning: High token count (~${actualTokens.toLocaleString()}). This may be expensive.`
    );
  }

  return formatFilesAsXml(files);
}

/**
 * Process a single file import (with optional line range or symbol extraction)
 */
async function processFileImport(
  importPath: string,
  currentFileDir: string,
  stack: ImportStack,
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const resolvedImports = importCtx?.resolvedImports;
  const projectRoot = getProjectRoot(currentFileDir, importCtx);

  const resolveSafeImportPath = (rawPath: string): string => {
    try {
      return resolveImportPath(rawPath, currentFileDir, projectRoot);
    } catch (err) {
      throw createImportError(
        `Blocked import path "${rawPath}": ${getErrorMessage(err)}`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: rawPath,
          projectRoot,
          suggestion: "Keep imports within the project root or adjust invocation cwd.",
        },
        err
      );
    }
  };

  const ensureImportExists = async (resolvedPath: string, originalPath: string): Promise<ReturnType<typeof Bun.file>> => {
    const file = Bun.file(resolvedPath);
    let exists = false;
    try {
      exists = await file.exists();
    } catch (err) {
      throw createImportError(
        `Failed to check imported path "${resolvedPath}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: originalPath,
          resolvedPath,
          suggestion: "Check file permissions and verify the path is accessible.",
        },
        err
      );
    }
    if (!exists) {
      throw createImportError(
        `Import not found: ${originalPath} (resolved to ${resolvedPath})`,
        "IMPORT_FILE_NOT_FOUND",
        {
          importPath: originalPath,
          resolvedPath,
          suggestion: "Confirm the file exists and that relative paths are correct.",
        }
      );
    }
    if (!statSync(resolvedPath).isFile()) throw createImportError(`Not a regular file: ${originalPath}`, "IMPORT_FILE_READ_FAILED", { resolvedPath });
    return file;
  };

  const readImportText = async (file: ReturnType<typeof Bun.file>, resolvedPath: string, originalPath: string): Promise<string> => {
    importCtx?.budget?.bytes(file.size);
    try {
      return await file.text();
    } catch (err) {
      throw createImportError(
        `Failed to read imported file "${resolvedPath}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: originalPath,
          resolvedPath,
          suggestion: "Verify read permissions and that the file is valid UTF-8 text.",
        },
        err
      );
    }
  };

  // Check for glob pattern first
  if (isGlobPatternInternal(importPath)) {
    return processGlobImport(importPath, currentFileDir, projectRoot, verbose, importCtx?.budget);
  }

  // Check for symbol extraction syntax
  const symbolParsed = parseSymbolExtractionInternal(importPath);
  if (symbolParsed.symbol) {
    const resolvedPath = resolveSafeImportPath(symbolParsed.path);

    const file = await ensureImportExists(resolvedPath, symbolParsed.path);

    // Check file size before reading
    if (exceedsLimit(file.size)) {
      throw new FileSizeLimitError(resolvedPath, file.size);
    }

    // Check for binary file (throw error for direct imports)
    if (await isBinaryFileAsync(resolvedPath)) {
      throw createImportError(
        `Cannot import binary file: ${symbolParsed.path} (resolved to ${resolvedPath})`,
        "IMPORT_BINARY_FILE",
        {
          importPath: symbolParsed.path,
          resolvedPath,
          suggestion: "Import a text file, or convert binary content to text before importing.",
        }
      );
    }

    if (verbose) {
      console.error(`[imports] Extracting symbol "${symbolParsed.symbol}" from: ${symbolParsed.path}`);
    }

    const content = await readImportText(file, resolvedPath, symbolParsed.path);
    // Track the resolved import
    if (resolvedImports) {
      resolvedImports.push(importPath);
    }
    try {
      return extractSymbol(content, symbolParsed.symbol);
    } catch (err) {
      throw createImportError(
        `Failed to extract symbol "${symbolParsed.symbol}" from "${resolvedPath}": ${getErrorMessage(err)}`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: symbolParsed.path,
          resolvedPath,
          symbol: symbolParsed.symbol,
          suggestion: "Verify the symbol name exists and is exported in the target file.",
        },
        err
      );
    }
  }

  // Check for line range syntax
  const rangeParsed = parseLineRangeInternal(importPath);
  if (rangeParsed.start !== undefined && rangeParsed.end !== undefined) {
    const resolvedPath = resolveSafeImportPath(rangeParsed.path);

    const file = await ensureImportExists(resolvedPath, rangeParsed.path);

    // Check file size before reading
    if (exceedsLimit(file.size)) {
      throw new FileSizeLimitError(resolvedPath, file.size);
    }

    // Check for binary file (throw error for direct imports)
    if (await isBinaryFileAsync(resolvedPath)) {
      throw createImportError(
        `Cannot import binary file: ${rangeParsed.path} (resolved to ${resolvedPath})`,
        "IMPORT_BINARY_FILE",
        {
          importPath: rangeParsed.path,
          resolvedPath,
          suggestion: "Import a text file instead of binary data.",
        }
      );
    }

    if (verbose) {
      console.error(`[imports] Loading lines ${rangeParsed.start}-${rangeParsed.end} from: ${rangeParsed.path}`);
    }

    const content = await readImportText(file, resolvedPath, rangeParsed.path);
    // Track the resolved import
    if (resolvedImports) {
      resolvedImports.push(importPath);
    }
    return extractLines(content, rangeParsed.start, rangeParsed.end);
  }

  // Regular file import
  const resolvedPath = resolveSafeImportPath(importPath);

  // Check if file exists first (needed for canonical path resolution)
  const file = await ensureImportExists(resolvedPath, importPath);

  // Resolve to canonical path for cycle detection (handles symlinks)
  const canonicalPath = toCanonicalPath(resolvedPath);

  // Check for circular imports using canonical path
  if (stack.has(canonicalPath)) {
    const cycle = [...stack, canonicalPath].join(" -> ");
    throw createImportError(
      `Circular import detected: ${cycle}`,
      "IMPORT_CIRCULAR_DEPENDENCY",
      {
        importPath,
        resolvedPath,
        cycle,
        suggestion: "Break the cycle by removing at least one import in the chain.",
      }
    );
  }

  // Check file size before reading
  if (exceedsLimit(file.size)) {
    throw new FileSizeLimitError(resolvedPath, file.size);
  }

  // Check for binary file (throw error for direct imports)
  if (await isBinaryFileAsync(resolvedPath)) {
    throw createImportError(
      `Cannot import binary file: ${importPath} (resolved to ${resolvedPath})`,
      "IMPORT_BINARY_FILE",
      {
        importPath,
        resolvedPath,
        suggestion: "Import text/markdown/json files only.",
      }
    );
  }

  // Always log file loading to stderr for visibility
  console.error(`[imports] Loading: ${importPath}`);

  // Track the resolved import
  if (resolvedImports) {
    resolvedImports.push(importPath);
  }

  // Read file content
  const content = await readImportText(file, resolvedPath, importPath);

  // Recursively process imports in the imported file
  // Use canonical path in stack for consistent cycle detection
  const newStack = new Set(stack);
  newStack.add(canonicalPath);

  // Nested @ imports may supply more context, never new executable actions.
  return expandContentImports(content, dirname(resolvedPath), newStack, verbose, importCtx);
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
