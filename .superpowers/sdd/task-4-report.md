# Task 4 Report: Codex Execution, Permissions, and Release Safety

## Status

Implemented and verified.

## Scope delivered

- Added shared Zod contracts for permission profiles, command classes, authorized paths, capability reports, execution evidence, checkpoints, policy input, and structured agent execution results.
- Completed the `AgentExecutionAdapter` surface on `ManualCodexAdapter`: capability checking, preparation, execution handle creation, structured result collection, and cancellation.
- Preserved fail-closed runtime behavior. The adapter never invents a plugin call or agent result; `collectResult` still requires externally supplied runtime evidence.
- Bound collected results to their prepared dispatch digest, execution ID, permission profile, command class, and authorized scope. Malformed, cancelled, mismatched, and escalated results are rejected.
- Rejected shell control operators in dispatch command scope before preparation.
- Added a deterministic execution policy evaluator enforcing G6 before code write; current QA, security, and data evidence at G7; human authorization, backup, and rollback readiness at G8; and confirmation, scope, backup, dry-run, and rollback evidence for destructive actions.
- Required a validated, completed structured execution result before G7/G8 approval transitions. CLI approval remains fail-closed when no runtime result is supplied.
- Added transactional human gate rejection with operation-ID replay protection and append-only audit evidence.
- Added functional CLI routes for `reject`, `gate readiness`, `secrets scan`, `diagnostics`, and `issue list`.
- Kept Git/project YAML authoritative: readiness and diagnostics read persisted state, rejection updates YAML transactionally, and secret scanning reads Git-tracked files without persisting secret content.

## TDD evidence

Initial RED was captured before production changes:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 26; pass 20; fail 6
TypeError: checkCapabilities is not a function
Missing expected COMMAND_INJECTION exception
TypeError: prepareExecution is not a function
SyntaxError: workflow-engine does not export evaluateExecutionPolicy
SyntaxError: cli does not export diagnostics
```

Focused GREEN after the minimum implementation:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 58; pass 58; fail 0
```

Self-review added two further genuine RED/GREEN checks:

```text
G7 policy claims without a structured result: RED (missing expected exception) -> GREEN
Runtime permission escalation: RED (missing expected rejection) -> GREEN
G8 approval readiness safety evidence: RED (expected 3 blockers, received none) -> GREEN
```

## Final verification

```text
npm run check
tests 129; pass 129; fail 0

npm pack --dry-run --workspace @system-design-team/cli
total files: 12; package size: 18.8 kB; exit 0

git diff --check
exit 0
```

## Second review fixes

The second review's provenance, semantic-role, exact-authorization, checksum, and reviewer-binding gaps were reproduced before implementation:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 62; pass 56; fail 6

Expected failures included the missing adapter receipt API and CLI receipt exports, plus accepted charter role reuse, checksum drift, unrelated execution approvals, and destructive authorization mismatches. The security test module could not instantiate until the missing receipt exports existed.
```

The minimum receipt flow now brands collected results inside the same adapter instance, derives reviewer identity/phase/verdict from the immutable dispatch, and transactionally records a digest-bound receipt with a matching append-only audit event. CLI review, approval, and readiness accept only receipt IDs from the canonical receipt registry. A hand-written tracked result file is not a receipt. Replays are idempotent, operation conflicts fail closed, and receipt or audit binding drift is rejected.

Execution approvals now bind the exact execution ID, dispatch digest, permission profile, command class, authorized paths, and destructive flag. Evidence references are checked against distinct workflow phase, owner, reviewer, path, purpose, current artifact version/status, independent review, human approval, and freshly inspected content checksum. Reviewer receipts must match reviewer agent, phase, and verdict; G8 review evaluates G8 authorization rather than G7.

Focused GREEN:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 80; pass 80; fail 0
```

Final second-review verification:

```text
npm run check
tests 150; pass 150; fail 0

npm pack --dry-run --workspace @system-design-team/cli
total files: 12; exit 0

npm pack --dry-run --workspace @system-design-team/codex-adapter
total files: 4; exit 0

git diff --check
exit 0
```

## Files changed

- `packages/core/src/index.ts`
- `packages/codex-adapter/src/index.ts`
- `packages/workflow-engine/src/index.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/bin.ts`
- `tests/dispatch.test.mjs`
- `tests/workflow-engine.test.mjs`
- `tests/security-recovery.test.mjs`
- `.superpowers/sdd/task-4-report.md`

## Concern

No real Codex or deployment runtime is fabricated. Standalone `start` and `review` continue to fail with `PLUGIN_ADAPTER_REQUIRED`, and G7/G8 approval fails with `EXECUTION_EVIDENCE_REQUIRED` unless a caller supplies a verified runtime result. The built-in secret scan intentionally covers common credential assignments in Git-tracked files; a dedicated scanner can replace it when one is adopted.

## Review fixes

The review findings were reproduced before implementation:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 56; pass 36; fail 20
```

The fix now enforces policy before sensitive execution, brands prepared work with adapter-owned immutable state, freezes handles, binds destructive scope, rejects failed checkpoints, and validates execution evidence through current artifact, review, and human approval records. G7/G8 CLI routes accept only contained Git-tracked structured evidence files, readiness exposes execution blockers and unconfigured gates, and the secret scanner covers common key, private-key, credential-URI, provider, cookie, and session formats without returning secret content.

Focused GREEN:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 72; pass 72; fail 0
```

Self-review added one further RED/GREEN check: artifact evidence backed by an agent approval at the wrong gate was initially accepted, then rejected after binding approval actor and gate to the authoritative artifact record.

Final review-fix verification:

```text
npm run check
tests 143; pass 143; fail 0

npm pack --dry-run --workspace @system-design-team/cli
total files: 12; exit 0

npm pack --dry-run --workspace @system-design-team/codex-adapter
total files: 4; exit 0

git diff --check
exit 0
```

## Third review fixes

The production authorization writer and evidence/replay issues were reproduced before implementation:

```text
npm test -- tests/dispatch.test.mjs tests/security-recovery.test.mjs
tests 35; pass 33; fail 2

Production preparation was blocked before an approval request could exist, and the CLI had no prepared-request persistence API.
Additional RED checks showed execution could not resolve the current exact G8 approval without a future approval ID and review replay accepted a different receipt.
```

The adapter can now attest a branded prepared execution request before side effects. The CLI transactionally persists and audits that request, exposes `--execution-request`, and G8 approval consumes it to write an exact execution authorization. Adapter execution re-resolves current project evidence immediately before runtime handoff. G6 remains an ordinary referenced scope approval, while production and destructive authorization stays exact.

Evidence roles now match all shipped greenfield, existing-system, and migration workflows: security and data are conditional on configured specialist phases; DevOps release/deployment/cutover evidence can satisfy backup and rollback; and QA or DevOps validation evidence can satisfy dry-run checks. Generic charter evidence remains invalid.

G8 reviewer execution is receipt-bound but no longer circularly requires production authorization. `revision_required` reviewer results are recordable. Review and approval records plus audit events retain receipt/request IDs and digests, and replay rejects binding drift. Execution-receipt audits use the runtime result permission profile.

Focused GREEN:

```text
npm test -- tests/dispatch.test.mjs tests/workflow-engine.test.mjs tests/security-recovery.test.mjs
tests 85; pass 85; fail 0
```

Final third-review verification:

```text
npm run check
tests 155; pass 155; fail 0

npm pack --dry-run --workspace @system-design-team/cli
total files: 12; exit 0

npm pack --dry-run --workspace @system-design-team/codex-adapter
total files: 4; exit 0

git diff --check
exit 0
```
