# Plan 003: Show full remote body (or gate remember-domain on truncation) in TOFU consent

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 050a0d6..HEAD -- src/trust.ts src/trust.test.ts src/cli-runner.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `050a0d6`, 2026-11-18

## Why this matters

The TOFU consent screen truncates the remote flow body at 500 chars, but approval executes the WHOLE body — including `@imports` and `` !`cmd` `` inlines past the cut. A reviewer approves what they saw; the engine runs what they didn't. Either show the full body or refuse the one-click "trust this domain forever" option when truncation hid content. Consent-UI-only change; execution path untouched.

## Current state

Relevant files:

- `src/trust.ts` — `BODY_PREVIEW_LENGTH = 500` (line 23), `truncateBody` (~88-95), `promptForTrust` (~110-175): prints truncated body, then `confirm` execute + `select` remember-domain. No paging; `rememberDomain: true` is offered even when truncated.
- `src/trust.test.ts` (check it exists with `ls src/trust*`; if missing, follow `src/remote.test.ts` structure instead — note which you used)
- `src/cli-runner.ts` — calls `promptForTrust` in `handleTOFU` (~3311); read the call site to confirm the return shape it consumes (`{ approved, rememberDomain }` — do NOT change the shape).

Excerpt (verified this session):

```ts
// src/trust.ts:88-95
function truncateBody(body: string, maxLength: number = BODY_PREVIEW_LENGTH): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength) + "\n... (truncated)";
}
```

Repo conventions: `console.error` for consent UI, `@inquirer/prompts` lazy import (keep it lazy — the comment explains the ~50ms startup tax). Tests use temp dirs + fake TTY where needed (see `src/trust-boundaries.test.ts` harness via `md()` helper — prefer testing `truncateBody`/prompt helpers directly over driving the full CLI).

## Commands you will need

| Purpose   | Command                                        | Expected on success                |
|-----------|------------------------------------------------|------------------------------------|
| Typecheck | `bunx tsc --noEmit`                            | exit 0 (except pre-existing `src/ui.ts:200`) |
| Tests     | `bun test src/trust.test.ts` (or file you used) | all pass                          |
| Lint      | `bun run lint 2>&1 \| grep -c warning`         | no NEW warnings vs base            |

## Scope

**In scope**:

- `src/trust.ts` (preview rendering + remember gating)
- `src/trust.test.ts` (or new test file if none exists — create `src/trust.test.ts` mirroring `src/remote.test.ts` structure)

**Out of scope**:

- `src/cli-runner.ts` `handleTOFU` logic — consume the same `{ approved, rememberDomain }` shape; do not touch
- `known_hosts` file format or trust storage
- URL allowlist policy (separate finding)

## Git workflow

- Branch: `advisor/003-tofu-full-body`
- Commit per step; conventional commits (see `git log --oneline -5`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Track whether truncation happened

Change `truncateBody` to also report truncation (return `{ text, truncated: boolean }`, updating its single call site in `promptForTrust`), OR add a `wasTruncated(body)` helper next to it. Minimal diff wins — one helper + one call-site use.

**Verify**: `bunx tsc --noEmit` → no new errors

### Step 2: Gate remember-domain on full visibility

In `promptForTrust`, when the body was truncated: print an explicit line `Body truncated at 500 chars — showing full body before remembering.` then print the FULL body (still via `displayUntrusted`), and only then offer the remember-domain select. When not truncated, behavior is byte-identical to today (confirm + select, same defaults: `default: false`, remember defaults `"no"`).

**Verify**: manual reasoning + tests in step 3 (inquirer prompts can't run headless — test the helpers, not the prompt)

### Step 3: Tests for the helpers

Cases: short body → `{ truncated: false }`, exact-500 → false, 501 → true with full text available; remember-gating logic as a pure function if you extracted one (preferred: extract `shouldGateRemember(truncated)` so it's directly testable).

**Verify**: `bun test src/trust.test.ts` → all pass including new cases

## Test plan

- New tests for truncation detection + gating predicate. Do NOT attempt headless inquirer driving (flaky, out of scope).
- If `src/trust.test.ts` doesn't exist, create it following `src/remote.test.ts` imports/structure.
- Verification: file green.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0 (ignoring pre-existing `src/ui.ts:200`)
- [ ] Truncation helper + gating predicate tested and green
- [ ] Untruncated flow renders byte-identical output (no extra lines when `truncated === false`)
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `promptForTrust` signature differs from `(url, command, frontmatter, body)` or the return shape isn't `{ approved, rememberDomain }` (caller contract changed).
- `displayUntrusted` doesn't exist or has different semantics than "mark untrusted output" (read it first).
- Inquirer version lacks `confirm`/`select` (check `package.json` — if the API differs, adapt the plan rather than forcing it, and report the adaptation).

## Maintenance notes

- If `BODY_PREVIEW_LENGTH` changes, the gating follows automatically (single predicate on the boolean, not the constant).
- Reviewer focus: the untruncated path must be pixel-identical — any extra line there is a regression in every local consent screen.
- Deferred: URL policy threading (separate finding), paging UI for very long bodies (explicit non-goal — full print is the v1).
