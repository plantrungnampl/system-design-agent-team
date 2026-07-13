import type {
  AgentExecutionResult,
  ApprovalRecord,
  ArtifactEvidenceReference,
  ExecutionEvidenceContext,
  ExecutionPolicyInput,
  PreparedExecutionRequest,
  GateApprovalReference,
  GateId,
  PhaseStatus,
  WorkflowDefinition,
  WorkflowState,
} from "@system-design-team/core";
import {
  AgentExecutionResultSchema,
  ExecutionEvidenceContextSchema,
  ExecutionPolicyInputSchema,
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

export interface ExecutionPolicyReport {
  allowed: boolean;
  blockers: string[];
}

type AuthorizationActor = ApprovalRecord["approved_by"];

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

function phaseDependsOn(
  workflow: WorkflowDefinition,
  phaseId: string,
  dependencyId: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(phaseId)) return false;
  visited.add(phaseId);
  const phase = workflow.phases.find(({ id }) => id === phaseId);
  return phase?.depends_on.some((candidate) => candidate === dependencyId
    || phaseDependsOn(workflow, candidate, dependencyId, visited)) ?? false;
}

function isFinalGatePhase(workflow: WorkflowDefinition, definition: WorkflowDefinition["phases"][number]): boolean {
  return !workflow.phases.some((candidate) => candidate.gate === definition.gate
    && candidate.id !== definition.id
    && phaseDependsOn(workflow, candidate.id, definition.id));
}

function bindPendingArtifactEvidence(
  evidence: ExecutionPolicyInput["evidence"],
  definition: WorkflowDefinition["phases"][number],
  current: WorkflowState["phases"][string],
  approval: ApprovalRecord,
): ExecutionPolicyInput["evidence"] {
  const bind = (reference: ArtifactEvidenceReference | undefined) => reference
    && reference.artifact_id === definition.artifact?.id
    ? {
        ...reference,
        ...(current.review_id ? { review_id: current.review_id } : {}),
        approval_id: approval.id,
      }
    : reference;
  return {
    ...evidence,
    qa: bind(evidence.qa),
    security: bind(evidence.security),
    data: bind(evidence.data),
    backup: bind(evidence.backup),
    dry_run: bind(evidence.dry_run),
    rollback: bind(evidence.rollback),
  };
}

export function approveGate(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  approval: ApprovalRecord,
  execution?: AgentExecutionResult,
  evidenceContext?: ExecutionEvidenceContext,
  executionRequest?: PreparedExecutionRequest,
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
  const enforceReleasePolicy = (approval.gate === "G7" || approval.gate === "G8")
    && isFinalGatePhase(workflow, definition);
  const pendingContext = evidenceContext ? {
    ...evidenceContext,
    approvals: [...evidenceContext.approvals.filter(({ id }) => id !== approval.id), approval],
  } : undefined;
  if (approval.gate === "G7" && enforceReleasePolicy) {
    if (!execution) throw new Error("EXECUTION_EVIDENCE_REQUIRED");
    if (!pendingContext) throw new Error("EXECUTION_EVIDENCE_CONTEXT_REQUIRED");
    const report = evaluateExecutionResult({
      ...execution,
      evidence: bindPendingArtifactEvidence(execution.evidence, definition, current, approval),
    }, approval.gate, pendingContext, approval.approved_by);
    if (!report.allowed) throw new Error(report.blockers[0]);
  }
  if (approval.gate === "G8" && enforceReleasePolicy) {
    if (!executionRequest) throw new Error("EXECUTION_REQUEST_REQUIRED");
    if (!pendingContext) throw new Error("EXECUTION_EVIDENCE_CONTEXT_REQUIRED");
    const report = evaluateExecutionPolicy({
      ...executionRequest.authorization,
      evidence: bindPendingArtifactEvidence(executionRequest.evidence, definition, current, approval),
      target_gate: "G8",
    }, pendingContext, approval.approved_by);
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

function approvedGate(
  reference: GateApprovalReference | undefined,
  context: ExecutionEvidenceContext,
  policy: ExecutionPolicyInput,
  expectedGate?: GateId,
): boolean {
  const gate = reference?.gate ?? expectedGate;
  if (!gate) return false;
  const exact = policy.permission_profile === "production_execution"
    || policy.command_class === "production_impact" || policy.destructive;
  return context.approvals.some((approval) => (!reference || approval.id === reference.approval_id)
    && approval.gate === gate
    && (approval.decision === "approved" || approval.decision === "approved_with_conditions")
    && approval.approved_by.type === "human"
    && (!exact || (approval.execution_authorization?.execution_id === policy.execution_id
      && approval.execution_authorization.dispatch_digest === policy.dispatch_digest
      && approval.execution_authorization.permission_profile === policy.permission_profile
      && approval.execution_authorization.command_class === policy.command_class
      && approval.execution_authorization.destructive === policy.destructive
      && JSON.stringify(approval.execution_authorization.authorized_paths)
        === JSON.stringify(policy.authorized_paths))));
}

type EvidenceRole = "qa" | "security" | "data" | "backup" | "dry_run" | "rollback";

function phaseMatchesRole(role: EvidenceRole, phase: WorkflowDefinition["phases"][number]): boolean {
  const purpose = `${phase.id} ${phase.artifact.path} ${phase.artifact.title}`.toLowerCase();
  switch (role) {
    case "qa": return phase.owner === "qa-lead"
      && phase.artifact.path.startsWith("testing/")
      && /test|qa|verification|validation|regression/.test(purpose);
    case "security": return phase.owner === "security-reviewer"
      && (phase.artifact.path.startsWith("security/") || phase.artifact.path.startsWith("release/"))
      && /security|release-readiness|release readiness/.test(purpose);
    case "data": return (phase.owner === "data-reviewer"
      || (phase.artifact.path.startsWith("data/") && phase.reviewer === "data-reviewer"))
      && /data|mapping|transition|migration|reconciliation/.test(purpose);
    case "backup": return phase.owner === "devops-lead" && phase.artifact.path.startsWith("release/")
      && /release|deployment|cutover|backup/.test(purpose);
    case "dry_run": return (phase.owner === "qa-lead" || phase.owner === "devops-lead")
      && /test|validation|dry[- ]?run|rehearsal|parallel/.test(purpose);
    case "rollback": return phase.owner === "devops-lead" && phase.artifact.path.startsWith("release/")
      && /release|deployment|cutover|rollback|backout/.test(purpose);
  }
}

function currentArtifact(
  reference: ArtifactEvidenceReference | undefined,
  role: EvidenceRole,
  context: ExecutionEvidenceContext,
): boolean {
  if (!reference || !referencedArtifact(reference, role, context)) return false;
  const phase = context.workflow.phases.find(({ artifact: configured }) => configured.id === reference.artifact_id);
  const review = context.reviews.find(({ id }) => id === reference.review_id);
  const approval = context.approvals.find((candidate) =>
    (!reference.approval_id || candidate.id === reference.approval_id)
      && candidate.gate === phase?.gate
      && candidate.artifact_versions[reference.artifact_id] === reference.version
      && (candidate.decision === "approved" || candidate.decision === "approved_with_conditions")
      && candidate.approved_by.type === "human");
  return review?.verdict === "approved"
    && review.phase === phase?.id
    && review.reviewer === phase?.reviewer
    && review.artifact_versions[reference.artifact_id] === reference.version
    && (approval?.decision === "approved" || approval?.decision === "approved_with_conditions")
    && approval.approved_by.type === "human"
    && approval.gate === phase?.gate
    && approval.artifact_versions[reference.artifact_id] === reference.version;
}

function referencedArtifact(
  reference: ArtifactEvidenceReference | undefined,
  role: EvidenceRole,
  context: ExecutionEvidenceContext,
): boolean {
  if (!reference) return false;
  const artifact = context.artifacts.find(({ id }) => id === reference.artifact_id);
  const phase = context.workflow.phases.find(({ artifact: configured }) => configured.id === reference.artifact_id);
  return artifact?.version === reference.version
    && artifact.status === reference.status
    && context.verified_checksums[artifact.id] === artifact.checksum
    && phase?.artifact.path === artifact.path
    && phase.owner === artifact.owner
    && phase.reviewer === artifact.reviewer
    && phase.gate === artifact.required_gate
    && phaseMatchesRole(role, phase);
}

function reviewArtifact(
  reference: ArtifactEvidenceReference | undefined,
  role: EvidenceRole,
  context: ExecutionEvidenceContext,
  reviewedPhase: string | undefined,
): boolean {
  if (!reference || !referencedArtifact(reference, role, context)) return false;
  const phase = context.workflow.phases.find(({ artifact }) => artifact.id === reference.artifact_id);
  if (phase?.id === reviewedPhase) return true;
  const review = context.reviews.find(({ id }) => id === reference.review_id);
  const approval = reference.approval_id
    ? context.approvals.find(({ id }) => id === reference.approval_id)
    : undefined;
  return review?.verdict === "approved"
    && review.phase === phase?.id
    && review.reviewer === phase?.reviewer
    && review.artifact_versions[reference.artifact_id] === reference.version
    && (!reference.approval_id || ((approval?.decision === "approved"
      || approval?.decision === "approved_with_conditions")
      && approval.approved_by.type === "human"
      && approval.gate === phase?.gate
      && approval.artifact_versions[reference.artifact_id] === reference.version));
}

export function evaluateReviewExecutionResult(
  execution: AgentExecutionResult,
  contextInput: ExecutionEvidenceContext,
  reviewedPhase?: string,
): ExecutionPolicyReport {
  const parsed = AgentExecutionResultSchema.safeParse(execution);
  if (!parsed.success) return { allowed: false, blockers: ["EXECUTION_RESULT_INVALID"] };
  if (parsed.data.status !== "completed") return { allowed: false, blockers: ["EXECUTION_NOT_COMPLETED"] };
  if (parsed.data.checkpoints.some(({ status }) => status !== "completed")) {
    return { allowed: false, blockers: ["CHECKPOINT_NOT_COMPLETED"] };
  }
  const context = ExecutionEvidenceContextSchema.parse(contextInput);
  const blockers: string[] = [];
  const evidence = parsed.data.evidence;
  const artifactReferences: Array<[ArtifactEvidenceReference | undefined, EvidenceRole, string]> = [
    [evidence.qa, "qa", "QA_EVIDENCE_NOT_CURRENT"],
    [evidence.security, "security", "SECURITY_EVIDENCE_NOT_CURRENT"],
    [evidence.data, "data", "DATA_EVIDENCE_NOT_CURRENT"],
    [evidence.backup, "backup", "BACKUP_VERIFICATION_REQUIRED"],
    [evidence.dry_run, "dry_run", "DRY_RUN_REQUIRED"],
    [evidence.rollback, "rollback", "ROLLBACK_PLAN_REQUIRED"],
  ];
  for (const [reference, role, blocker] of artifactReferences) {
    if (reference && !reviewArtifact(reference, role, context, reviewedPhase)) blockers.push(blocker);
  }
  const gateReferences = [
    ...evidence.gate_approvals,
    evidence.destructive_confirmation,
    evidence.scope_confirmation,
  ].filter((reference) => reference !== undefined);
  for (const reference of gateReferences) {
    if (!context.approvals.some((approval) => approval.id === reference.approval_id
      && approval.gate === reference.gate
      && approval.approved_by.type === "human"
      && (approval.decision === "approved" || approval.decision === "approved_with_conditions"))) {
      blockers.push(`${reference.gate}_APPROVAL_REFERENCE_INVALID`);
    }
  }
  return { allowed: blockers.length === 0, blockers };
}

export function evaluateExecutionPolicy(
  input: ExecutionPolicyInput,
  contextInput: ExecutionEvidenceContext,
  authorizingActor?: AuthorizationActor,
): ExecutionPolicyReport {
  const policy = ExecutionPolicyInputSchema.parse(input);
  const context = ExecutionEvidenceContextSchema.parse(contextInput);
  const blockers: string[] = [];
  const add = (condition: boolean, blocker: string) => {
    if (condition && !blockers.includes(blocker)) blockers.push(blocker);
  };
  const production = policy.permission_profile === "production_execution"
    || policy.command_class === "production_impact";
  const evidenceGate = policy.target_gate ?? ((production || policy.destructive) ? "G8" : undefined);
  const terminalPhases = evidenceGate === "G7" || evidenceGate === "G8"
    ? context.workflow.phases.filter((phase) => phase.gate === evidenceGate
      && isFinalGatePhase(context.workflow, phase))
    : [];
  const relevantPhases = terminalPhases.length === 0
    ? context.workflow.phases
    : context.workflow.phases.filter((phase) => terminalPhases.some((terminal) =>
      phase.id === terminal.id || phaseDependsOn(context.workflow, terminal.id, phase.id)));
  const evidenceContext = {
    ...context,
    workflow: { ...context.workflow, phases: relevantPhases },
  };
  const gate = (id: GateId) => policy.evidence.gate_approvals.find((reference) => reference.gate === id);
  const hasRole = (role: EvidenceRole) => relevantPhases.some((phase) => phaseMatchesRole(role, phase));

  add(policy.permission_profile === "code_write"
    && !approvedGate(gate("G6"), context, policy), "G6_APPROVAL_REQUIRED");
  if (policy.target_gate === "G7" || policy.target_gate === "G8" || production) {
    add(hasRole("qa") && !currentArtifact(policy.evidence.qa, "qa", evidenceContext), "QA_EVIDENCE_NOT_CURRENT");
    add(hasRole("security") && !currentArtifact(policy.evidence.security, "security", evidenceContext), "SECURITY_EVIDENCE_NOT_CURRENT");
    add(hasRole("data") && !currentArtifact(policy.evidence.data, "data", evidenceContext), "DATA_EVIDENCE_NOT_CURRENT");
  }
  if (production) {
    add(!approvedGate(gate("G8"), context, policy, "G8"), "G8_APPROVAL_REQUIRED");
  }
  if (policy.target_gate === "G8" || production) {
    add((production || policy.destructive) && !approvedGate(gate("G8"), context, policy, "G8"),
      "HUMAN_AUTHORIZATION_REQUIRED");
    add(!currentArtifact(policy.evidence.backup, "backup", evidenceContext), "BACKUP_VERIFICATION_REQUIRED");
    add(!currentArtifact(policy.evidence.rollback, "rollback", evidenceContext), "ROLLBACK_PLAN_REQUIRED");
  }
  if (policy.destructive) {
    add(!approvedGate(policy.evidence.destructive_confirmation, context, policy), "DESTRUCTIVE_CONFIRMATION_REQUIRED");
    add(!approvedGate(policy.evidence.scope_confirmation, context, policy), "SCOPE_CONFIRMATION_REQUIRED");
    add(!currentArtifact(policy.evidence.backup, "backup", evidenceContext), "BACKUP_VERIFICATION_REQUIRED");
    add(!currentArtifact(policy.evidence.dry_run, "dry_run", evidenceContext), "DRY_RUN_REQUIRED");
    add(!currentArtifact(policy.evidence.rollback, "rollback", evidenceContext), "ROLLBACK_PLAN_REQUIRED");
  }
  return { allowed: blockers.length === 0, blockers };
}

export function evaluateExecutionResult(
  execution: AgentExecutionResult,
  targetGate: GateId | undefined,
  context: ExecutionEvidenceContext,
  actor?: AuthorizationActor,
): ExecutionPolicyReport {
  const parsed = AgentExecutionResultSchema.safeParse(execution);
  if (!parsed.success) return { allowed: false, blockers: ["EXECUTION_RESULT_INVALID"] };
  if (parsed.data.status !== "completed") return { allowed: false, blockers: ["EXECUTION_NOT_COMPLETED"] };
  if (parsed.data.checkpoints.some(({ status }) => status !== "completed")) {
    return { allowed: false, blockers: ["CHECKPOINT_NOT_COMPLETED"] };
  }
  return evaluateExecutionPolicy({
    execution_id: parsed.data.execution_id,
    dispatch_digest: parsed.data.dispatch_digest,
    permission_profile: parsed.data.permission_profile,
    authorized_paths: parsed.data.authorized_paths,
    command_class: parsed.data.command_class,
    destructive: parsed.data.destructive,
    evidence: parsed.data.evidence,
    target_gate: targetGate,
  }, context, actor);
}

export function gateReadiness(
  state: WorkflowState,
  workflow: WorkflowDefinition,
  gate: GateId,
  execution?: AgentExecutionResult,
  evidenceContext?: ExecutionEvidenceContext,
): GateReadiness {
  const configured = workflow.phases.filter((phase) => phase.gate === gate);
  if (configured.length === 0) return { gate, ready: false, blockers: ["GATE_NOT_CONFIGURED"] };
  const blockers = configured
    .filter((phase) => !approvedStatuses.includes(state.phases[phase.id]?.status ?? "not_started"))
    .map((phase) => `PHASE_NOT_APPROVED:${phase.id}`)
    .sort();
  if (gate === "G7" || gate === "G8") {
    if (!execution || !evidenceContext) blockers.push("EXECUTION_EVIDENCE_REQUIRED");
    else blockers.push(...evaluateExecutionResult(execution, gate, evidenceContext).blockers);
  }

  return { gate, ready: blockers.length === 0, blockers };
}
