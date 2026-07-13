# Architecture and sources of truth

V1 separates durable domain state from runtime adapters:

- `core` owns shared Zod contracts and stable identifiers.
- `project-store` owns contained atomic writes, locks, recovery, and redacted audit events.
- `workflow-engine` owns phase transitions and G0-G9 gate policy.
- `artifact-validator` and `traceability` validate artifacts, links, freshness, and coverage.
- `plugin-registry` verifies trusted plugin identity, skills, and digest-only invocation records.
- `codex-adapter` prepares scoped requests and validates execution receipts.
- `sqlite-cache` builds a disposable real SQLite index from authoritative files.
- `cli` composes the public operations and bundles workflows, agent definitions, and templates.

## Authority boundaries

Git-backed YAML and Markdown under `.agent-team/` are authoritative. `workflow-state.yaml`, `artifact-registry.yaml`, `traceability.yaml`, `reviews.yaml`, `approvals.yaml`, execution records, and handovers bind decisions to exact versions and evidence. `.agent-team/audit/events.jsonl` is an append-only operational summary, not approval or plugin proof.

The optional `.agent-team/cache/index.db` is derived data. Its schema and source commit are checked; corruption or staleness disables cache-backed diagnostics without blocking core file-backed workflow operations. Rebuilding it never changes authoritative project content.

Bootstrap assets under `workflows/`, `agents/`, and `templates/` are copied into the packed CLI. Initialization creates `.codex/agents/` instructions without overwriting application source, an existing root `AGENTS.md`, or unrelated `.codex` files.

## Execution boundary

The adapter distinguishes prepared requests, runtime receipts, plugin availability, and completed invocation evidence. Availability does not prove a plugin invocation. The framework stores only identity, status, timestamps, references, and digests—not private reasoning or plugin internals.

Production-impacting work requires exact authorization and current gate evidence. V1 prepares and verifies those contracts; it does not deploy to production and has no automatic cloud, GitHub, CI, or production connector.

See [Operations](operations.md) for lifecycle behavior and [Security](security.md) for trust boundaries.
