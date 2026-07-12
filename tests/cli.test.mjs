import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  approve,
  doctor,
  getStatus,
  handover,
  initProject,
  reviewPhase,
  setPluginStatus,
  startPhase,
  validatePhase,
} from "@system-design-team/cli";
import {
  AgentManifestSchema,
  HandoverRecordSchema,
  WorkflowDefinitionSchema,
} from "@system-design-team/core";
import { ProjectStore } from "@system-design-team/project-store";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginUri = "plugin://superpowers@openai-curated-remote";
const operationKey = (action, target, raw) => JSON.stringify([action, target, raw]);

async function temporaryGitRepository() {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-cli-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function readYaml(root, path) {
  return parse(await readFile(join(root, path), "utf8"));
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
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await writeFile(join(root, ".agent-team", artifact.path), [
    "---",
    `artifact_id: ${artifact.id}`,
    `version: ${version}`,
    `status: ${fileStatus}`,
    `owner: ${artifact.owner}`,
    `reviewer: ${artifact.reviewer}`,
    "---",
    `# ${artifact.id}`,
    body,
  ].join("\n"));
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

async function requirementsAwaitingApproval(root, prefix = "REQUIREMENTS") {
  await completeIntake(root, `${prefix}-INTAKE`);
  await enterArtifactValidation(root, "requirements", "REQUIREMENTS", prefix);
  return reviewPhase(
    root,
    "requirements",
    "requirements-reviewer",
    "approved",
    `${prefix}-REVIEW`,
  );
}

test("init creates a valid minimal project without overwriting source", async () => {
  const root = await temporaryGitRepository();
  await writeFile(join(root, "AGENTS.md"), "repository policy\n");
  await mkdir(join(root, ".codex/generated"), { recursive: true });
  await writeFile(join(root, ".codex/generated/existing.txt"), "keep\n");

  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });

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
  }), /ALREADY_INITIALIZED/);

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
  }), /ALREADY_INITIALIZED/);
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
  }), /PATH_OUTSIDE_PROJECT/);
  await assert.rejects(() => lstat(join(root, ".agent-team")), { code: "ENOENT" });
  assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
});

test("first-slice assets are valid and contain the required agents and phases", async () => {
  const catalogue = AgentManifestSchema.array().parse(
    parse(await readFile(join(repository, "agents/catalogue.yaml"), "utf8")),
  );
  assert.deepEqual(catalogue.map(({ id }) => id), [
    "lead-orchestrator",
    "documentation-reviewer",
    "business-analyst",
    "requirements-reviewer",
    "product-owner",
  ]);

  for (const [file, mode] of [
    ["greenfield.yaml", "greenfield"],
    ["existing-system.yaml", "existing_system"],
    ["migration.yaml", "migration"],
  ]) {
    const workflow = WorkflowDefinitionSchema.parse(
      parse(await readFile(join(repository, "workflows", file), "utf8")),
    );
    assert.equal(workflow.mode, mode);
    assert.deepEqual(workflow.phases.map(({ id }) => id), ["intake", "requirements", "product"]);
  }
});

test("start checks the phase owner plugin before changing state and replays safely", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  const before = await ProjectStore.open(root).readWorkflowState();

  await assert.rejects(
    startPhase(root, "intake", "OP-START-INTAKE"),
    /REQUIRED_PLUGIN_UNKNOWN/,
  );
  assert.deepEqual(await ProjectStore.open(root).readWorkflowState(), before);

  await setPluginStatus(
    root,
    pluginUri,
    "available",
    ["brainstorming"],
  );
  const started = await startPhase(root, "intake", "OP-START-INTAKE");
  assert.equal(started.phases.intake.status, "in_progress");
  assert.equal(started.state_version, before.state_version + 1);
  assert.deepEqual(await startPhase(root, "intake", "OP-START-INTAKE"), started);
});

test("validate checks registered artifacts before entering artifact validation", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  await setPluginStatus(
    root,
    pluginUri,
    "available",
    ["brainstorming"],
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
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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

test("review records independent evidence and applies two idempotent state updates", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
  const validated = await enterArtifactValidation(root, "intake", "PROJECT-CHARTER", "REVIEW");

  await assert.rejects(() => reviewPhase(
    root,
    "intake",
    "lead-orchestrator",
    "approved",
    "OP-REVIEW",
  ), /REVIEWER_NOT_CONFIGURED/);
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
  await setArtifactStatus(root, "PROJECT-CHARTER", { version: 2 });
  assert.deepEqual(await reviewPhase(
    root,
    "intake",
    "documentation-reviewer",
    "approved",
    "OP-REVIEW",
  ), reviewed);
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
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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

test("approve persists registry-bound evidence and is idempotent", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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

  assert.deepEqual(await handover(root, "requirements", "OP-HANDOVER-REQ"), handedOver);
});

test("status and doctor return structured project diagnostics", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });

  const status = await getStatus(root);
  assert.equal(status.project.id, "leave-system");
  assert.equal(status.phases.intake.status, "ready");
  assert.equal(status.plugins[0].status, "unknown");

  const diagnostics = await doctor(root);
  assert.deepEqual(diagnostics.checks.map(({ name }) => name), [
    "git",
    "node",
    "state_schema",
    "workflow",
    "plugins",
  ]);
  assert.equal(diagnostics.checks.find(({ name }) => name === "plugins").ok, false);
  await setPluginStatus(root, pluginUri, "available", []);
  const missingSkill = await doctor(root);
  assert.equal(missingSkill.checks.find(({ name }) => name === "plugins").ok, false);
  assert.match(missingSkill.checks.find(({ name }) => name === "plugins").detail, /REQUIRED_SKILL_MISSING/);
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
  assert.equal((await doctor(root)).ok, true);
});

test("CLI help lists the first-slice commands", async () => {
  const bin = join(repository, "packages/cli/dist/bin.js");
  const { stdout } = await execFileAsync(
    process.execPath,
    [bin, "--help"],
  );
  for (const command of ["init", "status", "start", "review", "approve", "handover", "validate", "doctor"]) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.match(stdout, /review <phase> --reviewer <id> --verdict <approved\|revision_required> --operation-id <id>/);

  const root = await temporaryGitRepository();
  await execFileAsync(process.execPath, [
    bin,
    "init",
    "--id", "leave-system",
    "--name", "Leave System",
    "--mode", "greenfield",
    "--profile", "standard",
  ], { cwd: root });
  const status = JSON.parse((await execFileAsync(process.execPath, [bin, "status"], { cwd: root })).stdout);
  assert.equal(status.project.id, "leave-system");
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

  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
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
  const reviewed = JSON.parse((await execFileAsync(process.execPath, [
    bin,
    "review",
    "intake",
    "--reviewer", "documentation-reviewer",
    "--verdict", "approved",
    "--operation-id", "CLI-REVIEW",
  ], { cwd: root })).stdout);
  assert.equal(reviewed.phases.intake.status, "awaiting_approval");
});
