# Repository Guidelines

- Use Node.js 20 or newer and npm workspaces. Run `npm run check` before committing.
- Keep packages ESM-only, strict TypeScript projects with explicit public exports.
- Add behavior test-first with Node's built-in test runner. Preserve genuine RED and GREEN evidence.
- Keep changes inside the requested package; do not add speculative commands, abstractions, or dependencies.
- Validate persisted domain data with the shared Zod contracts from `@system-design-team/core`.
- Treat Git-backed YAML as authoritative. Never fabricate approval or plugin-invocation evidence.
