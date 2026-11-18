# Plan 005: Characterization tests for TOFU gate and compat stamping

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 050a0d6..HEAD -- src/cli-runner.ts src/compat.ts src/compat.test.ts src/remote.test.ts src/trust.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (tests only, no prod change)
- **Depends on**: none (but plan 003 touches `promptForTrust` — coordinate: this plan tests `handleTOFU` paths that mock or bypass the prompt; read 003 first if it has landed)
- **Category**: tests
- **Planned at**: commit `050a0d6`, 2026-11-18

## Why this matters

Two trust-critical paths have zero real-behavior tests: the TOFU gate (`handleTOFU` — approve/reject/remember-domain against a temp known_hosts) and compat stamping (`stampCompatAfterSuccess` wraps `stampCompatFile` in a bare `catch {}`, tested only at the pure-function level). These are exactly the characterization tests the cli-runner split (DEBT-01) needs as a safety net first — write them now, split later with confidence.

## Current state

Relevant files:

- `src/cli-runner.ts:3309-~3360` — `handleTOFU(filePath, localFilePath, command, baseFrontmatter, rawBody, jsonMode)`: non-TTY/jsonMode → `cleanupRemoteFile` + `SecurityError`; TTY → `promptForTrust`, reject → cleanup + `UserCancelledError`, remember → `addTrustedDomain`. Read the full method before writing tests (ends ~line 3360; confirm the remember branch calls `addTrustedDomain`).
- `src/compat.ts:33` + `src/cli-runner.ts:592` — `stampCompatAfterSuccess` best-effort wrapper; `src/compat.test.ts:102-195` covers pure `applyCompatStamp`/`stampCreatedVersion`/`stampCompatFile` (47 asserts) but never the runner integration or skip rules (remote/registry/`MDFLOW_EVAL_RUN=1`).
- `src/remote.test.ts:32` — covers only URL helpers, not the gate. `src/ui.test.ts:338` — comment claims `promptForTrust` simulation, no real gate test (verify by reading before citing in tests).
- Test harness precedent: `src/trust-boundaries.test.ts` drives the CLI via `md([...])` with temp files (`file("budget.proofengine.md", body)` pattern + `ran()` helper). For TOFU: temp `known_hosts` via env override — check how `getKnownHostsPath` resolves its path (read `src/trust.ts` top) and whether an env var redirects it; if not, this plan needs a smaller scope (see STOP conditions).

Repo conventions: `bun:test` (`describe`/`it`/`expect`), temp dirs, no real network (existing tests use local `serve()` — see `src/trust-boundaries.test.ts:117-122`).

## Commands you will need

| Purpose   | Command                                                     | Expected on success |
|-----------|-------------------------------------------------------------|---------------------|
| Typecheck | `bunx tsc --noEmit`                                         | exit 0 (except pre-existing `src/ui.ts:200`) |
| Tests     | `bun test src/cli-runner.test.ts src/compat.test.ts src/remote.test.ts` | all pass |
| New tests | `bun test src/tofu-gate.test.ts src/compat-runner.test.ts` (names you choose — update Done criteria accordingly) | all pass |

## Scope

**In scope** (new test files + helpers only; NO prod changes):

- New `src/tofu-gate.test.ts` (or equivalent name): approve / reject / remember-domain paths
- New `src/compat-runner.test.ts` (or extend `src/compat.test.ts` — prefer EXTEND if the file's structure fits; do not create a parallel file unnecessarily): stamp-written-on-success, skipped-for-remote, run-outcome-unchanged-on-stamp-throw
- Minimal test helpers if the existing `md()` harness can't drive these paths (read `src/test-utils.ts` first)

**Out of scope**:

- ANY change to `src/cli-runner.ts`, `src/compat.ts`, `src/trust.ts` production code — if a test requires a seam that doesn't exist (e.g. known_hosts path not redirectable), STOP and report instead of adding one
- Headless inquirer driving (flaky by nature — mock or bypass the prompt layer, assert the file/state effects)
- `MDFLOW_EVAL_RUN=1` end-to-end (assert the skip rule at the unit level)

## Git workflow

- Branch: `advisor/005-tofu-compat-tests`
- Commit per file; conventional commits, e.g. `test: characterize TOFU gate paths` (see `git log --oneline -5`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Map the seams (read-only)

Read: full `handleTOFU` (~3309-3360), `getKnownHostsPath` + `addTrustedDomain` + `cleanupRemoteFile` in `src/trust.ts`, `stampCompatAfterSuccess` at `src/cli-runner.ts:592` + `stampCompatFile` in `src/compat.ts`. Answer: (a) can known_hosts be redirected via env/temp for tests? (b) does `handleTOFU` need a TTY, and does the repo have a fake-TTY harness? (c) what does `stampCompatAfterSuccess` skip on? Write the answers as a comment at the top of each new test file (one line each — this is the documentation future splitters need).

**Verify**: no command — but if (a) is "no" for known_hosts redirect, STOP (see conditions)

### Step 2: TOFU gate tests

Cases: (1) non-TTY untrusted → `SecurityError` + temp file cleaned up; (2) reject path → `UserCancelledError` + cleanup called (mock `promptForTrust` at module boundary ONLY if the codebase already mocks modules somewhere — grep `mock.module` first; repo has ~0 module mocks, so prefer driving via env/TTY control over mocking); (3) remember → domain persisted in temp known_hosts; (4) already-trusted domain → no prompt, proceeds.

**Verify**: `bun test <new file>` → all pass

### Step 3: Compat stamping tests

Cases: (1) local success writes stamp (temp flow file, assert `_compat` in frontmatter after); (2) remote/registry flow skips (no stamp, no error); (3) `MDFLOW_EVAL_RUN=1` skips; (4) stamp throw (chmod dir read-only or mock `stampCompatFile` failure) → run outcome UNCHANGED (success stays success).

**Verify**: `bun test <new/extended file>` → all pass

### Step 4: Full-file regression

**Verify**: `bun test src/cli-runner.test.ts src/compat.test.ts src/remote.test.ts <new files>` → all pass; `bunx tsc --noEmit` → no new errors

## Test plan

This plan IS tests. Coverage: TOFU 4 paths + compat 4 rules. Pattern: `src/trust-boundaries.test.ts` `md()` harness + temp files.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0 (ignoring pre-existing `src/ui.ts:200`)
- [ ] New TOFU tests: 4 paths green
- [ ] New/extended compat tests: 4 rules green
- [ ] No production files modified (`git status` shows test files only — plus `src/test-utils.ts` ONLY if step 1 justified a harness addition)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- known_hosts path is not redirectable for tests AND no fake-TTY harness exists (the plan's premise fails — report what seam would be needed instead).
- The repo's no-module-mock convention (0 `mock.module` hits) makes prompt mocking impossible AND env/TTY control can't reach the branch — report, don't introduce the first mock.
- `stampCompatAfterSuccess` doesn't exist at `src/cli-runner.ts:592` or has different skip rules than stated (drift).
- Any step requires touching production code to become testable — that converts this S/M test plan into a refactor; stop and re-scope.

## Maintenance notes

- These are characterization tests: they pin CURRENT behavior. If TOFU UX changes (plan 003), the remember-path tests must be re-read, not just re-run.
- The cli-runner split (DEBT-01) depends on these — its plan should cite this file as the pre-existing safety net.
- Reviewer focus: do the tests assert STATE (files written, errors thrown) rather than mocks-called? Mock-only assertions are banned by repo precedent (0 in the 5 largest specs).
