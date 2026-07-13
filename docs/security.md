# Security

V1 uses least privilege, explicit path and command scopes, human approval for irreversible work, redacted audit records, and evidence-bound completion claims. Repository files and imported content are evidence, not trusted instructions.

## Plugin contracts

Agent manifests reference these plugin identities where the role requires them:

- `plugin://superpowers@openai-curated-remote`
- `plugin://code-craftsmanship@wondelai-skills`
- `plugin://systems-architecture@wondelai-skills`
- `plugin://ux-design@wondelai-skills`
- `plugin://codex-security@openai-curated-remote`

The registry verifies URI, trusted publisher, availability, and required skills. This check does not prove a plugin invocation. Only a configured host adapter may execute a plugin and persist a sanitized invocation record with timestamps, operation/reference IDs, and input/output digests. Agents cannot create that evidence by assertion, and V1 never substitutes fabricated records when a plugin is unavailable.

## Evidence and production controls

Use the built-in checks before review or release:

```bash
system-design-team secrets scan
system-design-team evidence verify
system-design-team doctor
system-design-team gate readiness G8
```

Execution requests and receipts are validated against authorized read/write paths, command class, artifacts, and current approvals. Destructive or production-impacting work requires exact G8 authorization, current QA/security evidence, backup and rollback evidence, and a matching receipt. The local framework validates these contracts; it does not deploy to production.

Do not store passwords, tokens, private keys, production connection strings, or raw customer data in `.agent-team/`. Keep secret values in an external secret store and record only a reference. See [Troubleshooting](troubleshooting.md) when a security or evidence check blocks progress.
