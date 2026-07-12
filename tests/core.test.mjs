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
  const handover = core.HandoverRecordSchema.parse({
    id: '["handover","requirements","OP-1"]',
    phase: "requirements",
    from_agent: "business-analyst",
    to_agent: "product-owner",
    approved_inputs: ["REQUIREMENTS@1"],
    expected_outputs: [],
    acceptance_conditions: ["Use approved inputs."],
  });
  const reviews = core.ReviewListSchema.parse({
    reviews: [{
      id: '["review","requirements","OP-1"]',
      phase: "requirements",
      reviewer: "requirements-reviewer",
      verdict: "approved",
      artifact_versions: { REQUIREMENTS: 1 },
      timestamp: "2026-07-11T00:00:00Z",
    }],
  });
  const state = core.WorkflowStateSchema.parse({
    schema_version: 1,
    state_version: 1,
    project_id: "leave-system",
    current_phase: "requirements",
    phases: {
      requirements: {
        status: "awaiting_approval",
        review_id: reviews.reviews[0].id,
      },
    },
    completed_operations: [],
  });

  assert.equal(project.project.mode, "greenfield");
  assert.equal(plugins.plugins[0].status, "unknown");
  assert.deepEqual(approvals.approvals, []);
  assert.equal(registry.artifacts[0].version, 1);
  assert.equal(lock.framework.version, "0.1.0");
  assert.equal(handover.id, '["handover","requirements","OP-1"]');
  assert.equal(handover.phase, "requirements");
  assert.equal(reviews.reviews[0].verdict, "approved");
  assert.equal(state.phases.requirements.review_id, reviews.reviews[0].id);
  assert.throws(() => core.ReviewRecordSchema.parse({
    ...reviews.reviews[0],
    verdict: "looks_good",
  }));
  assert.throws(() => core.ArtifactRegistrySchema.parse({
    artifacts: [{ ...registry.artifacts[0], version: 0 }],
  }));
});
