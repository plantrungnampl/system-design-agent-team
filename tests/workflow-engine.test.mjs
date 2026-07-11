import assert from "node:assert/strict";
import test from "node:test";
import {
  approveGate,
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
