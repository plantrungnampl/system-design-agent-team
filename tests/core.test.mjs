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
