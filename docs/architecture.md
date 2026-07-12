# Architecture and sources of truth

This is the first V1 vertical slice, not the complete framework. The CLI coordinates small ESM TypeScript workspace packages:

- `core` owns shared Zod contracts.
- `project-store` owns contained, atomic filesystem writes, locks, and audit redaction.
- `workflow-engine` owns allowed phase and gate transitions.
- `artifact-validator` checks review-ready Markdown artifacts.
- `plugin-registry` checks required plugin capabilities.
- `codex-adapter` prepares bounded dispatches without fabricating runtime evidence.
- `cli` composes those public APIs for initialization and lifecycle operations.

## Authority boundaries

Git-backed YAML under `.agent-team/` is authoritative. `workflow-state.yaml` records lifecycle state, scoped operation IDs, and handover evidence digests; `artifact-registry.yaml`, `reviews.yaml`, `approvals.yaml`, and `handovers/*.yaml` bind evidence to exact artifact versions. Use the CLI or exported library functions for lifecycle changes instead of editing workflow state directly.

Generated lock files contain synced owner metadata and are fail-closed: an existing lock always blocks normal work. `doctor` identifies valid same-host locks whose owner PID is dead. `repair --locks --yes` removes only those locks after the operator confirms all framework processes are quiescent; repair is an administrative precondition, not a concurrency guarantee.

Repository assets under `workflows/`, `agents/`, and `templates/` define bootstrap inputs. Shared Zod schemas validate persisted domain data at read/write boundaries. `.agent-team/audit/events.jsonl` is a redacted operational log, not approval evidence.

Application source, an existing root `AGENTS.md`, and unrelated `.codex` content remain outside framework ownership. Initialization creates framework state without replacing them.

The packed CLI currently contains compiled CLI files and metadata only. Bootstrap assets still require the repository checkout; standalone installation is deferred beyond this slice.
