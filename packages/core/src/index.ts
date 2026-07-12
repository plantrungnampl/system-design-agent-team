import { z } from "zod";

export const FRAMEWORK_VERSION = "0.1.0";

export const GateIdSchema = z.enum(["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]);

export const PhaseStatusSchema = z.enum([
  "not_started",
  "ready",
  "in_progress",
  "artifact_validation",
  "under_review",
  "revision_required",
  "awaiting_approval",
  "approved",
  "handed_over",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
]);

export const ProjectModeSchema = z.enum(["greenfield", "existing_system", "migration"]);
export const ProjectProfileSchema = z.enum(["small", "standard", "enterprise", "regulated", "custom"]);

const VersionedReferenceSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});

export const ProjectConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    mode: ProjectModeSchema,
    profile: ProjectProfileSchema,
  }),
  framework: z.object({ version: z.string().min(1) }),
  workflow: VersionedReferenceSchema,
});

export const FrameworkLockSchema = z.object({
  framework: z.object({ version: z.string().min(1) }),
  workflow: VersionedReferenceSchema,
});

export const WorkflowPhaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Phase id must be kebab-case"),
  owner: z.string().min(1),
  reviewer: z.string().min(1),
  gate: GateIdSchema,
  depends_on: z.array(z.string()).default([]),
  required_plugins: z.array(z.string()).default([]),
  artifact: z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9-]+$/),
    path: z.string().min(1).refine((path) =>
      !path.startsWith("/")
      && !path.includes("\\")
      && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Artifact path must be a contained POSIX-style relative path"),
    title: z.string().min(1),
  }),
}).superRefine((phase, context) => {
  if (phase.owner === phase.reviewer) {
    context.addIssue({
      code: "custom",
      message: "Reviewer must be independent from owner",
      path: ["reviewer"],
    });
  }
});

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  mode: ProjectModeSchema,
  phases: z.array(WorkflowPhaseSchema).min(1),
}).superRefine((workflow, context) => {
  const phaseIds = new Set<string>();
  const artifactIds = new Set<string>();
  const artifactPaths = new Set<string>();
  workflow.phases.forEach((phase, index) => {
    if (phaseIds.has(phase.id)) {
      context.addIssue({ code: "custom", message: "Phase ids must be unique", path: ["phases", index, "id"] });
    }
    phaseIds.add(phase.id);
    if (artifactIds.has(phase.artifact.id) || artifactPaths.has(phase.artifact.path)) {
      context.addIssue({
        code: "custom",
        message: "Phase artifacts must have unique ids and paths",
        path: ["phases", index, "artifact"],
      });
    }
    artifactIds.add(phase.artifact.id);
    artifactPaths.add(phase.artifact.path);
  });
  workflow.phases.forEach((phase, phaseIndex) => {
    phase.depends_on.forEach((dependency, dependencyIndex) => {
      if (dependency === phase.id || !phaseIds.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: "Phase dependency must reference another configured phase",
          path: ["phases", phaseIndex, "depends_on", dependencyIndex],
        });
      } else if (workflow.phases.findIndex((candidate) => candidate.id === dependency) >= phaseIndex) {
        context.addIssue({
          code: "custom",
          message: "Phase dependency must reference an earlier configured phase",
          path: ["phases", phaseIndex, "depends_on", dependencyIndex],
        });
      }
    });
  });
});

export const WorkflowPhaseStateSchema = z.object({
  status: PhaseStatusSchema,
  review_id: z.string().min(1).optional(),
  approval_id: z.string().min(1).optional(),
  handover_id: z.string().min(1).optional(),
  handover_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const WorkflowStateSchema = z.object({
  schema_version: z.number().int().positive(),
  state_version: z.number().int().nonnegative(),
  project_id: z.string().min(1),
  current_phase: z.string().min(1),
  phases: z.record(z.string().min(1), WorkflowPhaseStateSchema),
  completed_operations: z.array(z.string()).default([]),
});

export const PluginFallbackPolicySchema = z.enum([
  "block",
  "request_user_action",
  "allow_with_approval",
  "optional",
]);

export const RequiredPluginSchema = z.object({
  uri: z.string().min(1),
  required_skills: z.array(z.string()).default([]),
  fallback_policy: PluginFallbackPolicySchema,
});

export const AgentManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Agent id must be kebab-case"),
  version: z.string().min(1),
  display_name: z.string().min(1).default("Agent"),
  category: z.string().min(1).default("general"),
  mission: z.string().min(20).default("Execute the assigned role within its approved scope."),
  authority: z.object({
    may: z.array(z.string().min(1)).min(1),
    may_not: z.array(z.string().min(1)).min(1),
  }).default({ may: ["execute assigned work"], may_not: ["approve own work"] }),
  outputs: z.array(z.string().min(1)).min(1).default(["execution result"]),
  reviewer: z.string().min(1),
  required_plugins: z.array(RequiredPluginSchema).default([]),
}).superRefine((agent, context) => {
  if (agent.id === agent.reviewer) {
    context.addIssue({
      code: "custom",
      message: "Reviewer must be independent from agent",
      path: ["reviewer"],
    });
  }
});

export const PluginStatusSchema = z.enum([
  "available",
  "unavailable",
  "disabled_by_policy",
  "installed_but_incompatible",
  "skill_missing",
  "verification_failed",
  "unknown",
]);

export const PluginStatusRecordSchema = z.object({
  uri: z.string().min(1),
  status: PluginStatusSchema,
  skills: z.array(z.string()).default([]),
});

export const PluginStatusListSchema = z.object({
  plugins: z.array(PluginStatusRecordSchema),
});

export const ApprovalDecisionSchema = z.enum([
  "approved",
  "approved_with_conditions",
  "rejected",
  "revoked",
  "expired",
]);

export const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  gate: GateIdSchema,
  decision: ApprovalDecisionSchema,
  approved_by: z.object({
    type: z.enum(["human", "agent"]),
    identifier: z.string().min(1),
  }),
  artifact_versions: z.record(z.string().min(1), z.number().int().positive()),
  timestamp: z.string().min(1),
});

export const ApprovalListSchema = z.object({
  approvals: z.array(ApprovalRecordSchema),
});

export const ArtifactStatusSchema = z.enum([
  "draft",
  "in_review",
  "revision_required",
  "approved",
  "approved_with_conditions",
  "stale",
  "superseded",
  "archived",
  "rejected",
]);

export const ArtifactRecordSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  owner: z.string().min(1),
  reviewer: z.string().min(1),
  required_gate: GateIdSchema,
});

export const ArtifactRegistrySchema = z.object({
  artifacts: z.array(ArtifactRecordSchema),
});

export const ReviewVerdictSchema = z.enum(["approved", "revision_required"]);

export const ReviewRecordSchema = z.object({
  id: z.string().min(1),
  phase: z.string().min(1),
  reviewer: z.string().min(1),
  verdict: ReviewVerdictSchema,
  artifact_versions: z.record(z.string().min(1), z.number().int().positive()),
  timestamp: z.string().min(1),
});

export const ReviewListSchema = z.object({
  reviews: z.array(ReviewRecordSchema),
});

export const HandoverRecordSchema = z.object({
  id: z.string().min(1),
  phase: z.string().min(1),
  from_agent: z.string().min(1),
  to_agent: z.string().min(1),
  approved_inputs: z.array(z.string()),
  expected_outputs: z.array(z.string()),
  acceptance_conditions: z.array(z.string()),
});

export type ProjectMode = z.infer<typeof ProjectModeSchema>;
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type FrameworkLock = z.infer<typeof FrameworkLockSchema>;
export type GateId = z.infer<typeof GateIdSchema>;
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type PluginStatusRecord = z.infer<typeof PluginStatusRecordSchema>;
export type PluginStatusList = z.infer<typeof PluginStatusListSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalList = z.infer<typeof ApprovalListSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArtifactRegistry = z.infer<typeof ArtifactRegistrySchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type ReviewList = z.infer<typeof ReviewListSchema>;
export type HandoverRecord = z.infer<typeof HandoverRecordSchema>;
