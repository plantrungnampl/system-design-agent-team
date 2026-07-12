import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
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

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("lifecycle lock is cleaned up after its callback fails", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-security-");
  const store = ProjectStore.open(root);

  await assert.rejects(
    () => store.withLock(".agent-team/lifecycle.lock", async () => { throw new Error("callback failed"); }),
    /callback failed/,
  );
  await store.withLock(".agent-team/lifecycle.lock", async () => {});
  await assert.rejects(() => access(join(root, ".agent-team/lifecycle.lock")), { code: "ENOENT" });
});

test("initialization preserves source and AGENTS while lifecycle exclusion recovers without losing evidence", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-recovery-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/application.ts"), "export const untouched = true;\n");
  await writeFile(join(root, "AGENTS.md"), "keep repository policy\n");
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  assert.equal(await readFile(join(root, "src/application.ts"), "utf8"), "export const untouched = true;\n");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "keep repository policy\n");

  const store = ProjectStore.open(root);
  await setPluginStatus(root, pluginUri, "available", ["brainstorming"]);
  await startPhase(root, "intake", "OP-START");
  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const artifact = registry.artifacts.find(({ id }) => id === "PROJECT-CHARTER");
  artifact.status = "in_review";
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, [
    "---",
    "artifact_id: PROJECT-CHARTER",
    "version: 1",
    "status: in_review",
    "owner: lead-orchestrator",
    "reviewer: documentation-reviewer",
    "---",
    "# Project Charter",
    "Ready for review.",
  ].join("\n"));
  assert.equal((await validatePhase(root, "intake", "OP-VALIDATE")).valid, true);

  await store.withLock(".agent-team/lifecycle.lock", async () => {
    await assert.rejects(
      () => reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW"),
      /STATE_LOCKED/,
    );
  });
  await reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW");

  const state = await store.readWorkflowState();
  const { reviews } = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8"));
  assert.deepEqual(reviews.map(({ id, artifact_versions }) => ({ id, artifact_versions })), [{
    id: JSON.stringify(["review", "intake", "OP-REVIEW"]),
    artifact_versions: { "PROJECT-CHARTER": 1 },
  }]);
  assert.equal(state.phases.intake.status, "awaiting_approval");
  assert.equal(state.phases.intake.review_id, JSON.stringify(["review", "intake", "OP-REVIEW"]));
});
