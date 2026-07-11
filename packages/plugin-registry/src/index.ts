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
      const record = this.#records.get(requirement.uri);
      if (!record || record.status === "unknown") {
        blockers.push({ code: "REQUIRED_PLUGIN_UNKNOWN", uri: requirement.uri });
        continue;
      }
      if (record.status !== "available") {
        blockers.push({
          code: `REQUIRED_PLUGIN_${record.status.toUpperCase()}`,
          uri: requirement.uri,
        });
        continue;
      }
      for (const skill of requirement.required_skills) {
        if (!record.skills.includes(skill)) {
          blockers.push({ code: "REQUIRED_SKILL_MISSING", uri: requirement.uri, skill });
        }
      }
    }

    return { allowed: blockers.length === 0, blockers };
  }
}
