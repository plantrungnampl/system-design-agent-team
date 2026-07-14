# 0001: SQLite cache runtime

Status: accepted

The project query cache uses `better-sqlite3@12.10.1`. Its supported engines include Node.js 20, 22, and 24, matching this repository's Node.js 20 minimum. It provides a small synchronous API over a direct SQLite file, which fits a disposable local cache better than a client/server database.

Current releases may compile from source on Node.js 20 because prebuilt binaries were removed. Contributors therefore need a working native build toolchain when no compatible binary is available.

The cache is rebuilt in full at `.agent-team/cache/index.db`. Git-backed YAML and Markdown remain authoritative; SQLite is never a fallback source of record. Cache corruption or incompatibility disables cache-backed queries until the next rebuild and must not block core workflows.

Incremental updates are intentionally out of scope because a complete rebuild is sufficient for the current project size and avoids synchronization logic.
