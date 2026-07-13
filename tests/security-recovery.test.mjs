import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
  doctor,
  initProject,
  invokePlugin,
  repair,
  reviewPhase,
  setPluginStatus,
  startPhase,
  validatePhase,
} from "@system-design-team/cli";
import { ProjectStore } from "@system-design-team/project-store";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const pluginUri = "plugin://superpowers@openai-curated-remote";

class FakePluginAdapter {
  async resolve(uri) {
    return { uri, publisher_identity: "openai-curated-remote", status: "available" };
  }

  async verifySkill() {
    return true;
  }

  async invoke(request) {
    return {
      plugin_uri: request.plugin_uri,
      publisher_identity: "openai-curated-remote",
      status: "success",
      output: { artifact: "requirements", secret: "runtime-only" },
      execution_reference: "fake-execution-persisted",
      started_at: "2026-07-13T00:00:00.000Z",
      completed_at: "2026-07-13T00:00:01.000Z",
      chain_of_thought: "must never be stored",
    };
  }
}

const pluginAdapter = new FakePluginAdapter();

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

test("plugin status cache cannot authorize phase start without a current adapter report", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-plugin-trust-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  await setPluginStatus(root, pluginUri, "available", [
    "brainstorming",
    "writing-plans",
    "verification-before-completion",
  ]);
  const before = await ProjectStore.open(root).readWorkflowState();

  await assert.rejects(
    () => startPhase(root, "intake", "CACHE-ONLY-START"),
    /PLUGIN_ADAPTER_REQUIRED/,
  );
  assert.deepEqual(await ProjectStore.open(root).readWorkflowState(), before);
});

test("verified plugin invocation persists sanitized evidence", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-plugin-evidence-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });

  const result = await invokePlugin(root, new FakePluginAdapter(), {
    plugin_uri: pluginUri,
    skill: "brainstorming",
    input: { objective: "requirements", secret: "input-only" },
  }, "PLUGIN-EVIDENCE");
  const evidenceText = await readFile(join(root, ".agent-team/plugin-invocations.yaml"), "utf8");
  const evidence = parse(evidenceText);

  assert.equal(result.output.secret, "runtime-only");
  assert.equal(evidence.invocations.length, 1);
  assert.equal(evidence.invocations[0].execution_reference, "fake-execution-persisted");
  assert(!evidenceText.includes("input-only"));
  assert(!evidenceText.includes("runtime-only"));
  assert(!evidenceText.includes("must never be stored"));
});

test("lifecycle lock serializes plugin status and phase start", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-lifecycle-race-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  const store = ProjectStore.open(root);
  const beforeState = await store.readWorkflowState();
  const beforeStatus = await readFile(join(root, ".agent-team/plugin-status.yaml"), "utf8");

  await store.withLock(".agent-team/lifecycle.lock", async () => {
    let statusError;
    let startError;
    try { await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]); } catch (error) { statusError = error; }
    try { await startPhase(root, "intake", "LOCKED-START"); } catch (error) { startError = error; }
    assert.match(String(statusError), /STATE_LOCKED/);
    assert.match(String(startError), /STATE_LOCKED/);
  });

  assert.deepEqual(await store.readWorkflowState(), beforeState);
  assert.equal(await readFile(join(root, ".agent-team/plugin-status.yaml"), "utf8"), beforeStatus);
});

test("initialization check and creation share a root lock", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-init-race-");
  const store = ProjectStore.open(root);
  await store.withLock(".system-design-team-init.lock", async () => {
    await assert.rejects(() => initProject(root, {
      id: "leave-system",
      name: "Leave System",
      mode: "greenfield",
      profile: "standard",
    }), /STATE_LOCKED/);
    await assert.rejects(() => access(join(root, ".agent-team")), { code: "ENOENT" });
  });
});

test("doctor diagnoses and explicit repair clears an abandoned lifecycle lock", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-explicit-repair-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  const moduleUrl = new URL("../packages/project-store/dist/index.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", [
    `import { ProjectStore } from ${JSON.stringify(moduleUrl)};`,
    `await ProjectStore.open(${JSON.stringify(root)}).withLock(".agent-team/lifecycle.lock", async () => {`,
    `  console.log("ready");`,
    `  await new Promise(() => {});`,
    `});`,
  ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await once(child.stdout, "data");
  child.kill();
  await once(child, "exit");

  await assert.rejects(
    () => ProjectStore.open(root).withLock(".agent-team/lifecycle.lock", async () => {}),
    /STATE_LOCKED/,
  );
  const locks = (await doctor(root)).checks.find(({ name }) => name === "locks");
  assert.equal(locks.ok, false);
  assert.match(locks.detail, /repair --locks --yes/);
  await assert.rejects(
    () => repair(root, { locks: true, confirmedQuiescent: false }),
    /QUIESCENCE_CONFIRMATION_REQUIRED/,
  );
  assert.deepEqual(
    await repair(root, { locks: true, confirmedQuiescent: true }),
    { repaired: [".agent-team/lifecycle.lock"] },
  );
  await ProjectStore.open(root).withLock(".agent-team/lifecycle.lock", async () => {});
});

test("completed lifecycle replay repairs a missing audit event once", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-audit-recovery-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  });
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  const started = await startPhase(root, "intake", "AUDIT-START", pluginAdapter);
  const store = ProjectStore.open(root);
  const auditPath = join(root, ".agent-team/audit/events.jsonl");
  const startId = JSON.stringify(["start", "intake", "AUDIT-START"]);
  const events = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert(events.some(({ action }) => action === "init"));
  await store.writeTextAtomic(
    ".agent-team/audit/events.jsonl",
    `${events.filter(({ id }) => id !== startId).map(JSON.stringify).join("\n")}\n`,
  );

  assert.deepEqual(await startPhase(root, "intake", "AUDIT-START", pluginAdapter), started);
  assert.deepEqual(await startPhase(root, "intake", "AUDIT-START", pluginAdapter), started);
  const repaired = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(repaired.filter(({ id }) => id === startId).length, 1);
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
  await setPluginStatus(root, pluginUri, "available", ["brainstorming", "writing-plans", "verification-before-completion"]);
  await startPhase(root, "intake", "OP-START", pluginAdapter);
  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const artifact = registry.artifacts.find(({ id }) => id === "PROJECT-CHARTER");
  artifact.status = "in_review";
  const text = [
    "---",
    "artifact_id: PROJECT-CHARTER",
    "version: 1",
    "status: in_review",
    "owner: lead-orchestrator",
    "reviewer: documentation-reviewer",
    "---",
    "# Project Charter",
    "Ready for review.",
  ].join("\n");
  artifact.checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, text);
  assert.equal((await validatePhase(root, "intake", "OP-VALIDATE")).valid, true);

  await store.withLock(".agent-team/lifecycle.lock", async () => {
    await assert.rejects(
      () => reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW"),
      /STATE_LOCKED/,
    );
  });
  await reviewPhase(root, "intake", "documentation-reviewer", "approved", "OP-REVIEW", pluginAdapter);

  const state = await store.readWorkflowState();
  const { reviews } = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8"));
  assert.deepEqual(reviews.map(({ id, artifact_versions }) => ({ id, artifact_versions })), [{
    id: JSON.stringify(["review", "intake", "OP-REVIEW"]),
    artifact_versions: { "PROJECT-CHARTER": 1 },
  }]);
  assert.equal(state.phases.intake.status, "awaiting_approval");
  assert.equal(state.phases.intake.review_id, JSON.stringify(["review", "intake", "OP-REVIEW"]));
});
