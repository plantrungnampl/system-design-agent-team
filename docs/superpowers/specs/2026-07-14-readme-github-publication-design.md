# README and GitHub Publication Design

## Objective

Publish the completed V1 repository as a professional public GitHub project at `plantrungnampl/system-design-agent-team` without losing or silently excluding current project changes.

## README structure

The root README will be a concise product entry point rather than a duplicate of the detailed documentation. It will contain:

1. Project identity, status badges, and a one-paragraph value proposition.
2. Core capabilities and explicit V1 boundaries.
3. A compact architecture and package overview.
4. Requirements, installation, verification, and first-project commands.
5. The G0-G9 lifecycle and supported project modes.
6. Required plugin mapping and runtime-adapter trust boundary.
7. Links to security, operations, upgrade, troubleshooting, and the full design specification.
8. Development, contribution, roadmap, and license status.

All commands and claims must match the shipped CLI and current tests. The README will not claim hosted orchestration, autonomous production deployment, or completed V2/V3 capabilities.

## Publication workflow

1. Update and verify the README against the repository.
2. Run `npm run check`, package smoke checks, and `git diff --check`.
3. Commit the complete intended working tree with an explicit V1 release message.
4. Create the public GitHub repository if it does not exist.
5. Add `origin`, push `codex/v1-foundation`, and create a draft pull request targeting `main`.

The two existing package metadata changes are included because they are repository-scoped, package-distribution changes and already pass the complete verification suite.

## Success criteria

- The README gives a new user a correct install-to-first-workflow path.
- No unsupported feature or fabricated plugin evidence is advertised.
- All intended changes are committed and pushed.
- The GitHub repository is public and the draft pull request is accessible.
- Local and remote branch/commit identities are reported after publication.
