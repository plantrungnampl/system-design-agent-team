import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  adoptProject,
  approve,
  diagnostics,
  doctor,
  gateReadinessReport,
  initProject,
  invokePlugin,
  issueList,
  inspectProject,
  loadExecutionReceipt,
  loadExecutionRequest,
  recordExecutionReceipt,
  recordExecutionRequest,
  rejectGate,
  repair,
  reviewPhase,
  secretsScan,
  setPluginStatus,
  startPhase,
  validatePhase,
} from "@system-design-team/cli";
import { ManualCodexAdapter } from "@system-design-team/codex-adapter";
import { WorkflowStateSchema } from "@system-design-team/core";
import { ProjectStore } from "@system-design-team/project-store";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const pluginUri = "plugin://superpowers@openai-curated-remote";
const lifecycleAuthorization = {
  actor: { type: "human", identifier: "project-owner" },
  authorizationSource: "test_authorization",
};

class FakePluginAdapter {
  async resolve(uri) {
    return { uri, publisher_identity: uri.split("@").at(-1), status: "available" };
  }

  async verifySkill() {
    return true;
  }

  async invoke(request) {
    return {
      plugin_uri: request.plugin_uri,
      publisher_identity: request.plugin_uri.split("@").at(-1),
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

async function repositorySnapshot(root, excluded = []) {
  const entries = [];
  const walk = async (directory, relative = "") => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (relative === "" && excluded.includes(child.name)) continue;
      const path = relative ? `${relative}/${child.name}` : child.name;
      if (child.isDirectory()) {
        entries.push({ path, type: "directory" });
        await walk(join(directory, child.name), path);
        continue;
      }
      const content = await readFile(join(directory, child.name));
      entries.push({
        path,
        type: "file",
        size: content.length,
        digest: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  await walk(root);
  const indexPath = join(root, ".git/index");
  const [index, indexStat] = await Promise.all([readFile(indexPath), stat(indexPath)]);
  return {
    entries,
    index: {
      digest: createHash("sha256").update(index).digest("hex"),
      mtimeMs: indexStat.mtimeMs,
      size: indexStat.size,
    },
  };
}

function reviewerResult(overrides = {}) {
  return {
    execution_id: "EXEC-REVIEW",
    dispatch_digest: "a".repeat(64),
    status: "completed",
    permission_profile: "read_only_assessment",
    authorized_paths: { read: [".agent-team/**"], write: [], execute: [] },
    command_class: "safe_read",
    destructive: false,
    checkpoints: [{
      id: "review-complete",
      status: "completed",
      timestamp: "2026-07-13T00:00:00.000Z",
      evidence: [`sha256:${"a".repeat(64)}`],
    }],
    evidence: { gate_approvals: [] },
    ...overrides,
  };
}

async function collectedReviewerResult(adapter, dispatchOverrides = {}, resultOverrides = {}) {
  const dispatch = {
    execution_id: "EXEC-REVIEW",
    agent_id: "code-reviewer",
    phase: "implementation",
    review_verdict: "approved",
    authorized_scope: { read: [".agent-team/**"], write: [], execute: [] },
    required_inputs: [],
    permission_profile: "read_only_assessment",
    command_class: "safe_read",
    ...dispatchOverrides,
  };
  const prepared = await adapter.prepareExecution(dispatch);
  return adapter.collectResult(await adapter.execute(prepared), reviewerResult({
    execution_id: dispatch.execution_id,
    dispatch_digest: prepared.digest,
    authorized_paths: dispatch.authorized_scope,
    ...resultOverrides,
  }));
}

async function reviewArtifactBinding(root, phase) {
  const project = parse(await readFile(join(root, ".agent-team/project.yaml"), "utf8"));
  const workflowFile = project.project.mode === "existing_system" ? "existing-system.yaml"
    : `${project.project.mode}.yaml`;
  const workflow = parse(await readFile(join(import.meta.dirname, "../workflows", workflowFile), "utf8"));
  const definition = workflow.phases.find(({ id }) => id === phase);
  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const artifacts = registry.artifacts.filter(({ owner, required_gate }) =>
    owner === definition.owner && required_gate === definition.gate);
  return {
    artifact_versions: Object.fromEntries(artifacts.map(({ id, version }) => [id, version])),
    artifact_checksums: Object.fromEntries(artifacts.map(({ id, checksum }) => [id, checksum])),
  };
}

async function recordReviewerReceipt(root, phase, reviewer, verdict, operationId) {
  const adapter = new ManualCodexAdapter();
  const result = await collectedReviewerResult(adapter, {
    execution_id: `EXEC-${operationId}`,
    agent_id: reviewer,
    phase,
    review_verdict: verdict,
    ...await reviewArtifactBinding(root, phase),
  });
  return recordExecutionReceipt(root, adapter, result, `RECEIPT-${operationId}`);
}

test("required CLI safety routes expose real project state", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-safety-routes-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-1");

  assert.deepEqual(await gateReadinessReport(root, "G0"), {
    gate: "G0",
    ready: false,
    blockers: ["PHASE_NOT_APPROVED:intake"],
  });
  assert.deepEqual(await diagnostics(root), await doctor(root));
  assert(Array.isArray((await issueList(root)).issues));
  assert.deepEqual(await secretsScan(root), { valid: true, findings: [] });

  const bin = join(import.meta.dirname, "../packages/cli/dist/bin.js");
  const { stdout } = await execFileAsync(process.execPath, [bin, "--help"], { cwd: root });
  for (const command of ["reject <gate>", "gate readiness <gate>", "secrets scan", "diagnostics", "issue list"]) {
    assert(stdout.includes(command));
  }
  assert(stdout.includes("--execution-receipt <id>"));
});

test("repository inspection preserves repository contents and Git index cross-platform", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-read-only-inspect-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  const source = join(root, "source.txt");
  await writeFile(source, "immutable source\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: root });
  await utimes(source, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  if (process.platform !== "win32") await chmod(source, 0o444);
  const before = { repository: await repositorySnapshot(root), source: await stat(source) };

  const first = await inspectProject(root);
  const second = await inspectProject(root);

  assert.deepEqual(second, first);
  assert.deepEqual(await repositorySnapshot(root), before.repository);
  const afterSource = await stat(source);
  assert.equal(afterSource.mtimeMs, before.source.mtimeMs);
  assert.equal(afterSource.size, before.source.size);
  if (process.platform !== "win32") assert.equal(afterSource.mode & 0o777, 0o444);
  await assert.rejects(() => access(join(root, ".agent-team")), { code: "ENOENT" });
});

test("adopt inventory preserves non-framework repository contents and Git index", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-no-write-adopt-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  const source = join(root, "source.ts");
  await writeFile(source, "export const source = true;\n");
  await execFileAsync("git", ["add", "source.ts"], { cwd: root });
  await utimes(source, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  const before = await repositorySnapshot(root, [".agent-team", ".codex"]);

  await adoptProject(root, {
    id: "no-write-adopt",
    name: "No Write Adopt",
    profile: "standard",
  }, "ADOPT-NO-WRITE", lifecycleAuthorization);

  assert.deepEqual(await repositorySnapshot(root, [".agent-team", ".codex"]), before);
});

test("secrets scan reports tracked and untracked credentials but excludes ignored and binary files", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-secret-scan-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\nbuild/\ncoverage/\n.agent-team/cache/\n");
  await writeFile(join(root, "config.txt"), "api_key = 'not-a-real-secret-value'\n");
  await writeFile(join(root, "cookie.txt"), "session_token=abcdefghijklmnopqrstuvwxyz\n");
  await writeFile(join(root, "database.txt"), "postgresql://admin:password@prod.example/app\n");
  await writeFile(join(root, "private.pem"), "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----\n");
  await writeFile(join(root, "provider.txt"), "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz123456\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await writeFile(join(root, "untracked.txt"), "api_key = 'untracked-not-real-secret'\n");
  await writeFile(join(root, "binary.dat"), Buffer.from("\0api_key = 'binary-not-real-secret'"));
  for (const directory of ["node_modules", "dist", "build", "coverage", ".agent-team/cache"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "ignored.txt"), "api_key = 'ignored-not-real-secret'\n");
  }
  await writeFile(join(root, "dist/tracked-release.txt"), "api_key = 'tracked-release-not-real-secret'\n");
  await execFileAsync("git", ["add", "-f", "binary.dat", "dist/tracked-release.txt"], { cwd: root });

  const result = await secretsScan(root);

  assert.equal(result.valid, false);
  assert.deepEqual(result.findings.map(({ path }) => path), [
    "config.txt",
    "cookie.txt",
    "database.txt",
    "dist/tracked-release.txt",
    "private.pem",
    "provider.txt",
    "untracked.txt",
  ]);
  assert(!JSON.stringify(result).includes("not-a-real-secret-value"));
});

test("hand-written tracked execution result is not a trusted receipt", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-execution-file-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-2");
  await writeFile(join(root, "g7-execution.yaml"), JSON.stringify(reviewerResult()));
  await execFileAsync("git", ["add", "g7-execution.yaml"], { cwd: root });

  await assert.rejects(() => loadExecutionReceipt(root, "g7-execution.yaml"), /EXECUTION_RECEIPT_NOT_FOUND/);
});

test("prepared execution requests persist with replay, conflict, and audit binding", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-execution-request-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-3");
  const adapter = new ManualCodexAdapter(async () => ({
    artifacts: [], reviews: [], approvals: [], verified_checksums: {},
    workflow: {
      id: "request-test", version: "1.0.0", mode: "greenfield",
      phases: [{
        id: "deployment", owner: "devops-lead", reviewer: "operations-reviewer", gate: "G8",
        depends_on: [], required_plugins: [],
        artifact: { id: "DEPLOYMENT-PLAN", path: "release/deployment-plan.md", title: "Deployment Plan" },
      }],
    },
  }));
  const prepared = await adapter.prepareExecution({
    execution_id: "EXEC-PRODUCTION",
    operation_id: "DEPLOY-1",
    objective: "Deploy release",
    authorized_scope: { read: ["release/**"], write: ["release/**"], execute: ["deploy"] },
    required_inputs: [],
    permission_profile: "production_execution",
    command_class: "production_impact",
    execution_evidence: { gate_approvals: [] },
  });

  const first = await recordExecutionRequest(root, adapter, prepared, "REQUEST-1");
  assert.deepEqual(await recordExecutionRequest(root, adapter, prepared, "REQUEST-1"), first);
  assert.deepEqual(await loadExecutionRequest(root, first.id), first);
  await assert.rejects(
    () => recordExecutionRequest(root, adapter, structuredClone(prepared), "REQUEST-2"),
    /PREPARED_EXECUTION_INVALID/,
  );
  const audit = await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8");
  assert(audit.includes(first.attestation_digest));
});

test("only an adapter-collected result records an audited receipt with safe replay", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-execution-receipt-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-4");
  const adapter = new ManualCodexAdapter();
  const collected = await collectedReviewerResult(adapter);

  await assert.rejects(
    () => recordExecutionReceipt(root, adapter, structuredClone(collected), "RECEIPT-1"),
    /EXECUTION_RESULT_NOT_COLLECTED/,
  );
  await assert.rejects(
    () => recordExecutionReceipt(root, {
      createExecutionReceipt: (result) => adapter.createExecutionReceipt(result),
    }, collected, "RECEIPT-WRAPPER"),
    /EXECUTION_ADAPTER_REQUIRED/,
  );
  const first = await recordExecutionReceipt(root, adapter, collected, "RECEIPT-1");
  assert.deepEqual(await recordExecutionReceipt(root, adapter, collected, "RECEIPT-1"), first);
  assert.deepEqual(await loadExecutionReceipt(root, first.id), first);
  const audit = await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8");
  assert.equal(audit.split(/\r?\n/).filter((line) => line.includes(first.id)).length, 1);
  const receiptAudit = audit.split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .find(({ action }) => action === "execution-receipt");
  assert.equal(receiptAudit.permission_profile, "read_only_assessment");

  const other = await collectedReviewerResult(adapter, { execution_id: "EXEC-OTHER" });
  await assert.rejects(
    () => recordExecutionReceipt(root, adapter, other, "RECEIPT-1"),
    /OPERATION_ID_CONFLICT/,
  );

  const receiptPath = join(root, ".agent-team/execution-receipts.yaml");
  const tampered = parse(await readFile(receiptPath, "utf8"));
  tampered.receipts[0].result.command_class = "local_validation";
  await writeFile(receiptPath, JSON.stringify(tampered));
  await assert.rejects(
    () => loadExecutionReceipt(root, first.id),
    /EXECUTION_RECEIPT_DIGEST_MISMATCH/,
  );
});

test("gate readiness CLI accepts an audited execution receipt for G7 and G8", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-gate-evidence-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-5");
  const adapter = new ManualCodexAdapter();
  const collected = await collectedReviewerResult(adapter);
  const receipt = await recordExecutionReceipt(root, adapter, collected, "GATE-RECEIPT");
  const bin = join(import.meta.dirname, "../packages/cli/dist/bin.js");

  for (const gate of ["G7", "G8"]) {
    const { stdout } = await execFileAsync(process.execPath, [
      bin,
      "gate",
      "readiness",
      gate,
      "--execution-receipt",
      receipt.id,
    ], { cwd: root });
    const result = JSON.parse(stdout);
    assert.equal(result.gate, gate);
    assert.equal(result.ready, false);
    assert(result.blockers.some((blocker) => blocker.includes("EVIDENCE")));
  }
});

test("G7 review binds its receipt to reviewer identity, phase, and verdict", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-review-execution-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-6");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.implementation.status = "artifact_validation";
  state.current_phase = "implementation";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const artifact = registry.artifacts.find(({ id }) => id === "IMPLEMENTATION-EVIDENCE");
  artifact.status = "in_review";
  const content = [
    "---",
    "artifact_id: IMPLEMENTATION-EVIDENCE",
    "version: 1",
    "status: in_review",
    "owner: developer",
    "reviewer: code-reviewer",
    "---",
    "# Implementation Evidence",
    "Current evidence.",
  ].join("\n");
  artifact.checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, content);
  const artifactBinding = {
    artifact_versions: { "IMPLEMENTATION-EVIDENCE": 1 },
    artifact_checksums: { "IMPLEMENTATION-EVIDENCE": artifact.checksum },
  };

  await assert.rejects(() => reviewPhase(
    root,
    "implementation",
    "code-reviewer",
    "approved",
    "G7-REVIEW",
    pluginAdapter,
  ), /REVIEW_EXECUTION_RECEIPT_REQUIRED/);

  const adapter = new ManualCodexAdapter();
  const wrongArtifactResult = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-WRONG-ARTIFACT",
    ...artifactBinding,
    artifact_checksums: { "IMPLEMENTATION-EVIDENCE": `sha256:${"0".repeat(64)}` },
  });
  const wrongArtifactReceipt = await recordExecutionReceipt(
    root,
    adapter,
    wrongArtifactResult,
    "RECEIPT-WRONG-ARTIFACT",
  );
  await assert.rejects(() => reviewPhase(
    root,
    "implementation",
    "code-reviewer",
    "approved",
    "G7-REVIEW",
    pluginAdapter,
    wrongArtifactReceipt.id,
  ), /REVIEWER_EXECUTION_ARTIFACT_MISMATCH/);

  for (const [dispatchOverride, expected] of [
    [{ agent_id: "wrong-reviewer" }, /REVIEWER_EXECUTION_IDENTITY_MISMATCH/],
    [{ phase: "verification" }, /REVIEWER_EXECUTION_PHASE_MISMATCH/],
    [{ review_verdict: "revision_required" }, /REVIEWER_EXECUTION_VERDICT_MISMATCH/],
  ]) {
    const collected = await collectedReviewerResult(adapter, {
      execution_id: `EXEC-${Object.keys(dispatchOverride)[0]}`,
      ...artifactBinding,
      ...dispatchOverride,
    });
    const receipt = await recordExecutionReceipt(
      root,
      adapter,
      collected,
      `RECEIPT-${Object.keys(dispatchOverride)[0]}`,
    );
    await assert.rejects(() => reviewPhase(
      root,
      "implementation",
      "code-reviewer",
      "approved",
      "G7-REVIEW",
      pluginAdapter,
      receipt.id,
    ), expected);
  }

  const collected = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-MATCHING",
    ...artifactBinding,
  });
  const receipt = await recordExecutionReceipt(root, adapter, collected, "RECEIPT-MATCHING");
  const reviewed = await reviewPhase(
    root,
    "implementation",
    "code-reviewer",
    "approved",
    "G7-REVIEW",
    pluginAdapter,
    receipt.id,
  );
  assert.equal(reviewed.phases.implementation.status, "awaiting_approval");
});

test("G8 approval persists an exact prepared request authorization and rejects replay drift", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-g8-approval-request-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-7");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.deployment = {
    status: "artifact_validation",
  };
  state.current_phase = "deployment";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);

  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const evidence = [
    ["TEST-SUMMARY", "verification", "qa-lead", "tester", "approved"],
    ["RELEASE-READINESS", "release-readiness", "security-reviewer", "architecture-reviewer", "approved"],
    ["DEPLOYMENT-PLAN", "deployment", "devops-lead", "operations-reviewer", "in_review"],
  ];
  const reviews = [];
  for (const [artifactId, phase, owner, reviewer, status] of evidence) {
    const artifact = registry.artifacts.find(({ id }) => id === artifactId);
    artifact.status = status;
    const content = [
      "---",
      `artifact_id: ${artifactId}`,
      "version: 1",
      `status: ${status}`,
      `owner: ${owner}`,
      `reviewer: ${reviewer}`,
      "---",
      `# ${artifactId}`,
      "Current evidence.",
    ].join("\n");
    artifact.checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await store.writeTextAtomic(`.agent-team/${artifact.path}`, content);
    if (artifactId !== "DEPLOYMENT-PLAN") {
      reviews.push({
        id: `REV-${artifactId}`,
        phase,
        reviewer,
        verdict: "approved",
        artifact_versions: { [artifactId]: 1 },
        timestamp: "2026-07-13T00:00:00.000Z",
      });
    }
  }
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeYamlAtomic(".agent-team/reviews.yaml", { reviews });
  await store.writeYamlAtomic(".agent-team/approvals.yaml", { approvals: [{
    id: "APR-G7-EVIDENCE",
    gate: "G7",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { "TEST-SUMMARY": 1, "RELEASE-READINESS": 1 },
    timestamp: "2026-07-13T00:00:00.000Z",
  }] });

  const workflow = parse(await readFile(join(import.meta.dirname, "../workflows/greenfield.yaml"), "utf8"));
  const artifacts = registry.artifacts.filter(({ id }) => evidence.some(([artifactId]) => artifactId === id));
  const context = {
    workflow,
    artifacts,
    reviews,
    approvals: parse(await readFile(join(root, ".agent-team/approvals.yaml"), "utf8")).approvals,
    verified_checksums: Object.fromEntries(artifacts.map(({ id, checksum }) => [id, checksum])),
  };
  const qa = {
    artifact_id: "TEST-SUMMARY", version: 1, status: "approved",
    review_id: "REV-TEST-SUMMARY", approval_id: "APR-G7-EVIDENCE",
  };
  const security = {
    artifact_id: "RELEASE-READINESS", version: 1, status: "approved",
    review_id: "REV-RELEASE-READINESS", approval_id: "APR-G7-EVIDENCE",
  };
  const deployment = {
    artifact_id: "DEPLOYMENT-PLAN", version: 1, status: "in_review",
    review_id: "PENDING-DEPLOYMENT-REVIEW",
  };
  const adapter = new ManualCodexAdapter(async () => context);
  const prepare = (executionId) => adapter.prepareExecution({
    execution_id: executionId,
    operation_id: `DEPLOY-${executionId}`,
    objective: "Deploy the approved release",
    authorized_scope: { read: ["release/**"], write: ["release/**"], execute: ["deploy"] },
    required_inputs: [],
    permission_profile: "production_execution",
    command_class: "production_impact",
    execution_evidence: { gate_approvals: [], qa, security, backup: deployment, rollback: deployment },
  });
  const approvalResult = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-G8-APPROVAL-REVIEW",
    agent_id: "operations-reviewer",
    phase: "deployment",
    ...await reviewArtifactBinding(root, "deployment"),
  }, { evidence: { gate_approvals: [], qa, security, backup: deployment, rollback: deployment } });
  const receipt = await recordExecutionReceipt(root, adapter, approvalResult, "RECEIPT-G8-APPROVAL");
  const reviewed = await reviewPhase(
    root, "deployment", "operations-reviewer", "approved", "REVIEW-G8-APPROVAL", pluginAdapter, receipt.id,
  );
  assert.equal(reviewed.phases.deployment.status, "awaiting_approval");
  context.reviews = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8")).reviews;
  const prepared = await prepare("EXEC-G8-APPROVAL");
  const request = await recordExecutionRequest(root, adapter, prepared, "REQUEST-G8-APPROVAL");
  const approved = await approve(root, "G8", "project-owner", "APPROVE-G8", receipt.id, request.id);
  assert.equal(approved.phases.deployment.status, "approved");

  const persisted = parse(await readFile(join(root, ".agent-team/approvals.yaml"), "utf8"))
    .approvals.find(({ gate }) => gate === "G8");
  assert.equal(persisted.execution_request_id, request.id);
  assert.equal(persisted.execution_request_digest, request.attestation_digest);
  assert.equal(persisted.execution_receipt_id, receipt.id);
  assert.equal(persisted.execution_receipt_digest, receipt.attestation_digest);
  assert.deepEqual(persisted.execution_authorization, request.authorization);
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse)
    .find(({ action, target }) => action === "approve" && target === "G8");
  assert.equal(audit.execution_request_id, request.id);
  assert.equal(audit.execution_request_digest, request.attestation_digest);
  assert.equal(audit.execution_receipt_id, receipt.id);
  assert.equal(audit.execution_receipt_digest, receipt.attestation_digest);
  assert.deepEqual(await approve(root, "G8", "project-owner", "APPROVE-G8", receipt.id, request.id), approved);

  const conflicting = await recordExecutionRequest(
    root, adapter, await prepare("EXEC-G8-CONFLICT"), "REQUEST-G8-CONFLICT",
  );
  await assert.rejects(
    () => approve(root, "G8", "project-owner", "APPROVE-G8", receipt.id, conflicting.id),
    /OPERATION_ID_CONFLICT/,
  );
});

test("existing-system G8 review and exact request approval progress without a pre-existing G8 approval", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-existing-g8-lifecycle-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "existing-system",
    name: "Existing System",
    mode: "existing_system",
    profile: "standard",
  }, "INIT-SECURITY-8");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.release.status = "artifact_validation";
  state.current_phase = "release";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);

  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const evidence = [
    ["REGRESSION-SUMMARY", "regression-security-testing", "qa-lead", "tester", "approved"],
    ["SECURITY-VERDICT", "security-review", "security-reviewer", "architecture-reviewer", "approved"],
    ["RELEASE-PLAN", "release", "devops-lead", "operations-reviewer", "in_review"],
  ];
  for (const [artifactId, , owner, reviewer, status] of evidence) {
    const artifact = registry.artifacts.find(({ id }) => id === artifactId);
    artifact.status = status;
    const content = [
      "---",
      `artifact_id: ${artifactId}`,
      "version: 1",
      `status: ${status}`,
      `owner: ${owner}`,
      `reviewer: ${reviewer}`,
      "---",
      `# ${artifactId}`,
      "Current evidence.",
    ].join("\n");
    artifact.checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await store.writeTextAtomic(`.agent-team/${artifact.path}`, content);
  }
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  const priorReviews = evidence.slice(0, 2).map(([artifactId, phase, , reviewer]) => ({
    id: `REV-${artifactId}`,
    phase,
    reviewer,
    verdict: "approved",
    artifact_versions: { [artifactId]: 1 },
    timestamp: "2026-07-13T00:00:00.000Z",
  }));
  const priorApprovals = evidence.slice(0, 2).map(([artifactId], index) => ({
    id: `APR-${artifactId}`,
    gate: "G7",
    decision: "approved",
    approved_by: { type: "human", identifier: "project-owner" },
    artifact_versions: { [artifactId]: 1 },
    timestamp: `2026-07-13T00:00:0${index}.000Z`,
  }));
  await store.writeYamlAtomic(".agent-team/reviews.yaml", { reviews: priorReviews });
  await store.writeYamlAtomic(".agent-team/approvals.yaml", { approvals: priorApprovals });

  const reference = (artifactId, status, approvalId) => ({
    artifact_id: artifactId,
    version: 1,
    status,
    review_id: `REV-${artifactId === "RELEASE-PLAN" ? "RELEASE" : artifactId}`,
    ...(approvalId ? { approval_id: approvalId } : {}),
  });
  const releaseEvidence = {
    gate_approvals: [],
    qa: reference("REGRESSION-SUMMARY", "approved", "APR-REGRESSION-SUMMARY"),
    security: reference("SECURITY-VERDICT", "approved", "APR-SECURITY-VERDICT"),
    backup: reference("RELEASE-PLAN", "in_review"),
    rollback: reference("RELEASE-PLAN", "in_review"),
  };
  const workflow = parse(await readFile(join(import.meta.dirname, "../workflows/existing-system.yaml"), "utf8"));
  const artifacts = registry.artifacts.filter(({ id }) => evidence.some(([artifactId]) => artifactId === id));
  const context = {
    workflow,
    artifacts,
    reviews: priorReviews,
    approvals: priorApprovals,
    verified_checksums: Object.fromEntries(artifacts.map(({ id, checksum }) => [id, checksum])),
  };
  const adapter = new ManualCodexAdapter(async () => context);
  const reviewResult = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-EXISTING-G8-REVIEW",
    agent_id: "operations-reviewer",
    phase: "release",
    ...await reviewArtifactBinding(root, "release"),
  }, { evidence: releaseEvidence });
  const receipt = await recordExecutionReceipt(root, adapter, reviewResult, "RECEIPT-EXISTING-G8");
  const reviewed = await reviewPhase(
    root, "release", "operations-reviewer", "approved", "REVIEW-EXISTING-G8", pluginAdapter, receipt.id,
  );
  assert.equal(reviewed.phases.release.status, "awaiting_approval");
  context.reviews = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8")).reviews;

  const prepared = await adapter.prepareExecution({
    execution_id: "EXEC-EXISTING-G8",
    operation_id: "DEPLOY-EXISTING",
    objective: "Release the existing system",
    authorized_scope: { read: ["release/**"], write: ["release/**"], execute: ["deploy"] },
    required_inputs: [],
    permission_profile: "production_execution",
    command_class: "production_impact",
    execution_evidence: releaseEvidence,
  });
  const request = await recordExecutionRequest(root, adapter, prepared, "REQUEST-EXISTING-G8");
  const approved = await approve(
    root, "G8", "project-owner", "APPROVE-EXISTING-G8", receipt.id, request.id,
  );
  assert.equal(approved.phases.release.status, "approved");
});

test("G8 reviewer receipt does not require production pre-authorization", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-g8-review-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-9");
  const store = ProjectStore.open(root);
  const state = await store.readWorkflowState();
  state.phases.deployment.status = "artifact_validation";
  state.current_phase = "deployment";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", state);
  const registry = parse(await readFile(join(root, ".agent-team/artifact-registry.yaml"), "utf8"));
  const artifact = registry.artifacts.find(({ id }) => id === "DEPLOYMENT-PLAN");
  artifact.status = "in_review";
  const content = [
    "---",
    "artifact_id: DEPLOYMENT-PLAN",
    "version: 1",
    "status: in_review",
    "owner: devops-lead",
    "reviewer: operations-reviewer",
    "---",
    "# Deployment Plan",
    "Current evidence.",
  ].join("\n");
  artifact.checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await store.writeYamlAtomic(".agent-team/artifact-registry.yaml", registry);
  await store.writeTextAtomic(`.agent-team/${artifact.path}`, content);
  const adapter = new ManualCodexAdapter();
  const collected = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-G8-REVIEW",
    agent_id: "operations-reviewer",
    phase: "deployment",
    ...await reviewArtifactBinding(root, "deployment"),
  });
  const receipt = await recordExecutionReceipt(root, adapter, collected, "RECEIPT-G8-REVIEW");

  const reviewed = await reviewPhase(
    root,
    "deployment",
    "operations-reviewer",
    "approved",
    "G8-REVIEW",
    pluginAdapter,
    receipt.id,
  );
  assert.equal(reviewed.phases.deployment.status, "awaiting_approval");

  const reset = await store.readWorkflowState();
  reset.phases.deployment.status = "artifact_validation";
  await store.writeYamlAtomic(".agent-team/workflow-state.yaml", reset);

  const revisionResult = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-G8-REVISION",
    agent_id: "operations-reviewer",
    phase: "deployment",
    review_verdict: "revision_required",
    ...await reviewArtifactBinding(root, "deployment"),
  });
  const revisionReceipt = await recordExecutionReceipt(
    root, adapter, revisionResult, "RECEIPT-G8-REVISION",
  );
  const revised = await reviewPhase(
    root,
    "deployment",
    "operations-reviewer",
    "revision_required",
    "G8-REVISION",
    pluginAdapter,
    revisionReceipt.id,
  );
  assert.equal(revised.phases.deployment.status, "revision_required");
  const reviews = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8"));
  assert.equal(reviews.reviews.at(-1).execution_receipt_id, revisionReceipt.id);
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  const reviewAudit = audit.filter(({ action, target }) => action === "review" && target === "deployment").at(-1);
  assert.equal(reviewAudit.execution_receipt_id, revisionReceipt.id);

  const conflictingResult = await collectedReviewerResult(adapter, {
    execution_id: "EXEC-G8-REVISION-CONFLICT",
    agent_id: "operations-reviewer",
    phase: "deployment",
    review_verdict: "revision_required",
    ...await reviewArtifactBinding(root, "deployment"),
  });
  const conflictingReceipt = await recordExecutionReceipt(
    root, adapter, conflictingResult, "RECEIPT-G8-REVISION-CONFLICT",
  );
  await assert.rejects(() => reviewPhase(
    root,
    "deployment",
    "operations-reviewer",
    "revision_required",
    "G8-REVISION",
    pluginAdapter,
    conflictingReceipt.id,
  ), /OPERATION_ID_CONFLICT/);
});

test("reject records a human decision and append-only audit event", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-reject-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-10");
  await startPhase(root, "intake", "REJECT-START", pluginAdapter);
  const store = ProjectStore.open(root);
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
  await validatePhase(root, "intake", "REJECT-VALIDATE");
  const reviewReceipt = await recordReviewerReceipt(
    root, "intake", "documentation-reviewer", "approved", "REJECT-REVIEW",
  );
  await reviewPhase(
    root, "intake", "documentation-reviewer", "approved", "REJECT-REVIEW", pluginAdapter, reviewReceipt.id,
  );

  const rejected = await rejectGate(root, "G0", "project-owner", "REJECT-G0");
  const approvals = parse(await readFile(join(root, ".agent-team/approvals.yaml"), "utf8"));
  const audit = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);

  assert.equal(rejected.phases.intake.status, "revision_required");
  assert.equal(approvals.approvals.at(-1).decision, "rejected");
  assert(audit.some(({ action, result }) => action === "reject" && result === "success"));
});

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
  }, "INIT-SECURITY-11");
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

test("phase start cannot overwrite a concurrent workflow-state update", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-start-concurrency-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-START-CONCURRENCY");
  const store = ProjectStore.open(root);
  let updated = false;
  const concurrentAdapter = {
    ...pluginAdapter,
    async resolve(uri) {
      if (!updated) {
        updated = true;
        const statePath = join(root, ".agent-team/workflow-state.yaml");
        const current = parse(await readFile(statePath, "utf8"));
        await writeFile(statePath, stringify(WorkflowStateSchema.parse({
          ...current,
          state_version: current.state_version + 1,
          completed_operations: [...current.completed_operations, "CONCURRENT-UPDATE"],
        })));
      }
      return { uri, publisher_identity: uri.split("@").at(-1), status: "available" };
    },
    async verifySkill() { return true; },
    async invoke(request) { return pluginAdapter.invoke(request); },
  };

  await assert.rejects(
    () => startPhase(root, "intake", "START-CONCURRENCY", concurrentAdapter),
    /STATE_VERSION_CONFLICT/,
  );
  const state = await store.readWorkflowState();
  assert.equal(state.phases.intake.status, "ready");
  assert(state.completed_operations.includes("CONCURRENT-UPDATE"));
});

test("verified plugin invocation persists sanitized evidence", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-plugin-evidence-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-12");

  const adapter = new FakePluginAdapter();
  let runtimeRequest;
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = async (request) => {
    runtimeRequest = structuredClone(request);
    return invoke(request);
  };
  const result = await invokePlugin(root, adapter, {
    plugin_uri: pluginUri,
    skill: "brainstorming",
    input: { objective: "requirements", secret: "input-only" },
  }, "PLUGIN-EVIDENCE");
  const evidenceText = await readFile(join(root, ".agent-team/plugin-invocations.yaml"), "utf8");
  const evidence = parse(evidenceText);

  assert.equal(result.output.secret, "runtime-only");
  assert.equal(runtimeRequest.operation_id, "PLUGIN-EVIDENCE");
  assert.equal(evidence.invocations.length, 1);
  assert.equal(evidence.invocations[0].operation_id, "PLUGIN-EVIDENCE");
  assert.equal(evidence.invocations[0].execution_reference, "fake-execution-persisted");
  assert(!evidenceText.includes("input-only"));
  assert(!evidenceText.includes("runtime-only"));
  assert(!evidenceText.includes("must never be stored"));
});

test("plugin invocation replay reuses persisted evidence without invoking twice", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-plugin-replay-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-13");
  const adapter = new FakePluginAdapter();
  let invocationCount = 0;
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = async (request) => {
    invocationCount += 1;
    return invoke(request);
  };
  const request = {
    plugin_uri: pluginUri,
    skill: "brainstorming",
    input: { objective: "requirements" },
  };

  const first = await invokePlugin(root, adapter, request, "PLUGIN-REPLAY");
  const auditPath = join(root, ".agent-team/audit/events.jsonl");
  const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);
  await writeFile(
    auditPath,
    `${audit.filter(({ action }) => action !== "plugin-invocation").map(JSON.stringify).join("\n")}\n`,
  );
  const replay = await invokePlugin(root, adapter, request, "PLUGIN-REPLAY");
  const evidence = parse(await readFile(join(root, ".agent-team/plugin-invocations.yaml"), "utf8"));
  const repairedAudit = (await readFile(auditPath, "utf8")).trim().split("\n").map(JSON.parse);

  assert.equal(invocationCount, 1);
  assert.deepEqual(replay.evidence, first.evidence);
  assert.equal(replay.output, undefined);
  assert.equal(evidence.invocations.length, 1);
  assert.equal(repairedAudit.filter(({ action, result }) =>
    action === "plugin-invocation" && result === "success").length, 1);
});

test("failed plugin invocation appends a redacted failure audit without success evidence", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-plugin-failure-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-14");
  const adapter = new FakePluginAdapter();
  adapter.invoke = async () => { throw new Error("runtime secret"); };

  await assert.rejects(
    () => invokePlugin(root, adapter, {
      plugin_uri: pluginUri,
      skill: "brainstorming",
      input: { secret: "input secret" },
    }, "PLUGIN-FAILED"),
    /PLUGIN_INVOCATION_FAILED/,
  );
  const auditText = await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8");
  const events = auditText.trim().split("\n").map(JSON.parse);
  const evidence = parse(await readFile(join(root, ".agent-team/plugin-invocations.yaml"), "utf8"));

  assert(events.some(({ action, result }) => action === "plugin-invocation" && result === "failure"));
  assert.deepEqual(evidence.invocations, []);
  assert(!auditText.includes("runtime secret"));
  assert(!auditText.includes("input secret"));
});

test("malformed plugin result appends a redacted failure audit without success evidence", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-plugin-malformed-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-15");
  const adapter = new FakePluginAdapter();
  adapter.invoke = async (request) => ({
    plugin_uri: request.plugin_uri,
    publisher_identity: "openai-curated-remote",
    status: "success",
    output: { secret: "output secret" },
  });

  await assert.rejects(
    () => invokePlugin(root, adapter, {
      plugin_uri: pluginUri,
      skill: "brainstorming",
      input: { secret: "input secret" },
    }, "PLUGIN-MALFORMED"),
    /PLUGIN_INVOCATION_RESULT_INVALID/,
  );
  const auditText = await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8");
  const events = auditText.trim().split("\n").map(JSON.parse);
  const evidence = parse(await readFile(join(root, ".agent-team/plugin-invocations.yaml"), "utf8"));

  assert(events.some(({ action, result }) => action === "plugin-invocation" && result === "failure"));
  assert.deepEqual(evidence.invocations, []);
  assert(!auditText.includes("output secret"));
  assert(!auditText.includes("input secret"));
});

test("lifecycle lock serializes plugin status and phase start", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-lifecycle-race-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-16");
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
    }, "INIT-SECURITY-17"), /STATE_LOCKED/);
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
  }, "INIT-SECURITY-18");
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

test("repair clears abandoned dependency locks before recovering a crashed adoption", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-adopt-crash-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "source.ts"), "export const source = true;\n");
  await execFileAsync("git", ["add", "source.ts"], { cwd: root });
  const moduleUrl = new URL("../packages/cli/dist/index.js", import.meta.url).href;
  const options = { id: "crash-adopt", name: "Crash Adopt", profile: "standard" };
  const child = spawn(process.execPath, ["--input-type=module", "-e", [
    `import { adoptProject } from ${JSON.stringify(moduleUrl)};`,
    `await adoptProject(${JSON.stringify(root)}, ${JSON.stringify(options)}, "ADOPT-CRASH", ${JSON.stringify(lifecycleAuthorization)}, {`,
    `  transactionFault: (point) => { if (point === "after_evidence_write") process.exit(86); },`,
    `});`,
  ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const [code] = await once(child, "exit");
  assert.equal(code, 86);
  await access(join(root, ".system-design-team-init.lock"));
  await access(join(root, ".agent-team/transactions.lock"));

  const repaired = await repair(root, { locks: true, confirmedQuiescent: true });
  assert(repaired.repaired.includes(".system-design-team-init.lock"));
  assert(repaired.repaired.includes(".agent-team/transactions.lock"));
  assert(repaired.repaired.some((item) => item.startsWith("transaction:")));
  assert.deepEqual(await ProjectStore.open(root).inspectTransactions(), []);

  const adopted = await adoptProject(
    root,
    options,
    "ADOPT-CRASH",
    lifecycleAuthorization,
  );
  assert.equal(adopted.project.project.id, "crash-adopt");
  assert.deepEqual(parse(await readFile(join(root, ".agent-team/inventory.yaml"), "utf8")), adopted.inventory);
  const events = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "adopt").length, 1);
});

test("completed lifecycle replay repairs a missing audit event once", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-audit-recovery-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-SECURITY-19");
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

test("start and validate recover state and audit as one transaction", async (t) => {
  const root = await temporaryDirectory(t, "system-design-team-state-audit-transaction-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await initProject(root, {
    id: "leave-system",
    name: "Leave System",
    mode: "greenfield",
    profile: "standard",
  }, "INIT-STATE-AUDIT");

  const failBeforeAudit = {
    transactionFault(point) {
      if (point === "before_audit_append") throw new Error("INTERRUPTED_BEFORE_AUDIT");
    },
  };
  await assert.rejects(
    () => startPhase(root, "intake", "TX-START", pluginAdapter, failBeforeAudit),
    /INTERRUPTED_BEFORE_AUDIT/,
  );
  assert.deepEqual(await ProjectStore.open(root).inspectTransactions(), [
    JSON.stringify(["start", "intake", "TX-START"]),
  ]);
  await ProjectStore.open(root).repairTransactions();

  const store = ProjectStore.open(root);
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

  await assert.rejects(
    () => validatePhase(root, "intake", "TX-VALIDATE", failBeforeAudit),
    /INTERRUPTED_BEFORE_AUDIT/,
  );
  assert.deepEqual(await store.inspectTransactions(), [
    JSON.stringify(["validate", "intake", "TX-VALIDATE"]),
  ]);
  await store.repairTransactions();

  const state = await store.readWorkflowState();
  assert.equal(state.phases.intake.status, "artifact_validation");
  const events = (await readFile(join(root, ".agent-team/audit/events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "start").length, 1);
  assert.equal(events.filter(({ action }) => action === "validate").length, 1);
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
  }, "INIT-SECURITY-20");
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
  const reviewReceipt = await recordReviewerReceipt(
    root, "intake", "documentation-reviewer", "approved", "OP-REVIEW",
  );

  await store.withLock(".agent-team/lifecycle.lock", async () => {
    await assert.rejects(
      () => reviewPhase(
        root, "intake", "documentation-reviewer", "approved", "OP-REVIEW", undefined, reviewReceipt.id,
      ),
      /STATE_LOCKED/,
    );
  });
  await reviewPhase(
    root, "intake", "documentation-reviewer", "approved", "OP-REVIEW", pluginAdapter, reviewReceipt.id,
  );

  const state = await store.readWorkflowState();
  const { reviews } = parse(await readFile(join(root, ".agent-team/reviews.yaml"), "utf8"));
  assert.deepEqual(reviews.map(({ id, artifact_versions }) => ({ id, artifact_versions })), [{
    id: JSON.stringify(["review", "intake", "OP-REVIEW"]),
    artifact_versions: { "PROJECT-CHARTER": 1 },
  }]);
  assert.equal(state.phases.intake.status, "awaiting_approval");
  assert.equal(state.phases.intake.review_id, JSON.stringify(["review", "intake", "OP-REVIEW"]));
});
