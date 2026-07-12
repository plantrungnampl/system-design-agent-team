import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArtifact, validateReviewReadyArtifact } from "@system-design-team/artifact-validator";
import {
  AgentManifestSchema,
  ApprovalListSchema,
  ApprovalRecordSchema,
  ArtifactRegistrySchema,
  FRAMEWORK_VERSION,
  FrameworkLockSchema,
  HandoverRecordSchema,
  PluginStatusListSchema,
  ProjectConfigSchema,
  ReviewListSchema,
  ReviewRecordSchema,
  ReviewVerdictSchema,
  WorkflowDefinitionSchema,
  WorkflowStateSchema,
  type AgentManifest,
  type ArtifactRecord,
  type GateId,
  type HandoverRecord,
  type PluginStatusRecord,
  type ProjectConfig,
  type ProjectMode,
  type ProjectProfile,
  type ReviewVerdict,
  type WorkflowDefinition,
  type WorkflowState,
} from "@system-design-team/core";
import { PluginRegistry } from "@system-design-team/plugin-registry";
import { GENERATED_LOCK_PATHS, ProjectStore } from "@system-design-team/project-store";
import { approveGate, transitionPhase } from "@system-design-team/workflow-engine";
import { parse } from "yaml";

export interface InitOptions {
  id: string;
  name: string;
  mode: ProjectMode;
  profile: ProjectProfile;
}

const assetsRoot = join(dirname(fileURLToPath(import.meta.url)), "assets");
const execFileAsync = promisify(execFile);
const workflowFiles: Record<ProjectMode, string> = {
  greenfield: "greenfield.yaml",
  existing_system: "existing-system.yaml",
  migration: "migration.yaml",
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readWorkflow(mode: ProjectMode): Promise<WorkflowDefinition> {
  const text = await readFile(join(assetsRoot, "workflows", workflowFiles[mode]), "utf8");
  return WorkflowDefinitionSchema.parse(parse(text));
}

async function readCatalogue(): Promise<AgentManifest[]> {
  const text = await readFile(join(assetsRoot, "agents/catalogue.yaml"), "utf8");
  return AgentManifestSchema.array().parse(parse(text));
}

async function removeNewAgentTeam(projectRoot: string): Promise<void> {
  const target = join(projectRoot, ".agent-team");
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  const [realRoot, realTarget] = await Promise.all([realpath(projectRoot), realpath(target)]);
  if (inside(realRoot, realTarget)) await rm(target, { recursive: true });
}

async function removeGeneratedPaths(projectRoot: string, paths: readonly string[]): Promise<void> {
  const realRoot = await realpath(projectRoot);
  for (const path of paths) {
    const target = join(projectRoot, path);
    try {
      if (inside(realRoot, await realpath(target))) await rm(target, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function removeEmptyGeneratedDirectory(projectRoot: string, path: string): Promise<void> {
  const target = join(projectRoot, path);
  try {
    if (inside(await realpath(projectRoot), await realpath(target))) await rmdir(target);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function readBootstrapAssets(mode: ProjectMode) {
  const [workflowText, catalogueText, handover] = await Promise.all([
    readFile(join(assetsRoot, "workflows", workflowFiles[mode]), "utf8"),
    readFile(join(assetsRoot, "agents/catalogue.yaml"), "utf8"),
    readFile(join(assetsRoot, "templates/handover.yaml"), "utf8"),
  ]);
  const workflow = WorkflowDefinitionSchema.parse(parse(workflowText));
  const catalogue = AgentManifestSchema.array().parse(parse(catalogueText));
  HandoverRecordSchema.parse(parse(handover));
  const agents = new Set(catalogue.map(({ id }) => id));
  for (const phase of workflow.phases) {
    if (!agents.has(phase.owner) || !agents.has(phase.reviewer)) {
      throw new Error(`WORKFLOW_AGENT_NOT_CONFIGURED: ${phase.id}`);
    }
  }
  return { workflow, catalogue };
}

function renderPhaseArtifact(phase: WorkflowDefinition["phases"][number]): string {
  return [
    "---",
    `artifact_id: ${phase.artifact.id}`,
    `title: ${JSON.stringify(phase.artifact.title)}`,
    "version: 1",
    "status: draft",
    `owner: ${phase.owner}`,
    `reviewer: ${phase.reviewer}`,
    `workflow_phase: ${phase.id}`,
    `required_gate: ${phase.gate}`,
    "---",
    `# ${phase.artifact.title}`,
    "",
    "## Purpose",
    "",
    `This artifact records the reviewable output of the ${phase.id} phase.`,
    "",
  ].join("\n");
}

function renderAgentInstruction(agent: AgentManifest): string {
  const bullets = (values: readonly string[]) => values.map((value) => `- ${value}`).join("\n");
  const plugins = agent.required_plugins.length === 0
    ? "- None."
    : bullets(agent.required_plugins.map((plugin) => [
      plugin.uri,
      plugin.required_skills.length > 0 ? `skills: ${plugin.required_skills.join(", ")}` : "skills: none",
      `fallback: ${plugin.fallback_policy}`,
    ].join("; ")));
  return [
    "<!-- This file is generated by System Design Team. Do not edit directly. -->",
    `# ${agent.display_name}`,
    "",
    "## Mission",
    "",
    agent.mission,
    "",
    "## Allowed actions",
    "",
    bullets(agent.authority.may),
    "",
    "## Prohibited actions",
    "",
    bullets(agent.authority.may_not),
    "",
    "## Required outputs",
    "",
    bullets(agent.outputs),
    "",
    "## Independent reviewer",
    "",
    `- ${agent.reviewer}`,
    "",
    "## Required plugins",
    "",
    plugins,
    "",
  ].join("\n");
}

export async function initProject(root: string, options: InitOptions): Promise<ProjectConfig> {
  const projectRoot = resolve(root);
  const store = ProjectStore.open(projectRoot);
  return store.withLock(".system-design-team-init.lock", async () => {
  if (await exists(join(projectRoot, ".agent-team"))) throw new Error("ALREADY_INITIALIZED");

  const { workflow, catalogue } = await readBootstrapAssets(options.mode);
  const project = ProjectConfigSchema.parse({
    schema_version: 1,
    project: options,
    framework: { version: FRAMEWORK_VERSION },
    workflow: { id: workflow.id, version: workflow.version },
  });
  const state = WorkflowStateSchema.parse({
    schema_version: 1,
    state_version: 0,
    project_id: options.id,
    current_phase: workflow.phases[0]?.id,
    phases: Object.fromEntries(workflow.phases.map((phase, index) => [
      phase.id,
      { status: index === 0 ? "ready" : "not_started" },
    ])),
    completed_operations: [],
  });
  const plugins = PluginStatusListSchema.parse({
    plugins: [...new Set(catalogue.flatMap((agent) =>
      agent.required_plugins.map((plugin) => plugin.uri),
    ))].sort().map((uri) => ({ uri, status: "unknown", skills: [] })),
  });
  const approvals = ApprovalListSchema.parse({ approvals: [] });
  const reviews = ReviewListSchema.parse({ reviews: [] });
  const registry = ArtifactRegistrySchema.parse({
    artifacts: workflow.phases.map((phase) => ({
      id: phase.artifact.id,
      path: phase.artifact.path,
      version: 1,
      status: "draft",
      owner: phase.owner,
      reviewer: phase.reviewer,
      required_gate: phase.gate,
    })),
  });
  const lock = FrameworkLockSchema.parse({
    framework: { version: FRAMEWORK_VERSION },
    workflow: project.workflow,
  });
  const codexKeep = join(projectRoot, ".codex/generated/.gitkeep");
  const preserveCodexKeep = await exists(codexKeep);
  const preserveCodexRoot = await exists(join(projectRoot, ".codex"));
  const preserveCodexAgents = await exists(join(projectRoot, ".codex/agents"));
  const preserveCodexGenerated = await exists(join(projectRoot, ".codex/generated"));
  if (preserveCodexKeep) {
    const [realRoot, realKeep] = await Promise.all([realpath(projectRoot), realpath(codexKeep)]);
    if (!inside(realRoot, realKeep)) throw new Error("PATH_OUTSIDE_PROJECT");
  }
  const codexAgentPaths = catalogue.map((agent) => `.codex/agents/${agent.id}.md`);
  for (const path of codexAgentPaths) {
    if (await exists(join(projectRoot, path))) throw new Error(`CODEX_AGENT_ALREADY_EXISTS: ${path}`);
  }

  try {
    await store.writeYamlAtomic(".agent-team/project.yaml", project);
    await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
    await store.writeYamlAtomic(".agent-team/plugin-status.yaml", plugins);
    await store.writeYamlAtomic(".agent-team/approvals.yaml", approvals);
    await store.writeYamlAtomic(".agent-team/reviews.yaml", reviews);
    await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
    await store.writeYamlAtomic(".agent-team/framework-lock.yaml", lock);
    for (const phase of workflow.phases) {
      await store.writeTextAtomic(
        `.agent-team/${phase.artifact.path}`,
        renderPhaseArtifact(phase),
      );
    }
    await store.writeTextAtomic(".agent-team/handovers/.gitkeep", "");
    await appendOperationAudit(store, operationKey("init", options.id, "bootstrap"), "init", options.id);
    for (const agent of catalogue) {
      await store.writeTextAtomic(`.codex/agents/${agent.id}.md`, renderAgentInstruction(agent));
    }
    if (!preserveCodexKeep) await store.writeTextAtomic(".codex/generated/.gitkeep", "");
    return project;
  } catch (error) {
    await removeNewAgentTeam(projectRoot);
    await removeGeneratedPaths(projectRoot, [
      ...codexAgentPaths,
      ...(preserveCodexKeep ? [] : [".codex/generated/.gitkeep"]),
    ]);
    if (!preserveCodexAgents) await removeEmptyGeneratedDirectory(projectRoot, ".codex/agents");
    if (!preserveCodexGenerated) await removeEmptyGeneratedDirectory(projectRoot, ".codex/generated");
    if (!preserveCodexRoot) await removeEmptyGeneratedDirectory(projectRoot, ".codex");
    throw error;
  }
  });
}

async function projectConfig(store: ProjectStore): Promise<ProjectConfig> {
  return store.readYaml(".agent-team/project.yaml", ProjectConfigSchema);
}

async function configuredWorkflow(store: ProjectStore): Promise<WorkflowDefinition> {
  const project = await projectConfig(store);
  const workflow = await readWorkflow(project.project.mode);
  if (workflow.id !== project.workflow.id || workflow.version !== project.workflow.version) {
    throw new Error("WORKFLOW_MISMATCH");
  }
  return workflow;
}

async function pluginStatus(store: ProjectStore) {
  return store.readYaml(".agent-team/plugin-status.yaml", PluginStatusListSchema);
}

async function artifactRegistry(store: ProjectStore) {
  return store.readYaml(".agent-team/artifact-registry.yaml", ArtifactRegistrySchema);
}

function requireOperationId(operationId: string): void {
  if (!operationId.trim()) throw new Error("OPERATION_ID_REQUIRED");
}

function operationKey(action: string, target: string, operationId: string): string {
  return JSON.stringify([action, target, operationId]);
}

async function appendOperationAudit(
  store: ProjectStore,
  id: string,
  action: string,
  target: string,
): Promise<void> {
  await store.appendAuditOnce({ id, action, target });
}

export async function setPluginStatus(
  root: string,
  uri: string,
  status: PluginStatusRecord["status"],
  skills: string[] = [],
) {
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
  const current = await pluginStatus(store);
  const record = { uri, status, skills };
  const plugins = current.plugins.some((plugin) => plugin.uri === uri)
    ? current.plugins.map((plugin) => plugin.uri === uri ? record : plugin)
    : [...current.plugins, record];
  const next = PluginStatusListSchema.parse({
    plugins: plugins.sort((left, right) => left.uri.localeCompare(right.uri)),
  });
  await store.writeYamlAtomic(".agent-team/plugin-status.yaml", next);
  return next;
  });
}

export async function startPhase(
  root: string,
  phase: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const scopedOperation = operationKey("start", phase, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
  const state = await store.readWorkflowState();
  if (state.completed_operations.includes(scopedOperation)) {
    await appendOperationAudit(store, scopedOperation, "start", phase);
    return state;
  }

  const workflow = await configuredWorkflow(store);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const owner = (await readCatalogue()).find((agent) => agent.id === definition.owner);
  if (!owner) throw new Error(`AGENT_NOT_CONFIGURED: ${definition.owner}`);
  const report = new PluginRegistry((await pluginStatus(store)).plugins).check(owner);
  if (!report.allowed) {
    const blocker = report.blockers[0];
    throw new Error(blocker
      ? `${blocker.code}: ${blocker.uri}${blocker.skill ? ` (${blocker.skill})` : ""}`
      : "PLUGIN_CAPABILITY_BLOCKED");
  }

  const next = await store.updateWorkflowState(state.state_version, (current) => transitionPhase(
    current,
    workflow,
    { phase, to: "in_progress", operation_id: scopedOperation },
  ));
  await appendOperationAudit(store, scopedOperation, "start", phase);
  return next;
  });
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function readArtifact(root: string, artifact: ArtifactRecord): Promise<string> {
  const base = await realpath(join(resolve(root), ".agent-team"));
  const target = resolve(base, artifact.path);
  if (!inside(base, target) || !inside(base, await realpath(target))) {
    throw new Error("PATH_OUTSIDE_PROJECT");
  }
  return readFile(target, "utf8");
}

const reviewReadyStatuses = new Set(["in_review", "approved", "approved_with_conditions"]);

async function inspectArtifacts(root: string, artifacts: readonly ArtifactRecord[]) {
  const findings: { artifact_id?: string; code: string; message: string }[] = [];
  for (const artifact of artifacts) {
    if (!reviewReadyStatuses.has(artifact.status)) {
      findings.push({
        artifact_id: artifact.id,
        code: "ARTIFACT_NOT_REVIEW_READY",
        message: `${artifact.id} registry status is ${artifact.status}`,
      });
    }
    try {
      const text = await readArtifact(root, artifact);
      const parsed = parseArtifact(text);
      const status = String(parsed.metadata.status ?? "");
      if (!reviewReadyStatuses.has(status)) {
        findings.push({
          artifact_id: artifact.id,
          code: "ARTIFACT_NOT_REVIEW_READY",
          message: `${artifact.id} front-matter status is ${status || "missing"}`,
        });
      }
      if (parsed.metadata.artifact_id !== artifact.id
        || Number(parsed.metadata.version) !== artifact.version
        || status !== artifact.status) {
        findings.push({
          artifact_id: artifact.id,
          code: "ARTIFACT_METADATA_MISMATCH",
          message: `${artifact.id} front matter does not match its registry record`,
        });
      }
      const validation = validateReviewReadyArtifact(text);
      findings.push(...validation.findings.map((finding) => ({
        artifact_id: artifact.id,
        ...finding,
      })));
    } catch (error) {
      findings.push({
        artifact_id: artifact.id,
        code: "ARTIFACT_UNREADABLE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return findings;
}

export async function validatePhase(root: string, phase: string, operationId: string) {
  requireOperationId(operationId);
  const scopedOperation = operationKey("validate", phase, operationId);
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  if (state.completed_operations.includes(scopedOperation)) {
    await appendOperationAudit(store, scopedOperation, "validate", phase);
    return { valid: true, phase, findings: [], state };
  }
  const workflow = await configuredWorkflow(store);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const artifacts = (await artifactRegistry(store)).artifacts.filter(
    (artifact) => artifact.owner === definition.owner && artifact.required_gate === definition.gate,
  );
  const findings = await inspectArtifacts(root, artifacts);
  if (artifacts.length === 0) {
    findings.push({ code: "NO_REGISTERED_ARTIFACTS", message: `No artifacts registered for ${phase}` });
  }
  if (findings.length > 0) return { valid: false, phase, findings, state };

  const next = await store.updateWorkflowState(state.state_version, (current) => transitionPhase(
    current,
    workflow,
    { phase, to: "artifact_validation", operation_id: scopedOperation },
  ));
  await appendOperationAudit(store, scopedOperation, "validate", phase);
  return { valid: true, phase, findings, state: next };
}

function artifactVersions(artifacts: readonly ArtifactRecord[]): Record<string, number> {
  return Object.fromEntries(
    [...artifacts].sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => [artifact.id, artifact.version]),
  );
}

function sameArtifactVersions(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const entries = (value: Record<string, number>) => Object.entries(value)
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function handoverDigest(record: HandoverRecord): string {
  const validated = HandoverRecordSchema.parse(record);
  return createHash("sha256").update(JSON.stringify(validated)).digest("hex");
}

function approvalInputs(artifactVersions: Record<string, number>): string[] {
  return Object.entries(artifactVersions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, version]) => `${id}@${version}`);
}

export async function reviewPhase(
  root: string,
  phase: string,
  reviewer: string,
  verdictInput: ReviewVerdict,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const reviewerId = reviewer.trim();
  const verdict = ReviewVerdictSchema.parse(verdictInput);
  const evidenceId = operationKey("review", phase, operationId);
  const underReviewId = operationKey("review-under-review", phase, operationId);
  const verdictId = operationKey("review-verdict", phase, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
  const [workflow, state, reviews, registry] = await Promise.all([
    configuredWorkflow(store),
    store.readWorkflowState(),
    store.readYaml(".agent-team/reviews.yaml", ReviewListSchema),
    artifactRegistry(store),
  ]);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const existing = reviews.reviews.find((review) => review.id === evidenceId);
  if (state.completed_operations.includes(verdictId)) {
    if (!existing) throw new Error("REVIEW_EVIDENCE_MISSING");
    if (existing.phase !== phase || existing.reviewer !== reviewerId || existing.verdict !== verdict) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
    if (state.phases[phase]?.review_id !== existing.id) throw new Error("REVIEW_EVIDENCE_MISSING");
    await appendOperationAudit(store, evidenceId, "review", phase);
    return state;
  }
  if (!reviewerId || reviewerId !== definition.reviewer || reviewerId === definition.owner) {
    throw new Error("REVIEWER_NOT_CONFIGURED");
  }
  const reviewerManifest = (await readCatalogue()).find((agent) => agent.id === reviewerId);
  if (!reviewerManifest) throw new Error("REVIEWER_NOT_CONFIGURED");
  const capability = new PluginRegistry((await pluginStatus(store)).plugins).check(reviewerManifest);
  if (!capability.allowed) {
    const blocker = capability.blockers[0];
    throw new Error(blocker
      ? `${blocker.code}: ${blocker.uri}${blocker.skill ? ` (${blocker.skill})` : ""}`
      : "PLUGIN_CAPABILITY_BLOCKED");
  }
  const artifacts = registry.artifacts.filter(
    (artifact) => artifact.owner === definition.owner && artifact.required_gate === definition.gate,
  );
  if (artifacts.length === 0) throw new Error("REVIEW_ARTIFACTS_REQUIRED");
  const [finding] = await inspectArtifacts(root, artifacts);
  if (finding) throw new Error(`${finding.code}: ${finding.message}`);
  const expected = {
    id: evidenceId,
    phase,
    reviewer: reviewerId,
    verdict,
    artifact_versions: artifactVersions(artifacts),
  };
  const review = existing ?? ReviewRecordSchema.parse({
    ...expected,
    timestamp: new Date().toISOString(),
  });
  if (existing) {
    const { timestamp: _timestamp, ...existingWithoutTimestamp } = existing;
    if (JSON.stringify(existingWithoutTimestamp) !== JSON.stringify(expected)) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
  }
  const bindReview = (value: WorkflowState): WorkflowState => {
    const current = value.phases[phase];
    if (!current) throw new Error("PHASE_NOT_CONFIGURED");
    return {
      ...value,
      phases: { ...value.phases, [phase]: { ...current, review_id: evidenceId } },
    };
  };

  let preview = state;
  if (!preview.completed_operations.includes(underReviewId)) {
    preview = transitionPhase(bindReview(preview), workflow, {
      phase,
      to: "under_review",
      operation_id: underReviewId,
    });
  }
  if (!preview.completed_operations.includes(verdictId)) {
    preview = transitionPhase(bindReview(preview), workflow, {
      phase,
      to: verdict === "approved" ? "awaiting_approval" : "revision_required",
      operation_id: verdictId,
    });
  }
  if (!existing) {
    await store.writeYamlAtomic(
      ".agent-team/reviews.yaml",
      ReviewListSchema.parse({ reviews: [...reviews.reviews, review] }),
    );
  }

  let current = state;
  if (!current.completed_operations.includes(underReviewId)) {
    current = await store.updateWorkflowState(current.state_version, (value) => transitionPhase(
      bindReview(value),
      workflow,
      { phase, to: "under_review", operation_id: underReviewId },
    ));
  }
  if (!current.completed_operations.includes(verdictId)) {
    current = await store.updateWorkflowState(current.state_version, (value) => transitionPhase(
      bindReview(value),
      workflow,
      {
        phase,
        to: verdict === "approved" ? "awaiting_approval" : "revision_required",
        operation_id: verdictId,
      },
    ));
  }
  await appendOperationAudit(store, evidenceId, "review", phase);
  return current;
  });
}

export async function approve(
  root: string,
  gate: GateId,
  by: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const approver = by.trim();
  if (!approver) throw new Error("APPROVER_REQUIRED");
  const scopedOperation = operationKey("approve", gate, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
  const [state, workflow, approvals, reviews, registry] = await Promise.all([
    store.readWorkflowState(),
    configuredWorkflow(store),
    store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
    store.readYaml(".agent-team/reviews.yaml", ReviewListSchema),
    artifactRegistry(store),
  ]);
  const existing = approvals.approvals.find((approval) => approval.id === scopedOperation);
  if (state.completed_operations.includes(scopedOperation)) {
    if (!existing) throw new Error("APPROVAL_EVIDENCE_MISSING");
    if (existing.gate !== gate
      || existing.decision !== "approved"
      || existing.approved_by.type !== "human"
      || existing.approved_by.identifier !== approver) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
    await appendOperationAudit(store, scopedOperation, "approve", gate);
    return state;
  }

  const definition = workflow.phases.find(
    (phase) => phase.gate === gate && state.phases[phase.id]?.status === "awaiting_approval",
  );
  if (!definition) throw new Error("INVALID_APPROVAL_STATE");
  const artifacts = registry.artifacts.filter(
    (artifact) => artifact.required_gate === gate && artifact.owner === definition.owner,
  );
  const versions = artifactVersions(artifacts);
  if (Object.keys(versions).length === 0) throw new Error("APPROVAL_ARTIFACTS_REQUIRED");
  const [finding] = await inspectArtifacts(root, artifacts);
  if (finding) throw new Error(`${finding.code}: ${finding.message}`);
  const reviewId = state.phases[definition.id]?.review_id;
  const review = reviews.reviews.find((candidate) => candidate.id === reviewId);
  if (!reviewId || !review) throw new Error("REVIEW_EVIDENCE_MISSING");
  if (review.phase !== definition.id
    || review.verdict !== "approved"
    || !sameArtifactVersions(review.artifact_versions, versions)) {
    throw new Error("REVIEW_VERSION_MISMATCH");
  }
  const expected = {
    id: scopedOperation,
    gate,
    decision: "approved" as const,
    approved_by: { type: "human" as const, identifier: approver },
    artifact_versions: versions,
  };
  const approval = existing ?? ApprovalRecordSchema.parse({
    ...expected,
    timestamp: new Date().toISOString(),
  });
  if (existing && JSON.stringify({ ...existing, timestamp: undefined })
    !== JSON.stringify({ ...expected, timestamp: undefined })) {
    throw new Error("OPERATION_ID_CONFLICT");
  }

  approveGate(state, workflow, approval);
  if (!existing) {
    const next = ApprovalListSchema.parse({ approvals: [...approvals.approvals, approval] });
    await store.writeYamlAtomic(".agent-team/approvals.yaml", next);
  }
  const nextState = await store.updateWorkflowState(state.state_version, (current) =>
    approveGate(current, workflow, approval));
  await appendOperationAudit(store, scopedOperation, "approve", gate);
  return nextState;
  });
}

export async function handover(
  root: string,
  phase: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const scopedOperation = operationKey("handover", phase, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
  const [workflow, initialState] = await Promise.all([
    configuredWorkflow(store),
    store.readWorkflowState(),
  ]);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const dependents = workflow.phases.filter((candidate) => candidate.depends_on.includes(phase));
  const target = dependents[0];
  if (!target) throw new Error("HANDOVER_TARGET_REQUIRED");
  let state = initialState;
  const phaseState = state.phases[phase];
  if (!phaseState) throw new Error("INVALID_HANDOVER_STATE");
  const relativeRecord = `.agent-team/handovers/${phase}.yaml`;
  const recordExists = await exists(join(resolve(root), relativeRecord));
  const stored = recordExists
    ? await store.readYaml(relativeRecord, HandoverRecordSchema)
    : undefined;

  if (state.completed_operations.includes(scopedOperation)) {
    if (!stored) throw new Error("HANDOVER_EVIDENCE_MISSING");
    const approvals = await store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema);
    const approval = approvals.approvals.find((candidate) => candidate.id === phaseState.approval_id);
    if (phaseState.handover_id !== scopedOperation
      || !phaseState.handover_digest
      || handoverDigest(stored) !== phaseState.handover_digest
      || stored.id !== scopedOperation
      || stored.phase !== phase
      || stored.from_agent !== definition.owner
      || stored.to_agent !== target.owner
      || !approval
      || JSON.stringify(stored.approved_inputs) !== JSON.stringify(approvalInputs(approval.artifact_versions))) {
      throw new Error("HANDOVER_EVIDENCE_CONFLICT");
    }
  } else {
    const [approvals, registry] = await Promise.all([
      store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
      artifactRegistry(store),
    ]);
    const approval = approvals.approvals.find((candidate) => candidate.id === phaseState.approval_id);
    if (!approval
      || (approval.decision !== "approved" && approval.decision !== "approved_with_conditions")) {
      throw new Error("APPROVAL_EVIDENCE_MISSING");
    }
    const approvedArtifacts = registry.artifacts.filter(
      (artifact) => artifact.required_gate === definition.gate && artifact.owner === definition.owner,
    );
    const [staleFinding] = await inspectArtifacts(root, approvedArtifacts);
    if (staleFinding
      || Object.keys(approval.artifact_versions).length === 0
      || !sameArtifactVersions(approval.artifact_versions, artifactVersions(approvedArtifacts))) {
      throw new Error("APPROVED_INPUT_STALE");
    }
    const proposed = HandoverRecordSchema.parse({
      id: scopedOperation,
      phase,
      from_agent: definition.owner,
      to_agent: target.owner,
      approved_inputs: approvalInputs(approval.artifact_versions),
      expected_outputs: [target.artifact.id],
      acceptance_conditions: ["Dependent work uses only the approved input versions."],
    });
    const digest = handoverDigest(proposed);
    if (stored && JSON.stringify(stored) !== JSON.stringify(proposed)) {
      throw new Error("HANDOVER_EVIDENCE_CONFLICT");
    }
    if (phaseState.status !== "approved") throw new Error("INVALID_HANDOVER_STATE");
    const withId: WorkflowState = {
      ...state,
      phases: {
        ...state.phases,
        [phase]: { ...phaseState, handover_id: scopedOperation, handover_digest: digest },
      },
    };
    transitionPhase(withId, workflow, {
      phase,
      to: "handed_over",
      operation_id: scopedOperation,
    });
    if (!stored) await store.writeYamlAtomic(relativeRecord, proposed);
    state = await store.updateWorkflowState(state.state_version, (current) => {
      const currentPhase = current.phases[phase];
      if (!currentPhase) throw new Error("INVALID_HANDOVER_STATE");
      return transitionPhase({
        ...current,
        phases: {
          ...current.phases,
          [phase]: { ...currentPhase, handover_id: scopedOperation, handover_digest: digest },
        },
      }, workflow, {
        phase,
        to: "handed_over",
        operation_id: scopedOperation,
      });
    });
  }

  for (const dependent of dependents) {
    const readinessId = operationKey("handover-ready", `${phase}->${dependent.id}`, operationId);
    state = await store.readWorkflowState();
    if (state.completed_operations.includes(readinessId)) continue;
    state = await store.updateWorkflowState(state.state_version, (current) => transitionPhase(
      current,
      workflow,
      { phase: dependent.id, to: "ready", operation_id: readinessId },
    ));
  }
  await appendOperationAudit(store, scopedOperation, "handover", phase);
  return state;
  });
}

export async function getStatus(root: string) {
  const store = ProjectStore.open(root);
  const [project, workflow, state, plugins] = await Promise.all([
    projectConfig(store),
    configuredWorkflow(store),
    store.readWorkflowState(),
    pluginStatus(store),
  ]);
  return {
    project: project.project,
    workflow: { id: workflow.id, version: workflow.version },
    current_phase: state.current_phase,
    state_version: state.state_version,
    phases: state.phases,
    plugins: plugins.plugins,
  };
}

export async function repair(
  root: string,
  options: { locks: boolean; confirmedQuiescent: boolean },
) {
  if (!options.locks) throw new Error("LOCKS_REQUIRED");
  if (!options.confirmedQuiescent) throw new Error("QUIESCENCE_CONFIRMATION_REQUIRED");
  const store = ProjectStore.open(root);
  const inspections = await Promise.all(GENERATED_LOCK_PATHS.map((path) => store.inspectLock(path)));
  if (inspections.some(({ status }) => status === "locked")) throw new Error("STATE_LOCKED");
  const repaired: string[] = [];
  for (const { path, status } of inspections) {
    if (status === "missing") continue;
    if (await store.repairLock(path, { confirmedQuiescent: true })) repaired.push(path);
  }
  return { repaired };
}

export async function doctor(root: string) {
  const store = ProjectStore.open(root);
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    checks.push({ name: "git", ok: stdout.trim() === "true", detail: stdout.trim() });
  } catch (error) {
    checks.push({ name: "git", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: major >= 20, detail: process.versions.node });
  try {
    await store.readWorkflowState();
    checks.push({ name: "state_schema", ok: true, detail: "valid" });
  } catch (error) {
    checks.push({ name: "state_schema", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const workflow = await configuredWorkflow(store);
    checks.push({ name: "workflow", ok: true, detail: `${workflow.id}@${workflow.version}` });
  } catch (error) {
    checks.push({ name: "workflow", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const [plugins, workflow, catalogue] = await Promise.all([
      pluginStatus(store),
      configuredWorkflow(store),
      readCatalogue(),
    ]);
    const registry = new PluginRegistry(plugins.plugins);
    const agentIds = [...new Set(workflow.phases.flatMap((phase) => [phase.owner, phase.reviewer]))]
      .sort();
    const blockers = agentIds.flatMap((agentId) => {
      const manifest = catalogue.find((agent) => agent.id === agentId);
      if (!manifest) return [`${agentId}:AGENT_NOT_CONFIGURED`];
      return registry.check(manifest).blockers.map((blocker) =>
        `${agentId}:${blocker.code}:${blocker.uri}${blocker.skill ? `:${blocker.skill}` : ""}`);
    });
    checks.push({
      name: "plugins",
      ok: blockers.length === 0,
      detail: blockers.length === 0
        ? "available"
        : blockers.join(","),
    });
  } catch (error) {
    checks.push({ name: "plugins", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const abandoned = (await Promise.all(GENERATED_LOCK_PATHS.map((path) => store.inspectLock(path))))
      .filter(({ status }) => status === "abandoned")
      .map(({ path }) => path);
    checks.push({
      name: "locks",
      ok: abandoned.length === 0,
      detail: abandoned.length === 0
        ? "no abandoned locks"
        : `abandoned:${abandoned.join(",")}; stop all framework processes, then run system-design-team repair --locks --yes`,
    });
  } catch (error) {
    checks.push({ name: "locks", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
