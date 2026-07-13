import type {
  AgentExecutionResult,
  ApprovalRecord,
  ExecutionPolicyInput,
  GateId,
  PhaseStatus,
  WorkflowDefinition,
  WorkflowState,
} from "@system-design-team/core";
import { AgentExecutionResultSchema, ExecutionPolicyInputSchema } from "@system-design-team/core";

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

export interface ExecutionPolicyReport {
  allowed: boolean;
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

function applyTransition(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  request: TransitionRequest,
  allowApproval = false,
): WorkflowState {
  if (state.completed_operations.includes(request.operation_id)) return state;

  const current = state.phases[request.phase];
  const definition = workflow.phases.find((phase) => phase.id === request.phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  if (!current || !transitions[current.status].includes(request.to)) {
    throw new Error("INVALID_TRANSITION");
  }
  if (request.to === "approved" && (!allowApproval || !current.approval_id)) {
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

export function transitionPhase(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  request: TransitionRequest,
): WorkflowState {
  return applyTransition(state, workflow, request);
}

export function approveGate(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  approval: ApprovalRecord,
  execution?: AgentExecutionResult,
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
  if (approval.approved_by.identifier === definition.owner) {
    throw new Error("SELF_APPROVAL_FORBIDDEN");
  }
  if (approval.gate === "G7" || approval.gate === "G8") {
    if (!execution) throw new Error("EXECUTION_EVIDENCE_REQUIRED");
    const parsed = AgentExecutionResultSchema.safeParse(execution);
    if (!parsed.success) throw new Error("EXECUTION_RESULT_INVALID");
    if (parsed.data.status !== "completed") throw new Error("EXECUTION_NOT_COMPLETED");
    const report = evaluateExecutionPolicy({
      permission_profile: parsed.data.permission_profile,
      authorized_paths: parsed.data.authorized_paths,
      command_class: parsed.data.command_class,
      destructive: parsed.data.destructive ?? false,
      evidence: parsed.data.evidence,
      target_gate: approval.gate,
    });
    if (!report.allowed) throw new Error(report.blockers[0]);
  }
  if (approval.decision !== "approved" && approval.decision !== "approved_with_conditions") {
    throw new Error("APPROVAL_NOT_GRANTED");
  }

  return applyTransition({
    ...state,
    phases: {
      ...state.phases,
      [definition.id]: { ...current, approval_id: approval.id },
    },
  }, workflow, {
    phase: definition.id,
    to: "approved",
    operation_id: approval.id,
  }, true);
}

export function rejectGate(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  rejection: ApprovalRecord,
): WorkflowState {
  if (state.completed_operations.includes(rejection.id)) return state;
  const definition = workflow.phases.find((phase) =>
    phase.gate === rejection.gate && state.phases[phase.id]?.status === "awaiting_approval");
  if (!definition) throw new Error("INVALID_APPROVAL_STATE");
  if (rejection.approved_by.type !== "human") throw new Error("HUMAN_APPROVAL_REQUIRED");
  if (rejection.approved_by.identifier === definition.owner) throw new Error("SELF_APPROVAL_FORBIDDEN");
  if (rejection.decision !== "rejected") throw new Error("REJECTION_REQUIRED");
  return applyTransition(state, workflow, {
    phase: definition.id,
    to: "revision_required",
    operation_id: rejection.id,
  });
}

export function evaluateExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicyReport {
  const policy = ExecutionPolicyInputSchema.parse(input);
  const blockers: string[] = [];
  const add = (condition: boolean, blocker: string) => {
    if (condition && !blockers.includes(blocker)) blockers.push(blocker);
  };
  const production = policy.permission_profile === "production_execution"
    || policy.command_class === "production_impact";

  add(policy.permission_profile === "code_write"
    && !policy.evidence.gate_approvals.includes("G6"), "G6_APPROVAL_REQUIRED");
  if (policy.target_gate === "G7" || policy.target_gate === "G8" || production) {
    add(policy.evidence.qa !== "current", "QA_EVIDENCE_NOT_CURRENT");
    add(policy.evidence.security !== "current", "SECURITY_EVIDENCE_NOT_CURRENT");
    add(policy.evidence.data !== "current", "DATA_EVIDENCE_NOT_CURRENT");
  }
  if (production) {
    add(!policy.evidence.gate_approvals.includes("G8"), "G8_APPROVAL_REQUIRED");
  }
  if (policy.target_gate === "G8" || production) {
    add(!policy.evidence.human_authorization, "HUMAN_AUTHORIZATION_REQUIRED");
    add(policy.evidence.backup !== "passed", "BACKUP_VERIFICATION_REQUIRED");
    add(policy.evidence.rollback !== "current", "ROLLBACK_PLAN_REQUIRED");
  }
  if (policy.destructive) {
    add(!policy.evidence.human_authorization, "HUMAN_AUTHORIZATION_REQUIRED");
    add(!policy.evidence.destructive_confirmation, "DESTRUCTIVE_CONFIRMATION_REQUIRED");
    add(!policy.evidence.scope_confirmation, "SCOPE_CONFIRMATION_REQUIRED");
    add(policy.evidence.backup !== "passed", "BACKUP_VERIFICATION_REQUIRED");
    add(policy.evidence.dry_run !== "passed", "DRY_RUN_REQUIRED");
    add(policy.evidence.rollback !== "current", "ROLLBACK_PLAN_REQUIRED");
  }
  return { allowed: blockers.length === 0, blockers };
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
