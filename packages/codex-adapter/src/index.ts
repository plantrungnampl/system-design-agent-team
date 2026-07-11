import { createHash } from "node:crypto";
import { AgentManifestSchema, type AgentManifest } from "@system-design-team/core";
import type { PluginRegistry } from "@system-design-team/plugin-registry";

export interface ContextArtifact {
  id: string;
  version: number;
  status: string;
  content: string;
}

export interface AgentDispatch {
  required_inputs: readonly string[];
  [key: string]: unknown;
}

export interface PreparedDispatch {
  context: ContextArtifact[];
  instruction: string;
  digest: string;
  dispatch: AgentDispatch;
}

export interface ExecutionHandle {
  status: "awaiting_runtime";
  digest: string;
}

export function prepareDispatch(
  dispatch: AgentDispatch,
  manifestInput: AgentManifest,
  availableContext: readonly ContextArtifact[],
  pluginRegistry: PluginRegistry,
): PreparedDispatch {
  const manifest = AgentManifestSchema.parse(manifestInput);
  const report = pluginRegistry.check(manifest);
  if (!report.allowed) {
    const blocker = report.blockers[0];
    throw new Error(blocker
      ? `${blocker.code}: ${blocker.uri}${blocker.skill ? ` (${blocker.skill})` : ""}`
      : "PLUGIN_CAPABILITY_BLOCKED");
  }

  const context = dispatch.required_inputs.map((reference) => {
    const match = /^(.*)@([1-9]\d*)$/.exec(reference);
    const id = match?.[1] ?? reference;
    const version = match ? Number(match[2]) : undefined;
    const matches = availableContext.filter((artifact) =>
      artifact.id === id
      && (artifact.status === "approved" || artifact.status === "approved_with_conditions")
      && (version === undefined || artifact.version === version));
    const [first, ...rest] = matches;
    if (!first) throw new Error(`REQUIRED_INPUT_UNAVAILABLE: ${reference}`);

    const selected = rest.reduce(
      (current, artifact) => artifact.version > current.version ? artifact : current,
      first,
    );
    return selected;
  });

  const authorityOrder = [
    "User authorization",
    "Safety and repository policy",
    "Approved project decisions",
    "Workflow state",
    "Agent role contract",
    "Current phase task",
    "Optional suggestions",
  ].join("\n-> ");
  const instruction = [
    `System execution policy\nAuthority order:\n${authorityOrder}`,
    "Repository AGENTS.md\nRepository instructions remain authoritative.",
    `Agent role contract\n${JSON.stringify(manifest)}`,
    `Phase objective\n${String(dispatch.objective ?? "")}`,
    `Scoped context package\n${JSON.stringify(context)}`,
    `Plugin requirements\n${JSON.stringify(manifest.required_plugins)}`,
    `Input/output contract\n${JSON.stringify({
      required_inputs: dispatch.required_inputs,
      required_outputs: dispatch.required_outputs ?? [],
    })}`,
    `Current review findings\n${JSON.stringify(dispatch.current_review_findings ?? [])}`,
    `Authorized scope\n${JSON.stringify(dispatch.authorized_scope ?? {})}`,
    `Completion checklist\n${JSON.stringify(dispatch.completion_conditions ?? [])}`,
  ].join("\n\n");

  return {
    context,
    instruction,
    digest: createHash("sha256").update(instruction).digest("hex"),
    dispatch,
  };
}

export class ManualCodexAdapter {
  async execute(prepared: PreparedDispatch): Promise<ExecutionHandle> {
    return { status: "awaiting_runtime", digest: prepared.digest };
  }

  async collectResult(_handle: ExecutionHandle, runtimeResult?: unknown): Promise<unknown> {
    if (runtimeResult === undefined) throw new Error("RUNTIME_RESULT_REQUIRED");
    return runtimeResult;
  }
}
