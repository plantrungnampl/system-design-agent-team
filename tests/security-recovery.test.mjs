import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

test("store rejects path and junction escapes, redacts audit secrets, and recovers failed locks", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-security-");
  const outside = await temporaryDirectory(t, "system-design-team-outside-");
  const store = ProjectStore.open(root);

  await assert.rejects(
    () => store.writeTextAtomic(`../${basename(outside)}-escape.txt`, "unsafe"),
    /PATH_OUTSIDE_PROJECT/,
  );
  const link = join(root, "linked");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () => store.writeTextAtomic("linked/escape.txt", "unsafe"),
      /PATH_OUTSIDE_PROJECT/,
    );
    await assert.rejects(() => access(join(outside, "escape.txt")), { code: "ENOENT" });
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) throw error;
  }

  await store.appendAudit({ action: "dispatch", token: "raw-token", nested: { apiKey: "raw-key" } });
  const audit = await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8");
  assert(!audit.includes("raw-token"));
  assert(!audit.includes("raw-key"));
  assert.deepEqual(JSON.parse(audit), {
    action: "dispatch",
    token: "[REDACTED]",
    nested: { apiKey: "[REDACTED]" },
  });

  await assert.rejects(
    () => store.withLock(".agent-team/lifecycle.lock", async () => { throw new Error("callback failed"); }),
    /callback failed/,
  );
  await store.withLock(".agent-team/lifecycle.lock", async () => {});
  await assert.rejects(() => access(join(root, ".agent-team/lifecycle.lock")), { code: "ENOENT" });
});

test("initialization preserves source and AGENTS while a concurrent review keeps its evidence", async (t) => {
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

  const attempts = await Promise.allSettled([
    reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW-A"),
    reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW-B"),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const state = await store.readWorkflowState();
  const { reviews } = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8"));
  assert.equal(reviews.length, 1);
  assert.equal(state.phases.intake.status, "awaiting_approval");
  assert.equal(state.phases.intake.review_id, reviews[0].id);
  assert.deepEqual(reviews[0].artifact_versions, { "PROJECT-CHARTER": 1 });
});
