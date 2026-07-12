# V1 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every Version 1 Definition of Done item in the approved System Design Agent Team specification without implementing Version 2 council automation or the Version 3 Python runtime.

**Architecture:** Build the remaining V1 capabilities in dependency order. First make persisted artifacts, audit events, changes, and multi-file mutations trustworthy; then add verified plugin/adapter execution and safety policy; then add project lifecycle, disposable SQLite indexing, and the remaining CLI surface; finally prove the three workflows and publish only verified documentation.

**Tech Stack:** Node.js 20+, ESM-only strict TypeScript, npm workspaces, Zod, YAML, Node built-in test runner, SQLite through the Node 22 built-in module only when available with a Node 20-compatible file-backed fallback prohibited; therefore V1 uses a rebuildable JSON query cache named `index.db` until a supported SQLite dependency is explicitly approved.

## Global Constraints

- Git-backed YAML and Markdown remain authoritative.
- No approval, plugin invocation, test, deployment, or authorization evidence may be fabricated.
- Every mutating command requires an operation ID and an append-only audit event.
- Author and reviewer executions remain independent.
- Production deployment and destructive actions require explicit human authorization.
- Required plugin identity is verified from the runtime adapter; project YAML cannot self-assert availability.
- Use Node.js 20 or newer, strict ESM TypeScript, existing dependencies, and Node's built-in test runner.
- Run `npm run check`, package smoke verification, and `git diff --check` before each milestone commit.

---

### Task 1: Persist artifact integrity, dependencies, traceability, and change requests

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/traceability/src/index.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: `tests/core.test.mjs`
- Test: `tests/artifact-traceability.test.mjs`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Produce `ArtifactDependencySchema`, `TraceabilityDocumentSchema`, `ChangeRequestSchema`, and enriched `ArtifactRecordSchema` with checksum and dependency metadata.
- Produce CLI operations `artifact list`, `artifact inspect`, `artifact validate`, `trace check`, `trace coverage`, `stale list`, and `change create`.
- `change create` computes downstream impact with `propagateStaleness`, marks affected artifacts stale, reopens only their owning phases, invalidates current approvals, and records one audit event.

- [ ] Write failing schema, checksum-tamper, propagation, CLI read, and change-impact tests.
- [ ] Run focused tests and confirm failures are caused by missing contracts and commands.
- [ ] Implement the minimum schemas and integrations; initialize `traceability.yaml` and artifact checksums.
- [ ] Make review, approval, dispatch, and handover reject checksum drift even when version/front matter is unchanged.
- [ ] Add the seven CLI command routes with no duplicate query layer.
- [ ] Run focused tests and `npm run check`.

### Task 2: Add recoverable multi-file transactions and enriched audit evidence

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/project-store/src/index.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `tests/project-store.test.mjs`
- Test: `tests/security-recovery.test.mjs`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Produce `AuditEventSchema` containing actor, authorization source, agent/adapter identity when applicable, permission profile, artifact versions, result, and timestamp.
- Produce `ProjectStore.transaction(operationId, writes, auditEvent)` using a journal under `.agent-team/transactions/` and atomic old-or-new recovery.
- Produce `repair` support for interrupted generated transactions without promoting incomplete evidence.

- [ ] Write fault-injection tests for interruption before journal commit, after evidence write, after state write, and before audit append.
- [ ] Verify RED with mixed-state or missing recovery behavior.
- [ ] Implement journaled writes, idempotent replay, and recovery inspection.
- [ ] Route review, approve, handover, change, plugin evidence, and initialization through the transaction contract.
- [ ] Verify old-or-new state in focused tests and run `npm run check`.

### Task 3: Implement trusted plugin capability and invocation evidence

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/plugin-registry/src/index.ts`
- Modify: `packages/codex-adapter/src/index.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `tests/dispatch.test.mjs`
- Test: `tests/security-recovery.test.mjs`

**Interfaces:**
- Produce `PluginAdapter.resolve`, `verifySkill`, and `invoke` contracts.
- Produce `PluginInvocationRecordSchema` with plugin URI, publisher identity, status, input/output digests, execution reference, and timestamps.
- Stored `plugin-status.yaml` is diagnostic cache only; `start` and `review` require a current adapter capability report.

- [ ] Write failing tests for spoofed publisher, incompatible plugin, missing skill, failed invocation, malformed result, and absent evidence.
- [ ] Implement a runtime adapter interface and a deterministic fake adapter for tests.
- [ ] Persist verified invocation evidence without chain-of-thought or secrets.
- [ ] Remove any lifecycle path that can become available only through self-authored project YAML.
- [ ] Run focused tests and `npm run check`.

### Task 4: Complete Codex execution, permissions, and release safety policies

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/codex-adapter/src/index.ts`
- Modify: `packages/workflow-engine/src/index.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `tests/dispatch.test.mjs`
- Test: `tests/workflow-engine.test.mjs`
- Test: `tests/security-recovery.test.mjs`

**Interfaces:**
- Complete `AgentExecutionAdapter` methods `checkCapabilities`, `prepareExecution`, `execute`, `collectResult`, and `cancel`.
- Validate structured execution results, checkpoints, permission profile, authorized paths, command class, and evidence before phase transition.
- Enforce G6 before code-write, current QA/security/data evidence at G7, explicit G8 production authorization, rollback/backup evidence, and destructive-action confirmation.

- [ ] Write failing permission-escalation, command-injection, cancellation, malformed-result, G6, G7, G8, destructive-action, backup, and rollback tests.
- [ ] Implement the smallest policy evaluator and execution-result schemas.
- [ ] Wire CLI lifecycle operations to verified execution evidence.
- [ ] Add `reject`, `gate readiness`, `secrets scan`, `diagnostics`, and `issue list` routes.
- [ ] Run focused tests and `npm run check`.

### Task 5: Complete project configuration, adoption, upgrades, and safe removal

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: `tests/cli.test.mjs`
- Test: `tests/security-recovery.test.mjs`

**Interfaces:**
- Expand project configuration with language, adapter, approval policy, plugin enforcement, cache, security classification, and environment overlays.
- Produce `adopt`, `inspect`, `upgrade --check`, `upgrade --dry-run`, `eject`, and `uninstall`; default uninstall preserves `.agent-team`.
- Upgrade analysis is deterministic, preserves local overrides, writes conflict proposals separately, and never auto-approves content.

- [ ] Write failing fresh/adopted/dirty/detached/missing-Git/read-only/override/eject/uninstall tests.
- [ ] Implement configuration precedence and profile-derived behavior.
- [ ] Implement repository inventory without source mutation.
- [ ] Implement read-only upgrade planning, eject materialization, and memory-preserving uninstall.
- [ ] Run focused tests and `npm run check`.

### Task 6: Add rebuildable project query cache and remaining validation commands

**Files:**
- Create: `packages/sqlite-cache/package.json`
- Create: `packages/sqlite-cache/tsconfig.json`
- Create: `packages/sqlite-cache/src/index.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: `tests/cache.test.mjs`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Produce disposable `index.db` from authoritative project files with source commit and schema version.
- Produce `cache rebuild`, `glossary validate`, and `evidence verify`.
- Cache corruption disables cache-backed queries but never blocks core workflow or loses authoritative data.

- [ ] Select a Node 20-compatible SQLite implementation already approved in the repository; if none exists, add the smallest maintained dependency and record the decision before production code.
- [ ] Write failing empty/populated/corrupt/stale/deleted/rebuild tests.
- [ ] Implement full rebuild and integrity metadata.
- [ ] Wire cache diagnostics and commands.
- [ ] Run focused tests and `npm run check`.

### Task 7: Prove all three workflows END2END

**Files:**
- Expand: `tests/e2e-greenfield.test.mjs`
- Create: `tests/e2e-existing-system.test.mjs`
- Create: `tests/e2e-migration.test.mjs`
- Create fixtures only under: `tests/fixtures/`

**Interfaces:**
- Greenfield reaches G9 with a revision cycle, architecture selection, implementation evidence, QA/security verdicts, G8 authorization, and post-release acceptance.
- Existing System proves scoped discovery, server-side authorization, modification of existing files, regression/security review, and no duplicate replacement implementation.
- Migration proves inventory, mapping, dry run, reconciliation, rollback/data-loss blocking, cutover approval, post-migration validation, and separate decommission approval.

- [ ] Build failing fixtures for the three approved scenarios.
- [ ] Implement only missing lifecycle behavior exposed by those fixtures.
- [ ] Add adversarial completion, secret, spoofing, and recovery cases.
- [ ] Run all fixture tests and `npm run check`.

### Task 8: Complete CI, packed-package smoke tests, and verified documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/architecture.md`
- Create: `docs/operations.md`
- Create: `docs/security.md`
- Create: `docs/upgrade.md`
- Create: `docs/troubleshooting.md`
- Add package smoke test under: `tests/`

**Interfaces:**
- CI covers Windows, Linux, macOS and Node 20/22 with build, tests, package smoke, and fixture tests.
- Packed CLI installation can initialize a repository using bundled assets.
- Documentation describes only commands and guarantees verified by the suite.

- [ ] Write package-install smoke and documentation consistency tests.
- [ ] Add the CI matrix and package smoke path.
- [ ] Replace first-slice and contradictory packaging text.
- [ ] Add installation, three-mode tutorials, operations, security, upgrade/recovery, and symptom-based troubleshooting documents.
- [ ] Run `npm run check`, packed-package smoke, `npm ci --dry-run`, and `git diff --check`.
