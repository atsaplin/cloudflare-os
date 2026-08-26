import {
  WorkspaceRepositoryExpectedError,
  digestBytes,
  isWorkspaceUuid,
  parseWorkspaceUploadMediaType,
  requirePendingUploadCapacity,
  type WorkspaceUpload,
  type WorkspaceUploadRequest,
} from "./workspace-files";
import {
  MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES,
  MAXIMUM_WORKSPACE_TOTAL_BYTES,
  WORKSPACE_FILE_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

const maximumPendingUploads = 1_000;
const workspaceUploadLifetimeMs = 24 * 60 * 60 * 1_000;

export interface WorkspaceUploadContent {
  uploadId: string;
  size: number;
  mediaType?: string;
  content: Uint8Array;
}

export type WorkspaceUploadStoreFailurePoint = "afterUploadPut";

export interface WorkspaceUploadStoreOptions {
  state: DurableObjectState;
  bucket: R2Bucket;
  workspaceId: string;
  maxPendingUploadBytes?: number;
  injectFailure?: (point: WorkspaceUploadStoreFailurePoint) => void | Promise<void>;
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

function expectedError(
  code: typeof WORKSPACE_FILE_ERROR_CODES[keyof typeof WORKSPACE_FILE_ERROR_CODES],
  message: string,
): never {
  throw new WorkspaceRepositoryExpectedError(code, message);
}

function requireOwnerId(ownerId: string): void {
  if (!ownerId || new TextEncoder().encode(ownerId).byteLength > 256) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace upload owner IDs must contain 1 to 256 UTF-8 bytes.",
    );
  }
}

function requireOperationId(operationId: string): void {
  if (!isWorkspaceUuid(operationId)) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace upload operation IDs must be lowercase UUID v4 values.",
    );
  }
}

function requireUploadRequest(request: WorkspaceUploadRequest): void {
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

export class WorkspaceUploadStore {
  readonly #state: DurableObjectState;
  readonly #bucket: R2Bucket;
  readonly #workspaceId: string;
  readonly #maxPendingUploadBytes: number;
  readonly #injectFailure?: WorkspaceUploadStoreOptions["injectFailure"];
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceUploadStoreOptions) {
    if (!options.workspaceId) throw new Error("Workspace ID is required.");
    this.#state = options.state;
    this.#bucket = options.bucket;
    this.#workspaceId = options.workspaceId;
    this.#maxPendingUploadBytes =
      options.maxPendingUploadBytes ?? MAXIMUM_WORKSPACE_TOTAL_BYTES;
    if (!Number.isSafeInteger(this.#maxPendingUploadBytes) || this.#maxPendingUploadBytes < 1) {
      throw new Error("Pending workspace upload limits must be positive safe integers.");
    }
    this.#injectFailure = options.injectFailure;
  }

  #ensureTable(): void {
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

  async #reserveUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<{
    upload: WorkspaceUpload;
    objectKey: string;
  }> {
    requireOwnerId(ownerId);
    requireUploadRequest(request);
    this.#ensureTable();

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
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.invalidRequest,
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

  stageUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<WorkspaceUpload> {
    return this.#withLock(() => this.#reserveUpload(ownerId, request))
      .then(reservation => this.#writeUpload(ownerId, request, reservation.upload,
        reservation.objectKey));
  }

  #getUpload(uploadId: string): UploadRow | undefined {
    if (!isWorkspaceUuid(uploadId)) {
      expectedError(WORKSPACE_FILE_ERROR_CODES.uploadUnavailable, "Invalid workspace upload ID.");
    }
    return [...this.#state.storage.sql.exec<UploadRow>(`
      SELECT upload_id, owner_id, object_key, byte_size, media_type, content_sha256,
             status, consumed_by_operation, expires_at
      FROM workspace_file_uploads
      WHERE upload_id = ?
    `, uploadId)][0];
  }

  getNextUploadExpiry(): number | undefined {
    this.#ensureTable();
    const row = [...this.#state.storage.sql.exec<{ expires_at: number }>(`
      SELECT expires_at
      FROM workspace_file_uploads
      ORDER BY expires_at
      LIMIT 1
    `)][0];
    return row?.expires_at;
  }

  cleanupExpiredUploads(now = Date.now()): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Workspace upload cleanup time must be a non-negative integer.");
    }
    return this.#withLock(async () => {
      this.#ensureTable();
      const expired = [...this.#state.storage.sql.exec<UploadRow>(`
        SELECT upload_id, owner_id, object_key, byte_size, media_type, content_sha256,
               status, consumed_by_operation, expires_at
        FROM workspace_file_uploads
        WHERE expires_at <= ?
        ORDER BY expires_at
      `, now)];
      for (let offset = 0; offset < expired.length; offset += maximumPendingUploads) {
        await this.#bucket.delete(
          expired.slice(offset, offset + maximumPendingUploads).map(upload => upload.object_key),
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

  deleteAllUploads(): Promise<void> {
    return this.#withLock(async () => {
      const prefix = `workspaces/${this.#workspaceId}/`;
      let cursor: string | undefined;
      do {
        const page = await this.#bucket.list({
          prefix,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (let offset = 0; offset < page.objects.length; offset += maximumPendingUploads) {
          await this.#bucket.delete(
            page.objects.slice(offset, offset + maximumPendingUploads).map(object => object.key),
          );
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      this.#ensureTable();
      this.#state.storage.sql.exec("DELETE FROM workspace_file_uploads");
    });
  }

  consumeUpload(
    uploadId: string,
    ownerId: string,
    operationId: string,
  ): Promise<WorkspaceUploadContent> {
    requireOwnerId(ownerId);
    requireOperationId(operationId);
    return this.#withLock(async () => {
      this.#ensureTable();
      const upload = this.#getUpload(uploadId);
      if (!upload || upload.expires_at <= Date.now()) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
          `Workspace upload ${uploadId} does not exist or has expired.`,
        );
      }
      if (upload.owner_id !== ownerId) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadAccessDenied,
          "Workspace uploads can only be used by the profile that staged them.",
        );
      }
      if (upload.status === "writing") {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
          `Workspace upload ${uploadId} is not ready.`,
        );
      }
      if (upload.status === "consumed" && upload.consumed_by_operation !== operationId) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadUnavailable,
          `Workspace upload ${uploadId} has already been used.`,
        );
      }
      const object = await this.#bucket.get(upload.object_key);
      if (!object || object.size !== upload.byte_size) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadIntegrityFailed,
          `Workspace upload ${uploadId} has missing or invalid content.`,
        );
      }
      const content = new Uint8Array(await object.arrayBuffer());
      if (content.byteLength !== upload.byte_size || upload.content_sha256 === null ||
          await digestBytes(content) !== upload.content_sha256) {
        expectedError(
          WORKSPACE_FILE_ERROR_CODES.uploadIntegrityFailed,
          `Workspace upload ${uploadId} failed its integrity check.`,
        );
      }
      if (upload.status === "ready") {
        this.#state.storage.sql.exec(`
          UPDATE workspace_file_uploads
          SET status = 'consumed', consumed_by_operation = ?
          WHERE upload_id = ? AND status = 'ready'
        `, operationId, uploadId);
      }
      return {
        uploadId,
        size: upload.byte_size,
        ...(upload.media_type === null ? {} : { mediaType: upload.media_type }),
        content,
      };
    });
  }
}
