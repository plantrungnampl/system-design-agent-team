import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArtifact, validateReviewReadyArtifact } from "@system-design-team/artifact-validator";
import {
  AgentInputContractJsonSchema,
  AgentManifestSchema,
  AgentOutputContractJsonSchema,
  AgentReviewChecklistSchema,
  AuditEventSchema,
  ApprovalListSchema,
  ApprovalRecordSchema,
  ArtifactRegistrySchema,
  ChangeRequestSchema,
  FRAMEWORK_VERSION,
  FrameworkLockSchema,
  GlossarySchema,
  ExecutionReceiptListSchema,
  ExecutionReceiptSchema,
  EjectOperationSchema,
  PreparedExecutionRequestListSchema,
  PreparedExecutionRequestSchema,
  HandoverRecordSchema,
  InstallationManifestSchema,
  InstallationOperationSchema,
  PluginInvocationListSchema,
  PluginStatusListSchema,
  ProjectConfigSchema,
  ReviewListSchema,
  ReviewRecordSchema,
  ReviewVerdictSchema,
  RepositoryInventorySchema,
  TraceabilityDocumentSchema,
  UninstallPlanSchema,
  WorkflowDefinitionSchema,
  WorkflowStateSchema,
  type AgentManifest,
  type AgentExecutionResult,
  type ExecutionReceipt,
  type ExecutionReceiptList,
  type PreparedExecutionRequest,
  type PreparedExecutionRequestList,
  type AuditEvent,
  type ArtifactRecord,
  type ChangeRequest,
  type GateId,
  type HandoverRecord,
  type PluginInvocationList,
  type PluginStatusRecord,
  type ProjectConfig,
  type EnvironmentOverlay,
  type LifecycleAuthorization,
  type RepositoryInventory,
  type ProjectMode,
  type ProjectProfile,
  type ReviewVerdict,
  type WorkflowDefinition,
  type WorkflowState,
} from "@system-design-team/core";
import { ManualCodexAdapter, type PreparedExecution } from "@system-design-team/codex-adapter";
import {
  PluginRegistry,
  pluginInvocationDigest,
  type PluginAdapter,
  type PluginInvocationRequest,
  type VerifiedPluginInvocation,
} from "@system-design-team/plugin-registry";
import {
  GENERATED_LOCK_PATHS,
  ProjectStore,
  type TransactionFaultPoint,
} from "@system-design-team/project-store";
import { inspectCache, rebuildCache } from "@system-design-team/sqlite-cache";
import { propagateStaleness, traceCoverage, validateTraceability } from "@system-design-team/traceability";
import {
  approveGate,
  evaluateExecutionResult,
  evaluateReviewExecutionResult,
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
  language?: string;
  adapter?: "codex";
  cache?: "none" | "sqlite";
  environments?: Record<string, EnvironmentOverlay>;
}

export interface AdoptOptions extends Omit<InitOptions, "mode"> {}

export type UpgradeMode = "check" | "dry-run";

export interface LifecycleAuthorizationInput {
  actor: LifecycleAuthorization["actor"];
  authorizationSource: string;
}

interface BootstrapExecutionOptions {
  transactionFault?: (point: TransactionFaultPoint) => void;
}

interface BootstrapContext {
  action: "init" | "adopt";
  operationId: string;
  authorization: LifecycleAuthorizationInput;
  inventory?: RepositoryInventory;
}

const assetsRoot = join(dirname(fileURLToPath(import.meta.url)), "assets");
const execFileAsync = promisify(execFile);
const workflowFiles: Record<ProjectMode, string> = {
  greenfield: "greenfield.yaml",
  existing_system: "existing-system.yaml",
  migration: "migration.yaml",
};

const apiAuthorization: LifecycleAuthorizationInput = {
  actor: { type: "system", identifier: "system-design-team-api" },
  authorizationSource: "api_invocation",
};

function runGit(root: string, args: readonly string[]) {
  return execFileAsync("git", [...args], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function persistedAuthorization(input: LifecycleAuthorizationInput): LifecycleAuthorization {
  return {
    actor: input.actor,
    authorization_source: input.authorizationSource,
  };
}

const humanApprovals = {
  business_scope: "human_required" as const,
  requirements: "human_required" as const,
  product_backlog: "human_required" as const,
  ux: "human_required" as const,
  architecture: "human_required" as const,
  implementation_plan: "human_required" as const,
  release_candidate: "human_required" as const,
  production_deployment: "human_required" as const,
};

function profileSecurity(profile: ProjectProfile) {
  if (profile === "regulated") return "restricted" as const;
  if (profile === "enterprise") return "confidential" as const;
  return "internal" as const;
}

const classificationLevel = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;

function applyOverlay(config: ProjectConfig, overlay: EnvironmentOverlay): ProjectConfig {
  if (overlay.security?.classification
    && classificationLevel[overlay.security.classification]
      < classificationLevel[config.security.classification]) {
    throw new Error("CLASSIFICATION_DOWNGRADE_NOT_ALLOWED");
  }
  return ProjectConfigSchema.parse({
    ...config,
    adapter: { ...config.adapter, ...overlay.adapter },
    approvals: { ...config.approvals, ...overlay.approvals },
    plugins: { ...config.plugins, ...overlay.plugins },
    cache: overlay.cache
      ? overlay.cache.provider === config.cache.provider
        ? { ...config.cache, ...overlay.cache }
        : overlay.cache
      : config.cache,
    security: { ...config.security, ...overlay.security },
  });
}

export function resolveProjectConfig(
  input: ProjectConfig,
  environment?: string,
  explicit: EnvironmentOverlay = {},
): ProjectConfig {
  const config = ProjectConfigSchema.parse(input);
  const environmentOverlay = environment ? config.environments[environment] : undefined;
  if (environment && !environmentOverlay) throw new Error("ENVIRONMENT_NOT_CONFIGURED");
  return applyOverlay(environmentOverlay ? applyOverlay(config, environmentOverlay) : config, explicit);
}

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

function renderAgentContractFiles(agent: AgentManifest) {
  const base = `.codex/agents/${agent.id}`;
  const checklist = AgentReviewChecklistSchema.parse({
    agent: agent.id,
    reviewer: agent.reviewer,
    checks: [
      `Verify the result satisfies the ${agent.display_name} mission.`,
      ...agent.outputs.map((output) => `Verify required output: ${output}.`),
      ...agent.authority.may_not.map((boundary) => `Verify prohibited action was not taken: ${boundary}.`),
      ...agent.required_plugins.map((plugin) => `Verify runtime evidence for ${plugin.uri}.`),
    ],
    verdicts: ["approved", "revision_required"],
  });
  return [
    { path: `${base}/agent.yaml`, content: stringify(agent) },
    { path: `${base}/instructions.md`, content: renderAgentInstruction(agent) },
    {
      path: `${base}/input-contract.schema.json`,
      content: `${JSON.stringify(AgentInputContractJsonSchema, null, 2)}\n`,
    },
    {
      path: `${base}/output-contract.schema.json`,
      content: `${JSON.stringify(AgentOutputContractJsonSchema, null, 2)}\n`,
    },
    { path: `${base}/review-checklist.yaml`, content: stringify(checklist) },
  ];
}

async function bootstrapProject(
  root: string,
  options: InitOptions,
  installation: BootstrapContext,
  execution: BootstrapExecutionOptions = {},
) {
  const projectRoot = resolve(root);
  const store = ProjectStore.open(projectRoot, execution);
  return store.withLock(".system-design-team-init.lock", async () => {
  const { workflow, catalogue } = await readBootstrapAssets(options.mode);
  const project = ProjectConfigSchema.parse({
    schema_version: 1,
    project: {
      id: options.id,
      name: options.name,
      mode: options.mode,
      profile: options.profile,
      language: options.language ?? "en",
    },
    framework: { version: FRAMEWORK_VERSION, management: "managed" },
    adapter: { primary: options.adapter ?? "codex" },
    workflow: { id: workflow.id, version: workflow.version },
    approvals: humanApprovals,
    plugins: { enforcement: "strict", fallback_requires_human_approval: true },
    cache: options.cache === "sqlite"
      ? { provider: "sqlite", path: ".agent-team/cache/index.db" }
      : { provider: "none" },
    security: { classification: profileSecurity(options.profile), secret_scan: "required" },
    environments: options.environments ?? {},
  });
  const operation = InstallationOperationSchema.parse({
    schema_version: 1,
    action: installation.action,
    operation_id: installation.operationId,
    authorization: persistedAuthorization(installation.authorization),
    project,
    ...(installation.inventory ? { inventory: installation.inventory } : {}),
  });
  if (await exists(join(projectRoot, ".agent-team"))) {
    let stored;
    try {
      stored = await store.readYaml(".agent-team/installation-operation.yaml", InstallationOperationSchema);
    } catch {
      throw new Error("ALREADY_INITIALIZED");
    }
    if (stored.operation_id !== installation.operationId) throw new Error("ALREADY_INITIALIZED");
    const { inventory: _storedInventory, ...storedRequest } = stored;
    const { inventory: _requestedInventory, ...requested } = operation;
    if (JSON.stringify(storedRequest) !== JSON.stringify(requested)) throw new Error("OPERATION_ID_CONFLICT");
    return { project: stored.project, inventory: stored.inventory };
  }
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
  const executionReceipts = ExecutionReceiptListSchema.parse({ receipts: [] });
  const executionRequests = PreparedExecutionRequestListSchema.parse({ requests: [] });
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
  const contractWrites = catalogue.flatMap(renderAgentContractFiles);
  const codexAgentPaths = [
    ...catalogue.map((agent) => `.codex/agents/${agent.id}.md`),
    ...contractWrites.map(({ path }) => path),
  ];
  for (const path of codexAgentPaths) {
    if (await exists(join(projectRoot, path))) throw new Error(`CODEX_AGENT_ALREADY_EXISTS: ${path}`);
  }

  const agentWrites = catalogue.map((agent) => ({
    path: `.codex/agents/${agent.id}.md`,
    content: renderAgentInstruction(agent),
  }));
  const newAgentDirectories = (await Promise.all(catalogue.map(async (agent) => {
    const path = `.codex/agents/${agent.id}`;
    return { path, exists: await exists(join(projectRoot, path)) };
  }))).filter(({ exists }) => !exists).map(({ path }) => path);
  const generatedFiles = [
    ...agentWrites,
    ...contractWrites,
    ...(preserveCodexKeep ? [] : [{ path: ".codex/generated/.gitkeep", content: "" }]),
  ];
  const manifest = InstallationManifestSchema.parse({
    schema_version: 1,
    files: generatedFiles.map(({ path, content }) => ({
      path,
      checksum: artifactChecksum(content),
      role: "generated_adapter",
    })),
    directories_created: [
      ...(!preserveCodexRoot ? [".codex"] : []),
      ...(!preserveCodexAgents ? [".codex/agents"] : []),
      ...newAgentDirectories,
      ...(!preserveCodexGenerated ? [".codex/generated"] : []),
    ],
  });

  try {
    const id = operationKey(installation.action, options.id, installation.operationId);
    await store.transaction(id, [
      { path: ".agent-team/project.yaml", content: stringify(project) },
      { path: ".agent-team/workflow-state.yaml", content: stringify(state) },
      { path: ".agent-team/plugin-status.yaml", content: stringify(plugins) },
      { path: ".agent-team/plugin-invocations.yaml", content: stringify(pluginInvocations) },
      { path: ".agent-team/execution-receipts.yaml", content: stringify(executionReceipts) },
      { path: ".agent-team/execution-requests.yaml", content: stringify(executionRequests) },
      { path: ".agent-team/approvals.yaml", content: stringify(approvals) },
      { path: ".agent-team/reviews.yaml", content: stringify(reviews) },
      { path: ".agent-team/artifact-registry.yaml", content: stringify(registry) },
      { path: ".agent-team/traceability.yaml", content: stringify(traceability) },
      { path: ".agent-team/framework-lock.yaml", content: stringify(lock) },
      { path: ".agent-team/installation-manifest.yaml", content: stringify(manifest) },
      { path: ".agent-team/installation-operation.yaml", content: stringify(operation) },
      ...(installation.inventory ? [{
        path: ".agent-team/inventory.yaml",
        content: stringify(installation.inventory),
      }] : []),
      ...workflow.phases.map((phase) => ({
        path: `.agent-team/${phase.artifact.path}`,
        content: artifactTexts.get(phase.id)!,
      })),
      { path: ".agent-team/handovers/.gitkeep", content: "" },
      ...agentWrites,
      ...contractWrites,
      ...(preserveCodexKeep ? [] : [{ path: ".codex/generated/.gitkeep", content: "" }]),
    ], makeAuditEvent(id, installation.action, options.id, options.profile, {
      actor: installation.authorization.actor,
      authorizationSource: installation.authorization.authorizationSource,
    }));
    return { project, inventory: installation.inventory };
  } catch (error) {
    await removeNewAgentTeam(projectRoot);
    await removeGeneratedPaths(projectRoot, [
      ...codexAgentPaths,
      ...(preserveCodexKeep ? [] : [".codex/generated/.gitkeep"]),
    ]);
    for (const path of [...newAgentDirectories].reverse()) {
      await removeEmptyGeneratedDirectory(projectRoot, path);
    }
    if (!preserveCodexAgents) await removeEmptyGeneratedDirectory(projectRoot, ".codex/agents");
    if (!preserveCodexGenerated) await removeEmptyGeneratedDirectory(projectRoot, ".codex/generated");
    if (!preserveCodexRoot) await removeEmptyGeneratedDirectory(projectRoot, ".codex");
    throw error;
  }
  });
}

export async function initProject(
  root: string,
  options: InitOptions,
  operationId: string,
  authorization: LifecycleAuthorizationInput = apiAuthorization,
  execution: BootstrapExecutionOptions = {},
): Promise<ProjectConfig> {
  requireOperationId(operationId);
  return (await bootstrapProject(root, options, {
    action: "init",
    operationId,
    authorization,
  }, execution)).project;
}

const languageByExtension: Record<string, string> = {
  ".cs": "C#",
  ".go": "Go",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".mjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
};

async function repositoryInventory(root: string) {
  const projectRoot = resolve(root);
  let gitRoot: string;
  let status: string;
  let tracked: string;
  try {
    [{ stdout: gitRoot }, { stdout: status }, { stdout: tracked }] = await Promise.all([
      runGit(projectRoot, ["rev-parse", "--show-toplevel"]),
      runGit(projectRoot, ["status", "--porcelain=v1"]),
      runGit(projectRoot, ["ls-files", "-z"]),
    ]);
  } catch {
    throw new Error("GIT_REQUIRED");
  }
  let branch: string | null = null;
  try {
    branch = (await runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]))
      .stdout.trim() || null;
  } catch {
    branch = null;
  }
  const files = tracked.split("\0").filter(Boolean).sort();
  return RepositoryInventorySchema.parse({
    git: {
      root: gitRoot.trim(),
      dirty: status.trim().length > 0,
      detached: branch === null,
      branch,
      tracked_files: files.length,
    },
    languages: [...new Set(files.map((path) => languageByExtension[extname(path).toLowerCase()])
      .filter((language): language is string => language !== undefined))].sort(),
  });
}

export async function inspectProject(root: string, options: { environment?: string } = {}) {
  const projectRoot = resolve(root);
  const repository = await repositoryInventory(projectRoot);
  const installed = await exists(join(projectRoot, ".agent-team/project.yaml"));
  if (!installed) return { installed, repository };
  const project = await projectConfig(ProjectStore.open(projectRoot));
  return {
    installed,
    repository,
    configuration: resolveProjectConfig(project, options.environment),
  };
}

export async function adoptProject(
  root: string,
  options: AdoptOptions,
  operationId: string,
  authorization: LifecycleAuthorizationInput = apiAuthorization,
  execution: BootstrapExecutionOptions = {},
) {
  requireOperationId(operationId);
  const projectRoot = resolve(root);
  const inventory = await repositoryInventory(projectRoot);
  const adopted = await bootstrapProject(projectRoot, { ...options, mode: "existing_system" }, {
    action: "adopt",
    operationId,
    authorization,
    inventory,
  }, execution);
  return { project: adopted.project, inventory: adopted.inventory! };
}

async function projectConfig(store: ProjectStore): Promise<ProjectConfig> {
  return store.readYaml(".agent-team/project.yaml", ProjectConfigSchema);
}

async function configuredWorkflow(store: ProjectStore): Promise<WorkflowDefinition> {
  const project = await projectConfig(store);
  const workflow = project.framework.management === "ejected"
    ? await store.readYaml(".agent-team/overrides/workflow.yaml", WorkflowDefinitionSchema)
    : await readWorkflow(project.project.mode);
  if (workflow.id !== project.workflow.id || workflow.version !== project.workflow.version) {
    throw new Error("WORKFLOW_MISMATCH");
  }
  return workflow;
}

async function configuredCatalogue(store: ProjectStore): Promise<AgentManifest[]> {
  const project = await projectConfig(store);
  return project.framework.management === "ejected"
    ? store.readYaml(".agent-team/overrides/agents.yaml", AgentManifestSchema.array())
    : readCatalogue();
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

async function executionReceipts(store: ProjectStore): Promise<ExecutionReceiptList> {
  return store.readYaml(".agent-team/execution-receipts.yaml", ExecutionReceiptListSchema);
}

async function executionRequests(store: ProjectStore): Promise<PreparedExecutionRequestList> {
  return store.readYaml(".agent-team/execution-requests.yaml", PreparedExecutionRequestListSchema);
}

async function executionEvidenceContext(root: string, store: ProjectStore) {
  const [registry, reviews, approvals, workflow] = await Promise.all([
    artifactRegistry(store),
    store.readYaml(".agent-team/reviews.yaml", ReviewListSchema),
    store.readYaml(".agent-team/approvals.yaml", ApprovalListSchema),
    configuredWorkflow(store),
  ]);
  const verified = await Promise.all(registry.artifacts.map(async (artifact) => {
    try {
      if ((await inspectArtifacts(root, [artifact])).length > 0) return undefined;
      return [artifact.id, artifactChecksum(await readArtifact(root, artifact))] as const;
    } catch {
      return undefined;
    }
  }));
  return {
    artifacts: registry.artifacts,
    reviews: reviews.reviews,
    approvals: approvals.approvals,
    workflow,
    verified_checksums: Object.fromEntries(verified.filter((entry) => entry !== undefined)),
  };
}

function requireOperationId(operationId: string): void {
  if (!operationId?.trim()) throw new Error("OPERATION_ID_REQUIRED");
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
    executionReceiptId?: string;
    executionReceiptDigest?: string;
    executionRequestId?: string;
    executionRequestDigest?: string;
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
    executionReceiptId?: string;
    executionReceiptDigest?: string;
    executionRequestId?: string;
    executionRequestDigest?: string;
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
    ...(options.executionReceiptId ? { execution_receipt_id: options.executionReceiptId } : {}),
    ...(options.executionReceiptDigest ? { execution_receipt_digest: options.executionReceiptDigest } : {}),
    ...(options.executionRequestId ? { execution_request_id: options.executionRequestId } : {}),
    ...(options.executionRequestDigest ? { execution_request_digest: options.executionRequestDigest } : {}),
    permission_profile: permissionProfile,
    artifact_versions: options.artifactVersions ?? {},
    result: options.result ?? "success",
    timestamp: new Date().toISOString(),
  });
}

async function ensureLifecycleTransaction(
  store: ProjectStore,
  id: string,
  writes: Parameters<ProjectStore["transaction"]>[1],
  audit: AuditEvent,
): Promise<void> {
  const pending = await store.inspectTransactions();
  if (pending.length > 0) {
    if (pending.length !== 1 || pending[0] !== id) throw new Error("PENDING_TRANSACTIONS");
    await store.repairTransactions();
  }
  await store.transaction(id, writes, audit);
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

async function invokeRequiredPlugins(
  root: string,
  manifest: AgentManifest,
  phase: string,
  operationId: string,
  adapter?: PluginAdapter,
  invokeMissing = true,
): Promise<void> {
  await requireCurrentCapabilities(manifest, adapter);
  const store = ProjectStore.open(root);
  for (const requirement of manifest.required_plugins) {
    const skills = requirement.required_skills.length > 0 ? requirement.required_skills : [undefined];
    for (const skill of skills) {
      const childOperationId = operationKey(
        "lifecycle-plugin",
        requirement.uri,
        JSON.stringify([operationId, manifest.id, phase, skill ?? null]),
      );
      await invokePluginLocked(root, store, adapter!, {
        plugin_uri: requirement.uri,
        ...(skill ? { skill } : {}),
        input: { agent_id: manifest.id, phase, operation_id: operationId },
        agent_id: manifest.id,
        phase,
      }, childOperationId, invokeMissing);
    }
  }
}

async function requirePluginInvocationAudit(
  root: string,
  invocation: PluginInvocationList["invocations"][number],
): Promise<void> {
  const auditPath = join(resolve(root), ".agent-team/audit/events.jsonl");
  const auditId = operationKey("plugin-invocation", invocation.plugin_uri, invocation.operation_id);
  let audit: AuditEvent | undefined;
  try {
    const projectRoot = await realpath(root);
    if (!inside(projectRoot, await realpath(auditPath))) throw new Error("PATH_OUTSIDE_PROJECT");
    audit = (await readFile(auditPath, "utf8")).split(/\r?\n/).filter(Boolean)
      .map((line) => AuditEventSchema.parse(JSON.parse(line)))
      .find(({ id }) => id === auditId);
  } catch (error) {
    if (error instanceof Error && error.message === "PATH_OUTSIDE_PROJECT") throw error;
    throw new Error("PLUGIN_INVOCATION_AUDIT_MISSING");
  }
  if (!audit) throw new Error("PLUGIN_INVOCATION_AUDIT_MISSING");
  if (audit.action !== "plugin-invocation"
    || audit.target !== invocation.plugin_uri
    || audit.adapter_id !== invocation.plugin_uri
    || audit.result !== "success") {
    throw new Error("PLUGIN_INVOCATION_AUDIT_MISMATCH");
  }
}

async function invokePluginLocked(
  root: string,
  store: ProjectStore,
  adapter: PluginAdapter,
  request: Omit<PluginInvocationRequest, "operation_id">,
  operationId: string,
  invokeMissing: boolean,
): Promise<VerifiedPluginInvocation> {
  const id = operationKey("plugin-invocation", request.plugin_uri, operationId);
  const current = await pluginInvocations(store);
  const existing = current.invocations.find((invocation) =>
    invocation.plugin_uri === request.plugin_uri && invocation.operation_id === operationId);
  if (existing) {
    if (existing.skill !== request.skill
      || existing.agent_id !== request.agent_id
      || existing.phase !== request.phase
      || existing.input_digest !== pluginInvocationDigest(request.input)) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
    await requirePluginInvocationAudit(root, existing);
    return { evidence: existing, output: undefined };
  }
  if (!invokeMissing) throw new Error("REQUIRED_PLUGIN_INVOCATION_MISSING");
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
}

export async function invokePlugin(
  root: string,
  adapter: PluginAdapter,
  request: Omit<PluginInvocationRequest, "operation_id">,
  operationId: string,
): Promise<VerifiedPluginInvocation> {
  requireOperationId(operationId);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", () =>
    invokePluginLocked(root, store, adapter, request, operationId, true));
}

export async function startPhase(
  root: string,
  phase: string,
  operationId: string,
  adapter?: PluginAdapter,
  execution: BootstrapExecutionOptions = {},
): Promise<WorkflowState> {
  requireOperationId(operationId);
  const scopedOperation = operationKey("start", phase, operationId);
  const store = ProjectStore.open(root, execution);
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
  const owner = (await configuredCatalogue(store)).find((agent) => agent.id === definition.owner);
  if (!owner) throw new Error(`AGENT_NOT_CONFIGURED: ${definition.owner}`);
  if (state.completed_operations.includes(scopedOperation)) {
    await invokeRequiredPlugins(root, owner, phase, scopedOperation, adapter, false);
    await appendOperationAudit(store, scopedOperation, "start", phase);
    return state;
  }
  await invokeRequiredPlugins(root, owner, phase, scopedOperation, adapter);

  const next = transitionPhase(
    state,
    workflow,
    { phase, to: "in_progress", operation_id: scopedOperation },
  );
  const { project } = await projectConfig(store);
  await ensureLifecycleTransaction(store, scopedOperation, [
    { path: ".agent-team/workflow-state.yaml", content: stringify(next), expectedStateVersion: state.state_version },
  ], makeAuditEvent(scopedOperation, "start", phase, project.profile));
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

export async function glossaryValidate(root: string) {
  try {
    const glossary = await ProjectStore.open(root).readYaml(".agent-team/glossary.yaml", GlossarySchema);
    return { valid: true, entry_count: glossary.entries.length, findings: [] };
  } catch (error) {
    return {
      valid: false,
      entry_count: 0,
      findings: [{
        code: "GLOSSARY_INVALID",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export async function evidenceVerify(root: string) {
  try {
    const store = ProjectStore.open(root);
    const [receipts, requests, invocations] = await Promise.all([
      executionReceipts(store),
      executionRequests(store),
      pluginInvocations(store),
    ]);
    const findings: { code: string; reference: string; message: string }[] = [];
    const audits = new Map<string, AuditEvent>();
    if (invocations.invocations.length > 0) {
      const auditPath = join(resolve(root), ".agent-team/audit/events.jsonl");
      const projectRoot = await realpath(root);
      if (!inside(projectRoot, await realpath(auditPath))) throw new Error("PATH_OUTSIDE_PROJECT");
      for (const line of (await readFile(auditPath, "utf8")).split(/\r?\n/).filter(Boolean)) {
        const audit = AuditEventSchema.parse(JSON.parse(line));
        audits.set(audit.id, audit);
      }
    }
    for (const receipt of receipts.receipts) {
      try {
        await loadExecutionReceipt(root, receipt.id);
      } catch (error) {
        findings.push({
          code: "EXECUTION_RECEIPT_INVALID",
          reference: receipt.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const request of requests.requests) {
      try {
        await loadExecutionRequest(root, request.id);
      } catch (error) {
        findings.push({
          code: "EXECUTION_REQUEST_INVALID",
          reference: request.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const invocation of invocations.invocations) {
      const audit = audits.get(operationKey("plugin-invocation", invocation.plugin_uri, invocation.operation_id));
      if (!audit) {
        findings.push({
          code: "PLUGIN_INVOCATION_AUDIT_MISSING",
          reference: invocation.operation_id,
          message: `No audit event attests ${invocation.plugin_uri}`,
        });
      } else if (audit.action !== "plugin-invocation"
        || audit.target !== invocation.plugin_uri
        || audit.adapter_id !== invocation.plugin_uri
        || audit.result !== "success") {
        findings.push({
          code: "PLUGIN_INVOCATION_AUDIT_MISMATCH",
          reference: invocation.operation_id,
          message: `Audit event does not attest ${invocation.plugin_uri}`,
        });
      }
    }
    return {
      valid: findings.length === 0,
      verified: {
        execution_receipts: receipts.receipts.length,
        execution_requests: requests.requests.length,
        plugin_invocations: invocations.invocations.length,
      },
      findings,
    };
  } catch (error) {
    return {
      valid: false,
      verified: { execution_receipts: 0, execution_requests: 0, plugin_invocations: 0 },
      findings: [{
        code: "EVIDENCE_INVALID",
        reference: ".agent-team",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
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
      {
        path: ".agent-team/workflow-state.yaml",
        content: stringify(nextState),
        expectedStateVersion: state.state_version,
      },
    ], makeAuditEvent(scopedOperation, "change", change.id, project.profile, {
      actor: { type: "human", identifier: change.requested_by },
      authorizationSource: "change_request",
      artifactVersions: Object.fromEntries(registry.artifacts
        .filter(({ id }) => staleIds.has(id)).map(({ id, version }) => [id, version])),
    }));
    return { change, stale_artifacts: staleArtifacts };
  });
}

export async function validatePhase(
  root: string,
  phase: string,
  operationId: string,
  execution: BootstrapExecutionOptions = {},
) {
  requireOperationId(operationId);
  const scopedOperation = operationKey("validate", phase, operationId);
  const store = ProjectStore.open(root, execution);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
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

  const next = transitionPhase(
    state,
    workflow,
    { phase, to: "artifact_validation", operation_id: scopedOperation },
  );
  const { project } = await projectConfig(store);
  await ensureLifecycleTransaction(store, scopedOperation, [
    { path: ".agent-team/workflow-state.yaml", content: stringify(next), expectedStateVersion: state.state_version },
  ], makeAuditEvent(scopedOperation, "validate", phase, project.profile));
  return { valid: true, phase, findings, state: next };
  });
}

function artifactVersions(artifacts: readonly ArtifactRecord[]): Record<string, number> {
  return Object.fromEntries(
    [...artifacts].sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => [artifact.id, artifact.version]),
  );
}

function artifactChecksums(artifacts: readonly ArtifactRecord[]): Record<string, string> {
  return Object.fromEntries(
    [...artifacts].sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => [artifact.id, artifact.checksum]),
  );
}

function sameRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const entries = (value: Record<string, unknown>) => Object.entries(value)
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
  receiptId?: string,
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
  if (!receiptId) throw new Error("REVIEW_EXECUTION_RECEIPT_REQUIRED");
  const reviewReceipt = await loadExecutionReceipt(root, receiptId);
  if (reviewReceipt.agent_id !== reviewerId || reviewReceipt.agent_id === definition.owner) {
    throw new Error("REVIEWER_EXECUTION_IDENTITY_MISMATCH");
  }
  if (reviewReceipt.phase !== phase) throw new Error("REVIEWER_EXECUTION_PHASE_MISMATCH");
  if (reviewReceipt.review_verdict !== verdict) throw new Error("REVIEWER_EXECUTION_VERDICT_MISMATCH");
  if (reviewReceipt.result.status !== "completed"
    || reviewReceipt.result.checkpoints.some(({ status }) => status !== "completed")) {
    throw new Error("REVIEW_EXECUTION_NOT_COMPLETED");
  }
  if (!reviewerId || reviewerId !== definition.reviewer || reviewerId === definition.owner) {
    throw new Error("REVIEWER_NOT_CONFIGURED");
  }
  const reviewerManifest = (await configuredCatalogue(store)).find((agent) => agent.id === reviewerId);
  if (!reviewerManifest) throw new Error("REVIEWER_NOT_CONFIGURED");
  const artifacts = registry.artifacts.filter(
    (artifact) => artifact.owner === definition.owner && artifact.required_gate === definition.gate,
  );
  if (artifacts.length === 0) throw new Error("REVIEW_ARTIFACTS_REQUIRED");
  const [finding] = await inspectArtifacts(root, artifacts);
  if (finding) throw new Error(`${finding.code}: ${finding.message}`);
  const versions = artifactVersions(artifacts);
  const checksums = artifactChecksums(artifacts);
  if (!reviewReceipt.artifact_versions || !reviewReceipt.artifact_checksums
    || !sameRecord(reviewReceipt.artifact_versions, versions)
    || !sameRecord(reviewReceipt.artifact_checksums, checksums)) {
    throw new Error("REVIEWER_EXECUTION_ARTIFACT_MISMATCH");
  }
  const report = evaluateReviewExecutionResult(
    reviewReceipt.result,
    await executionEvidenceContext(root, store),
    definition.id,
  );
  if (!report.allowed) throw new Error(report.blockers[0]);
  const existing = reviews.reviews.find((review) => review.id === evidenceId);
  if (state.completed_operations.includes(verdictId)) {
    if (!existing) throw new Error("REVIEW_EVIDENCE_MISSING");
    if (existing.phase !== phase || existing.reviewer !== reviewerId || existing.verdict !== verdict
      || existing.execution_receipt_id !== reviewReceipt.id
      || existing.execution_receipt_digest !== reviewReceipt.attestation_digest) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
    await invokeRequiredPlugins(root, reviewerManifest, phase, evidenceId, adapter, false);
    if (state.phases[phase]?.review_id !== existing.id) throw new Error("REVIEW_EVIDENCE_MISSING");
    await appendOperationAudit(store, evidenceId, "review", phase, {
      executionReceiptId: reviewReceipt.id,
      executionReceiptDigest: reviewReceipt.attestation_digest,
    });
    return state;
  }
  if ((definition.gate === "G7" || definition.gate === "G8") && !(await secretsScan(root)).valid) {
    throw new Error("SECRET_SCAN_FAILED");
  }
  await invokeRequiredPlugins(root, reviewerManifest, phase, evidenceId, adapter);
  const expected = {
    id: evidenceId,
    phase,
    reviewer: reviewerId,
    verdict,
    artifact_versions: versions,
    execution_receipt_id: reviewReceipt.id,
    execution_receipt_digest: reviewReceipt.attestation_digest,
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
    {
      path: ".agent-team/workflow-state.yaml",
      content: stringify(preview),
      expectedStateVersion: state.state_version,
    },
  ], makeAuditEvent(evidenceId, "review", phase, project.profile, {
    actor: { type: "agent", identifier: reviewerId },
    authorizationSource: "agent_manifest",
    artifactVersions: review.artifact_versions,
    executionReceiptId: reviewReceipt.id,
    executionReceiptDigest: reviewReceipt.attestation_digest,
  }));
  return preview;
  });
}

export async function approve(
  root: string,
  gate: GateId,
  by: string,
  operationId: string,
  receiptId?: string,
  requestId?: string,
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
  const receipt = receiptId ? await loadExecutionReceipt(root, receiptId) : undefined;
  const request = requestId ? await loadExecutionRequest(root, requestId) : undefined;
  if (state.completed_operations.includes(scopedOperation)) {
    if (!existing) throw new Error("APPROVAL_EVIDENCE_MISSING");
    if (existing.gate !== gate
      || existing.decision !== "approved"
      || existing.approved_by.type !== "human"
      || existing.approved_by.identifier !== approver
      || existing.execution_receipt_id !== receipt?.id
      || existing.execution_receipt_digest !== receipt?.attestation_digest
      || existing.execution_request_id !== request?.id
      || existing.execution_request_digest !== request?.attestation_digest) {
      throw new Error("OPERATION_ID_CONFLICT");
    }
    const [finding] = await inspectArtifacts(root, registry.artifacts.filter((artifact) =>
      artifact.required_gate === gate));
    if (finding) throw new Error(`${finding.code}: ${finding.message}`);
    await appendOperationAudit(store, scopedOperation, "approve", gate, {
      executionReceiptId: receipt?.id,
      executionReceiptDigest: receipt?.attestation_digest,
      executionRequestId: request?.id,
      executionRequestDigest: request?.attestation_digest,
    });
    return state;
  }
  if ((gate === "G7" || gate === "G8") && !(await secretsScan(root)).valid) {
    throw new Error("SECRET_SCAN_FAILED");
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
    || !sameRecord(review.artifact_versions, versions)) {
    throw new Error("REVIEW_VERSION_MISMATCH");
  }
  const expected = {
    id: scopedOperation,
    gate,
    decision: "approved" as const,
    approved_by: { type: "human" as const, identifier: approver },
    artifact_versions: versions,
    ...(receipt ? {
      execution_receipt_id: receipt.id,
      execution_receipt_digest: receipt.attestation_digest,
    } : {}),
    ...(request ? {
      execution_request_id: request.id,
      execution_request_digest: request.attestation_digest,
      execution_authorization: request.authorization,
    } : {}),
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
  const policyContext = await executionEvidenceContext(root, store);
  const nextState = approveGate(
    state,
    workflow,
    approval,
    receipt?.result,
    policyContext,
    request,
  );
  const { project } = await projectConfig(store);
  await store.transaction(scopedOperation, [
    { path: ".agent-team/approvals.yaml", content: stringify(nextApprovals) },
    {
      path: ".agent-team/workflow-state.yaml",
      content: stringify(nextState),
      expectedStateVersion: state.state_version,
    },
  ], makeAuditEvent(scopedOperation, "approve", gate, project.profile, {
    actor: { type: "human", identifier: approver },
    authorizationSource: "gate_policy",
    artifactVersions: versions,
    executionReceiptId: receipt?.id,
    executionReceiptDigest: receipt?.attestation_digest,
    executionRequestId: request?.id,
    executionRequestDigest: request?.attestation_digest,
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
      {
        path: ".agent-team/workflow-state.yaml",
        content: stringify(nextState),
        expectedStateVersion: state.state_version,
      },
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
      || !sameRecord(approval.artifact_versions, artifactVersions(approvedArtifacts))) {
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
      {
        path: ".agent-team/workflow-state.yaml",
        content: stringify(state),
        expectedStateVersion: initialState.state_version,
      },
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

export async function planUpgrade(root: string, mode: UpgradeMode) {
  const projectRoot = resolve(root);
  const store = ProjectStore.open(projectRoot);
  const [project, catalogue, lock] = await Promise.all([
    projectConfig(store),
    readCatalogue(),
    store.readYaml(".agent-team/framework-lock.yaml", FrameworkLockSchema),
  ]);
  const base = {
    mode,
    current_version: lock.framework.version,
    target_version: FRAMEWORK_VERSION,
  };
  const lockMatchesWorkflow = lock.workflow.id === project.workflow.id
    && lock.workflow.version === project.workflow.version;
  const lockProposal = {
    path: ".agent-team/overrides/upgrade/framework-lock.yaml",
    content: stringify(FrameworkLockSchema.parse({
      framework: { version: FRAMEWORK_VERSION },
      workflow: project.workflow,
    })),
  };
  if (project.framework.management === "ejected") {
    return lockMatchesWorkflow
      ? { ...base, status: "ejected" as const, changes: [], conflicts: [], proposals: [] }
      : {
        ...base,
        status: "blocked" as const,
        changes: [],
        conflicts: [{
          path: ".agent-team/framework-lock.yaml",
          proposal_path: ".agent-team/overrides/upgrade/framework-lock.yaml",
        }],
        proposals: [lockProposal],
      };
  }
  const changes: { path: string; action: "create" | "update" }[] = [];
  const conflicts: { path: string; proposal_path: string }[] = [];
  const proposals: { path: string; content: string }[] = [];
  if (!lockMatchesWorkflow) {
    conflicts.push({
      path: ".agent-team/framework-lock.yaml",
      proposal_path: ".agent-team/overrides/upgrade/framework-lock.yaml",
    });
    proposals.push(lockProposal);
  }
  for (const agent of catalogue) {
    const managedFiles = [
      { path: `.codex/agents/${agent.id}.md`, content: renderAgentInstruction(agent) },
      ...renderAgentContractFiles(agent),
    ];
    for (const { path, content } of managedFiles) {
      const proposalPath = `.agent-team/overrides/upgrade/${path.slice(".codex/agents/".length)}`;
      try {
        const target = join(projectRoot, path);
        if (!inside(await realpath(projectRoot), await realpath(target))) throw new Error("PATH_OUTSIDE_PROJECT");
        if (await readFile(target, "utf8") !== content) {
          conflicts.push({ path, proposal_path: proposalPath });
          proposals.push({ path: proposalPath, content });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") changes.push({ path, action: "create" });
        else throw error;
      }
    }
  }
  if (lock.framework.version !== FRAMEWORK_VERSION || !lockMatchesWorkflow) {
    changes.push({ path: ".agent-team/framework-lock.yaml", action: "update" });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  conflicts.sort((left, right) => left.path.localeCompare(right.path));
  proposals.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...base,
    status: conflicts.length > 0 ? "blocked" as const
      : changes.length > 0 ? "upgrade_available" as const
        : "current" as const,
    changes,
    conflicts,
    proposals,
  };
}

export async function ejectProject(
  root: string,
  operationId: string,
  authorization: LifecycleAuthorizationInput = apiAuthorization,
) {
  requireOperationId(operationId);
  const projectRoot = resolve(root);
  const store = ProjectStore.open(projectRoot);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const project = await projectConfig(store);
    const materialized = [
      ".agent-team/overrides/agents.yaml",
      ".agent-team/overrides/workflow.yaml",
    ];
    const record = EjectOperationSchema.parse({
      schema_version: 1,
      action: "eject",
      operation_id: operationId,
      authorization: persistedAuthorization(authorization),
      materialized,
    });
    if (await exists(join(projectRoot, ".agent-team/eject-operation.yaml"))) {
      const stored = await store.readYaml(".agent-team/eject-operation.yaml", EjectOperationSchema);
      if (JSON.stringify(stored) !== JSON.stringify(record)) throw new Error("OPERATION_ID_CONFLICT");
      return { status: "ejected" as const, materialized: stored.materialized };
    }
    if (project.framework.management === "ejected") throw new Error("EJECT_OPERATION_MISSING");
    const [workflow, catalogue] = await Promise.all([
      configuredWorkflow(store),
      configuredCatalogue(store),
    ]);
    const ejected = ProjectConfigSchema.parse({
      ...project,
      framework: { ...project.framework, management: "ejected" },
    });
    const id = operationKey("eject", project.project.id, operationId);
    await store.transaction(id, [
      { path: ".agent-team/project.yaml", content: stringify(ejected) },
      { path: materialized[0]!, content: stringify(catalogue) },
      { path: materialized[1]!, content: stringify(workflow) },
      { path: ".agent-team/eject-operation.yaml", content: stringify(record) },
    ], makeAuditEvent(id, "eject", project.project.id, project.project.profile, {
      actor: authorization.actor,
      authorizationSource: authorization.authorizationSource,
    }));
    return { status: "ejected" as const, materialized };
  });
}

export async function uninstallProject(
  root: string,
  operationId: string,
  authorization: LifecycleAuthorizationInput = apiAuthorization,
  execution: BootstrapExecutionOptions = {},
) {
  requireOperationId(operationId);
  const projectRoot = resolve(root);
  const store = ProjectStore.open(projectRoot, execution);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const project = await projectConfig(store);
    const expectedAuthorization = persistedAuthorization(authorization);
    const startId = operationKey("uninstall-started", project.project.id, operationId);
    const completionId = operationKey("uninstall", project.project.id, operationId);
    const startedAudit = () => makeAuditEvent(
      startId,
      "uninstall-started",
      project.project.id,
      project.project.profile,
      { actor: authorization.actor, authorizationSource: authorization.authorizationSource },
    );
    const completedAudit = () => makeAuditEvent(
      completionId,
      "uninstall",
      project.project.id,
      project.project.profile,
      { actor: authorization.actor, authorizationSource: authorization.authorizationSource },
    );
    let plan;
    if (await exists(join(projectRoot, ".agent-team/uninstall-plan.yaml"))) {
      plan = await store.readYaml(".agent-team/uninstall-plan.yaml", UninstallPlanSchema);
      if (plan.operation_id !== operationId
        || JSON.stringify(plan.authorization) !== JSON.stringify(expectedAuthorization)) {
        throw new Error("OPERATION_ID_CONFLICT");
      }
      if (plan.status === "completed") {
        await ensureLifecycleTransaction(store, completionId, [{
          path: ".agent-team/uninstall-plan.yaml",
          content: stringify(plan),
        }], completedAudit());
        return { removed: plan.removed, preserved: plan.preserved };
      }
    } else {
      const manifest = await store.readYaml(
        ".agent-team/installation-manifest.yaml",
        InstallationManifestSchema,
      );
      plan = UninstallPlanSchema.parse({
        schema_version: 1,
        operation_id: operationId,
        authorization: expectedAuthorization,
        status: "started",
        files: manifest.files.filter(({ role }) => role === "generated_adapter")
          .sort((left, right) => left.path.localeCompare(right.path)),
        directories: [...manifest.directories_created]
          .sort((left, right) => right.split("/").length - left.split("/").length),
        removed: [],
        preserved: [".agent-team"],
      });
    }
    await ensureLifecycleTransaction(store, startId, [{
      path: ".agent-team/uninstall-plan.yaml",
      content: stringify(plan),
    }], startedAudit());

    const removed = new Set(plan.removed);
    const preserved = new Set(plan.preserved);
    const realRoot = await realpath(projectRoot);
    for (const file of plan.files) {
      try {
        const target = join(projectRoot, file.path);
        if (!inside(realRoot, await realpath(target))) {
          preserved.add(file.path);
          continue;
        }
        if (artifactChecksum(await readFile(target, "utf8")) !== file.checksum) {
          preserved.add(file.path);
          continue;
        }
        await rm(target);
        removed.add(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          removed.add(file.path);
          continue;
        }
        throw error;
      }
    }
    for (const path of plan.directories) {
      await removeEmptyGeneratedDirectory(projectRoot, path);
    }
    const completed = UninstallPlanSchema.parse({
      ...plan,
      status: "completed",
      removed: [...removed].sort(),
      preserved: [...preserved].sort(),
    });
    await ensureLifecycleTransaction(store, completionId, [{
      path: ".agent-team/uninstall-plan.yaml",
      content: stringify(completed),
    }], completedAudit());
    return { removed: completed.removed, preserved: completed.preserved };
  });
}

export async function gateReadinessReport(root: string, gate: GateId, receiptId?: string) {
  const store = ProjectStore.open(root);
  const [state, workflow, context, receipt] = await Promise.all([
    store.readWorkflowState(),
    configuredWorkflow(store),
    executionEvidenceContext(root, store),
    receiptId ? loadExecutionReceipt(root, receiptId) : undefined,
  ]);
  return gateReadiness(state, workflow, gate, receipt?.result, context);
}

function attestationDigest(receipt: Pick<ExecutionReceipt,
  "adapter_id" | "agent_id" | "phase" | "review_verdict" | "artifact_versions"
  | "artifact_checksums" | "result">): `sha256:${string}` {
  const binding = {
    adapter_id: receipt.adapter_id,
    ...(receipt.agent_id ? { agent_id: receipt.agent_id } : {}),
    ...(receipt.phase ? { phase: receipt.phase } : {}),
    ...(receipt.review_verdict ? { review_verdict: receipt.review_verdict } : {}),
    ...(receipt.artifact_versions ? { artifact_versions: receipt.artifact_versions } : {}),
    ...(receipt.artifact_checksums ? { artifact_checksums: receipt.artifact_checksums } : {}),
    result: receipt.result,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
}

function requestAttestationDigest(request: Pick<PreparedExecutionRequest,
  "adapter_id" | "action" | "scope" | "authorization" | "evidence">): `sha256:${string}` {
  const binding = {
    adapter_id: request.adapter_id,
    action: request.action,
    scope: request.scope,
    authorization: {
      execution_id: request.authorization.execution_id,
      dispatch_digest: request.authorization.dispatch_digest,
      permission_profile: request.authorization.permission_profile,
      authorized_paths: request.authorization.authorized_paths,
      command_class: request.authorization.command_class,
      destructive: request.authorization.destructive,
    },
    evidence: request.evidence,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
}

export async function recordExecutionRequest(
  root: string,
  adapter: ManualCodexAdapter,
  prepared: PreparedExecution,
  operationId: string,
): Promise<PreparedExecutionRequest> {
  requireOperationId(operationId);
  if (!(adapter instanceof ManualCodexAdapter)) throw new Error("EXECUTION_ADAPTER_REQUIRED");
  const attested = adapter.createPreparedExecutionRequest(prepared);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const current = await executionRequests(store);
    const existing = current.requests.find((request) => request.operation_id === operationId
      || request.id === attested.authorization.execution_id);
    if (existing) {
      if (existing.operation_id !== operationId || existing.attestation_digest !== attested.attestation_digest) {
        throw new Error("OPERATION_ID_CONFLICT");
      }
      return loadExecutionRequest(root, existing.id);
    }
    const auditId = operationKey("execution-request", attested.authorization.execution_id, operationId);
    const request = PreparedExecutionRequestSchema.parse({
      id: attested.authorization.execution_id,
      operation_id: operationId,
      ...attested,
      recorded_at: new Date().toISOString(),
      audit_id: auditId,
    });
    const { project } = await projectConfig(store);
    await store.transaction(auditId, [{
      path: ".agent-team/execution-requests.yaml",
      content: stringify({ requests: [...current.requests, request] }),
    }], makeAuditEvent(auditId, "execution-request", request.id, request.authorization.permission_profile, {
      actor: { type: "system", identifier: "codex-runtime" },
      authorizationSource: "runtime-adapter",
      adapterId: request.adapter_id,
      executionRequestId: request.id,
      executionRequestDigest: request.attestation_digest,
    }));
    return request;
  });
}

export async function loadExecutionRequest(root: string, reference: string): Promise<PreparedExecutionRequest> {
  const request = (await executionRequests(ProjectStore.open(root))).requests.find(({ id }) => id === reference);
  if (!request) throw new Error("EXECUTION_REQUEST_NOT_FOUND");
  if (requestAttestationDigest(request) !== request.attestation_digest) {
    throw new Error("EXECUTION_REQUEST_DIGEST_MISMATCH");
  }
  const auditPath = join(resolve(root), ".agent-team/audit/events.jsonl");
  const audit = (await readFile(auditPath, "utf8")).split(/\r?\n/).filter(Boolean)
    .map((line) => AuditEventSchema.parse(JSON.parse(line))).find(({ id }) => id === request.audit_id);
  if (audit?.action !== "execution-request" || audit.execution_request_id !== request.id
    || audit.execution_request_digest !== request.attestation_digest) {
    throw new Error("EXECUTION_REQUEST_AUDIT_MISMATCH");
  }
  return request;
}

export async function recordExecutionReceipt(
  root: string,
  adapter: ManualCodexAdapter,
  result: AgentExecutionResult,
  operationId: string,
): Promise<ExecutionReceipt> {
  requireOperationId(operationId);
  if (!(adapter instanceof ManualCodexAdapter)) throw new Error("EXECUTION_ADAPTER_REQUIRED");
  const attested = adapter.createExecutionReceipt(result);
  const store = ProjectStore.open(root);
  return store.withLock(".agent-team/lifecycle.lock", async () => {
    const current = await executionReceipts(store);
    const byOperation = current.receipts.find((receipt) => receipt.operation_id === operationId);
    const byExecution = current.receipts.find((receipt) => receipt.id === result.execution_id);
    const existing = byOperation ?? byExecution;
    if (existing) {
      if (existing.operation_id !== operationId
        || existing.id !== result.execution_id
        || existing.attestation_digest !== attested.attestation_digest) {
        throw new Error("OPERATION_ID_CONFLICT");
      }
      await loadExecutionReceipt(root, existing.id);
      return existing;
    }
    const auditId = operationKey("execution-receipt", result.execution_id, operationId);
    const receipt = ExecutionReceiptSchema.parse({
      id: result.execution_id,
      operation_id: operationId,
      ...attested,
      recorded_at: new Date().toISOString(),
      audit_id: auditId,
    });
    const next = ExecutionReceiptListSchema.parse({ receipts: [...current.receipts, receipt] });
    await store.transaction(auditId, [
      { path: ".agent-team/execution-receipts.yaml", content: stringify(next) },
    ], makeAuditEvent(auditId, "execution-receipt", receipt.id, receipt.result.permission_profile, {
      actor: receipt.agent_id
        ? { type: "agent", identifier: receipt.agent_id }
        : { type: "system", identifier: "codex-runtime" },
      authorizationSource: "runtime-adapter",
      adapterId: receipt.adapter_id,
      executionReceiptId: receipt.id,
      executionReceiptDigest: receipt.attestation_digest,
    }));
    return receipt;
  });
}

export async function loadExecutionReceipt(root: string, reference: string): Promise<ExecutionReceipt> {
  if (!reference) throw new Error("EXECUTION_RECEIPT_NOT_FOUND");
  const receipt = (await executionReceipts(ProjectStore.open(root))).receipts
    .find(({ id }) => id === reference);
  if (!receipt) throw new Error("EXECUTION_RECEIPT_NOT_FOUND");
  if (attestationDigest(receipt) !== receipt.attestation_digest) {
    throw new Error("EXECUTION_RECEIPT_DIGEST_MISMATCH");
  }
  const auditPath = join(resolve(root), ".agent-team/audit/events.jsonl");
  let audit: AuditEvent | undefined;
  try {
    const projectRoot = await realpath(root);
    if (!inside(projectRoot, await realpath(auditPath))) throw new Error("PATH_OUTSIDE_PROJECT");
    audit = (await readFile(auditPath, "utf8")).split(/\r?\n/).filter(Boolean)
      .map((line) => AuditEventSchema.parse(JSON.parse(line)))
      .find(({ id }) => id === receipt.audit_id);
  } catch (error) {
    if (error instanceof Error && error.message === "PATH_OUTSIDE_PROJECT") throw error;
    throw new Error("EXECUTION_RECEIPT_AUDIT_MISSING");
  }
  if (audit?.action !== "execution-receipt"
    || audit.target !== receipt.id
    || audit.adapter_id !== receipt.adapter_id
    || audit.execution_receipt_id !== receipt.id
    || audit.execution_receipt_digest !== receipt.attestation_digest
    || audit.result !== "success") {
    throw new Error("EXECUTION_RECEIPT_AUDIT_MISMATCH");
  }
  return receipt;
}

export async function secretsScan(root: string) {
  let tracked = "";
  let untracked = "";
  try {
    [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      runGit(root, ["ls-files", "-z", "--cached"]),
      runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    ]);
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
  const projectRoot = await realpath(root);
  const generatedOrDependency = /(?:^|\/)(?:node_modules|dist|build|coverage)(?:\/|$)|^\.agent-team\/cache(?:\/|$)/;
  const trackedPaths = tracked.split("\0").filter(Boolean);
  const untrackedPaths = untracked.split("\0").filter((path) => path
    && path !== ".git"
    && !path.startsWith(".git/")
    && !generatedOrDependency.test(path));
  const paths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
  for (const path of paths) {
    let content: Buffer;
    try {
      const target = resolve(projectRoot, path);
      const entry = await lstat(target);
      if (!inside(projectRoot, target) || entry.isSymbolicLink() || !entry.isFile()) continue;
      if (!inside(projectRoot, await realpath(target))) continue;
      content = await readFile(target);
    } catch {
      continue;
    }
    if (content.subarray(0, 8192).includes(0)) continue;
    const lines = content.toString("utf8").split(/\r?\n/);
    const index = lines.findIndex((line) => secrets.some((secret) => secret.test(line)));
    if (index >= 0) findings.push({ path, line: index + 1, code: "POSSIBLE_SECRET" });
  }
  return { valid: findings.length === 0, findings };
}

export async function diagnostics(root: string) {
  return doctor(root);
}

export async function cacheRebuild(root: string) {
  const cache = (await projectConfig(ProjectStore.open(root))).cache;
  if (cache.provider !== "sqlite") throw new Error("CACHE_DISABLED");
  return rebuildCache(root, cache.path);
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
  const byPath = new Map(inspections.map((inspection) => [inspection.path, inspection]));
  const lockOrder = [
    ".agent-team/transactions.lock",
    ".agent-team/audit/events.lock",
    ".agent-team/workflow-state.lock",
    ".agent-team/lifecycle.lock",
    ".system-design-team-init.lock",
  ] as const;
  const repaired: string[] = [];
  for (const path of lockOrder) {
    const { status } = byPath.get(path)!;
    if (status === "missing") continue;
    if (await store.repairLock(path, { confirmedQuiescent: true })) repaired.push(path);
  }
  repaired.push(...(await store.repairTransactions()).map((id) => `transaction:${id}`));
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
    const { stdout } = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
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
    const cache = (await projectConfig(store)).cache;
    if (cache.provider === "none") {
      checks.push({ name: "cache", ok: true, detail: "disabled" });
    } else {
      const status = await inspectCache(root, cache.path);
      checks.push({
        name: "cache",
        ok: status.available,
        detail: status.available
          ? `${status.document_count} documents at ${status.source_commit}`
          : status.reason,
      });
    }
  } catch (error) {
    checks.push({ name: "cache", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const [plugins, workflow, catalogue] = await Promise.all([
      pluginStatus(store),
      configuredWorkflow(store),
      configuredCatalogue(store),
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
