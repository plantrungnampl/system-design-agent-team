# PR #1 Review Fixes Implementation Plan

**Goal:** Resolve the independent review and cross-platform CI findings on PR #1 without expanding V1 scope.

## Global constraints

- Use test-first RED/GREEN evidence for every behavior change.
- Git-backed YAML/Markdown remain authoritative; SQLite remains disposable.
- Never fabricate review, approval, execution, or plugin invocation evidence.
- Production/destructive actions require exact current authorization and safety evidence.
- Preserve Node.js 20+ support and all three workflows.
- Keep V2/V3 and autonomous deployment out of scope.

### Task 1: Enforce configuration and traceability policy

**Files:** `packages/cli/src/index.ts`, `packages/traceability/src/index.ts`, `tests/cli.test.mjs`, `tests/artifact-traceability.test.mjs` or the existing traceability test file.

- Add a failing test proving environment/explicit overlays cannot lower `security.classification` (`restricted > confidential > internal > public`).
- Reject a lowering override with a stable error; allow equal or stricter classification.
- Add a failing graph test for `A derived_from B`, followed by hard/derived consumers.
- Traverse every newly stale `hard_dependency` or `derived_from` target transitively without staling soft/reference-only links.
- Run the focused tests, then `npm run check` if focused tests pass.

### Task 2: Require attested reviews and real plugin invocation evidence

**Files:** `packages/core/src/index.ts`, `packages/cli/src/index.ts`, `packages/cli/src/bin.ts`, `packages/plugin-registry/src/index.ts`, lifecycle/E2E tests and fixtures directly affected.

- Add failing tests proving a reviewer ID plus verdict cannot advance any reviewed phase without an adapter-collected execution receipt.
- Require every review receipt to bind the configured reviewer, phase, verdict, current artifact versions/checksums, and completed execution result.
- Add failing tests proving a required-plugin phase cannot progress when the adapter only reports availability but no successful invocation occurs.
- During the lifecycle operation, invoke every required plugin/skill through the host adapter, persist sanitized digest evidence, and bind it to agent, phase, and operation/execution identity.
- Never accept hand-written status, receipt, or invocation records as authority.
- Update CLI help/argument validation and existing test harnesses to supply real receipts.
- Run focused lifecycle, dispatch, security/recovery, and END2END tests, then `npm run check`.

### Task 3: Fix cross-platform CI portability

**Files:** `tests/package-smoke.test.mjs`, `tests/e2e-existing-system.test.mjs`, `packages/sqlite-cache/package.json`, `package-lock.json`.

- Canonicalize both containment operands before the package-smoke realpath comparison so macOS `/var` -> `/private/var` and Windows canonicalization are handled.
- Make the existing-system fixture edit newline-agnostic and assert the intended replacement occurred.
- Pin `better-sqlite3` to `12.9.0`, the last release before Node 20 prebuilds were removed, preserving Node 20+ installation.
- Run focused smoke/E2E tests, `npm ci --dry-run`, `npm pack --workspaces --dry-run`, and `npm run check`.

### Task 4: Correct README execution and trust boundaries

**Files:** `README.md`, `docs/getting-started.md`, `docs/security.md`, `tests/documentation-consistency.test.mjs` if a regression assertion is needed.

- Make the repository quick start runnable with `npm exec -- system-design-team` or the direct built CLI path.
- State that `--plugin-adapter` loads executable host code and must point only to a reviewed, trusted adapter.
- Say V1 ships plugin contracts/identities, not the plugins themselves.
- Keep every command/option aligned with CLI help.
- Run documentation consistency tests and `git diff --check`.

### Task 5: Final independent review and publication

- Generate a fresh `main..HEAD` review package.
- Dispatch an independent whole-branch reviewer; fix all Critical/Important findings and re-review.
- Run `npm run check`, `npm ci --dry-run`, `npm pack --workspaces --dry-run`, and `git diff --check`.
- Commit and push to `codex/v1-foundation` so PR #1 updates.
- Verify GitHub Actions reaches a green Node 20/22 matrix on Linux, Windows, and macOS before marking merge-ready.
