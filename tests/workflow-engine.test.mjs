import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  approveGate,
  evaluateExecutionPolicy,
  gateReadiness,
  transitionPhase,
} from "@system-design-team/workflow-engine";

const workflow = {
  id: "greenfield-standard",
  version: "1.0.0",
  mode: "greenfield",
  phases: [
    { id: "intake", owner: "lead-orchestrator", reviewer: "documentation-reviewer", gate: "G0", depends_on: [] },
    { id: "requirements", owner: "business-analyst", reviewer: "requirements-reviewer", gate: "G2", depends_on: ["intake"] },
  ],
};

const state = {
  schema_version: 1,
  state_version: 0,
  project_id: "leave-system",
  current_phase: "intake",
  phases: {
    intake: { status: "approved" },
    requirements: { status: "not_started" },
  },
  completed_operations: [],
};

function withPhase(source, phase, status) {
  return {
    ...source,
    phases: { ...source.phases, [phase]: { ...source.phases[phase], status } },
  };
}

test("prevents skipping from not_started to approved", () => {
  assert.throws(() => transitionPhase(state, workflow, {
    phase: "requirements",
    to: "approved",
    operation_id: "OP-1",
  }), /INVALID_TRANSITION/);
});

test("requires an independent human G2 approval", () => {
  const awaiting = withPhase(state, "requirements", "awaiting_approval");
  assert.throws(() => approveGate(awaiting, workflow, {
    id: "APR-1",
    gate: "G2",
    decision: "approved",
    approved_by: { type: "agent", identifier: "business-analyst" },
    artifact_versions: { SRS: 1 },
    timestamp: "2026-07-11T00:00:00Z",
  }), /HUMAN_APPROVAL_REQUIRED/);
});

test("replaying an operation id returns unchanged state", () => {
  const ready = withPhase(state, "requirements", "ready");
  const once = transitionPhase(ready, workflow, {
    phase: "requirements",
    to: "in_progress",
    operation_id: "OP-2",
  });

  assert.strictEqual(transitionPhase(once, workflow, {
    phase: "requirements",
    to: "in_progress",
    operation_id: "OP-2",
  }), once);
});

test("requires approved dependencies before a phase becomes ready", () => {
  const blocked = withPhase(state, "intake", "in_progress");
  assert.throws(() => transitionPhase(blocked, workflow, {
    phase: "requirements",
    to: "ready",
    operation_id: "OP-3",
  }), /DEPENDENCIES_NOT_APPROVED/);
});

test("records an approved gate on its awaiting phase", () => {
  const awaiting = withPhase(state, "requirements", "awaiting_approval");
  const approved = approveGate(awaiting, workflow, {
    id: "APR-2",
    gate: "G2",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { SRS: 1 },
    timestamp: "2026-07-11T00:00:00Z",
  });

  assert.deepEqual(approved.phases.requirements, { status: "approved", approval_id: "APR-2" });
  assert.equal(approved.state_version, awaiting.state_version + 1);
  assert.deepEqual(approved.completed_operations, ["APR-2"]);
  assert.deepEqual(awaiting.phases.requirements, { status: "awaiting_approval" });
});

test("rejects gate approval before the phase awaits approval", () => {
  assert.throws(() => approveGate(state, workflow, {
    id: "APR-3",
    gate: "G2",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { SRS: 1 },
    timestamp: "2026-07-11T00:00:00Z",
  }), /INVALID_APPROVAL_STATE/);
});

test("prevents approval without an approval record", () => {
  const awaiting = withPhase(state, "requirements", "awaiting_approval");
  assert.throws(() => transitionPhase(awaiting, workflow, {
    phase: "requirements",
    to: "approved",
    operation_id: "OP-4",
  }), /APPROVAL_REQUIRED/);
});

test("rejects a forged approval id on the public transition API", () => {
  const awaiting = withPhase(state, "requirements", "awaiting_approval");
  const forged = {
    ...awaiting,
    phases: {
      ...awaiting.phases,
      requirements: { ...awaiting.phases.requirements, approval_id: "APR-FORGED" },
    },
  };

  assert.throws(() => transitionPhase(forged, workflow, {
    phase: "requirements",
    to: "approved",
    operation_id: "OP-FORGED",
  }), /APPROVAL_REQUIRED/);
});

test("rejects human self-approval by the phase owner", () => {
  const awaiting = withPhase(state, "requirements", "awaiting_approval");
  assert.throws(() => approveGate(awaiting, workflow, {
    id: "APR-SELF",
    gate: "G2",
    decision: "approved",
    approved_by: { type: "human", identifier: "business-analyst" },
    artifact_versions: { SRS: 1 },
    timestamp: "2026-07-11T00:00:00Z",
  }), /SELF_APPROVAL_FORBIDDEN/);
});

test("approves the awaiting phase when a gate is shared", () => {
  const definition = {
    ...workflow,
    phases: [
      ...workflow.phases,
      { id: "architecture", owner: "architect", reviewer: "architecture-reviewer", gate: "G2", depends_on: [] },
    ],
  };
  const workflowState = {
    ...state,
    phases: {
      ...state.phases,
      requirements: { status: "approved" },
      architecture: { status: "awaiting_approval" },
    },
  };

  const approved = approveGate(workflowState, definition, {
    id: "APR-4",
    gate: "G2",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { ARCHITECTURE: 1 },
    timestamp: "2026-07-11T00:00:00Z",
  });

  assert.deepEqual(approved.phases.architecture, { status: "approved", approval_id: "APR-4" });
});

test("rejects a state phase that is not configured by the workflow", () => {
  const invalidState = {
    ...state,
    phases: { ...state.phases, ghost: { status: "not_started" } },
  };
  assert.throws(() => transitionPhase(invalidState, workflow, {
    phase: "ghost",
    to: "ready",
    operation_id: "OP-5",
  }), /PHASE_NOT_CONFIGURED/);
});

test("reports gate blockers in deterministic phase order", () => {
  const definition = {
    ...workflow,
    phases: [
      ...workflow.phases,
      { id: "architecture", owner: "architect", reviewer: "architecture-reviewer", gate: "G2", depends_on: [] },
      { id: "backlog", owner: "product-owner", reviewer: "product-reviewer", gate: "G2", depends_on: [] },
      { id: "handover", owner: "owner", reviewer: "reviewer", gate: "G2", depends_on: [] },
    ],
  };
  const workflowState = {
    ...state,
    phases: {
      ...state.phases,
      requirements: { status: "approved" },
      architecture: { status: "ready" },
      backlog: { status: "under_review" },
      handover: { status: "handed_over" },
    },
  };

  assert.deepEqual(gateReadiness(workflowState, definition, "G2"), {
    gate: "G2",
    ready: false,
    blockers: ["PHASE_NOT_APPROVED:architecture", "PHASE_NOT_APPROVED:backlog"],
  });
});

const evidenceRoles = {
  QA: ["verification", "qa-lead", "tester", "testing/qa.md", "QA Evidence", "G7"],
  SECURITY: ["security-review", "security-reviewer", "architecture-reviewer", "security/verdict.md", "Security Verdict", "G7"],
  DATA: ["data-mapping", "system-analyst", "data-reviewer", "data/mapping.md", "Data Reconciliation", "G7"],
  BACKUP: ["backup-verification", "devops-lead", "operations-reviewer", "release/backup-verification.md", "Backup Verification", "G8"],
  "DRY-RUN": ["deployment-rehearsal", "devops-lead", "operations-reviewer", "release/deployment-rehearsal.md", "Deployment Dry Run", "G8"],
  ROLLBACK: ["rollback-planning", "devops-lead", "operations-reviewer", "release/rollback-plan.md", "Rollback Plan", "G8"],
};
const evidenceArtifacts = Object.entries(evidenceRoles).map(([id, [, owner, reviewer, path, , gate]]) => ({
  id,
  path,
  type: "document",
  version: 1,
  status: "approved",
  owner,
  reviewer,
  dependencies: [],
  consumers: [],
  required_gate: gate,
  checksum: `sha256:${"a".repeat(64)}`,
}));
const evidenceWorkflow = {
  id: "evidence-workflow",
  version: "1.0.0",
  mode: "greenfield",
  phases: Object.entries(evidenceRoles).map(([id, [phase, owner, reviewer, path, title, gate]]) => ({
    id: phase,
    owner,
    reviewer,
    gate,
    depends_on: [],
    required_plugins: [],
    artifact: { id, path, title },
  })),
};
const executionAuthorization = {
  execution_id: "EXEC-POLICY",
  dispatch_digest: "b".repeat(64),
  permission_profile: "code_write",
  authorized_paths: { read: ["src/**"], write: ["src/**"], execute: ["npm test"] },
  command_class: "mutating_local",
  destructive: false,
};
const evidenceContext = {
  artifacts: evidenceArtifacts,
  workflow: evidenceWorkflow,
  verified_checksums: Object.fromEntries(evidenceArtifacts.map(({ id, checksum }) => [id, checksum])),
  reviews: evidenceArtifacts.map(({ id, reviewer }) => ({
    id: `REV-${id}`,
    phase: evidenceRoles[id][0],
    reviewer,
    verdict: "approved",
    artifact_versions: { [id]: 1 },
    timestamp: "2026-07-13T00:00:00Z",
  })),
  approvals: ["G6", "G7", "G8"].map((gate) => ({
    id: `APR-${gate}`,
    gate,
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: Object.fromEntries(evidenceArtifacts.map(({ id }) => [id, 1])),
    execution_authorization: executionAuthorization,
    timestamp: "2026-07-13T00:00:00Z",
  })),
};
const artifactReference = (id) => ({
  artifact_id: id,
  version: 1,
  status: "approved",
  review_id: `REV-${id}`,
  approval_id: ["BACKUP", "DRY-RUN", "ROLLBACK"].includes(id) ? "APR-G8" : "APR-G7",
});
const gateReference = (gate) => ({ gate, approval_id: `APR-${gate}` });
const policyInput = {
  execution_id: "EXEC-POLICY",
  dispatch_digest: "b".repeat(64),
  permission_profile: "code_write",
  authorized_paths: { read: ["src/**"], write: ["src/**"], execute: ["npm test"] },
  command_class: "mutating_local",
  destructive: false,
  evidence: { gate_approvals: [] },
};
const contextAuthorizedFor = (input) => ({
  ...evidenceContext,
  approvals: evidenceContext.approvals.map((approval) => ({
    ...approval,
    execution_authorization: {
      execution_id: input.execution_id,
      dispatch_digest: input.dispatch_digest,
      permission_profile: input.permission_profile,
      authorized_paths: input.authorized_paths,
      command_class: input.command_class,
      destructive: input.destructive,
    },
  })),
});

test("G6 blocks code-write execution until authoritatively approved", () => {
  assert.deepEqual(evaluateExecutionPolicy(policyInput, evidenceContext).blockers, ["G6_APPROVAL_REQUIRED"]);
});

test("G7 requires current QA, security, and data evidence", () => {
  assert.deepEqual(evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G7",
  }, evidenceContext).blockers, [
    "QA_EVIDENCE_NOT_CURRENT",
    "SECURITY_EVIDENCE_NOT_CURRENT",
    "DATA_EVIDENCE_NOT_CURRENT",
  ]);
});

test("G8 production execution requires explicit human authorization", () => {
  const report = evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "production_execution",
    command_class: "production_impact",
    evidence: { gate_approvals: [] },
  }, evidenceContext);

  assert(report.blockers.includes("G8_APPROVAL_REQUIRED"));
  assert(report.blockers.includes("HUMAN_AUTHORIZATION_REQUIRED"));
});

test("G8 approval readiness requires human authorization, backup, and rollback", () => {
  assert.deepEqual(evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G8",
    evidence: {
      gate_approvals: [],
      qa: artifactReference("QA"),
      security: artifactReference("SECURITY"),
      data: artifactReference("DATA"),
    },
  }, evidenceContext).blockers, [
    "BACKUP_VERIFICATION_REQUIRED",
    "ROLLBACK_PLAN_REQUIRED",
  ]);
});

test("destructive execution requires explicit confirmation", () => {
  const input = {
    ...policyInput,
    destructive: true,
    evidence: {
      gate_approvals: [gateReference("G6")],
      scope_confirmation: gateReference("G6"),
      backup: artifactReference("BACKUP"),
      dry_run: artifactReference("DRY-RUN"),
      rollback: artifactReference("ROLLBACK"),
    },
  };
  const report = evaluateExecutionPolicy(input, contextAuthorizedFor(input));

  assert.deepEqual(report.blockers, ["DESTRUCTIVE_CONFIRMATION_REQUIRED"]);
});

test("destructive execution requires verified backup", () => {
  const input = {
    ...policyInput,
    destructive: true,
    evidence: {
      gate_approvals: [gateReference("G6")],
      destructive_confirmation: gateReference("G6"),
      scope_confirmation: gateReference("G6"),
      dry_run: artifactReference("DRY-RUN"),
      rollback: artifactReference("ROLLBACK"),
    },
  };
  const report = evaluateExecutionPolicy(input, contextAuthorizedFor(input));

  assert.deepEqual(report.blockers, ["BACKUP_VERIFICATION_REQUIRED"]);
});

test("production execution requires a current rollback plan", () => {
  const input = {
    ...policyInput,
    permission_profile: "production_execution",
    command_class: "production_impact",
    evidence: {
      gate_approvals: [gateReference("G8")],
      qa: artifactReference("QA"),
      security: artifactReference("SECURITY"),
      data: artifactReference("DATA"),
      backup: artifactReference("BACKUP"),
    },
  };
  const report = evaluateExecutionPolicy(input, contextAuthorizedFor(input));

  assert.deepEqual(report.blockers, ["ROLLBACK_PLAN_REQUIRED"]);
});

test("G7 approval rejects policy claims without a structured execution result", () => {
  const g7Workflow = {
    ...workflow,
    phases: [{ id: "release", owner: "developer", reviewer: "code-reviewer", gate: "G7", depends_on: [] }],
  };
  const awaiting = {
    ...state,
    phases: { release: { status: "awaiting_approval" } },
  };

  assert.throws(() => approveGate(awaiting, g7Workflow, {
    id: "APR-G7",
    gate: "G7",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { RELEASE: 1 },
    timestamp: "2026-07-13T00:00:00Z",
  }, {
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    evidence: { gate_approvals: [] },
  }, evidenceContext), /EXECUTION_RESULT_INVALID/);
});

test("self-asserted evidence is rejected when its artifact version is not current", () => {
  const stale = { ...artifactReference("QA"), version: 2 };
  const report = evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G7",
    evidence: { gate_approvals: [], qa: stale, security: stale, data: stale },
  }, evidenceContext);

  assert.deepEqual(report.blockers, [
    "QA_EVIDENCE_NOT_CURRENT",
    "SECURITY_EVIDENCE_NOT_CURRENT",
    "DATA_EVIDENCE_NOT_CURRENT",
  ]);
});

test("artifact evidence requires a human approval at the artifact gate", () => {
  const context = {
    ...evidenceContext,
    approvals: evidenceContext.approvals.map((approval) => approval.id === "APR-G7"
      ? { ...approval, gate: "G6", approved_by: { type: "agent", identifier: "reviewer" } }
      : approval),
  };
  const report = evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G7",
    evidence: {
      gate_approvals: [],
      qa: artifactReference("QA"),
      security: artifactReference("SECURITY"),
      data: artifactReference("DATA"),
    },
  }, context);

  assert.deepEqual(report.blockers, [
    "QA_EVIDENCE_NOT_CURRENT",
    "SECURITY_EVIDENCE_NOT_CURRENT",
    "DATA_EVIDENCE_NOT_CURRENT",
  ]);
});

test("gate readiness rejects unconfigured gates", () => {
  assert.deepEqual(gateReadiness(state, workflow, "G8"), {
    gate: "G8",
    ready: false,
    blockers: ["GATE_NOT_CONFIGURED"],
  });
});

test("G7 approval rejects a failed execution checkpoint", () => {
  const g8Workflow = {
    ...workflow,
    phases: [{ id: "deployment", owner: "devops-lead", reviewer: "operations-reviewer", gate: "G7", depends_on: [] }],
  };
  const awaiting = { ...state, phases: { deployment: { status: "awaiting_approval" } } };
  const execution = {
    execution_id: "EXEC-G8",
    dispatch_digest: "a".repeat(64),
    status: "completed",
    permission_profile: "test_execution",
    authorized_paths: { read: [".agent-team/**"], write: [], execute: [] },
    command_class: "local_validation",
    destructive: false,
    checkpoints: [{
      id: "release-check",
      status: "failed",
      timestamp: "2026-07-13T00:00:00.000Z",
      evidence: [`sha256:${"a".repeat(64)}`],
    }],
    evidence: {
      gate_approvals: [],
      qa: artifactReference("QA"),
      security: artifactReference("SECURITY"),
      data: artifactReference("DATA"),
      backup: artifactReference("BACKUP"),
      rollback: artifactReference("ROLLBACK"),
    },
  };

  assert.throws(() => approveGate(awaiting, g8Workflow, {
    id: "APR-G8-CURRENT",
    gate: "G7",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { DEPLOYMENT: 1 },
    timestamp: "2026-07-13T00:00:00Z",
  }, execution, evidenceContext), /CHECKPOINT_NOT_COMPLETED/);
});

test("one project charter cannot satisfy execution evidence roles", () => {
  const charter = {
    ...evidenceArtifacts[0],
    id: "PROJECT-CHARTER",
    path: "context/project-charter.md",
    owner: "lead-orchestrator",
    reviewer: "documentation-reviewer",
    required_gate: "G0",
  };
  const context = {
    artifacts: [charter],
    workflow: {
      id: "charter-only",
      version: "1.0.0",
      mode: "greenfield",
      phases: [{
        id: "intake",
        owner: charter.owner,
        reviewer: charter.reviewer,
        gate: "G0",
        depends_on: [],
        required_plugins: [],
        artifact: { id: charter.id, path: charter.path, title: "Project Charter" },
      }],
    },
    verified_checksums: { "PROJECT-CHARTER": charter.checksum },
    reviews: [{ ...evidenceContext.reviews[0], artifact_versions: { "PROJECT-CHARTER": 1 } }],
    approvals: [{
      ...evidenceContext.approvals[0],
      gate: "G0",
      artifact_versions: { "PROJECT-CHARTER": 1 },
    }],
  };
  const reference = {
    artifact_id: "PROJECT-CHARTER",
    version: 1,
    status: "approved",
    review_id: context.reviews[0].id,
    approval_id: context.approvals[0].id,
  };
  const report = evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G8",
    evidence: {
      gate_approvals: [],
      qa: reference,
      security: reference,
      data: reference,
      backup: reference,
      rollback: reference,
    },
  }, context, { type: "human", identifier: "owner" });

  for (const blocker of ["BACKUP_VERIFICATION_REQUIRED", "ROLLBACK_PLAN_REQUIRED"]) {
    assert(report.blockers.includes(blocker));
  }
});

test("checksum drift invalidates otherwise current evidence", () => {
  const report = evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G7",
    evidence: {
      gate_approvals: [],
      qa: artifactReference("QA"),
      security: artifactReference("SECURITY"),
      data: artifactReference("DATA"),
    },
  }, {
    ...evidenceContext,
    verified_checksums: { ...evidenceContext.verified_checksums, QA: `sha256:${"c".repeat(64)}` },
  });

  assert(report.blockers.includes("QA_EVIDENCE_NOT_CURRENT"));
});

test("execution approval must bind digest, paths, action, and execution id", () => {
  const input = {
    ...policyInput,
    permission_profile: "production_execution",
    command_class: "production_impact",
    evidence: {
      gate_approvals: [gateReference("G8")],
      qa: artifactReference("QA"),
      security: artifactReference("SECURITY"),
      data: artifactReference("DATA"),
      backup: artifactReference("BACKUP"),
      rollback: artifactReference("ROLLBACK"),
    },
  };
  const authorization = {
    execution_id: input.execution_id,
    dispatch_digest: input.dispatch_digest,
    permission_profile: input.permission_profile,
    authorized_paths: input.authorized_paths,
    command_class: input.command_class,
    destructive: input.destructive,
  };
  const mismatches = [
    { execution_id: "OTHER" },
    { dispatch_digest: "c".repeat(64) },
    { authorized_paths: { ...policyInput.authorized_paths, write: ["other/**"] } },
    { command_class: "safe_read" },
  ];
  for (const mismatch of mismatches) {
    const context = {
      ...evidenceContext,
      approvals: evidenceContext.approvals.map((approval) => approval.id === "APR-G8"
        ? { ...approval, execution_authorization: { ...authorization, ...mismatch } }
        : approval),
    };
    assert(evaluateExecutionPolicy(input, context).blockers.includes("G8_APPROVAL_REQUIRED"));
  }
});

test("unrelated approval cannot authorize destructive confirmation or scope", () => {
  const report = evaluateExecutionPolicy({
    ...policyInput,
    destructive: true,
    evidence: {
      gate_approvals: [gateReference("G6")],
      destructive_confirmation: gateReference("G6"),
      scope_confirmation: gateReference("G6"),
      backup: artifactReference("BACKUP"),
      dry_run: artifactReference("DRY-RUN"),
      rollback: artifactReference("ROLLBACK"),
    },
  }, evidenceContext);

  assert(report.blockers.includes("DESTRUCTIVE_CONFIRMATION_REQUIRED"));
  assert(report.blockers.includes("SCOPE_CONFIRMATION_REQUIRED"));
});

test("all shipped workflows have satisfiable legitimate evidence roles", async () => {
  for (const file of ["greenfield.yaml", "existing-system.yaml", "migration.yaml"]) {
    const definition = parse(await readFile(new URL(`../workflows/${file}`, import.meta.url), "utf8"));
    const qa = definition.phases.find(({ owner }) => owner === "qa-lead");
    const security = definition.phases.find(({ owner }) => owner === "security-reviewer");
    const data = definition.phases.find(({ artifact, owner, reviewer }) => artifact.path.startsWith("data/")
      && (owner === "data-reviewer" || reviewer === "data-reviewer"));
    const release = definition.phases.find(({ gate, owner, artifact }) => gate === "G8"
      && owner === "devops-lead" && artifact.path.startsWith("release/"));
    const phases = [...new Set([qa, security, data, release].filter(Boolean))];
    const artifacts = phases.map((phase) => ({
      id: phase.artifact.id,
      path: phase.artifact.path,
      type: "document",
      version: 1,
      status: "approved",
      owner: phase.owner,
      reviewer: phase.reviewer,
      dependencies: [],
      consumers: [],
      required_gate: phase.gate,
      checksum: `sha256:${"a".repeat(64)}`,
    }));
    const approvals = phases.map((phase) => ({
      id: `APR-${phase.artifact.id}`,
      gate: phase.gate,
      decision: "approved",
      approved_by: { type: "human", identifier: "owner" },
      artifact_versions: { [phase.artifact.id]: 1 },
      timestamp: "2026-07-13T00:00:00Z",
    }));
    const reference = (phase) => phase ? ({
      artifact_id: phase.artifact.id,
      version: 1,
      status: "approved",
      review_id: `REV-${phase.artifact.id}`,
      approval_id: `APR-${phase.artifact.id}`,
    }) : undefined;
    const report = evaluateExecutionPolicy({
      ...policyInput,
      permission_profile: "test_execution",
      command_class: "local_validation",
      target_gate: "G8",
      evidence: {
        gate_approvals: [],
        qa: reference(qa),
        security: reference(security),
        data: reference(data),
        backup: reference(release),
        rollback: reference(release),
      },
    }, {
      workflow: definition,
      artifacts,
      approvals,
      verified_checksums: Object.fromEntries(artifacts.map(({ id, checksum }) => [id, checksum])),
      reviews: phases.map((phase) => ({
        id: `REV-${phase.artifact.id}`,
        phase: phase.id,
        reviewer: phase.reviewer,
        verdict: "approved",
        artifact_versions: { [phase.artifact.id]: 1 },
        timestamp: "2026-07-13T00:00:00Z",
      })),
    }, { type: "human", identifier: "owner" });

    assert.deepEqual(report.blockers, [], file);
  }
});
