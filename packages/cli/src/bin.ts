#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import {
  AdapterIdSchema,
  CacheProviderSchema,
  GateIdSchema,
  ProjectModeSchema,
  ProjectProfileSchema,
  ReviewVerdictSchema,
} from "@system-design-team/core";
import {
  adoptProject,
  artifactInspect,
  artifactList,
  artifactValidate,
  approve,
  createChange,
  diagnostics,
  doctor,
  ejectProject,
  gateReadinessReport,
  getStatus,
  handover,
  initProject,
  inspectProject,
  issueList,
  rejectGate,
  repair,
  reviewPhase,
  planUpgrade,
  secretsScan,
  startPhase,
  staleList,
  traceCheck,
  traceCoverageReport,
  uninstallProject,
  validatePhase,
} from "./index.js";

const usage = `Usage: system-design-team <command> [options]

Commands:
  init --id <id> --name <name> --mode <mode> --profile <profile> [--language <language>] [--cache <none|sqlite>] [--adapter <codex>]
  adopt --id <id> --name <name> --profile <profile> --operation-id <id> [--language <language>] [--cache <none|sqlite>] [--adapter <codex>]
  inspect [--environment <name>]
  status
  start <phase> --operation-id <id>
  validate <phase> --operation-id <id>
  review <phase> --reviewer <id> --verdict <approved|revision_required> --operation-id <id> [--execution-receipt <id>]
  approve <gate> --by <id> --operation-id <id> [--execution-receipt <id>] [--execution-request <id>]
  reject <gate> --by <id> --operation-id <id>
  handover <phase> --operation-id <id>
  artifact list
  artifact inspect <id>
  artifact validate <id>
  trace check
  trace coverage
  stale list
  change create <id> --by <id> --artifacts <ids> --reason <text> --impact <low|medium|high> --operation-id <id>
  gate readiness <gate> [--execution-receipt <id>]
  issue list
  secrets scan
  diagnostics
  doctor
  repair --locks --yes
  upgrade --check
  upgrade --dry-run
  eject --operation-id <id>
  uninstall --operation-id <id>`;

const commandShape: Record<string, { positionals: number; options: string[] }> = {
  init: { positionals: 1, options: ["id", "name", "mode", "profile", "language", "cache", "adapter"] },
  adopt: { positionals: 1, options: ["id", "name", "profile", "language", "cache", "adapter", "operation-id"] },
  inspect: { positionals: 1, options: ["environment"] },
  status: { positionals: 1, options: [] },
  start: { positionals: 2, options: ["operation-id"] },
  validate: { positionals: 2, options: ["operation-id"] },
  review: { positionals: 2, options: ["reviewer", "verdict", "operation-id", "execution-receipt"] },
  approve: { positionals: 2, options: ["by", "operation-id", "execution-receipt", "execution-request"] },
  reject: { positionals: 2, options: ["by", "operation-id"] },
  handover: { positionals: 2, options: ["operation-id"] },
  "artifact list": { positionals: 2, options: [] },
  "artifact inspect": { positionals: 3, options: [] },
  "artifact validate": { positionals: 3, options: [] },
  "trace check": { positionals: 2, options: [] },
  "trace coverage": { positionals: 2, options: [] },
  "stale list": { positionals: 2, options: [] },
  "change create": { positionals: 3, options: ["by", "artifacts", "reason", "impact", "reapprovals", "operation-id"] },
  "gate readiness": { positionals: 3, options: ["execution-receipt"] },
  "issue list": { positionals: 2, options: [] },
  "secrets scan": { positionals: 2, options: [] },
  diagnostics: { positionals: 1, options: [] },
  doctor: { positionals: 1, options: [] },
  repair: { positionals: 1, options: ["locks", "yes"] },
  upgrade: { positionals: 1, options: ["check", "dry-run"] },
  eject: { positionals: 1, options: ["operation-id"] },
  uninstall: { positionals: 1, options: ["operation-id"] },
};

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} is required`);
  return value;
}

function validateInvocation(
  command: string,
  positionals: string[],
  values: Record<string, string | boolean | undefined>,
): void {
  const shape = commandShape[command];
  if (!shape) throw new Error(`Unknown command: ${command}`);
  if (positionals.length !== shape.positionals) {
    throw new Error(`Unexpected positional arguments for ${command}`);
  }
  for (const [option, value] of Object.entries(values)) {
    if (option === "help" || value === undefined || value === false) continue;
    if (!shape.options.includes(option)) throw new Error(`Option --${option} is not valid for ${command}`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      id: { type: "string" },
      name: { type: "string" },
      mode: { type: "string" },
      profile: { type: "string" },
      language: { type: "string" },
      cache: { type: "string" },
      adapter: { type: "string" },
      environment: { type: "string" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      by: { type: "string" },
      reviewer: { type: "string" },
      verdict: { type: "string" },
      "operation-id": { type: "string" },
      "execution-receipt": { type: "string" },
      "execution-request": { type: "string" },
      artifacts: { type: "string" },
      reason: { type: "string" },
      impact: { type: "string" },
      reapprovals: { type: "string" },
      locks: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const rootCommand = positionals[0];
  if (!rootCommand) {
    console.log(usage);
    return;
  }
  const command = ["artifact", "trace", "stale", "change", "gate", "issue", "secrets"].includes(rootCommand)
    ? `${rootCommand} ${positionals[1] ?? ""}`
    : rootCommand;
  validateInvocation(command, positionals, values);
  if (values.help) {
    console.log(usage);
    return;
  }

  const root = process.cwd();
  const receiptId = values["execution-receipt"];
  const cliAuthorization = {
    actor: { type: "system" as const, identifier: "system-design-team-cli" },
    authorizationSource: "cli_invocation",
  };
  let result: unknown;
  switch (command) {
    case "init":
      result = await initProject(root, {
        id: required(values.id, "--id"),
        name: required(values.name, "--name"),
        mode: ProjectModeSchema.parse(required(values.mode, "--mode").replace("-", "_")),
        profile: ProjectProfileSchema.parse(required(values.profile, "--profile")),
        language: values.language,
        adapter: values.adapter ? AdapterIdSchema.parse(values.adapter) : undefined,
        cache: CacheProviderSchema.parse(values.cache ?? "none"),
      });
      break;
    case "adopt":
      result = await adoptProject(root, {
        id: required(values.id, "--id"),
        name: required(values.name, "--name"),
        profile: ProjectProfileSchema.parse(required(values.profile, "--profile")),
        language: values.language,
        adapter: values.adapter ? AdapterIdSchema.parse(values.adapter) : undefined,
        cache: CacheProviderSchema.parse(values.cache ?? "none"),
      }, required(values["operation-id"], "--operation-id"), cliAuthorization);
      break;
    case "inspect":
      result = await inspectProject(root, { environment: values.environment });
      break;
    case "status":
      result = await getStatus(root);
      break;
    case "start":
      result = await startPhase(
        root,
        required(positionals[1], "phase"),
        required(values["operation-id"], "--operation-id"),
      );
      break;
    case "approve":
      result = await approve(
        root,
        GateIdSchema.parse(required(positionals[1], "gate")),
        required(values.by, "--by"),
        required(values["operation-id"], "--operation-id"),
        receiptId,
        values["execution-request"],
      );
      break;
    case "reject":
      result = await rejectGate(
        root,
        GateIdSchema.parse(required(positionals[1], "gate")),
        required(values.by, "--by"),
        required(values["operation-id"], "--operation-id"),
      );
      break;
    case "review":
      result = await reviewPhase(
        root,
        required(positionals[1], "phase"),
        required(values.reviewer, "--reviewer"),
        ReviewVerdictSchema.parse(required(values.verdict, "--verdict")),
        required(values["operation-id"], "--operation-id"),
        undefined,
        receiptId,
      );
      break;
    case "handover":
      result = await handover(
        root,
        required(positionals[1], "phase"),
        required(values["operation-id"], "--operation-id"),
      );
      break;
    case "artifact list":
      result = await artifactList(root);
      break;
    case "artifact inspect":
      result = await artifactInspect(root, required(positionals[2], "artifact id"));
      break;
    case "artifact validate":
      result = await artifactValidate(root, required(positionals[2], "artifact id"));
      break;
    case "trace check":
      result = await traceCheck(root);
      break;
    case "trace coverage":
      result = await traceCoverageReport(root);
      break;
    case "stale list":
      result = await staleList(root);
      break;
    case "change create": {
      const inputLevel = required(values.impact, "--impact");
      const level = (["low", "medium", "high"] as const).find((candidate) => candidate === inputLevel);
      if (!level) throw new Error("--impact must be low, medium, or high");
      result = await createChange(root, {
        id: required(positionals[2], "change id"),
        requested_by: required(values.by, "--by"),
        affected_artifacts: required(values.artifacts, "--artifacts").split(",").map((id) => id.trim()).filter(Boolean),
        reason: required(values.reason, "--reason"),
        impact: { scope: level, architecture: level, security: level, schedule: level },
        required_reapprovals: values.reapprovals
          ? values.reapprovals.split(",").map((gate) => GateIdSchema.parse(gate.trim()))
          : [],
      }, required(values["operation-id"], "--operation-id"));
      break;
    }
    case "gate readiness":
      result = await gateReadinessReport(
        root,
        GateIdSchema.parse(required(positionals[2], "gate")),
        receiptId,
      );
      break;
    case "issue list":
      result = await issueList(root);
      break;
    case "secrets scan":
      result = await secretsScan(root);
      break;
    case "diagnostics":
      result = await diagnostics(root);
      break;
    case "validate":
      result = await validatePhase(
        root,
        required(positionals[1], "phase"),
        required(values["operation-id"], "--operation-id"),
      );
      break;
    case "doctor":
      result = await doctor(root);
      break;
    case "repair":
      result = await repair(root, {
        locks: values.locks === true,
        confirmedQuiescent: values.yes === true,
      });
      break;
    case "upgrade":
      if (values.check === values["dry-run"]) throw new Error("Use exactly one of --check or --dry-run");
      result = await planUpgrade(root, values.check ? "check" : "dry-run");
      break;
    case "eject":
      result = await ejectProject(
        root,
        required(values["operation-id"], "--operation-id"),
        cliAuthorization,
      );
      break;
    case "uninstall":
      result = await uninstallProject(
        root,
        required(values["operation-id"], "--operation-id"),
        cliAuthorization,
      );
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  const outcome = result as { ok?: boolean; valid?: boolean };
  if ((command === "doctor" && outcome.ok === false)
    || ((command === "validate" || command === "artifact validate" || command === "trace check")
      && outcome.valid === false)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
