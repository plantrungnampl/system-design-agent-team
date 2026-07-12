# Getting started

This repository is the first V1 vertical slice: greenfield initialization and the approval-gated intake-to-requirements-to-product path.

## Prerequisites

- Node.js 20 or newer
- Git
- A repository checkout of this project

Install, build, and inspect the implemented commands:

```bash
npm ci
npm run build
node packages/cli/dist/bin.js --help
```

Run the CLI from the project repository you want to manage, using the absolute path to this checkout's built `bin.js`:

```bash
node /path/to/system-design-agent-team/packages/cli/dist/bin.js init \
  --id leave-system --name "Leave System" --mode greenfield --profile standard
node /path/to/system-design-agent-team/packages/cli/dist/bin.js status
node /path/to/system-design-agent-team/packages/cli/dist/bin.js doctor
```

The lifecycle commands are:

```text
start <phase> --operation-id <id>
validate <phase> --operation-id <id>
review <phase> --reviewer <id> --verdict <approved|revision_required> --operation-id <id>
approve <gate> --by <human-id> --operation-id <id>
handover <phase> --operation-id <id>
```

Lock files are never reclaimed automatically. If `doctor` reports an abandoned same-host lock, stop every framework process for the project, then explicitly confirm that quiescent state:

```text
repair --locks --yes
```

The repair command only removes generated lock files with valid metadata whose same-host owner PID is dead. Live, foreign-host, invalid, and unconfirmed repairs remain blocked.

`start` blocks until the host records the owner's required plugin skills through the exported `setPluginStatus` library API. There is no plugin-status CLI command in this slice.

Packed CLI assets still require a repository checkout: workflows, the agent catalogue, and templates are not yet included in the npm package. Run `npm run check` for the complete build and test gate.
