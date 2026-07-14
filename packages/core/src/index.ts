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
export const AdapterIdSchema = z.enum(["codex"]);
export const ApprovalPolicySchema = z.enum(["human_required"]);
export const PluginEnforcementSchema = z.enum(["strict"]);
export const CacheProviderSchema = z.enum(["none", "sqlite"]);
export const SecurityClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);

export const GlossarySchema = z.object({
  entries: z.array(z.object({
    term: z.string().min(1),
    definition: z.string().min(1),
  })),
}).superRefine((glossary, context) => {
  const terms = new Set<string>();
  glossary.entries.forEach(({ term }, index) => {
    const normalized = term.trim().toLocaleLowerCase("en");
    if (terms.has(normalized)) {
      context.addIssue({ code: "custom", message: "Glossary terms must be unique", path: ["entries", index, "term"] });
    }
    terms.add(normalized);
  });
});

export const ProjectApprovalPolicySchema = z.object({
  business_scope: ApprovalPolicySchema.default("human_required"),
  requirements: ApprovalPolicySchema.default("human_required"),
  product_backlog: ApprovalPolicySchema.default("human_required"),
  ux: ApprovalPolicySchema.default("human_required"),
  architecture: ApprovalPolicySchema.default("human_required"),
  implementation_plan: ApprovalPolicySchema.default("human_required"),
  release_candidate: ApprovalPolicySchema.default("human_required"),
  production_deployment: ApprovalPolicySchema.default("human_required"),
});

export const AdapterConfigSchema = z.object({ primary: AdapterIdSchema.default("codex") });
export const PluginEnforcementConfigSchema = z.object({
  enforcement: PluginEnforcementSchema.default("strict"),
  fallback_requires_human_approval: z.literal(true).default(true),
});
export const CacheConfigSchema = z.object({
  provider: CacheProviderSchema.default("none"),
  path: z.string().min(1).optional(),
}).superRefine((cache, context) => {
  if (cache.provider === "sqlite" && !cache.path) {
    context.addIssue({ code: "custom", message: "SQLite cache requires a path", path: ["path"] });
  }
  if (cache.provider === "sqlite" && cache.path
    && (!cache.path.startsWith(".agent-team/cache/")
      || cache.path.includes("\\")
      || cache.path.slice(".agent-team/cache/".length).split("/")
        .some((segment) => segment === "" || segment === "." || segment === ".."))) {
    context.addIssue({
      code: "custom",
      message: "SQLite cache path must be under .agent-team/cache/",
      path: ["path"],
    });
  }
  if (cache.provider === "none" && cache.path) {
    context.addIssue({ code: "custom", message: "Disabled cache cannot have a path", path: ["path"] });
  }
});
export const SecurityConfigSchema = z.object({
  classification: SecurityClassificationSchema.default("internal"),
  secret_scan: z.literal("required").default("required"),
});

export const EnvironmentOverlaySchema = z.object({
  adapter: AdapterConfigSchema.partial().optional(),
  approvals: ProjectApprovalPolicySchema.partial().optional(),
  plugins: PluginEnforcementConfigSchema.partial().optional(),
  cache: z.object({ provider: CacheProviderSchema, path: z.string().min(1).optional() }).optional(),
  security: SecurityConfigSchema.partial().optional(),
});

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
    language: z.string().min(2).default("en"),
  }),
  framework: z.object({
    version: z.string().min(1),
    management: z.enum(["managed", "ejected"]).default("managed"),
  }),
  adapter: AdapterConfigSchema.default({ primary: "codex" }),
  workflow: VersionedReferenceSchema,
  approvals: ProjectApprovalPolicySchema.default({
    business_scope: "human_required",
    requirements: "human_required",
    product_backlog: "human_required",
    ux: "human_required",
    architecture: "human_required",
    implementation_plan: "human_required",
    release_candidate: "human_required",
    production_deployment: "human_required",
  }),
  plugins: PluginEnforcementConfigSchema.default({
    enforcement: "strict",
    fallback_requires_human_approval: true,
  }),
  cache: CacheConfigSchema.default({ provider: "none" }),
  security: SecurityConfigSchema.default({ classification: "internal", secret_scan: "required" }),
  environments: z.record(z.string().min(1), EnvironmentOverlaySchema).default({}),
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

export const AgentReviewChecklistSchema = z.object({
  agent: z.string().min(1),
  reviewer: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1),
  verdicts: z.array(z.enum(["approved", "revision_required"])).length(2),
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

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const ManagedRelativePathSchema = z.string().min(1).refine((path) =>
  !path.startsWith("/")
  && !path.includes("\\")
  && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
"Managed path must be a contained POSIX-style relative path");

export const LifecycleAuthorizationSchema = z.object({
  actor: z.object({
    type: z.enum(["human", "agent", "system"]),
    identifier: z.string().min(1),
  }),
  authorization_source: z.string().min(1),
});

export const RepositoryInventorySchema = z.object({
  git: z.object({
    root: z.string().min(1),
    dirty: z.boolean(),
    detached: z.boolean(),
    branch: z.string().min(1).nullable(),
    tracked_files: z.number().int().nonnegative(),
  }),
  languages: z.array(z.string().min(1)),
});

export const InstalledFileSchema = z.object({
  path: ManagedRelativePathSchema,
  checksum: Sha256DigestSchema,
  role: z.literal("generated_adapter"),
});

export const InstallationManifestSchema = z.object({
  schema_version: z.literal(1),
  files: z.array(InstalledFileSchema),
  directories_created: z.array(ManagedRelativePathSchema),
});

export const InstallationOperationSchema = z.object({
  schema_version: z.literal(1),
  action: z.enum(["init", "adopt"]),
  operation_id: z.string().min(1),
  authorization: LifecycleAuthorizationSchema,
  project: ProjectConfigSchema,
  inventory: RepositoryInventorySchema.optional(),
});

export const EjectOperationSchema = z.object({
  schema_version: z.literal(1),
  action: z.literal("eject"),
  operation_id: z.string().min(1),
  authorization: LifecycleAuthorizationSchema,
  materialized: z.array(ManagedRelativePathSchema),
});

export const UninstallPlanSchema = z.object({
  schema_version: z.literal(1),
  operation_id: z.string().min(1),
  authorization: LifecycleAuthorizationSchema,
  status: z.enum(["started", "completed"]),
  files: z.array(InstalledFileSchema),
  directories: z.array(ManagedRelativePathSchema),
  removed: z.array(ManagedRelativePathSchema).default([]),
  preserved: z.array(ManagedRelativePathSchema).default([".agent-team"]),
});

export const PermissionProfileSchema = z.enum([
  "read_only_assessment",
  "documentation_write",
  "code_write",
  "test_execution",
  "infrastructure_write",
  "production_execution",
]);

export const CommandClassSchema = z.enum([
  "safe_read",
  "local_validation",
  "mutating_local",
  "external_side_effect",
  "production_impact",
]);

export const AuthorizedPathsSchema = z.object({
  read: z.array(z.string().min(1)).default([]),
  write: z.array(z.string().min(1)).default([]),
  execute: z.array(z.string().min(1)).default([]),
});

export const CapabilityRequirementsSchema = z.object({
  permission_profile: PermissionProfileSchema,
  authorized_paths: AuthorizedPathsSchema,
  command_class: CommandClassSchema,
});

export const AgentInputContractSchema = z.object({
  execution_id: z.string().min(1),
  project_id: z.string().min(1),
  objective: z.string().min(1),
  authorized_scope: AuthorizedPathsSchema,
  prohibited_scope: z.array(z.string().min(1)).default([]),
  required_inputs: z.array(z.string().min(1)),
  required_outputs: z.array(z.string().min(1)),
  completion_conditions: z.array(z.string().min(1)).min(1),
});

export const AgentInputContractJsonSchema = z.toJSONSchema(AgentInputContractSchema);

export const CapabilityReportSchema = z.object({
  allowed: z.boolean(),
  blockers: z.array(z.string().min(1)),
});

export const ExecutionAuthorizationSchema = CapabilityRequirementsSchema.extend({
  execution_id: z.string().min(1),
  dispatch_digest: z.string().regex(/^[a-f0-9]{64}$/),
  destructive: z.boolean(),
});

export const GateApprovalReferenceSchema = z.object({
  gate: GateIdSchema,
  approval_id: z.string().min(1),
});

export const ArtifactEvidenceReferenceSchema = z.object({
  artifact_id: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["in_review", "approved", "approved_with_conditions"]),
  review_id: z.string().min(1),
  approval_id: z.string().min(1).optional(),
});

export const ExecutionEvidenceSchema = z.object({
  gate_approvals: z.array(GateApprovalReferenceSchema).default([]),
  qa: ArtifactEvidenceReferenceSchema.optional(),
  security: ArtifactEvidenceReferenceSchema.optional(),
  data: ArtifactEvidenceReferenceSchema.optional(),
  destructive_confirmation: GateApprovalReferenceSchema.optional(),
  scope_confirmation: GateApprovalReferenceSchema.optional(),
  data_loss: ArtifactEvidenceReferenceSchema.optional(),
  backup: ArtifactEvidenceReferenceSchema.optional(),
  dry_run: ArtifactEvidenceReferenceSchema.optional(),
  rollback: ArtifactEvidenceReferenceSchema.optional(),
});

export const ExecutionPolicyInputSchema = CapabilityRequirementsSchema.extend({
  execution_id: z.string().min(1),
  dispatch_digest: z.string().regex(/^[a-f0-9]{64}$/),
  target_gate: GateIdSchema.optional(),
  destructive: z.boolean(),
  evidence: ExecutionEvidenceSchema,
});

export const ExecutionCheckpointSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  timestamp: z.string().datetime(),
  evidence: z.array(Sha256DigestSchema).min(1),
});

export const AgentExecutionResultSchema = z.object({
  execution_id: z.string().min(1),
  dispatch_digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["completed", "failed", "cancelled"]),
  permission_profile: PermissionProfileSchema,
  authorized_paths: AuthorizedPathsSchema,
  command_class: CommandClassSchema,
  destructive: z.boolean().default(false),
  checkpoints: z.array(ExecutionCheckpointSchema).min(1),
  evidence: ExecutionEvidenceSchema,
  output: z.unknown().optional(),
});

export const AgentOutputContractJsonSchema = z.toJSONSchema(AgentExecutionResultSchema);

export const ExecutionReceiptSchema = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  adapter_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  review_verdict: z.enum(["approved", "revision_required"]).optional(),
  artifact_versions: z.record(z.string().min(1), z.number().int().positive()).optional(),
  artifact_checksums: z.record(z.string().min(1), Sha256DigestSchema).optional(),
  result: AgentExecutionResultSchema,
  attestation_digest: Sha256DigestSchema,
  recorded_at: z.string().datetime(),
  audit_id: z.string().min(1),
});

export const ExecutionReceiptListSchema = z.object({ receipts: z.array(ExecutionReceiptSchema) });

export const PreparedExecutionRequestSchema = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  adapter_id: z.string().min(1),
  action: z.string().min(1),
  scope: AuthorizedPathsSchema,
  authorization: ExecutionAuthorizationSchema,
  evidence: ExecutionEvidenceSchema,
  attestation_digest: Sha256DigestSchema,
  recorded_at: z.string().datetime(),
  audit_id: z.string().min(1),
});
export const PreparedExecutionRequestListSchema = z.object({ requests: z.array(PreparedExecutionRequestSchema) });

export const PluginInvocationStatusSchema = z.enum(["success", "failure"]);

const PluginInvocationResultFieldsSchema = z.object({
  plugin_uri: z.string().min(1),
  publisher_identity: z.string().min(1),
  status: PluginInvocationStatusSchema,
  output: z.unknown(),
  execution_reference: z.string().min(1),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
});

export const PluginInvocationResultSchema = PluginInvocationResultFieldsSchema.superRefine((result, context) => {
  if (result.completed_at < result.started_at) {
    context.addIssue({
      code: "custom",
      message: "Plugin invocation cannot complete before it starts",
      path: ["completed_at"],
    });
  }
});

export const PluginInvocationRecordSchema = PluginInvocationResultFieldsSchema.omit({ output: true }).extend({
  operation_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  skill: z.string().min(1).optional(),
  input_digest: Sha256DigestSchema,
  output_digest: Sha256DigestSchema,
}).superRefine((record, context) => {
  if (record.completed_at < record.started_at) {
    context.addIssue({
      code: "custom",
      message: "Plugin invocation cannot complete before it starts",
      path: ["completed_at"],
    });
  }
});

export const PluginInvocationListSchema = z.object({
  invocations: z.array(PluginInvocationRecordSchema),
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
  execution_authorization: ExecutionAuthorizationSchema.optional(),
  execution_request_id: z.string().min(1).optional(),
  execution_request_digest: Sha256DigestSchema.optional(),
  execution_receipt_id: z.string().min(1).optional(),
  execution_receipt_digest: Sha256DigestSchema.optional(),
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

export const ArtifactDependencySchema = z.object({
  artifact_id: z.string().min(1),
  version: z.number().int().positive(),
  type: z.enum(["hard_dependency", "soft_dependency", "reference_only", "derived_from"]),
});

export const TraceabilityDocumentSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    status: z.string().min(1),
  })),
  links: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.string().min(1),
  })),
});

const ChangeImpactSchema = z.enum(["low", "medium", "high"]);

export const ChangeRequestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, "Change request id must be filename-safe"),
  requested_by: z.string().min(1),
  affected_artifacts: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  impact: z.object({
    scope: ChangeImpactSchema,
    architecture: ChangeImpactSchema,
    security: ChangeImpactSchema,
    schedule: ChangeImpactSchema,
  }),
  required_reapprovals: z.array(GateIdSchema).default([]),
});

export const ArtifactRecordSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  type: z.string().min(1).default("document"),
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  owner: z.string().min(1),
  reviewer: z.string().min(1),
  dependencies: z.array(ArtifactDependencySchema).default([]),
  consumers: z.array(z.string().min(1)).default([]),
  required_gate: GateIdSchema,
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
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
  execution_receipt_id: z.string().min(1).optional(),
  execution_receipt_digest: Sha256DigestSchema.optional(),
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

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  target: z.string().min(1),
  actor: z.object({
    type: z.enum(["human", "agent", "system"]),
    identifier: z.string().min(1),
  }),
  authorization_source: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  adapter_id: z.string().min(1).optional(),
  permission_profile: z.string().min(1),
  artifact_versions: z.record(z.string().min(1), z.number().int().positive()),
  execution_receipt_id: z.string().min(1).optional(),
  execution_receipt_digest: Sha256DigestSchema.optional(),
  execution_request_id: z.string().min(1).optional(),
  execution_request_digest: Sha256DigestSchema.optional(),
  result: z.enum(["success", "failure"]),
  timestamp: z.string().datetime(),
}).superRefine((event, context) => {
  if (event.actor.type === "agent" && event.agent_id !== event.actor.identifier) {
    context.addIssue({
      code: "custom",
      message: "Agent audit events must bind agent_id to the actor identifier",
      path: ["agent_id"],
    });
  }
});

export const ExecutionEvidenceContextSchema = z.object({
  artifacts: z.array(ArtifactRecordSchema),
  reviews: z.array(ReviewRecordSchema),
  approvals: z.array(ApprovalRecordSchema),
  workflow: WorkflowDefinitionSchema,
  verified_checksums: z.record(z.string().min(1), Sha256DigestSchema),
});

export type ProjectMode = z.infer<typeof ProjectModeSchema>;
export type Glossary = z.infer<typeof GlossarySchema>;
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type EnvironmentOverlay = z.infer<typeof EnvironmentOverlaySchema>;
export type CacheProvider = z.infer<typeof CacheProviderSchema>;
export type LifecycleAuthorization = z.infer<typeof LifecycleAuthorizationSchema>;
export type RepositoryInventory = z.infer<typeof RepositoryInventorySchema>;
export type InstallationManifest = z.infer<typeof InstallationManifestSchema>;
export type UninstallPlan = z.infer<typeof UninstallPlanSchema>;
export type FrameworkLock = z.infer<typeof FrameworkLockSchema>;
export type GateId = z.infer<typeof GateIdSchema>;
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type PluginStatusRecord = z.infer<typeof PluginStatusRecordSchema>;
export type PluginStatusList = z.infer<typeof PluginStatusListSchema>;
export type PluginInvocationResult = z.infer<typeof PluginInvocationResultSchema>;
export type PluginInvocationRecord = z.infer<typeof PluginInvocationRecordSchema>;
export type PluginInvocationList = z.infer<typeof PluginInvocationListSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalList = z.infer<typeof ApprovalListSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArtifactRegistry = z.infer<typeof ArtifactRegistrySchema>;
export type ArtifactDependency = z.infer<typeof ArtifactDependencySchema>;
export type TraceabilityDocument = z.infer<typeof TraceabilityDocumentSchema>;
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type ReviewList = z.infer<typeof ReviewListSchema>;
export type HandoverRecord = z.infer<typeof HandoverRecordSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;
export type CommandClass = z.infer<typeof CommandClassSchema>;
export type AuthorizedPaths = z.infer<typeof AuthorizedPathsSchema>;
export type CapabilityRequirements = z.infer<typeof CapabilityRequirementsSchema>;
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;
export type ExecutionAuthorization = z.infer<typeof ExecutionAuthorizationSchema>;
export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>;
export type GateApprovalReference = z.infer<typeof GateApprovalReferenceSchema>;
export type ArtifactEvidenceReference = z.infer<typeof ArtifactEvidenceReferenceSchema>;
export type ExecutionEvidenceContext = z.infer<typeof ExecutionEvidenceContextSchema>;
export type ExecutionPolicyInput = z.infer<typeof ExecutionPolicyInputSchema>;
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpointSchema>;
export type AgentExecutionResult = z.infer<typeof AgentExecutionResultSchema>;
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
export type ExecutionReceiptList = z.infer<typeof ExecutionReceiptListSchema>;
export type PreparedExecutionRequest = z.infer<typeof PreparedExecutionRequestSchema>;
export type PreparedExecutionRequestList = z.infer<typeof PreparedExecutionRequestListSchema>;
