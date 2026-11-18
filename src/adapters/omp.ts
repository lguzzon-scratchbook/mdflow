/**
 * oh-my-pi CLI adapter (`omp` 18.3.2 — "oh-my-pi", pi fork).
 *
 * Print mode: `-p/--print` with a positional prompt (bare `omp -p "<body>"`).
 * Interactive mode: bare positional prompt, drop --print.
 *
 * NOT hermetic: omp 18.3.2 exposes no `--no-prompt-templates` /
 * `--no-context-files` equivalents, so ambient config.yml still loads.
 * Verified isolation flags: --no-extensions, --no-skills, --no-rules,
 * --no-session. `--no-tools`/`--no-lsp`/`--no-pty` are capability kills,
 * not ambient-context strips, so they stay out of the isolation layer.
 * Auth/sessions stay ambient (~/.omp/agent); no prepareEnv — omp and pi
 * share the PI_CODING_AGENT_DIR name but are separate products, and
 * pointing omp at the pi bridge dir risks auth.json corruption.
 * Future lever: --profile / OMP_PROFILE (verified in --help, unprobed).
 *
 * System prompt: --system-prompt replaces; --append-system-prompt takes a
 * single value (help marks repeatable flags explicitly and does not for
 * this one), so append segments join. No applyHooks — --hook/-e protocol
 * compatibility with the mdflow stdin/stdout contract is unverified, so a
 * flow WITH a hooks file fails loudly like droid.
 */

import type {
  ToolAdapter,
  CommandDefaults,
  AgentFrontmatter,
  SystemPromptSpec,
  SystemPromptTranslation,
} from "../types";

export const ompAdapter: ToolAdapter = {
  name: "omp",

  getDefaults(): CommandDefaults {
    return {
      print: true,
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    delete result.print;
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return {
      "no-extensions": true,
      "no-skills": true,
      "no-rules": true,
      "no-session": true,
    };
  },

  applySystemPrompt(spec: SystemPromptSpec): SystemPromptTranslation {
    const frontmatter: Record<string, string> = {};
    if (spec.replace !== undefined) frontmatter["system-prompt"] = spec.replace;
    if (spec.append && spec.append.length > 0) {
      // omp takes a single --append-system-prompt value; join segments.
      frontmatter["append-system-prompt"] = spec.append.join("\n\n");
    }
    return { frontmatter };
  },
};

export default ompAdapter;
