/**
 * URL-import resolvers, extracted from imports.ts.
 *
 * Owns the URL kind of the import pipeline: allow/blocklist policy,
 * content-type gating, and fetch. Depends on imports-shared for
 * context/error helpers only.
 */

import { fetchTextResource } from "./fetch";
import { ImportError, getErrorMessage } from "./errors";
import { validateUrl } from "./security";
import {
  createImportError,
  type ImportContext,
} from "./imports-shared";

export const URL_ALLOWLIST_ENV_KEYS = [
  "MDFLOW_IMPORT_URL_ALLOWLIST",
  "MDFLOW_URL_ALLOWLIST",
] as const;

export const URL_BLOCKLIST_ENV_KEYS = [
  "MDFLOW_IMPORT_URL_BLOCKLIST",
  "MDFLOW_URL_BLOCKLIST",
] as const;

function parseListFromEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function readUrlPolicyList(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): string[] {
  for (const key of keys) {
    const value = env[key];
    if (value) {
      return parseListFromEnv(value);
    }
  }
  return [];
}

/**
 * Allowed content types for URL imports
 */
const ALLOWED_CONTENT_TYPES = [
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/json",
  "application/x-json",
  "text/json",
];

/**
 * Check if a content type is allowed
 */
export function isAllowedContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  // Extract the base type (ignore charset and other params)
  const baseType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(baseType);
}

/**
 * Determine if content looks like markdown or JSON
 * Used when content-type header is missing or generic
 */
export function inferContentType(content: string, url: string): "markdown" | "json" | "unknown" {
  const trimmed = content.trim();

  // Check if it looks like JSON
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON
    }
  }

  // Check URL extension
  const urlLower = url.toLowerCase();
  if (urlLower.endsWith(".md") || urlLower.endsWith(".markdown")) {
    return "markdown";
  }
  if (urlLower.endsWith(".json")) {
    return "json";
  }

  // Check for common markdown patterns
  if (trimmed.startsWith("#") ||
      trimmed.includes("\n#") ||
      trimmed.includes("\n- ") ||
      trimmed.includes("\n* ") ||
      trimmed.includes("```")) {
    return "markdown";
  }

  return "unknown";
}

/**
 * Process a URL import by fetching and validating content
 */
export async function processUrlImport(
  url: string,
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const policyEnv = importCtx?.policyEnv ?? importCtx?.env ?? process.env;
  const allowlist = readUrlPolicyList(policyEnv, URL_ALLOWLIST_ENV_KEYS);
  const blocklist = readUrlPolicyList(policyEnv, URL_BLOCKLIST_ENV_KEYS);

  let validatedUrl: URL;
  try {
    validatedUrl = validateUrl(url, { allowlist, blocklist });
  } catch (err) {
    throw createImportError(
      `Blocked URL import "${url}": ${getErrorMessage(err)}`,
      "IMPORT_URL_FETCH_FAILED",
      {
        url,
        allowlistEnabled: allowlist.length > 0,
        blocklistEnabled: blocklist.length > 0,
        suggestion:
          "Adjust MDFLOW_IMPORT_URL_ALLOWLIST/MDFLOW_IMPORT_URL_BLOCKLIST or import from an allowed host.",
      },
      err
    );
  }

  const targetUrl = validatedUrl.href;

  // Always log URL fetches to stderr for visibility
  console.error(`[imports] Fetching: ${targetUrl}`);

  try {
    const response = await fetchTextResource(targetUrl, {
      policy: { allowlist, blocklist },
      headers: {
        "Accept": "text/markdown, application/json, text/plain, */*",
        "User-Agent": "mdflow/1.0",
      },
    });

    if (!response.ok) {
      throw createImportError(
        `Failed to fetch URL import "${targetUrl}": HTTP ${response.status} ${response.statusText}.`,
        "IMPORT_URL_FETCH_FAILED",
        {
          url: targetUrl,
          status: response.status,
          suggestion: "Check the URL, authentication, or network connectivity.",
        }
      );
    }

    const contentType = response.headers.get("content-type");
    const content = response.text;
    importCtx?.budget?.bytes(Buffer.byteLength(content));

    // Check content type header
    if (contentType && isAllowedContentType(contentType)) {
      return content.trim();
    }

    // Content-type missing or generic - infer from content
    const inferred = inferContentType(content, targetUrl);
    if (inferred === "markdown" || inferred === "json") {
      return content.trim();
    }

    // Cannot determine content type - reject
    throw createImportError(
      `URL returned unsupported content type: ${contentType || "unknown"}. ` +
      `Only markdown and JSON are allowed. URL: ${targetUrl}`,
      "IMPORT_URL_FETCH_FAILED",
      {
        url: targetUrl,
        contentType: contentType || "unknown",
        suggestion: "Use a URL that serves markdown/json/plain text content.",
      }
    );
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw createImportError(
      `Failed to fetch URL import "${targetUrl}": ${getErrorMessage(err)}`,
      "IMPORT_URL_FETCH_FAILED",
      {
        url: targetUrl,
        suggestion: "Check the URL, proxy settings, and internet connectivity, then retry.",
      },
      err
    );
  }
}
