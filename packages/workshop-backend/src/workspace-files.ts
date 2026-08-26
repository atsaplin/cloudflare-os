import {
  MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES,
  WORKSPACE_FILE_ERROR_CODES,
  type WorkspaceFileErrorCode,
} from "@gadgets/workshop-shared/api";
import type { WorkspaceNode } from "./workspace-manifest";

const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const gitOidPattern = /^[0-9a-f]{40}$/;
const mediaTypePattern =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[ \t]*[\x21-\x7e]+)*$/;
const maximumChanges = 1_000;
const maximumPendingUploads = 1_000;
const operationTrailerLabel = "Workspace-Operation:";
const digestTrailerLabel = "Workspace-Request-Digest:";

export function isWorkspaceUuid(value: unknown): value is string {
  return typeof value === "string" && operationIdPattern.test(value);
}

/** An expected caller-visible workspace rejection with a stable public category. */
export class WorkspaceRepositoryExpectedError extends Error {
  constructor(readonly code: WorkspaceFileErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceRepositoryExpectedError";
  }
}

/** A workspace mutation lost a compare-and-swap race with a newer revision. */
export class WorkspaceRepositoryConflictError extends Error {
  constructor(readonly expectedHead: string, readonly currentHead: string) {
    super(`Workspace changed from ${expectedHead} to ${currentHead}.`);
    this.name = "WorkspaceRepositoryConflictError";
  }
}

export function expectedError(code: WorkspaceFileErrorCode, message: string): never {
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

export function requireActor(actor: WorkspaceActor): void {
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

export function requireTimestamp(timestamp: string): void {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    expectedError(
      WORKSPACE_FILE_ERROR_CODES.invalidRequest,
      "Workspace mutation timestamps must be canonical UTC ISO strings.",
    );
  }
}

export function requireRequest(request: WorkspaceMutationRequest): void {
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

export function requireStagedRequest(request: StagedWorkspaceMutationRequest): void {
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

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function digestRequest(request: WorkspaceMutationRequest): Promise<string> {
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

export async function digestStagedRequest(
  request: StagedWorkspaceMutationRequest,
): Promise<string> {
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

export function recoveryTrailers(operationId: string, requestDigest: string): string {
  return `${operationTrailerLabel} ${operationId}\n${digestTrailerLabel} ${requestDigest}`;
}
