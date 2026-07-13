import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArtifact, validateReviewReadyArtifact } from "@system-design-team/artifact-validator";
import {
  AgentManifestSchema,
  AgentExecutionResultSchema,
  AuditEventSchema,
  ApprovalListSchema,
  ApprovalRecordSchema,
  ArtifactRegistrySchema,
  ChangeRequestSchema,
  FRAMEWORK_VERSION,
  FrameworkLockSchema,
  HandoverRecordSchema,
  PluginInvocationListSchema,
  PluginStatusListSchema,
  ProjectConfigSchema,
  ReviewListSchema,
  ReviewRecordSchema,
  ReviewVerdictSchema,
  TraceabilityDocumentSchema,
  WorkflowDefinitionSchema,
  WorkflowStateSchema,
  type AgentManifest,
  type AgentExecutionResult,
  type AuditEvent,
  type ArtifactRecord,
  type ChangeRequest,
  type GateId,
  type HandoverRecord,
  type PluginInvocationList,
  type PluginStatusRecord,
  type ProjectConfig,
  type ProjectMode,
  type ProjectProfile,
  type ReviewVerdict,
  type WorkflowDefinition,
  type WorkflowState,
} from "@system-design-team/core";
import {
  PluginRegistry,
  pluginInvocationDigest,
  type PluginAdapter,
  type PluginInvocationRequest,
  type VerifiedPluginInvocation,
} from "@system-design-team/plugin-registry";
import { GENERATED_LOCK_PATHS, ProjectStore } from "@system-design-team/project-store";
import { propagateStaleness, traceCoverage, validateTraceability } from "@system-design-team/traceability";
import {
  approveGate,
  evaluateExecutionResult,
  gateReadiness,
  rejectGate as rejectWorkflowGate,
  transitionPhase,
} from "@system-design-team/workflow-engine";
import { parse, stringify } from "yaml";

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

function artifactChecksum(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
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
  const pluginInvocations = PluginInvocationListSchema.parse({ invocations: [] });
  const approvals = ApprovalListSchema.parse({ approvals: [] });
  const reviews = ReviewListSchema.parse({ reviews: [] });
  const artifactTexts = new Map(workflow.phases.map((phase) => [phase.id, renderPhaseArtifact(phase)]));
  const registry = ArtifactRegistrySchema.parse({
    artifacts: workflow.phases.map((phase) => ({
      id: phase.artifact.id,
      path: phase.artifact.path,
      type: "document",
      version: 1,
      status: "draft",
      owner: phase.owner,
      reviewer: phase.reviewer,
      dependencies: phase.depends_on.map((dependency) => ({
        artifact_id: workflow.phases.find((candidate) => candidate.id === dependency)!.artifact.id,
        version: 1,
        type: "hard_dependency",
      })),
      consumers: workflow.phases
        .filter((candidate) => candidate.depends_on.includes(phase.id))
        .map((candidate) => candidate.artifact.id),
      required_gate: phase.gate,
      checksum: artifactChecksum(artifactTexts.get(phase.id)!),
    })),
  });
  const traceability = TraceabilityDocumentSchema.parse({
    nodes: registry.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: "artifact",
      status: artifact.status,
    })),
    links: registry.artifacts.flatMap((artifact) => artifact.dependencies.map((dependency) => ({
      from: dependency.artifact_id,
      to: artifact.id,
      type: dependency.type,
    }))),
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
    const id = operationKey("init", options.id, "bootstrap");
    await store.transaction(id, [
      { path: ".agent-team/project.yaml", content: stringify(project) },
      { path: ".agent-team/workflow-state.yaml", content: stringify(state) },
      { path: ".agent-team/plugin-status.yaml", content: stringify(plugins) },
      { path: ".agent-team/plugin-invocations.yaml", content: stringify(pluginInvocations) },
      { path: ".agent-team/approvals.yaml", content: stringify(approvals) },
      { path: ".agent-team/reviews.yaml", content: stringify(reviews) },
      { path: ".agent-team/artifact-registry.yaml", content: stringify(registry) },
      { path: ".agent-team/traceability.yaml", content: stringify(traceability) },
      { path: ".agent-team/framework-lock.yaml", content: stringify(lock) },
      ...workflow.phases.map((phase) => ({
        path: `.agent-team/${phase.artifact.path}`,
        content: artifactTexts.get(phase.id)!,
      })),
      { path: ".agent-team/handovers/.gitkeep", content: "" },
      ...catalogue.map((agent) => ({
        path: `.codex/agents/${agent.id}.md`,
        content: renderAgentInstruction(agent),
      })),
      ...(preserveCodexKeep ? [] : [{ path: ".codex/generated/.gitkeep", content: "" }]),
    ], makeAuditEvent(id, "init", options.id, options.profile, {
      authorizationSource: "bootstrap",
    }));
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

async function pluginInvocations(store: ProjectStore): Promise<PluginInvocationList> {
  return store.readYaml(".agent-team/plugin-invocations.yaml", PluginInvocationListSchema);
}

async function artifactRegistry(store: ProjectStore) {
  return store.readYaml(".agent-team/artifact-registry.yaml", ArtifactRegistrySchema);
}

async function executionEvidenceContext(store: ProjectStore) {
  const [registry, reviews, approvals] = await Promise.all([
    artifactRegistry(store),
    store.readYaml(".agent-team/reviews.yaml", ReviewListSchema),
    store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
  ]);
  return { artifacts: registry.artifacts, reviews: reviews.reviews, approvals: approvals.approvals };
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
  options: {
    actor?: AuditEvent["actor"];
    authorizationSource?: string;
    artifactVersions?: Record<string, number>;
    adapterId?: string;
    result?: AuditEvent["result"];
  } = {},
): Promise<void> {
  const { project } = await projectConfig(store);
  await store.appendAuditOnce(makeAuditEvent(id, action, target, project.profile, options));
}

function makeAuditEvent(
  id: string,
  action: string,
  target: string,
  permissionProfile: string,
  options: {
    actor?: AuditEvent["actor"];
    authorizationSource?: string;
    artifactVersions?: Record<string, number>;
    adapterId?: string;
    result?: AuditEvent["result"];
  } = {},
): AuditEvent {
  const actor = options.actor ?? { type: "system" as const, identifier: "system-design-team" };
  return AuditEventSchema.parse({
    id,
    action,
    target,
    actor,
    authorization_source: options.authorizationSource ?? "workflow",
    ...(actor.type === "agent" ? { agent_id: actor.identifier } : {}),
    ...(options.adapterId ? { adapter_id: options.adapterId } : {}),
    permission_profile: permissionProfile,
    artifact_versions: options.artifactVersions ?? {},
    result: options.result ?? "success",
    timestamp: new Date().toISOString(),
  });
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
  const id = operationKey("plugin", uri, JSON.stringify([status, skills]));
  const { project } = await projectConfig(store);
  await store.transaction(id, [
    { path: ".agent-team/plugin-status.yaml", content: stringify(next) },
  ], makeAuditEvent(id, "plugin", uri, project.profile, {
    authorizationSource: "operator",
    adapterId: uri,
  }));
  return next;
  });
}

function capabilityError(report: Awaited<ReturnType<PluginRegistry["checkCurrent"]>>): Error | undefined {
  const blocker = report.blockers[0];
  return blocker
    ? new Error(`${blocker.code}: ${blocker.uri}${blocker.skill ? ` (${blocker.skill})` : ""}`)
    : undefined;
}

async function requireCurrentCapabilities(
  manifest: AgentManifest,
  adapter?: PluginAdapter,
): Promise<void> {
  if (!adapter) throw new Error("PLUGIN_ADAPTER_REQUIRED");
  const error = capabilityError(await new PluginRegistry([]).checkCurrent(manifest, adapter));
  if (error) throw error;
}

export async function invokePlugin(
  root: string,
  adapter: PluginAdapter,
  request: Omit<PluginInvocationRequest, "operation_id">,
  operationId: string,
): Promise<VerifiedPluginInvocation> {
  requireOperationId(operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const id = operationKey("plugin-invocation", request.plugin_uri, operationId);
    const current = await pluginInvocations(store);
    const existing = current.invocations.find((invocation) =>
      invocation.plugin_uri === request.plugin_uri && invocation.operation_id === operationId);
    if (existing) {
      if (existing.skill !== request.skill
        || existing.input_digest !== pluginInvocationDigest(request.input)) {
        throw new Error("OPERATION_ID_CONFLICT");
      }
      await appendOperationAudit(store, id, "plugin-invocation", request.plugin_uri, {
        authorizationSource: "runtime-adapter",
        adapterId: request.plugin_uri,
      });
      return { evidence: existing, output: undefined };
    }
    let result: VerifiedPluginInvocation;
    try {
      result = await new PluginRegistry([]).invoke(adapter, { ...request, operation_id: operationId });
    } catch (error) {
      await appendOperationAudit(
        store,
        operationKey("plugin-invocation-failure", request.plugin_uri, operationId),
        "plugin-invocation",
        request.plugin_uri,
        {
          authorizationSource: "runtime-adapter",
          adapterId: request.plugin_uri,
          result: "failure",
        },
      );
      throw error;
    }
    const next = PluginInvocationListSchema.parse({
      invocations: [...current.invocations, result.evidence],
    });
    const { project } = await projectConfig(store);
    await store.transaction(id, [
      { path: ".agent-team/plugin-invocations.yaml", content: stringify(next) },
    ], makeAuditEvent(id, "plugin-invocation", request.plugin_uri, project.profile, {
      authorizationSource: "runtime-adapter",
      adapterId: request.plugin_uri,
    }));
    return result;
  });
}

export async function startPhase(
  root: string,
  phase: string,
  operationId: string,
  adapter?: PluginAdapter,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const scopedOperation = operationKey("start", phase, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
  const state = await store.readWorkflowState();
  const workflow = await configuredWorkflow(store);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const registry = await artifactRegistry(store);
  const inputIds = new Set(definition.depends_on.map((dependency) =>
    workflow.phases.find((candidate) => candidate.id === dependency)!.artifact.id));
  if ((await inspectArtifacts(root, registry.artifacts.filter(({ id }) => inputIds.has(id)))).length > 0) {
    throw new Error("APPROVED_INPUT_STALE");
  }
  const owner = (await readCatalogue()).find((agent) => agent.id === definition.owner);
  if (!owner) throw new Error(`AGENT_NOT_CONFIGURED: ${definition.owner}`);
  await requireCurrentCapabilities(owner, adapter);
  if (state.completed_operations.includes(scopedOperation)) {
    await appendOperationAudit(store, scopedOperation, "start", phase);
    return state;
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

async function inspectArtifacts(
  root: string,
  artifacts: readonly ArtifactRecord[],
  requireReviewReady = true,
) {
  const findings: { artifact_id?: string; code: string; message: string }[] = [];
  for (const artifact of artifacts) {
    if (requireReviewReady && !reviewReadyStatuses.has(artifact.status)) {
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
      if (artifactChecksum(text) !== artifact.checksum) {
        findings.push({
          artifact_id: artifact.id,
          code: "ARTIFACT_CHECKSUM_MISMATCH",
          message: `${artifact.id} content does not match its registered checksum`,
        });
      }
      if (requireReviewReady && !reviewReadyStatuses.has(status)) {
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

export async function artifactList(root: string): Promise<ArtifactRecord[]> {
  return [...(await artifactRegistry(ProjectStore.open(root))).artifacts]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function artifactInspect(root: string, id: string) {
  const artifact = (await artifactRegistry(ProjectStore.open(root))).artifacts
    .find((candidate) => candidate.id === id);
  if (!artifact) throw new Error("ARTIFACT_NOT_FOUND");
  return { ...artifact, checksum_valid: artifactChecksum(await readArtifact(root, artifact)) === artifact.checksum };
}

export async function artifactValidate(root: string, id: string) {
  const registry = await artifactRegistry(ProjectStore.open(root));
  const artifact = registry.artifacts.find((candidate) => candidate.id === id);
  if (!artifact) throw new Error("ARTIFACT_NOT_FOUND");
  const findings = await inspectArtifacts(root, [artifact], false);
  return { artifact_id: id, valid: findings.length === 0, findings };
}

async function traceabilityDocument(store: ProjectStore) {
  return store.readYaml(".agent-team/traceability.yaml", TraceabilityDocumentSchema);
}

export async function traceCheck(root: string) {
  const document = await traceabilityDocument(ProjectStore.open(root));
  const findings = validateTraceability(document.nodes, document.links);
  return { valid: findings.length === 0, findings };
}

export async function traceCoverageReport(root: string) {
  const document = await traceabilityDocument(ProjectStore.open(root));
  return traceCoverage(document.nodes, document.links);
}

export async function staleList(root: string): Promise<ArtifactRecord[]> {
  return (await artifactList(root)).filter(({ status }) => status === "stale");
}

export async function createChange(
  root: string,
  input: ChangeRequest,
  operationId: string,
) {
  requireOperationId(operationId);
  const change = ChangeRequestSchema.parse(input);
  const scopedOperation = operationKey("change", change.id, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const [state, workflow, registry, approvals, traceability] = await Promise.all([
      store.readWorkflowState(),
      configuredWorkflow(store),
      artifactRegistry(store),
      store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
      traceabilityDocument(store),
    ]);
    const artifactIds = new Set(registry.artifacts.map(({ id }) => id));
    if (change.affected_artifacts.some((id) => !artifactIds.has(id))) {
      throw new Error("ARTIFACT_NOT_FOUND");
    }
    const staleArtifacts = [...new Set([
      ...change.affected_artifacts,
      ...propagateStaleness(change.affected_artifacts, traceability.links),
    ])].filter((id) => artifactIds.has(id)).sort();
    if (state.completed_operations.includes(scopedOperation)) {
      const stored = await store.readYaml(`.agent-team/changes/${change.id}.yaml`, ChangeRequestSchema);
      if (JSON.stringify(stored) !== JSON.stringify(change)) throw new Error("OPERATION_ID_CONFLICT");
      await appendOperationAudit(store, scopedOperation, "change", change.id);
      return { change: stored, stale_artifacts: staleArtifacts };
    }

    const staleIds = new Set(staleArtifacts);
    const stalePhases = new Set(workflow.phases
      .filter(({ artifact }) => staleIds.has(artifact.id))
      .map(({ id }) => id));
    const invalidatedApprovalIds = new Set(approvals.approvals
      .filter((approval) => (Object.keys(approval.artifact_versions).some((id) => staleIds.has(id))
        || change.required_reapprovals.includes(approval.gate))
        && (approval.decision === "approved" || approval.decision === "approved_with_conditions"))
      .map(({ id }) => id));
    const reopenedPhases = new Set([
      ...stalePhases,
      ...workflow.phases
        .filter(({ id }) => invalidatedApprovalIds.has(state.phases[id]?.approval_id ?? ""))
        .map(({ id }) => id),
    ]);
    const nextRegistry = ArtifactRegistrySchema.parse({
      artifacts: registry.artifacts.map((artifact) =>
        staleIds.has(artifact.id) ? { ...artifact, status: "stale" } : artifact),
    });
    const nextApprovals = ApprovalListSchema.parse({
      approvals: approvals.approvals.map((approval) =>
        invalidatedApprovalIds.has(approval.id)
          ? { ...approval, decision: "revoked" }
          : approval),
    });
    const nextTraceability = TraceabilityDocumentSchema.parse({
      ...traceability,
      nodes: traceability.nodes.map((node) =>
        staleIds.has(node.id) ? { ...node, status: "stale" } : node),
    });

    const nextState = WorkflowStateSchema.parse({
      ...state,
      state_version: state.state_version + 1,
      current_phase: workflow.phases.find(({ id }) => reopenedPhases.has(id))?.id ?? state.current_phase,
      completed_operations: [...state.completed_operations, scopedOperation],
      phases: Object.fromEntries(Object.entries(state.phases).map(([id, phaseState]) => {
        if (!reopenedPhases.has(id)) return [id, phaseState];
        const {
          review_id: _reviewId,
          approval_id: _approvalId,
          handover_id: _handoverId,
          handover_digest: _handoverDigest,
          ...reopened
        } = phaseState;
        return [id, { ...reopened, status: "revision_required" }];
      })),
    });
    const { project } = await projectConfig(store);
    await store.transaction(scopedOperation, [
      { path: `.agent-team/changes/${change.id}.yaml`, content: stringify(change) },
      { path: ".agent-team/artifact-registry.yaml", content: stringify(nextRegistry) },
      { path: ".agent-team/approvals.yaml", content: stringify(nextApprovals) },
      { path: ".agent-team/traceability.yaml", content: stringify(nextTraceability) },
      { path: ".agent-team/workflow-state.yaml", content: stringify(nextState) },
    ], makeAuditEvent(scopedOperation, "change", change.id, project.profile, {
      actor: { type: "human", identifier: change.requested_by },
      authorizationSource: "change_request",
      artifactVersions: Object.fromEntries(registry.artifacts
        .filter(({ id }) => staleIds.has(id)).map(({ id, version }) => [id, version])),
    }));
    return { change, stale_artifacts: staleArtifacts };
  });
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
  adapter?: PluginAdapter,
  execution?: AgentExecutionResult,
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
  if (definition.gate === "G7" || definition.gate === "G8") {
    if (!execution) throw new Error("REVIEW_EXECUTION_REQUIRED");
    const report = evaluateExecutionResult(execution, "G7", {
      artifacts: registry.artifacts,
      reviews: reviews.reviews,
      approvals: (await store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema)).approvals,
    });
    if (!report.allowed) throw new Error(report.blockers[0]);
  }
  const existing = reviews.reviews.find((review) => review.id === evidenceId);
  if (state.completed_operations.includes(verdictId)) {
    if (!existing) throw new Error("REVIEW_EVIDENCE_MISSING");
    if (existing.phase !== phase || existing.reviewer !== reviewerId || existing.verdict !== verdict) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
    const reviewerManifest = (await readCatalogue()).find((agent) => agent.id === reviewerId);
    if (!reviewerManifest) throw new Error("REVIEWER_NOT_CONFIGURED");
    await requireCurrentCapabilities(reviewerManifest, adapter);
    if (state.phases[phase]?.review_id !== existing.id) throw new Error("REVIEW_EVIDENCE_MISSING");
    const replayDefinition = workflow.phases.find((candidate) => candidate.id === phase);
    const [finding] = await inspectArtifacts(root, registry.artifacts.filter((artifact) =>
      artifact.owner === replayDefinition?.owner && artifact.required_gate === replayDefinition.gate));
    if (finding) throw new Error(`${finding.code}: ${finding.message}`);
    await appendOperationAudit(store, evidenceId, "review", phase);
    return state;
  }
  if (!reviewerId || reviewerId !== definition.reviewer || reviewerId === definition.owner) {
    throw new Error("REVIEWER_NOT_CONFIGURED");
  }
  const reviewerManifest = (await readCatalogue()).find((agent) => agent.id === reviewerId);
  if (!reviewerManifest) throw new Error("REVIEWER_NOT_CONFIGURED");
  await requireCurrentCapabilities(reviewerManifest, adapter);
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
  const nextReviews = ReviewListSchema.parse({
    reviews: existing ? reviews.reviews : [...reviews.reviews, review],
  });
  const { project } = await projectConfig(store);
  await store.transaction(evidenceId, [
    { path: ".agent-team/reviews.yaml", content: stringify(nextReviews) },
    { path: ".agent-team/workflow-state.yaml", content: stringify(preview) },
  ], makeAuditEvent(evidenceId, "review", phase, project.profile, {
    actor: { type: "agent", identifier: reviewerId },
    authorizationSource: "agent_manifest",
    artifactVersions: review.artifact_versions,
  }));
  return preview;
  });
}

export async function approve(
  root: string,
  gate: GateId,
  by: string,
  operationId: string,
  execution?: AgentExecutionResult,
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
    const [finding] = await inspectArtifacts(root, registry.artifacts.filter((artifact) =>
      artifact.required_gate === gate));
    if (finding) throw new Error(`${finding.code}: ${finding.message}`);
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

  const nextApprovals = ApprovalListSchema.parse({
    approvals: existing ? approvals.approvals : [...approvals.approvals, approval],
  });
  const nextState = approveGate(state, workflow, approval, execution, {
    artifacts: registry.artifacts,
    reviews: reviews.reviews,
    approvals: approvals.approvals,
  });
  const { project } = await projectConfig(store);
  await store.transaction(scopedOperation, [
    { path: ".agent-team/approvals.yaml", content: stringify(nextApprovals) },
    { path: ".agent-team/workflow-state.yaml", content: stringify(nextState) },
  ], makeAuditEvent(scopedOperation, "approve", gate, project.profile, {
    actor: { type: "human", identifier: approver },
    authorizationSource: "gate_policy",
    artifactVersions: versions,
  }));
  return nextState;
  });
}

export async function rejectGate(
  root: string,
  gate: GateId,
  by: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const actor = by.trim();
  if (!actor) throw new Error("APPROVER_REQUIRED");
  const scopedOperation = operationKey("reject", gate, operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const [state, workflow, approvals, registry] = await Promise.all([
      store.readWorkflowState(),
      configuredWorkflow(store),
      store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
      artifactRegistry(store),
    ]);
    const existing = approvals.approvals.find(({ id }) => id === scopedOperation);
    if (state.completed_operations.includes(scopedOperation)) {
      if (!existing || existing.gate !== gate || existing.decision !== "rejected"
        || existing.approved_by.identifier !== actor) throw new Error("OPERATION_ID_CONFLICT");
      await appendOperationAudit(store, scopedOperation, "reject", gate);
      return state;
    }
    const definition = workflow.phases.find((phase) =>
      phase.gate === gate && state.phases[phase.id]?.status === "awaiting_approval");
    if (!definition) throw new Error("INVALID_APPROVAL_STATE");
    const versions = artifactVersions(registry.artifacts.filter((artifact) =>
      artifact.required_gate === gate && artifact.owner === definition.owner));
    const rejection = ApprovalRecordSchema.parse({
      id: scopedOperation,
      gate,
      decision: "rejected",
      approved_by: { type: "human", identifier: actor },
      artifact_versions: versions,
      timestamp: new Date().toISOString(),
    });
    const nextState = rejectWorkflowGate(state, workflow, rejection);
    const nextApprovals = ApprovalListSchema.parse({ approvals: [...approvals.approvals, rejection] });
    const { project } = await projectConfig(store);
    await store.transaction(scopedOperation, [
      { path: ".agent-team/approvals.yaml", content: stringify(nextApprovals) },
      { path: ".agent-team/workflow-state.yaml", content: stringify(nextState) },
    ], makeAuditEvent(scopedOperation, "reject", gate, project.profile, {
      actor: { type: "human", identifier: actor },
      authorizationSource: "gate_policy",
      artifactVersions: versions,
    }));
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
    const [approvals, registry] = await Promise.all([
      store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
      artifactRegistry(store),
    ]);
    const approval = approvals.approvals.find((candidate) => candidate.id === phaseState.approval_id);
    if ((await inspectArtifacts(root, registry.artifacts.filter((artifact) =>
      artifact.required_gate === definition.gate && artifact.owner === definition.owner))).length > 0) {
      throw new Error("APPROVED_INPUT_STALE");
    }
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
    state = transitionPhase(withId, workflow, {
      phase,
      to: "handed_over",
      operation_id: scopedOperation,
    });
    for (const dependent of dependents) {
      const readinessId = operationKey("handover-ready", `${phase}->${dependent.id}`, operationId);
      if (!state.completed_operations.includes(readinessId)) {
        state = transitionPhase(state, workflow, {
          phase: dependent.id,
          to: "ready",
          operation_id: readinessId,
        });
      }
    }
    const { project } = await projectConfig(store);
    await store.transaction(scopedOperation, [
      { path: relativeRecord, content: stringify(proposed) },
      { path: ".agent-team/workflow-state.yaml", content: stringify(state) },
    ], makeAuditEvent(scopedOperation, "handover", phase, project.profile, {
      actor: { type: "agent", identifier: definition.owner },
      authorizationSource: "approved_gate",
      artifactVersions: approval.artifact_versions,
    }));
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
  await appendOperationAudit(store, scopedOperation, "handover", phase, {
    actor: { type: "agent", identifier: definition.owner },
    authorizationSource: "approved_gate",
  });
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

export async function gateReadinessReport(root: string, gate: GateId, execution?: AgentExecutionResult) {
  const store = ProjectStore.open(root);
  const [state, workflow, context] = await Promise.all([
    store.readWorkflowState(),
    configuredWorkflow(store),
    executionEvidenceContext(store),
  ]);
  return gateReadiness(state, workflow, gate, execution, context);
}

export async function loadExecutionResult(root: string, reference: string): Promise<AgentExecutionResult> {
  if (!reference || isAbsolute(reference) || reference.includes("\\")
    || reference.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("PATH_OUTSIDE_PROJECT");
  }
  const projectRoot = await realpath(root);
  const target = resolve(projectRoot, reference);
  if (!inside(projectRoot, target)) throw new Error("PATH_OUTSIDE_PROJECT");
  await execFileAsync("git", ["ls-files", "--error-unmatch", "--", reference], { cwd: projectRoot })
    .catch(() => { throw new Error("EXECUTION_EVIDENCE_NOT_TRACKED"); });
  const actual = await realpath(target);
  if (!inside(projectRoot, actual)) throw new Error("PATH_OUTSIDE_PROJECT");
  let value: unknown;
  try {
    value = parse(await readFile(actual, "utf8"));
  } catch {
    throw new Error("EXECUTION_RESULT_INVALID");
  }
  const result = AgentExecutionResultSchema.safeParse(value);
  if (!result.success) throw new Error("EXECUTION_RESULT_INVALID");
  return result.data;
}

export async function secretsScan(root: string) {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root }));
  } catch {
    throw new Error("GIT_REQUIRED");
  }
  // ponytail: deterministic signatures only; use a dedicated scanner when one is adopted.
  const secrets = [
    /\b(?:api[_-]?key|secret|token|password|cookie|session[_-]?(?:id|token))\b\s*[:=]\s*["']?[^\s"']{8,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|sqlserver):\/\/[^\s:@]+:[^\s@]+@/i,
    /\b(?:AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|GOOGLE_API_KEY)\s*=/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bAIza[A-Za-z0-9_-]{30,}\b/,
  ];
  const findings: { path: string; line: number; code: string }[] = [];
  for (const path of stdout.split("\0").filter(Boolean).sort()) {
    let content: string;
    try {
      content = await readFile(join(root, path), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const index = lines.findIndex((line) => secrets.some((secret) => secret.test(line)));
    if (index >= 0) findings.push({ path, line: index + 1, code: "POSSIBLE_SECRET" });
  }
  return { valid: findings.length === 0, findings };
}

export async function diagnostics(root: string) {
  return doctor(root);
}

export async function issueList(root: string) {
  const report = await doctor(root);
  return {
    issues: report.checks.filter(({ ok }) => !ok).map(({ name, detail }) => ({
      code: name.toUpperCase(),
      detail,
    })),
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
  const repaired = (await store.repairTransactions()).map((id) => `transaction:${id}`);
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
    const transactions = await store.inspectTransactions();
    checks.push({
      name: "transactions",
      ok: transactions.length === 0,
      detail: transactions.length === 0 ? "none pending" : `${transactions.length} pending; run repair --locks --yes`,
    });
  } catch (error) {
    checks.push({ name: "transactions", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
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
