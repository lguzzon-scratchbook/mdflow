/**
 * Command-inline resolvers, extracted from imports.ts (seam: smallest surface).
 *
 * Owns the executable half of the import pipeline: !`cmd` inlines and
 * executable code fences. Depends on shared.ts for context/error helpers only.
 */

import { join } from "path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "os";
import { MAX_INPUT_SIZE, exceedsLimit } from "./limits";
import { getErrorMessage } from "./errors";
import { escapeShellArg } from "./security";
import { getProcessManager } from "./process-manager";
import {
  ANSI_ESCAPE_REGEX,
  createImportError,
  getCommandTimeout,
  isMarkdownFileCommand,
  MAX_COMMAND_OUTPUT_SIZE,
  type ImportContext,
} from "./imports-shared";

/**
 * TTY Dashboard for monitoring parallel command execution
 * Handles rendering stacked spinners and live output previews
 */
export class ParallelDashboard {
  private items: Map<string, { command: string; status: string; frame: number }> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private isTTY: boolean;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private linesRendered = 0;

  constructor() {
    this.isTTY = process.stderr.isTTY ?? false;
  }

  start() {
    if (!this.isTTY) return;
    process.stderr.write('\x1B[?25l'); // Hide cursor
    this.interval = setInterval(() => this.render(), 80);
  }

  stop() {
    if (!this.isTTY) return;
    if (this.interval) clearInterval(this.interval);
    this.clear();
    process.stderr.write('\x1B[?25h'); // Show cursor
  }

  register(id: string, command: string) {
    // Truncate command visual if too long
    const displayCmd = command.length > 40 ? command.slice(0, 37) + '...' : command;
    this.items.set(id, { command: displayCmd, status: 'Starting...', frame: 0 });
  }

  update(id: string, chunk: string) {
    const item = this.items.get(id);
    if (item) {
      // Clean newlines and take last 15 chars
      const clean = chunk.replace(/[\r\n]/g, ' ').trim();
      const preview = clean.length > 15 ? '...' + clean.slice(-15) : clean;
      item.status = preview || item.status;
    }
  }

  finish(id: string) {
    this.items.delete(id);
    this.render(); // Immediate update to remove line
  }

  private clear() {
    if (this.linesRendered > 0) {
      // Move up linesRendered times and clear screen down
      process.stderr.write(`\x1B[${this.linesRendered}A`);
      process.stderr.write('\x1B[0J');
      this.linesRendered = 0;
    }
  }

  private render() {
    this.clear();

    const lines: string[] = [];

    for (const [_, item] of this.items) {
      item.frame = (item.frame + 1) % this.spinnerFrames.length;
      const spinner = this.spinnerFrames[item.frame];
      // Format: ⠋ command : last output
      lines.push(`${spinner} ${item.command} : \x1B[90m${item.status}\x1B[0m`);
    }

    if (lines.length > 0) {
      process.stderr.write(lines.join('\n') + '\n');
      this.linesRendered = lines.length;
    }
  }
}

export async function processCommandInline(
  command: string,
  currentFileDir: string,
  verbose: boolean,
  importCtx?: ImportContext,
  onProgress?: (chunk: string) => void,
  useDashboard: boolean = false
): Promise<string> {
  const isWin = platform() === "win32";

  // Already rendered exactly once from authored source.
  const processedCommand = command;

  // Auto-prefix markdown files with `mdflow` to run them as agents
  let actualCommand = processedCommand;
  if (isMarkdownFileCommand(processedCommand)) {
    const trimmed = processedCommand.trim();
    const firstSpace = trimmed.search(/\s/);
    const markdownPath = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const trailingArgs = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trimStart();
    const escapedMarkdownPath = escapeShellArg(markdownPath, isWin ? "win32" : "posix");
    actualCommand = `mdflow ${escapedMarkdownPath}${trailingArgs ? ` ${trailingArgs}` : ""}`;
    console.error(`[imports] Auto-running .md file with mdflow: ${actualCommand}`);
  }

  // Dry-run safety: report the command without claiming or attempting execution.
  if (importCtx?.dryRun) {
    console.error(`[imports] Dry-run: Skipping execution of '${actualCommand}'`);
    return `[Dry Run: Command "${actualCommand}" not executed]`;
  }

  // Always log command execution unless dashboard is active (it shows progress)
  if (!useDashboard) {
    console.error(`[imports] Executing: ${processedCommand}`);
  }

  // Use importCtx.env if provided, otherwise fall back to process.env
  const env = importCtx?.env ?? process.env;

  // Use invocationCwd for command execution if provided (allows agents in ~/.mdflow
  // to run commands in the user's current directory), fall back to file directory
  const commandCwd = importCtx?.invocationCwd ?? currentFileDir;

  // Improvement #5: Cross-platform shell support
  const shell = isWin ? "cmd.exe" : "sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", actualCommand] : ["-c", actualCommand];

  return runImportProcess([shell, ...shellArgs], commandCwd, env, "Inline command", onProgress);
}

/** Both executable syntaxes own a process group, drain both pipes, and keep
 * the deadline live through child exit (even after the pipes close). */
export async function runImportProcess(argv: string[], cwd: string, env: Record<string, string | undefined>, label: string, progress?: (text: string) => void): Promise<string> {
  const pm = getProcessManager();
  pm.signal.throwIfAborted();
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
  pm.register(proc, label);
  const kill = () => {
    try { if (process.platform !== "win32") { process.kill(-proc.pid, "SIGKILL"); return; } } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  };
  let bytes = 0;
  const collect = async (stream: ReadableStream<Uint8Array>, update?: (text: string) => void) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (exceedsLimit(bytes)) throw new Error("combined output exceeds 10MB limit");
      chunks.push(chunk);
      update?.(new TextDecoder().decode(chunk));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.subarray(0, 1024).includes(0)) throw new Error("returned binary data");
    return buffer.toString("utf8").trim().replace(ANSI_ESCAPE_REGEX, "");
  };
  const ms = getCommandTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([collect(proc.stdout, progress), collect(proc.stderr), proc.exited]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
    if (code !== 0) throw new Error(`Exit ${code}: ${(stderr || stdout || "No output").slice(0, 4000)}`);
    const output = (label === "Code fence" ? [stdout, stderr] : [stderr, stdout]).filter(Boolean).join("\n");
    return output.length <= MAX_COMMAND_OUTPUT_SIZE ? output : output.slice(0, MAX_COMMAND_OUTPUT_SIZE) +
      `\n... [Output truncated: ${(output.length - MAX_COMMAND_OUTPUT_SIZE).toLocaleString()} characters removed]`;
  } catch (cause) {
    kill();
    await proc.exited;
    throw createImportError(`${label} failed: ${getErrorMessage(cause)}`, "IMPORT_COMMAND_FAILED", { cwd }, cause);
  } finally { clearTimeout(timer); pm.unregister(proc); }
}

export async function processExecutableCodeFence(
  action: { shebang: string; language: string; code: string }, dir: string, verbose: boolean, ctx?: ImportContext,
): Promise<string> {
  if (ctx?.dryRun) return "[Dry Run: Code fence not executed]";
  const temp = await mkdtemp(join(tmpdir(), "mdflow-fence-"));
  try {
    const ext = /^[a-zA-Z0-9]+$/.test(action.language) ? action.language : "script";
    const path = join(temp, "script." + ext);
    await writeFile(path, action.shebang + "\n" + action.code, { flag: "wx", mode: 0o700 });
    console.error(`[imports] Executing code fence (${ext}): ${action.shebang}`);
    return await runImportProcess([path], ctx?.invocationCwd ?? dir, ctx?.env ?? process.env, "Code fence");
  } finally { await rm(temp, { recursive: true, force: true }); }
}

// Re-export for callers that reach the 10MB input cap through this module.
export { MAX_INPUT_SIZE };
