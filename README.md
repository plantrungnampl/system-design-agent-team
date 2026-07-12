# System Design Agent Team

Codex-first, approval-gated, END2END multi-agent framework for greenfield, existing-system, and migration projects.

Current status: the foundation packages and first V1 approval-gated vertical slice are implemented.

Requires Node.js 20 or newer and Git. From this repository checkout:

```bash
npm install
npm run build
node packages/cli/dist/bin.js --help
```

The first slice exposes `init`, `status`, `start`, `validate`, `review`, `approve`, `handover`, and `doctor` for the intake-to-requirements-to-product workflow. Project state is stored under `.agent-team/`; application source and an existing root `AGENTS.md` are left untouched.

Packed CLI assets still require this repository checkout; workflows, the agent catalogue, and templates are not yet bundled for standalone installation.

See [Getting started](docs/getting-started.md), [Architecture and sources of truth](docs/architecture.md), and the [design specification](docs/superpowers/specs/2026-07-11-system-design-agent-team-design.md).
