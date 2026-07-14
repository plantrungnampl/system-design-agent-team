import { createHash } from "node:crypto";
import {
  AgentManifestSchema,
  PluginInvocationRecordSchema,
  PluginInvocationResultSchema,
  PluginStatusRecordSchema,
  type AgentManifest,
  type PluginInvocationRecord,
  type PluginInvocationResult,
  type PluginStatusRecord,
} from "@system-design-team/core";

export interface CapabilityReport {
  allowed: boolean;
  blockers: { code: string; uri: string; skill?: string }[];
}

export interface PluginResolution {
  uri: string;
  publisher_identity: string;
  status: PluginStatusRecord["status"];
}

export interface PluginInvocationRequest {
  plugin_uri: string;
  skill?: string;
  input: unknown;
  operation_id: string;
  agent_id?: string;
  phase?: string;
}

export interface PluginAdapter {
  resolve(uri: string): Promise<PluginResolution>;
  verifySkill(uri: string, skill: string): Promise<boolean>;
  invoke(request: PluginInvocationRequest): Promise<PluginInvocationResult>;
}

export interface VerifiedPluginInvocation {
  evidence: PluginInvocationRecord;
  output: unknown;
}

const trustedPublishers = new Map([
  ["plugin://ux-design@wondelai-skills", "wondelai-skills"],
  ["plugin://code-craftsmanship@wondelai-skills", "wondelai-skills"],
  ["plugin://codex-security@openai-curated-remote", "openai-curated-remote"],
  ["plugin://systems-architecture@wondelai-skills", "wondelai-skills"],
  ["plugin://superpowers@openai-curated-remote", "openai-curated-remote"],
]);

export function pluginInvocationDigest(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("PLUGIN_INVOCATION_RESULT_INVALID");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function resolution(input: unknown): PluginResolution | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const status = PluginStatusRecordSchema.shape.status.safeParse(value.status);
  if (typeof value.uri !== "string"
    || typeof value.publisher_identity !== "string"
    || !status.success) return undefined;
  return { uri: value.uri, publisher_identity: value.publisher_identity, status: status.data };
}

export class PluginRegistry {
  readonly #records = new Map<string, PluginStatusRecord>();

  constructor(records: readonly PluginStatusRecord[]) {
    for (const input of records) {
      const record = PluginStatusRecordSchema.parse(input);
      if (this.#records.has(record.uri)) {
        throw new Error(`DUPLICATE_PLUGIN_STATUS: ${record.uri}`);
      }
      this.#records.set(record.uri, record);
    }
  }

  check(input: AgentManifest): CapabilityReport {
    const manifest = AgentManifestSchema.parse(input);
    const blockers: CapabilityReport["blockers"] = [];

    for (const requirement of manifest.required_plugins) {
      const strictBlockers: CapabilityReport["blockers"] = [];
      const record = this.#records.get(requirement.uri);
      if (!record || record.status === "unknown") {
        strictBlockers.push({ code: "REQUIRED_PLUGIN_UNKNOWN", uri: requirement.uri });
      } else if (record.status !== "available") {
        strictBlockers.push({
          code: `REQUIRED_PLUGIN_${record.status.toUpperCase()}`,
          uri: requirement.uri,
        });
      } else {
        for (const skill of requirement.required_skills) {
          if (!record.skills.includes(skill)) {
            strictBlockers.push({ code: "REQUIRED_SKILL_MISSING", uri: requirement.uri, skill });
          }
        }
      }

      if (strictBlockers.length === 0 || requirement.fallback_policy === "optional") continue;
      if (requirement.fallback_policy === "request_user_action") {
        blockers.push({ code: "USER_ACTION_REQUIRED", uri: requirement.uri });
      } else if (requirement.fallback_policy === "allow_with_approval") {
        blockers.push({ code: "FALLBACK_APPROVAL_REQUIRED", uri: requirement.uri });
      } else {
        blockers.push(...strictBlockers);
      }
    }

    return { allowed: blockers.length === 0, blockers };
  }

  async checkCurrent(input: AgentManifest, adapter: PluginAdapter): Promise<CapabilityReport> {
    const manifest = AgentManifestSchema.parse(input);
    const blockers: CapabilityReport["blockers"] = [];

    for (const requirement of manifest.required_plugins) {
      const strictBlockers: CapabilityReport["blockers"] = [];
      const expectedPublisher = trustedPublishers.get(requirement.uri);
      if (!expectedPublisher) {
        strictBlockers.push({ code: "UNTRUSTED_PLUGIN_URI", uri: requirement.uri });
      } else {
        let resolved: PluginResolution | undefined;
        try {
          resolved = resolution(await adapter.resolve(requirement.uri));
        } catch {
          resolved = undefined;
        }
        if (!resolved || resolved.uri !== requirement.uri) {
          strictBlockers.push({ code: "REQUIRED_PLUGIN_VERIFICATION_FAILED", uri: requirement.uri });
        } else if (resolved.publisher_identity !== expectedPublisher) {
          strictBlockers.push({ code: "PLUGIN_PUBLISHER_MISMATCH", uri: requirement.uri });
        } else if (resolved.status !== "available") {
          strictBlockers.push({
            code: `REQUIRED_PLUGIN_${resolved.status.toUpperCase()}`,
            uri: requirement.uri,
          });
        } else {
          for (const skill of requirement.required_skills) {
            let verified = false;
            try {
              verified = await adapter.verifySkill(requirement.uri, skill) === true;
            } catch {
              verified = false;
            }
            if (!verified) strictBlockers.push({ code: "REQUIRED_SKILL_MISSING", uri: requirement.uri, skill });
          }
        }
      }

      if (strictBlockers.length === 0 || requirement.fallback_policy === "optional") continue;
      if (requirement.fallback_policy === "request_user_action") {
        blockers.push({ code: "USER_ACTION_REQUIRED", uri: requirement.uri });
      } else if (requirement.fallback_policy === "allow_with_approval") {
        blockers.push({ code: "FALLBACK_APPROVAL_REQUIRED", uri: requirement.uri });
      } else {
        blockers.push(...strictBlockers);
      }
    }

    return { allowed: blockers.length === 0, blockers };
  }

  async invoke(
    adapter: PluginAdapter,
    request: PluginInvocationRequest,
  ): Promise<VerifiedPluginInvocation> {
    const expectedPublisher = trustedPublishers.get(request.plugin_uri);
    if (!expectedPublisher) throw new Error(`UNTRUSTED_PLUGIN_URI: ${request.plugin_uri}`);
    const capability = await this.checkCurrent({
      id: "plugin-invocation",
      version: "1",
      display_name: "Plugin invocation",
      category: "runtime",
      mission: "Invoke one verified plugin skill within its approved runtime scope.",
      authority: { may: ["invoke verified plugin"], may_not: ["approve output"] },
      outputs: ["verified invocation evidence"],
      reviewer: "runtime",
      required_plugins: [{
        uri: request.plugin_uri,
        required_skills: request.skill ? [request.skill] : [],
        fallback_policy: "block",
      }],
    }, adapter);
    const [blocker] = capability.blockers;
    if (blocker) throw new Error(`${blocker.code}: ${blocker.uri}${blocker.skill ? ` (${blocker.skill})` : ""}`);

    let raw: unknown;
    try {
      raw = await adapter.invoke(request);
    } catch {
      throw new Error("PLUGIN_INVOCATION_FAILED");
    }
    const parsed = PluginInvocationResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error("PLUGIN_INVOCATION_RESULT_INVALID");
    const result = parsed.data;
    if (result.plugin_uri !== request.plugin_uri) throw new Error("PLUGIN_INVOCATION_RESULT_INVALID");
    if (result.publisher_identity !== expectedPublisher) throw new Error("PLUGIN_PUBLISHER_MISMATCH");
    if (result.status !== "success") throw new Error("PLUGIN_INVOCATION_FAILED");

    return {
      evidence: PluginInvocationRecordSchema.parse({
        ...result,
        operation_id: request.operation_id,
        ...(request.agent_id ? { agent_id: request.agent_id } : {}),
        ...(request.phase ? { phase: request.phase } : {}),
        ...(request.skill ? { skill: request.skill } : {}),
        input_digest: pluginInvocationDigest(request.input),
        output_digest: pluginInvocationDigest(result.output),
      }),
      output: result.output,
    };
  }
}
