# Plan 002: Redact array values and short secret flags in logs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 050a0d6..HEAD -- src/secrets.ts src/secrets.test.ts src/logger.ts src/logger.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (complements 001; either order works)
- **Category**: security
- **Planned at**: commit `050a0d6`, 2026-11-18

## Why this matters

`redactArgs`/`maskArgs` recurse into plain objects but skip arrays (`!Array.isArray(value)`), and single-letter flags never match `SENSITIVE_KEY_PATTERNS`. Secrets nested in arrays, string log fields, and `-k secret` short-flag pairs reach persisted debug logs in `~/.mdflow/logs` unredacted. This closes the log-persistence half of the secret leak; plan 001 closes the argv-display half.

## Current state

The relevant files:

- `src/secrets.ts` — `redactArgs` (~100-115): `else if (value && typeof value === "object" && !Array.isArray(value))` recurses; arrays fall to `else` and pass through. `maskArgs` (~138-150): identical shape. Sensitive patterns at ~19-26 (`key|token|secret|password|credential|auth`, case-insensitive).
- `src/logger.ts:123-134` — redacts only plain-object log args, not strings or arrays.
- `src/secrets.test.ts`, `src/logger.test.ts` — existing test patterns to follow.

Excerpts:

```ts
// src/secrets.ts:104-112
for (const [key, value] of Object.entries(args)) {
  if (isSensitiveKey(key)) {
    result[key] = redactValue(value);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    // Recursively redact nested objects
    result[key] = redactArgs(value as Record<string, unknown>);
  } else {
    result[key] = value;   // <-- arrays land here, unredacted
  }
}
```

Repo conventions: pure helpers + table tests in `*.test.ts`; redaction is display-only. `redactValue` already handles non-string values (read it before editing — if it stringifies blindly, arrays of objects still need element-wise recursion, not a single redact call).

## Commands you will need

| Purpose   | Command                               | Expected on success           |
|-----------|---------------------------------------|-------------------------------|
| Typecheck | `bunx tsc --noEmit`                   | exit 0 (except pre-existing `src/ui.ts:200`) |
| Tests     | `bun test src/secrets.test.ts src/logger.test.ts` | all pass              |
| Lint      | `bun run lint 2>&1 \| grep -c warning`| no NEW warnings vs base       |

## Scope

**In scope**:

- `src/secrets.ts` (`redactArgs`, `maskArgs` array branches)
- `src/logger.ts` (string/array log-arg redaction, ONLY if it calls into secrets helpers — read first)
- `src/secrets.test.ts`, `src/logger.test.ts` (new cases)

**Out of scope**:

- `src/history.ts` persistence filtering (separate finding, separate decision — do NOT bundle)
- Short-flag `--k value` argv masking: handle ONLY if `maskArgsArray`-adjacent and trivial (explicit `-k`/`-t`/`-s` alias list); if it needs a flag-alias registry, note it and SKIP (say so in the commit message)
- Any change to log LEVELS or log destinations

## Git workflow

- Branch: `advisor/002-redact-arrays-shorts`
- Commit per step; conventional commits (see `git log --oneline -5`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Recurse into arrays in `redactArgs` and `maskArgs`

Add an `Array.isArray(value)` branch BEFORE the plain-object branch in both functions: map elements, recursing into objects via the same function, applying `redactValue`/`maskValue` to sensitive-keyed object elements and to bare strings ONLY when the parent key is sensitive (never redact arbitrary strings — that breaks log readability and is a behavior change beyond this plan).

**Verify**: `bun test src/secrets.test.ts` → all pass

### Step 2: Cover short flags if trivial

Check `maskArgsArray` against `-k secret`: `keyName` is `k`, which matches no pattern. If the fix is a 5-line alias map (`k→api-key` family is engine-specific — do NOT guess engine flags), SKIP with a commit-message note. Only proceed if a generic rule covers it (e.g. single-letter flag followed by a value that LOOKS like a secret is guessing — do not do that).

**Verify**: `bunx tsc --noEmit` → no new errors

### Step 3: Logger string/array args

Read `src/logger.ts:123-134`. If it delegates to `redactArgs`/`maskArgs`, step 1 covers it — add one logger-level test proving an array arg is redacted end-to-end and stop. If it has its OWN recursion, mirror the array branch there.

**Verify**: `bun test src/logger.test.ts` → all pass

### Step 4: Regression tests

Cases: `{ tokens: ["sk-1", "sk-2"] }` redacted element-wise; nested `{ a: [{ token: "sk-1" }] }`; non-sensitive arrays (`{ models: ["opus", "sonnet"] }`) pass through UNCHANGED (assert exact equality — over-redaction is the failure mode to guard).

**Verify**: `bun test src/secrets.test.ts src/logger.test.ts` → all pass including new cases

## Test plan

- New tests in `src/secrets.test.ts` (array + nested cases, passthrough guard) and one end-to-end in `src/logger.test.ts` if step 3 applies.
- Pattern: existing `describe("redactArgs")` / `describe("maskArgs")` blocks.
- Verification: both files green.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0 (ignoring pre-existing `src/ui.ts:200`)
- [ ] `bun test src/secrets.test.ts src/logger.test.ts` exits 0 with new array cases
- [ ] `grep -n "Array.isArray" src/secrets.ts` shows the new branches
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match live code (drift).
- `redactValue` stringifies values destructively (check: does it preserve type? if arrays would become `"[object Object]"`, the element-wise approach in step 1 is REQUIRED — if that's somehow infeasible, stop).
- Any existing test asserts the CURRENT (leaky) behavior — i.e. a test expects arrays unredacted. That test encodes the bug; do not silently update it, report it.

## Maintenance notes

- Future sensitive-key additions inherit array coverage automatically.
- Reviewer focus: the passthrough test (`models` unchanged) — over-redaction is worse than under-redaction here since it corrupts logs silently.
- Deferred: `history.ts` persistence filtering, short-flag alias registry.
