import {
  MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES,
  MAXIMUM_WORKSPACE_TOTAL_BYTES,
  WORKSPACE_FILE_ERROR_CODES,
  type CommitInfo,
} from "@gadgets/workshop-shared/api";
import {
  createWorkspaceNode,
  deleteWorkspaceNode,
  getWorkspaceNode,
  listWorkspaceChildren,
  moveWorkspaceNode,
  parseWorkspaceIndex,
  resolveWorkspacePath,
  serializeWorkspaceIndex,
  updateWorkspaceFileMetadata,
  WORKSPACE_INDEX_PATH,
  type WorkspaceIndexV1,
} from "./workspace-manifest";
import {
  digestRequest,
  digestStagedRequest,
  digestBytes,
  expectedError,
  isWorkspaceUuid,
  recoveryTrailers,
  requireActor,
  requireRequest,
  requireStagedRequest,
  requireTimestamp,
  type StagedWorkspaceMutationRequest,
  type WorkspaceActor,
  type WorkspaceMutation,
  type WorkspaceMutationRequest,
  type WorkspaceMutationResult,
  type WorkspaceNodeReference,
  type WorkspaceRepositoryNode,
  type WorkspaceRevision,
  type WorkspaceUpload,
  type WorkspaceUploadRequest,
  WorkspaceRepositoryConflictError,
  WorkspaceRepositoryExpectedError,
} from "./workspace-files";
import type {
  WorkspaceArtifactCanonical,
  WorkspaceArtifactLifecycle,
  WorkspaceArtifactMutation,
  WorkspaceArtifactMutationOperation,
  WorkspaceArtifactReader,
} from "./workspace-artifacts";
import { WorkspaceUploadStore as DurableWorkspaceUploadStore } from "./workspace-upload-store";

const maximumHistoryDepth = 100;
const operationForkEpoch = 0;
const operationForkPrefix = "workspace-file-operation:";

interface OperationRow {
  [key: string]: string | null;
  operation_id: string;
  request_digest: string;
  expected_head: string;
  status: string;
  result_head: string | null;
  result_root_id: string | null;
  created_json: string;
  staged_head: string | null;
  stale_current_head: string | null;
  actor_name: string;
  operation_timestamp: string;
}

interface WorkspaceReadRevision {
  repositoryName: string;
  head: string;
  baselineHead: string;
  index: WorkspaceIndexV1;
}

interface PlannedChatMutation {
  result: Extract<ChatWorkspaceOperationResult, { changed: boolean }>;
  mutation?: WorkspaceArtifactMutation;
}

/** The lifecycle methods required by the Artifacts-backed file facade. */
export type ArtifactsWorkspaceFileLifecycle = Pick<WorkspaceArtifactLifecycle,
  | "ensureCanonical"
  | "getCanonical"
  | "getForkStatus"
  | "stageChatMutation"
  | "acceptChatFork"
  | "completeAcceptedChatFork"
  | "discardChatFork"
  | "readCommitLog"
  | "getHistory"
  | "readChatCommitLog"
  | "deleteWorkspaceRepositories"
>;

/** The upload-store methods required to stage and resolve file content. */
export type ArtifactsWorkspaceFileUploadStore = Pick<DurableWorkspaceUploadStore,
  | "stageUpload"
  | "getNextUploadExpiry"
  | "cleanupExpiredUploads"
  | "consumeUpload"
  | "deleteAllUploads"
>;

export interface ArtifactsWorkspaceFilesOptions {
  state: DurableObjectState;
  lifecycle: ArtifactsWorkspaceFileLifecycle;
  reader: WorkspaceArtifactReader;
  uploadStore: ArtifactsWorkspaceFileUploadStore;
}

export interface CreateArtifactsWorkspaceFilesOptions {
  state: DurableObjectState;
  bucket: R2Bucket;
  workspaceId: string;
  lifecycle: WorkspaceArtifactLifecycle;
  reader: WorkspaceArtifactReader;
}

export interface WorkspaceFileRepository {
  initialize(actor: WorkspaceActor): Promise<WorkspaceRevision>;
  getRevision(): Promise<WorkspaceRevision>;
  list(folderId: string): Promise<WorkspaceRepositoryNode[]>;
  readFileStream(nodeId: string): Promise<ReadableStream<Uint8Array>>;
  getHistory(limit?: number): Promise<CommitInfo[]>;
  stageUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<WorkspaceUpload>;
  getNextUploadExpiry(): number | undefined;
  cleanupExpiredUploads(now?: number): Promise<number>;
  deleteAllWorkspaceFiles(): Promise<void>;
  applyStaged(request: StagedWorkspaceMutationRequest): Promise<WorkspaceMutationResult>;
  hasChatFileChanges(chatId: string, epoch: number): Promise<boolean>;
  runChatOperation(request: ChatWorkspaceOperationRequest): Promise<ChatWorkspaceOperationResult>;
}

export type ChatWorkspaceOperation =
  | { kind: "list"; path: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string; mediaType?: string }
  | { kind: "mkdir"; path: string }
  | { kind: "move"; path: string; destination: string }
  | { kind: "delete"; path: string; recursive?: boolean };

export interface ChatWorkspaceOperationRequest {
  chatId: string;
  epoch: number;
  operationId: string;
  actor: WorkspaceActor;
  timestamp: string;
  operation: ChatWorkspaceOperation;
}

export type ChatWorkspaceOperationResult =
  | {
      kind: "list";
      head: string;
      path: string;
      entries: WorkspaceRepositoryNode[];
    }
  | {
      kind: "read";
      head: string;
      path: string;
      node: WorkspaceRepositoryNode;
      content: string;
    }
  | {
      kind: "write" | "mkdir" | "move" | "delete";
      head: string;
      path: string;
      changed: boolean;
      nodeId?: string;
      node?: WorkspaceRepositoryNode;
    };

export type ArtifactsWorkspaceFilesFactory = (
  options: CreateArtifactsWorkspaceFilesOptions,
) => WorkspaceFileRepository;

let workspaceFilesFactory: ArtifactsWorkspaceFilesFactory = options =>
  new ArtifactsWorkspaceFiles({
    state: options.state,
    lifecycle: options.lifecycle,
    reader: options.reader,
    uploadStore: new DurableWorkspaceUploadStore({
      state: options.state,
      bucket: options.bucket,
      workspaceId: options.workspaceId,
    }),
  });

export function createArtifactsWorkspaceFiles(
  options: CreateArtifactsWorkspaceFilesOptions,
): WorkspaceFileRepository {
  return workspaceFilesFactory(options);
}

export function setArtifactsWorkspaceFilesFactoryForTest(
  factory: ArtifactsWorkspaceFilesFactory,
): void {
  workspaceFilesFactory = factory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationForkId(operationId: string): string {
  return `${operationForkPrefix}${operationId}`;
}

function parseCreatedMap(serialized: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Workspace operation created-node metadata is malformed.", { cause: error });
  }
  if (!isRecord(value)) throw new Error("Workspace operation created-node metadata is malformed.");
  const created: Record<string, string> = {};
  for (const [clientId, nodeId] of Object.entries(value)) {
    if (!isWorkspaceUuid(nodeId)) {
      throw new Error("Workspace operation created-node metadata is malformed.");
    }
    created[clientId] = nodeId;
  }
  return created;
}

function resolveReference(
  reference: WorkspaceNodeReference,
  created: Record<string, string>,
): string {
  if ("nodeId" in reference) return reference.nodeId;
  const nodeId = created[reference.clientId];
  if (!nodeId) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      `Unknown workspace mutation client ID: ${reference.clientId}`,
    );
  }
  return nodeId;
}

function resolveMutationInput<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof WorkspaceRepositoryExpectedError) throw error;
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      error instanceof Error ? error.message : "Workspace mutation input is invalid.",
    );
  }
}

function totalFileBytes(index: WorkspaceIndexV1): number {
  let total = 0;
  for (const node of Object.values(index.nodes)) {
    if (node.kind === "file") total += node.size;
  }
  return total;
}

function hasFileDescendant(index: WorkspaceIndexV1, nodeId: string): boolean {
  return Object.values(index.nodes).some(node => {
    if (node.kind !== "file") return false;
    let parentId = node.parentId;
    while (parentId !== null) {
      if (parentId === nodeId) return true;
      parentId = index.nodes[parentId]?.parentId ?? null;
    }
    return false;
  });
}

function requireWorkspaceQuota(index: WorkspaceIndexV1): void {
  if (totalFileBytes(index) > MAXIMUM_WORKSPACE_TOTAL_BYTES) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.workspaceQuotaExceeded,
      `Workspace storage cannot exceed ${MAXIMUM_WORKSPACE_TOTAL_BYTES} bytes.`,
    );
  }
}

function byteStream(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(content);
      controller.close();
    },
  });
}

function parseCommittedResult(row: OperationRow): WorkspaceMutationResult {
  if (row.status !== "committed" || row.result_head === null || row.result_root_id === null) {
    throw new Error(`Workspace operation ${row.operation_id} is not committed.`);
  }
  return {
    operationId: row.operation_id,
    head: row.result_head,
    rootId: row.result_root_id,
    created: parseCreatedMap(row.created_json),
  };
}

function createIds(request: WorkspaceMutationRequest | StagedWorkspaceMutationRequest): Record<string, string> {
  const created: Record<string, string> = {};
  for (const change of request.changes) {
    if (change.kind === "createFile" || change.kind === "createFolder") {
      created[change.clientId] = crypto.randomUUID();
    }
  }
  return created;
}

function requireChatOperationIdentity(request: ChatWorkspaceOperationRequest): void {
  if (!request.chatId || new TextEncoder().encode(request.chatId).byteLength > 256 ||
      !Number.isSafeInteger(request.epoch) || request.epoch < 0 || request.epoch > 1_000_000_000) {
    expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Chat workspace identity is invalid.");
  }
  if (!request.operationId ||
      new TextEncoder().encode(request.operationId).byteLength > 256 ||
      /\p{Cc}/u.test(request.operationId)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Chat workspace operation IDs must contain 1 to 256 printable UTF-8 bytes.",
    );
  }
  requireActor(request.actor);
  requireTimestamp(request.timestamp);
}

function normalizeChatPath(value: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || /\p{Cc}/u.test(value)) {
    expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace paths are invalid.");
  }
  if (value === "" || value === "/") return "";
  const path = value.startsWith("/") ? value.slice(1) : value;
  if (!path || path.endsWith("/") || path.includes("\\")) {
    expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace paths are invalid.");
  }
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace paths are invalid.");
  }
  return path;
}

function nodeAtPath(index: WorkspaceIndexV1, path: string): WorkspaceRepositoryNode | undefined {
  if (path === "") return getWorkspaceNode(index, index.rootId);
  for (const nodeId of Object.keys(index.nodes)) {
    const node = getWorkspaceNode(index, nodeId);
    if (node?.path === path) return node;
  }
  return undefined;
}

function requireNodeAtPath(index: WorkspaceIndexV1, path: string): WorkspaceRepositoryNode {
  const node = nodeAtPath(index, path);
  if (!node) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      `Workspace path ${JSON.stringify(path || "/")} does not exist.`,
    );
  }
  return node;
}

function splitWorkspacePath(path: string): { parentPath: string; name: string } {
  if (!path) {
    expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "The workspace root cannot be changed.");
  }
  const separator = path.lastIndexOf("/");
  return separator === -1
    ? { parentPath: "", name: path }
    : { parentPath: path.slice(0, separator), name: path.slice(separator + 1) };
}

async function digestChatOperation(request: ChatWorkspaceOperationRequest): Promise<string> {
  const operation = request.operation.kind === "write"
    ? {
        ...request.operation,
        content: undefined,
        contentSha256: await digestBytes(new TextEncoder().encode(request.operation.content)),
      }
    : request.operation;
  return digestBytes(new TextEncoder().encode(JSON.stringify({
    chatId: request.chatId,
    epoch: request.epoch,
    operationId: request.operationId,
    actorId: request.actor.id,
    operation,
  })));
}

function commitHasRecoveryTrailers(
  commit: CommitInfo,
  operationId: string,
  requestDigest: string,
): boolean {
  return commit.message.includes(recoveryTrailers(operationId, requestDigest));
}

function commitHasOperationId(commit: CommitInfo, operationId: string): boolean {
  return commit.message.split("\n").includes(`Workspace-Operation: ${operationId}`);
}

function workspaceUuidFromDigest(digest: string): string {
  const value = digest.slice(0, 32).split("");
  value[12] = "4";
  value[16] = ((Number.parseInt(value[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function commitsAfterBaseline(commits: CommitInfo[], baselineHead: string): CommitInfo[] {
  const baselineIndex = commits.findIndex(commit => commit.oid === baselineHead);
  return baselineIndex === -1 ? commits : commits.slice(0, baselineIndex);
}

export class ArtifactsWorkspaceFiles implements WorkspaceFileRepository {
  readonly #state: DurableObjectState;
  readonly #lifecycle: ArtifactsWorkspaceFileLifecycle;
  readonly #reader: WorkspaceArtifactReader;
  readonly #uploadStore: ArtifactsWorkspaceFileUploadStore;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ArtifactsWorkspaceFilesOptions) {
    this.#state = options.state;
    this.#lifecycle = options.lifecycle;
    this.#reader = options.reader;
    this.#uploadStore = options.uploadStore;
  }

  async #withLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release?.();
    }
  }

  #ensureOperationTable(): void {
    this.#state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_artifact_file_operations (
        operation_id TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        expected_head TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'stale')),
        result_head TEXT,
        result_root_id TEXT,
        created_json TEXT NOT NULL,
        staged_head TEXT,
        stale_current_head TEXT,
        actor_name TEXT NOT NULL,
        operation_timestamp TEXT NOT NULL
      )
    `);
  }

  #getOperation(operationId: string): OperationRow | undefined {
    return [...this.#state.storage.sql.exec<OperationRow>(`
      SELECT operation_id, request_digest, expected_head, status,
             result_head, result_root_id, created_json, staged_head, stale_current_head,
             actor_name, operation_timestamp
      FROM workspace_artifact_file_operations
      WHERE operation_id = ?
    `, operationId)][0];
  }

  #insertPrepared(
    request: WorkspaceMutationRequest | StagedWorkspaceMutationRequest,
    digest: string,
    created: Record<string, string>,
  ): void {
    this.#state.storage.sql.exec(`
      INSERT INTO workspace_artifact_file_operations (
        operation_id, request_digest, expected_head, status, result_head, result_root_id,
        created_json, staged_head, stale_current_head, actor_name, operation_timestamp
      ) VALUES (?, ?, ?, 'prepared', NULL, NULL, ?, NULL, NULL, ?, ?)
    `, request.operationId, digest, request.expectedHead, JSON.stringify(created),
    request.actor.name, request.timestamp);
  }

  #markStaged(operationId: string, head: string): void {
    this.#state.storage.sql.exec(`
      UPDATE workspace_artifact_file_operations
      SET staged_head = ?
      WHERE operation_id = ? AND status = 'prepared'
    `, head, operationId);
  }

  #markStale(operationId: string, currentHead: string): void {
    this.#state.storage.sql.exec(`
      UPDATE workspace_artifact_file_operations
      SET status = 'stale', stale_current_head = ?
      WHERE operation_id = ? AND status = 'prepared'
    `, currentHead, operationId);
  }

  #markCommitted(operationId: string, result: WorkspaceMutationResult): void {
    this.#state.storage.sql.exec(`
      UPDATE workspace_artifact_file_operations
      SET status = 'committed', result_head = ?, result_root_id = ?, created_json = ?
      WHERE operation_id = ? AND status = 'prepared'
    `, result.head, result.rootId, JSON.stringify(result.created), operationId);
    const row = this.#getOperation(operationId);
    if (!row || row.status !== "committed") {
      throw new Error(`Workspace operation ${operationId} did not persist its committed result.`);
    }
  }

  async #canonical(): Promise<WorkspaceArtifactCanonical> {
    const canonical = await this.#lifecycle.getCanonical();
    if (!canonical) throw new Error("Canonical workspace repository is not initialized.");
    return canonical;
  }

  async #readIndex(canonical: WorkspaceArtifactCanonical): Promise<WorkspaceIndexV1> {
    return parseWorkspaceIndex(await this.#reader.readFile(
      canonical.repositoryName,
      canonical.head,
      WORKSPACE_INDEX_PATH,
    ));
  }

  async #readChatRevision(chatId: string, epoch: number): Promise<WorkspaceReadRevision> {
    const fork = await this.#lifecycle.getForkStatus(chatId, epoch);
    if (fork !== undefined) {
      if (fork.state !== "open") {
        throw new Error(`Chat workspace fork ${chatId}/${epoch} is ${fork.state}.`);
      }
      return {
        repositoryName: fork.repositoryName,
        head: fork.latestHead,
        baselineHead: fork.baselineHead,
        index: parseWorkspaceIndex(await this.#reader.readFile(
          fork.repositoryName,
          fork.latestHead,
          WORKSPACE_INDEX_PATH,
        )),
      };
    }
    const canonical = await this.#canonical();
    return {
      repositoryName: canonical.repositoryName,
      head: canonical.head,
      baselineHead: canonical.head,
      index: await this.#readIndex(canonical),
    };
  }

  async #planChatMutation(
    request: ChatWorkspaceOperationRequest,
    revision: WorkspaceReadRevision,
    createdNodeId: string,
  ): Promise<PlannedChatMutation> {
    const operation = request.operation;
    if (operation.kind === "list" || operation.kind === "read") {
      throw new Error("Read-only workspace operations cannot be planned as mutations.");
    }
    const path = normalizeChatPath(operation.kind === "move"
      ? operation.destination
      : operation.path);
    const sourcePath = normalizeChatPath(operation.path);
    const existing = nodeAtPath(revision.index, sourcePath);
    let changes: WorkspaceMutation[];
    let nodeId: string | undefined;

    if (operation.kind === "mkdir") {
      if (existing !== undefined) {
        if (existing.kind !== "folder") {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            `Workspace path ${JSON.stringify(sourcePath)} is not a folder.`,
          );
        }
        return {
          result: {
            kind: "mkdir",
            head: revision.head,
            path: sourcePath,
            changed: false,
            nodeId: existing.id,
          },
        };
      }
      const target = splitWorkspacePath(sourcePath);
      const parent = requireNodeAtPath(revision.index, target.parentPath);
      if (parent.kind !== "folder") {
        expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace parent is not a folder.");
      }
      nodeId = createdNodeId;
      changes = [{
        kind: "createFolder",
        clientId: "target",
        parent: { nodeId: parent.id },
        name: target.name,
      }];
    } else if (operation.kind === "write") {
      const content = new TextEncoder().encode(operation.content);
      if (existing !== undefined) {
        if (existing.kind !== "file") {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            `Workspace path ${JSON.stringify(sourcePath)} is not a file.`,
          );
        }
        const mediaType = operation.mediaType ?? existing.mediaType;
        const current = await this.#reader.readFile(
          revision.repositoryName,
          revision.head,
          existing.path,
        );
        if (current.byteLength === content.byteLength &&
            current.every((byte, index) => byte === content[index]) &&
            mediaType === existing.mediaType) {
          return {
            result: {
              kind: "write",
              head: revision.head,
              path: sourcePath,
              changed: false,
              nodeId: existing.id,
            },
          };
        }
        nodeId = existing.id;
        changes = [{ kind: "replaceFile", nodeId: existing.id, content, mediaType }];
      } else {
        const target = splitWorkspacePath(sourcePath);
        const parent = requireNodeAtPath(revision.index, target.parentPath);
        if (parent.kind !== "folder") {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            "Workspace parent is not a folder.",
          );
        }
        nodeId = createdNodeId;
        changes = [{
          kind: "createFile",
          clientId: "target",
          parent: { nodeId: parent.id },
          name: target.name,
          content,
          ...(operation.mediaType === undefined ? {} : { mediaType: operation.mediaType }),
        }];
      }
    } else if (operation.kind === "move") {
      const node = requireNodeAtPath(revision.index, sourcePath);
      if (sourcePath === path) {
        return {
          result: {
            kind: "move",
            head: revision.head,
            path,
            changed: false,
            nodeId: node.id,
          },
        };
      }
      const target = splitWorkspacePath(path);
      const parent = requireNodeAtPath(revision.index, target.parentPath);
      if (parent.kind !== "folder") {
        expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace parent is not a folder.");
      }
      nodeId = node.id;
      changes = [{ kind: "move", nodeId: node.id, parent: { nodeId: parent.id }, name: target.name }];
    } else {
      const node = requireNodeAtPath(revision.index, sourcePath);
      nodeId = node.id;
      changes = [{ kind: "delete", nodeId: node.id, recursive: operation.recursive ?? false }];
    }

    if (!nodeId) throw new Error("Chat workspace mutation has no stable node ID.");
    const plan = await this.#plan({
      operationId: request.operationId,
      expectedHead: revision.head,
      actor: request.actor,
      timestamp: request.timestamp,
      message: `Workspace ${operation.kind}: ${sourcePath}`,
      changes,
    }, revision.index, { target: nodeId });
    return {
      result: {
        kind: operation.kind,
        head: revision.head,
        path,
        changed: true,
        nodeId,
      },
      mutation: plan.mutation,
    };
  }

  async #resolveStagedChanges(
    request: StagedWorkspaceMutationRequest,
  ): Promise<WorkspaceMutation[]> {
    const changes: WorkspaceMutation[] = [];
    const seenUploads = new Set<string>();
    for (const change of request.changes) {
      if (change.kind !== "createFile" && change.kind !== "replaceFile") {
        changes.push(change);
        continue;
      }
      if (seenUploads.has(change.uploadId)) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.invalidRequest,
          `Workspace upload ${change.uploadId} cannot be used more than once.`,
        );
      }
      seenUploads.add(change.uploadId);
      const upload = await this.#uploadStore.consumeUpload(
        change.uploadId,
        request.actor.id,
        request.operationId,
      );
      if (upload.size > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadQuotaExceeded,
          `Workspace upload ${change.uploadId} exceeds the per-file limit.`,
        );
      }
      if (change.kind === "createFile") {
        changes.push({
          kind: "createFile",
          clientId: change.clientId,
          parent: change.parent,
          name: change.name,
          content: upload.content,
          ...(upload.mediaType === undefined ? {} : { mediaType: upload.mediaType }),
        });
      } else {
        changes.push({
          kind: "replaceFile",
          nodeId: change.nodeId,
          content: upload.content,
          ...(upload.mediaType === undefined ? {} : { mediaType: upload.mediaType }),
        });
      }
    }
    return changes;
  }

  async #plan(
    request: WorkspaceMutationRequest,
    initial: WorkspaceIndexV1,
    created: Record<string, string>,
  ): Promise<{ index: WorkspaceIndexV1; mutation: WorkspaceArtifactMutation }> {
    let index = initial;
    const operations: WorkspaceArtifactMutationOperation[] = [];
    const context = { actorId: request.actor.id, now: request.timestamp };
    for (const change of request.changes) {
      if (change.kind === "createFolder") {
        const result = resolveMutationInput(() => createWorkspaceNode(index, {
          kind: "folder",
          parentId: resolveReference(change.parent, created),
          name: change.name,
        }, { ...context, createId: () => created[change.clientId] }));
        index = result.index;
      } else if (change.kind === "createFile") {
        const result = resolveMutationInput(() => createWorkspaceNode(index, {
          kind: "file",
          parentId: resolveReference(change.parent, created),
          name: change.name,
          size: change.content.byteLength,
          ...(change.mediaType === undefined ? {} : { mediaType: change.mediaType }),
        }, { ...context, createId: () => created[change.clientId] }));
        index = result.index;
        operations.push({ kind: "write", path: result.node.path, content: change.content });
      } else if (change.kind === "replaceFile") {
        const node = getWorkspaceNode(index, change.nodeId);
        if (!node) {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            `Workspace node ${change.nodeId} does not exist.`,
          );
        }
        if (node.kind !== "file") {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            `Workspace node ${change.nodeId} is not a file.`,
          );
        }
        operations.push({ kind: "write", path: node.path, content: change.content });
        index = resolveMutationInput(() => updateWorkspaceFileMetadata(
          index,
          change.nodeId,
          change.mediaType,
          change.content.byteLength,
          context,
        ));
      } else if (change.kind === "move") {
        const node = getWorkspaceNode(index, change.nodeId);
        if (!node) {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            `Workspace node ${change.nodeId} does not exist.`,
          );
        }
        const parentId = resolveReference(change.parent, created);
        if (node.parentId === parentId && node.name === change.name) continue;
        const moved = resolveMutationInput(() => {
          const next = moveWorkspaceNode(index, change.nodeId, parentId, change.name, context);
          return { next, oldPath: node.path, newPath: resolveWorkspacePath(next, change.nodeId) };
        });
        if (node.kind === "file" || hasFileDescendant(index, change.nodeId)) {
          operations.push({ kind: "move", from: moved.oldPath, to: moved.newPath });
        }
        index = moved.next;
      } else {
        const deleted = resolveMutationInput(() => ({
          path: resolveWorkspacePath(index, change.nodeId),
          result: deleteWorkspaceNode(index, change.nodeId, change.recursive ?? false),
        }));
        operations.push({ kind: "delete", path: deleted.path });
        index = deleted.result.index;
      }
      requireWorkspaceQuota(index);
    }
    requireWorkspaceQuota(index);
    operations.push({ kind: "write", path: WORKSPACE_INDEX_PATH, content: serializeWorkspaceIndex(index) });
    return { index, mutation: { operations } };
  }

  async #cleanupUnstagedFork(operationId: string, expectedHead: string): Promise<void> {
    const fork = await this.#lifecycle.getForkStatus(operationForkId(operationId), operationForkEpoch);
    if (fork?.state === "open" && fork.latestHead === expectedHead) {
      await this.#lifecycle.discardChatFork(operationForkId(operationId), operationForkEpoch);
    }
  }

  async #cleanupCommittedFork(operationId: string, head: string): Promise<void> {
    const fork = await this.#lifecycle.getForkStatus(operationForkId(operationId), operationForkEpoch);
    if (fork?.state === "accepted") {
      await this.#lifecycle.completeAcceptedChatFork(
        operationForkId(operationId),
        operationForkEpoch,
        head,
      );
    } else if (fork?.state === "open") {
      await this.#lifecycle.discardChatFork(operationForkId(operationId), operationForkEpoch);
    }
  }

  async #finishAcceptedOperation(
    request: WorkspaceMutationRequest | StagedWorkspaceMutationRequest,
    canonical: WorkspaceArtifactCanonical,
    created: Record<string, string>,
  ): Promise<WorkspaceMutationResult | undefined> {
    const forkId = operationForkId(request.operationId);
    const fork = await this.#lifecycle.getForkStatus(forkId, operationForkEpoch);
    if (fork?.state !== "accepting" && fork?.state !== "accepted") return undefined;
    const accepted = await this.#lifecycle.acceptChatFork(forkId, operationForkEpoch);
    if (accepted.status === "stale") {
      this.#markStale(request.operationId, accepted.currentHead);
      await this.#lifecycle.discardChatFork(forkId, operationForkEpoch);
      throw new WorkspaceRepositoryConflictError(accepted.expectedHead, accepted.currentHead);
    }
    const result: WorkspaceMutationResult = {
      operationId: request.operationId,
      head: accepted.head,
      rootId: canonical.rootId,
      created,
    };
    this.#markCommitted(request.operationId, result);
    await this.#lifecycle.completeAcceptedChatFork(forkId, operationForkEpoch, accepted.head);
    return result;
  }

  async #apply(
    request: WorkspaceMutationRequest | StagedWorkspaceMutationRequest,
    digest: string,
    resolveChanges: () => Promise<WorkspaceMutation[]>,
  ): Promise<WorkspaceMutationResult> {
    this.#ensureOperationTable();
    const existing = this.#getOperation(request.operationId);
    if (existing && existing.request_digest !== digest) {
      expectedError(
        WORKSPACE_FILE_ERROR_CODES.operationReused,
        `Workspace operation ${request.operationId} was reused with different input.`,
      );
    }
    if (existing?.status === "committed") {
      const result = parseCommittedResult(existing);
      await this.#cleanupCommittedFork(request.operationId, result.head);
      return result;
    }
    if (existing?.status === "stale") {
      if (!existing.stale_current_head) {
        throw new Error(`Workspace operation ${request.operationId} has no stale head.`);
      }
      throw new WorkspaceRepositoryConflictError(request.expectedHead, existing.stale_current_head);
    }

    const canonical = await this.#lifecycle.ensureCanonical(request.actor);
    const created = existing ? parseCreatedMap(existing.created_json) : createIds(request);
    if (!existing) this.#insertPrepared(request, digest, created);
    const operationActor = {
      id: request.actor.id,
      name: existing?.actor_name ?? request.actor.name,
    };
    const operationTimestamp = existing?.operation_timestamp ?? request.timestamp;
    if (existing) {
      const recovered = await this.#finishAcceptedOperation(request, canonical, created);
      if (recovered) return recovered;
    }
    const current = await this.#canonical();
    if (current.head !== request.expectedHead) {
      this.#markStale(request.operationId, current.head);
      throw new WorkspaceRepositoryConflictError(request.expectedHead, current.head);
    }

    try {
      const initial = await this.#readIndex(current);
      const resolved = await resolveChanges();
      const planRequest: WorkspaceMutationRequest = {
        operationId: request.operationId,
        expectedHead: request.expectedHead,
        actor: operationActor,
        timestamp: operationTimestamp,
        message: request.message,
        changes: resolved,
      };
      const plan = await this.#plan(planRequest, initial, created);
      const forkId = operationForkId(request.operationId);
      const fork = await this.#lifecycle.getForkStatus(forkId, operationForkEpoch);
      let stagedHead = existing?.staged_head;
      if (stagedHead === null || stagedHead === undefined) {
        if (fork && (fork.state === "accepting" || fork.state === "accepted")) {
          stagedHead = fork.latestHead;
        } else if (fork?.state === "open" && fork.latestHead !== request.expectedHead) {
          stagedHead = fork.latestHead;
        }
        if (stagedHead === null || stagedHead === undefined) {
          const stagedFork = await this.#lifecycle.stageChatMutation(
            forkId,
            operationForkEpoch,
            operationActor,
            request.message,
            plan.mutation,
          );
          stagedHead = stagedFork.latestHead;
          this.#markStaged(request.operationId, stagedHead);
        }
      }

      const accepted = await this.#lifecycle.acceptChatFork(forkId, operationForkEpoch);
      if (accepted.status === "stale") {
        this.#markStale(request.operationId, accepted.currentHead);
        await this.#lifecycle.discardChatFork(forkId, operationForkEpoch);
        throw new WorkspaceRepositoryConflictError(accepted.expectedHead, accepted.currentHead);
      }
      const result: WorkspaceMutationResult = {
        operationId: request.operationId,
        head: accepted.head,
        rootId: canonical.rootId,
        created,
      };
      this.#markCommitted(request.operationId, result);
      await this.#lifecycle.completeAcceptedChatFork(forkId, operationForkEpoch, accepted.head);
      return result;
    } catch (error) {
      const row = this.#getOperation(request.operationId);
      if (row?.status === "prepared") {
        await this.#cleanupUnstagedFork(request.operationId, request.expectedHead);
      }
      throw error;
    }
  }

  initialize(actor: WorkspaceActor): Promise<WorkspaceRevision> {
    return this.#withLock(async () => {
      const canonical = await this.#lifecycle.ensureCanonical(actor);
      return { head: canonical.head, rootId: canonical.rootId };
    });
  }

  getRevision(): Promise<WorkspaceRevision> {
    return this.#withLock(async () => {
      const canonical = await this.#canonical();
      const index = await this.#readIndex(canonical);
      return { head: canonical.head, rootId: index.rootId };
    });
  }

  getNode(nodeId: string): Promise<WorkspaceRepositoryNode | undefined> {
    return this.#withLock(async () => {
      const node = getWorkspaceNode(await this.#readIndex(await this.#canonical()), nodeId);
      return node;
    });
  }

  list(folderId: string): Promise<WorkspaceRepositoryNode[]> {
    return this.#withLock(async () => {
      const nodes = listWorkspaceChildren(await this.#readIndex(await this.#canonical()), folderId);
      return nodes;
    });
  }

  async readFile(nodeId: string): Promise<Uint8Array> {
    return this.#withLock(async () => {
      const canonical = await this.#canonical();
      const index = await this.#readIndex(canonical);
      const node = getWorkspaceNode(index, nodeId);
      if (!node) throw new Error(`Workspace node ${nodeId} does not exist.`);
      if (node.kind !== "file") throw new Error(`Workspace node ${nodeId} is not a file.`);
      return this.#reader.readFile(canonical.repositoryName, canonical.head, node.path);
    });
  }

  async readFileStream(nodeId: string): Promise<ReadableStream<Uint8Array>> {
    return byteStream(await this.readFile(nodeId));
  }

  hasChatFileChanges(chatId: string, epoch: number): Promise<boolean> {
    return this.#withLock(async () => {
      const fork = await this.#lifecycle.getForkStatus(chatId, epoch);
      if (fork?.state !== "open" || fork.latestHead === fork.baselineHead) return false;
      const commits = commitsAfterBaseline(await this.#lifecycle.readChatCommitLog(
        chatId,
        epoch,
        fork.latestHead,
        { depth: maximumHistoryDepth },
      ), fork.baselineHead);
      return commits.some(commit => commit.message.split("\n")
        .some(line => line.startsWith("Workspace-Operation: ")));
    });
  }

  runChatOperation(request: ChatWorkspaceOperationRequest): Promise<ChatWorkspaceOperationResult> {
    requireChatOperationIdentity(request);
    return this.#withLock(async () => {
      const path = normalizeChatPath(request.operation.path);
      if (request.operation.kind === "list") {
        const revision = await this.#readChatRevision(request.chatId, request.epoch);
        const folder = requireNodeAtPath(revision.index, path);
        if (folder.kind !== "folder") {
          expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace path is not a folder.");
        }
        return {
          kind: "list",
          head: revision.head,
          path,
          entries: listWorkspaceChildren(revision.index, folder.id),
        };
      }
      if (request.operation.kind === "read") {
        const revision = await this.#readChatRevision(request.chatId, request.epoch);
        const node = requireNodeAtPath(revision.index, path);
        if (node.kind !== "file") {
          expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, "Workspace path is not a file.");
        }
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          await this.#reader.readFile(revision.repositoryName, revision.head, node.path),
        );
        return { kind: "read", head: revision.head, path, node, content };
      }

      const digest = await digestChatOperation(request);
      const revision = await this.#readChatRevision(request.chatId, request.epoch);
      if (revision.head !== revision.baselineHead) {
        const commits = commitsAfterBaseline(await this.#lifecycle.readChatCommitLog(
          request.chatId,
          request.epoch,
          revision.head,
          { depth: maximumHistoryDepth },
        ), revision.baselineHead);
        const prior = commits.find(commit => commitHasOperationId(commit, request.operationId));
        if (prior !== undefined) {
          if (!commitHasRecoveryTrailers(prior, request.operationId, digest)) {
            expectedError(
              WORKSPACE_FILE_ERROR_CODES.operationReused,
              `Chat workspace operation ${request.operationId} was reused with different input.`,
            );
          }
          const resultPath = normalizeChatPath(request.operation.kind === "move"
            ? request.operation.destination
            : request.operation.path);
          const node = request.operation.kind === "delete"
            ? undefined
            : nodeAtPath(revision.index, resultPath);
          return {
            kind: request.operation.kind,
            head: prior.oid,
            path: resultPath,
            changed: true,
            ...(node === undefined ? {} : { nodeId: node.id }),
          };
        }
      }

      const plan = await this.#planChatMutation(
        request,
        revision,
        workspaceUuidFromDigest(digest),
      );
      if (plan.mutation === undefined) return plan.result;

      const message = `Workspace ${request.operation.kind}: ${path}\n\n` +
        recoveryTrailers(request.operationId, digest);
      const staged = await this.#lifecycle.stageChatMutation(
        request.chatId,
        request.epoch,
        request.actor,
        message,
        plan.mutation,
      );
      return { ...plan.result, head: staged.latestHead };
    });
  }

  getHistory(limit = 50): Promise<CommitInfo[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumHistoryDepth) {
      throw new Error("Workspace history limit must be an integer from 1 to 100.");
    }
    return this.#lifecycle.getHistory(limit);
  }

  readCommitLog(oid: string, options?: { depth?: number }): Promise<CommitInfo[]> {
    return this.#lifecycle.readCommitLog(oid, options);
  }

  stageUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<WorkspaceUpload> {
    return this.#uploadStore.stageUpload(ownerId, request);
  }

  getNextUploadExpiry(): number | undefined {
    return this.#uploadStore.getNextUploadExpiry();
  }

  cleanupExpiredUploads(now = Date.now()): Promise<number> {
    return this.#uploadStore.cleanupExpiredUploads(now);
  }

  deleteAllWorkspaceFiles(): Promise<void> {
    return this.#withLock(async () => {
      await Promise.all([
        this.#lifecycle.deleteWorkspaceRepositories(),
        this.#uploadStore.deleteAllUploads(),
      ]);
    });
  }

  async apply(request: WorkspaceMutationRequest): Promise<WorkspaceMutationResult> {
    requireRequest(request);
    const digest = await digestRequest(request);
    return this.#withLock(() => this.#apply(
      request,
      digest,
      () => Promise.resolve(request.changes),
    ));
  }

  async applyStaged(request: StagedWorkspaceMutationRequest): Promise<WorkspaceMutationResult> {
    requireStagedRequest(request);
    const digest = await digestStagedRequest(request);
    return this.#withLock(() => this.#apply(
      request,
      digest,
      () => this.#resolveStagedChanges(request),
    ));
  }
}
