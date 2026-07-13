# Operations

## Approval gates

| Gate | Decision |
|---|---|
| G0 | Project intake or legacy baseline |
| G1 | Business scope or continuity |
| G2 | Requirements |
| G3 | Product scope and backlog |
| G4 | UX direction |
| G5 | Architecture, stack, data, and security design |
| G6 | Implementation or migration-wave plan |
| G7 | Release candidate or cutover readiness |
| G8 | Explicit production deployment or cutover authorization |
| G9 | Post-release acceptance, reconciliation, or decommission |

The active workflow determines which phases use each gate. An approval is bound to artifact versions; changed or stale evidence must be reviewed again. Author and reviewer identities remain separate.

Check progress and blockers with:

```bash
system-design-team status
system-design-team gate readiness G5
system-design-team issue list
system-design-team stale list
system-design-team trace check
system-design-team trace coverage
```

Validate project knowledge and evidence with:

```bash
system-design-team artifact list
system-design-team glossary validate
system-design-team evidence verify
system-design-team secrets scan
system-design-team diagnostics
```

## Cache and recovery

When the project was initialized with SQLite caching, rebuild the disposable index from current Git-backed files:

```bash
system-design-team cache rebuild
```

If an execution stops, rerun a mutating operation with the same operation ID to recover or return its prior result. `doctor` reports incomplete transactions, schema problems, cache health, missing plugins, and locks.

Lock repair is deliberately explicit. Stop every framework process for the project, verify the owner process is dead, then run:

```bash
system-design-team repair --locks --yes
```

Only valid, dead, same-host generated locks are removed. Invalid, live, foreign-host, or unconfirmed lock repair stays blocked. Production actions remain adapter- and authorization-controlled; this CLI does not deploy to production.
