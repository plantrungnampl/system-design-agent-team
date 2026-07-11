import type {
  ApprovalRecord,
  GateId,
  PhaseStatus,
  WorkflowDefinition,
  WorkflowState,
} from "@system-design-team/core";

export interface TransitionRequest {
  phase: string;
  to: PhaseStatus;
  operation_id: string;
}

export interface GateReadiness {
  gate: GateId;
  ready: boolean;
  blockers: string[];
}

const transitions: Record<PhaseStatus, readonly PhaseStatus[]> = {
  not_started: ["ready"],
  ready: ["in_progress"],
  in_progress: ["artifact_validation", "blocked", "failed", "cancelled"],
  artifact_validation: ["under_review", "revision_required", "blocked"],
  under_review: ["revision_required", "awaiting_approval", "blocked"],
  revision_required: ["in_progress", "blocked", "cancelled"],
  awaiting_approval: ["approved", "revision_required", "blocked"],
  approved: ["handed_over", "superseded"],
  handed_over: ["superseded"],
  blocked: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  cancelled: [],
  superseded: [],
};

const approvedStatuses: readonly PhaseStatus[] = ["approved", "handed_over"];

export function transitionPhase(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  request: TransitionRequest,
): WorkflowState {
  if (state.completed_operations.includes(request.operation_id)) return state;

  const current = state.phases[request.phase];
  const definition = workflow.phases.find((phase) => phase.id === request.phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  if (!current || !transitions[current.status].includes(request.to)) {
    throw new Error("INVALID_TRANSITION");
  }
  if (request.to === "approved" && !current.approval_id) {
    throw new Error("APPROVAL_REQUIRED");
  }
  if (request.to === "ready") {
    const blockers = definition.depends_on.filter(
      (dependency) => !approvedStatuses.includes(state.phases[dependency]?.status ?? "not_started"),
    );
    if (blockers.length > 0) {
      throw new Error(`DEPENDENCIES_NOT_APPROVED:${blockers.sort().join(",")}`);
    }
  }

  return {
    ...state,
    state_version: state.state_version + 1,
    current_phase: request.phase,
    completed_operations: [...state.completed_operations, request.operation_id],
    phases: {
      ...state.phases,
      [request.phase]: { ...current, status: request.to },
    },
  };
}

export function approveGate(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  approval: ApprovalRecord,
): WorkflowState {
  if (state.completed_operations.includes(approval.id)) return state;

  const configured = workflow.phases.filter((phase) => phase.gate === approval.gate);
  const definition = configured.find(
    (phase) => state.phases[phase.id]?.status === "awaiting_approval",
  );
  if (!definition) {
    throw new Error(configured.length === 0 ? "GATE_NOT_CONFIGURED" : "INVALID_APPROVAL_STATE");
  }

  const current = state.phases[definition.id];
  if (!current) throw new Error("INVALID_APPROVAL_STATE");
  if (approval.gate === "G2" && approval.approved_by.type !== "human") {
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }
  if (approval.decision !== "approved" && approval.decision !== "approved_with_conditions") {
    throw new Error("APPROVAL_NOT_GRANTED");
  }

  return transitionPhase({
    ...state,
    phases: {
      ...state.phases,
      [definition.id]: { ...current, approval_id: approval.id },
    },
  }, workflow, {
    phase: definition.id,
    to: "approved",
    operation_id: approval.id,
  });
}

export function gateReadiness(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  gate: GateId,
): GateReadiness {
  const blockers = workflow.phases
    .filter((phase) => phase.gate === gate)
    .filter((phase) => !approvedStatuses.includes(state.phases[phase.id]?.status ?? "not_started"))
    .map((phase) => `PHASE_NOT_APPROVED:${phase.id}`)
    .sort();

  return { gate, ready: blockers.length === 0, blockers };
}
