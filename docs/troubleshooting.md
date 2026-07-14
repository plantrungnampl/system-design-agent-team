# Troubleshooting

## A phase will not start

Run:

```bash
system-design-team doctor
system-design-team status
```

Resolve previous-gate, stale-artifact, or required-plugin findings. Plugin availability alone is not invocation evidence. Required-plugin lifecycle execution needs a configured host adapter; the standalone CLI cannot manufacture that adapter or its receipts.

## A gate is not ready

```bash
system-design-team gate readiness G7
system-design-team evidence verify
system-design-team trace check
system-design-team stale list
```

Fix the named missing, stale, unreviewed, or mismatched evidence. Do not edit an approval record to bypass readiness.

## Cache diagnostics fail

The SQLite cache is disposable. Authoritative YAML and Markdown operations continue when it is missing, stale, or corrupt. Rebuild it:

```bash
system-design-team cache rebuild
system-design-team diagnostics
```

## A lock remains after a crash

Stop every framework process and use `system-design-team doctor` to confirm that the same-host owner PID is dead. Then follow the explicit repair procedure in [Operations](operations.md). Never delete unknown lock files while another process may be active.

## Upgrade or uninstall reports a conflict

Use `system-design-team upgrade --dry-run` to inspect workflow-lock, generated-file, or override conflicts. Uninstall preserves altered generated files and reports their paths in `preserved`; decide whether each file is a local customization, then resolve it deliberately.

## A command is missing

```bash
node packages/cli/dist/bin.js --help
```

Only help-listed commands exist in V1. Council automation, dashboards, publishing, hosted orchestration, and automatic deployment are not implemented.
