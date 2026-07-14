# System Design Agent Team

[![CI](https://github.com/plantrungnampl/system-design-agent-team/actions/workflows/ci.yml/badge.svg)](https://github.com/plantrungnampl/system-design-agent-team/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

A local, Codex-first framework that coordinates an END2END system-design team with approval gates, traceability, and verified execution evidence. V1 is a Git-backed CLI framework; it does not autonomously deploy production or provide the planned hosted V2/V3 runtime.

## Why this exists

Complex software work often loses context between business analysis, UX, architecture, implementation, QA, and release. This framework turns those handoffs into an auditable workflow: every phase has an owner, an independent reviewer, required artifacts, explicit evidence, and a gate that cannot be skipped by assertion.

## What V1 provides

- Greenfield, existing-system, and migration workflows.
- G0-G9 approval gates with author/reviewer separation.
- Git-backed project memory, decisions, reviews, handovers, and audit events.
- Artifact validation, traceability coverage, and stale-dependency detection.
- Scoped Codex dispatch requests and validated execution receipts.
- Strict plugin identity, capability, and invocation-evidence contracts.
- Atomic state updates, idempotent operations, recovery, and an optional rebuildable SQLite index.

## Architecture

```text
Command-line interface
    |
    +-- workflow engine -------- phases, reviews, gates
    +-- artifact validation ---- schemas, freshness, traceability
    +-- Codex adapter ----------- scoped requests and receipts
    +-- plugin registry --------- identity, skills, invocation evidence
    +-- project store ----------- atomic Git-backed YAML/Markdown
    `-- SQLite cache ------------ disposable query index
```

Git-backed Markdown and YAML under `.agent-team/` are authoritative. Generated adapter files and `.agent-team/cache/index.db` can be rebuilt.

## Quick start

Requires Node.js 20 or newer and Git.

```bash
npm ci
npm run check
node packages/cli/dist/bin.js --help
```

After installing the packed or published workspaces, initialize a project from its repository root:

```bash
system-design-team init --id leave-system --name "Leave System" --mode greenfield --profile standard --operation-id INIT-001
system-design-team status
system-design-team doctor
```

A plugin-bound phase requires a host-provided adapter module:

```bash
system-design-team start intake --operation-id INTAKE-START-001 --plugin-adapter ./codex-plugin-adapter.mjs
system-design-team validate intake --operation-id INTAKE-VALIDATE-001
system-design-team review intake --reviewer documentation-reviewer --verdict approved --operation-id INTAKE-REVIEW-001 --plugin-adapter ./codex-plugin-adapter.mjs
system-design-team approve G0 --by project-owner --operation-id INTAKE-APPROVE-001
system-design-team handover intake --operation-id INTAKE-HANDOVER-001
```

The adapter must default-export the `resolve`, `verifySkill`, and `invoke` methods defined by `@system-design-team/plugin-registry`.

## Workflow and approval gates

Each phase follows `start -> validate -> independent review -> approval -> handover`. The standard gates are:

| Gate | Decision |
| --- | --- |
| G0-G2 | Intake, business scope, and requirements |
| G3-G4 | Product backlog and UX |
| G5-G6 | Architecture/stack and implementation plan |
| G7-G8 | Release candidate and production authorization |
| G9 | Post-release acceptance |

Human approval remains mandatory for consequential decisions such as scope, requirements, technology stack, destructive migration, and production deployment.

## Project modes

| Mode | Starting point |
| --- | --- |
| `greenfield` | New business problem and product discovery |
| `existing_system` | Repository assessment before scoped change design |
| `migration` | Legacy inventory, transition design, reconciliation, and cutover |

Profiles are `small`, `standard`, `enterprise`, and `regulated`.

## Plugin contracts

The agent catalogue declares these trusted plugin identities:

| Plugin | Primary roles |
| --- | --- |
| `plugin://superpowers@openai-curated-remote` | Orchestration, discovery, planning, verification |
| `plugin://ux-design@wondelai-skills` | UX design and review |
| `plugin://systems-architecture@wondelai-skills` | System, architecture, data, and operations design |
| `plugin://code-craftsmanship@wondelai-skills` | Development, code review, and QA |
| `plugin://codex-security@openai-curated-remote` | Security review |

Availability is diagnostic only. A successful adapter-issued invocation record is required as execution evidence; the framework never fabricates it.

## Workspace packages

| Package | Responsibility |
| --- | --- |
| `@system-design-team/core` | Shared Zod contracts and identifiers |
| `@system-design-team/workflow-engine` | State transitions, reviews, gates, and policy |
| `@system-design-team/artifact-validator` | Artifact structure and review readiness |
| `@system-design-team/traceability` | Links, coverage, and staleness |
| `@system-design-team/project-store` | Contained atomic persistence and recovery |
| `@system-design-team/plugin-registry` | Plugin trust and invocation records |
| `@system-design-team/codex-adapter` | Scoped dispatch and receipt validation |
| `@system-design-team/sqlite-cache` | Disposable SQLite index |
| `@system-design-team/cli` | Public commands and bundled assets |

## Security and reliability

V1 applies least privilege, contained paths, redacted audit events, strict plugin publisher checks, operation idempotency, and evidence-bound completion. Repository content is treated as untrusted evidence rather than executable instruction. Production-impacting work requires current authorization and safety evidence; V1 validates those contracts but does not perform deployment.

## Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Security](docs/security.md)
- [Upgrade](docs/upgrade.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Full design specification](docs/superpowers/specs/2026-07-11-system-design-agent-team-design.md)

## Development

```bash
npm ci
npm run build
npm test
npm run check
```

CI runs the full check on Node.js 20 and 22 across Linux, Windows, and macOS. The repository uses ESM-only strict TypeScript, npm workspaces, and Node's built-in test runner.

## Roadmap

- **V1:** local Git-backed workflow engine, CLI, Codex adapter contracts, plugins, gates, and validation.
- **V2 (planned):** richer parallel dispatch, council orchestration, GitHub integration, and project health views.
- **V3 (planned):** optional hosted Python multi-agent runtime, durable queues, observability, and multi-project operation.

## Contributing

Create a focused branch, keep changes within the relevant workspace, add behavior test-first, and run `npm run check` before opening a pull request. Do not commit secrets or fabricate approval, review, or plugin evidence.

## License

No open-source license has been granted yet. Copyright remains with the repository owner.
