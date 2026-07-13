import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  approve,
  handover,
  initProject,
  reviewPhase,
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
  recordProductionRequest,
  reviewerReceipt,
  reviewReadyPhase,
  temporaryRepository,
  writePhaseArtifact,
} from "./fixtures/e2e-harness.mjs";

const mode = "migration";
const fixture = join(import.meta.dirname, "fixtures/migration");

test("migration blocks unsafe cutover, validates data, and separately approves decommission", async (t) => {
  const root = await temporaryRepository(t, "system-design-team-migration-e2e-", fixture);
  const options = {
    id: "oracle-to-postgres-orders",
    name: "Oracle Orders to PostgreSQL",
    mode,
    profile: "standard",
  };
  await assert.rejects(() => initProject(root, options, "INIT-MIGRATION-CRASH", undefined, {
    transactionFault(point) { if (point === "before_audit_append") throw new Error("SIMULATED_CRASH"); },
  }), /SIMULATED_CRASH/);
  await assert.rejects(() => access(join(root, ".agent-team/project.yaml")));
  await initProject(root, options, "INIT-MIGRATION-E2E");

  assert.match(await readFile(join(root, "legacy-orders.csv"), "utf8"), /1001,C-001,12500/);
  assert.match(await readFile(join(root, "mapping.yaml"), "utf8"), /orders\.id/);
  let phase;
  for (const [id, body] of [
    ["legacy-assessment", "Inventory: Oracle ORDERS source, PostgreSQL orders target, two fixture rows, and no omitted dependencies."],
    ["business-continuity", "Downtime budget: 30 minutes. Data-loss tolerance: zero rows. Coexistence and rollback owners are assigned."],
    ["target-state", "Target PostgreSQL schema uses bigint identifiers, required customer IDs, managed backup, and audited cutover."],
    ["data-mapping", "ORDER_ID maps to orders.id; CUSTOMER_ID is trimmed; uniqueness and row-count reconciliation are mandatory."],
    ["transition-architecture", "Transition uses a repeatable export, staging validation, idempotent load, and reversible traffic switch."],
    ["migration-waves", "Wave 1 dry-runs both fixture rows; Wave 2 cuts over only after reconciliation and rollback rehearsal."],
  ]) {
    phase = await reviewReadyPhase(root, mode, id, body);
    await approveAndHandover(root, mode, id, { receipt: phase.receipt });
  }

  phase = await reviewReadyPhase(root, mode, "parallel-validation",
    "Dry run loaded 2 of 2 rows. Source and target totals reconcile; negative transformation cases are retained.");
  await approveAndHandover(root, mode, "parallel-validation", { receipt: phase.receipt });
  const qa = await artifactReference(root, mode, "PARALLEL-VALIDATION");
  const data = await artifactReference(root, mode, "DATA-MAPPING");
  const dataLoss = await artifactReference(root, mode, "BUSINESS-CONTINUITY");

  await startPhase(root, "cutover-readiness", "START-cutover-readiness-1", pluginAdapter);
  await writePhaseArtifact(root, mode, "cutover-readiness",
    "Reconciliation is exact; dry run passed; cutover owner, downtime window, backup, rollback trigger, and restore command are recorded.");
  assert.equal((await validatePhase(root, "cutover-readiness", "VALIDATE-cutover-readiness-1")).valid, true);
  const dryRun = await artifactReference(root, mode, "PARALLEL-VALIDATION");
  const readinessEvidence = { gate_approvals: [], qa, data, dry_run: dryRun };
  const readinessReceipt = await reviewerReceipt(root, mode, "cutover-readiness", readinessEvidence);
  await reviewPhase(root, "cutover-readiness", "operations-reviewer", "approved",
    "REVIEW-cutover-readiness-1", pluginAdapter, readinessReceipt.id);
  await approveAndHandover(root, mode, "cutover-readiness", { receipt: readinessReceipt });

  await startPhase(root, "cutover", "START-cutover-1", pluginAdapter);
  await writePhaseArtifact(root, mode, "cutover",
    "Verified backup precedes the load. Rollback restores Oracle routing if row counts or totals differ. Zero data loss is required.");
  assert.equal((await validatePhase(root, "cutover", "VALIDATE-cutover-1")).valid, true);
  const cutoverPending = await artifactReference(root, mode, "CUTOVER-PLAN", false);
  const reviewEvidence = {
    gate_approvals: [], qa, data, dry_run: dryRun,
    backup: cutoverPending, rollback: cutoverPending,
  };
  const cutoverReceipt = await reviewerReceipt(root, mode, "cutover", reviewEvidence);
  await reviewPhase(root, "cutover", "operations-reviewer", "approved",
    "REVIEW-cutover-1", pluginAdapter, cutoverReceipt.id);

  const unsafeApprovalId = operationKey("approve", "G8", "APPROVE-cutover-no-rollback");
  const humanReferences = {
    gate_approvals: [{ gate: "G8", approval_id: unsafeApprovalId }],
    destructive_confirmation: { gate: "G8", approval_id: unsafeApprovalId },
    scope_confirmation: { gate: "G8", approval_id: unsafeApprovalId },
  };
  const noRollbackRequest = await recordProductionRequest(root, mode, "cutover", {
    ...humanReferences, qa, data, dry_run: dryRun, backup: cutoverPending,
  }, { destructive: true, executionId: "EXEC-CUTOVER-NO-ROLLBACK", operationId: "REQUEST-CUTOVER-NO-ROLLBACK" });
  await assert.rejects(
    () => approve(root, "G8", "project-owner", "APPROVE-cutover-no-rollback", cutoverReceipt.id, noRollbackRequest.id),
    /ROLLBACK_PLAN_REQUIRED/,
  );

  const noDataLossApprovalId = operationKey("approve", "G8", "APPROVE-cutover-no-data-loss");
  const noDataLossRequest = await recordProductionRequest(root, mode, "cutover", {
    gate_approvals: [{ gate: "G8", approval_id: noDataLossApprovalId }],
    destructive_confirmation: { gate: "G8", approval_id: noDataLossApprovalId },
    scope_confirmation: { gate: "G8", approval_id: noDataLossApprovalId },
    qa, data, dry_run: dryRun, backup: cutoverPending, rollback: cutoverPending,
  }, { destructive: true, executionId: "EXEC-CUTOVER-NO-DATA-LOSS", operationId: "REQUEST-CUTOVER-NO-DATA-LOSS" });
  await assert.rejects(
    () => approve(root, "G8", "project-owner", "APPROVE-cutover-no-data-loss", cutoverReceipt.id, noDataLossRequest.id),
    /DATA_LOSS_POLICY_CONFIRMATION_REQUIRED/,
  );

  const validApprovalId = operationKey("approve", "G8", "APPROVE-cutover-valid");
  const validEvidence = {
    gate_approvals: [{ gate: "G8", approval_id: validApprovalId }],
    destructive_confirmation: { gate: "G8", approval_id: validApprovalId },
    scope_confirmation: { gate: "G8", approval_id: validApprovalId },
    qa, data, data_loss: dataLoss, dry_run: dryRun, backup: cutoverPending, rollback: cutoverPending,
  };
  const validRequest = await recordProductionRequest(root, mode, "cutover", validEvidence, {
    destructive: true, executionId: "EXEC-CUTOVER-VALID", operationId: "REQUEST-CUTOVER-VALID",
  });
  await approveAndHandover(root, mode, "cutover", {
    receipt: cutoverReceipt, request: validRequest, suffix: "valid",
  });

  phase = await reviewReadyPhase(root, mode, "post-migration-reconciliation",
    "Post-cutover source and target row counts, keys, and total cents reconcile exactly; monitoring is healthy.");
  await approveAndHandover(root, mode, "post-migration-reconciliation", { receipt: phase.receipt });
  phase = await reviewReadyPhase(root, mode, "legacy-decommission",
    "A separate business decision authorizes decommission only after reconciliation and archive retention verification.");
  await approveAndHandover(root, mode, "legacy-decommission", { receipt: phase.receipt });

  const state = await ProjectStore.open(root).readWorkflowState();
  assert.equal(state.phases["legacy-decommission"].status, "approved");
  const approvals = (await readYaml(root, ".agent-team/approvals.yaml")).approvals;
  assert.equal(approvals.filter(({ gate }) => gate === "G9").length, 2);
  assert.notEqual(state.phases["post-migration-reconciliation"].approval_id,
    state.phases["legacy-decommission"].approval_id);
});
