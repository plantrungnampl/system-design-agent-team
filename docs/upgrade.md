# Upgrade, eject, and uninstall

Commit or otherwise checkpoint project memory before lifecycle maintenance. Inspect the current managed installation, then preview compatibility without changing files:

```bash
system-design-team inspect
system-design-team upgrade --check
system-design-team upgrade --dry-run
```

V1 reports proposed framework, workflow-lock, generated-file, and local-override conflicts. It does not silently merge conflicting business artifacts or approve migrated content. Resolve reported conflicts in source configuration or overrides, then run the checks again.

To materialize the managed catalogue and workflow into project-owned overrides:

```bash
system-design-team eject --operation-id EJECT-001
```

Eject preserves `.agent-team/` history and changes the project to self-managed behavior. Automatic managed upgrades no longer apply.

To remove generated adapter files while preserving project knowledge:

```bash
system-design-team uninstall --operation-id UNINSTALL-001
```

Uninstall verifies the installation manifest and preserves `.agent-team/`, approvals, decisions, reviews, audit history, and artifacts. V1 intentionally exposes no purge command. Delete retained project memory only through a separately reviewed repository change.

If maintenance is interrupted, run `system-design-team doctor`; retry the same operation ID after resolving the reported transaction or lock condition. See [Operations](operations.md) for safe lock repair.
