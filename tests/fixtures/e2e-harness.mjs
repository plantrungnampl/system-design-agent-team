import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  approve,
  handover,
  recordExecutionReceipt,
  recordExecutionRequest,
  reviewPhase,
  startPhase,
  validatePhase,
} from "@system-design-team/cli";
import { ManualCodexAdapter } from "@system-design-team/codex-adapter";
import { ProjectStore } from "@system-design-team/project-store";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const workflowFile = {
  greenfield: "greenfield.yaml",
  existing_system: "existing-system.yaml",
  migration: "migration.yaml",
};

export const operationKey = (action, target, raw) => JSON.stringify([action, target, raw]);

export const pluginAdapter = {
  async resolve(uri) {
    return { uri, publisher_identity: uri.split("@").at(-1), status: "available" };
  },
  async verifySkill() { return true; },
  async invoke() { throw new Error("TEST_INVOCATION_NOT_CONFIGURED"); },
};

export async function temporaryRepository(t, prefix, fixture) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (fixture) await cp(fixture, root, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

export async function readYaml(root, path) {
  return parse(await readFile(join(root, path), "utf8"));
}

export async function loadWorkflow(mode) {
  return parse(await readFile(join(import.meta.dirname, `../../workflows/${workflowFile[mode]}`), "utf8"));
}

export async function executionContext(root, mode) {
  const [workflow, registry, reviews, approvals] = await Promise.all([
    loadWorkflow(mode),
    readYaml(root, ".agent-team/artifact-registry.yaml"),
    readYaml(root, ".agent-team/reviews.yaml"),
    readYaml(root, ".agent-team/approvals.yaml"),
  ]);
  return {
    workflow,
    artifacts: registry.artifacts,
    reviews: reviews.reviews,
    approvals: approvals.approvals,
    verified_checksums: Object.fromEntries(registry.artifacts.map(({ id, checksum }) => [id, checksum])),
  };
}

export async function writePhaseArtifact(root, mode, phase, body, incrementVersion = false) {
  const workflow = await loadWorkflow(mode);
  const definition = workflow.phases.find(({ id }) => id === phase);
  const store = ProjectStore.open(root);
  const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
  const artifact = registry.artifacts.find(({ id }) => id === definition.artifact.id);
  if (incrementVersion) artifact.version += 1;
  artifact.status = "in_review";
  const text = [
    "---",
    `artifact_id: ${artifact.id}`,
    `version: ${artifact.version}`,
    "status: in_review",
    `owner: ${artifact.owner}`,
    `reviewer: ${artifact.reviewer}`,
    "---",
    `# ${definition.artifact.title}`,
    body,
  ].join("\n");
  artifact.checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, text);
  return artifact;
}

export async function artifactReference(root, mode, artifactId, includeApproval = true) {
  const [workflow, state, registry] = await Promise.all([
    loadWorkflow(mode),
    ProjectStore.open(root).readWorkflowState(),
    readYaml(root, ".agent-team/artifact-registry.yaml"),
  ]);
  const phase = workflow.phases.find(({ artifact }) => artifact.id === artifactId);
  const artifact = registry.artifacts.find(({ id }) => id === artifactId);
  return {
    artifact_id: artifact.id,
    version: artifact.version,
    status: artifact.status,
    review_id: state.phases[phase.id].review_id ?? `PENDING-${phase.id}`,
    ...(includeApproval && state.phases[phase.id].approval_id
      ? { approval_id: state.phases[phase.id].approval_id }
      : {}),
  };
}

export async function reviewerReceipt(root, mode, phase, evidence, suffix = "1") {
  const workflow = await loadWorkflow(mode);
  const definition = workflow.phases.find(({ id }) => id === phase);
  const adapter = new ManualCodexAdapter(() => executionContext(root, mode));
  const dispatch = {
    execution_id: `EXEC-REVIEW-${phase}-${suffix}`,
    agent_id: definition.reviewer,
    phase,
    review_verdict: "approved",
    authorized_scope: { read: [".agent-team/**"], write: [], execute: [] },
    required_inputs: [],
    permission_profile: "read_only_assessment",
    command_class: "safe_read",
  };
  const prepared = await adapter.prepareExecution(dispatch);
  const result = await adapter.collectResult(await adapter.execute(prepared), {
    execution_id: dispatch.execution_id,
    dispatch_digest: prepared.digest,
    status: "completed",
    permission_profile: dispatch.permission_profile,
    authorized_paths: dispatch.authorized_scope,
    command_class: dispatch.command_class,
    destructive: false,
    checkpoints: [{
      id: `review-${phase}`,
      status: "completed",
      timestamp: "2026-07-13T00:00:00.000Z",
      evidence: [`sha256:${"c".repeat(64)}`],
    }],
    evidence: evidence ?? { gate_approvals: [] },
  });
  return recordExecutionReceipt(root, adapter, result, `RECEIPT-REVIEW-${phase}-${suffix}`);
}

export async function reviewReadyPhase(root, mode, phase, body, options = {}) {
  const workflow = await loadWorkflow(mode);
  const definition = workflow.phases.find(({ id }) => id === phase);
  const suffix = options.suffix ?? "1";
  await startPhase(root, phase, `START-${phase}-${suffix}`, options.pluginAdapter ?? pluginAdapter);
  await writePhaseArtifact(root, mode, phase, body, options.incrementVersion);
  const validation = await validatePhase(root, phase, `VALIDATE-${phase}-${suffix}`);
  assert.equal(validation.valid, true, JSON.stringify(validation.findings));
  const receipt = definition.gate === "G7" || definition.gate === "G8"
    ? await reviewerReceipt(root, mode, phase, options.evidence, suffix)
    : undefined;
  await reviewPhase(root, phase, definition.reviewer, options.verdict ?? "approved",
    `REVIEW-${phase}-${suffix}`, options.pluginAdapter ?? pluginAdapter, receipt?.id);
  return { definition, receipt };
}

export async function approveAndHandover(root, mode, phase, options = {}) {
  const workflow = await loadWorkflow(mode);
  const definition = workflow.phases.find(({ id }) => id === phase);
  const suffix = options.suffix ?? "1";
  await approve(root, definition.gate, "project-owner", `APPROVE-${phase}-${suffix}`,
    options.receipt?.id, options.request?.id);
  if (workflow.phases.some(({ depends_on }) => depends_on.includes(phase))) {
    await handover(root, phase, `HANDOVER-${phase}-${suffix}`);
  }
}

export async function recordCodeExecution(root, mode, phase, changedFiles) {
  const state = await ProjectStore.open(root).readWorkflowState();
  const workflow = await loadWorkflow(mode);
  const dependency = workflow.phases.find(({ id }) => id === phase).depends_on[0];
  const g6 = state.phases[dependency].approval_id;
  const adapter = new ManualCodexAdapter(() => executionContext(root, mode));
  const dispatch = {
    execution_id: `EXEC-CODE-${phase}`,
    agent_id: "developer",
    phase,
    authorized_scope: { read: ["src/**", "tests/**"], write: ["src/**", "tests/**"], execute: ["dotnet test"] },
    required_inputs: [],
    permission_profile: "code_write",
    command_class: "mutating_local",
    execution_evidence: { gate_approvals: [{ gate: "G6", approval_id: g6 }] },
  };
  const prepared = await adapter.prepareExecution(dispatch);
  const result = await adapter.collectResult(await adapter.execute(prepared), {
    execution_id: dispatch.execution_id,
    dispatch_digest: prepared.digest,
    status: "completed",
    permission_profile: dispatch.permission_profile,
    authorized_paths: dispatch.authorized_scope,
    command_class: dispatch.command_class,
    destructive: false,
    checkpoints: [{
      id: "implementation-and-tests",
      status: "completed",
      timestamp: "2026-07-13T00:00:00.000Z",
      evidence: [`sha256:${"d".repeat(64)}`],
    }],
    evidence: dispatch.execution_evidence,
    output: { changed_files: changedFiles },
  });
  return recordExecutionReceipt(root, adapter, result, `RECEIPT-CODE-${phase}`);
}

export async function recordProductionRequest(root, mode, phase, evidence, options = {}) {
  const adapter = new ManualCodexAdapter(() => executionContext(root, mode));
  const dispatch = {
    execution_id: options.executionId ?? `EXEC-PRODUCTION-${phase}`,
    objective: `Execute approved ${phase}`,
    authorized_scope: { read: ["release/**"], write: ["release/**"], execute: ["deploy"] },
    required_inputs: [],
    permission_profile: "production_execution",
    command_class: "production_impact",
    destructive: options.destructive ?? false,
    execution_evidence: evidence,
  };
  const prepared = await adapter.prepareExecution(dispatch);
  return recordExecutionRequest(root, adapter, prepared, options.operationId ?? `REQUEST-${phase}`);
}
