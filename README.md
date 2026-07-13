# System Design Agent Team

System Design Agent Team is a local, Codex-first workflow and dispatch framework for greenfield, existing-system, and migration projects. It stores reviewable project knowledge in Git, enforces G0-G9 approval gates, validates traceability and execution evidence, and prepares bounded agent work. V1 does not deploy to production or provide a hosted multi-agent runtime.

## Start here

Requires Node.js 20 or newer and Git.

```bash
npm ci
npm run check
node packages/cli/dist/bin.js --help
```

After installing the packed or published workspace packages, the executable is `system-design-team`. Initialize a project from its repository root:

```bash
system-design-team init --id leave-system --name "Leave System" --mode greenfield --profile standard --operation-id INIT-001
system-design-team status
system-design-team doctor
```

Git-backed Markdown and YAML under `.agent-team/` remain authoritative. The optional SQLite index is disposable and rebuildable. Plugin availability and skill contracts are checked, but availability does not prove a plugin invocation; only adapter-issued invocation evidence can do that.

Read [Getting started](docs/getting-started.md), [Architecture](docs/architecture.md), [Operations](docs/operations.md), [Security](docs/security.md), [Upgrade](docs/upgrade.md), and [Troubleshooting](docs/troubleshooting.md). The full intended product shape is recorded in the [design specification](docs/superpowers/specs/2026-07-11-system-design-agent-team-design.md).
