```markdown
# system-design-agent-team Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill introduces the core development patterns, coding conventions, and workflows used in the `system-design-agent-team` TypeScript monorepo. It covers how to add new packages, implement features or fixes, manage cross-package changes, maintain tests, and update documentation. The guide is designed to help contributors quickly understand and follow established practices for consistent, high-quality contributions.

## Coding Conventions

- **Language:** TypeScript (no major framework)
- **File Naming:** Use `camelCase` for files and directories.
  - Example: `myFeature.ts`, `userService/`
- **Import Style:** Use absolute imports.
  - Example:
    ```typescript
    import { doSomething } from 'utils/doSomething';
    ```
- **Export Style:** Use named exports.
  - Example:
    ```typescript
    // src/index.ts
    export function myFunction() { ... }
    export const MY_CONST = 42;
    ```
- **Commit Messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/) with these prefixes:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation changes
  - `test:` for test-related changes
  - Example: `feat: add project lifecycle hooks`

## Workflows

### Add New Package/Module
**Trigger:** When introducing a new logical component or service as a package.  
**Command:** `/new-package`

1. Create a new directory under `packages/` (e.g., `packages/myNewPackage`)
2. Add `package.json` and `tsconfig.json` for the new package.
3. Implement initial logic in `src/index.ts`.
4. Add or update the root-level `tsconfig.json` to include the new package.
5. Add or update `package-lock.json`.
6. Add an initial test file in `tests/` (e.g., `tests/myNewPackage.test.mjs`).

**Example:**
```bash
mkdir packages/myNewPackage
# Add package.json and tsconfig.json
# Implement src/index.ts
# Add tests/myNewPackage.test.mjs
```

---

### Feature or Fix in Existing Package
**Trigger:** When adding a feature or fixing a bug in an existing package.  
**Command:** `/feature`

1. Edit `src/index.ts` in the relevant package.
2. Update or add tests in `tests/`.
3. Optionally update related files (e.g., `bin.ts` for CLI).
4. Commit with a `feat:` or `fix:` message.

**Example:**
```typescript
// packages/myPackage/src/index.ts
export function newFeature() { ... }
```
```bash
# Update tests/myPackage.test.mjs
git commit -m "feat: add new feature to myPackage"
```

---

### Cross-Package Feature or Fix
**Trigger:** When implementing or fixing a feature that affects multiple packages and their tests.  
**Command:** `/cross-feature`

1. Edit `src/index.ts` in each affected package.
2. Update or add tests for each affected package.
3. Optionally update `bin.ts` or other entrypoints.
4. Commit with a `feat:` or `fix:` message.

**Example:**
```typescript
// packages/packageA/src/index.ts
// packages/packageB/src/index.ts
// Update both implementations and corresponding tests
```

---

### Add or Update E2E Test Fixtures
**Trigger:** When verifying or expanding end-to-end (E2E) coverage for workflows.  
**Command:** `/add-e2e-test`

1. Add or update `tests/e2e-*.test.mjs` files.
2. Add or update files in `tests/fixtures/`.
3. Optionally update implementation files if needed for E2E.
4. Commit with `test(e2e):` or `fix:` message.

**Example:**
```bash
# Add tests/e2e-user-flow.test.mjs
# Update tests/fixtures/sampleData.json
git commit -m "test(e2e): add user flow scenario"
```

---

### Documentation or Plan Update
**Trigger:** When documenting plans, decisions, or updating user/developer docs.  
**Command:** `/add-doc`

1. Edit or add files in `docs/`.
2. Optionally update `README.md`.
3. Commit with `docs:` message.

**Example:**
```bash
# Edit docs/architecture.md
git commit -m "docs: update architecture overview"
```

---

### Test-Driven Fix or Hardening
**Trigger:** When fixing a bug or hardening logic, ensuring tests reflect the change.  
**Command:** `/fix`

1. Edit `src/index.ts` in the affected package.
2. Edit or add relevant test files.
3. Commit with `fix:` message.

**Example:**
```typescript
// packages/myPackage/src/index.ts
export function fixedFunction() { ... }
```
```bash
# Update tests/myPackage.test.mjs
git commit -m "fix: handle edge case in myPackage"
```

---

## Testing Patterns

- **Test File Pattern:** `*.test.mjs` (JavaScript/TypeScript, ESM modules)
- **Test Location:** All tests are in the `tests/` directory.
- **E2E Tests:** Use `tests/e2e-*.test.mjs` and supporting files in `tests/fixtures/`.
- **Testing Framework:** Not explicitly specified; follow the pattern in existing test files.

**Example Test File:**
```javascript
// tests/myPackage.test.mjs
import { myFunction } from '../packages/myPackage/src/index.js';

describe('myFunction', () => {
  it('should return expected value', () => {
    // test logic
  });
});
```

## Commands

| Command         | Purpose                                                       |
|-----------------|---------------------------------------------------------------|
| /new-package    | Scaffold and implement a new package/module                   |
| /feature        | Add a feature or fix to an existing package                   |
| /cross-feature  | Implement a feature or fix across multiple packages           |
| /add-e2e-test   | Add or update E2E test files and fixtures                     |
| /add-doc        | Add or update documentation or planning files                 |
| /fix            | Apply a test-driven fix or hardening to implementation/tests  |
```