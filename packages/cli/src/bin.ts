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
  approve,
  doctor,
  getStatus,
  handover,
  initProject,
  reviewPhase,
  startPhase,
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
  handover <phase> --operation-id <id>
  doctor`;

const commandShape: Record<string, { positionals: number; options: string[] }> = {
  init: { positionals: 1, options: ["id", "name", "mode", "profile"] },
  status: { positionals: 1, options: [] },
  start: { positionals: 2, options: ["operation-id"] },
  validate: { positionals: 2, options: ["operation-id"] },
  review: { positionals: 2, options: ["reviewer", "verdict", "operation-id"] },
  approve: { positionals: 2, options: ["by", "operation-id"] },
  handover: { positionals: 2, options: ["operation-id"] },
  doctor: { positionals: 1, options: [] },
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
    },
  });
  const command = positionals[0];
  if (!command) {
    console.log(usage);
    return;
  }
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
    default:
      throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  const outcome = result as { ok?: boolean; valid?: boolean };
  if ((command === "doctor" && outcome.ok === false)
    || (command === "validate" && outcome.valid === false)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
