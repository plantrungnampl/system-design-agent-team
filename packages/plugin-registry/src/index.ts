import {
  AgentManifestSchema,
  PluginStatusRecordSchema,
  type AgentManifest,
  type PluginStatusRecord,
} from "@system-design-team/core";

export interface CapabilityReport {
  allowed: boolean;
  blockers: { code: string; uri: string; skill?: string }[];
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
}
