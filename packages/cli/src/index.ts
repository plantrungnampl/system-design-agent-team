import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateReviewReadyArtifact } from "@system-design-team/artifact-validator";
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
  WorkflowDefinitionSchema,
  WorkflowStateSchema,
  type AgentManifest,
  type ArtifactRecord,
  type GateId,
  type PluginStatusRecord,
  type ProjectConfig,
  type ProjectMode,
  type ProjectProfile,
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
    await access(path);
    return true;
  } catch {
    return false;
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

export async function initProject(root: string, options: InitOptions): Promise<ProjectConfig> {
  const projectRoot = resolve(root);
  if (await exists(join(projectRoot, ".agent-team/project.yaml"))) {
    throw new Error("ALREADY_INITIALIZED");
  }

  const workflow = await readWorkflow(options.mode);
  const catalogue = await readCatalogue();
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

  for (const directory of ["context", "requirements", "product", "handovers"]) {
    await mkdir(join(projectRoot, ".agent-team", directory), { recursive: true });
  }
  await mkdir(join(projectRoot, ".codex/generated"), { recursive: true });

  const store = ProjectStore.open(projectRoot);
  await store.writeYamlAtomic(".agent-team/project.yaml", project);
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  await store.writeYamlAtomic(".agent-team/plugin-status.yaml", plugins);
  await store.writeYamlAtomic(".agent-team/approvals.yaml", approvals);
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeYamlAtomic(".agent-team/framework-lock.yaml", lock);
  await writeFile(
    join(projectRoot, ".agent-team/context/project-charter.md"),
    await readFile(join(assetsRoot, "templates/project-charter.md")),
    { flag: "wx" },
  );
  await writeFile(
    join(projectRoot, ".agent-team/requirements/requirements.md"),
    await readFile(join(assetsRoot, "templates/requirements.md")),
    { flag: "wx" },
  );
  return project;
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
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  if (state.completed_operations.includes(operationId)) return state;

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
    { phase, to: "in_progress", operation_id: operationId },
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

export async function validatePhase(root: string, phase: string, operationId: string) {
  requireOperationId(operationId);
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  if (state.completed_operations.includes(operationId)) {
    return { valid: true, phase, findings: [], state };
  }
  const workflow = await configuredWorkflow(store);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const artifacts = (await artifactRegistry(store)).artifacts.filter(
    (artifact) => artifact.owner === definition.owner && artifact.required_gate === definition.gate,
  );
  const findings: { artifact_id?: string; code: string; message: string }[] = [];
  if (artifacts.length === 0) {
    findings.push({ code: "NO_REGISTERED_ARTIFACTS", message: `No artifacts registered for ${phase}` });
  }
  for (const artifact of artifacts) {
    try {
      const validation = validateReviewReadyArtifact(await readArtifact(root, artifact));
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
  if (findings.length > 0) return { valid: false, phase, findings, state };

  const next = await store.updateWorkflowState(state.state_version, (current) => transitionPhase(
    current,
    workflow,
    { phase, to: "artifact_validation", operation_id: operationId },
  ));
  return { valid: true, phase, findings, state: next };
}

function artifactVersions(artifacts: readonly ArtifactRecord[]): Record<string, number> {
  return Object.fromEntries(
    [...artifacts].sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => [artifact.id, artifact.version]),
  );
}

export async function approve(
  root: string,
  gate: GateId,
  by: string,
  operationId: string,
): Promise<WorkflowState> {
  requireOperationId(operationId);
  if (!by.trim()) throw new Error("APPROVER_REQUIRED");
  const store = ProjectStore.open(root);
  const [state, workflow, approvals, registry] = await Promise.all([
    store.readWorkflowState(),
    configuredWorkflow(store),
    store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
    artifactRegistry(store),
  ]);
  const existing = approvals.approvals.find((approval) => approval.id === operationId);
  if (state.completed_operations.includes(operationId)) {
    if (!existing) throw new Error("APPROVAL_EVIDENCE_MISSING");
    return state;
  }

  const definition = workflow.phases.find(
    (phase) => phase.gate === gate && state.phases[phase.id]?.status === "awaiting_approval",
  );
  if (!definition) throw new Error("INVALID_APPROVAL_STATE");
  const versions = artifactVersions(registry.artifacts.filter(
    (artifact) => artifact.required_gate === gate && artifact.owner === definition.owner,
  ));
  if (Object.keys(versions).length === 0) throw new Error("APPROVAL_ARTIFACTS_REQUIRED");
  const expected = {
    id: operationId,
    gate,
    decision: "approved" as const,
    approved_by: { type: "human" as const, identifier: by },
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
  const store = ProjectStore.open(root);
  const workflow = await configuredWorkflow(store);
  const definition = workflow.phases.find((candidate) => candidate.id === phase);
  if (!definition) throw new Error("PHASE_NOT_CONFIGURED");
  const dependents = workflow.phases.filter((candidate) => candidate.depends_on.includes(phase));
  const target = dependents[0];
  if (!target) throw new Error("HANDOVER_TARGET_REQUIRED");
  const registry = await artifactRegistry(store);
  const proposed = HandoverRecordSchema.parse({
    from_agent: definition.owner,
    to_agent: target.owner,
    approved_inputs: Object.entries(artifactVersions(registry.artifacts.filter(
      (artifact) => artifact.required_gate === definition.gate && artifact.owner === definition.owner,
    ))).map(([id, version]) => `${id}@${version}`),
    expected_outputs: registry.artifacts.filter((artifact) => artifact.owner === target.owner)
      .map((artifact) => artifact.id).sort(),
    acceptance_conditions: ["Dependent work uses only the approved input versions."],
  });
  const relativeRecord = `.agent-team/handovers/${phase}.yaml`;
  const recordExists = await exists(join(resolve(root), relativeRecord));
  if (recordExists) {
    const current = await store.readYaml(relativeRecord, HandoverRecordSchema);
    if (current.from_agent !== proposed.from_agent || current.to_agent !== proposed.to_agent) {
      throw new Error("HANDOVER_EVIDENCE_CONFLICT");
    }
  }

  let state = await store.readWorkflowState();
  if (!state.completed_operations.includes(operationId)) {
    const phaseState = state.phases[phase];
    if (!phaseState || phaseState.status !== "approved") throw new Error("INVALID_HANDOVER_STATE");
    const withId: WorkflowState = {
      ...state,
      phases: {
        ...state.phases,
        [phase]: { ...phaseState, handover_id: operationId },
      },
    };
    transitionPhase(withId, workflow, {
      phase,
      to: "handed_over",
      operation_id: operationId,
    });
    if (!recordExists) await store.writeYamlAtomic(relativeRecord, proposed);
    state = await store.updateWorkflowState(state.state_version, (current) => {
      const currentPhase = current.phases[phase];
      if (!currentPhase) throw new Error("INVALID_HANDOVER_STATE");
      return transitionPhase({
        ...current,
        phases: {
          ...current.phases,
          [phase]: { ...currentPhase, handover_id: operationId },
        },
      }, workflow, {
        phase,
        to: "handed_over",
        operation_id: operationId,
      });
    });
  } else if (!recordExists) {
    throw new Error("HANDOVER_EVIDENCE_MISSING");
  }

  for (const dependent of dependents) {
    const readinessId = `${operationId}:ready:${dependent.id}`;
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
    const plugins = await pluginStatus(store);
    const unavailable = plugins.plugins.filter((plugin) => plugin.status !== "available");
    checks.push({
      name: "plugins",
      ok: unavailable.length === 0,
      detail: unavailable.length === 0
        ? "available"
        : unavailable.map((plugin) => `${plugin.uri}:${plugin.status}`).join(","),
    });
  } catch (error) {
    checks.push({ name: "plugins", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
