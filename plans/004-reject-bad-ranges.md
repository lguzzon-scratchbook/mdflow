# Plan 004: Reject zero and reversed line ranges at parse time

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 050a0d6..HEAD -- src/imports-parser.ts src/imports-file.ts src/imports-parser.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `050a0d6`, 2026-11-18

## Why this matters

`@file:50-10` (reversed) and `@file:0-5` (zero start) parse without error today: `parseLineRange` accepts any digits, and `extractLines` clamps `startIdx` with `Math.max(0, start - 1)`, silently yielding an empty or wrong slice. The flow then runs with evidence silently missing. One validation at the single choke point turns silent wrong-context into a loud, actionable error.

## Current state

Relevant files:

- `src/imports-parser.ts:167-178` — `parseLineRange` returns `{ path, start, end }` with no validation (`parseInt` of any `\d+` pair, including `0` and reversed)
- `src/imports-file.ts:87-98` — `extractLines(content, start, end)`: throws only when `start > lines.length`; clamps end to EOF, floors start at 0
- `src/imports-parser.test.ts:587+` — `describe('parseLineRange')` with valid-range cases (read them; follow the `toEqual` style)

Excerpts (verified this session):

```ts
// src/imports-parser.ts:167-178
export function parseLineRange(path: string): { path: string; start?: number; end?: number } {
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
```

Design constraint (do NOT violate): callers treat a return WITHOUT `start`/`end` as "no range syntax". So on invalid ranges you must THROW (loud), never return `{ path }` silently (that would import the whole file — worse than today's empty slice). Check how `extractLines` errors surface today (thrown `Error` with "out of range" message propagates to the user — match that shape).

Repo conventions: parser is pure, tested table-style in `src/imports-parser.test.ts`; error messages name the offending value and suggest the fix.

## Commands you will need

| Purpose   | Command                                              | Expected on success                |
|-----------|------------------------------------------------------|------------------------------------|
| Typecheck | `bunx tsc --noEmit`                                  | exit 0 (except pre-existing `src/ui.ts:200`) |
| Tests     | `bun test src/imports-parser.test.ts src/imports.test.ts` | all pass                     |
| Lint      | `bun run lint 2>&1 \| grep -c warning`               | no NEW warnings vs base            |

## Scope

**In scope**:

- `src/imports-parser.ts` (`parseLineRange` validation)
- `src/imports-file.ts` (`extractLines` defensive check — belt-and-braces for direct callers)
- `src/imports-parser.test.ts` (new cases)

**Out of scope**:

- `parseSymbolExtractionInternal` or any other parser — same file, different syntax, not this bug
- Changing VALID range semantics (clamping end to EOF stays; `start > lines.length` error stays)
- `src/imports.ts` orchestrators — they propagate the throw unchanged

## Git workflow

- Branch: `advisor/004-reject-bad-ranges`
- Commit per step; conventional commits (see `git log --oneline -5`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Throw in `parseLineRange` for start < 1 or start > end

After the match, before returning: `if (start < 1 || start > end) throw new Error(...)` naming the range (`file.ts:50-10`) and stating the rule ("line numbers start at 1 and start must not exceed end"). Message style matches `extractLines` ("Line range ... is out of range...").

**Verify**: `bun test src/imports-parser.test.ts` → existing tests still pass (none cover invalid ranges — confirm by grep, don't assume)

### Step 2: Mirror the guard in `extractLines`

Same condition at the top of `extractLines` in `src/imports-file.ts` (direct callers bypass the parser). Same message shape.

**Verify**: `bunx tsc --noEmit` → no new errors

### Step 3: Regression tests

In `describe('parseLineRange')`: `@f.ts:0-5` throws, `@f.ts:50-10` throws, `@f.ts:5-5` (single line) does NOT throw, `@f.ts:1-5` still parses (already covered — don't duplicate). For `extractLines`: add `expect(() => extractLines("a\nb", 2, 1)).toThrow()` — check how `extractLines` is imported in the test file first (it may need an import from `imports-file`; read the test imports).

**Verify**: `bun test src/imports-parser.test.ts src/imports.test.ts` → all pass including new cases

## Test plan

- New parser cases (zero start, reversed, single-line OK) + one extractor case.
- Pattern: existing `describe('parseLineRange')` `toEqual`/`toThrow` style.
- Verification: both files green.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0 (ignoring pre-existing `src/ui.ts:200`)
- [ ] Invalid ranges throw loud errors at parse AND extract layers
- [ ] `@f.ts:5-5` and all previously-valid ranges still parse identically
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any existing test asserts the CURRENT lenient behavior (e.g. expects `0-5` to parse) — that test encodes the bug; report it, don't silently update it.
- `extractLines` is called anywhere with `start` possibly `0` LEGITIMATELY (grep all callers — if an internal caller relies on 0-clamping, the parser-layer throw in step 1 suffices and step 2 must be skipped; report this).
- The throw shape breaks an error-type contract (check: do callers catch specific error classes from the parser? if `ImportError` with a code is required rather than plain `Error`, match it — read one `createImportError` call site first).

## Maintenance notes

- If new range syntaxes are added (e.g. negative offsets), extend the SAME guard — single choke point.
- Reviewer focus: the `start === end` single-line case must keep working (off-by-one risk lives here).
- Deferred: symbol-extraction validation (different syntax, no reported bug).
