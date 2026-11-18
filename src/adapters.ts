/**
 * Portable adapter registry for provider-agnostic frontmatter translation.
 *
 * This file also re-exports legacy tool-adapter registry helpers used by
 * config.ts (print/interactive defaults).
 */

import type { Adapter, AgentFrontmatter } from "./types";

// Re-export legacy adapter registry API for config/defaults compatibility.
export {
  registerAdapter,
  getAdapter,
  hasAdapter,
  getRegisteredAdapters,
  getDefaultAdapter,
  buildBuiltinDefaults,
  clearAdapterRegistry,
  defaultAdapter,
} from "./adapters/index";

export type { ToolAdapter } from "./types";

type CanonicalPortableKey = "model" | "temperature" | "max-tokens";
type ProviderKeyMap = Record<CanonicalPortableKey, string>;

const MAX_TOKENS_ALIASES = ["max_tokens", "maxTokens"] as const;

function normalizeCanonicalKeys(frontmatter: AgentFrontmatter): AgentFrontmatter {
  const normalized = { ...frontmatter };

  if (normalized["max-tokens"] === undefined) {
    for (const alias of MAX_TOKENS_ALIASES) {
      const aliasedValue = normalized[alias];
      if (aliasedValue !== undefined) {
        normalized["max-tokens"] = aliasedValue;
        break;
      }
    }
  }

  for (const alias of MAX_TOKENS_ALIASES) {
    delete normalized[alias];
  }

  return normalized;
}

function translateCanonicalKeys(
  frontmatter: AgentFrontmatter,
  keyMap: ProviderKeyMap,
  capabilities: Adapter["capabilities"]
): AgentFrontmatter {
  const translated = { ...frontmatter };

  if (!capabilities.model) delete translated.model;
  if (!capabilities.temperature) delete translated.temperature;
  if (!capabilities.maxTokens) delete translated["max-tokens"];

  const mappings: Array<[CanonicalPortableKey, string]> = [
    ["model", keyMap.model],
    ["temperature", keyMap.temperature],
    ["max-tokens", keyMap["max-tokens"]],
  ];

  for (const [canonicalKey, providerKey] of mappings) {
    if (providerKey === canonicalKey) continue;
    const value = translated[canonicalKey];
    if (value === undefined) continue;

    // Prefer explicitly provider-specific key if user already set one.
    if (translated[providerKey] === undefined) {
      translated[providerKey] = value;
    }
    delete translated[canonicalKey];
  }

  return translated;
}

function createPortableAdapter(
  name: string,
  keyMap: ProviderKeyMap,
  capabilities: Adapter["capabilities"] = {
    model: true,
    temperature: true,
    maxTokens: true,
  }
): Adapter {
  return {
    name,
    capabilities,
    normalizeFrontmatter(frontmatter: AgentFrontmatter): AgentFrontmatter {
      const normalized = normalizeCanonicalKeys(frontmatter);
      return translateCanonicalKeys(normalized, keyMap, capabilities);
    },
    buildArgs(
      frontmatter: AgentFrontmatter,
      templateVars: Set<string>,
      buildGenericArgs: (frontmatter: AgentFrontmatter, templateVars: Set<string>) => string[]
    ): string[] {
      const normalized = this.normalizeFrontmatter(frontmatter);
      return buildGenericArgs(normalized, templateVars);
    },
  };
}

export const claudePortableAdapter = createPortableAdapter("claude", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-tokens",
});

export const codexPortableAdapter = createPortableAdapter("codex", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-output-tokens",
});

export const geminiPortableAdapter = createPortableAdapter("gemini", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-output-tokens",
});

export const copilotPortableAdapter = createPortableAdapter("copilot", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-completion-tokens",
});

export const droidPortableAdapter = createPortableAdapter("droid", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-tokens",
});

export const opencodePortableAdapter = createPortableAdapter("opencode", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-tokens",
});

// Model-only engines: --model is supported; temperature and max-tokens are
// unexposed or unconfirmed upstream, so those keys are dropped, not passed.
// Per-engine notes: pi (optional ":<thinking>" suffix), agy (unconfirmed),
// grok/kimi/omp (absent from --help), cursor-agent (model only),
// aivo (consumed by aivo itself as -m/--model).
function modelOnlyPortableAdapter(name: string): Adapter {
  return createPortableAdapter(
    name,
    { model: "model", temperature: "temperature", "max-tokens": "max-tokens" },
    { model: true, temperature: false, maxTokens: false }
  );
}

export const piPortableAdapter = modelOnlyPortableAdapter("pi");
export const cursorAgentPortableAdapter = modelOnlyPortableAdapter("cursor-agent");
export const agyPortableAdapter = modelOnlyPortableAdapter("agy");
export const grokPortableAdapter = modelOnlyPortableAdapter("grok");
export const kimiPortableAdapter = modelOnlyPortableAdapter("kimi");
export const ompPortableAdapter = modelOnlyPortableAdapter("omp");
export const aivoPortableAdapter = modelOnlyPortableAdapter("aivo");

const PORTABLE_ADAPTERS: Record<string, Adapter> = {
  claude: claudePortableAdapter,
  codex: codexPortableAdapter,
  gemini: geminiPortableAdapter,
  copilot: copilotPortableAdapter,
  droid: droidPortableAdapter,
  opencode: opencodePortableAdapter,
  pi: piPortableAdapter,
  "cursor-agent": cursorAgentPortableAdapter,
  agy: agyPortableAdapter,
  grok: grokPortableAdapter,
  kimi: kimiPortableAdapter,
  omp: ompPortableAdapter,
  aivo: aivoPortableAdapter,
};

/**
 * Look up portable adapter by command/provider name.
 */
export function getPortableAdapter(command: string): Adapter | undefined {
  return PORTABLE_ADAPTERS[command.trim().toLowerCase()];
}

/**
 * List known portable provider adapters.
 */
export function getPortableAdapterNames(): string[] {
  return Object.keys(PORTABLE_ADAPTERS);
}
