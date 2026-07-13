#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import {
  GateIdSchema,
  ProjectModeSchema,
  ProjectProfileSchema,
  ReviewVerdictSchema,
} from "@system-design-team/core";
import {
  artifactInspect,
  artifactList,
  artifactValidate,
  approve,
  createChange,
  diagnostics,
  doctor,
  gateReadinessReport,
  getStatus,
  handover,
  initProject,
  issueList,
  rejectGate,
  repair,
  reviewPhase,
  secretsScan,
  startPhase,
  staleList,
  traceCheck,
  traceCoverageReport,
  validatePhase,
} from "./index.js";

const usage = `Usage: system-design-team <command> [options]

Commands:
  init --id <id> --name <name> --mode <mode> --profile <profile>
  status
  start <phase> --operation-id <id>
  validate <phase> --operation-id <id>
  review <phase> --reviewer <id> --verdict <approved|revision_required> --operation-id <id>
  approve <gate> --by <id> --operation-id <id>
  reject <gate> --by <id> --operation-id <id>
  handover <phase> --operation-id <id>
  artifact list
  artifact inspect <id>
  artifact validate <id>
  trace check
  trace coverage
  stale list
  change create <id> --by <id> --artifacts <ids> --reason <text> --impact <low|medium|high> --operation-id <id>
  gate readiness <gate>
  issue list
  secrets scan
  diagnostics
  doctor
  repair --locks --yes`;

const commandShape: Record<string, { positionals: number; options: string[] }> = {
  init: { positionals: 1, options: ["id", "name", "mode", "profile"] },
  status: { positionals: 1, options: [] },
  start: { positionals: 2, options: ["operation-id"] },
  validate: { positionals: 2, options: ["operation-id"] },
  review: { positionals: 2, options: ["reviewer", "verdict", "operation-id"] },
  approve: { positionals: 2, options: ["by", "operation-id"] },
  reject: { positionals: 2, options: ["by", "operation-id"] },
  handover: { positionals: 2, options: ["operation-id"] },
  "artifact list": { positionals: 2, options: [] },
  "artifact inspect": { positionals: 3, options: [] },
  "artifact validate": { positionals: 3, options: [] },
  "trace check": { positionals: 2, options: [] },
  "trace coverage": { positionals: 2, options: [] },
  "stale list": { positionals: 2, options: [] },
  "change create": { positionals: 3, options: ["by", "artifacts", "reason", "impact", "reapprovals", "operation-id"] },
  "gate readiness": { positionals: 3, options: [] },
  "issue list": { positionals: 2, options: [] },
  "secrets scan": { positionals: 2, options: [] },
  diagnostics: { positionals: 1, options: [] },
  doctor: { positionals: 1, options: [] },
  repair: { positionals: 1, options: ["locks", "yes"] },
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
      by: { type: "string" },
      reviewer: { type: "string" },
      verdict: { type: "string" },
      "operation-id": { type: "string" },
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
  let result: unknown;
  switch (command) {
    case "init":
      result = await initProject(root, {
        id: required(values.id, "--id"),
        name: required(values.name, "--name"),
        mode: ProjectModeSchema.parse(required(values.mode, "--mode").replace("-", "_")),
        profile: ProjectProfileSchema.parse(required(values.profile, "--profile")),
      });
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
      result = await gateReadinessReport(root, GateIdSchema.parse(required(positionals[2], "gate")));
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
