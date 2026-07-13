import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  approve,
  handover,
  initProject,
  recordExecutionReceipt,
  recordExecutionRequest,
  reviewPhase as reviewPhaseWithAdapter,
  setPluginStatus,
  startPhase as startPhaseWithAdapter,
  validatePhase,
} from "@system-design-team/cli";
import { ManualCodexAdapter } from "@system-design-team/codex-adapter";
import { ProjectStore } from "@system-design-team/project-store";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const pluginUri = "plugin://superpowers@openai-curated-remote";
const operationKey = (action, target, raw) => JSON.stringify([action, target, raw]);
const adapterWithStatus = (status) => ({
  async resolve(uri) {
    return { uri, publisher_identity: uri.slice(uri.lastIndexOf("@") + 1), status };
  },
  async verifySkill() {
    return true;
  },
  async invoke() {
    throw new Error("TEST_INVOCATION_NOT_CONFIGURED");
  },
});
const pluginAdapter = adapterWithStatus("available");
const startPhase = (root, phase, operationId, adapter = pluginAdapter) =>
  startPhaseWithAdapter(root, phase, operationId, adapter);
const reviewPhase = (root, phase, reviewer, verdict, operationId, adapter = pluginAdapter, receiptId) =>
  reviewPhaseWithAdapter(root, phase, reviewer, verdict, operationId, adapter, receiptId);

async function temporaryGitRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function readYaml(root, path) {
  return parse(await readFile(join(root, path), "utf8"));
}

async function makeReviewReady(root, artifactId) {
  const store = ProjectStore.open(root);
  const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
  const artifact = registry.artifacts.find(({ id }) => id === artifactId);
  artifact.status = "in_review";
  const text = [
    "---",
    `artifact_id: ${artifact.id}`,
    `version: ${artifact.version}`,
    "status: in_review",
    `owner: ${artifact.owner}`,
    `reviewer: ${artifact.reviewer}`,
    "---",
    `# ${artifact.id}`,
    "The artifact is complete and ready for independent review.",
  ].join("\n");
  artifact.checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, text);
}

async function workflowFixture() {
  return parse(await readFile(join(import.meta.dirname, "../workflows/greenfield.yaml"), "utf8"));
}

async function executionContext(root) {
  const [workflow, registry, reviews, approvals] = await Promise.all([
    workflowFixture(),
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

async function writePhaseArtifact(root, phase, body, incrementVersion = false) {
  const workflow = await workflowFixture();
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

async function artifactReference(root, artifactId, includeApproval = true) {
  const [workflow, state, registry] = await Promise.all([
    workflowFixture(),
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

async function reviewerReceipt(root, phase, evidence = { gate_approvals: [] }) {
  const workflow = await workflowFixture();
  const definition = workflow.phases.find(({ id }) => id === phase);
  const adapter = new ManualCodexAdapter(() => executionContext(root));
  const dispatch = {
    execution_id: `EXEC-REVIEW-${phase}`,
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
      evidence: [`sha256:${"a".repeat(64)}`],
    }],
    evidence,
  });
  return {
    adapter,
    receipt: await recordExecutionReceipt(root, adapter, result, `RECEIPT-REVIEW-${phase}`),
  };
}

async function reviewReadyPhase(root, phase, body, evidence, options = {}) {
  const workflow = await workflowFixture();
  const definition = workflow.phases.find(({ id }) => id === phase);
  const round = options.incrementVersion ? 2 : 1;
  await startPhase(root, phase, `START-${phase}-${round}`);
  await writePhaseArtifact(root, phase, body, options.incrementVersion);
  assert.equal((await validatePhase(root, phase, `VALIDATE-${phase}-${round}`)).valid, true);
  const receipt = definition.gate === "G7" || definition.gate === "G8"
    ? (await reviewerReceipt(root, phase, evidence)).receipt
    : undefined;
  await reviewPhase(root, phase, definition.reviewer, options.verdict ?? "approved",
    `REVIEW-${phase}-${round}`, pluginAdapter, receipt?.id);
  return { definition, receipt };
}

test("greenfield reaches G9 with revision, attested implementation, release, and post-release acceptance", async (t) => {
  const root = await temporaryGitRepository(t);
  await initProject(root, {
    id: "leave-system-full",
    name: "Internal Leave Request System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-GREENFIELD-FULL");

  for (const [phase, body] of [
    ["intake", "Mode: greenfield. Profile: standard. Sponsor: HR Director."],
    ["business-discovery", "Goal: reduce leave approval time. Success metric: 95% within one business day."],
  ]) {
    const { receipt } = await reviewReadyPhase(root, phase, body);
    await approveAndHandover(root, phase, receipt);
  }

  await startPhase(root, "requirements", "START-requirements-1");
  await writePhaseArtifact(root, "requirements", "Everything passed.");
  const unsupported = await validatePhase(root, "requirements", "VALIDATE-unsupported-completion");
  assert.equal(unsupported.valid, false);
  assert(unsupported.findings.some(({ code }) => code === "UNSUPPORTED_COMPLETION_CLAIM"));

  await writePhaseArtifact(root, "requirements", "Employees submit leave requests; managers approve or reject with an auditable reason.");
  assert.equal((await validatePhase(root, "requirements", "VALIDATE-requirements-1")).valid, true);
  await reviewPhase(root, "requirements", "requirements-reviewer", "revision_required",
    "REVIEW-requirements-1", pluginAdapter);
  assert.equal((await ProjectStore.open(root).readWorkflowState()).phases.requirements.status, "revision_required");

  const revised = await reviewReadyPhase(
    root,
    "requirements",
    "Employees submit leave requests; managers approve or reject with an auditable reason. Acceptance: rejected requests retain the reviewer and timestamp.",
    undefined,
    { incrementVersion: true },
  );
  await approveAndHandover(root, "requirements", revised.receipt);

  for (const [phase, body] of [
    ["product", "MVP includes request submission, manager decision, audit history, and notifications."],
    ["ux", "Flow covers submit, loading, success, rejection, validation error, and keyboard navigation."],
    ["system-analysis", "Modules: identity, leave requests, approval workflow, audit log, and notifications."],
    ["architecture", "Options: modular monolith or services. Selected stack: Node.js, PostgreSQL, and managed backups."],
  ]) {
    const { receipt } = await reviewReadyPhase(root, phase, body);
    await approveAndHandover(root, phase, receipt);
  }
  const architectureApproval = (await readYaml(root, ".agent-team/approvals.yaml")).approvals
    .find(({ id }) => id === operationKey("approve", "G5", "APPROVE-architecture"));
  assert.deepEqual(architectureApproval.approved_by, { type: "human", identifier: "project-owner" });

  const blockedCodeAdapter = new ManualCodexAdapter(() => executionContext(root));
  await assert.rejects(() => blockedCodeAdapter.prepareExecution({
    execution_id: "EXEC-CODE-BEFORE-G6",
    authorized_scope: { read: ["src/**"], write: ["src/**"], execute: ["npm test"] },
    required_inputs: [],
    permission_profile: "code_write",
    command_class: "mutating_local",
    execution_evidence: { gate_approvals: [] },
  }), /G6_APPROVAL_REQUIRED/);

  const planning = await reviewReadyPhase(
    root,
    "implementation-planning",
    "Vertical slice: submit and decide a request. Definition of Done includes unit, authorization, and rollback tests.",
  );
  await approveAndHandover(root, "implementation-planning", planning.receipt);
  const g6 = (await ProjectStore.open(root).readWorkflowState()).phases["implementation-planning"].approval_id;
  const codeAdapter = new ManualCodexAdapter(() => executionContext(root));
  const codeDispatch = {
    execution_id: "EXEC-IMPLEMENT-LEAVE-SLICE",
    agent_id: "developer",
    phase: "implementation",
    authorized_scope: { read: ["src/**"], write: ["src/**"], execute: ["npm test"] },
    required_inputs: [],
    permission_profile: "code_write",
    command_class: "mutating_local",
    execution_evidence: { gate_approvals: [{ gate: "G6", approval_id: g6 }] },
  };
  const preparedCode = await codeAdapter.prepareExecution(codeDispatch);
  const codeResult = await codeAdapter.collectResult(await codeAdapter.execute(preparedCode), {
    execution_id: codeDispatch.execution_id,
    dispatch_digest: preparedCode.digest,
    status: "completed",
    permission_profile: codeDispatch.permission_profile,
    authorized_paths: codeDispatch.authorized_scope,
    command_class: codeDispatch.command_class,
    destructive: false,
    checkpoints: [{
      id: "tests-pass",
      status: "completed",
      timestamp: "2026-07-13T00:00:00.000Z",
      evidence: [`sha256:${"b".repeat(64)}`],
    }],
    evidence: codeDispatch.execution_evidence,
    output: { changed_files: ["src/leave-request.ts", "tests/leave-request.test.ts"] },
  });
  const implementationReceipt = await recordExecutionReceipt(
    root, codeAdapter, codeResult, "RECEIPT-IMPLEMENT-LEAVE-SLICE",
  );

  await startPhase(root, "implementation", "START-implementation-1");
  await writePhaseArtifact(root, "implementation", `Vertical slice implemented. Receipt: ${implementationReceipt.id}.`);
  assert.equal((await validatePhase(root, "implementation", "VALIDATE-implementation-1")).valid, true);
  await assert.rejects(
    () => reviewPhase(root, "implementation", "code-reviewer", "approved", "REVIEW-implementation-missing", pluginAdapter),
    /REVIEW_EXECUTION_RECEIPT_REQUIRED/,
  );
  const implementationReview = await reviewerReceipt(root, "implementation");
  await reviewPhase(root, "implementation", "code-reviewer", "approved",
    "REVIEW-implementation-1", pluginAdapter, implementationReview.receipt.id);
  await approveAndHandover(root, "implementation", implementationReview.receipt);

  const verification = await reviewReadyPhase(
    root,
    "verification",
    "Unit, integration, negative authorization, and regression suites passed with retained execution evidence.",
    { gate_approvals: [] },
  );
  await approveAndHandover(root, "verification", verification.receipt);
  const qa = await artifactReference(root, "TEST-SUMMARY");

  await startPhase(root, "release-readiness", "START-release-readiness-1");
  await writePhaseArtifact(root, "release-readiness", "Threat model reviewed; no blocking findings; residual risks accepted by the owner.");
  assert.equal((await validatePhase(root, "release-readiness", "VALIDATE-release-readiness-1")).valid, true);
  const securityPending = await artifactReference(root, "RELEASE-READINESS", false);
  const releaseEvidence = { gate_approvals: [], qa, security: securityPending };
  const releaseReview = await reviewerReceipt(root, "release-readiness", releaseEvidence);
  await reviewPhase(root, "release-readiness", "architecture-reviewer", "approved",
    "REVIEW-release-readiness-1", pluginAdapter, releaseReview.receipt.id);
  await approveAndHandover(root, "release-readiness", releaseReview.receipt);
  const security = await artifactReference(root, "RELEASE-READINESS");

  await startPhase(root, "deployment", "START-deployment-1");
  await writePhaseArtifact(root, "deployment", "Managed backup verified. Rollback restores the previous image and schema before traffic resumes.");
  assert.equal((await validatePhase(root, "deployment", "VALIDATE-deployment-1")).valid, true);
  const deploymentPending = await artifactReference(root, "DEPLOYMENT-PLAN", false);
  const deploymentReviewEvidence = {
    gate_approvals: [], qa, security, backup: deploymentPending, rollback: deploymentPending,
  };
  const deploymentReview = await reviewerReceipt(root, "deployment", deploymentReviewEvidence);
  await reviewPhase(root, "deployment", "operations-reviewer", "approved",
    "REVIEW-deployment-1", pluginAdapter, deploymentReview.receipt.id);
  const g8ApprovalId = operationKey("approve", "G8", "APPROVE-deployment");
  const productionEvidence = {
    ...deploymentReviewEvidence,
    gate_approvals: [{ gate: "G8", approval_id: g8ApprovalId }],
  };
  const productionAdapter = new ManualCodexAdapter(() => executionContext(root));
  const preparedDeployment = await productionAdapter.prepareExecution({
    execution_id: "EXEC-DEPLOY-LEAVE-SYSTEM",
    objective: "Deploy the approved leave system",
    authorized_scope: { read: ["release/**"], write: ["release/**"], execute: ["deploy"] },
    required_inputs: [],
    permission_profile: "production_execution",
    command_class: "production_impact",
    execution_evidence: productionEvidence,
  });
  const deploymentRequest = await recordExecutionRequest(
    root, productionAdapter, preparedDeployment, "REQUEST-DEPLOY-LEAVE-SYSTEM",
  );
  await approveAndHandover(root, "deployment", deploymentReview.receipt, deploymentRequest);

  const operational = await reviewReadyPhase(
    root,
    "operational-validation",
    "Health checks, alert routing, core leave journey, and data integrity checks passed.",
  );
  await approveAndHandover(root, "operational-validation", operational.receipt);
  const postRelease = await reviewReadyPhase(
    root,
    "post-release-review",
    "Business owner accepts the release; monitoring and incident readiness remain active.",
  );
  await approveAndHandover(root, "post-release-review", postRelease.receipt);

  const finalState = await ProjectStore.open(root).readWorkflowState();
  assert.equal(finalState.phases["post-release-review"].status, "approved");
  assert.equal(finalState.phases.deployment.status, "handed_over");
  const approvals = (await readYaml(root, ".agent-team/approvals.yaml")).approvals;
  assert.equal(approvals.filter(({ gate }) => gate === "G9").length, 2);
});

async function approveAndHandover(root, phase, receipt, request) {
  const workflow = await workflowFixture();
  const definition = workflow.phases.find(({ id }) => id === phase);
  await approve(root, definition.gate, "project-owner", `APPROVE-${phase}`, receipt?.id, request?.id);
  if (workflow.phases.some(({ depends_on }) => depends_on.includes(phase))) {
    await handover(root, phase, `HANDOVER-${phase}`);
  }
}

test("greenfield requirements flow blocks missing plugins and reaches handover with evidence", async (t) => {
  const root = await temporaryGitRepository(t);
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-E2E-1");

  await assert.rejects(
    () => startPhase(root, "intake", "OP-START-INTAKE", adapterWithStatus("unknown")),
    /REQUIRED_PLUGIN_UNKNOWN/,
  );
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);

  await startPhase(root, "intake", "OP-START-INTAKE");
  await makeReviewReady(root, "PROJECT-CHARTER");
  assert.equal((await validatePhase(root, "intake", "OP-VALIDATE-INTAKE")).valid, true);
  await reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW-INTAKE");
  await approve(root, "G0", "project-owner", "OP-APPROVE-G0");
  await handover(root, "intake", "OP-HANDOVER-INTAKE");

  await startPhase(root, "business-discovery", "OP-START-DISCOVERY");
  await makeReviewReady(root, "BUSINESS-CONTEXT");
  assert.equal((await validatePhase(root, "business-discovery", "OP-VALIDATE-DISCOVERY")).valid, true);
  await reviewPhase(root, "business-discovery", "business-analyst", "approved", "OP-REVIEW-DISCOVERY");
  await approve(root, "G1", "project-owner", "OP-APPROVE-G1");
  await handover(root, "business-discovery", "OP-HANDOVER-DISCOVERY");

  await startPhase(root, "requirements", "OP-START-REQ");
  await makeReviewReady(root, "REQUIREMENTS");
  assert.equal((await validatePhase(root, "requirements", "OP-VALIDATE-REQ")).valid, true);
  await reviewPhase(root, "requirements", "requirements-reviewer", "approved", "OP-REVIEW-REQ");
  await approve(root, "G2", "project-owner", "OP-APPROVE-G2");
  await handover(root, "requirements", "OP-HANDOVER-REQ");

  const store = ProjectStore.open(root);
  const finalState = await store.readWorkflowState();
  const { reviews } = await readYaml(root, ".agent-team/reviews.yaml");
  const { approvals } = await readYaml(root, ".agent-team/approvals.yaml");
  const intakeHandover = await readYaml(root, ".agent-team/handovers/intake.yaml");
  const discoveryHandover = await readYaml(root, ".agent-team/handovers/business-discovery.yaml");
  const requirementsHandover = await readYaml(root, ".agent-team/handovers/requirements.yaml");

  assert.equal(finalState.phases.requirements.status, "handed_over");
  assert.equal(finalState.phases.product.status, "ready");
  assert.deepEqual(reviews.map(({ id, reviewer, artifact_versions }) => ({
    id,
    reviewer,
    artifact_versions,
  })), [
    {
      id: operationKey("review", "intake", "OP-REVIEW-INTAKE"),
      reviewer: "documentation-reviewer",
      artifact_versions: { "PROJECT-CHARTER": 1 },
    },
    {
      id: operationKey("review", "business-discovery", "OP-REVIEW-DISCOVERY"),
      reviewer: "business-analyst",
      artifact_versions: { "BUSINESS-CONTEXT": 1 },
    },
    {
      id: operationKey("review", "requirements", "OP-REVIEW-REQ"),
      reviewer: "requirements-reviewer",
      artifact_versions: { REQUIREMENTS: 1 },
    },
  ]);
  assert.deepEqual(approvals.map(({ id, gate, approved_by, artifact_versions }) => ({
    id,
    gate,
    approved_by,
    artifact_versions,
  })), [
    {
      id: operationKey("approve", "G0", "OP-APPROVE-G0"),
      gate: "G0",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "PROJECT-CHARTER": 1 },
    },
    {
      id: operationKey("approve", "G1", "OP-APPROVE-G1"),
      gate: "G1",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "BUSINESS-CONTEXT": 1 },
    },
    {
      id: operationKey("approve", "G2", "OP-APPROVE-G2"),
      gate: "G2",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { REQUIREMENTS: 1 },
    },
  ]);
  assert.deepEqual(
    [intakeHandover, discoveryHandover, requirementsHandover]
      .map(({ id, approved_inputs }) => ({ id, approved_inputs })),
    [
      {
        id: operationKey("handover", "intake", "OP-HANDOVER-INTAKE"),
        approved_inputs: ["PROJECT-CHARTER@1"],
      },
      {
        id: operationKey("handover", "business-discovery", "OP-HANDOVER-DISCOVERY"),
        approved_inputs: ["BUSINESS-CONTEXT@1"],
      },
      {
        id: operationKey("handover", "requirements", "OP-HANDOVER-REQ"),
        approved_inputs: ["REQUIREMENTS@1"],
      },
    ],
  );
  assert.deepEqual(finalState.completed_operations, [
    operationKey("start", "intake", "OP-START-INTAKE"),
    operationKey("validate", "intake", "OP-VALIDATE-INTAKE"),
    operationKey("review-under-review", "intake", "OP-REVIEW-INTAKE"),
    operationKey("review-verdict", "intake", "OP-REVIEW-INTAKE"),
    operationKey("approve", "G0", "OP-APPROVE-G0"),
    operationKey("handover", "intake", "OP-HANDOVER-INTAKE"),
    operationKey("handover-ready", "intake->business-discovery", "OP-HANDOVER-INTAKE"),
    operationKey("start", "business-discovery", "OP-START-DISCOVERY"),
    operationKey("validate", "business-discovery", "OP-VALIDATE-DISCOVERY"),
    operationKey("review-under-review", "business-discovery", "OP-REVIEW-DISCOVERY"),
    operationKey("review-verdict", "business-discovery", "OP-REVIEW-DISCOVERY"),
    operationKey("approve", "G1", "OP-APPROVE-G1"),
    operationKey("handover", "business-discovery", "OP-HANDOVER-DISCOVERY"),
    operationKey("handover-ready", "business-discovery->requirements", "OP-HANDOVER-DISCOVERY"),
    operationKey("start", "requirements", "OP-START-REQ"),
    operationKey("validate", "requirements", "OP-VALIDATE-REQ"),
    operationKey("review-under-review", "requirements", "OP-REVIEW-REQ"),
    operationKey("review-verdict", "requirements", "OP-REVIEW-REQ"),
    operationKey("approve", "G2", "OP-APPROVE-G2"),
    operationKey("handover", "requirements", "OP-HANDOVER-REQ"),
    operationKey("handover-ready", "requirements->product", "OP-HANDOVER-REQ"),
  ]);
});
