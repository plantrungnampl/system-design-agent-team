import { execFile } from "node:child_process";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
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
  type PluginStatusRecord,
  type ProjectConfig,
  type ProjectMode,
  type ProjectProfile,
  type ReviewVerdict,
  type WorkflowDefinition,
  type WorkflowState,
} from "@system-design-team/core";
import { PluginRegistry } from "@system-design-team/plugin-registry";
import { ProjectStore } from "@system-design-team/project-store";
import { approveGate, transitionPhase } from "@system-design-team/workflow-engine";
import { parse } from "yaml";

export interface InitOptions {
  id: string;
  name: string;
  mode: ProjectMode;
  profile: ProjectProfile;
}

const assetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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

async function readBootstrapAssets(mode: ProjectMode) {
  const [workflowText, catalogueText, charter, requirements, handover] = await Promise.all([
    readFile(join(assetsRoot, "workflows", workflowFiles[mode]), "utf8"),
    readFile(join(assetsRoot, "agents/catalogue.yaml"), "utf8"),
    readFile(join(assetsRoot, "templates/project-charter.md"), "utf8"),
    readFile(join(assetsRoot, "templates/requirements.md"), "utf8"),
    readFile(join(assetsRoot, "templates/handover.yaml"), "utf8"),
  ]);
  const workflow = WorkflowDefinitionSchema.parse(parse(workflowText));
  const catalogue = AgentManifestSchema.array().parse(parse(catalogueText));
  parseArtifact(charter);
  parseArtifact(requirements);
  HandoverRecordSchema.parse(parse(handover));
  return { workflow, catalogue, charter, requirements };
}

export async function initProject(root: string, options: InitOptions): Promise<ProjectConfig> {
  const projectRoot = resolve(root);
  if (await exists(join(projectRoot, ".agent-team"))) throw new Error("ALREADY_INITIALIZED");

  const { workflow, catalogue, charter, requirements } = await readBootstrapAssets(options.mode);
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
    artifacts: [
      {
        id: "PROJECT-CHARTER",
        path: "context/project-charter.md",
        version: 1,
        status: "draft",
        owner: "lead-orchestrator",
        reviewer: "documentation-reviewer",
        required_gate: "G0",
      },
      {
        id: "REQUIREMENTS",
        path: "requirements/requirements.md",
        version: 1,
        status: "draft",
        owner: "business-analyst",
        reviewer: "requirements-reviewer",
        required_gate: "G2",
      },
    ],
  });
  const lock = FrameworkLockSchema.parse({
    framework: { version: FRAMEWORK_VERSION },
    workflow: project.workflow,
  });
  const store = ProjectStore.open(projectRoot);
  const codexKeep = join(projectRoot, ".codex/generated/.gitkeep");
  const preserveCodexKeep = await exists(codexKeep);
  if (preserveCodexKeep) {
    const [realRoot, realKeep] = await Promise.all([realpath(projectRoot), realpath(codexKeep)]);
    if (!inside(realRoot, realKeep)) throw new Error("PATH_OUTSIDE_PROJECT");
  }

  try {
    await store.writeYamlAtomic(".agent-team/project.yaml", project);
    await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
    await store.writeYamlAtomic(".agent-team/plugin-status.yaml", plugins);
    await store.writeYamlAtomic(".agent-team/approvals.yaml", approvals);
    await store.writeYamlAtomic(".agent-team/reviews.yaml", reviews);
    await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
    await store.writeYamlAtomic(".agent-team/framework-lock.yaml", lock);
    await store.writeTextAtomic(".agent-team/context/project-charter.md", charter);
    await store.writeTextAtomic(".agent-team/requirements/requirements.md", requirements);
    await store.writeTextAtomic(".agent-team/product/.gitkeep", "");
    await store.writeTextAtomic(".agent-team/handovers/.gitkeep", "");
    if (!preserveCodexKeep) await store.writeTextAtomic(".codex/generated/.gitkeep", "");
    return project;
  } catch (error) {
    await removeNewAgentTeam(projectRoot);
    throw error;
  }
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

export async function setPluginStatus(
  root: string,
  uri: string,
  status: PluginStatusRecord["status"],
  skills: string[] = [],
) {
  const store = ProjectStore.open(root);
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
}

export async function startPhase(
  root: string,
  phase: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const scopedOperation = operationKey("start", phase, operationId);
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  if (state.completed_operations.includes(scopedOperation)) return state;

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

  return store.updateWorkflowState(state.state_version, (current) => transitionPhase(
    current,
    workflow,
    { phase, to: "in_progress", operation_id: scopedOperation },
  ));
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
  return { valid: true, phase, findings, state: next };
}

function artifactVersions(artifacts: readonly ArtifactRecord[]): Record<string, number> {
  return Object.fromEntries(
    [...artifacts].sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => [artifact.id, artifact.version]),
  );
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
  const [workflow, state, reviews, registry] = await Promise.all([
    configuredWorkflow(store),
    store.readWorkflowState(),
    store.readYaml(".agent-team/reviews.yaml", ReviewListSchema),
    artifactRegistry(store),
  ]);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  if (!reviewerId || reviewerId !== definition.reviewer || reviewerId === definition.owner) {
    throw new Error("REVIEWER_NOT_CONFIGURED");
  }
  const existing = reviews.reviews.find((review) => review.id === evidenceId);
  if (state.completed_operations.includes(verdictId)) {
    if (!existing) throw new Error("REVIEW_EVIDENCE_MISSING");
    return state;
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

  let preview = state;
  if (!preview.completed_operations.includes(underReviewId)) {
    preview = transitionPhase(preview, workflow, {
      phase,
      to: "under_review",
      operation_id: underReviewId,
    });
  }
  if (!preview.completed_operations.includes(verdictId)) {
    preview = transitionPhase(preview, workflow, {
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
      value,
      workflow,
      { phase, to: "under_review", operation_id: underReviewId },
    ));
  }
  if (!current.completed_operations.includes(verdictId)) {
    current = await store.updateWorkflowState(current.state_version, (value) => transitionPhase(
      value,
      workflow,
      {
        phase,
        to: verdict === "approved" ? "awaiting_approval" : "revision_required",
        operation_id: verdictId,
      },
    ));
  }
  return current;
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
  const [state, workflow, approvals, registry] = await Promise.all([
    store.readWorkflowState(),
    configuredWorkflow(store),
    store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
    artifactRegistry(store),
  ]);
  const existing = approvals.approvals.find((approval) => approval.id === scopedOperation);
  if (state.completed_operations.includes(scopedOperation)) {
    if (!existing) throw new Error("APPROVAL_EVIDENCE_MISSING");
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
  return store.updateWorkflowState(state.state_version, (current) =>
    approveGate(current, workflow, approval));
}

export async function handover(
  root: string,
  phase: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const scopedOperation = operationKey("handover", phase, operationId);
  const store = ProjectStore.open(root);
  const [workflow, approvals, registry] = await Promise.all([
    configuredWorkflow(store),
    store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
    artifactRegistry(store),
  ]);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const dependents = workflow.phases.filter((candidate) => candidate.depends_on.includes(phase));
  const target = dependents[0];
  if (!target) throw new Error("HANDOVER_TARGET_REQUIRED");
  let state = await store.readWorkflowState();
  const phaseState = state.phases[phase];
  if (!phaseState) throw new Error("INVALID_HANDOVER_STATE");
  const approval = approvals.approvals.find((candidate) => candidate.id === phaseState.approval_id);
  if (!approval
    || (approval.decision !== "approved" && approval.decision !== "approved_with_conditions")) {
    throw new Error("APPROVAL_EVIDENCE_MISSING");
  }
  const proposed = HandoverRecordSchema.parse({
    id: scopedOperation,
    phase,
    from_agent: definition.owner,
    to_agent: target.owner,
    approved_inputs: Object.entries(approval.artifact_versions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, version]) => `${id}@${version}`),
    expected_outputs: registry.artifacts.filter((artifact) => artifact.owner === target.owner)
      .map((artifact) => artifact.id).sort(),
    acceptance_conditions: ["Dependent work uses only the approved input versions."],
  });
  const relativeRecord = `.agent-team/handovers/${phase}.yaml`;
  const recordExists = await exists(join(resolve(root), relativeRecord));
  if (recordExists) {
    const current = await store.readYaml(relativeRecord, HandoverRecordSchema);
    if (JSON.stringify(current) !== JSON.stringify(proposed)) {
      throw new Error("HANDOVER_EVIDENCE_CONFLICT");
    }
  }

  if (!state.completed_operations.includes(scopedOperation)) {
    if (phaseState.status !== "approved") throw new Error("INVALID_HANDOVER_STATE");
    const withId: WorkflowState = {
      ...state,
      phases: {
        ...state.phases,
        [phase]: { ...phaseState, handover_id: scopedOperation },
      },
    };
    transitionPhase(withId, workflow, {
      phase,
      to: "handed_over",
      operation_id: scopedOperation,
    });
    if (!recordExists) await store.writeYamlAtomic(relativeRecord, proposed);
    state = await store.updateWorkflowState(state.state_version, (current) => {
      const currentPhase = current.phases[phase];
      if (!currentPhase) throw new Error("INVALID_HANDOVER_STATE");
      return transitionPhase({
        ...current,
        phases: {
          ...current.phases,
          [phase]: { ...currentPhase, handover_id: scopedOperation },
        },
      }, workflow, {
        phase,
        to: "handed_over",
        operation_id: scopedOperation,
      });
    });
  } else if (!recordExists) {
    throw new Error("HANDOVER_EVIDENCE_MISSING");
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
  return state;
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
  return { ok: checks.every((check) => check.ok), checks };
}
