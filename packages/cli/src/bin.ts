#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import { GateIdSchema, ProjectModeSchema, ProjectProfileSchema } from "@system-design-team/core";
import {
  approve,
  doctor,
  getStatus,
  handover,
  initProject,
  startPhase,
  validatePhase,
} from "./index.js";

const usage = `Usage: system-design-team <command> [options]

Commands:
  init       Initialize project state
  status     Show project state
  start      Start a phase
  approve    Approve a gate
  handover   Hand over an approved phase
  validate   Validate phase artifacts
  doctor     Check project prerequisites`;

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} is required`);
  return value;
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
      "operation-id": { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
