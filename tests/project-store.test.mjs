import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { AuditEventSchema } from "@system-design-team/core";
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

test("allows only one concurrent caller inside a shared lock", async (t) => {
  const root = await projectWithState(t);
  const store = ProjectStore.open(root);
  let release;
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const first = store.withLock(".agent-team/lifecycle.lock", async () => {
    entered();
    await held;
  });
  await inside;

  await assert.rejects(
    () => store.withLock(".agent-team/lifecycle.lock", async () => {}),
    /STATE_LOCKED/,
  );
  release();
  await first;
  await assert.rejects(
    () => access(join(root, ".agent-team", "lifecycle.lock")),
    { code: "ENOENT" },
  );
});

test("requires explicit quiescent repair after a lock owner process dies", async (t) => {
  const root = await projectWithState(t);
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

  const store = ProjectStore.open(root);
  await assert.rejects(
    () => store.withLock(".agent-team/lifecycle.lock", async () => {}),
    /STATE_LOCKED/,
  );
  assert.equal((await store.inspectLock(".agent-team/lifecycle.lock")).status, "abandoned");
  await assert.rejects(
    () => store.repairLock(".agent-team/lifecycle.lock", { confirmedQuiescent: false }),
    /QUIESCENCE_CONFIRMATION_REQUIRED/,
  );
  assert.equal(
    await store.repairLock(".agent-team/lifecycle.lock", { confirmedQuiescent: true }),
    true,
  );
  await store.withLock(".agent-team/lifecycle.lock", async () => {});
  await assert.rejects(
    () => access(join(root, ".agent-team", "lifecycle.lock")),
    { code: "ENOENT" },
  );
});

test("explicit repair rejects live, foreign-host, and invalid lock metadata", async (t) => {
  const root = await projectWithState(t);
  const store = ProjectStore.open(root);
  const lockPath = join(root, ".agent-team/lifecycle.lock");
  const reject = async (metadata) => {
    await writeFile(lockPath, typeof metadata === "string" ? metadata : JSON.stringify(metadata));
    assert.equal((await store.inspectLock(".agent-team/lifecycle.lock")).status, "locked");
    await assert.rejects(
      () => store.repairLock(".agent-team/lifecycle.lock", { confirmedQuiescent: true }),
      /STATE_LOCKED/,
    );
    await rm(lockPath);
  };

  await reject({ pid: process.pid, hostname: hostname(), created_at: new Date().toISOString() });
  await reject({ pid: 2147483647, hostname: "other-host", created_at: new Date().toISOString() });
  await reject("invalid metadata");
});

test("appends a redacted audit event only once per id", async (t) => {
  const root = await projectWithState(t);
  const store = ProjectStore.open(root);

  await store.appendAuditOnce({ id: "OP-1", action: "start", token: "secret" });
  await store.appendAuditOnce({ id: "OP-1", action: "start", token: "changed" });

  const events = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(events, [{ id: "OP-1", action: "start", token: "[REDACTED]" }]);
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

const auditEvent = (id) => AuditEventSchema.parse({
  id,
  action: "review",
  target: "intake",
  actor: { type: "agent", identifier: "documentation-reviewer" },
  authorization_source: "workflow",
  agent_id: "documentation-reviewer",
  permission_profile: "standard",
  artifact_versions: { "PROJECT-CHARTER": 1 },
  result: "success",
  timestamp: "2026-07-12T00:00:00.000Z",
});

for (const [fault, expected] of [
  ["before_journal_commit", "old"],
  ["after_evidence_write", "new"],
  ["after_state_write", "new"],
  ["before_audit_append", "new"],
]) {
  test(`recovers ${expected} state after interruption ${fault}`, async (t) => {
    const root = await temporaryDirectory(t, "project-store-transaction-");
    await mkdir(join(root, ".agent-team"), { recursive: true });
    await writeFile(join(root, ".agent-team/evidence.yaml"), "value: old\n");
    await writeFile(join(root, ".agent-team/state.yaml"), "value: old\n");
    const interrupted = ProjectStore.open(root, {
      transactionFault: (point) => {
        if (point === fault) throw new Error(`INTERRUPTED_${point}`);
      },
    });

    await assert.rejects(() => interrupted.transaction("OP-TRANSACTION", [
      { path: ".agent-team/evidence.yaml", content: "value: new\n", role: "evidence" },
      { path: ".agent-team/state.yaml", content: "value: new\n", role: "state" },
    ], auditEvent("OP-TRANSACTION")), new RegExp(`INTERRUPTED_${fault}`));

    const store = ProjectStore.open(root);
    const pending = await store.inspectTransactions();
    assert.equal(pending.length, expected === "new" ? 1 : 0);
    await store.repairTransactions();
    assert.equal(await readFile(join(root, ".agent-team/evidence.yaml"), "utf8"), `value: ${expected}\n`);
    assert.equal(await readFile(join(root, ".agent-team/state.yaml"), "utf8"), `value: ${expected}\n`);
    if (expected === "new") {
      const events = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
        .trim().split("\n").map(JSON.parse);
      assert.deepEqual(events, [auditEvent("OP-TRANSACTION")]);
    } else {
      await assert.rejects(() => access(join(root, ".agent-team/audit/events.jsonl")), { code: "ENOENT" });
    }
    assert.deepEqual(await store.inspectTransactions(), []);
  });
}

test("transaction replay is idempotent", async (t) => {
  const root = await temporaryDirectory(t, "project-store-transaction-");
  const store = ProjectStore.open(root);
  const writes = [{ path: ".agent-team/evidence.yaml", content: "value: new\n" }];
  const event = auditEvent("OP-IDEMPOTENT");

  await store.transaction("OP-IDEMPOTENT", writes, event);
  await store.transaction("OP-IDEMPOTENT", writes, event);

  const events = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(events, [event]);
});

test("transaction rejects a stale expected workflow-state version", async (t) => {
  const root = await projectWithState(t);
  const store = ProjectStore.open(root);
  await assert.rejects(
    () => store.transaction("OP-STALE-TRANSACTION", [{
      path: ".agent-team/workflow-state.yaml",
      content: workflowStateYaml,
      expectedStateVersion: 0,
    }], auditEvent("OP-STALE-TRANSACTION")),
    /STATE_VERSION_CONFLICT/,
  );
  assert.equal(await readFile(join(root, ".agent-team/workflow-state.yaml"), "utf8"), workflowStateYaml);
});

test("completed operation ids are bound to the original payload", async (t) => {
  const root = await temporaryDirectory(t, "project-store-receipt-");
  const store = ProjectStore.open(root);
  await store.transaction("OP-RECEIPT", [{ path: ".agent-team/value", content: "one" }], auditEvent("OP-RECEIPT"));

  await assert.rejects(
    () => store.transaction("OP-RECEIPT", [{ path: ".agent-team/value", content: "two" }], auditEvent("OP-RECEIPT")),
    /OPERATION_ID_CONFLICT/,
  );
  assert.equal(await readFile(join(root, ".agent-team/value"), "utf8"), "one");
  assert.equal((await readdir(join(root, ".agent-team/transactions/completed"))).length, 1);
});

test("a pending journal blocks ordinary mutations until repair", async (t) => {
  const root = await temporaryDirectory(t, "project-store-pending-");
  const interrupted = ProjectStore.open(root, {
    transactionFault: (point) => { if (point === "after_evidence_write") throw new Error("INTERRUPTED"); },
  });
  await assert.rejects(
    () => interrupted.transaction("OP-PENDING", [
      { path: ".agent-team/evidence", content: "evidence", role: "evidence" },
      { path: ".agent-team/workflow-state.yaml", content: workflowStateYaml, role: "state" },
    ], auditEvent("OP-PENDING")),
    /INTERRUPTED/,
  );

  const store = ProjectStore.open(root);
  await assert.rejects(() => store.writeTextAtomic("ordinary", "newer"), /PENDING_TRANSACTIONS/);
  await assert.rejects(() => store.transaction("OP-OTHER", [], auditEvent("OP-OTHER")), /PENDING_TRANSACTIONS/);
  await store.repairTransactions();
  await store.writeTextAtomic("ordinary", "allowed");
});

test("repair rejects malformed, misnamed, and unbound journals", async (t) => {
  const root = await temporaryDirectory(t, "project-store-invalid-journal-");
  const directory = join(root, ".agent-team/transactions");
  await mkdir(directory, { recursive: true });
  const write = async (name, value) => {
    await writeFile(join(directory, name), JSON.stringify(value));
    await assert.rejects(() => ProjectStore.open(root).repairTransactions(), /TRANSACTION_JOURNAL_INVALID/);
    await rm(join(directory, name));
  };

  await write("wrong.json", { operationId: "OP", writes: [], auditEvent: auditEvent("OP") });
  const operationId = "OP-SHAPE";
  const name = `${createHash("sha256").update(operationId).digest("hex")}.json`;
  await write(name, { operationId, writes: [{ path: "../escape", content: "x", role: "evidence" }], auditEvent: auditEvent(operationId) });
  await write(name, { operationId, writes: [], auditEvent: auditEvent("OTHER") });
});

test("repair does not overwrite work newer than the journal", async (t) => {
  const root = await temporaryDirectory(t, "project-store-newer-");
  const interrupted = ProjectStore.open(root, {
    transactionFault: (point) => { if (point === "before_audit_append") throw new Error("INTERRUPTED"); },
  });
  await writeFile(join(root, "value"), "old");
  await assert.rejects(
    () => interrupted.transaction("OP-NEWER", [{ path: "value", content: "transaction", role: "evidence" }], auditEvent("OP-NEWER")),
    /INTERRUPTED/,
  );
  await writeFile(join(root, "value"), "newer");

  await assert.rejects(() => ProjectStore.open(root).repairTransactions(), /TRANSACTION_WRITE_CONFLICT/);
  assert.equal(await readFile(join(root, "value"), "utf8"), "newer");
});

test("fault hooks follow semantic write roles instead of array positions", async (t) => {
  const root = await temporaryDirectory(t, "project-store-roles-");
  const points = [];
  const store = ProjectStore.open(root, { transactionFault: (point) => points.push(point) });
  await store.transaction("OP-ROLES", [
    { path: ".agent-team/workflow-state.yaml", content: workflowStateYaml, role: "state" },
    { path: ".agent-team/reviews.yaml", content: "reviews: []\n", role: "evidence" },
  ], auditEvent("OP-ROLES"));
  assert.deepEqual(points, ["before_journal_commit", "after_state_write", "after_evidence_write", "before_audit_append"]);
});

test("agent audit identity must match the actor and transaction operation", async (t) => {
  assert.throws(() => AuditEventSchema.parse({ ...auditEvent("OP-AGENT"), agent_id: "other" }), /agent/i);
  const root = await temporaryDirectory(t, "project-store-audit-bind-");
  await assert.rejects(
    () => ProjectStore.open(root).transaction(
      "OP-TRANSACTION",
      [],
      auditEvent("OTHER"),
    ),
    /AUDIT_ID_MISMATCH/,
  );
});

test("inspect and repair reject a journal symlink outside the project", async (t) => {
  const root = await temporaryDirectory(t, "project-store-journal-link-");
  const outside = await temporaryDirectory(t, "project-store-journal-outside-");
  const operationId = "OP-LINKED-JOURNAL";
  const name = `${createHash("sha256").update(operationId).digest("hex")}.json`;
  const outsideJournal = join(outside, name);
  await writeFile(outsideJournal, JSON.stringify({
    version: 1,
    operationId,
    writes: [{ path: "promoted", content: "unsafe", role: "evidence", beforeDigest: null }],
    auditEvent: auditEvent(operationId),
  }));
  await mkdir(join(root, ".agent-team/transactions"), { recursive: true });
  try {
    await symlink(outsideJournal, join(root, ".agent-team/transactions", name), "file");
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) throw error;
    await rm(outsideJournal);
    await mkdir(outsideJournal);
    await symlink(outsideJournal, join(root, ".agent-team/transactions", name), "junction");
  }

  const store = ProjectStore.open(root);
  await assert.rejects(() => store.inspectTransactions(), /PATH_OUTSIDE_PROJECT/);
  await assert.rejects(() => store.repairTransactions(), /PATH_OUTSIDE_PROJECT/);
  await assert.rejects(() => access(join(root, "promoted")), { code: "ENOENT" });
});

test("transaction replay rejects a receipt symlink outside the project", async (t) => {
  const root = await temporaryDirectory(t, "project-store-receipt-link-");
  const outside = await temporaryDirectory(t, "project-store-receipt-outside-");
  const operationId = "OP-LINKED-RECEIPT";
  const store = ProjectStore.open(root);
  const writes = [{ path: "value", content: "safe" }];
  const event = auditEvent(operationId);
  await store.transaction(operationId, writes, event);
  const name = `${createHash("sha256").update(operationId).digest("hex")}.json`;
  const receipt = join(root, ".agent-team/transactions/completed", name);
  const outsideReceipt = join(outside, name);
  await writeFile(outsideReceipt, await readFile(receipt));
  await rm(join(root, ".agent-team/transactions/completed"), { recursive: true });
  await symlink(outside, join(root, ".agent-team/transactions/completed"), "junction");

  await assert.rejects(() => store.transaction(operationId, writes, event), /PATH_OUTSIDE_PROJECT/);
  assert.equal(await readFile(join(root, "value"), "utf8"), "safe");
});
