import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  artifactInspect,
  artifactList,
  artifactValidate,
  approve,
  adoptProject,
  cacheRebuild,
  createChange,
  doctor,
  ejectProject,
  evidenceVerify,
  getStatus,
  glossaryValidate,
  handover,
  initProject,
  inspectProject,
  planUpgrade,
  recordExecutionReceipt,
  resolveProjectConfig,
  reviewPhase as reviewPhaseWithAdapter,
  setPluginStatus,
  startPhase as startPhaseWithAdapter,
  staleList,
  traceCheck,
  traceCoverageReport,
  uninstallProject,
  validatePhase,
} from "@system-design-team/cli";
import { ManualCodexAdapter } from "@system-design-team/codex-adapter";
import {
  AgentManifestSchema,
  AuditEventSchema,
  HandoverRecordSchema,
  WorkflowDefinitionSchema,
} from "@system-design-team/core";
import { ProjectStore } from "@system-design-team/project-store";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginUri = "plugin://superpowers@openai-curated-remote";
const operationKey = (action, target, raw) => JSON.stringify([action, target, raw]);
const adapterWithStatus = (status) => ({
  async resolve(uri) {
    return { uri, publisher_identity: uri.slice(uri.lastIndexOf("@") + 1), status };
  },
  async verifySkill() {
    return true;
  },
  async invoke(request) {
    return {
      plugin_uri: request.plugin_uri,
      publisher_identity: request.plugin_uri.split("@").at(-1),
      status: "success",
      output: { ok: true },
      execution_reference: `test-${request.operation_id}`,
      started_at: "2026-07-14T00:00:00.000Z",
      completed_at: "2026-07-14T00:00:01.000Z",
    };
  },
});
const pluginAdapter = adapterWithStatus("available");
const unavailablePluginAdapter = adapterWithStatus("unknown");
const availabilityOnlyPluginAdapter = {
  ...pluginAdapter,
  async invoke() { throw new Error("TEST_INVOCATION_NOT_CONFIGURED"); },
};
const lifecycleAuthorization = {
  actor: { type: "human", identifier: "project-owner" },
  authorizationSource: "test_authorization",
};
const startPhase = (root, phase, operationId, adapter = pluginAdapter) =>
  startPhaseWithAdapter(root, phase, operationId, adapter);
const reviewPhase = async (root, phase, reviewer, verdict, operationId, adapter = pluginAdapter) => {
  const receipt = await reviewerReceipt(root, phase, reviewer, verdict, operationId);
  return reviewPhaseWithAdapter(root, phase, reviewer, verdict, operationId, adapter, receipt.id);
};

async function temporaryGitRepository() {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-cli-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function readYaml(root, path) {
  return parse(await readFile(join(root, path), "utf8"));
}

async function reviewerReceipt(root, phase, reviewer, verdict, operationId) {
  const project = await readYaml(root, ".agent-team/project.yaml");
  const workflow = project.framework.management === "ejected"
    ? await readYaml(root, ".agent-team/overrides/workflow.yaml")
    : parse(await readFile(join(repository, "workflows", `${project.project.mode.replace("_", "-")}.yaml`), "utf8"));
  const definition = workflow.phases.find(({ id }) => id === phase);
  const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
  const artifacts = registry.artifacts.filter(({ owner, required_gate }) =>
    owner === definition.owner && required_gate === definition.gate);
  const dispatch = {
    execution_id: `EXEC-${operationId}`,
    agent_id: reviewer,
    phase,
    review_verdict: verdict,
    artifact_versions: Object.fromEntries(artifacts.map(({ id, version }) => [id, version])),
    artifact_checksums: Object.fromEntries(artifacts.map(({ id, checksum }) => [id, checksum])),
    authorized_scope: { read: [".agent-team/**"], write: [], execute: [] },
    required_inputs: [],
    permission_profile: "read_only_assessment",
    command_class: "safe_read",
  };
  const executionAdapter = new ManualCodexAdapter();
  const prepared = await executionAdapter.prepareExecution(dispatch);
  const result = await executionAdapter.collectResult(await executionAdapter.execute(prepared), {
    execution_id: dispatch.execution_id,
    dispatch_digest: prepared.digest,
    status: "completed",
    permission_profile: dispatch.permission_profile,
    authorized_paths: dispatch.authorized_scope,
    command_class: dispatch.command_class,
    checkpoints: [{
      id: `review-${phase}`,
      status: "completed",
      timestamp: "2026-07-14T00:00:00.000Z",
      evidence: [`sha256:${"a".repeat(64)}`],
    }],
    evidence: { gate_approvals: [] },
  });
  return recordExecutionReceipt(root, executionAdapter, result, `RECEIPT-${operationId}`);
}

async function enableAllPlugins(root) {
  const catalogue = AgentManifestSchema.array().parse(
    parse(await readFile(join(repository, "agents/catalogue.yaml"), "utf8")),
  );
  const skillsByUri = new Map();
  for (const plugin of catalogue.flatMap(({ required_plugins }) => required_plugins)) {
    const skills = skillsByUri.get(plugin.uri) ?? new Set();
    plugin.required_skills.forEach((skill) => skills.add(skill));
    skillsByUri.set(plugin.uri, skills);
  }
  for (const [uri, skills] of skillsByUri) {
    await setPluginStatus(root, uri, "available", [...skills].sort());
  }
}

async function setArtifactStatus(
  root,
  id,
  {
    registryStatus = "in_review",
    fileStatus = registryStatus,
    version = 1,
    body = "The artifact is ready for independent review.",
  } = {},
) {
  const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
  const artifact = registry.artifacts.find((candidate) => candidate.id === id);
  artifact.status = registryStatus;
  artifact.version = version;
  const text = [
    "---",
    `artifact_id: ${artifact.id}`,
    `version: ${version}`,
    `status: ${fileStatus}`,
    `owner: ${artifact.owner}`,
    `reviewer: ${artifact.reviewer}`,
    "---",
    `# ${artifact.id}`,
    body,
  ].join("\n");
  await writeFile(join(root, ".agent-team", artifact.path), text);
  artifact.checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
}

async function enterArtifactValidation(root, phase, artifactId, prefix) {
  await setArtifactStatus(root, artifactId);
  await startPhase(root, phase, `${prefix}-START`);
  return validatePhase(root, phase, `${prefix}-VALIDATE`);
}

async function completeIntake(root, prefix = "INTAKE") {
  await enterArtifactValidation(root, "intake", "PROJECT-CHARTER", prefix);
  await reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    `${prefix}-REVIEW`,
  );
  await approve(root, "G0", "project-owner", `${prefix}-APPROVE`);
  return handover(root, "intake", `${prefix}-HANDOVER`);
}

async function completeBusinessDiscovery(root, prefix = "DISCOVERY") {
  await completeIntake(root, `${prefix}-INTAKE`);
  await enterArtifactValidation(root, "business-discovery", "BUSINESS-CONTEXT", prefix);
  await reviewPhase(root, "business-discovery", "business-analyst", "approved", `${prefix}-REVIEW`);
  await approve(root, "G1", "project-owner", `${prefix}-APPROVE`);
  return handover(root, "business-discovery", `${prefix}-HANDOVER`);
}

async function requirementsAwaitingApproval(root, prefix = "REQUIREMENTS") {
  await completeBusinessDiscovery(root, `${prefix}-DISCOVERY`);
  await enterArtifactValidation(root, "requirements", "REQUIREMENTS", prefix);
  return reviewPhase(
    root,
    "requirements",
    "requirements-reviewer",
    "approved",
    `${prefix}-REVIEW`,
  );
}

test("init creates a valid project without overwriting source", async () => {
  const root = await temporaryGitRepository();
  await writeFile(join(root, "AGENTS.md"), "repository policy\n");
  await mkdir(join(root, ".codex/generated"), { recursive: true });
  await writeFile(join(root, ".codex/generated/existing.txt"), "keep\n");

  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-1");

  const project = parse(await readFile(join(root, ".agent-team/project.yaml"), "utf8"));
  const state = parse(await readFile(join(root, ".agent-team/workflow-state.yaml"), "utf8"));
  assert.equal(project.project.id, "leave-system");
  assert.equal(state.phases.intake.status, "ready");
  assert.equal(state.phases.requirements.status, "not_started");
  assert.equal(state.phases.product.status, "not_started");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "repository policy\n");
  assert.equal(await readFile(join(root, ".codex/generated/existing.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(join(root, ".codex/generated/.gitkeep"), "utf8"), "");
  await assert.rejects(readFile(join(root, "src")), /ENOENT/);
});

test("fresh initialization persists complete profile-derived configuration", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "configured-system",
    name: "Configured System",
    mode: "greenfield",
    profile: "regulated",
    environments: {
      production: { security: { classification: "restricted" } },
    },
  }, "INIT-CLI-2");

  const project = await readYaml(root, ".agent-team/project.yaml");
  assert.equal(project.project.language, "en");
  assert.deepEqual(project.adapter, { primary: "codex" });
  assert.equal(project.approvals.production_deployment, "human_required");
  assert.deepEqual(project.plugins, {
    enforcement: "strict",
    fallback_requires_human_approval: true,
  });
  assert.deepEqual(project.cache, { provider: "none" });
  assert.deepEqual(project.security, {
    classification: "restricted",
    secret_scan: "required",
  });
  assert.equal(project.environments.production.security.classification, "restricted");
  assert.equal(project.framework.management, "managed");

  const inspected = await inspectProject(root, { environment: "production" });
  assert.equal(inspected.configuration.security.classification, "restricted");
  assert.equal(inspected.configuration.approvals.production_deployment, "human_required");
});

test("explicit configuration overrides environment and clears superseded cache settings", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "precedence-system",
    name: "Precedence System",
    mode: "greenfield",
    profile: "standard",
    cache: "sqlite",
    environments: {
      production: { security: { classification: "confidential" } },
    },
  }, "INIT-CLI-3");
  const project = await readYaml(root, ".agent-team/project.yaml");

  const effective = resolveProjectConfig(project, "production", {
    cache: { provider: "none" },
    security: { classification: "restricted" },
  });

  assert.deepEqual(effective.cache, { provider: "none" });
  assert.equal(effective.security.classification, "restricted");
  assert.equal(effective.approvals.production_deployment, "human_required");
});

test("classification overlays reject lowering and allow equal or stricter values", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "classification-system",
    name: "Classification System",
    mode: "greenfield",
    profile: "standard",
    environments: {
      downgrade: { security: { classification: "public" } },
    },
  }, "INIT-CLI-CLASSIFICATION");
  const project = await readYaml(root, ".agent-team/project.yaml");

  assert.throws(
    () => resolveProjectConfig(project, "downgrade"),
    /CLASSIFICATION_DOWNGRADE_NOT_ALLOWED/,
  );
  assert.throws(
    () => resolveProjectConfig(project, undefined, { security: { classification: "public" } }),
    /CLASSIFICATION_DOWNGRADE_NOT_ALLOWED/,
  );
  assert.equal(
    resolveProjectConfig(project, undefined, { security: { classification: "internal" } })
      .security.classification,
    "internal",
  );
  assert.equal(
    resolveProjectConfig(project, undefined, { security: { classification: "restricted" } })
      .security.classification,
    "restricted",
  );
});

test("adopt inventories an existing repository without mutating source", async () => {
  const root = await temporaryGitRepository();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/application.ts"), "export const source = true;\n");
  await writeFile(join(root, "README.md"), "# Existing system\n");
  await execFileAsync("git", ["add", "src/application.ts", "README.md"], { cwd: root });
  const before = await readFile(join(root, "src/application.ts"), "utf8");

  const adopted = await adoptProject(root, {
    id: "existing-system",
    name: "Existing System",
    profile: "standard",
  }, "ADOPT-INVENTORY", lifecycleAuthorization);

  assert.equal(adopted.project.project.mode, "existing_system");
  assert.deepEqual(adopted.inventory.languages, ["TypeScript"]);
  assert.equal(adopted.inventory.git.tracked_files, 2);
  assert.equal(await readFile(join(root, "src/application.ts"), "utf8"), before);
  assert.deepEqual(await readYaml(root, ".agent-team/inventory.yaml"), adopted.inventory);
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert(audit.some(({ action, actor, authorization_source }) =>
    action === "adopt"
    && actor.identifier === "project-owner"
    && authorization_source === "test_authorization"));
});

test("mutating project lifecycle APIs require caller operation ids", async () => {
  const initRoot = await temporaryGitRepository();
  await assert.rejects(() => initProject(initRoot, {
    id: "missing-init-operation",
    name: "Missing Init Operation",
    mode: "greenfield",
    profile: "standard",
  }, "", lifecycleAuthorization), /OPERATION_ID_REQUIRED/);
  await assert.rejects(() => access(join(initRoot, ".agent-team")), { code: "ENOENT" });

  const adoptRoot = await temporaryGitRepository();
  await assert.rejects(() => adoptProject(adoptRoot, {
    id: "missing-adopt-operation",
    name: "Missing Adopt Operation",
    profile: "standard",
  }, "", lifecycleAuthorization), /OPERATION_ID_REQUIRED/);
  await assert.rejects(() => access(join(adoptRoot, ".agent-team")), { code: "ENOENT" });

  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "missing-lifecycle-operation",
    name: "Missing Lifecycle Operation",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-LIFECYCLE", lifecycleAuthorization);
  await assert.rejects(() => ejectProject(root, "", lifecycleAuthorization), /OPERATION_ID_REQUIRED/);
  await assert.rejects(() => uninstallProject(root, "", lifecycleAuthorization), /OPERATION_ID_REQUIRED/);
});

test("init replay is idempotent and binds the operation id to its request", async () => {
  const root = await temporaryGitRepository();
  const options = {
    id: "init-replay",
    name: "Init Replay",
    mode: "greenfield",
    profile: "standard",
  };

  const first = await initProject(root, options, "INIT-REPLAY", lifecycleAuthorization);
  assert.deepEqual(await initProject(root, options, "INIT-REPLAY", lifecycleAuthorization), first);
  await assert.rejects(
    () => initProject(root, { ...options, name: "Changed Name" }, "INIT-REPLAY", lifecycleAuthorization),
    /OPERATION_ID_CONFLICT/,
  );
});

test("adopt replay is idempotent and binds the operation id to its request", async () => {
  const root = await temporaryGitRepository();
  await writeFile(join(root, "source.ts"), "export {};\n");
  await execFileAsync("git", ["add", "source.ts"], { cwd: root });
  const options = { id: "adopt-replay", name: "Adopt Replay", profile: "standard" };

  const first = await adoptProject(root, options, "ADOPT-REPLAY", lifecycleAuthorization);
  assert.deepEqual(await adoptProject(root, options, "ADOPT-REPLAY", lifecycleAuthorization), first);
  await assert.rejects(
    () => adoptProject(root, { ...options, name: "Changed Name" }, "ADOPT-REPLAY", lifecycleAuthorization),
    /OPERATION_ID_CONFLICT/,
  );
});

test("adopt bootstrap is one recoverable transaction under fault injection", async () => {
  const root = await temporaryGitRepository();
  await writeFile(join(root, "source.ts"), "export {};\n");
  await execFileAsync("git", ["add", "source.ts"], { cwd: root });
  const options = { id: "adopt-fault", name: "Adopt Fault", profile: "standard" };

  await assert.rejects(() => adoptProject(
    root,
    options,
    "ADOPT-FAULT",
    lifecycleAuthorization,
    { transactionFault: (point) => { if (point === "before_audit_append") throw new Error("adopt fault"); } },
  ), /adopt fault/);
  await assert.rejects(() => access(join(root, ".agent-team")), { code: "ENOENT" });
  await assert.rejects(() => access(join(root, ".codex")), { code: "ENOENT" });

  const adopted = await adoptProject(root, options, "ADOPT-FAULT", lifecycleAuthorization);
  assert.equal(adopted.project.project.id, "adopt-fault");
  await access(join(root, ".agent-team/inventory.yaml"));
  await access(join(root, ".agent-team/installation-manifest.yaml"));
});

test("inspect reports dirty and detached Git state", async () => {
  const root = await temporaryGitRepository();
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "dirty\n");
  assert.equal((await inspectProject(root)).repository.git.dirty, true);

  await execFileAsync("git", ["checkout", "--quiet", "--detach", "HEAD"], { cwd: root });
  const detached = await inspectProject(root);
  assert.equal(detached.repository.git.detached, true);
  assert.equal(detached.repository.git.branch, null);
});

test("adopt requires Git and leaves a non-repository untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-no-git-"));
  await writeFile(join(root, "source.txt"), "keep\n");

  await assert.rejects(() => adoptProject(root, {
    id: "no-git",
    name: "No Git",
    profile: "standard",
  }, "ADOPT-NO-GIT", lifecycleAuthorization), /GIT_REQUIRED/);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "keep\n");
  await assert.rejects(() => access(join(root, ".agent-team")), { code: "ENOENT" });
});

test("upgrade check and dry-run preserve overrides and approved content", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "upgrade-system",
    name: "Upgrade System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-4");
  const agentPath = join(root, ".codex/agents/lead-orchestrator.md");
  const missingContract = ".codex/agents/lead-orchestrator/output-contract.schema.json";
  const overriddenAgent = `${await readFile(agentPath, "utf8")}\nLocal override.\n`;
  await writeFile(agentPath, overriddenAgent);
  await rm(join(root, missingContract));
  const approvalsBefore = await readFile(join(root, ".agent-team/approvals.yaml"), "utf8");
  const artifactBefore = await readFile(join(root, ".agent-team/context/project-charter.md"), "utf8");
  const lock = await readYaml(root, ".agent-team/framework-lock.yaml");
  lock.framework.version = "0.0.0";
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/framework-lock.yaml", lock);

  const check = await planUpgrade(root, "check");
  const dryRun = await planUpgrade(root, "dry-run");
  assert.equal(check.conflicts[0].path, ".codex/agents/lead-orchestrator.md");
  assert.equal(check.conflicts[0].proposal_path, ".agent-team/overrides/upgrade/lead-orchestrator.md");
  assert.equal(check.current_version, "0.0.0");
  assert(check.changes.some(({ path, action }) => path === missingContract && action === "create"));
  assert(check.changes.some(({ path, action }) => path === ".agent-team/framework-lock.yaml" && action === "update"));
  assert.deepEqual(dryRun, { ...check, mode: "dry-run" });
  assert.equal(await readFile(agentPath, "utf8"), overriddenAgent);
  assert.equal(await readFile(join(root, ".agent-team/approvals.yaml"), "utf8"), approvalsBefore);
  assert.equal(await readFile(join(root, ".agent-team/context/project-charter.md"), "utf8"), artifactBefore);
  await assert.rejects(() => access(join(root, ".agent-team/overrides/upgrade/lead-orchestrator.md")), { code: "ENOENT" });
});

test("upgrade blocks an authoritative lock workflow mismatch", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "lock-mismatch",
    name: "Lock Mismatch",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-LOCK-MISMATCH", lifecycleAuthorization);
  const lock = await readYaml(root, ".agent-team/framework-lock.yaml");
  lock.workflow.version = "0.0.0";
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/framework-lock.yaml", lock);

  const result = await planUpgrade(root, "check");
  assert.equal(result.status, "blocked");
  const conflict = result.conflicts.find(({ path }) => path === ".agent-team/framework-lock.yaml");
  assert.equal(conflict.proposal_path, ".agent-team/overrides/upgrade/framework-lock.yaml");
  const proposal = result.proposals.find(({ path }) => path === conflict.proposal_path);
  assert.deepEqual(parse(proposal.content), {
    framework: { version: "0.1.0" },
    workflow: { id: "greenfield-standard", version: "1.0.0" },
  });
  await assert.rejects(() => access(join(root, conflict.proposal_path)), { code: "ENOENT" });
});

test("eject materializes project-owned overrides and disables upgrades", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "ejected-system",
    name: "Ejected System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-EJECTED", lifecycleAuthorization);

  const result = await ejectProject(root, "EJECT-1", lifecycleAuthorization);
  const project = await readYaml(root, ".agent-team/project.yaml");
  assert.equal(project.framework.management, "ejected");
  assert.deepEqual(result.materialized, [
    ".agent-team/overrides/agents.yaml",
    ".agent-team/overrides/workflow.yaml",
  ]);
  assert.equal((await readYaml(root, ".agent-team/overrides/workflow.yaml")).mode, "greenfield");
  assert(Array.isArray(await readYaml(root, ".agent-team/overrides/agents.yaml")));
  assert.equal((await planUpgrade(root, "check")).status, "ejected");
  const lock = await readYaml(root, ".agent-team/framework-lock.yaml");
  lock.workflow.version = "0.0.0";
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/framework-lock.yaml", lock);
  const blocked = await planUpgrade(root, "dry-run");
  const lockConflict = blocked.conflicts.find(({ path }) => path === ".agent-team/framework-lock.yaml");
  const lockProposal = blocked.proposals.find(({ path }) => path === lockConflict.proposal_path);
  assert.deepEqual(parse(lockProposal.content), {
    framework: { version: "0.1.0" },
    workflow: { id: "greenfield-standard", version: "1.0.0" },
  });
  await assert.rejects(() => access(join(root, lockConflict.proposal_path)), { code: "ENOENT" });
  assert.deepEqual(await ejectProject(root, "EJECT-1", lifecycleAuthorization), result);
  await assert.rejects(
    () => ejectProject(root, "EJECT-1", { ...lifecycleAuthorization, authorizationSource: "changed" }),
    /OPERATION_ID_CONFLICT/,
  );
});

test("ejected agent catalogue is authoritative for start, review, and doctor", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "catalogue-authority",
    name: "Catalogue Authority",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-5");
  await ejectProject(root, "EJECT-CATALOGUE", lifecycleAuthorization);
  const store = ProjectStore.open(root);
  const catalogue = await readYaml(root, ".agent-team/overrides/agents.yaml");
  catalogue.find(({ id }) => id === "lead-orchestrator").required_plugins = [];
  catalogue.find(({ id }) => id === "documentation-reviewer").required_plugins = [];
  await store.writeYamlAtomic(".agent-team/overrides/agents.yaml", catalogue);

  await startPhaseWithAdapter(root, "intake", "EJECTED-START", unavailablePluginAdapter);
  await setArtifactStatus(root, "PROJECT-CHARTER");
  await validatePhase(root, "intake", "EJECTED-VALIDATE");
  const reviewed = await reviewPhase(
    root, "intake", "documentation-reviewer", "approved", "EJECTED-REVIEW",
    unavailablePluginAdapter,
  );
  assert.equal(reviewed.phases.intake.status, "awaiting_approval");

  await store.writeYamlAtomic(
    ".agent-team/overrides/agents.yaml",
    catalogue.filter(({ id }) => id !== "documentation-reviewer"),
  );
  const plugins = (await doctor(root)).checks.find(({ name }) => name === "plugins");
  assert.equal(plugins.ok, false);
  assert.match(plugins.detail, /documentation-reviewer:AGENT_NOT_CONFIGURED/);
});

test("init records exact generated ownership and uninstall preserves non-owned paths", async () => {
  const root = await temporaryGitRepository();
  await mkdir(join(root, ".codex/agents"), { recursive: true });
  await writeFile(join(root, ".codex/user.txt"), "user-owned\n");
  await initProject(root, {
    id: "manifest-uninstall",
    name: "Manifest Uninstall",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-6");
  const manifest = await readYaml(root, ".agent-team/installation-manifest.yaml");
  const generated = manifest.files.filter(({ role }) => role === "generated_adapter");
  assert(generated.every(({ checksum }) => /^sha256:[a-f0-9]{64}$/.test(checksum)));
  assert(generated.some(({ path }) => path === ".codex/generated/.gitkeep"));
  assert(!manifest.directories_created.includes(".codex/agents"));
  const modified = generated.find(({ path }) => path.includes("lead-orchestrator"));
  await writeFile(join(root, modified.path), "local override\n");
  await writeFile(join(root, ".codex/agents/user.md"), "user-owned\n");

  const result = await uninstallProject(root, "UNINSTALL-MANIFEST", lifecycleAuthorization);
  assert(!result.removed.includes(modified.path));
  assert(result.preserved.includes(modified.path));
  assert.equal(await readFile(join(root, modified.path), "utf8"), "local override\n");
  assert.equal(await readFile(join(root, ".codex/agents/user.md"), "utf8"), "user-owned\n");
  assert.equal(await readFile(join(root, ".codex/user.txt"), "utf8"), "user-owned\n");
  await assert.rejects(() => access(join(root, ".codex/generated/.gitkeep")), { code: "ENOENT" });
  await access(join(root, ".codex/agents"));

  const preservedRoot = await temporaryGitRepository();
  await mkdir(join(preservedRoot, ".codex/generated"), { recursive: true });
  await mkdir(join(preservedRoot, ".codex/agents"), { recursive: true });
  await writeFile(join(preservedRoot, ".codex/generated/.gitkeep"), "");
  await initProject(preservedRoot, {
    id: "preexisting-manifest",
    name: "Preexisting Manifest",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-7");
  const preservedManifest = await readYaml(preservedRoot, ".agent-team/installation-manifest.yaml");
  assert(!preservedManifest.files.some(({ path }) => path === ".codex/generated/.gitkeep"));
  assert(!preservedManifest.directories_created.includes(".codex/generated"));
  await uninstallProject(preservedRoot, "UNINSTALL-PREEXISTING", lifecycleAuthorization);
  await access(join(preservedRoot, ".codex/generated/.gitkeep"));
  await access(join(preservedRoot, ".codex/generated"));
});

test("uninstall removes generated adapter files and preserves project memory", async () => {
  const root = await temporaryGitRepository();
  await mkdir(join(root, ".codex"));
  await writeFile(join(root, ".codex/keep.txt"), "user-owned\n");
  await initProject(root, {
    id: "uninstalled-system",
    name: "Uninstalled System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-8");
  const approvalsBefore = await readFile(join(root, ".agent-team/approvals.yaml"), "utf8");

  const result = await uninstallProject(root, "UNINSTALL-1", lifecycleAuthorization);
  assert.deepEqual(result.preserved, [".agent-team"]);
  assert.equal(await readFile(join(root, ".codex/keep.txt"), "utf8"), "user-owned\n");
  assert.equal(await readFile(join(root, ".agent-team/approvals.yaml"), "utf8"), approvalsBefore);
  await access(join(root, ".agent-team/project.yaml"));
  await assert.rejects(() => access(join(root, ".codex/agents/lead-orchestrator.md")), { code: "ENOENT" });
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert(audit.some(({ action, authorization_source, result }) =>
    action === "uninstall" && authorization_source === "test_authorization" && result === "success"));
  assert.deepEqual(await uninstallProject(root, "UNINSTALL-1", lifecycleAuthorization), result);
  await assert.rejects(
    () => uninstallProject(root, "UNINSTALL-1", { ...lifecycleAuthorization, authorizationSource: "changed" }),
    /OPERATION_ID_CONFLICT/,
  );
});

test("uninstall does not follow a generated-path link outside the project", async (t) => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "linked-uninstall",
    name: "Linked Uninstall",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-9");
  const generated = join(root, ".codex/agents/lead-orchestrator.md");
  const outside = await mkdtemp(join(tmpdir(), "system-design-team-outside-agent-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "lead-orchestrator.md");
  await writeFile(outsideFile, await readFile(generated, "utf8"));
  await rm(join(root, ".codex/agents"), { recursive: true });
  await symlink(outside, join(root, ".codex/agents"), "junction");

  const result = await uninstallProject(root, "UNINSTALL-LINK", lifecycleAuthorization);

  assert(!result.removed.includes(".codex/agents/lead-orchestrator.md"));
  assert.equal(await readFile(outsideFile, "utf8"), await readFile(generated, "utf8"));
});

test("uninstall never deletes before its durable plan and started audit", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "uninstall-plan-failure",
    name: "Uninstall Plan Failure",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-10");
  const generated = join(root, ".codex/agents/lead-orchestrator.md");
  await mkdir(join(root, ".agent-team/uninstall-plan.yaml"));

  await assert.rejects(
    () => uninstallProject(root, "UNINSTALL-PLAN-FAIL", lifecycleAuthorization),
  );
  await access(generated);
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert(!audit.some(({ action }) => action === "uninstall-started"));
});

test("uninstall does not delete when the started audit append fails", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "uninstall-audit-failure",
    name: "Uninstall Audit Failure",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-11");
  const generated = join(root, ".codex/agents/lead-orchestrator.md");

  await assert.rejects(() => uninstallProject(
    root,
    "UNINSTALL-AUDIT-FAIL",
    lifecycleAuthorization,
    { transactionFault: (point) => { if (point === "before_audit_append") throw new Error("audit fault"); } },
  ), /audit fault/);
  await access(generated);
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert(!audit.some(({ action }) => action === "uninstall-started"));

  const resumed = await uninstallProject(root, "UNINSTALL-AUDIT-FAIL", lifecycleAuthorization);
  assert(resumed.removed.includes(".codex/agents/lead-orchestrator.md"));
});

test("uninstall resumes a durably planned operation after a mid-delete failure", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "uninstall-resume",
    name: "Uninstall Resume",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-12");
  const manifest = await readYaml(root, ".agent-team/installation-manifest.yaml");
  const planned = manifest.files.filter(({ role }) => role === "generated_adapter")
    .sort((left, right) => left.path.localeCompare(right.path));
  const first = planned[0];
  const blocked = planned[1];
  const blockedPath = join(root, blocked.path);
  const blockedContent = await readFile(blockedPath, "utf8");
  await rm(blockedPath);
  await mkdir(blockedPath);

  await assert.rejects(
    () => uninstallProject(root, "UNINSTALL-RESUME", lifecycleAuthorization),
  );
  await assert.rejects(() => access(join(root, first.path)), { code: "ENOENT" });
  const started = await readYaml(root, ".agent-team/uninstall-plan.yaml");
  assert.equal(started.status, "started");
  const startedAudit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert(startedAudit.some(({ action }) => action === "uninstall-started"));
  assert(!startedAudit.some(({ action }) => action === "uninstall"));

  await rm(blockedPath, { recursive: true });
  await writeFile(blockedPath, blockedContent);
  const completed = await uninstallProject(root, "UNINSTALL-RESUME", lifecycleAuthorization);
  assert.equal((await readYaml(root, ".agent-team/uninstall-plan.yaml")).status, "completed");
  assert(completed.removed.includes(first.path));
  assert(completed.removed.includes(blocked.path));
});

test("lifecycle audit records carry authorization and artifact context", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-13");

  const [event] = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(AuditEventSchema.parse(event), event);
  assert.equal(event.actor.type, "system");
  assert.equal(event.actor.identifier, "system-design-team-api");
  assert.equal(event.authorization_source, "api_invocation");
  assert.equal(event.permission_profile, "standard");
  assert.deepEqual(event.artifact_versions, {});
});

test("init materializes complete workflow assets and Codex agent instructions", async () => {
  for (const [mode, workflowFile] of [
    ["greenfield", "greenfield.yaml"],
    ["existing_system", "existing-system.yaml"],
    ["migration", "migration.yaml"],
  ]) {
    const root = await temporaryGitRepository();
    await initProject(root, {
      id: `${mode}-project`,
      name: `${mode} project`,
      mode,
      profile: "standard",
    }, "INIT-CLI-14");
    const workflow = WorkflowDefinitionSchema.parse(
      parse(await readFile(join(repository, "workflows", workflowFile), "utf8")),
    );
    const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
    assert.equal(registry.artifacts.length, workflow.phases.length);
    for (const phase of workflow.phases) {
      const artifact = registry.artifacts.find(({ id }) => id === phase.artifact.id);
      assert.equal(artifact.type, "document");
      assert.match(artifact.checksum, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(artifact.dependencies, phase.depends_on.map((dependency) => ({
        artifact_id: workflow.phases.find(({ id }) => id === dependency).artifact.id,
        version: 1,
        type: "hard_dependency",
      })));
      assert.deepEqual(artifact.consumers, workflow.phases
        .filter(({ depends_on }) => depends_on.includes(phase.id))
        .map(({ artifact: dependentArtifact }) => dependentArtifact.id));
      const text = await readFile(join(root, ".agent-team", phase.artifact.path), "utf8");
      assert.match(text, new RegExp(`artifact_id: ${phase.artifact.id}`));
      assert.match(text, new RegExp(`owner: ${phase.owner}`));
      assert.match(text, /^## Purpose$/m);
    }

    const participants = new Set(workflow.phases.flatMap(({ owner, reviewer }) => [owner, reviewer]));
    for (const id of participants) {
      const text = await readFile(join(root, ".codex/agents", `${id}.md`), "utf8");
      assert.match(text, /generated by System Design Team/i);
      assert.match(text, /^## Mission$/m);
      assert.match(text, /^## Allowed actions$/m);
      assert.match(text, /^## Prohibited actions$/m);
      assert.match(text, /^## Required outputs$/m);
      assert.match(text, /^## Independent reviewer$/m);
      assert.match(text, /^## Required plugins$/m);
    }

    const catalogue = AgentManifestSchema.array().parse(
      parse(await readFile(join(repository, "agents/catalogue.yaml"), "utf8")),
    );
    for (const agent of catalogue) {
      const directory = join(root, ".codex/agents", agent.id);
      assert.deepEqual(
        AgentManifestSchema.parse(parse(await readFile(join(directory, "agent.yaml"), "utf8"))),
        agent,
      );
      assert.match(await readFile(join(directory, "instructions.md"), "utf8"), /^## Mission$/m);
      const inputContract = JSON.parse(await readFile(join(directory, "input-contract.schema.json"), "utf8"));
      const outputContract = JSON.parse(await readFile(join(directory, "output-contract.schema.json"), "utf8"));
      assert.equal(inputContract.type, "object");
      assert(inputContract.required.includes("objective"));
      assert.equal(outputContract.type, "object");
      assert(outputContract.required.includes("execution_id"));
      const checklist = parse(await readFile(join(directory, "review-checklist.yaml"), "utf8"));
      assert.equal(checklist.agent, agent.id);
      assert.equal(checklist.reviewer, agent.reviewer);
      assert(checklist.checks.length > 0);
    }
  }
});

test("artifact and trace read operations expose persisted integrity", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-15");

  const artifacts = await artifactList(root);
  const projectCharter = await artifactInspect(root, "PROJECT-CHARTER");
  assert.equal(artifacts.some(({ id }) => id === "PROJECT-CHARTER"), true);
  assert.equal(projectCharter.checksum_valid, true);
  assert.deepEqual(await artifactValidate(root, "PROJECT-CHARTER"), {
    artifact_id: "PROJECT-CHARTER",
    valid: true,
    findings: [],
  });
  assert.deepEqual(await traceCheck(root), { valid: true, findings: [] });
  assert.deepEqual(await traceCoverageReport(root), { total: 0, covered: 0, percentage: 100 });
  assert.deepEqual(await staleList(root), []);
  const bin = join(repository, "packages/cli/dist/bin.js");
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "artifact", "list"], { cwd: root })).stdout).length, artifacts.length);
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "artifact", "inspect", "PROJECT-CHARTER"], { cwd: root })).stdout).checksum_valid, true);
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "artifact", "validate", "PROJECT-CHARTER"], { cwd: root })).stdout).valid, true);
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "trace", "check"], { cwd: root })).stdout).valid, true);
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "trace", "coverage"], { cwd: root })).stdout).percentage, 100);
  assert.deepEqual(JSON.parse((await execFileAsync(process.execPath, [bin, "stale", "list"], { cwd: root })).stdout), []);

  await writeFile(
    join(root, ".agent-team", projectCharter.path),
    `${await readFile(join(root, ".agent-team", projectCharter.path), "utf8")}tampered\n`,
  );
  assert.equal((await artifactInspect(root, "PROJECT-CHARTER")).checksum_valid, false);
  assert.equal((await artifactValidate(root, "PROJECT-CHARTER")).findings[0].code, "ARTIFACT_CHECKSUM_MISMATCH");
});

test("change creation stales direct and downstream artifacts and invalidates their approvals", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-16");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.intake = { status: "approved", approval_id: "APR-G0" };
  state.phases["business-discovery"] = { status: "approved", approval_id: "APR-G1" };
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  await store.writeYamlAtomic(".agent-team/approvals.yaml", { approvals: [
    {
      id: "APR-G0", gate: "G0", decision: "approved",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "PROJECT-CHARTER": 1 }, timestamp: "2026-07-12T00:00:00Z",
    },
    {
      id: "APR-G1", gate: "G1", decision: "approved",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "BUSINESS-CONTEXT": 1 }, timestamp: "2026-07-12T00:00:00Z",
    },
    {
      id: "APR-G9", gate: "G9", decision: "approved",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "POST-RELEASE-REVIEW": 1 }, timestamp: "2026-07-12T00:00:00Z",
    },
  ] });

  const bin = join(repository, "packages/cli/dist/bin.js");
  const result = JSON.parse((await execFileAsync(process.execPath, [
    bin, "change", "create", "CR-001",
    "--by", "product-owner",
    "--artifacts", " PROJECT-CHARTER ",
    "--reason", "Approved scope changed.",
    "--impact", "high",
    "--reapprovals", " G1, G9 ",
    "--operation-id", "CHANGE-001",
  ], { cwd: root })).stdout);

  assert(result.stale_artifacts.includes("PROJECT-CHARTER"));
  assert(result.stale_artifacts.includes("BUSINESS-CONTEXT"));
  assert.equal((await staleList(root)).some(({ id }) => id === "BUSINESS-CONTEXT"), true);
  const changedState = await store.readWorkflowState();
  assert.equal(changedState.phases.intake.status, "revision_required");
  assert.equal(changedState.phases["business-discovery"].status, "revision_required");
  const approvals = await readYaml(root, ".agent-team/approvals.yaml");
  assert.equal(approvals.approvals.find(({ id }) => id === "APR-G0").decision, "revoked");
  assert.equal(approvals.approvals.find(({ id }) => id === "APR-G1").decision, "revoked");
  assert.equal(approvals.approvals.find(({ id }) => id === "APR-G9").decision, "revoked");
  const events = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "change").length, 1);

  const replayInput = {
    id: "CR-001",
    requested_by: "product-owner",
    affected_artifacts: ["PROJECT-CHARTER"],
    reason: "Approved scope changed.",
    impact: { scope: "high", architecture: "high", security: "high", schedule: "high" },
    required_reapprovals: ["G1", "G9"],
  };
  assert.deepEqual((await createChange(root, replayInput, "CHANGE-001")).change, replayInput);
  await assert.rejects(
    () => createChange(root, { ...replayInput, reason: "Conflicting replay." }, "CHANGE-001"),
    /OPERATION_ID_CONFLICT/,
  );
});

test("required reapproval reopens its approved phase without staling unrelated artifacts", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-17");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.intake = { status: "approved", approval_id: "APR-G0" };
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  await store.writeYamlAtomic(".agent-team/approvals.yaml", { approvals: [{
    id: "APR-G0", gate: "G0", decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { "PROJECT-CHARTER": 1 }, timestamp: "2026-07-12T00:00:00Z",
  }] });

  await createChange(root, {
    id: "CR-REAPPROVE",
    requested_by: "product-owner",
    affected_artifacts: ["POST-RELEASE-REVIEW"],
    reason: "Reapprove the charter without changing it.",
    impact: { scope: "low", architecture: "low", security: "low", schedule: "low" },
    required_reapprovals: ["G0"],
  }, "CHANGE-REAPPROVE");

  const next = await store.readWorkflowState();
  assert.equal(next.phases.intake.status, "revision_required");
  assert.equal(next.phases.intake.approval_id, undefined);
  const staleIds = new Set((await staleList(root)).map(({ id }) => id));
  assert.equal(staleIds.has("POST-RELEASE-REVIEW"), true);
  assert.equal(staleIds.has("PROJECT-CHARTER"), false);
});

test("checksum drift blocks review, approval, handover, and dependent dispatch", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-18");
  await enableAllPlugins(root);
  await setArtifactStatus(root, "PROJECT-CHARTER");
  await startPhase(root, "intake", "CHECKSUM-START");
  await validatePhase(root, "intake", "CHECKSUM-VALIDATE");
  const path = join(root, ".agent-team/context/project-charter.md");
  const original = await readFile(path, "utf8");
  const tamper = () => writeFile(path, `${original}\nUnregistered edit.`);
  const restore = () => writeFile(path, original);

  await tamper();
  await assert.rejects(
    () => reviewPhase(root, "intake", "documentation-reviewer", "approved", "CHECKSUM-REVIEW"),
    /ARTIFACT_CHECKSUM_MISMATCH/,
  );
  await restore();
  await reviewPhase(root, "intake", "documentation-reviewer", "approved", "CHECKSUM-REVIEW");

  await tamper();
  await assert.rejects(() => approve(root, "G0", "project-owner", "CHECKSUM-APPROVE"), /ARTIFACT_CHECKSUM_MISMATCH/);
  await restore();
  await approve(root, "G0", "project-owner", "CHECKSUM-APPROVE");

  await tamper();
  await assert.rejects(() => handover(root, "intake", "CHECKSUM-HANDOVER"), /APPROVED_INPUT_STALE/);
  await restore();
  await handover(root, "intake", "CHECKSUM-HANDOVER");

  await tamper();
  await assert.rejects(() => startPhase(root, "business-discovery", "CHECKSUM-DISPATCH"), /APPROVED_INPUT_STALE/);
});

test("init rejects partial state without touching existing project data", async () => {
  const root = await temporaryGitRepository();
  await mkdir(join(root, ".agent-team"));
  await writeFile(join(root, ".agent-team/partial.txt"), "user data\n");
  await mkdir(join(root, ".codex/generated"), { recursive: true });
  await writeFile(join(root, ".codex/generated/existing.txt"), "keep\n");

  await assert.rejects(() => initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-19"), /ALREADY_INITIALIZED/);

  assert.equal(await readFile(join(root, ".agent-team/partial.txt"), "utf8"), "user data\n");
  assert.equal(await readFile(join(root, ".codex/generated/existing.txt"), "utf8"), "keep\n");
  assert.deepEqual(await readdir(join(root, ".agent-team")), ["partial.txt"]);
});

test("init rejects a linked state directory without writing through it", async (t) => {
  const root = await temporaryGitRepository();
  const outside = await mkdtemp(join(tmpdir(), "system-design-team-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "sentinel.txt"), "keep\n");
  try {
    await symlink(outside, join(root, ".agent-team"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(() => initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-20"), /ALREADY_INITIALIZED/);
  assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
  assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "keep\n");
});

test("init rolls back new state when the existing Codex path is unsafe", async (t) => {
  const root = await temporaryGitRepository();
  const outside = await mkdtemp(join(tmpdir(), "system-design-team-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, ".codex"));
  await writeFile(join(outside, "sentinel.txt"), "keep\n");
  try {
    await symlink(outside, join(root, ".codex/generated"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(() => initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-21"), /PATH_OUTSIDE_PROJECT/);
  await assert.rejects(() => lstat(join(root, ".agent-team")), { code: "ENOENT" });
  assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
});

test("canonical assets parse as the complete catalogue and workflows", async () => {
  const catalogue = AgentManifestSchema.array().parse(
    parse(await readFile(join(repository, "agents/catalogue.yaml"), "utf8")),
  );
  assert.equal(catalogue.length, 21);

  for (const [file, mode] of [
    ["greenfield.yaml", "greenfield"],
    ["existing-system.yaml", "existing_system"],
    ["migration.yaml", "migration"],
  ]) {
    const workflow = WorkflowDefinitionSchema.parse(
      parse(await readFile(join(repository, "workflows", file), "utf8")),
    );
    assert.equal(workflow.mode, mode);
    assert(workflow.phases.length >= 11);
  }
});

test("built CLI contains the canonical bootstrap assets", async () => {
  const builtAssets = join(repository, "packages/cli/dist/assets");
  const catalogue = AgentManifestSchema.array().parse(
    parse(await readFile(join(builtAssets, "agents/catalogue.yaml"), "utf8")),
  );
  assert.equal(catalogue.length, 21);
  for (const file of ["greenfield.yaml", "existing-system.yaml", "migration.yaml"]) {
    WorkflowDefinitionSchema.parse(
      parse(await readFile(join(builtAssets, "workflows", file), "utf8")),
    );
  }
  assert.match(await readFile(join(builtAssets, "templates/handover.yaml"), "utf8"), /from_agent/);
});

test("start checks the phase owner plugin before changing state and replays safely", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-22");
  const before = await ProjectStore.open(root).readWorkflowState();

  await assert.rejects(
    startPhase(root, "intake", "OP-START-INTAKE", unavailablePluginAdapter),
    /REQUIRED_PLUGIN_UNKNOWN/,
  );
  assert.deepEqual(await ProjectStore.open(root).readWorkflowState(), before);

  await setPluginStatus(
    root,
    pluginUri,
    "available",
    ["brainstorming", "writing-plans", "verification-before-completion"],
  );
  await assert.rejects(
    startPhase(root, "intake", "OP-START-INTAKE", availabilityOnlyPluginAdapter),
    /PLUGIN_INVOCATION_FAILED/,
  );
  assert.deepEqual(await ProjectStore.open(root).readWorkflowState(), before);

  const invoked = [];
  const invokingAdapter = {
    ...pluginAdapter,
    async invoke(request) {
      invoked.push(request);
      return {
        plugin_uri: request.plugin_uri,
        publisher_identity: "openai-curated-remote",
        status: "success",
        output: { ok: true },
        execution_reference: `runtime-${invoked.length}`,
        started_at: "2026-07-14T00:00:00.000Z",
        completed_at: "2026-07-14T00:00:01.000Z",
      };
    },
  };
  const started = await startPhase(root, "intake", "OP-START-INTAKE", invokingAdapter);
  assert.equal(started.phases.intake.status, "in_progress");
  assert.equal(started.state_version, before.state_version + 1);
  assert.equal(invoked.length, 3);
  const evidence = await readYaml(root, ".agent-team/plugin-invocations.yaml");
  const parentOperationId = operationKey("start", "intake", "OP-START-INTAKE");
  assert.deepEqual(evidence.invocations.map(({ agent_id, phase, operation_id }) => ({
    agent_id,
    phase,
    operation_id,
  })), ["brainstorming", "writing-plans", "verification-before-completion"].map((skill) => ({
    agent_id: "lead-orchestrator",
    phase: "intake",
    operation_id: operationKey(
      "lifecycle-plugin",
      pluginUri,
      JSON.stringify([parentOperationId, "lead-orchestrator", "intake", skill]),
    ),
  })));
  assert.deepEqual(await startPhase(root, "intake", "OP-START-INTAKE", invokingAdapter), started);
  assert.equal(invoked.length, 3);
});

test("lifecycle plugin invocations are valid audited evidence", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-LIFECYCLE-AUDIT");

  await startPhase(root, "intake", "LIFECYCLE-AUDIT-START");

  const report = await evidenceVerify(root);
  assert.equal(report.valid, true, JSON.stringify(report.findings));
  assert.equal(report.verified.plugin_invocations, 3);
});

test("completed start replay requires exact invocation evidence and audit", async () => {
  const missingRoot = await temporaryGitRepository();
  await initProject(missingRoot, {
    id: "missing-evidence",
    name: "Missing Evidence",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-MISSING-EVIDENCE");
  await startPhase(missingRoot, "intake", "REPLAY-EVIDENCE-START");
  const missing = await readYaml(missingRoot, ".agent-team/plugin-invocations.yaml");
  missing.invocations.shift();
  await ProjectStore.open(missingRoot).writeYamlAtomic(".agent-team/plugin-invocations.yaml", missing);
  await assert.rejects(
    () => startPhase(missingRoot, "intake", "REPLAY-EVIDENCE-START"),
    /REQUIRED_PLUGIN_INVOCATION_MISSING/,
  );

  const auditRoot = await temporaryGitRepository();
  await initProject(auditRoot, {
    id: "missing-audit",
    name: "Missing Audit",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-MISSING-AUDIT");
  await startPhase(auditRoot, "intake", "REPLAY-AUDIT-START");
  const auditPath = join(auditRoot, ".agent-team/audit/events.jsonl");
  const audits = (await readFile(auditPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const invocationAudit = audits.find(({ action, result }) => action === "plugin-invocation" && result === "success");
  invocationAudit.target = "plugin://mismatched@example";
  await writeFile(auditPath, `${audits.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(
    () => startPhase(auditRoot, "intake", "REPLAY-AUDIT-START"),
    /PLUGIN_INVOCATION_AUDIT_MISMATCH/,
  );
});

test("partial required-plugin success is durable and replay-safe", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "partial-plugin",
    name: "Partial Plugin",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-PARTIAL-PLUGIN");
  const calls = [];
  let failWritingPlans = true;
  const adapter = {
    ...pluginAdapter,
    async invoke(request) {
      calls.push(request.skill);
      if (request.skill === "writing-plans" && failWritingPlans) {
        failWritingPlans = false;
        throw new Error("SECOND_SKILL_FAILED");
      }
      return pluginAdapter.invoke(request);
    },
  };

  await assert.rejects(
    () => startPhase(root, "intake", "PARTIAL-PLUGIN-START", adapter),
    /PLUGIN_INVOCATION_FAILED/,
  );
  const partial = await readYaml(root, ".agent-team/plugin-invocations.yaml");
  assert.deepEqual(partial.invocations.map(({ skill }) => skill), ["brainstorming"]);

  const started = await startPhase(root, "intake", "PARTIAL-PLUGIN-START", adapter);
  assert.equal(started.phases.intake.status, "in_progress");
  assert.deepEqual(calls, [
    "brainstorming",
    "writing-plans",
    "writing-plans",
    "verification-before-completion",
  ]);
});

test("validate checks registered artifacts before entering artifact validation", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-23");
  await setPluginStatus(
    root,
    pluginUri,
    "available",
    ["brainstorming", "writing-plans", "verification-before-completion"],
  );
  await startPhase(root, "intake", "OP-START-INTAKE");
  await setArtifactStatus(root, "PROJECT-CHARTER", { body: "TODO: confirm scope" });

  const invalid = await validatePhase(root, "intake", "OP-VALIDATE-INTAKE");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.state.phases.intake.status, "in_progress");
  assert.equal(invalid.findings[0].code, "PROHIBITED_PLACEHOLDER");

  await setArtifactStatus(root, "PROJECT-CHARTER");
  const valid = await validatePhase(root, "intake", "OP-VALIDATE-INTAKE");
  assert.equal(valid.valid, true);
  assert.equal(valid.state.phases.intake.status, "artifact_validation");
});

test("validate rejects draft registry and front-matter statuses", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-24");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await startPhase(root, "intake", "OP-START");

  const registryDraft = await validatePhase(root, "intake", "OP-REGISTRY-DRAFT");
  assert.equal(registryDraft.valid, false);
  assert.equal(registryDraft.state.phases.intake.status, "in_progress");
  assert(registryDraft.findings.some(({ code }) => code === "ARTIFACT_NOT_REVIEW_READY"));

  await setArtifactStatus(root, "PROJECT-CHARTER", {
    registryStatus: "in_review",
    fileStatus: "draft",
  });
  const frontMatterDraft = await validatePhase(root, "intake", "OP-FRONT-MATTER-DRAFT");
  assert.equal(frontMatterDraft.valid, false);
  assert.equal(frontMatterDraft.state.phases.intake.status, "in_progress");
  assert(frontMatterDraft.findings.some(({ code }) => code === "ARTIFACT_NOT_REVIEW_READY"));
});

test("scopes identical raw operation IDs to their action and target", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-25");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await setArtifactStatus(root, "PROJECT-CHARTER");

  await startPhase(root, "intake", "SAME-RAW-ID");
  const validated = await validatePhase(root, "intake", "SAME-RAW-ID");
  assert.equal(validated.state.phases.intake.status, "artifact_validation");
  assert(validated.state.completed_operations.includes(
    operationKey("start", "intake", "SAME-RAW-ID"),
  ));
  assert(validated.state.completed_operations.includes(
    operationKey("validate", "intake", "SAME-RAW-ID"),
  ));
});

test("every reviewed phase requires an adapter-collected execution receipt", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-REVIEW-RECEIPT");
  await setPluginStatus(root, pluginUri, "available", [
    "brainstorming",
    "writing-plans",
    "verification-before-completion",
  ]);
  await enterArtifactValidation(root, "intake", "PROJECT-CHARTER", "RECEIPT-REQUIRED");

  await assert.rejects(() => reviewPhaseWithAdapter(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    "OP-RECEIPT-REQUIRED",
    pluginAdapter,
  ), /REVIEW_EXECUTION_RECEIPT_REQUIRED/);
  assert.deepEqual((await readYaml(root, ".agent-team/reviews.yaml")).reviews, []);
});

test("review records independent evidence and applies two idempotent state updates", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-26");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  const validated = await enterArtifactValidation(root, "intake", "PROJECT-CHARTER", "REVIEW");

  await assert.rejects(() => reviewPhase(
    root,
    "intake",
    "lead-orchestrator",
    "approved",
    "OP-INVALID-REVIEW",
  ), /REVIEWER_EXECUTION_IDENTITY_MISMATCH/);
  assert.deepEqual((await readYaml(root, ".agent-team/reviews.yaml")).reviews, []);

  const reviewed = await reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    "OP-REVIEW",
  );
  const evidence = await readYaml(root, ".agent-team/reviews.yaml");
  assert.equal(reviewed.phases.intake.status, "awaiting_approval");
  assert.equal(reviewed.phases.intake.review_id, evidence.reviews[0].id);
  assert.equal(reviewed.state_version, validated.state.state_version + 2);
  assert.equal(evidence.reviews[0].id, operationKey("review", "intake", "OP-REVIEW"));
  assert.deepEqual(evidence.reviews[0].artifact_versions, { "PROJECT-CHARTER": 1 });
  assert.deepEqual(await reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    "OP-REVIEW",
  ), reviewed);
  await setArtifactStatus(root, "PROJECT-CHARTER", { version: 2 });
  await assert.rejects(() => reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    "OP-REVIEW",
  ), /OPERATION_ID_CONFLICT/);
  assert.equal((await readYaml(root, ".agent-team/reviews.yaml")).reviews.length, 1);
  await assert.rejects(() => reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "revision_required",
    "OP-REVIEW",
  ), /OPERATION_ID_CONFLICT/);
  await assert.rejects(() => reviewPhase(
    root,
    "intake",
    "lead-orchestrator",
    "approved",
    "OP-REVIEW",
  ), /OPERATION_ID_CONFLICT/);
});

test("review can require revision without automated reviewer execution", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-27");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  const validated = await enterArtifactValidation(root, "intake", "PROJECT-CHARTER", "REVISION");

  const reviewed = await reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "revision_required",
    "OP-REVISION",
  );
  assert.equal(reviewed.phases.intake.status, "revision_required");
  assert.equal(reviewed.state_version, validated.state.state_version + 2);
});

test("review checks the configured reviewer plugin before recording evidence", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-28");
  await setArtifactStatus(root, "UX-HANDOFF");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.ux.status = "artifact_validation";
  state.current_phase = "ux";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  await setPluginStatus(root, "plugin://ux-design@wondelai-skills", "available", []);

  await assert.rejects(
    () => reviewPhase(root, "ux", "ux-reviewer", "approved", "OP-UX-REVIEW", unavailablePluginAdapter),
    /REQUIRED_PLUGIN_UNKNOWN/,
  );
  assert.deepEqual((await readYaml(root, ".agent-team/reviews.yaml")).reviews, []);

  const reviewed = await reviewPhase(root, "ux", "ux-reviewer", "approved", "OP-UX-REVIEW");
  assert.equal(reviewed.phases.ux.status, "awaiting_approval");
});

test("completed review replay requires its exact audited plugin invocation", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "review-replay",
    name: "Review Replay",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-REVIEW-REPLAY");
  await setArtifactStatus(root, "UX-HANDOFF");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.ux.status = "artifact_validation";
  state.current_phase = "ux";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);

  const reviewed = await reviewPhase(root, "ux", "ux-reviewer", "approved", "REVIEW-REPLAY");
  assert.equal(reviewed.phases.ux.status, "awaiting_approval");
  const invocations = await readYaml(root, ".agent-team/plugin-invocations.yaml");
  await store.writeYamlAtomic(".agent-team/plugin-invocations.yaml", {
    invocations: invocations.invocations.filter(({ agent_id }) => agent_id !== "ux-reviewer"),
  });
  await assert.rejects(
    () => reviewPhase(root, "ux", "ux-reviewer", "approved", "REVIEW-REPLAY"),
    /REQUIRED_PLUGIN_INVOCATION_MISSING/,
  );

  await store.writeYamlAtomic(".agent-team/plugin-invocations.yaml", invocations);
  const report = await evidenceVerify(root);
  assert.equal(report.valid, true, JSON.stringify(report.findings));
});

test("approve persists registry-bound evidence and is idempotent", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-29");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  const awaiting = await requirementsAwaitingApproval(root, "APPROVAL");

  const approved = await approve(root, "G2", "  project-owner  ", "OP-APPROVE-G2");
  const evidence = await readYaml(root, ".agent-team/approvals.yaml");
  const approval = evidence.approvals.find(({ gate }) => gate === "G2");
  assert.equal(approved.phases.requirements.status, "approved");
  assert.equal(approved.state_version, awaiting.state_version + 1);
  assert.deepEqual(approval.artifact_versions, { REQUIREMENTS: 1 });
  assert.equal(approval.approved_by.identifier, "project-owner");
  assert.equal(approval.id, operationKey("approve", "G2", "OP-APPROVE-G2"));

  await setArtifactStatus(root, "REQUIREMENTS", { version: 2 });
  assert.deepEqual(await approve(root, "G2", "project-owner", "OP-APPROVE-G2"), approved);
  await assert.rejects(
    () => approve(root, "G2", "alternate-owner", "OP-APPROVE-G2"),
    /OPERATION_ID_CONFLICT/,
  );
  assert.equal(
    (await readYaml(root, ".agent-team/approvals.yaml")).approvals
      .filter(({ gate }) => gate === "G2").length,
    1,
  );
});

test("approval rejects artifact versions that were not independently reviewed", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-30");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await requirementsAwaitingApproval(root, "VERSION-BINDING");
  await setArtifactStatus(root, "REQUIREMENTS", { version: 2 });

  await assert.rejects(
    () => approve(root, "G2", "project-owner", "OP-UNREVIEWED-V2"),
    /REVIEW_VERSION_MISMATCH/,
  );
  assert.equal(
    (await readYaml(root, ".agent-team/approvals.yaml")).approvals
      .filter(({ gate }) => gate === "G2").length,
    0,
  );
  assert.equal((await ProjectStore.open(root).readWorkflowState()).phases.requirements.status, "awaiting_approval");
});

test("approval rejects non-ready artifacts and trimmed self-approval", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-31");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await requirementsAwaitingApproval(root, "REJECTION");
  await setArtifactStatus(root, "REQUIREMENTS", {
    registryStatus: "stale",
    fileStatus: "stale",
  });
  await assert.rejects(
    () => approve(root, "G2", "project-owner", "OP-DRAFT"),
    /ARTIFACT_NOT_REVIEW_READY/,
  );

  await setArtifactStatus(root, "REQUIREMENTS");
  await assert.rejects(
    () => approve(root, "G2", " business-analyst ", "OP-SELF"),
    /SELF_APPROVAL_FORBIDDEN/,
  );
  assert.equal(
    (await readYaml(root, ".agent-team/approvals.yaml")).approvals
      .filter(({ gate }) => gate === "G2").length,
    0,
  );
});

test("handover writes a valid record and advances each directly dependent phase separately", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-32");
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await requirementsAwaitingApproval(root, "HANDOVER");
  const approved = await approve(root, "G2", "project-owner", "OP-APPROVE-REQ");
  await setArtifactStatus(root, "REQUIREMENTS", { version: 2 });

  await assert.rejects(
    () => handover(root, "requirements", "OP-HANDOVER-REQ"),
    /APPROVED_INPUT_STALE/,
  );
  await assert.rejects(
    () => access(join(root, ".agent-team/handovers/requirements.yaml")),
    { code: "ENOENT" },
  );
  await setArtifactStatus(root, "REQUIREMENTS", { version: 1 });

  const handedOver = await handover(root, "requirements", "OP-HANDOVER-REQ");
  const record = HandoverRecordSchema.parse(
    await readYaml(root, ".agent-team/handovers/requirements.yaml"),
  );
  assert.equal(record.id, operationKey("handover", "requirements", "OP-HANDOVER-REQ"));
  assert.equal(record.phase, "requirements");
  assert.equal(record.from_agent, "business-analyst");
  assert.equal(record.to_agent, "product-owner");
  assert.deepEqual(record.approved_inputs, ["REQUIREMENTS@1"]);
  assert.equal(handedOver.phases.requirements.status, "handed_over");
  assert.equal(handedOver.phases.product.status, "ready");
  assert.equal(handedOver.state_version, approved.state_version + 2);
  assert.match(handedOver.phases.requirements.handover_digest, /^[a-f0-9]{64}$/);

  const originalDigest = handedOver.phases.requirements.handover_digest;
  const tamperedInputs = HandoverRecordSchema.parse({ ...record, approved_inputs: ["REQUIREMENTS@999"] });
  await ProjectStore.open(root).writeYamlAtomic(
    ".agent-team/handovers/requirements.yaml",
    tamperedInputs,
  );
  const tamperedState = await ProjectStore.open(root).readWorkflowState();
  tamperedState.phases.requirements.handover_digest = createHash("sha256")
    .update(JSON.stringify(tamperedInputs)).digest("hex");
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/workflow-state.yaml", tamperedState);
  await assert.rejects(
    () => handover(root, "requirements", "OP-HANDOVER-REQ"),
    /HANDOVER_EVIDENCE_CONFLICT/,
  );
  tamperedState.phases.requirements.handover_digest = originalDigest;
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/workflow-state.yaml", tamperedState);
  await ProjectStore.open(root).writeYamlAtomic(
    ".agent-team/handovers/requirements.yaml",
    { ...record, acceptance_conditions: ["Tampered condition"] },
  );
  await assert.rejects(
    () => handover(root, "requirements", "OP-HANDOVER-REQ"),
    /HANDOVER_EVIDENCE_CONFLICT/,
  );
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/handovers/requirements.yaml", record);

  const auditPath = join(root, ".agent-team/audit/events.jsonl");
  const handoverId = operationKey("handover", "requirements", "OP-HANDOVER-REQ");
  const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
  await ProjectStore.open(root).writeTextAtomic(
    ".agent-team/audit/events.jsonl",
    `${audit.filter(({ id }) => id !== handoverId).map(JSON.stringify).join("\n")}\n`,
  );
  await setArtifactStatus(root, "REQUIREMENTS", { version: 2 });

  assert.deepEqual(await handover(root, "requirements", "OP-HANDOVER-REQ"), handedOver);
  assert.deepEqual(
    (await readYaml(root, ".agent-team/handovers/requirements.yaml")).approved_inputs,
    ["REQUIREMENTS@1"],
  );
  const repaired = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(repaired.filter(({ id }) => id === handoverId).length, 1);
  await assert.rejects(
    () => handover(root, "requirements", "OP-HANDOVER-NEW"),
    /APPROVED_INPUT_STALE/,
  );
});

test("handover lists only the target phase artifact as its expected output", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-33");
  await setArtifactStatus(root, "RELEASE-READINESS");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases["release-readiness"] = { status: "approved", approval_id: "APR-RELEASE" };
  state.current_phase = "release-readiness";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  await store.writeYamlAtomic(".agent-team/approvals.yaml", {
    approvals: [{
      id: "APR-RELEASE",
      gate: "G7",
      decision: "approved",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "RELEASE-READINESS": 1 },
      timestamp: "2026-07-12T00:00:00Z",
    }],
  });

  await handover(root, "release-readiness", "OP-RELEASE-HANDOVER");
  const record = await readYaml(root, ".agent-team/handovers/release-readiness.yaml");
  assert.deepEqual(record.expected_outputs, ["DEPLOYMENT-PLAN"]);
});

test("status and doctor return structured project diagnostics", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-34");

  const status = await getStatus(root);
  assert.equal(status.project.id, "leave-system");
  assert.equal(status.phases.intake.status, "ready");
  assert.equal(status.plugins[0].status, "unknown");

  const diagnostics = await doctor(root);
  assert.deepEqual(diagnostics.checks.map(({ name }) => name), [
    "transactions",
    "git",
    "node",
    "state_schema",
    "workflow",
    "cache",
    "plugins",
    "locks",
  ]);
  assert.equal(diagnostics.checks.find(({ name }) => name === "plugins").ok, false);
  await setPluginStatus(root, pluginUri, "available", []);
  const missingSkill = await doctor(root);
  assert.equal(missingSkill.checks.find(({ name }) => name === "plugins").ok, false);
  assert.match(missingSkill.checks.find(({ name }) => name === "plugins").detail, /REQUIRED_SKILL_MISSING/);
  await enableAllPlugins(root);
  assert.equal((await doctor(root)).ok, true);
});

test("glossary and evidence validation use authoritative project files", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-VALIDATION");
  const store = ProjectStore.open(root);
  await store.writeYamlAtomic(".agent-team/glossary.yaml", {
    entries: [{ term: "Queue", definition: "Work awaiting processing." }],
  });

  assert.deepEqual(await glossaryValidate(root), { valid: true, entry_count: 1, findings: [] });
  assert.deepEqual(await evidenceVerify(root), {
    valid: true,
    verified: { execution_receipts: 0, execution_requests: 0, plugin_invocations: 0 },
    findings: [],
  });

  await writeFile(join(root, ".agent-team/glossary.yaml"), "entries:\n  - term: Queue\n");
  assert.equal((await glossaryValidate(root)).valid, false);
  await writeFile(join(root, ".agent-team/execution-receipts.yaml"), "receipts: invalid\n");
  assert.equal((await evidenceVerify(root)).valid, false);
});

test("evidence verification rejects schema-valid plugin claims without audit evidence", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-CLI-EVIDENCE");
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/plugin-invocations.yaml", {
    invocations: [{
      plugin_uri: pluginUri,
      publisher_identity: "openai-curated-remote",
      status: "success",
      execution_reference: "fabricated",
      started_at: "2026-07-13T00:00:00.000Z",
      completed_at: "2026-07-13T00:00:01.000Z",
      operation_id: "FABRICATED",
      skill: "brainstorming",
      input_digest: `sha256:${"0".repeat(64)}`,
      output_digest: `sha256:${"1".repeat(64)}`,
    }],
  });

  const report = await evidenceVerify(root);

  assert.equal(report.valid, false);
  assert.equal(report.findings[0].code, "PLUGIN_INVOCATION_AUDIT_MISSING");
});

test("cache rebuild integrates with diagnostics without blocking core workflow", async () => {
  const root = await temporaryGitRepository();
  await execFileAsync("git", ["config", "user.email", "cli@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "CLI Test"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
    cache: "sqlite",
  }, "INIT-CLI-CACHE");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initialize project"], { cwd: root });

  const rebuilt = await cacheRebuild(root);
  assert.equal(rebuilt.available, true);
  assert.equal((await doctor(root)).checks.find(({ name }) => name === "cache").ok, true);

  await writeFile(join(root, ".agent-team/cache/index.db"), "broken");
  assert.equal((await doctor(root)).checks.find(({ name }) => name === "cache").ok, false);
  assert.equal((await getStatus(root)).project.id, "leave-system");
});

test("CLI help lists the implemented commands", async () => {
  const bin = join(repository, "packages/cli/dist/bin.js");
  const { stdout } = await execFileAsync(
    process.execPath,
    [bin, "--help"],
  );
  for (const command of [
    "init", "adopt", "inspect", "status", "start", "review", "approve", "handover",
    "validate", "doctor", "repair", "upgrade", "eject", "uninstall", "cache", "glossary", "evidence",
  ]) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.match(stdout, /review <phase> --reviewer <id> --verdict <approved\|revision_required> --operation-id <id>/);
  assert.match(stdout, /review .*--execution-receipt <id>/);
  assert.match(stdout, /repair --locks --yes/);
  assert.match(stdout, /init .*--operation-id <id>/);
  assert.match(stdout, /adopt .*--operation-id <id>/);
  assert.match(stdout, /eject --operation-id <id>/);
  assert.match(stdout, /uninstall --operation-id <id>/);
  assert.match(stdout, /cache rebuild/);
  assert.match(stdout, /glossary validate/);
  assert.match(stdout, /evidence verify/);

  const root = await temporaryGitRepository();
  await execFileAsync(process.execPath, [
    bin,
    "init",
    "--id", "leave-system",
    "--name", "Leave System",
    "--mode", "greenfield",
    "--profile", "standard",
    "--operation-id", "CLI-INIT",
    "--language", "en",
    "--cache", "none",
    "--adapter", "codex",
  ], { cwd: root });
  const status = JSON.parse((await execFileAsync(process.execPath, [bin, "status"], { cwd: root })).stdout);
  assert.equal(status.project.id, "leave-system");
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "inspect"], { cwd: root })).stdout).installed, true);
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "upgrade", "--check"], { cwd: root })).stdout).mode, "check");
  assert.equal(JSON.parse((await execFileAsync(process.execPath, [bin, "upgrade", "--dry-run"], { cwd: root })).stdout).mode, "dry-run");
  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "repair", "--locks"], { cwd: root }),
    /QUIESCENCE_CONFIRMATION_REQUIRED/,
  );
  const repairedLocks = JSON.parse((await execFileAsync(
    process.execPath,
    [bin, "repair", "--locks", "--yes"],
    { cwd: root },
  )).stdout);
  assert.deepEqual(repairedLocks.repaired, []);
  assert.equal(status.phases.intake.status, "ready");

  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "status", "extra"], { cwd: root }),
    (error) => error.code === 1 && /Unexpected positional/.test(error.stderr),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "status", "--by", "nobody"], { cwd: root }),
    (error) => error.code === 1 && /not valid for status/.test(error.stderr),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "doctor"], { cwd: root }),
    (error) => error.code === 1 && JSON.parse(error.stdout).ok === false,
  );

  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await startPhase(root, "intake", "CLI-START");
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      bin,
      "validate",
      "intake",
      "--operation-id", "CLI-INVALID",
    ], { cwd: root }),
    (error) => error.code === 1 && JSON.parse(error.stdout).valid === false,
  );
  await setArtifactStatus(root, "PROJECT-CHARTER");
  await validatePhase(root, "intake", "CLI-VALID");
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      bin,
      "review",
      "intake",
      "--reviewer", "documentation-reviewer",
      "--verdict", "approved",
      "--operation-id", "CLI-REVIEW",
    ], { cwd: root }),
    /--execution-receipt is required/,
  );
  const reviewed = await reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    "CLI-REVIEW",
  );
  assert.equal(reviewed.phases.intake.status, "awaiting_approval");

  assert.equal(JSON.parse((await execFileAsync(
    process.execPath,
    [bin, "eject", "--operation-id", "CLI-EJECT"],
    { cwd: root },
  )).stdout).status, "ejected");
  assert.deepEqual(
    JSON.parse((await execFileAsync(
      process.execPath,
      [bin, "uninstall", "--operation-id", "CLI-UNINSTALL"],
      { cwd: root },
    )).stdout).preserved,
    [".agent-team"],
  );

  const adoptedRoot = await temporaryGitRepository();
  await writeFile(join(adoptedRoot, "source.ts"), "export {};\n");
  await execFileAsync("git", ["add", "source.ts"], { cwd: adoptedRoot });
  const adopted = JSON.parse((await execFileAsync(process.execPath, [
    bin,
    "adopt",
    "--id", "adopted-system",
    "--name", "Adopted System",
    "--profile", "standard",
    "--operation-id", "CLI-ADOPT",
    "--adapter", "codex",
  ], { cwd: adoptedRoot })).stdout);
  assert.equal(adopted.project.project.mode, "existing_system");

  const badAdapterRoot = await temporaryGitRepository();
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      bin, "init", "--id", "bad-adapter", "--name", "Bad Adapter",
      "--mode", "greenfield", "--profile", "standard", "--operation-id", "BAD-ADAPTER", "--adapter", "other",
    ], { cwd: badAdapterRoot }),
    /Invalid option|Invalid input|codex/,
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "eject"], { cwd: root }),
    /--operation-id is required/,
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "uninstall"], { cwd: root }),
    /--operation-id is required/,
  );
  const missingAdoptOperationRoot = await temporaryGitRepository();
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      bin, "adopt", "--id", "missing-operation", "--name", "Missing Operation", "--profile", "standard",
    ], { cwd: missingAdoptOperationRoot }),
    /--operation-id is required/,
  );
  const missingInitOperationRoot = await temporaryGitRepository();
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      bin, "init", "--id", "missing-init-operation", "--name", "Missing Init Operation",
      "--mode", "greenfield", "--profile", "standard",
    ], { cwd: missingInitOperationRoot }),
    /--operation-id is required/,
  );
  const removedCodexFlagRoot = await temporaryGitRepository();
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      bin, "init", "--id", "removed-codex", "--name", "Removed Codex",
      "--mode", "greenfield", "--profile", "standard", "--codex",
    ], { cwd: removedCodexFlagRoot }),
    /Unknown option '--codex'/,
  );
  const lifecycleAudit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert(lifecycleAudit.some(({ action, actor, authorization_source }) =>
    action === "eject"
    && actor.identifier === "system-design-team-cli"
    && authorization_source === "cli_invocation"));
});

test("CLI runs cache and validation commands and rejects extra arguments", async () => {
  const bin = join(repository, "packages/cli/dist/bin.js");
  const root = await temporaryGitRepository();
  await execFileAsync("git", ["config", "user.email", "cli@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "CLI Test"], { cwd: root });
  await execFileAsync(process.execPath, [
    bin,
    "init",
    "--id", "leave-system",
    "--name", "Leave System",
    "--mode", "greenfield",
    "--profile", "standard",
    "--operation-id", "CLI-CACHE-INIT",
    "--cache", "sqlite",
  ], { cwd: root });
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/glossary.yaml", {
    entries: [{ term: "Queue", definition: "Work awaiting processing." }],
  });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initialize project"], { cwd: root });

  assert.equal(JSON.parse((await execFileAsync(
    process.execPath,
    [bin, "cache", "rebuild"],
    { cwd: root },
  )).stdout).available, true);
  assert.equal(JSON.parse((await execFileAsync(
    process.execPath,
    [bin, "glossary", "validate"],
    { cwd: root },
  )).stdout).valid, true);
  assert.equal(JSON.parse((await execFileAsync(
    process.execPath,
    [bin, "evidence", "verify"],
    { cwd: root },
  )).stdout).valid, true);
  await assert.rejects(
    () => execFileAsync(process.execPath, [bin, "cache", "rebuild", "extra"], { cwd: root }),
    /Unexpected positional arguments/,
  );
});
