import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as core from "@system-design-team/core";
import { parse } from "yaml";

const repository = process.cwd();

test("complete role catalogue defines approved boundaries and plugin mappings", async () => {
  const catalogue = core.AgentManifestSchema.array().parse(
    parse(await readFile(join(repository, "agents/catalogue.yaml"), "utf8")),
  );
  assert.deepEqual(catalogue.map(({ id }) => id), [
    "lead-orchestrator",
    "customer-proxy",
    "business-analyst",
    "requirements-reviewer",
    "product-owner",
    "project-manager",
    "ux-designer",
    "ux-reviewer",
    "system-analyst",
    "solution-architect",
    "architecture-reviewer",
    "developer-lead",
    "developer",
    "code-reviewer",
    "qa-lead",
    "tester",
    "devops-lead",
    "security-reviewer",
    "data-reviewer",
    "documentation-reviewer",
    "operations-reviewer",
  ]);
  assert(catalogue.every((agent) => agent.mission.length >= 20));
  assert(catalogue.every((agent) => agent.authority.may.length > 0));
  assert(catalogue.every((agent) => agent.authority.may_not.length > 0));
  assert(catalogue.every((agent) => agent.outputs.length > 0));
  assert(catalogue.every((agent) => agent.id !== agent.reviewer));

  const plugins = (id) => catalogue.find((agent) => agent.id === id)
    .required_plugins.map(({ uri }) => uri);
  assert.deepEqual(plugins("ux-designer"), ["plugin://ux-design@wondelai-skills"]);
  assert.deepEqual(plugins("solution-architect"), ["plugin://systems-architecture@wondelai-skills"]);
  assert.deepEqual(plugins("developer"), [
    "plugin://code-craftsmanship@wondelai-skills",
    "plugin://superpowers@openai-curated-remote",
  ]);
  assert.deepEqual(plugins("tester"), [
    "plugin://code-craftsmanship@wondelai-skills",
    "plugin://superpowers@openai-curated-remote",
  ]);
  assert.deepEqual(plugins("devops-lead"), [
    "plugin://systems-architecture@wondelai-skills",
    "plugin://superpowers@openai-curated-remote",
  ]);
  assert.deepEqual(plugins("security-reviewer"), [
    "plugin://codex-security@openai-curated-remote",
    "plugin://systems-architecture@wondelai-skills",
  ]);

  assert.throws(() => core.AgentManifestSchema.parse({
    ...catalogue[0],
    reviewer: catalogue[0].id,
  }), /reviewer/i);
});

test("END2END workflow assets use configured agents, ordered dependencies, and phase artifacts", async () => {
  const catalogue = core.AgentManifestSchema.array().parse(
    parse(await readFile(join(repository, "agents/catalogue.yaml"), "utf8")),
  );
  const agents = new Set(catalogue.map(({ id }) => id));
  const expected = new Map([
    ["greenfield.yaml", [
      "intake", "business-discovery", "requirements", "product", "ux", "system-analysis",
      "architecture", "implementation-planning", "implementation", "verification",
      "release-readiness", "deployment", "operational-validation", "post-release-review",
    ]],
    ["existing-system.yaml", [
      "repository-discovery", "current-system-analysis", "change-request-analysis",
      "impact-analysis", "updated-requirements", "ux-architecture-delta",
      "implementation-planning", "implementation", "regression-security-testing", "security-review",
      "release", "operational-validation",
    ]],
    ["migration.yaml", [
      "legacy-assessment", "business-continuity", "target-state", "data-mapping",
      "transition-architecture", "migration-waves", "parallel-validation",
      "cutover-readiness", "cutover", "post-migration-reconciliation", "legacy-decommission",
    ]],
  ]);

  for (const [file, phases] of expected) {
    const workflow = core.WorkflowDefinitionSchema.parse(
      parse(await readFile(join(repository, "workflows", file), "utf8")),
    );
    assert.deepEqual(workflow.phases.map(({ id }) => id), phases);
    const positions = new Map(workflow.phases.map(({ id }, index) => [id, index]));
    for (const [index, phase] of workflow.phases.entries()) {
      assert(agents.has(phase.owner), `${file}:${phase.id} owner is configured`);
      assert(agents.has(phase.reviewer), `${file}:${phase.id} reviewer is configured`);
      assert.notEqual(phase.owner, phase.reviewer);
      assert.deepEqual(
        phase.required_plugins,
        catalogue.find(({ id }) => id === phase.owner).required_plugins.map(({ uri }) => uri),
        `${file}:${phase.id} plugin contract matches its owner`,
      );
      assert.equal(phase.artifact.path.startsWith("../"), false);
      assert.match(phase.artifact.id, /^[A-Z][A-Z0-9-]+$/);
      assert(phase.depends_on.every((dependency) => positions.get(dependency) < index));
    }
    if (file === "existing-system.yaml") {
      assert.equal(workflow.phases.find(({ id }) => id === "security-review").owner, "security-reviewer");
    }
    if (file === "migration.yaml") {
      assert.equal(workflow.phases.find(({ id }) => id === "data-mapping").reviewer, "data-reviewer");
      assert.equal(
        workflow.phases.find(({ id }) => id === "post-migration-reconciliation").reviewer,
        "data-reviewer",
      );
    }
  }
});

test("parses a valid workflow and rejects self-reviewing phase definitions", () => {
  const valid = core.WorkflowDefinitionSchema.parse({
    id: "greenfield-standard",
    version: "1.0.0",
    mode: "greenfield",
    phases: [{
      id: "requirements",
      owner: "business-analyst",
      reviewer: "requirements-reviewer",
      gate: "G2",
      depends_on: [],
      artifact: { id: "REQUIREMENTS", path: "requirements/requirements.md", title: "Requirements" },
    }],
  });
  assert.equal(valid.phases[0].gate, "G2");

  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{ ...valid.phases[0], reviewer: "business-analyst" }],
  }), /reviewer/i);
  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{ ...valid.phases[0], id: "../outside" }],
  }), /phase id/i);

  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [valid.phases[0], { ...valid.phases[0] }],
  }), /unique/i);
  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{ ...valid.phases[0], depends_on: ["missing"] }],
  }), /dependency/i);
  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{ ...valid.phases[0], depends_on: ["requirements"] }],
  }), /dependency/i);
  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{
      ...valid.phases[0],
      artifact: { ...valid.phases[0].artifact, path: "../outside.md" },
    }],
  }), /artifact path/i);
  assert.throws(() => core.WorkflowDefinitionSchema.parse({
    ...valid,
    phases: [{
      ...valid.phases[0],
      artifact: { ...valid.phases[0].artifact, path: "nested/../../outside.md" },
    }],
  }), /artifact path/i);
  assert.throws(() => core.AgentManifestSchema.parse({
    id: "../outside",
    version: "1.0.0",
    reviewer: "independent-reviewer",
    required_plugins: [],
  }), /agent id/i);
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
      checksum: `sha256:${"a".repeat(64)}`,
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
        handover_digest: "a".repeat(64),
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
  assert.equal(state.phases.requirements.handover_digest, "a".repeat(64));
  assert.throws(() => core.ReviewRecordSchema.parse({
    ...reviews.reviews[0],
    verdict: "looks_good",
  }));
  assert.throws(() => core.ArtifactRegistrySchema.parse({
    artifacts: [{ ...registry.artifacts[0], version: 0 }],
  }));
});

test("artifact, traceability, and change contracts preserve dependency metadata", () => {
  const dependency = core.ArtifactDependencySchema.parse({
    artifact_id: "PROJECT-CHARTER",
    version: 1,
    type: "hard_dependency",
  });
  const traceability = core.TraceabilityDocumentSchema.parse({
    nodes: [{ id: "PROJECT-CHARTER", kind: "artifact", status: "approved" }],
    links: [{ from: "PROJECT-CHARTER", to: "REQUIREMENTS", type: "hard_dependency" }],
  });
  const change = core.ChangeRequestSchema.parse({
    id: "CR-001",
    requested_by: "product-owner",
    affected_artifacts: ["PROJECT-CHARTER"],
    reason: "Approved scope changed.",
    impact: { scope: "high", architecture: "medium", security: "low", schedule: "high" },
    required_reapprovals: ["G0"],
  });
  const artifact = core.ArtifactRecordSchema.parse({
    id: "REQUIREMENTS",
    path: "requirements/requirements.md",
    type: "requirements",
    version: 1,
    status: "approved",
    owner: "business-analyst",
    reviewer: "requirements-reviewer",
    dependencies: [dependency],
    consumers: ["PRODUCT-BACKLOG"],
    required_gate: "G2",
    checksum: `sha256:${"a".repeat(64)}`,
  });

  assert.equal(artifact.dependencies[0].type, "hard_dependency");
  assert.deepEqual(artifact.consumers, ["PRODUCT-BACKLOG"]);
  assert.equal(traceability.links[0].to, "REQUIREMENTS");
  assert.equal(change.required_reapprovals[0], "G0");
  assert.throws(() => core.ArtifactRecordSchema.parse({ ...artifact, checksum: "sha256:bad" }));
});
