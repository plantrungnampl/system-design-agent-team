import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  approve,
  handover,
  initProject,
  reviewPhase,
  setPluginStatus,
  startPhase,
  validatePhase,
} from "@system-design-team/cli";
import { ProjectStore } from "@system-design-team/project-store";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const pluginUri = "plugin://superpowers@openai-curated-remote";
const operationKey = (action, target, raw) => JSON.stringify([action, target, raw]);

async function temporaryGitRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function readYaml(root, path) {
  return parse(await readFile(join(root, path), "utf8"));
}

async function makeReviewReady(root, artifactId) {
  const store = ProjectStore.open(root);
  const registry = await readYaml(root, ".agent-team/artifact-registry.yaml");
  const artifact = registry.artifacts.find(({ id }) => id === artifactId);
  artifact.status = "in_review";
  const text = [
    "---",
    `artifact_id: ${artifact.id}`,
    `version: ${artifact.version}`,
    "status: in_review",
    `owner: ${artifact.owner}`,
    `reviewer: ${artifact.reviewer}`,
    "---",
    `# ${artifact.id}`,
    "The artifact is complete and ready for independent review.",
  ].join("\n");
  artifact.checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, text);
}

test("greenfield requirements flow blocks missing plugins and reaches handover with evidence", async (t) => {
  const root = await temporaryGitRepository(t);
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });

  await assert.rejects(
    () => startPhase(root, "intake", "OP-START-INTAKE"),
    /REQUIRED_PLUGIN_UNKNOWN/,
  );
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);

  await startPhase(root, "intake", "OP-START-INTAKE");
  await makeReviewReady(root, "PROJECT-CHARTER");
  assert.equal((await validatePhase(root, "intake", "OP-VALIDATE-INTAKE")).valid, true);
  await reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW-INTAKE");
  await approve(root, "G0", "project-owner", "OP-APPROVE-G0");
  await handover(root, "intake", "OP-HANDOVER-INTAKE");

  await startPhase(root, "business-discovery", "OP-START-DISCOVERY");
  await makeReviewReady(root, "BUSINESS-CONTEXT");
  assert.equal((await validatePhase(root, "business-discovery", "OP-VALIDATE-DISCOVERY")).valid, true);
  await reviewPhase(root, "business-discovery", "business-analyst", "approved", "OP-REVIEW-DISCOVERY");
  await approve(root, "G1", "project-owner", "OP-APPROVE-G1");
  await handover(root, "business-discovery", "OP-HANDOVER-DISCOVERY");

  await startPhase(root, "requirements", "OP-START-REQ");
  await makeReviewReady(root, "REQUIREMENTS");
  assert.equal((await validatePhase(root, "requirements", "OP-VALIDATE-REQ")).valid, true);
  await reviewPhase(root, "requirements", "requirements-reviewer", "approved", "OP-REVIEW-REQ");
  await approve(root, "G2", "project-owner", "OP-APPROVE-G2");
  await handover(root, "requirements", "OP-HANDOVER-REQ");

  const store = ProjectStore.open(root);
  const finalState = await store.readWorkflowState();
  const { reviews } = await readYaml(root, ".agent-team/reviews.yaml");
  const { approvals } = await readYaml(root, ".agent-team/approvals.yaml");
  const intakeHandover = await readYaml(root, ".agent-team/handovers/intake.yaml");
  const discoveryHandover = await readYaml(root, ".agent-team/handovers/business-discovery.yaml");
  const requirementsHandover = await readYaml(root, ".agent-team/handovers/requirements.yaml");

  assert.equal(finalState.phases.requirements.status, "handed_over");
  assert.equal(finalState.phases.product.status, "ready");
  assert.deepEqual(reviews.map(({ id, reviewer, artifact_versions }) => ({
    id,
    reviewer,
    artifact_versions,
  })), [
    {
      id: operationKey("review", "intake", "OP-REVIEW-INTAKE"),
      reviewer: "documentation-reviewer",
      artifact_versions: { "PROJECT-CHARTER": 1 },
    },
    {
      id: operationKey("review", "business-discovery", "OP-REVIEW-DISCOVERY"),
      reviewer: "business-analyst",
      artifact_versions: { "BUSINESS-CONTEXT": 1 },
    },
    {
      id: operationKey("review", "requirements", "OP-REVIEW-REQ"),
      reviewer: "requirements-reviewer",
      artifact_versions: { REQUIREMENTS: 1 },
    },
  ]);
  assert.deepEqual(approvals.map(({ id, gate, approved_by, artifact_versions }) => ({
    id,
    gate,
    approved_by,
    artifact_versions,
  })), [
    {
      id: operationKey("approve", "G0", "OP-APPROVE-G0"),
      gate: "G0",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "PROJECT-CHARTER": 1 },
    },
    {
      id: operationKey("approve", "G1", "OP-APPROVE-G1"),
      gate: "G1",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { "BUSINESS-CONTEXT": 1 },
    },
    {
      id: operationKey("approve", "G2", "OP-APPROVE-G2"),
      gate: "G2",
      approved_by: { type: "human", identifier: "project-owner" },
      artifact_versions: { REQUIREMENTS: 1 },
    },
  ]);
  assert.deepEqual(
    [intakeHandover, discoveryHandover, requirementsHandover]
      .map(({ id, approved_inputs }) => ({ id, approved_inputs })),
    [
      {
        id: operationKey("handover", "intake", "OP-HANDOVER-INTAKE"),
        approved_inputs: ["PROJECT-CHARTER@1"],
      },
      {
        id: operationKey("handover", "business-discovery", "OP-HANDOVER-DISCOVERY"),
        approved_inputs: ["BUSINESS-CONTEXT@1"],
      },
      {
        id: operationKey("handover", "requirements", "OP-HANDOVER-REQ"),
        approved_inputs: ["REQUIREMENTS@1"],
      },
    ],
  );
  assert.deepEqual(finalState.completed_operations, [
    operationKey("start", "intake", "OP-START-INTAKE"),
    operationKey("validate", "intake", "OP-VALIDATE-INTAKE"),
    operationKey("review-under-review", "intake", "OP-REVIEW-INTAKE"),
    operationKey("review-verdict", "intake", "OP-REVIEW-INTAKE"),
    operationKey("approve", "G0", "OP-APPROVE-G0"),
    operationKey("handover", "intake", "OP-HANDOVER-INTAKE"),
    operationKey("handover-ready", "intake->business-discovery", "OP-HANDOVER-INTAKE"),
    operationKey("start", "business-discovery", "OP-START-DISCOVERY"),
    operationKey("validate", "business-discovery", "OP-VALIDATE-DISCOVERY"),
    operationKey("review-under-review", "business-discovery", "OP-REVIEW-DISCOVERY"),
    operationKey("review-verdict", "business-discovery", "OP-REVIEW-DISCOVERY"),
    operationKey("approve", "G1", "OP-APPROVE-G1"),
    operationKey("handover", "business-discovery", "OP-HANDOVER-DISCOVERY"),
    operationKey("handover-ready", "business-discovery->requirements", "OP-HANDOVER-DISCOVERY"),
    operationKey("start", "requirements", "OP-START-REQ"),
    operationKey("validate", "requirements", "OP-VALIDATE-REQ"),
    operationKey("review-under-review", "requirements", "OP-REVIEW-REQ"),
    operationKey("review-verdict", "requirements", "OP-REVIEW-REQ"),
    operationKey("approve", "G2", "OP-APPROVE-G2"),
    operationKey("handover", "requirements", "OP-HANDOVER-REQ"),
    operationKey("handover-ready", "requirements->product", "OP-HANDOVER-REQ"),
  ]);
});
