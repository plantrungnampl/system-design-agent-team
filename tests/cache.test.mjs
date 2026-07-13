import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  CACHE_SCHEMA_VERSION,
  inspectCache,
  queryCache,
  rebuildCache,
} from "../packages/sqlite-cache/dist/index.js";

const execFileAsync = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "system-design-cache-"));
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "cache@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Cache Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "cache fixture\n");
  await commit(root, "initial");
  return root;
}

async function commit(root, message) {
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", message], { cwd: root });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

test("rebuilds an empty cache with integrity metadata", async () => {
  const root = await repository();

  const rebuilt = await rebuildCache(root);

  assert.equal(rebuilt.schema_version, CACHE_SCHEMA_VERSION);
  assert.equal(rebuilt.document_count, 0);
  assert.match(rebuilt.source_commit, /^[a-f0-9]{40}$/);
  assert.equal((await inspectCache(root)).available, true);
});

test("indexes authoritative YAML and Markdown in a real SQLite database", async () => {
  const root = await repository();
  await mkdir(join(root, ".agent-team/context"), { recursive: true });
  await writeFile(join(root, ".agent-team/project.yaml"), "project:\n  id: leave-system\n");
  await writeFile(join(root, ".agent-team/context/decision.md"), "# Decision\nUse queues.\n");
  await writeFile(join(root, ".agent-team/context/ignored.txt"), "Decision outside authoritative formats\n");
  await commit(root, "add project files");

  const rebuilt = await rebuildCache(root);
  const query = await queryCache(root, "Decision");
  const header = await readFile(join(root, ".agent-team/cache/index.db"));

  assert.equal(header.subarray(0, 16).toString(), "SQLite format 3\0");
  assert.equal(rebuilt.document_count, 2);
  assert.equal(query.available, true);
  assert.deepEqual(query.results.map(({ path }) => path), [".agent-team/context/decision.md"]);
});

test("disables cache queries when the database is corrupt", async () => {
  const root = await repository();
  await rebuildCache(root);
  await writeFile(join(root, ".agent-team/cache/index.db"), "not sqlite");

  const query = await queryCache(root, "anything");

  assert.deepEqual(query, { available: false, reason: "corrupt", results: [] });
});

test("disables cache queries when the source commit is stale", async () => {
  const root = await repository();
  await rebuildCache(root);
  await writeFile(join(root, "README.md"), "changed after rebuild\n");
  await commit(root, "change source");

  const query = await queryCache(root, "anything");

  assert.deepEqual(query, { available: false, reason: "stale", results: [] });
});

test("treats a deleted cache as unavailable", async () => {
  const root = await repository();
  await rebuildCache(root);
  await rm(join(root, ".agent-team/cache/index.db"));

  const query = await queryCache(root, "anything");

  assert.deepEqual(query, { available: false, reason: "missing", results: [] });
});

test("a full rebuild replaces an unusable cache", async () => {
  const root = await repository();
  await mkdir(join(root, ".agent-team"), { recursive: true });
  await writeFile(join(root, ".agent-team/glossary.yaml"), "entries:\n  - term: Queue\n    definition: Work awaiting processing.\n");
  const sourceCommit = await commit(root, "add glossary");
  await mkdir(join(root, ".agent-team/cache"), { recursive: true });
  await writeFile(join(root, ".agent-team/cache/index.db"), "broken");

  const rebuilt = await rebuildCache(root);
  const query = await queryCache(root, "Queue");

  assert.equal(rebuilt.source_commit, sourceCommit);
  assert.equal(query.available, true);
  assert.deepEqual(query.results.map(({ path }) => path), [".agent-team/glossary.yaml"]);
});

test("rejects a cache path outside the project", async () => {
  const root = await repository();

  await assert.rejects(
    () => rebuildCache(root, "../index.db"),
    /PATH_OUTSIDE_PROJECT/,
  );
});
