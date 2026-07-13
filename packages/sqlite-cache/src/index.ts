import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

export const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CACHE_PATH = ".agent-team/cache/index.db";

export type CacheUnavailableReason = "missing" | "corrupt" | "stale" | "incompatible";

export interface CacheStatusAvailable {
  available: true;
  schema_version: number;
  source_commit: string;
  document_count: number;
}

export interface CacheStatusUnavailable {
  available: false;
  reason: CacheUnavailableReason;
}

export type CacheStatus = CacheStatusAvailable | CacheStatusUnavailable;

export interface CachedDocument {
  path: string;
  content: string;
}

const execFileAsync = promisify(execFile);
const sourceExtensions = new Set([".md", ".yaml", ".yml"]);

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function targetPath(root: string, path: string): string {
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error("PATH_OUTSIDE_PROJECT");
  return target;
}

async function prepareTarget(root: string, path: string): Promise<string> {
  const target = targetPath(root, path);
  await mkdir(dirname(target), { recursive: true });
  if (!inside(root, await realpath(dirname(target)))) throw new Error("PATH_OUTSIDE_PROJECT");
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("PATH_OUTSIDE_PROJECT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

async function sourceCommit(root: string): Promise<string> {
  try {
    return (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })).stdout.trim();
  } catch {
    throw new Error("GIT_REQUIRED");
  }
}

async function sourceDocuments(root: string): Promise<CachedDocument[]> {
  const base = join(root, ".agent-team");
  try {
    const entry = await lstat(base);
    if (entry.isSymbolicLink() || !entry.isDirectory() || !inside(root, await realpath(base))) {
      throw new Error("PATH_OUTSIDE_PROJECT");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const documents: CachedDocument[] = [];
  const pending = [base];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (relative(base, path) !== "cache") pending.push(path);
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        documents.push({
          path: relative(root, path).split(sep).join("/"),
          content: await readFile(path, "utf8"),
        });
      }
    }
  }
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

export async function rebuildCache(
  projectRoot: string,
  path = DEFAULT_CACHE_PATH,
): Promise<CacheStatusAvailable> {
  const root = await realpath(resolve(projectRoot));
  const [commit, documents, target] = await Promise.all([
    sourceCommit(root),
    sourceDocuments(root),
    prepareTarget(root, path),
  ]);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let database: Database.Database | undefined;
  try {
    database = new Database(temporary);
    database.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents (path TEXT PRIMARY KEY, content TEXT NOT NULL);
    `);
    const insertDocument = database.prepare("INSERT INTO documents (path, content) VALUES (?, ?)");
    database.transaction((rows: readonly CachedDocument[]) => {
      for (const document of rows) insertDocument.run(document.path, document.content);
    })(documents);
    const insertMetadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    insertMetadata.run("schema_version", String(CACHE_SCHEMA_VERSION));
    insertMetadata.run("source_commit", commit);
    insertMetadata.run("document_count", String(documents.length));
    database.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
    database.close();
    database = undefined;
    await rename(temporary, target);
  } finally {
    database?.close();
    await rm(temporary, { force: true });
  }
  return {
    available: true,
    schema_version: CACHE_SCHEMA_VERSION,
    source_commit: commit,
    document_count: documents.length,
  };
}

export async function inspectCache(
  projectRoot: string,
  path = DEFAULT_CACHE_PATH,
): Promise<CacheStatus> {
  const root = await realpath(resolve(projectRoot));
  const target = targetPath(root, path);
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink() || !inside(root, await realpath(target))) {
      return { available: false, reason: "corrupt" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false, reason: "missing" };
    }
    return { available: false, reason: "corrupt" };
  }
  let database: Database.Database | undefined;
  try {
    database = new Database(target, { readonly: true, fileMustExist: true });
    if (database.pragma("integrity_check", { simple: true }) !== "ok") {
      return { available: false, reason: "corrupt" };
    }
    const metadata = new Map((database.prepare("SELECT key, value FROM metadata").all() as {
      key: string;
      value: string;
    }[]).map(({ key, value }) => [key, value]));
    const schemaVersion = Number(metadata.get("schema_version"));
    if (schemaVersion !== CACHE_SCHEMA_VERSION
      || database.pragma("user_version", { simple: true }) !== CACHE_SCHEMA_VERSION) {
      return { available: false, reason: "incompatible" };
    }
    const commit = metadata.get("source_commit");
    const documentCount = Number(metadata.get("document_count"));
    const storedCount = Number((database.prepare("SELECT COUNT(*) AS count FROM documents").get() as {
      count: number;
    }).count);
    if (!commit || !Number.isSafeInteger(documentCount) || documentCount < 0 || storedCount !== documentCount) {
      return { available: false, reason: "corrupt" };
    }
    if (commit !== await sourceCommit(root)) return { available: false, reason: "stale" };
    return {
      available: true,
      schema_version: schemaVersion,
      source_commit: commit,
      document_count: documentCount,
    };
  } catch {
    return { available: false, reason: "corrupt" };
  } finally {
    database?.close();
  }
}

export async function queryCache(
  projectRoot: string,
  query: string,
  path = DEFAULT_CACHE_PATH,
): Promise<(CacheStatus & { results: CachedDocument[] })> {
  const status = await inspectCache(projectRoot, path);
  if (!status.available) return { ...status, results: [] };
  let database: Database.Database | undefined;
  try {
    const root = await realpath(resolve(projectRoot));
    database = new Database(targetPath(root, path), { readonly: true, fileMustExist: true });
    const results = database.prepare(`
      SELECT path, content FROM documents
      WHERE instr(path, ?) > 0 OR instr(content, ?) > 0
      ORDER BY path
    `).all(query, query) as CachedDocument[];
    return { ...status, results };
  } catch {
    return { available: false, reason: "corrupt", results: [] };
  } finally {
    database?.close();
  }
}
