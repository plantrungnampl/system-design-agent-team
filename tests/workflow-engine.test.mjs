import assert from "node:assert/strict";
import test from "node:test";
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

const policyInput = {
  permission_profile: "code_write",
  authorized_paths: { read: ["src/**"], write: ["src/**"], execute: ["npm test"] },
  command_class: "mutating_local",
  destructive: false,
  evidence: {
    gate_approvals: [],
    qa: "missing",
    security: "missing",
    data: "missing",
    human_authorization: false,
    destructive_confirmation: false,
    scope_confirmation: false,
    backup: "missing",
    dry_run: "missing",
    rollback: "missing",
  },
};

test("G6 blocks code-write execution until approved", () => {
  assert.deepEqual(evaluateExecutionPolicy(policyInput).blockers, ["G6_APPROVAL_REQUIRED"]);
});

test("G7 requires current QA, security, and data evidence", () => {
  assert.deepEqual(evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "test_execution",
    command_class: "local_validation",
    target_gate: "G7",
  }).blockers, [
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
    evidence: {
      ...policyInput.evidence,
      qa: "current",
      security: "current",
      data: "current",
      backup: "passed",
      rollback: "current",
    },
  });

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
      ...policyInput.evidence,
      qa: "current",
      security: "current",
      data: "current",
    },
  }).blockers, [
    "HUMAN_AUTHORIZATION_REQUIRED",
    "BACKUP_VERIFICATION_REQUIRED",
    "ROLLBACK_PLAN_REQUIRED",
  ]);
});

test("destructive execution requires explicit confirmation", () => {
  const report = evaluateExecutionPolicy({
    ...policyInput,
    destructive: true,
    evidence: {
      ...policyInput.evidence,
      gate_approvals: ["G6"],
      human_authorization: true,
      scope_confirmation: true,
      backup: "passed",
      dry_run: "passed",
      rollback: "current",
    },
  });

  assert.deepEqual(report.blockers, ["DESTRUCTIVE_CONFIRMATION_REQUIRED"]);
});

test("destructive execution requires verified backup", () => {
  const report = evaluateExecutionPolicy({
    ...policyInput,
    destructive: true,
    evidence: {
      ...policyInput.evidence,
      gate_approvals: ["G6"],
      human_authorization: true,
      destructive_confirmation: true,
      scope_confirmation: true,
      dry_run: "passed",
      rollback: "current",
    },
  });

  assert.deepEqual(report.blockers, ["BACKUP_VERIFICATION_REQUIRED"]);
});

test("production execution requires a current rollback plan", () => {
  const report = evaluateExecutionPolicy({
    ...policyInput,
    permission_profile: "production_execution",
    command_class: "production_impact",
    evidence: {
      ...policyInput.evidence,
      gate_approvals: ["G8"],
      qa: "current",
      security: "current",
      data: "current",
      human_authorization: true,
      backup: "passed",
    },
  });

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
    evidence: {
      ...policyInput.evidence,
      qa: "current",
      security: "current",
      data: "current",
    },
  }), /EXECUTION_RESULT_INVALID/);
});
