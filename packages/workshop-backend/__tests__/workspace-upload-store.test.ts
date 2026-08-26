import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import type { WorkspaceUpload } from "../src/workspace-repository";
import { WorkspaceUploadStore } from "../src/workspace-upload-store";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    WORKSPACE_FILES: R2Bucket;
  }
}

const OPERATION_ONE = "00000000-0000-4000-8000-000000000001";
const OPERATION_TWO = "00000000-0000-4000-8000-000000000002";

function workspace(name: string): DurableObjectStub<OverseerDurableObject> {
  return env.TEST_OVERSEER.getByName(`workspace-upload-store:${name}`);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function stream(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller): void {
      controller.enqueue(content);
      controller.close();
    },
  });
}

async function expectErrorCode(operation: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (candidate) {
    error = candidate;
  }
  expect(error).toMatchObject({ code });
}

async function withStore<T>(
  name: string,
  run: (store: WorkspaceUploadStore, workspaceId: string, state: DurableObjectState) => Promise<T>,
  maxPendingUploadBytes?: number,
): Promise<T> {
  return runInDurableObject(workspace(name), (_instance, state) => {
    const workspaceId = state.id.toString();
    return run(new WorkspaceUploadStore({
      state,
      bucket: env.WORKSPACE_FILES,
      workspaceId,
      ...(maxPendingUploadBytes === undefined ? {} : { maxPendingUploadBytes }),
    }), workspaceId, state);
  });
}

describe("WorkspaceUploadStore", () => {
  it("stages and consumes an upload once, while allowing an exact operation retry", async () => {
    const result = await withStore("stage-consume", async store => {
      const content = bytes("payload");
      const upload = await store.stageUpload("user:aleksey", {
        content: stream(content),
        size: content.byteLength,
        mediaType: "text/plain",
      });

      const consumed = await store.consumeUpload(upload.uploadId, "user:aleksey", OPERATION_ONE);
      const replay = await store.consumeUpload(upload.uploadId, "user:aleksey", OPERATION_ONE);
      return { upload, consumed, replay };
    });

    expect(result.upload).toMatchObject<Partial<WorkspaceUpload>>({
      size: 7,
      mediaType: "text/plain",
    });
    expect(result.consumed).toEqual({
      uploadId: result.upload.uploadId,
      size: 7,
      mediaType: "text/plain",
      content: bytes("payload"),
    });
    expect(result.replay).toEqual(result.consumed);
  });

  it("authorizes consumption by owner and operation", async () => {
    await withStore("authorization", async store => {
      const content = bytes("payload");
      const upload = await store.stageUpload("user:aleksey", {
        content: stream(content),
        size: content.byteLength,
      });

      await expectErrorCode(
        store.consumeUpload(upload.uploadId, "user:other", OPERATION_ONE),
        "WORKSPACE_FILE_UPLOAD_ACCESS_DENIED",
      );
      await store.consumeUpload(upload.uploadId, "user:aleksey", OPERATION_ONE);
      await expectErrorCode(
        store.consumeUpload(upload.uploadId, "user:aleksey", OPERATION_TWO),
        "WORKSPACE_FILE_UPLOAD_UNAVAILABLE",
      );
    });
  });

  it("rejects content whose stored size or digest does not match the staged upload", async () => {
    await withStore("integrity", async (store, workspaceId) => {
      const sizeUpload = await store.stageUpload("user:aleksey", {
        content: stream(bytes("payload")),
        size: 7,
      });
      const sizeObjects = await env.WORKSPACE_FILES.list({
        prefix: `workspaces/${workspaceId}/uploads/${sizeUpload.uploadId}`,
      });
      await env.WORKSPACE_FILES.put(sizeObjects.objects[0].key, bytes("short"));
      await expectErrorCode(
        store.consumeUpload(sizeUpload.uploadId, "user:aleksey", OPERATION_ONE),
        "WORKSPACE_FILE_UPLOAD_INTEGRITY_FAILED",
      );

      const digestUpload = await store.stageUpload("user:aleksey", {
        content: stream(bytes("payload")),
        size: 7,
      });
      const digestObjects = await env.WORKSPACE_FILES.list({
        prefix: `workspaces/${workspaceId}/uploads/${digestUpload.uploadId}`,
      });
      await env.WORKSPACE_FILES.put(digestObjects.objects[0].key, bytes("changed"));
      await expectErrorCode(
        store.consumeUpload(digestUpload.uploadId, "user:aleksey", OPERATION_TWO),
        "WORKSPACE_FILE_UPLOAD_INTEGRITY_FAILED",
      );
    });
  });

  it("removes expired uploads and their objects", async () => {
    const result = await withStore("cleanup", async (store, workspaceId, state) => {
      const upload = await store.stageUpload("user:aleksey", {
        content: stream(bytes("payload")),
        size: 7,
      });
      state.storage.sql.exec(
        "UPDATE workspace_file_uploads SET expires_at = 0 WHERE upload_id = ?",
        upload.uploadId,
      );
      await expectErrorCode(
        store.consumeUpload(upload.uploadId, "user:aleksey", OPERATION_ONE),
        "WORKSPACE_FILE_UPLOAD_UNAVAILABLE",
      );

      const before = await env.WORKSPACE_FILES.list({
        prefix: `workspaces/${workspaceId}/uploads/${upload.uploadId}`,
      });
      const cleaned = await store.cleanupExpiredUploads(0);
      const after = await env.WORKSPACE_FILES.list({
        prefix: `workspaces/${workspaceId}/uploads/${upload.uploadId}`,
      });
      return { before, after, cleaned, nextExpiry: store.getNextUploadExpiry() };
    });

    expect(result.before.objects).toHaveLength(1);
    expect(result.after.objects).toHaveLength(0);
    expect(result.cleaned).toBe(1);
    expect(result.nextExpiry).toBeUndefined();
  });

  it("releases a failed stream reservation and enforces pending capacity", async () => {
    await withStore("limits", async store => {
      await expectErrorCode(store.stageUpload("user:aleksey", {
        content: stream(bytes("short")),
        size: 7,
      }), "WORKSPACE_FILE_INVALID_REQUEST");

      await store.stageUpload("user:aleksey", {
        content: stream(bytes("1234")),
        size: 4,
      });
      await expectErrorCode(store.stageUpload("user:aleksey", {
        content: stream(bytes("5678")),
        size: 4,
      }), "WORKSPACE_FILE_UPLOAD_QUOTA_EXCEEDED");
    }, 7);
  });
});
