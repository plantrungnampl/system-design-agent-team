---
name: add-new-package-module
description: Workflow command scaffold for add-new-package-module in system-design-agent-team.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-new-package-module

Use this workflow when working on **add-new-package-module** in `system-design-agent-team`.

## Goal

Adds a new package/module to the monorepo, including implementation, package config, tsconfig, and initial tests.

## Common Files

- `packages/*/package.json`
- `packages/*/tsconfig.json`
- `packages/*/src/index.ts`
- `package-lock.json`
- `tsconfig.json`
- `tests/*.test.mjs`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create new package directory under packages/
- Add package.json and tsconfig.json for the new package
- Implement initial logic in src/index.ts
- Add or update root-level tsconfig.json
- Add or update package-lock.json

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.