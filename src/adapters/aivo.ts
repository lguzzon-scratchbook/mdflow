/**
 * aivo CLI adapter (`aivo` v0.50.0 — built-in agent + router over inner tools).
 *
 * Default: standalone one-shot `aivo code -p "<body>"` (no tools, no project
 * access — the hermetic shape). Interactive mode drops `-p`: `aivo code
 * "<body>"` opens the TUI seeded with the first message.
 *
 * Router mode per flow: `_subcommand: [run, <tool>]` (tool ∈ claude, codex,
 * gemini, opencode, pi, grok) + `p: false` to drop the `-p` default (it would
 * otherwise leak through to the inner tool). Prompt stays a bare positional
 * on all six inner tools. Future lever: `-e` agent mode (`e: true` +
 * positional body runs headless WITH tools; verified in `aivo code --help`).
 *
 * Ambient: no aivo-level isolation flags, system-prompt flags, or hooks
 * mechanism exist, so no getIsolationDefaults / applySystemPrompt /
 * applyHooks — like kimi. Auth is ambient via `aivo keys`; aivo pins
 * claude `--settings`, so mdflow hooks could never inject there anyway.
 * No prepareEnv.
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

export const aivoAdapter: ToolAdapter = {
  name: "aivo",

  getDefaults(): CommandDefaults {
    return {
      _subcommand: ["code"],
      p: true,
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // TUI is the default without -p; keep the code subcommand.
    delete result.p;
    return result;
  },
};

export default aivoAdapter;
