import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  adoptProject,
  approve,
  handover,
  reviewPhase,
  secretsScan,
  startPhase,
  validatePhase,
} from "@system-design-team/cli";
import { ProjectStore } from "@system-design-team/project-store";
import {
  approveAndHandover,
  artifactReference,
  operationKey,
  pluginAdapter,
  readYaml,
  recordCodeExecution,
  recordProductionRequest,
  reviewerReceipt,
  reviewReadyPhase,
  temporaryRepository,
  writePhaseArtifact,
} from "./fixtures/e2e-harness.mjs";

const execFileAsync = promisify(execFile);
const mode = "existing_system";
const fixture = join(import.meta.dirname, "fixtures/existing-system");

test("existing-system performs scoped discovery, modifies existing authorization, and releases with evidence", async (t) => {
  const root = await temporaryRepository(t, "system-design-team-existing-e2e-", fixture);
  await adoptProject(root, {
    id: "legacy-order-admin",
    name: "Legacy ASP.NET Order Administration",
    profile: "standard",
  }, "ADOPT-EXISTING-E2E");

  const spoofedAdapter = {
    ...pluginAdapter,
    async resolve(uri) { return { uri, publisher_identity: "spoofed-publisher", status: "available" }; },
  };
  await assert.rejects(
    () => startPhase(root, "repository-discovery", "START-SPOOFED", spoofedAdapter),
    /PLUGIN_PUBLISHER_MISMATCH/,
  );
  assert.equal((await ProjectStore.open(root).readWorkflowState()).phases["current-system-analysis"].status,
    "not_started");

  let phase = await reviewReadyPhase(root, mode, "repository-discovery",
    "Scoped files: src/AdminPage.aspx.cs and tests/AdminPageAuthorizationTests.cs. Current flow calls DeleteOrder without a server-side role check.");
  await approveAndHandover(root, mode, "repository-discovery", { receipt: phase.receipt });
  assert.equal((await ProjectStore.open(root).readWorkflowState()).phases["current-system-analysis"].status, "ready");

  for (const [id, body] of [
    ["current-system-analysis", "Authentication exists, but DeleteOrder has no server-side authorization boundary."],
    ["change-request-analysis", "Add an administrator role check before order deletion; an interface-only change is insufficient."],
    ["impact-analysis", "Delta is limited to AdminPage and its regression test; no rewrite or duplicate page is approved."],
    ["updated-requirements", "The server shall reject DeleteOrder unless the authenticated user has the Administrator role."],
    ["ux-architecture-delta", "The UI may hide the action, but the server-side role check remains authoritative."],
    ["implementation-planning", "Modify the existing code-behind and regression test after G6; do not create Fixed or V2 files."],
  ]) {
    phase = await reviewReadyPhase(root, mode, id, body);
    await approveAndHandover(root, mode, id, { receipt: phase.receipt });
  }

  const sourcePath = join(root, "src/AdminPage.aspx.cs");
  const testPath = join(root, "tests/AdminPageAuthorizationTests.cs");
  const source = await readFile(sourcePath, "utf8");
  const regression = await readFile(testPath, "utf8");
  await writeFile(sourcePath, source.replace(
    "    {\n        OrderService.Delete(orderId);",
    "    {\n        Authorization.RequireRole(\"Administrator\");\n        OrderService.Delete(orderId);",
  ));
  await writeFile(testPath, regression.replace(
    "    // Existing regression suite; the END2END scenario extends this file.",
    "    public void NonAdministratorIsRejected() => Assert.Throws<UnauthorizedAccessException>(() => page.DeleteOrder(42));",
  ));
  const codeReceipt = await recordCodeExecution(root, mode, "implementation", [
    "src/AdminPage.aspx.cs", "tests/AdminPageAuthorizationTests.cs",
  ]);
  assert.match(await readFile(sourcePath, "utf8"), /RequireRole\("Administrator"\)/);
  assert.match(await readFile(testPath, "utf8"), /NonAdministratorIsRejected/);
  const allFiles = (await Promise.all([readdir(join(root, "src")), readdir(join(root, "tests"))])).flat();
  assert.equal(allFiles.some((name) => /(?:Fixed|V2)/i.test(name)), false);

  phase = await reviewReadyPhase(root, mode, "implementation",
    `Existing files changed under approved G6 scope. Runtime receipt: ${codeReceipt.id}.`);
  await approveAndHandover(root, mode, "implementation", { receipt: phase.receipt });
  phase = await reviewReadyPhase(root, mode, "regression-security-testing",
    "Regression covers authorized and unauthorized deletion; no frontend-only authorization is accepted.");
  await approveAndHandover(root, mode, "regression-security-testing", { receipt: phase.receipt });
  const qa = await artifactReference(root, mode, "REGRESSION-SUMMARY");

  await startPhase(root, "security-review", "START-security-review-1", pluginAdapter);
  await writePhaseArtifact(root, mode, "security-review",
    "Server-side role enforcement verified; the negative authorization test passes and no blocker remains.");
  assert.equal((await validatePhase(root, "security-review", "VALIDATE-security-review-1")).valid, true);
  const secretPath = join(root, "tracked-secret.txt");
  await writeFile(secretPath, "api_key = 'not-a-real-secret-value'\n");
  await execFileAsync("git", ["add", "tracked-secret.txt"], { cwd: root });
  assert.equal((await secretsScan(root)).valid, false);
  const securityPending = await artifactReference(root, mode, "SECURITY-VERDICT", false);
  const securityEvidence = { gate_approvals: [], qa, security: securityPending };
  const blockedReceipt = await reviewerReceipt(root, mode, "security-review", securityEvidence, "secret");
  await assert.rejects(
    () => reviewPhase(root, "security-review", "architecture-reviewer", "approved",
      "REVIEW-security-with-secret", pluginAdapter, blockedReceipt.id),
    /SECRET_SCAN_FAILED/,
  );
  await execFileAsync("git", ["rm", "--quiet", "--cached", "tracked-secret.txt"], { cwd: root });
  await rm(secretPath);
  const securityReceipt = await reviewerReceipt(root, mode, "security-review", securityEvidence, "clean");
  await reviewPhase(root, "security-review", "architecture-reviewer", "approved",
    "REVIEW-security-clean", pluginAdapter, securityReceipt.id);
  const lateSecretPath = join(root, "late-secret.txt");
  await writeFile(lateSecretPath, "api_key = 'another-not-real-secret-value'\n");
  await execFileAsync("git", ["add", "late-secret.txt"], { cwd: root });
  await assert.rejects(
    () => approve(root, "G7", "project-owner", "APPROVE-security-late-secret", securityReceipt.id),
    /SECRET_SCAN_FAILED/,
  );
  await execFileAsync("git", ["rm", "--quiet", "--cached", "late-secret.txt"], { cwd: root });
  await rm(lateSecretPath);
  await approveAndHandover(root, mode, "security-review", { receipt: securityReceipt });
  const security = await artifactReference(root, mode, "SECURITY-VERDICT");

  await startPhase(root, "release", "START-release-1", pluginAdapter);
  await writePhaseArtifact(root, mode, "release",
    "Backup verified. Rollback restores the previous package and database snapshot.");
  assert.equal((await validatePhase(root, "release", "VALIDATE-release-1")).valid, true);
  const releasePending = await artifactReference(root, mode, "RELEASE-PLAN", false);
  const releaseReviewEvidence = {
    gate_approvals: [], qa, security, backup: releasePending, rollback: releasePending,
  };
  const releaseReceipt = await reviewerReceipt(root, mode, "release", releaseReviewEvidence);
  await reviewPhase(root, "release", "operations-reviewer", "approved",
    "REVIEW-release-1", pluginAdapter, releaseReceipt.id);
  const g8Id = operationKey("approve", "G8", "APPROVE-release-1");
  const releaseEvidence = {
    gate_approvals: [{ gate: "G8", approval_id: g8Id }], qa, security,
    backup: releasePending, rollback: releasePending,
  };
  const request = await recordProductionRequest(root, mode, "release", releaseEvidence);
  await approveAndHandover(root, mode, "release", { receipt: releaseReceipt, request });

  phase = await reviewReadyPhase(root, mode, "operational-validation",
    "Admin deletion journey, authorization denial, monitoring, and data integrity checks passed.");
  await approveAndHandover(root, mode, "operational-validation", { receipt: phase.receipt });
  const state = await ProjectStore.open(root).readWorkflowState();
  assert.equal(state.phases["operational-validation"].status, "approved");
  assert.equal((await readYaml(root, ".agent-team/approvals.yaml")).approvals.some(({ gate, approved_by }) =>
    gate === "G8" && approved_by.type === "human"), true);
});
