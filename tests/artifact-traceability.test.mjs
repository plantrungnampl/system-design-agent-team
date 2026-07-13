import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArtifact,
  validateReviewReadyArtifact,
} from "@system-design-team/artifact-validator";
import {
  propagateStaleness,
  traceCoverage,
  validateTraceability,
} from "@system-design-team/traceability";

test("parses only bounded leading front matter", () => {
  assert.deepEqual(parseArtifact("---\nartifact_id: SRS\n---\n# SRS"), {
    metadata: { artifact_id: "SRS" },
    body: "# SRS",
  });

  const prefaced = "preface\n---\nartifact_id: SRS\n---\n# SRS";
  assert.deepEqual(parseArtifact(prefaced), { metadata: {}, body: prefaced });

  const unclosed = "---\nartifact_id: SRS\n# SRS";
  assert.deepEqual(parseArtifact(unclosed), { metadata: {}, body: unclosed });
});

test("blocks prohibited placeholders in review-ready artifacts", () => {
  const result = validateReviewReadyArtifact("---\nartifact_id: SRS\nstatus: in_review\n---\n# SRS\nTODO: permissions");
  assert.equal(result.valid, false);
  assert.equal(result.findings[0].code, "PROHIBITED_PLACEHOLDER");
});

test("allows review-ready prose that discusses placeholders", () => {
  const result = validateReviewReadyArtifact(`---
status: approved
---
All sample requirements were removed before review.
No silent fallback behavior is permitted.
The TODO list is empty, and the value is not marked TBD.
The phrase to be defined later is prohibited.`);

  assert.deepEqual(result, { valid: true, findings: [] });
});

test("blocks standalone placeholder markers in review-ready artifacts", () => {
  const placeholders = [
    "TODO: permissions",
    "- TBD: retention",
    "to be defined later: recovery targets",
    "sample requirement",
    "- sample requirements",
    "placeholder architecture",
    "Lorem ipsum dolor sit amet",
  ];

  for (const placeholder of placeholders) {
    assert.equal(validateReviewReadyArtifact(`---\nstatus: approved\n---\n${placeholder}`).valid, false);
  }
});

test("blocks Markdown-prefixed standalone placeholder markers", () => {
  const placeholders = [
    "## TODO: permissions",
    "- [ ] TODO: permissions",
    "* [x] TBD: retention",
    "1. to be defined later: recovery targets",
    "2) sample requirement",
    "###### placeholder architecture",
  ];

  for (const placeholder of placeholders) {
    assert.equal(
      validateReviewReadyArtifact(`---\nstatus: approved\n---\n${placeholder}`).valid,
      false,
      placeholder,
    );
  }
});

test("allows explicit placeholders in drafts and returns stable parse diagnostics", () => {
  assert.deepEqual(validateReviewReadyArtifact("---\nstatus: draft\n---\nTODO: permissions"), {
    valid: true,
    findings: [],
  });
  assert.deepEqual(validateReviewReadyArtifact("---\nstatus: [invalid\n---\n# SRS"), {
    valid: false,
    findings: [{ code: "INVALID_FRONT_MATTER", message: "Artifact front matter is invalid YAML" }],
  });
});

test("rejects unsupported completion claims even with filler but accepts concrete evidence", () => {
  for (const claim of [
    "Everything passed.",
    "All security checks were successful.",
    "Everything passed.\nLooks good.",
    "All security checks were successful.\nEvidence:",
    "Everything passed.\nCommand: npm test",
    "All tests passed.\nExit code: 0",
    "Everything passed.\nArtifact:",
  ]) {
    const result = validateReviewReadyArtifact(`---\nstatus: approved\n---\n# Summary\n${claim}`);
    assert.equal(result.valid, false, claim);
    assert.equal(result.findings[0].code, "UNSUPPORTED_COMPLETION_CLAIM");
  }

  assert.deepEqual(validateReviewReadyArtifact(`---
status: approved
---
# Test summary
All tests passed.
Command: node --test tests/leave-request.test.mjs
Exit code: 0
Passed: 2, Failed: 0`), { valid: true, findings: [] });

  assert.deepEqual(validateReviewReadyArtifact(`---
status: approved
---
# Review summary
Everything passed.
Receipt: RECEIPT-REVIEW-123`), { valid: true, findings: [] });

  assert.deepEqual(validateReviewReadyArtifact(`---
status: approved
---
# Review summary
Everything passed.
Artifact: requirements/srs.md`), { valid: true, findings: [] });
});

test("reports an approved requirement without a current test", () => {
  const findings = validateTraceability(
    [{ id: "FR-AUTH-001", kind: "requirement", status: "approved" }],
    [],
  );
  assert(findings.some((finding) => finding.code === "REQUIREMENT_WITHOUT_TEST"));
});

test("reports deterministic requirement-to-test coverage without mutating inputs", () => {
  const nodes = [
    { id: "FR-002", kind: "requirement", status: "approved" },
    { id: "TEST-001", kind: "test", status: "approved" },
    { id: "FR-001", kind: "requirement", status: "approved" },
  ];
  const links = [{ from: "FR-002", to: "TEST-001", type: "verified_by" }];
  const snapshot = structuredClone({ nodes, links });

  assert.deepEqual(validateTraceability(nodes, links).map((finding) => finding.nodeId), ["FR-001"]);
  assert.deepEqual(traceCoverage(nodes, links), { total: 2, covered: 1, percentage: 50 });
  assert.deepEqual({ nodes, links }, snapshot);
  assert.deepEqual(traceCoverage([], []), { total: 0, covered: 0, percentage: 100 });
});

test("staleness follows hard dependencies but not reference-only links", () => {
  const stale = propagateStaleness(["SRS"], [
    { from: "SRS", to: "BACKLOG", type: "hard_dependency" },
    { from: "SRS", to: "README", type: "reference_only" },
  ]);
  assert.deepEqual([...stale], ["BACKLOG"]);
});

test("staleness follows hard dependencies transitively and direct derivations", () => {
  const links = [
    { from: "BACKLOG", to: "PLAN", type: "hard_dependency" },
    { from: "SRS", to: "GENERATED", type: "derived_from" },
    { from: "GENERATED", to: "UNRELATED", type: "hard_dependency" },
    { from: "SRS", to: "BACKLOG", type: "hard_dependency" },
    { from: "SRS", to: "README", type: "reference_only" },
  ];
  const snapshot = structuredClone(links);

  assert.deepEqual([...propagateStaleness(["SRS"], links)], ["BACKLOG", "GENERATED", "PLAN"]);
  assert.deepEqual(links, snapshot);
});

test("staleness does not propagate through soft dependencies", () => {
  assert.deepEqual([...propagateStaleness(["SRS"], [
    { from: "SRS", to: "BACKLOG", type: "soft_dependency" },
    { from: "BACKLOG", to: "PLAN", type: "hard_dependency" },
  ])], []);
});
