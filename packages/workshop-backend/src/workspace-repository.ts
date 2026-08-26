import { Workspace, WorkspaceFileSystem, type FileInfo } from "@cloudflare/shell";
import { createGit, type GitLogEntry, type GitStatusEntry } from "@cloudflare/shell/git";
import {
  MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES,
  MAXIMUM_WORKSPACE_TOTAL_BYTES,
  WORKSPACE_FILE_ERROR_CODES,
  type WorkspaceFileErrorCode,
} from "@gadgets/workshop-shared/api";
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
const mediaTypePattern =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[ \t]*[\x21-\x7e]+)*$/;
const maximumChanges = 1_000;
const maximumPendingUploads = 1_000;
const workspaceUploadLifetimeMs = 24 * 60 * 60 * 1_000;
const operationTrailerLabel = "Workspace-Operation:";
const digestTrailerLabel = "Workspace-Request-Digest:";

/** An expected caller-visible repository rejection with a stable public error category. */
export class WorkspaceRepositoryExpectedError extends Error {
  constructor(readonly code: WorkspaceFileErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceRepositoryExpectedError";
  }
}

function expectedError(code: WorkspaceFileErrorCode, message: string): never {
  throw new WorkspaceRepositoryExpectedError(code, message);
}

/** Parses a caller-provided media type before it can become R2 HTTP metadata. */
export function parseWorkspaceUploadMediaType(mediaType: string | undefined): string | undefined {
  if (mediaType !== undefined &&
      (mediaType.length > 255 || !mediaTypePattern.test(mediaType))) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace uploads must provide a valid media type of at most 255 characters.",
    );
  }
  return mediaType;
}

/** Enforces the aggregate reservation limit for staged workspace uploads. */
export function requirePendingUploadCapacity(
  currentCount: number,
  currentBytes: number,
  nextBytes: number,
  maximumBytes: number,
): void {
  if (currentCount >= maximumPendingUploads || currentBytes + nextBytes > maximumBytes) {
    expectedError(WORKSPACE_FILE_ERROR_CODES.uploadQuotaExceeded,
      `Workspace pending upload storage cannot exceed ${maximumBytes} bytes ` +
      `or ${maximumPendingUploads} objects.`,
    );
  }
}

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

/** A stable workspace node with its current accepted byte size. */
export interface WorkspaceRepositoryNode extends WorkspaceNode {
  size: number;
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

/** One workspace change whose file content is held in an opaque staged upload. */
export type StagedWorkspaceMutation =
  | Exclude<WorkspaceMutation, { kind: "createFile" } | { kind: "replaceFile" }>
  | {
      kind: "createFile";
      clientId: string;
      parent: WorkspaceNodeReference;
      name: string;
      uploadId: string;
    }
  | {
      kind: "replaceFile";
      nodeId: string;
      uploadId: string;
    };

export interface StagedWorkspaceMutationRequest {
  operationId: string;
  expectedHead: string;
  actor: WorkspaceActor;
  timestamp: string;
  message: string;
  changes: StagedWorkspaceMutation[];
}

export interface WorkspaceUploadRequest {
  content: ReadableStream<Uint8Array>;
  size: number;
  mediaType?: string;
}

export interface WorkspaceUpload {
  uploadId: string;
  size: number;
  mediaType?: string;
  expiresAt: string;
}

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

export type WorkspaceRepositoryFailurePoint =
  | "afterUploadPut"
  | "afterWorktree"
  | "afterCommit";

export interface WorkspaceRepositoryOptions {
  state: DurableObjectState;
  bucket: R2Bucket;
  workspaceId: string;
  maxWorkspaceBytes?: number;
  maxPendingUploadBytes?: number;
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

interface UploadRow {
  [key: string]: string | number | null;
  upload_id: string;
  owner_id: string;
  object_key: string;
  byte_size: number;
  media_type: string | null;
  content_sha256: string | null;
  status: string;
  consumed_by_operation: string | null;
  expires_at: number;
}

interface UploadAggregateRow {
  [key: string]: number;
  upload_count: number;
  total_bytes: number;
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
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace actor IDs must contain 1 to 256 UTF-8 bytes.",
    );
  }
  if (!actor.name || new TextEncoder().encode(actor.name).byteLength > 256) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace actor names must contain 1 to 256 UTF-8 bytes.",
    );
  }
}

function requireTimestamp(timestamp: string): void {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace mutation timestamps must be canonical UTC ISO strings.",
    );
  }
}

function requireRequest(request: WorkspaceMutationRequest): void {
  if (!operationIdPattern.test(request.operationId)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace operation IDs must be lowercase UUID v4 values.",
    );
  }
  if (!gitOidPattern.test(request.expectedHead)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Expected workspace heads must be Git object IDs.",
    );
  }
  requireActor(request.actor);
  requireTimestamp(request.timestamp);
  if (!request.message.trim() || request.message.length > 1_000) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace commit messages must contain 1 to 1000 characters.",
    );
  }
  if (request.message.includes(operationTrailerLabel) ||
      request.message.includes(digestTrailerLabel)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace commit messages cannot contain reserved recovery metadata.",
    );
  }
  if (request.changes.length < 1 || request.changes.length > maximumChanges) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      `Workspace mutations must contain 1 to ${maximumChanges} changes.`,
    );
  }
  const clientIds = new Set<string>();
  for (const change of request.changes) {
    if (change.kind === "createFile" || change.kind === "createFolder") {
      if (!change.clientId || clientIds.has(change.clientId)) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.invalidRequest,
          "Created workspace nodes require unique non-empty client IDs.",
        );
      }
      clientIds.add(change.clientId);
    }
    if ((change.kind === "createFile" || change.kind === "replaceFile") &&
        change.content.byteLength > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
      expectedError(WORKSPACE_FILE_ERROR_CODES.uploadQuotaExceeded,
        `Workspace file content cannot exceed ${MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES} bytes.`,
      );
    }
  }
}

function requireStagedRequest(request: StagedWorkspaceMutationRequest): void {
  if (!operationIdPattern.test(request.operationId)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace operation IDs must be lowercase UUID v4 values.",
    );
  }
  if (!gitOidPattern.test(request.expectedHead)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Expected workspace heads must be Git object IDs.",
    );
  }
  requireActor(request.actor);
  requireTimestamp(request.timestamp);
  if (!request.message.trim() || request.message.length > 1_000) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace commit messages must contain 1 to 1000 characters.",
    );
  }
  if (request.message.includes(operationTrailerLabel) ||
      request.message.includes(digestTrailerLabel)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace commit messages cannot contain reserved recovery metadata.",
    );
  }
  if (request.changes.length < 1 || request.changes.length > maximumChanges) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      `Workspace mutations must contain 1 to ${maximumChanges} changes.`,
    );
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
    actorId: request.actor.id,
    message: request.message,
    changes,
  });
  return digestBytes(new TextEncoder().encode(canonical));
}

function canonicalReference(reference: WorkspaceNodeReference): WorkspaceNodeReference {
  return "nodeId" in reference
    ? { nodeId: reference.nodeId }
    : { clientId: reference.clientId };
}

async function digestStagedRequest(request: StagedWorkspaceMutationRequest): Promise<string> {
  const changes = request.changes.map(change => {
    if (change.kind === "createFolder") return {
      kind: change.kind,
      clientId: change.clientId,
      parent: canonicalReference(change.parent),
      name: change.name,
    };
    if (change.kind === "createFile") return {
      kind: change.kind,
      clientId: change.clientId,
      parent: canonicalReference(change.parent),
      name: change.name,
      uploadId: change.uploadId,
    };
    if (change.kind === "replaceFile") return {
      kind: change.kind,
      nodeId: change.nodeId,
      uploadId: change.uploadId,
    };
    if (change.kind === "move") return {
      kind: change.kind,
      nodeId: change.nodeId,
      parent: canonicalReference(change.parent),
      name: change.name,
    };
    return {
      kind: change.kind,
      nodeId: change.nodeId,
      recursive: change.recursive ?? false,
    };
  });
  return digestBytes(new TextEncoder().encode(JSON.stringify({
    operationId: request.operationId,
    expectedHead: request.expectedHead,
    actorId: request.actor.id,
    message: request.message,
    changes,
  })));
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
  readonly #bucket: R2Bucket;
  readonly #workspaceId: string;
  readonly #maxWorkspaceBytes: number;
  readonly #maxPendingUploadBytes: number;
  readonly #workspace: Workspace;
  readonly #worktreeRoot: string;
  readonly #git: ReturnType<typeof createGit>;
  readonly #injectFailure?: WorkspaceRepositoryOptions["injectFailure"];
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceRepositoryOptions) {
    this.#state = options.state;
    this.#bucket = options.bucket;
    this.#workspaceId = options.workspaceId;
    this.#maxWorkspaceBytes = options.maxWorkspaceBytes ?? MAXIMUM_WORKSPACE_TOTAL_BYTES;
    if (!Number.isSafeInteger(this.#maxWorkspaceBytes) || this.#maxWorkspaceBytes < 1) {
      throw new Error("Workspace byte limits must be positive safe integers.");
    }
    this.#maxPendingUploadBytes =
      options.maxPendingUploadBytes ?? MAXIMUM_WORKSPACE_TOTAL_BYTES;
    if (!Number.isSafeInteger(this.#maxPendingUploadBytes) || this.#maxPendingUploadBytes < 1) {
      throw new Error("Pending workspace upload limits must be positive safe integers.");
    }
    this.#injectFailure = options.injectFailure;
    this.#workspace = new Workspace({
      sql: options.state.storage.sql,
      namespace: "workspace_files",
      r2: options.bucket,
      r2Prefix: `workspaces/${options.workspaceId}`,
      name: () => options.workspaceId,
    });
    // isomorphic-git coordinates process-wide work by path. Give every Durable Object a distinct
    // virtual worktree path so concurrent repositories cannot share its `.git` lock keys.
    this.#worktreeRoot = `/accepted-${options.workspaceId}`;
    this.#git = createGit(new WorkspaceFileSystem(this.#workspace), this.#worktreeRoot);
  }

  #worktreePath(path = ""): string {
    return path ? `${this.#worktreeRoot}/${path}` : this.#worktreeRoot;
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
    this.#state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_file_uploads (
        upload_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        byte_size INTEGER NOT NULL,
        media_type TEXT,
        content_sha256 TEXT,
        status TEXT NOT NULL CHECK (status IN ('writing', 'ready', 'consumed')),
        consumed_by_operation TEXT,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  #requireUploadRequest(request: WorkspaceUploadRequest): void {
    if (!Number.isSafeInteger(request.size) || request.size < 0) {
      expectedError(
        WORKSPACE_FILE_ERROR_CODES.invalidRequest,
        "Workspace uploads must declare a non-negative safe integer size.",
      );
    }
    if (request.size > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
      expectedError(
        WORKSPACE_FILE_ERROR_CODES.uploadQuotaExceeded,
        `Workspace uploads must declare a size from 0 to ${MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES} bytes.`,
      );
    }
    parseWorkspaceUploadMediaType(request.mediaType);
  }

  async #reserveUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<{
    upload: WorkspaceUpload;
    objectKey: string;
  }> {
    if (!ownerId || new TextEncoder().encode(ownerId).byteLength > 256) {
      expectedError(
        WORKSPACE_FILE_ERROR_CODES.invalidRequest,
        "Workspace upload owner IDs must contain 1 to 256 UTF-8 bytes.",
      );
    }
    this.#requireUploadRequest(request);
    this.#ensureOperationTable();

    const aggregate = [...this.#state.storage.sql.exec<UploadAggregateRow>(`
      SELECT COUNT(*) AS upload_count, COALESCE(SUM(byte_size), 0) AS total_bytes
      FROM workspace_file_uploads
      WHERE status IN ('writing', 'ready')
    `)][0];
    if (!aggregate) throw new Error("Workspace upload reservation totals are unavailable.");
    requirePendingUploadCapacity(
      aggregate.upload_count,
      aggregate.total_bytes,
      request.size,
      this.#maxPendingUploadBytes,
    );

    const uploadId = crypto.randomUUID();
    const objectKey = `workspaces/${this.#workspaceId}/uploads/${uploadId}`;
    const expiresAt = Date.now() + workspaceUploadLifetimeMs;
    this.#state.storage.sql.exec(`
      INSERT INTO workspace_file_uploads (
        upload_id, owner_id, object_key, byte_size, media_type, content_sha256,
        status, consumed_by_operation, expires_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'writing', NULL, ?)
    `, uploadId, ownerId, objectKey, request.size, request.mediaType ?? null, expiresAt);
    const alarm = await this.#state.storage.getAlarm();
    if (alarm === null || expiresAt < alarm) await this.#state.storage.setAlarm(expiresAt);
    return {
      upload: {
        uploadId,
        size: request.size,
        ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
        expiresAt: new Date(expiresAt).toISOString(),
      },
      objectKey,
    };
  }

  async #writeUpload(
    ownerId: string,
    request: WorkspaceUploadRequest,
    upload: WorkspaceUpload,
    objectKey: string,
  ): Promise<WorkspaceUpload> {
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = request.content.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > request.size || received > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
          await reader.cancel("Workspace upload content exceeds its declared size.");
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.invalidRequest,
            "Workspace upload content exceeds its declared size.",
          );
        }
        chunks.push(value);
      }
      if (received !== request.size) {
        expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest,
          `Workspace upload declared ${request.size} bytes but received ${received} bytes.`,
        );
      }
      const content = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const sha256 = await digestBytes(content);
      const putOptions: R2PutOptions = {
        sha256,
        ...(request.mediaType === undefined
          ? {}
          : { httpMetadata: { contentType: request.mediaType } }),
      };
      const object = await this.#bucket.put(objectKey, content, putOptions);
      if (object.size !== request.size) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadIntegrityFailed,
          `Workspace upload ${upload.uploadId} was not stored completely.`,
        );
      }
      await this.#injectFailure?.("afterUploadPut");
      await this.#withLock(async () => {
        const row = this.#getUpload(upload.uploadId);
        if (!row || row.owner_id !== ownerId || row.status !== "writing") {
          expectedError(
            WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
            `Workspace upload ${upload.uploadId} reservation was lost.`,
          );
        }
        this.#state.storage.sql.exec(`
          UPDATE workspace_file_uploads
          SET status = 'ready', content_sha256 = ?
          WHERE upload_id = ?
        `, sha256, upload.uploadId);
      });
      return upload;
    } catch (error) {
      await this.#bucket.delete(objectKey);
      await this.#withLock(async () => {
        this.#state.storage.sql.exec(
          "DELETE FROM workspace_file_uploads WHERE upload_id = ? AND status = 'writing'",
          upload.uploadId,
        );
      });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /** Stages one bounded stream for a subsequent authorized mutation. */
  async stageUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<WorkspaceUpload> {
    const reservation = await this.#withLock(() => this.#reserveUpload(ownerId, request));
    return this.#writeUpload(ownerId, request, reservation.upload, reservation.objectKey);
  }

  #getUpload(uploadId: string): UploadRow | undefined {
    if (!operationIdPattern.test(uploadId)) {
      expectedError(WORKSPACE_FILE_ERROR_CODES.uploadUnavailable, "Invalid workspace upload ID.");
    }
    return [...this.#state.storage.sql.exec<UploadRow>(`
      SELECT upload_id, owner_id, object_key, byte_size, media_type, content_sha256,
             status, consumed_by_operation, expires_at
      FROM workspace_file_uploads
      WHERE upload_id = ?
    `, uploadId)][0];
  }

  /** Returns the earliest staged-upload expiry, if any. */
  getNextUploadExpiry(): number | undefined {
    this.#ensureOperationTable();
    const row = [...this.#state.storage.sql.exec<{ expires_at: number }>(`
      SELECT expires_at
      FROM workspace_file_uploads
      ORDER BY expires_at
      LIMIT 1
    `)][0];
    return row?.expires_at;
  }

  /** Removes expired upload metadata and its private R2 objects. */
  cleanupExpiredUploads(now = Date.now()): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Workspace upload cleanup time must be a non-negative integer.");
    }
    return this.#withLock(async () => {
      this.#ensureOperationTable();
      const expired = [...this.#state.storage.sql.exec<UploadRow>(`
        SELECT upload_id, owner_id, object_key, byte_size, media_type, content_sha256,
               status, consumed_by_operation, expires_at
        FROM workspace_file_uploads
        WHERE expires_at <= ?
        ORDER BY expires_at
      `, now)];
      for (let offset = 0; offset < expired.length; offset += 1_000) {
        await this.#bucket.delete(
          expired.slice(offset, offset + 1_000).map(upload => upload.object_key),
        );
      }
      this.#state.storage.transactionSync(() => {
        for (const upload of expired) {
          this.#state.storage.sql.exec(
            "DELETE FROM workspace_file_uploads WHERE upload_id = ?",
            upload.upload_id,
          );
        }
      });
      return expired.length;
    });
  }

  async #resolveStagedChanges(
    request: StagedWorkspaceMutationRequest,
  ): Promise<{ changes: WorkspaceMutation[]; uploads: UploadRow[] }> {
    const changes: WorkspaceMutation[] = [];
    const uploads: UploadRow[] = [];
    const seenUploads = new Set<string>();
    let totalBytes = 0;
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
      const upload = this.#getUpload(change.uploadId);
      if (!upload || upload.expires_at <= Date.now()) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
          `Workspace upload ${change.uploadId} does not exist or has expired.`,
        );
      }
      if (upload.owner_id !== request.actor.id) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadAccessDenied,
          "Workspace uploads can only be used by the profile that staged them.",
        );
      }
      if (upload.status === "writing") {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
          `Workspace upload ${change.uploadId} is not ready.`,
        );
      }
      if (upload.status === "consumed" &&
          upload.consumed_by_operation !== request.operationId) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
          `Workspace upload ${change.uploadId} has already been used.`,
        );
      }
      totalBytes += upload.byte_size;
      if (totalBytes > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
        expectedError(WORKSPACE_FILE_ERROR_CODES.uploadQuotaExceeded,
          `Workspace mutations cannot contain more than ${MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES} bytes.`,
        );
      }
      const object = await this.#bucket.get(upload.object_key);
      if (!object || object.size !== upload.byte_size) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadIntegrityFailed,
          `Workspace upload ${change.uploadId} has missing or invalid content.`,
        );
      }
      const content = new Uint8Array(await object.arrayBuffer());
      if (upload.content_sha256 === null || await digestBytes(content) !== upload.content_sha256) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadIntegrityFailed,
          `Workspace upload ${change.uploadId} failed its integrity check.`,
        );
      }
      const mediaType = upload.media_type ?? undefined;
      changes.push(change.kind === "createFile" ? {
        kind: "createFile",
        clientId: change.clientId,
        parent: change.parent,
        name: change.name,
        content,
        ...(mediaType === undefined ? {} : { mediaType }),
      } : {
        kind: "replaceFile",
        nodeId: change.nodeId,
        content,
        ...(mediaType === undefined ? {} : { mediaType }),
      });
      uploads.push(upload);
    }
    return { changes, uploads };
  }

  #withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run, run);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #initialize(actor: WorkspaceActor): Promise<WorkspaceRevision> {
    requireActor(actor);
    this.#ensureOperationTable();
    // Force Shell's lazy table initialization to finish before isomorphic-git starts issuing
    // concurrent filesystem calls during its own initialization.
    const stored = await this.#workspace.readFileBytes(this.#worktreePath(WORKSPACE_INDEX_PATH));
    await this.#git.init({ defaultBranch: "main" });
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

    await this.#workspace.writeFileBytes(
      this.#worktreePath(WORKSPACE_INDEX_PATH),
      serializeWorkspaceIndex(index),
    );
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
    const bytes = await this.#workspace.readFileBytes(this.#worktreePath(WORKSPACE_INDEX_PATH));
    if (bytes === null) throw new Error("Workspace filesystem is not initialized.");
    return parseWorkspaceIndex(bytes);
  }

  async #getHead(): Promise<string> {
    const [head] = await this.#git.log({ depth: 1, ref: "main" });
    if (!head) throw new Error("Workspace filesystem has no accepted revision.");
    return head.oid;
  }

  /** Returns the current accepted workspace revision. */
  getRevision(): Promise<WorkspaceRevision> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      const index = await this.#readIndex();
      return { head: await this.#getHead(), rootId: index.rootId };
    });
  }

  async #withSize(node: WorkspaceNode): Promise<WorkspaceRepositoryNode> {
    if (node.kind === "folder") return { ...node, size: 0 };
    const stat = await this.#workspace.stat(this.#worktreePath(node.path));
    if (stat === null || stat.type !== "file") {
      throw new Error(`Workspace file ${node.id} has no content.`);
    }
    return { ...node, size: stat.size };
  }

  /** Resolves one stable identity at the current accepted revision. */
  getNode(nodeId: string): Promise<WorkspaceRepositoryNode | undefined> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      const node = getWorkspaceNode(await this.#readIndex(), nodeId);
      return node === undefined ? undefined : this.#withSize(node);
    });
  }

  /** Lists the current direct children of one stable folder identity. */
  list(folderId: string): Promise<WorkspaceRepositoryNode[]> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      const nodes = listWorkspaceChildren(await this.#readIndex(), folderId);
      return Promise.all(nodes.map((node) => this.#withSize(node)));
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
      const content = await this.#workspace.readFileBytes(this.#worktreePath(node.path));
      if (content === null) throw new Error(`Workspace file ${nodeId} has no content.`);
      return content;
    });
  }

  /** Streams the current accepted bytes for one stable file identity. */
  readFileStream(nodeId: string): Promise<ReadableStream<Uint8Array>> {
    return this.#withLock(async () => {
      await this.#recoverPreparedOperations();
      const index = await this.#readIndex();
      const node = getWorkspaceNode(index, nodeId);
      if (!node) throw new Error(`Workspace node ${nodeId} does not exist.`);
      if (node.kind !== "file") throw new Error(`Workspace node ${nodeId} is not a file.`);
      const content = await this.#workspace.readFileStream(this.#worktreePath(node.path));
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
    for (const entry of await this.#workspace.readDir(this.#worktreeRoot)) {
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
    for (const path of folders) {
      await this.#workspace.mkdir(this.#worktreePath(path), { recursive: true });
    }
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
    const entries: FileInfo[] = await this.#workspace.readDir(this.#worktreePath(directory));
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
        const result = resolveMutationInput(() => createWorkspaceNode(index, {
          kind: "folder",
          parentId: resolveReference(change.parent, created),
          name: change.name,
        }, { ...context, createId: () => created[change.clientId] }));
        index = result.index;
        await this.#workspace.mkdir(this.#worktreePath(result.node.path));
      } else if (change.kind === "createFile") {
        const result = resolveMutationInput(() => createWorkspaceNode(index, {
          kind: "file",
          parentId: resolveReference(change.parent, created),
          name: change.name,
          size: change.content.byteLength,
          ...(change.mediaType === undefined ? {} : { mediaType: change.mediaType }),
        }, { ...context, createId: () => created[change.clientId] }));
        index = result.index;
        await this.#workspace.writeFileBytes(
          this.#worktreePath(result.node.path),
          change.content,
          change.mediaType,
        );
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
        await this.#workspace.writeFileBytes(
          this.#worktreePath(node.path),
          change.content,
          change.mediaType,
        );
        index = resolveMutationInput(() =>
          updateWorkspaceFileMetadata(
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
        const { oldPath, next, newPath } = resolveMutationInput(() => {
          const resolvedOldPath = resolveWorkspacePath(index, change.nodeId);
          const nextIndex = moveWorkspaceNode(
            index,
            change.nodeId,
            parentId,
            change.name,
            context,
          );
          return {
            oldPath: resolvedOldPath,
            next: nextIndex,
            newPath: resolveWorkspacePath(nextIndex, change.nodeId),
          };
        });
        await this.#workspace.mv(this.#worktreePath(oldPath), this.#worktreePath(newPath));
        index = next;
      } else {
        const { path, deleted } = resolveMutationInput(() => ({
          path: resolveWorkspacePath(index, change.nodeId),
          deleted: deleteWorkspaceNode(index, change.nodeId, change.recursive ?? false),
        }));
        await this.#workspace.rm(this.#worktreePath(path), {
          recursive: change.recursive ?? false,
        });
        index = deleted.index;
      }
    }

    await this.#workspace.writeFileBytes(
      this.#worktreePath(WORKSPACE_INDEX_PATH),
      serializeWorkspaceIndex(index),
    );
    await this.#validateWorktree(index);
    return index;
  }

  async #apply(request: WorkspaceMutationRequest, digest: string): Promise<WorkspaceMutationResult> {
    const initial = await this.#initialize(request.actor);
    await this.#recoverPreparedOperations();

    const row = this.#getOperation(request.operationId);
    if (row && row.request_digest !== digest) {
      expectedError(
        WORKSPACE_FILE_ERROR_CODES.operationReused,
        `Workspace operation ${request.operationId} was reused with different input.`,
      );
    }
    if (row?.status === "committed") return this.#resultFromRow(row, initial.rootId);

    const currentHead = await this.#getHead();
    if (currentHead !== request.expectedHead) {
      throw new WorkspaceRepositoryConflictError(request.expectedHead, currentHead);
    }

    const created = row ? parseCreatedMap(row.created_json) : this.#createdIds(request);
    if (row) this.#markPrepared(request.operationId);
    else this.#insertPrepared(request, digest, created);
    try {
      const index = await this.#applyChanges(request, created);
      const workspaceInfo = await this.#workspace.getWorkspaceInfo();
      if (workspaceInfo.totalBytes > this.#maxWorkspaceBytes) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.workspaceQuotaExceeded,
          `Workspace storage cannot exceed ${this.#maxWorkspaceBytes} bytes.`,
        );
      }
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
    } catch (error) {
      const prepared = this.#getOperation(request.operationId);
      if (prepared?.status === "prepared") await this.#recoverPrepared(prepared);
      throw error;
    }
  }

  /** Applies one idempotent compare-and-swap mutation to accepted workspace state. */
  async apply(request: WorkspaceMutationRequest): Promise<WorkspaceMutationResult> {
    requireRequest(request);
    const digest = await digestRequest(request);
    return this.#withLock(() => this.#apply(request, digest));
  }

  /** Resolves caller-owned upload handles and applies one authorized mutation atomically. */
  applyStaged(request: StagedWorkspaceMutationRequest): Promise<WorkspaceMutationResult> {
    return this.#withLock(async () => {
      requireStagedRequest(request);
      this.#ensureOperationTable();
      const digest = await digestStagedRequest(request);
      const initial = await this.#initialize(request.actor);
      await this.#recoverPreparedOperations();
      const existing = this.#getOperation(request.operationId);
      if (existing && existing.request_digest !== digest) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.operationReused,
          `Workspace operation ${request.operationId} was reused with different input.`,
        );
      }
      if (existing?.status === "committed") {
        return this.#resultFromRow(existing, initial.rootId);
      }
      const currentHead = await this.#getHead();
      if (currentHead !== request.expectedHead) {
        throw new WorkspaceRepositoryConflictError(request.expectedHead, currentHead);
      }
      const { changes, uploads } = await this.#resolveStagedChanges(request);
      const resolved: WorkspaceMutationRequest = { ...request, changes };
      requireRequest(resolved);
      for (const upload of uploads) {
        this.#state.storage.sql.exec(`
          UPDATE workspace_file_uploads
          SET status = 'consumed', consumed_by_operation = ?
          WHERE upload_id = ?
        `, request.operationId, upload.upload_id);
      }
      return this.#apply(resolved, digest);
    });
  }

  /** Deletes every R2 object owned by this workspace before the Durable Object is removed. */
  deleteAllWorkspaceFiles(): Promise<void> {
    return this.#withLock(async () => {
      const prefix = `workspaces/${this.#workspaceId}/`;
      let cursor: string | undefined;
      do {
        const page = await this.#bucket.list({
          prefix,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (page.objects.length > 0) {
          await this.#bucket.delete(page.objects.map(object => object.key));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    });
  }
}
