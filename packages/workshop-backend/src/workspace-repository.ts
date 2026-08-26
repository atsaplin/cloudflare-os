import { Workspace, WorkspaceFileSystem, type FileInfo } from "@cloudflare/shell";
import { createGit, type GitLogEntry, type GitStatusEntry } from "@cloudflare/shell/git";
import {
  WORKSPACE_INDEX_PATH,
  createEmptyWorkspaceIndex,
  createWorkspaceNode,
  deleteWorkspaceNode,
  getWorkspaceNode,
  listWorkspaceChildren,
  moveWorkspaceNode,
  parseWorkspaceIndex,
  resolveWorkspacePath,
  serializeWorkspaceIndex,
  updateWorkspaceFileMetadata,
  validateWorkspaceTree,
  type WorkspaceIndexV1,
  type WorkspaceNode,
  type WorkspaceTreeEntryKind,
} from "./workspace-manifest";

const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const gitOidPattern = /^[0-9a-f]{40}$/;
const maximumChanges = 1_000;
const maximumInlineBytes = 10 * 1024 * 1024;
const operationTrailerLabel = "Workspace-Operation:";
const digestTrailerLabel = "Workspace-Request-Digest:";

/** Identity recorded for a workspace mutation. */
export interface WorkspaceActor {
  id: string;
  name: string;
}

/** The accepted workspace revision and its stable root identity. */
export interface WorkspaceRevision {
  head: string;
  rootId: string;
}

/** A stable node or a node created earlier in the same mutation batch. */
export type WorkspaceNodeReference = { nodeId: string } | { clientId: string };

/** One accepted workspace filesystem change. */
export type WorkspaceMutation =
  | {
      kind: "createFolder";
      clientId: string;
      parent: WorkspaceNodeReference;
      name: string;
    }
  | {
      kind: "createFile";
      clientId: string;
      parent: WorkspaceNodeReference;
      name: string;
      content: Uint8Array;
      mediaType?: string;
    }
  | {
      kind: "replaceFile";
      nodeId: string;
      content: Uint8Array;
      mediaType?: string;
    }
  | {
      kind: "move";
      nodeId: string;
      parent: WorkspaceNodeReference;
      name: string;
    }
  | {
      kind: "delete";
      nodeId: string;
      recursive?: boolean;
    };

/** A compare-and-swap mutation of the accepted workspace tree. */
export interface WorkspaceMutationRequest {
  operationId: string;
  expectedHead: string;
  actor: WorkspaceActor;
  timestamp: string;
  message: string;
  changes: WorkspaceMutation[];
}

/** The accepted result of one idempotent workspace mutation. */
export interface WorkspaceMutationResult extends WorkspaceRevision {
  operationId: string;
  created: Record<string, string>;
}

export type WorkspaceRepositoryFailurePoint = "afterWorktree" | "afterCommit";

export interface WorkspaceRepositoryOptions {
  state: DurableObjectState;
  bucket: R2Bucket;
  workspaceId: string;
  injectFailure?: (point: WorkspaceRepositoryFailurePoint) => void | Promise<void>;
}

interface OperationRow {
  [key: string]: string | null;
  operation_id: string;
  request_digest: string;
  expected_head: string;
  status: string;
  result_head: string | null;
  created_json: string;
}

/** A mutation lost a compare-and-swap race with a newer accepted revision. */
export class WorkspaceRepositoryConflictError extends Error {
  constructor(readonly expectedHead: string, readonly currentHead: string) {
    super(`Workspace changed from ${expectedHead} to ${currentHead}.`);
    this.name = "WorkspaceRepositoryConflictError";
  }
}

function requireActor(actor: WorkspaceActor): void {
  if (!actor.id || new TextEncoder().encode(actor.id).byteLength > 256) {
    throw new Error("Workspace actor IDs must contain 1 to 256 UTF-8 bytes.");
  }
  if (!actor.name || new TextEncoder().encode(actor.name).byteLength > 256) {
    throw new Error("Workspace actor names must contain 1 to 256 UTF-8 bytes.");
  }
}

function requireTimestamp(timestamp: string): void {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new Error("Workspace mutation timestamps must be canonical UTC ISO strings.");
  }
}

function requireRequest(request: WorkspaceMutationRequest): void {
  if (!operationIdPattern.test(request.operationId)) {
    throw new Error("Workspace operation IDs must be lowercase UUID v4 values.");
  }
  if (!gitOidPattern.test(request.expectedHead)) {
    throw new Error("Expected workspace heads must be Git object IDs.");
  }
  requireActor(request.actor);
  requireTimestamp(request.timestamp);
  if (!request.message.trim() || request.message.length > 1_000) {
    throw new Error("Workspace commit messages must contain 1 to 1000 characters.");
  }
  if (request.message.includes(operationTrailerLabel) ||
      request.message.includes(digestTrailerLabel)) {
    throw new Error("Workspace commit messages cannot contain reserved recovery metadata.");
  }
  if (request.changes.length < 1 || request.changes.length > maximumChanges) {
    throw new Error(`Workspace mutations must contain 1 to ${maximumChanges} changes.`);
  }
  const clientIds = new Set<string>();
  for (const change of request.changes) {
    if (change.kind === "createFile" || change.kind === "createFolder") {
      if (!change.clientId || clientIds.has(change.clientId)) {
        throw new Error("Created workspace nodes require unique non-empty client IDs.");
      }
      clientIds.add(change.clientId);
    }
    if ((change.kind === "createFile" || change.kind === "replaceFile") &&
        change.content.byteLength > maximumInlineBytes) {
      throw new Error(`Inline workspace content cannot exceed ${maximumInlineBytes} bytes.`);
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function digestRequest(request: WorkspaceMutationRequest): Promise<string> {
  const changes: unknown[] = [];
  for (const change of request.changes) {
    if (change.kind === "createFolder") changes.push({
      kind: change.kind,
      clientId: change.clientId,
      parent: "nodeId" in change.parent
        ? { nodeId: change.parent.nodeId }
        : { clientId: change.parent.clientId },
      name: change.name,
    });
    else if (change.kind === "createFile") changes.push({
      kind: change.kind,
      clientId: change.clientId,
      parent: "nodeId" in change.parent
        ? { nodeId: change.parent.nodeId }
        : { clientId: change.parent.clientId },
      name: change.name,
      mediaType: change.mediaType ?? null,
      contentSha256: await digestBytes(change.content),
    });
    else if (change.kind === "replaceFile") changes.push({
      kind: change.kind,
      nodeId: change.nodeId,
      mediaType: change.mediaType ?? null,
      contentSha256: await digestBytes(change.content),
    });
    else if (change.kind === "move") changes.push({
      kind: change.kind,
      nodeId: change.nodeId,
      parent: "nodeId" in change.parent
        ? { nodeId: change.parent.nodeId }
        : { clientId: change.parent.clientId },
      name: change.name,
    });
    else changes.push({
      kind: change.kind,
      nodeId: change.nodeId,
      recursive: change.recursive ?? false,
    });
  }
  const canonical = JSON.stringify({
    operationId: request.operationId,
    expectedHead: request.expectedHead,
    actor: { id: request.actor.id, name: request.actor.name },
    timestamp: request.timestamp,
    message: request.message,
    changes,
  });
  return digestBytes(new TextEncoder().encode(canonical));
}

function parseCreatedMap(serialized: string): Record<string, string> {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace operation created-node metadata is malformed.");
  }
  const created: Record<string, string> = {};
  for (const [clientId, nodeId] of Object.entries(value)) {
    if (typeof nodeId !== "string" || !operationIdPattern.test(nodeId)) {
      throw new Error("Workspace operation created-node metadata is malformed.");
    }
    created[clientId] = nodeId;
  }
  return created;
}

function resolveReference(reference: WorkspaceNodeReference, created: Record<string, string>): string {
  if ("nodeId" in reference) return reference.nodeId;
  const nodeId = created[reference.clientId];
  if (!nodeId) throw new Error(`Unknown workspace mutation client ID: ${reference.clientId}`);
  return nodeId;
}

function recoveryTrailers(operationId: string, requestDigest: string): string {
  return `${operationTrailerLabel} ${operationId}\n${digestTrailerLabel} ${requestDigest}`;
}

/**
 * Private filesystem and versioning facade for one Overseer Durable Object.
 *
 * Every public method serializes through one workspace-wide queue because Shell has one mutable
 * worktree and Git index. Callers never receive the underlying Workspace or Git objects.
 */
export class WorkspaceRepository {
  readonly #state: DurableObjectState;
  readonly #workspace: Workspace;
  readonly #git: ReturnType<typeof createGit>;
  readonly #injectFailure?: WorkspaceRepositoryOptions["injectFailure"];
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceRepositoryOptions) {
    this.#state = options.state;
    this.#injectFailure = options.injectFailure;
    this.#workspace = new Workspace({
      sql: options.state.storage.sql,
      namespace: "workspace_files",
      r2: options.bucket,
      r2Prefix: `workspaces/${options.workspaceId}`,
      name: () => options.workspaceId,
    });
    this.#git = createGit(new WorkspaceFileSystem(this.#workspace));
  }

  #ensureOperationTable(): void {
    this.#state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_file_operations (
        operation_id TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        expected_head TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'failed')),
        result_head TEXT,
        created_json TEXT NOT NULL
      )
    `);
  }

  #withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run, run);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #initialize(actor: WorkspaceActor): Promise<WorkspaceRevision> {
    requireActor(actor);
    this.#ensureOperationTable();
    await this.#git.init({ defaultBranch: "main" });
    const stored = await this.#workspace.readFileBytes(WORKSPACE_INDEX_PATH);
    const index = stored === null ? createEmptyWorkspaceIndex({
      actorId: actor.id,
      now: new Date().toISOString(),
    }) : parseWorkspaceIndex(stored);

    if (stored !== null) {
      const branches = await this.#git.branch({ list: true });
      if ("branches" in branches && Array.isArray(branches.branches) &&
          branches.branches.includes("main")) {
        await this.#materializeFolders(index);
        return { head: await this.#getHead(), rootId: index.rootId };
      }
    }

    await this.#workspace.writeFileBytes(WORKSPACE_INDEX_PATH, serializeWorkspaceIndex(index));
    const status = await this.#git.status();
    await this.#stageStatus(status);
    await this.#git.commit({
      message: "Initialize workspace",
      author: { name: actor.name, email: "workspace@cloudflare-os.invalid" },
    });

    const head = await this.#getHead();
    return { head, rootId: index.rootId };
  }

  /** Initializes the accepted filesystem exactly once. */
  initialize(actor: WorkspaceActor): Promise<WorkspaceRevision> {
    return this.#withLock(async () => {
      await this.#initialize(actor);
      await this.#recoverPreparedOperations();
      const index = await this.#readIndex();
      return { head: await this.#getHead(), rootId: index.rootId };
    });
  }

  async #readIndex(): Promise<WorkspaceIndexV1> {
    const bytes = await this.#workspace.readFileBytes(WORKSPACE_INDEX_PATH);
    if (bytes === null) throw new Error("Workspace filesystem is not initialized.");
    return parseWorkspaceIndex(bytes);
  }

  async #getHead(): Promise<string> {
    const [head] = await this.#git.log({ depth: 1, ref: "main" });
    if (!head) throw new Error("Workspace filesystem has no accepted revision.");
    return head.oid;
  }

  /** Resolves one stable identity at the current accepted revision. */
  getNode(nodeId: string): Promise<WorkspaceNode | undefined> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      return getWorkspaceNode(await this.#readIndex(), nodeId);
    });
  }

  /** Lists the current direct children of one stable folder identity. */
  list(folderId: string): Promise<WorkspaceNode[]> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      return listWorkspaceChildren(await this.#readIndex(), folderId);
    });
  }

  /** Reads the current bytes for one stable file identity. */
  readFile(nodeId: string): Promise<Uint8Array> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      const index = await this.#readIndex();
      const node = getWorkspaceNode(index, nodeId);
      if (!node) throw new Error(`Workspace node ${nodeId} does not exist.`);
      if (node.kind !== "file") throw new Error(`Workspace node ${nodeId} is not a file.`);
      const content = await this.#workspace.readFileBytes(node.path);
      if (content === null) throw new Error(`Workspace file ${nodeId} has no content.`);
      return content;
    });
  }

  /** Returns accepted workspace commits from newest to oldest. */
  getHistory(limit: number): Promise<GitLogEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Workspace history limit must be an integer from 1 to 100.");
    }
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      return this.#git.log({ depth: limit, ref: "main" });
    });
  }

  #getOperation(operationId: string): OperationRow | undefined {
    return [...this.#state.storage.sql.exec<OperationRow>(`
      SELECT operation_id, request_digest, expected_head, status, result_head, created_json
      FROM workspace_file_operations
      WHERE operation_id = ?
    `, operationId)][0];
  }

  #getPreparedOperations(): OperationRow[] {
    return [...this.#state.storage.sql.exec<OperationRow>(`
      SELECT operation_id, request_digest, expected_head, status, result_head, created_json
      FROM workspace_file_operations
      WHERE status = 'prepared'
      ORDER BY rowid
    `)];
  }

  #insertPrepared(
    request: WorkspaceMutationRequest,
    digest: string,
    created: Record<string, string>,
  ): void {
    this.#state.storage.sql.exec(`
      INSERT INTO workspace_file_operations (
        operation_id, request_digest, expected_head, status, result_head, created_json
      ) VALUES (?, ?, ?, 'prepared', NULL, ?)
    `, request.operationId, digest, request.expectedHead, JSON.stringify(created));
  }

  #markCommitted(operationId: string, head: string): void {
    this.#state.storage.sql.exec(`
      UPDATE workspace_file_operations
      SET status = 'committed', result_head = ?
      WHERE operation_id = ?
    `, head, operationId);
  }

  #markFailed(operationId: string): void {
    this.#state.storage.sql.exec(`
      UPDATE workspace_file_operations
      SET status = 'failed', result_head = NULL
      WHERE operation_id = ?
    `, operationId);
  }

  #markPrepared(operationId: string): void {
    this.#state.storage.sql.exec(`
      UPDATE workspace_file_operations
      SET status = 'prepared', result_head = NULL
      WHERE operation_id = ?
    `, operationId);
  }

  #resultFromRow(row: OperationRow, rootId: string): WorkspaceMutationResult {
    if (row.status !== "committed" || row.result_head === null) {
      throw new Error(`Workspace operation ${row.operation_id} is not committed.`);
    }
    return {
      operationId: row.operation_id,
      head: row.result_head,
      rootId,
      created: parseCreatedMap(row.created_json),
    };
  }

  async #recoverPrepared(row: OperationRow): Promise<void> {
    const currentHead = await this.#getHead();
    if (currentHead !== row.expected_head) {
      const [head] = await this.#git.log({ depth: 1, ref: currentHead });
      const trailers = recoveryTrailers(row.operation_id, row.request_digest);
      if (head?.parent.length === 1 && head.parent[0] === row.expected_head &&
          head.message.endsWith(`${trailers}\n`)) {
        this.#markCommitted(row.operation_id, currentHead);
        return;
      }
      throw new Error(
        `Prepared workspace operation ${row.operation_id} cannot recover from head ${currentHead}.`,
      );
    }

    await this.#restoreAcceptedWorktree();
    this.#markFailed(row.operation_id);
  }

  async #recoverPreparedOperations(): Promise<void> {
    this.#ensureOperationTable();
    for (const prepared of this.#getPreparedOperations()) await this.#recoverPrepared(prepared);
  }

  async #restoreAcceptedWorktree(): Promise<void> {
    for (const entry of await this.#workspace.readDir()) {
      if (entry.name !== ".git") {
        await this.#workspace.rm(entry.path, { recursive: true, force: true });
      }
    }
    await this.#git.checkout({ ref: "main", force: true });
    const index = await this.#readIndex();
    await this.#materializeFolders(index);
    await this.#validateWorktree(index);
  }

  async #materializeFolders(index: WorkspaceIndexV1): Promise<void> {
    const folders = Object.entries(index.nodes)
      .filter(([id, node]) => id !== index.rootId && node.kind === "folder")
      .map(([id]) => resolveWorkspacePath(index, id))
      .toSorted((left, right) =>
        left.split("/").length - right.split("/").length || left.localeCompare(right));
    for (const path of folders) await this.#workspace.mkdir(path, { recursive: true });
  }

  async #stageStatus(status: GitStatusEntry[]): Promise<void> {
    for (const entry of status) {
      if (entry.workdir === 0) await this.#git.rm({ filepath: entry.filepath });
      else await this.#git.add({ filepath: entry.filepath });
    }
  }

  async #collectTree(
    directory = "",
    tree = new Map<string, WorkspaceTreeEntryKind>(),
  ): Promise<Map<string, WorkspaceTreeEntryKind>> {
    const entries: FileInfo[] = await this.#workspace.readDir(directory);
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (path === ".git" || path.startsWith(".git/")) continue;
      const kind: WorkspaceTreeEntryKind = entry.type === "directory"
        ? "folder"
        : entry.type === "symlink" ? "symlink" : "file";
      tree.set(path, kind);
      if (entry.type === "directory") await this.#collectTree(path, tree);
    }
    return tree;
  }

  async #validateWorktree(index: WorkspaceIndexV1): Promise<void> {
    validateWorkspaceTree(index, await this.#collectTree());
  }

  #createdIds(request: WorkspaceMutationRequest): Record<string, string> {
    const created: Record<string, string> = {};
    for (const change of request.changes) {
      if (change.kind === "createFile" || change.kind === "createFolder") {
        created[change.clientId] = crypto.randomUUID();
      }
    }
    return created;
  }

  async #applyChanges(
    request: WorkspaceMutationRequest,
    created: Record<string, string>,
  ): Promise<WorkspaceIndexV1> {
    let index = await this.#readIndex();
    const context = { actorId: request.actor.id, now: request.timestamp };

    for (const change of request.changes) {
      if (change.kind === "createFolder") {
        const result = createWorkspaceNode(index, {
          kind: "folder",
          parentId: resolveReference(change.parent, created),
          name: change.name,
        }, { ...context, createId: () => created[change.clientId] });
        index = result.index;
        await this.#workspace.mkdir(result.node.path);
      } else if (change.kind === "createFile") {
        const result = createWorkspaceNode(index, {
          kind: "file",
          parentId: resolveReference(change.parent, created),
          name: change.name,
          ...(change.mediaType === undefined ? {} : { mediaType: change.mediaType }),
        }, { ...context, createId: () => created[change.clientId] });
        index = result.index;
        await this.#workspace.writeFileBytes(
          result.node.path,
          change.content,
          change.mediaType,
        );
      } else if (change.kind === "replaceFile") {
        const node = getWorkspaceNode(index, change.nodeId);
        if (!node) throw new Error(`Workspace node ${change.nodeId} does not exist.`);
        if (node.kind !== "file") throw new Error(`Workspace node ${change.nodeId} is not a file.`);
        await this.#workspace.writeFileBytes(node.path, change.content, change.mediaType);
        index = updateWorkspaceFileMetadata(index, change.nodeId, change.mediaType, context);
      } else if (change.kind === "move") {
        const oldPath = resolveWorkspacePath(index, change.nodeId);
        const next = moveWorkspaceNode(
          index,
          change.nodeId,
          resolveReference(change.parent, created),
          change.name,
          context,
        );
        const newPath = resolveWorkspacePath(next, change.nodeId);
        await this.#workspace.mv(oldPath, newPath);
        index = next;
      } else {
        const path = resolveWorkspacePath(index, change.nodeId);
        const deleted = deleteWorkspaceNode(index, change.nodeId, change.recursive ?? false);
        await this.#workspace.rm(path, { recursive: change.recursive ?? false });
        index = deleted.index;
      }
    }

    await this.#workspace.writeFileBytes(WORKSPACE_INDEX_PATH, serializeWorkspaceIndex(index));
    await this.#validateWorktree(index);
    return index;
  }

  async #apply(request: WorkspaceMutationRequest, digest: string): Promise<WorkspaceMutationResult> {
    const initial = await this.#initialize(request.actor);
    await this.#recoverPreparedOperations();

    const row = this.#getOperation(request.operationId);
    if (row && row.request_digest !== digest) {
      throw new Error(`Workspace operation ${request.operationId} was reused with different input.`);
    }
    if (row?.status === "committed") return this.#resultFromRow(row, initial.rootId);

    const currentHead = await this.#getHead();
    if (currentHead !== request.expectedHead) {
      throw new WorkspaceRepositoryConflictError(request.expectedHead, currentHead);
    }

    const created = row ? parseCreatedMap(row.created_json) : this.#createdIds(request);
    if (row) this.#markPrepared(request.operationId);
    else this.#insertPrepared(request, digest, created);
    const index = await this.#applyChanges(request, created);
    await this.#injectFailure?.("afterWorktree");

    const status = await this.#git.status();
    if (status.length === 0) {
      this.#markCommitted(request.operationId, currentHead);
      return {
        operationId: request.operationId,
        head: currentHead,
        rootId: index.rootId,
        created,
      };
    }
    await this.#stageStatus(status);
    const committed = await this.#git.commit({
      message: `${request.message.trim()}\n\n${recoveryTrailers(request.operationId, digest)}`,
      author: { name: request.actor.name, email: "workspace@cloudflare-os.invalid" },
    });
    await this.#injectFailure?.("afterCommit");
    this.#markCommitted(request.operationId, committed.oid);
    return {
      operationId: request.operationId,
      head: committed.oid,
      rootId: index.rootId,
      created,
    };
  }

  /** Applies one idempotent compare-and-swap mutation to accepted workspace state. */
  async apply(request: WorkspaceMutationRequest): Promise<WorkspaceMutationResult> {
    requireRequest(request);
    const digest = await digestRequest(request);
    return this.#withLock(() => this.#apply(request, digest));
  }
}
