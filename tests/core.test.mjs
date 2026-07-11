import assert from "node:assert/strict";
import test from "node:test";
import * as core from "@system-design-team/core";

test("parses a valid workflow and rejects self-reviewing phase definitions", () => {
  const valid = core.WorkflowDefinitionSchema.parse({
    id: "greenfield-standard",
    version: "1.0.0",
    mode: "greenfield",
    phases: [{ id: "requirements", owner: "business-analyst", reviewer: "requirements-reviewer", gate: "G2", depends_on: [] }],
  });
  assert.equal(valid.phases[0].gate, "G2");

  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{ ...valid.phases[0], reviewer: "business-analyst" }],
  }), /reviewer/i);
});

test("validates persisted CLI wrapper records", () => {
  const project = core.ProjectConfigSchema.parse({
    schema_version: 1,
    project: {
      id: "leave-system",
      name: "Leave System",
      mode: "greenfield",
      profile: "standard",
    },
    framework: { version: "0.1.0" },
    workflow: { id: "greenfield-standard", version: "1.0.0" },
  });
  const plugins = core.PluginStatusListSchema.parse({
    plugins: [{ uri: "plugin://superpowers@openai-curated-remote", status: "unknown", skills: [] }],
  });
  const approvals = core.ApprovalListSchema.parse({ approvals: [] });
  const registry = core.ArtifactRegistrySchema.parse({
    artifacts: [{
      id: "PROJECT-CHARTER",
      path: "context/project-charter.md",
      version: 1,
      status: "draft",
      owner: "lead-orchestrator",
      reviewer: "documentation-reviewer",
      required_gate: "G0",
    }],
  });
  const lock = core.FrameworkLockSchema.parse({
    framework: { version: "0.1.0" },
    workflow: { id: "greenfield-standard", version: "1.0.0" },
  });

  assert.equal(project.project.mode, "greenfield");
  assert.equal(plugins.plugins[0].status, "unknown");
  assert.deepEqual(approvals.approvals, []);
  assert.equal(registry.artifacts[0].version, 1);
  assert.equal(lock.framework.version, "0.1.0");
  assert.throws(() => core.ArtifactRegistrySchema.parse({
    artifacts: [{ ...registry.artifacts[0], version: 0 }],
  }));
});
