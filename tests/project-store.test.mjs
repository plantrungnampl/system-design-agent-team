import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { ProjectStore } from "@system-design-team/project-store";

const workflowStateYaml = `schema_version: 1
state_version: 1
project_id: leave-system
current_phase: intake
phases:
  intake:
    status: ready
completed_operations: []
`;

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function projectWithState(t) {
  const root = await temporaryDirectory(t, "project-store-");
  await mkdir(join(root, ".agent-team"), { recursive: true });
  await writeFile(join(root, ".agent-team", "workflow-state.yaml"), workflowStateYaml);
  return root;
}

test("rejects writes outside the project root", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  const outside = join(root, "..", `${basename(root)}-escape.yaml`);
  t.after(() => rm(outside, { force: true }));

  const store = ProjectStore.open(root);
  await assert.rejects(() => store.writeYamlAtomic(`../${basename(outside)}`, {}), /PATH_OUTSIDE_PROJECT/);
  await assert.rejects(() => access(outside), { code: "ENOENT" });
});

test("rejects writes through a linked directory outside the project root", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  const outside = await temporaryDirectory(t, "project-store-outside-");
  const link = join(root, "linked");

  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const store = ProjectStore.open(root);
  await assert.rejects(
    () => store.writeYamlAtomic("linked/new/escape.yaml", {}),
    /PATH_OUTSIDE_PROJECT/,
  );
  await assert.rejects(() => access(join(outside, "new", "escape.yaml")), { code: "ENOENT" });
});

test("rejects a stale state version without changing the file", async (t) => {
  const root = await projectWithState(t);
  const store = ProjectStore.open(root);
  const before = await store.readWorkflowState();

  await assert.rejects(
    () => store.updateWorkflowState(before.state_version - 1, (value) => value),
    /STATE_VERSION_CONFLICT/,
  );
  assert.deepEqual(await store.readWorkflowState(), before);
});

test("atomically replaces YAML without leaving a temporary file", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  const store = ProjectStore.open(root);

  await store.writeYamlAtomic("state.yaml", { value: "old" });
  await store.writeYamlAtomic("state.yaml", { value: "new" });

  assert.match(await readFile(join(root, "state.yaml"), "utf8"), /value: new/);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("writes text atomically through the same containment boundary", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  const outside = await temporaryDirectory(t, "project-store-outside-");
  const store = ProjectStore.open(root);

  await store.writeTextAtomic("generated/instructions.md", "safe\n");
  assert.equal(await readFile(join(root, "generated", "instructions.md"), "utf8"), "safe\n");
  await assert.rejects(
    () => store.writeTextAtomic(`../${basename(outside)}-escape.md`, "unsafe\n"),
    /PATH_OUTSIDE_PROJECT/,
  );
});

test("cleans the temporary file after atomic replacement fails", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  await mkdir(join(root, "occupied"));
  const store = ProjectStore.open(root);

  await assert.rejects(() => store.writeYamlAtomic("occupied", { value: "new" }));
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("requires the next state version before replacing workflow state", async (t) => {
  const root = await projectWithState(t);
  const store = ProjectStore.open(root);
  const before = await store.readWorkflowState();

  await assert.rejects(
    () => store.updateWorkflowState(before.state_version, (value) => value),
    /STATE_VERSION_INVALID/,
  );
  assert.deepEqual(await store.readWorkflowState(), before);

  const next = await store.updateWorkflowState(before.state_version, (value) => ({
    ...value,
    state_version: value.state_version + 1,
  }));
  assert.equal(next.state_version, before.state_version + 1);
});

test("allows exactly one concurrent update for the same state version", async (t) => {
  const root = await projectWithState(t);
  const before = await ProjectStore.open(root).readWorkflowState();
  const update = (operation) => ProjectStore.open(root).updateWorkflowState(
    before.state_version,
    (value) => ({
      ...value,
      state_version: value.state_version + 1,
      completed_operations: [...value.completed_operations, operation],
    }),
  );

  const results = await Promise.allSettled([update("first"), update("second")]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /STATE_LOCKED|STATE_VERSION_CONFLICT/);
  assert.equal((await ProjectStore.open(root).readWorkflowState()).state_version, before.state_version + 1);
  await assert.rejects(
    () => access(join(root, ".agent-team", "workflow-state.lock")),
    { code: "ENOENT" },
  );
});

test("appends one redacted audit JSON object per line", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  const store = ProjectStore.open(root);

  await store.appendAudit({ action: "dispatch", token: "raw-token" });
  await store.appendAudit({ action: "review", nested: { password: "raw-password" } });

  const lines = (await readFile(join(root, ".agent-team", "audit", "events.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(lines, [
    { action: "dispatch", token: "[REDACTED]" },
    { action: "review", nested: { password: "[REDACTED]" } },
  ]);
});

test("rejects a dangling audit symlink or junction", async (t) => {
  const root = await temporaryDirectory(t, "project-store-");
  const outside = await temporaryDirectory(t, "project-store-outside-");
  const auditDirectory = join(root, ".agent-team", "audit");
  const auditPath = join(auditDirectory, "events.jsonl");
  await mkdir(auditDirectory, { recursive: true });

  try {
    await symlink(outside, auditPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await rm(outside, { force: true, recursive: true });

  await assert.rejects(
    () => ProjectStore.open(root).appendAudit({ action: "dispatch" }),
    /PATH_OUTSIDE_PROJECT/,
  );
  await assert.rejects(() => access(outside), { code: "ENOENT" });
});
