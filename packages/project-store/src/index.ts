import { randomUUID } from "node:crypto";
import {
  appendFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { WorkflowStateSchema, type WorkflowState } from "@system-design-team/core";
import { parse, stringify } from "yaml";

type Schema<T> = { parse(value: unknown): T };
type ProjectStoreErrorCode =
  | "PATH_OUTSIDE_PROJECT"
  | "STATE_LOCKED"
  | "STATE_VERSION_CONFLICT"
  | "STATE_VERSION_INVALID";

export class ProjectStoreError extends Error {
  constructor(readonly code: ProjectStoreErrorCode) {
    super(code);
    this.name = "ProjectStoreError";
  }
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function targetPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (!inside(root, target)) throw new ProjectStoreError("PATH_OUTSIDE_PROJECT");
  return target;
}

async function nearestExisting(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function requireInside(realRoot: string, realTarget: string): void {
  if (!inside(realRoot, realTarget)) throw new ProjectStoreError("PATH_OUTSIDE_PROJECT");
}

async function prepareParent(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root);
  requireInside(realRoot, await nearestExisting(dirname(target)));
  await mkdir(dirname(target), { recursive: true });
  requireInside(realRoot, await realpath(dirname(target)));
  return realRoot;
}

async function atomicWrite(root: string, path: string, content: string): Promise<void> {
  await prepareParent(root, path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const sensitiveKey = /password|passphrase|token|secret|api.?key|private.?key|connection.?string|cookie|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? "[REDACTED]" : redact(item),
  ]));
}

async function abandonedLocalLock(path: string): Promise<boolean> {
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return false;
  }
  if (!owner || typeof owner !== "object") return false;
  const { pid, hostname: ownerHost, created_at: createdAt } = owner as Record<string, unknown>;
  if (!Number.isInteger(pid) || (pid as number) <= 0
    || ownerHost !== hostname()
    || typeof createdAt !== "string"
    || !Number.isFinite(Date.parse(createdAt))) return false;
  try {
    process.kill(pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export class ProjectStore {
  private constructor(private readonly root: string) {}

  static open(root: string): ProjectStore {
    return new ProjectStore(resolve(root));
  }

  async readYaml<T>(relativePath: string, schema: Schema<T>): Promise<T> {
    const target = targetPath(this.root, relativePath);
    requireInside(await realpath(this.root), await realpath(target));
    return schema.parse(parse(await readFile(target, "utf8")));
  }

  async writeYamlAtomic(relativePath: string, value: unknown): Promise<void> {
    const target = targetPath(this.root, relativePath);
    await atomicWrite(this.root, target, stringify(value));
  }

  async writeTextAtomic(relativePath: string, content: string): Promise<void> {
    const target = targetPath(this.root, relativePath);
    await atomicWrite(this.root, target, content);
  }

  async withLock<T>(relativeLockPath: string, callback: () => Promise<T> | T): Promise<T> {
    const lockPath = targetPath(this.root, relativeLockPath);
    await prepareParent(this.root, lockPath);
    let lock: FileHandle | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        lock = await open(lockPath, "wx");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 0 && await abandonedLocalLock(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new ProjectStoreError("STATE_LOCKED");
      }
    }
    if (!lock) throw new ProjectStoreError("STATE_LOCKED");
    try {
      await lock.writeFile(JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        created_at: new Date().toISOString(),
      }), "utf8");
      await lock.sync();
      return await callback();
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }

  readWorkflowState(): Promise<WorkflowState> {
    return this.readYaml(".agent-team/workflow-state.yaml", WorkflowStateSchema);
  }

  async updateWorkflowState(
    expectedVersion: number,
    reducer: (state: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    return this.withLock(".agent-team/workflow-state.lock", async () => {
      const current = await this.readWorkflowState();
      if (current.state_version !== expectedVersion) {
        throw new ProjectStoreError("STATE_VERSION_CONFLICT");
      }

      const requiredVersion = current.state_version + 1;
      const next = reducer(current);
      if (next.state_version !== requiredVersion) {
        throw new ProjectStoreError("STATE_VERSION_INVALID");
      }

      const validated = WorkflowStateSchema.parse(next);
      await this.writeYamlAtomic(".agent-team/workflow-state.yaml", validated);
      return validated;
    });
  }

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    const target = targetPath(this.root, ".agent-team/audit/events.jsonl");
    const realRoot = await prepareParent(this.root, target);
    let exists = true;
    try {
      await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      let realTarget: string;
      try {
        realTarget = await realpath(target);
      } catch {
        throw new ProjectStoreError("PATH_OUTSIDE_PROJECT");
      }
      requireInside(realRoot, realTarget);
    }
    await appendFile(target, `${JSON.stringify(redact(event))}\n`, "utf8");
  }

  async appendAuditOnce(event: Record<string, unknown> & { id: string }): Promise<void> {
    if (!event.id) throw new Error("AUDIT_ID_REQUIRED");
    await this.withLock(".agent-team/audit/events.lock", async () => {
      const target = targetPath(this.root, ".agent-team/audit/events.jsonl");
      let text = "";
      try {
        requireInside(await realpath(this.root), await realpath(target));
        text = await readFile(target, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const exists = text.split(/\r?\n/).filter(Boolean)
        .some((line) => (JSON.parse(line) as { id?: unknown }).id === event.id);
      if (!exists) await this.appendAudit(event);
    });
  }
}
