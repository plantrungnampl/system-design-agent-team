# Getting started

V1 is a local Codex-first workflow and dispatch framework. Run it in the Git repository that will own `.agent-team/` project memory.

## Install and verify

Node.js 20 or newer and Git are required. For framework development:

```bash
npm ci
npm run check
node packages/cli/dist/bin.js --help
```

The package smoke test packs every internal workspace, installs the tarballs into a clean temporary package, and runs the installed CLI. A consumer may use the `system-design-team` executable after those packages are published or supplied as tarballs.

## Choose a project mode

Greenfield starts from a new business problem:

```bash
system-design-team init --id leave-system --name "Leave System" --mode greenfield --profile standard --operation-id INIT-GREENFIELD-001
```

Existing-system adoption inventories tracked source and documentation without changing application source:

```bash
system-design-team adopt --id order-system --name "Order System" --profile standard --operation-id ADOPT-001
```

Migration starts with legacy assessment and continues through separately approved cutover, reconciliation, and decommission phases:

```bash
system-design-team init --id order-migration --name "Order Migration" --mode migration --profile enterprise --operation-id INIT-MIGRATION-001
```

Use `small`, `standard`, `enterprise`, or `regulated` profiles. Generated project artifacts are English. Inspect the effective installation and current state:

```bash
system-design-team inspect
system-design-team status
system-design-team doctor
```

## Work through a phase

Every mutation needs a caller-supplied operation ID. A typical phase follows start, artifact work, validation, independent review, human approval where required, then handover:

```bash
system-design-team start intake --operation-id INTAKE-START-001
system-design-team validate intake --operation-id INTAKE-VALIDATE-001
system-design-team review intake --reviewer documentation-reviewer --verdict approved --operation-id INTAKE-REVIEW-001
system-design-team approve G0 --by project-owner --operation-id INTAKE-APPROVE-001
system-design-team handover intake --operation-id INTAKE-HANDOVER-001
```

Required-plugin phases need a host-provided execution adapter. The standalone CLI checks persisted status and evidence but does not invoke third-party capabilities by itself. See [Security](security.md) for the plugin contract and [Operations](operations.md) for gate and recovery procedures.
