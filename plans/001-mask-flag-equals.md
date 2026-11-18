# Plan 001: Mask --flag=value secrets in argv display paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 050a0d6..HEAD -- src/secrets.ts src/secrets.test.ts src/cli-runner-helpers.ts`
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

Secrets passed as `--api-key=sk-live-...` (equals form) stay plaintext in dry-run output, spinner previews, and log lines, while the space-separated form `--api-key sk-live-...` is masked. Any flow author or operator using the equals form leaks credentials into terminal scrollback, piped logs, and `~/.mdflow/logs`. Fixing the argv splitter closes the highest-frequency secret leak with a display-only change.

## Current state

The relevant files, each with one line on its role:

- `src/secrets.ts` — masking/redaction helpers; `maskArgsArray` (~164-187) and `maskArgs` (~201-224) only mask when the secret is the NEXT argv entry
- `src/secrets.test.ts` — existing pattern for masking tests (read it first, follow its structure)
- `src/cli-runner-helpers.ts:164` — `formatCommandPreview` calls `maskArgsArray` (covered automatically)

Excerpts of the code as it exists today:

```ts
// src/secrets.ts:171-182
} else if (arg.startsWith("-")) {
  // Extract key name from flag (e.g., "--api-key" -> "api-key")
  const keyName = arg.replace(/^-+/, "");
  result.push(arg);
  if (isSensitiveKey(keyName)) {
    maskNext = true;
  }
}
```

Problem: for `--api-key=sk-123`, `keyName` is `api-key=sk-123` and the whole arg is pushed unmasked. Same gap in `maskArgs` (~201-224): recurses into plain objects only, skips arrays, and never splits on `=`.

Repo conventions: small pure helpers in `src/secrets.ts`, tested in `src/secrets.test.ts`; display-masking only, never mutate the real argv. Match the existing `maskValue`/`redactValue` helpers (read them in-file before editing).

## Commands you will need

| Purpose   | Command                                  | Expected on success              |
|-----------|------------------------------------------|----------------------------------|
| Typecheck | `bunx tsc --noEmit`                      | exit 0 (except pre-existing `src/ui.ts:200` error — verify it exists on base via `git stash` if unsure) |
| Tests     | `bun test src/secrets.test.ts`           | all pass                         |
| Lint      | `bun run lint 2>&1 \| grep -c warning`    | no NEW warnings vs base count    |

## Scope

**In scope** (the only files you should modify):

- `src/secrets.ts`
- `src/secrets.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/cli-runner.ts`, `src/cli-runner-helpers.ts` — callers; they inherit the fix via `maskArgsArray`
- `src/logger.ts` array recursion (plan 002 covers redaction gaps there)
- Any change to how secrets are PARSED for execution — display masking only

## Git workflow

- Branch: `advisor/001-mask-flag-equals`
- Commit per step; message style: conventional commits, e.g. `fix: mask --flag=value secrets in argv display` (see `git log --oneline -5` for style)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Split on first `=` in `maskArgsArray`

In `src/secrets.ts`, in the `arg.startsWith("-")` branch: split `arg` on the first `=`; check `isSensitiveKey` against the LEFT part only; if sensitive and a right part exists, push `left + "=" + maskValue(right)` instead of the raw arg and do NOT set `maskNext`. Cover short (`-k=v`) and long (`--api-key=v`) forms identically (both start with `-`).

**Verify**: `bun test src/secrets.test.ts` → all pass (existing tests unchanged)

### Step 2: Same split in `maskArgs` object path

Apply the identical `=`-split where `maskArgs` handles string values whose keys look like flags (read the function first; only the branch where `isSensitiveKey(key)` is true and value is a string needs no change — the gap is keys that CONTAIN `=`, e.g. env-style `"--api-key=sk-123": ...`. Only add handling if such keys reach the function; otherwise note and skip).

**Verify**: `bunx tsc --noEmit` → no new errors

### Step 3: Add regression tests

In `src/secrets.test.ts`, model after the existing `maskArgsArray` cases. Cover: `--api-key=sk-123` → `--api-key=sk-****` (use the file's existing mask format), `-k=sk-123` short form, non-sensitive `--model=opus` passes through UNCHANGED, space form still works (already covered — do not duplicate, just keep green).

**Verify**: `bun test src/secrets.test.ts` → all pass, including the new cases

## Test plan

- New tests in `src/secrets.test.ts` for the equals form (long + short + non-sensitive passthrough).
- Structural pattern: the file's existing `describe("maskArgsArray")` block.
- Verification: `bun test src/secrets.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bunx tsc --noEmit` exits 0 (ignoring pre-existing `src/ui.ts:200`)
- [ ] `bun test src/secrets.test.ts` exits 0; new equals-form tests exist and pass
- [ ] `grep -n "maskNext = true" src/secrets.ts` shows the space-form path intact
- [ ] No files outside `src/secrets.ts`, `src/secrets.test.ts` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/secrets.ts:171-182` doesn't match the excerpt (drift).
- Any caller depends on the UNMASKED equals form (grep `maskArgsArray` callers and read them — if one parses the masked output back, stop).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If new secret-key patterns are added to `SENSITIVE_KEY_PATTERNS`, the equals-form path inherits them automatically (same `isSensitiveKey` call) — no extra work.
- Reviewer should scrutinize: the `maskValue` output format for the equals form matches the space form exactly (same redaction shape, no length leak).
- Explicitly deferred: array recursion and short-flag aliases (plan 002).
