# README and GitHub Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the completed V1 framework with a professional, accurate README in the public `plantrungnampl/system-design-agent-team` GitHub repository.

**Architecture:** Keep the root README as the concise product entry point and link detailed operational material from `docs/`. Publish the existing feature branch without rewriting history, then open a draft pull request into `main`.

**Tech Stack:** Markdown, Node.js 20+, npm workspaces, Git, GitHub CLI.

## Global Constraints

- Preserve all current repository-scoped implementation changes.
- Do not claim hosted orchestration, autonomous production deployment, or completed V2/V3 capabilities.
- Git-backed Markdown and YAML remain authoritative.
- Required plugin availability never substitutes for verified invocation evidence.
- Run `npm run check` before publication.

---

### Task 1: Professional root README

**Files:**
- Modify: `README.md`
- Verify: `tests/documentation-consistency.test.mjs`

**Interfaces:**
- Consumes: shipped CLI help, workspace package names, `docs/*.md`, and the approved design specification.
- Produces: the public project landing page and correct links into detailed documentation.

- [ ] **Step 1: Replace the root README with the approved structure**

Write these concrete sections in order:

```markdown
# System Design Agent Team
[![CI](https://github.com/plantrungnampl/system-design-agent-team/actions/workflows/ci.yml/badge.svg)](https://github.com/plantrungnampl/system-design-agent-team/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

A local, Codex-first framework that coordinates an END2END system-design team with approval gates, traceability, and verified execution evidence. V1 is a Git-backed CLI framework; it does not autonomously deploy production or provide the planned hosted V2/V3 runtime.

## Why this exists
## What V1 provides
## Architecture
## Quick start
## Workflow and approval gates
## Project modes
## Plugin contracts
## Workspace packages
## Security and reliability
## Documentation
## Development
## Roadmap
## Contributing
## License
```

Use only commands exposed by `system-design-team --help`. Quick start must show Node.js 20+, `npm ci`, `npm run check`, project initialization, status, doctor, and the host-provided `--plugin-adapter` option for plugin-bound lifecycle commands.

- [ ] **Step 2: Verify documentation claims and links**

Run:

```bash
node --test tests/documentation-consistency.test.mjs
```

Expected: 3 tests pass, 0 fail.

---

### Task 2: Release verification and commit

**Files:**
- Modify: all currently tracked V1 implementation, test, workflow, package metadata, README, and publication-plan files in the working tree.
- Test: complete repository suite and packed workspace smoke test.

**Interfaces:**
- Consumes: the verified V1 working tree.
- Produces: one intentional release commit on `codex/v1-foundation`.

- [ ] **Step 1: Run the full release checks**

Run:

```bash
npm run check
npm ci --dry-run
npm pack --workspaces --dry-run
git diff --check
```

Expected: all commands exit 0; the test suite reports no failures.

- [ ] **Step 2: Confirm the intended publication scope**

Run:

```bash
git status -sb
git diff --stat
```

Expected: only repository-scoped V1 implementation, tests, workflow, package metadata, README, and publication documentation are modified.

- [ ] **Step 3: Commit the release-ready tree**

Run:

```bash
git add --all
git commit -m "feat: complete V1 system design agent team"
```

Expected: a new commit on `codex/v1-foundation` and no unstaged intended changes.

---

### Task 3: Public GitHub repository and draft pull request

**Files:**
- External state: GitHub repository `plantrungnampl/system-design-agent-team`
- External state: local `origin` remote

**Interfaces:**
- Consumes: the committed `codex/v1-foundation` branch and authenticated GitHub CLI session.
- Produces: a public repository, tracked remote branch, and draft pull request targeting `main`.

- [ ] **Step 1: Create or verify the public repository**

Run:

```bash
gh repo view plantrungnampl/system-design-agent-team --json nameWithOwner,visibility,defaultBranchRef
```

If it does not exist, run:

```bash
gh repo create plantrungnampl/system-design-agent-team --public --description "Codex-first END2END system design agent team with approval gates, traceability, and verified execution evidence"
```

Expected: repository exists with `PUBLIC` visibility.

- [ ] **Step 2: Configure origin and push the feature branch**

Run:

```bash
git remote add origin https://github.com/plantrungnampl/system-design-agent-team.git
git push -u origin codex/v1-foundation
```

If `origin` already exists, verify it points to the same repository instead of replacing it silently.

Expected: `codex/v1-foundation` tracks `origin/codex/v1-foundation`.

- [ ] **Step 3: Ensure a `main` base exists and open the draft pull request**

Push the existing local `main` branch (`6602c16`, the approved design specification baseline) without changing the current working branch:

```bash
git push origin main:main
gh pr create --repo plantrungnampl/system-design-agent-team --base main --head codex/v1-foundation --draft --title "Complete V1 system design agent team" --body-file .git/codex-pr-body.md
```

The PR body must summarize capabilities, review fixes, user impact, and the exact verification commands.

Expected: GitHub returns a draft PR URL targeting `main`.

- [ ] **Step 4: Verify publication identity**

Run:

```bash
git status -sb
git rev-parse HEAD
git ls-remote --heads origin main codex/v1-foundation
gh pr view --json url,isDraft,baseRefName,headRefName,state
```

Expected: clean intended worktree, matching local/remote feature commit, `main` base, and an open draft pull request.
