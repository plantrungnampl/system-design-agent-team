# Agent Catalogue and END2END Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-agent, three-phase demonstration assets with the complete V1 role catalogue, three mode-specific END2END workflows, and deterministic Codex agent materialization during project initialization.

**Architecture:** Keep YAML as the canonical source. Extend the existing Zod contracts just enough to describe role boundaries and phase artifacts, validate cross-file references before initialization, and derive `.codex/agents/*.md` plus one reviewable artifact per phase from those validated assets. Do not add a generator framework, new dependency, SQLite, upgrade commands, or Python runtime.

**Tech Stack:** Node.js 20+, ESM-only strict TypeScript, npm workspaces, Zod, YAML, Node built-in test runner.

## Global Constraints

- Use Node.js 20 or newer and npm workspaces.
- Run `npm run check` before completion.
- Add behavior test-first and preserve genuine RED and GREEN evidence.
- Git-backed YAML is authoritative; generated Codex files contain no fabricated approval or plugin-invocation evidence.
- Required third-party plugins use their approved URIs and `block` fallback policy.
- Author and reviewer must be different agents in every phase.

---

### Task 1: Complete and cross-validate the canonical role catalogue

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `agents/catalogue.yaml`
- Test: `tests/core.test.mjs`

**Interfaces:**
- Produces: `AgentManifestSchema` fields `display_name`, `category`, `mission`, `authority`, `outputs`, and existing plugin contracts.
- Produces: a catalogue of the 21 approved core roles.

- [ ] **Step 1: Write failing contract tests**

Add assertions that parse the catalogue, require exactly the approved role IDs, reject an empty mission or self-review, and verify the required plugin mappings for UX, architecture, engineering, QA, and DevOps roles.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern="complete role catalogue"`

Expected: FAIL because the existing schema and catalogue contain only five minimal roles.

- [ ] **Step 3: Extend the schema and catalogue minimally**

Use these required manifest shapes:

```ts
authority: z.object({
  may: z.array(z.string().min(1)).min(1),
  may_not: z.array(z.string().min(1)).min(1),
}),
outputs: z.array(z.string().min(1)).min(1),
```

Populate the 21 roles approved in Section 8 of the design specification. Reuse the four canonical plugin URIs; do not invent plugin evidence or optional runtime behavior.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --test-name-pattern="complete role catalogue"`

Expected: PASS.

### Task 2: Define complete mode-specific workflows and phase artifacts

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `workflows/greenfield.yaml`
- Modify: `workflows/existing-system.yaml`
- Modify: `workflows/migration.yaml`
- Test: `tests/core.test.mjs`

**Interfaces:**
- Produces: `WorkflowPhaseSchema.artifact` with `id`, `path`, and `title`.
- Consumes: canonical agent IDs from Task 1.

- [ ] **Step 1: Write failing workflow tests**

Assert each mode has its approved ordered phase IDs, every phase owns one artifact, every owner/reviewer exists in the catalogue, every owner differs from its reviewer, and every dependency points backward rather than creating a cycle.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern="END2END workflow assets"`

Expected: FAIL because each current workflow contains only intake, requirements, and product.

- [ ] **Step 3: Add the minimal artifact contract and complete workflows**

Use one canonical reviewable artifact per phase. Model the approved Greenfield, Existing System, and Migration sequences; preserve human gates G0-G9 and required plugin URIs. Use repeated gates where multiple reviewed phases contribute to the same human decision.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --test-name-pattern="END2END workflow assets"`

Expected: PASS.

### Task 3: Materialize validated artifacts and Codex agent instructions at init

**Files:**
- Modify: `packages/cli/src/index.ts`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: `AgentManifest[]` and `WorkflowDefinition` from validated YAML.
- Produces: `.agent-team/<phase artifact path>` and `.codex/agents/<agent-id>.md`.

- [ ] **Step 1: Write failing initialization tests**

Initialize each project mode and assert that all configured phase artifacts are registered and created with matching front matter. Assert that every workflow participant has a generated Codex instruction file containing its mission, allowed actions, prohibited actions, outputs, reviewer, and plugin requirements.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern="materializes complete workflow assets"`

Expected: FAIL because init currently creates two artifacts and only `.codex/generated/.gitkeep`.

- [ ] **Step 3: Implement deterministic derivation**

Add two small pure render helpers in `packages/cli/src/index.ts`. Generate artifact Markdown with valid front matter and a concrete `Purpose` section; generate agent Markdown with a generated-file warning. Register artifacts directly from workflow phases. Keep writes inside existing `ProjectStore` atomic/path-containment controls.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test -- --test-name-pattern="materializes complete workflow assets"`

Expected: PASS.

Run: `npm run check`

Expected: all builds and tests pass.

### Task 4: Verify the milestone as a distributable repository change

**Files:**
- Modify only if verification exposes a defect directly caused by Tasks 1-3.

- [ ] **Step 1: Run repository checks**

Run: `npm run check`

Expected: PASS with no failed tests.

- [ ] **Step 2: Run package and diff checks**

Run: `npm ci --dry-run`

Expected: PASS.

Run: `npm pack --dry-run --workspace @system-design-team/cli`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 3: Review scope**

Confirm the diff implements only the role catalogue, workflow assets, derived initialization output, tests, and this plan. Record any remaining V1 work without implementing it in this milestone.
