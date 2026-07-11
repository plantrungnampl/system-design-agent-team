import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function temporaryGitRepository() {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-cli-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function readYaml(root, path) {
  return parse(await readFile(join(root, path), "utf8"));
}

async function setPhaseStatus(root, phase, status) {
  const store = ProjectStore.open(root);
  const current = await store.readWorkflowState();
  return store.updateWorkflowState(current.state_version, (state) => ({
    ...state,
    state_version: state.state_version + 1,
    current_phase: phase,
    phases: {
      ...state.phases,
      [phase]: { ...state.phases[phase], status },
    },
  }));
}

test("init creates a valid minimal project without overwriting source", async () => {
  const root = await temporaryGitRepository();
  await writeFile(join(root, "AGENTS.md"), "repository policy\n");

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
  await assert.rejects(readFile(join(root, "src")), /ENOENT/);
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
    "plugin://superpowers@openai-curated-remote",
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
    "plugin://superpowers@openai-curated-remote",
    "available",
    ["brainstorming"],
  );
  await startPhase(root, "intake", "OP-START-INTAKE");
  await writeFile(join(root, ".agent-team/context/project-charter.md"), [
    "---",
    "status: in_review",
    "---",
    "# Project Charter",
    "TODO: confirm scope",
  ].join("\n"));

  const invalid = await validatePhase(root, "intake", "OP-VALIDATE-INTAKE");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.state.phases.intake.status, "in_progress");
  assert.equal(invalid.findings[0].code, "PROHIBITED_PLACEHOLDER");

  await writeFile(join(root, ".agent-team/context/project-charter.md"), [
    "---",
    "status: in_review",
    "---",
    "# Project Charter",
    "Scope is approved for the leave management system.",
  ].join("\n"));
  const valid = await validatePhase(root, "intake", "OP-VALIDATE-INTAKE");
  assert.equal(valid.valid, true);
  assert.equal(valid.state.phases.intake.status, "artifact_validation");
});

test("approve persists registry-bound evidence and is idempotent", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  const awaiting = await setPhaseStatus(root, "requirements", "awaiting_approval");

  const approved = await approve(root, "G2", "project-owner", "OP-APPROVE-G2");
  const evidence = await readYaml(root, ".agent-team/approvals.yaml");
  assert.equal(approved.phases.requirements.status, "approved");
  assert.equal(approved.state_version, awaiting.state_version + 1);
  assert.deepEqual(evidence.approvals[0].artifact_versions, { REQUIREMENTS: 1 });

  assert.deepEqual(await approve(root, "G2", "project-owner", "OP-APPROVE-G2"), approved);
  assert.equal((await readYaml(root, ".agent-team/approvals.yaml")).approvals.length, 1);
});

test("handover writes a valid record and advances each directly dependent phase separately", async () => {
  const root = await temporaryGitRepository();
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  const approved = await setPhaseStatus(root, "requirements", "approved");

  const handedOver = await handover(root, "requirements", "OP-HANDOVER-REQ");
  const record = HandoverRecordSchema.parse(
    await readYaml(root, ".agent-team/handovers/requirements.yaml"),
  );
  assert.equal(record.from_agent, "business-analyst");
  assert.equal(record.to_agent, "product-owner");
  assert.deepEqual(record.approved_inputs, ["REQUIREMENTS@1"]);
  assert.equal(handedOver.phases.requirements.status, "handed_over");
  assert.equal(handedOver.phases.product.status, "ready");
  assert.equal(handedOver.state_version, approved.state_version + 2);

  const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
  registry.artifacts.find(({ id }) => id === "REQUIREMENTS").version = 2;
  await ProjectStore.open(root).writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
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
});

test("CLI help lists the first-slice commands", async () => {
  const bin = join(repository, "packages/cli/dist/bin.js");
  const { stdout } = await execFileAsync(
    process.execPath,
    [bin, "--help"],
  );
  for (const command of ["init", "status", "start", "approve", "handover", "validate", "doctor"]) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`));
  }

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
});
