import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import {
  AuditEventSchema,
  WorkflowStateSchema,
  type AuditEvent,
  type WorkflowState,
} from "@system-design-team/core";
import { parse, stringify } from "yaml";

type Schema<T> = { parse(value: unknown): T };
type ProjectStoreErrorCode =
  | "LOCK_PATH_NOT_GENERATED"
  | "OPERATION_ID_CONFLICT"
  | "PATH_OUTSIDE_PROJECT"
  | "PENDING_TRANSACTIONS"
  | "QUIESCENCE_CONFIRMATION_REQUIRED"
  | "STATE_LOCKED"
  | "STATE_VERSION_CONFLICT"
  | "STATE_VERSION_INVALID"
  | "TRANSACTION_JOURNAL_INVALID"
  | "TRANSACTION_WRITE_CONFLICT";

export class ProjectStoreError extends Error {
  constructor(readonly code: ProjectStoreErrorCode) {
    super(code);
    this.name = "ProjectStoreError";
  }
}

export const GENERATED_LOCK_PATHS = [
  ".system-design-team-init.lock",
  ".agent-team/lifecycle.lock",
  ".agent-team/transactions.lock",
  ".agent-team/workflow-state.lock",
  ".agent-team/audit/events.lock",
] as const;

export interface LockInspection {
  path: string;
  status: "missing" | "abandoned" | "locked";
}

export interface TransactionWrite {
  path: string;
  content: string;
  role?: "evidence" | "state";
}

export type TransactionFaultPoint =
  | "before_journal_commit"
  | "after_evidence_write"
  | "after_state_write"
  | "before_audit_append";

interface TransactionJournal {
  version: 1;
  operationId: string;
  writes: Array<Required<TransactionWrite> & { beforeDigest: string | null }>;
  auditEvent: AuditEvent;
}

interface TransactionReceipt {
  operationId: string;
  digest: string;
}

const transactionLock = ".agent-team/transactions.lock";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    sensitiveKey.test(key) && key !== "authorization_source" ? "[REDACTED]" : redact(item),
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
  private constructor(
    private readonly root: string,
    private readonly transactionFault?: (point: TransactionFaultPoint) => void,
  ) {}

  static open(
    root: string,
    options: { transactionFault?: (point: TransactionFaultPoint) => void } = {},
  ): ProjectStore {
    return new ProjectStore(resolve(root), options.transactionFault);
  }

  private journalPath(operationId: string): string {
    return `.agent-team/transactions/${digest(operationId)}.json`;
  }

  private receiptPath(operationId: string): string {
    return `.agent-team/transactions/completed/${digest(operationId)}.json`;
  }

  private journalDigest(journal: TransactionJournal): string {
    const { timestamp: _timestamp, ...auditEvent } = journal.auditEvent;
    return digest(JSON.stringify({
      operationId: journal.operationId,
      writes: journal.writes.map(({ path, content, role }) => ({ path, content, role })),
      auditEvent,
    }));
  }

  private async fileDigest(relativePath: string): Promise<string | null> {
    const target = targetPath(this.root, relativePath);
    try {
      requireInside(await realpath(this.root), await realpath(target));
      return digest(await readFile(target, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readContainedFile(relativePath: string, allowMissing = false): Promise<string | undefined> {
    const target = targetPath(this.root, relativePath);
    try {
      await lstat(target);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch {
      throw new ProjectStoreError("PATH_OUTSIDE_PROJECT");
    }
    requireInside(await realpath(this.root), realTarget);
    return readFile(target, "utf8");
  }

  private async pendingTransactionFiles(): Promise<string[]> {
    const directory = targetPath(this.root, ".agent-team/transactions");
    try {
      requireInside(await realpath(this.root), await realpath(directory));
      return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async assertNoPendingTransactions(): Promise<void> {
    if ((await this.pendingTransactionFiles()).length > 0) {
      throw new ProjectStoreError("PENDING_TRANSACTIONS");
    }
  }

  private validateJournal(value: unknown, file: string): TransactionJournal {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const raw = value as Record<string, unknown>;
      if (raw.version !== 1 || typeof raw.operationId !== "string" || raw.operationId.length === 0
        || !Array.isArray(raw.writes) || !raw.auditEvent || typeof raw.auditEvent !== "object"
        || file !== `${digest(raw.operationId)}.json`) throw new Error();
      const auditEvent = AuditEventSchema.parse(raw.auditEvent);
      if (auditEvent.id !== raw.operationId) throw new Error();
      const seen = new Set<string>();
      const writes = raw.writes.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        const write = value as Record<string, unknown>;
        if (typeof write.path !== "string" || typeof write.content !== "string"
          || (write.role !== "evidence" && write.role !== "state")
          || (write.beforeDigest !== null
            && (typeof write.beforeDigest !== "string" || !/^[a-f0-9]{64}$/.test(write.beforeDigest)))) throw new Error();
        targetPath(this.root, write.path);
        if (seen.has(write.path)) throw new Error();
        seen.add(write.path);
        return {
          path: write.path,
          content: write.content,
          role: write.role,
          beforeDigest: write.beforeDigest,
        } as Required<TransactionWrite> & { beforeDigest: string | null };
      });
      return { version: 1, operationId: raw.operationId, writes, auditEvent };
    } catch {
      throw new ProjectStoreError("TRANSACTION_JOURNAL_INVALID");
    }
  }

  private async readReceipt(operationId: string): Promise<TransactionReceipt | undefined> {
    try {
      const text = await this.readContainedFile(this.receiptPath(operationId), true);
      if (text === undefined) return undefined;
      const value = JSON.parse(text) as TransactionReceipt;
      if (value.operationId !== operationId || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error();
      return value;
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      throw new ProjectStoreError("TRANSACTION_JOURNAL_INVALID");
    }
  }

  private async applyJournal(journal: TransactionJournal): Promise<void> {
    const currentDigests = await Promise.all(journal.writes.map(({ path }) => this.fileDigest(path)));
    journal.writes.forEach((write, index) => {
      const current = currentDigests[index];
      if (current !== write.beforeDigest && current !== digest(write.content)) {
        throw new ProjectStoreError("TRANSACTION_WRITE_CONFLICT");
      }
    });
    for (const write of journal.writes) {
      const current = await this.fileDigest(write.path);
      const intended = digest(write.content);
      if (current !== intended) await atomicWrite(this.root, targetPath(this.root, write.path), write.content);
      this.transactionFault?.(write.role === "state" ? "after_state_write" : "after_evidence_write");
    }
    this.transactionFault?.("before_audit_append");
    await this.appendAuditOnceUnlocked(journal.auditEvent);
  }

  async transaction(
    operationId: string,
    writes: readonly TransactionWrite[],
    auditEvent: AuditEvent,
  ): Promise<void> {
    if (!operationId) throw new Error("OPERATION_ID_REQUIRED");
    await this.withLock(transactionLock, async () => {
      await this.assertNoPendingTransactions();
      const validatedAudit = AuditEventSchema.parse(auditEvent);
      if (validatedAudit.id !== operationId) throw new Error("AUDIT_ID_MISMATCH");
      const transactionWrites = await Promise.all(writes.map(async ({ path, content, role }) => ({
        path,
        content,
        role: role ?? (path === ".agent-team/workflow-state.yaml" ? "state" as const : "evidence" as const),
        beforeDigest: await this.fileDigest(path),
      })));
      const journal: TransactionJournal = {
        version: 1,
        operationId,
        writes: transactionWrites,
        auditEvent: validatedAudit,
      };
      const journalDigest = this.journalDigest(journal);
      const receipt = await this.readReceipt(operationId);
      if (receipt) {
        if (receipt.digest !== journalDigest) throw new ProjectStoreError("OPERATION_ID_CONFLICT");
        return;
      }
      const relativeJournal = this.journalPath(operationId);
      this.transactionFault?.("before_journal_commit");
      await atomicWrite(this.root, targetPath(this.root, relativeJournal), JSON.stringify(journal));
      await this.applyJournal(journal);
      await atomicWrite(this.root, targetPath(this.root, this.receiptPath(operationId)), JSON.stringify({
        operationId,
        digest: journalDigest,
      } satisfies TransactionReceipt));
      await rm(targetPath(this.root, relativeJournal));
    });
  }

  async inspectTransactions(): Promise<string[]> {
    const operations: string[] = [];
    for (const file of await this.pendingTransactionFiles()) {
      const raw = JSON.parse((await this.readContainedFile(`.agent-team/transactions/${file}`))!);
      operations.push(this.validateJournal(raw, file).operationId);
    }
    return operations;
  }

  async repairTransactions(): Promise<string[]> {
    return this.withLock(transactionLock, async () => {
      const repaired: string[] = [];
      for (const file of await this.pendingTransactionFiles()) {
        const path = `.agent-team/transactions/${file}`;
        let raw: unknown;
        try {
          raw = JSON.parse((await this.readContainedFile(path))!);
        } catch (error) {
          if (error instanceof ProjectStoreError) throw error;
          throw new ProjectStoreError("TRANSACTION_JOURNAL_INVALID");
        }
        const journal = this.validateJournal(raw, file);
        const journalDigest = this.journalDigest(journal);
        const receipt = await this.readReceipt(journal.operationId);
        if (receipt && receipt.digest !== journalDigest) throw new ProjectStoreError("OPERATION_ID_CONFLICT");
        await this.applyJournal(journal);
        if (!receipt) await atomicWrite(this.root, targetPath(this.root, this.receiptPath(journal.operationId)), JSON.stringify({
          operationId: journal.operationId,
          digest: journalDigest,
        } satisfies TransactionReceipt));
        await rm(targetPath(this.root, path));
        repaired.push(journal.operationId);
      }
      return repaired;
    });
  }

  async readYaml<T>(relativePath: string, schema: Schema<T>): Promise<T> {
    const target = targetPath(this.root, relativePath);
    requireInside(await realpath(this.root), await realpath(target));
    return schema.parse(parse(await readFile(target, "utf8")));
  }

  async writeYamlAtomic(relativePath: string, value: unknown): Promise<void> {
    await this.withLock(transactionLock, async () => {
      await this.assertNoPendingTransactions();
      await atomicWrite(this.root, targetPath(this.root, relativePath), stringify(value));
    });
  }

  async writeTextAtomic(relativePath: string, content: string): Promise<void> {
    await this.withLock(transactionLock, async () => {
      await this.assertNoPendingTransactions();
      await atomicWrite(this.root, targetPath(this.root, relativePath), content);
    });
  }

  async withLock<T>(relativeLockPath: string, callback: () => Promise<T> | T): Promise<T> {
    const lockPath = targetPath(this.root, relativeLockPath);
    await prepareParent(this.root, lockPath);
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ProjectStoreError("STATE_LOCKED");
      }
      throw error;
    }
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

  async inspectLock(relativeLockPath: string): Promise<LockInspection> {
    if (!(GENERATED_LOCK_PATHS as readonly string[]).includes(relativeLockPath)) {
      throw new ProjectStoreError("LOCK_PATH_NOT_GENERATED");
    }
    const lockPath = targetPath(this.root, relativeLockPath);
    try {
      await lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: relativeLockPath, status: "missing" };
      }
      throw error;
    }
    return {
      path: relativeLockPath,
      status: await abandonedLocalLock(lockPath) ? "abandoned" : "locked",
    };
  }

  async repairLock(
    relativeLockPath: string,
    options: { confirmedQuiescent: boolean },
  ): Promise<boolean> {
    if (!options.confirmedQuiescent) {
      throw new ProjectStoreError("QUIESCENCE_CONFIRMATION_REQUIRED");
    }
    const inspection = await this.inspectLock(relativeLockPath);
    if (inspection.status === "missing") return false;
    if (inspection.status !== "abandoned"
      || !await abandonedLocalLock(targetPath(this.root, relativeLockPath))) {
      throw new ProjectStoreError("STATE_LOCKED");
    }
    // Administrative precondition: the caller confirmed all framework processes are quiescent.
    await rm(targetPath(this.root, relativeLockPath));
    return true;
  }

  readWorkflowState(): Promise<WorkflowState> {
    return this.readYaml(".agent-team/workflow-state.yaml", WorkflowStateSchema);
  }

  async updateWorkflowState(
    expectedVersion: number,
    reducer: (state: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    return this.withLock(transactionLock, async () => {
      await this.assertNoPendingTransactions();
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
      await atomicWrite(
        this.root,
        targetPath(this.root, ".agent-team/workflow-state.yaml"),
        stringify(validated),
      );
      return validated;
      });
    });
  }

  private async appendAuditUnlocked(event: Record<string, unknown>): Promise<void> {
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

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    await this.withLock(transactionLock, async () => {
      await this.assertNoPendingTransactions();
      await this.appendAuditUnlocked(event);
    });
  }

  private async appendAuditOnceUnlocked(event: Record<string, unknown> & { id: string }): Promise<void> {
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
      if (!exists) await this.appendAuditUnlocked(event);
    });
  }

  async appendAuditOnce(event: Record<string, unknown> & { id: string }): Promise<void> {
    await this.withLock(transactionLock, async () => {
      await this.assertNoPendingTransactions();
      await this.appendAuditOnceUnlocked(event);
    });
  }
}
