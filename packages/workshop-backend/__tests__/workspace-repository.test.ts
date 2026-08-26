import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import {
  WorkspaceRepository,
  WorkspaceRepositoryConflictError,
  parseWorkspaceUploadMediaType,
  requirePendingUploadCapacity,
  type WorkspaceRepositoryFailurePoint,
} from "../src/workspace-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    WORKSPACE_FILES: R2Bucket;
  }
}

const ROOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function workspace(name: string): DurableObjectStub<OverseerDurableObject> {
  return env.TEST_OVERSEER.getByName(`workspace-repository:${name}`);
}

async function withRepository<T>(
  name: string,
  run: (
    repository: WorkspaceRepository,
    workspaceId: string,
    state: DurableObjectState,
  ) => Promise<T>,
  failAt?: WorkspaceRepositoryFailurePoint,
  maxWorkspaceBytes?: number,
  maxPendingUploadBytes?: number,
): Promise<T> {
  return runInDurableObject(workspace(name), (_instance, state) => {
    const workspaceId = state.id.toString();
    return run(new WorkspaceRepository({
      state,
      bucket: env.WORKSPACE_FILES,
      workspaceId,
      ...(maxWorkspaceBytes === undefined ? {} : { maxWorkspaceBytes }),
      ...(maxPendingUploadBytes === undefined ? {} : { maxPendingUploadBytes }),
      ...(failAt === undefined ? {} : {
        injectFailure: (point) => {
          if (point === failAt) throw new Error(`Injected failure at ${point}`);
        },
      }),
    }), workspaceId, state);
  });
}

describe("WorkspaceRepository", () => {
  it("initializes one durable versioned filesystem inside the owning workspace", async () => {
    const first = await withRepository("initialize", (repository) =>
      repository.initialize({ id: "user:aleksey", name: "Aleksey" }));

    await abortAllDurableObjects();

    const second = await withRepository("initialize", async (repository) => ({
      revision: await repository.initialize({ id: "user:other", name: "Other" }),
      root: await repository.getNode(first.rootId),
      history: await repository.getHistory(10),
    }));

    expect(first.head).toMatch(/^[0-9a-f]{40}$/);
    expect(first.rootId).toMatch(ROOT_ID_PATTERN);
    expect(second.revision).toEqual(first);
    expect(second.root).toMatchObject({
      id: first.rootId,
      kind: "folder",
      path: "",
      createdBy: "user:aleksey",
    });
    expect(second.history).toEqual([
      expect.objectContaining({ oid: first.head, message: "Initialize workspace\n" }),
    ]);
  });

  it("commits a binary file and stable identity as one idempotent mutation", async () => {
    const result = await withRepository("binary", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const request = {
        operationId: "00000000-0000-4000-8000-000000000010",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:10:00.000Z",
        message: "Add project files",
        changes: [
          {
            kind: "createFolder" as const,
            clientId: "folder",
            parent: { nodeId: initial.rootId },
            name: "project",
          },
          {
            kind: "createFile" as const,
            clientId: "file",
            parent: { clientId: "folder" as const },
            name: "payload.bin",
            mediaType: "application/octet-stream",
            content: new Uint8Array([0, 255, 1, 128]),
          },
        ],
      };

      const first = await repository.apply(request);
      const second = await repository.apply({
        ...request,
        actor: { name: request.actor.name, id: request.actor.id },
      });
      const fileId = first.created.file;
      return {
        first,
        second,
        revision: await repository.getRevision(),
        file: await repository.getNode(fileId),
        content: await repository.readFile(fileId),
        streamContent: new Uint8Array(await new Response(
          await repository.readFileStream(fileId),
        ).arrayBuffer()),
        history: await repository.getHistory(10),
      };
    });

    expect(result.second).toEqual(result.first);
    expect(result.file).toMatchObject({
      id: result.first.created.file,
      path: "project/payload.bin",
      mediaType: "application/octet-stream",
      size: 4,
    });
    expect(result.content).toEqual(new Uint8Array([0, 255, 1, 128]));
    expect(result.streamContent).toEqual(result.content);
    expect(result.revision).toEqual({ head: result.first.head, rootId: result.first.rootId });
    expect(result.history).toHaveLength(2);
    expect(result.history[0]).toMatchObject({
      oid: result.first.head,
      message: expect.stringContaining("00000000-0000-4000-8000-000000000010"),
    });
  });

  it("serializes mutations and rejects a stale expected head", async () => {
    const outcomes = await withRepository("conflict", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const makeRequest = (operationId: string, name: string) => ({
        operationId,
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:11:00.000Z",
        message: `Create ${name}`,
        changes: [{
          kind: "createFolder" as const,
          clientId: name,
          parent: { nodeId: initial.rootId },
          name,
        }],
      });
      return Promise.allSettled([
        repository.apply(makeRequest("00000000-0000-4000-8000-000000000020", "one")),
        repository.apply(makeRequest("00000000-0000-4000-8000-000000000021", "two")),
      ]);
    });

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(WorkspaceRepositoryConflictError) });
  });

  it("reserves operation trailers for repository recovery metadata", async () => {
    await withRepository("reserved-trailer", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      await expect(repository.apply({
        operationId: "00000000-0000-4000-8000-000000000025",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:11:30.000Z",
        message: "Pretend\n\nWorkspace-Operation: 00000000-0000-4000-8000-000000000024",
        changes: [{
          kind: "createFolder",
          clientId: "folder",
          parent: { nodeId: initial.rootId },
          name: "folder",
        }],
      })).rejects.toThrow(/reserved recovery metadata/i);
    });
  });

  it("recovers an interrupted worktree after Durable Object eviction", async () => {
    const name = "recovery";
    const initial = await withRepository(name, (repository) =>
      repository.initialize({ id: "user:aleksey", name: "Aleksey" }));
    const request = {
      operationId: "00000000-0000-4000-8000-000000000030",
      expectedHead: initial.head,
      actor: { id: "agent:7", name: "Agent 7" },
      timestamp: "2026-08-26T04:12:00.000Z",
      message: "Create recovered file",
      changes: [{
        kind: "createFile" as const,
        clientId: "file",
        parent: { nodeId: initial.rootId as string },
        name: "recovered.txt",
        mediaType: "text/plain",
        content: new TextEncoder().encode("recovered"),
      }],
    };

    await expect(withRepository(name, (repository) => repository.apply(request), "afterWorktree"))
      .rejects.toThrow("Injected failure at afterWorktree");

    await abortAllDurableObjects();

    const recovered = await withRepository(name, async (repository) => {
      const result = await repository.apply(request);
      return {
        result,
        content: await repository.readFile(result.created.file),
        history: await repository.getHistory(10),
      };
    });

    expect(new TextDecoder().decode(recovered.content)).toBe("recovered");
    expect(recovered.history).toHaveLength(2);
    expect(recovered.history[0].oid).toBe(recovered.result.head);
  });

  it("never exposes an abandoned worktree through accepted reads", async () => {
    const name = "read-recovery";
    const accepted = await withRepository(name, async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      return repository.apply({
        operationId: "00000000-0000-4000-8000-000000000035",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:12:30.000Z",
        message: "Create accepted file",
        changes: [{
          kind: "createFile",
          clientId: "file",
          parent: { nodeId: initial.rootId },
          name: "accepted.txt",
          content: new TextEncoder().encode("accepted"),
          mediaType: "text/plain",
        }],
      });
    });
    const abandoned = {
      operationId: "00000000-0000-4000-8000-000000000036",
      expectedHead: accepted.head,
      actor: { id: "agent:7", name: "Agent 7" },
      timestamp: "2026-08-26T04:12:31.000Z",
      message: "Abandoned replacement",
      changes: [
        {
          kind: "replaceFile" as const,
          nodeId: accepted.created.file,
          content: new TextEncoder().encode("uncommitted"),
          mediaType: "text/plain",
        },
        {
          kind: "createFolder" as const,
          clientId: "hidden",
          parent: { nodeId: accepted.rootId as string },
          name: "hidden",
        },
      ],
    };
    await expect(withRepository(
      name,
      (repository) => repository.apply(abandoned),
      "afterWorktree",
    )).rejects.toThrow("Injected failure at afterWorktree");
    await abortAllDurableObjects();

    const visible = await withRepository(name, async (repository) => ({
      node: await repository.getNode(accepted.created.file),
      children: await repository.list(accepted.rootId),
      content: await repository.readFile(accepted.created.file),
    }));

    expect(visible.node?.path).toBe("accepted.txt");
    expect(visible.children.map((node) => node.name)).toEqual(["accepted.txt"]);
    expect(new TextDecoder().decode(visible.content)).toBe("accepted");
  });

  it("finalizes a commit whose response was interrupted", async () => {
    const name = "post-commit-recovery";
    const initial = await withRepository(name, (repository) =>
      repository.initialize({ id: "user:aleksey", name: "Aleksey" }));
    const request = {
      operationId: "00000000-0000-4000-8000-000000000040",
      expectedHead: initial.head,
      actor: { id: "agent:7", name: "Agent 7" },
      timestamp: "2026-08-26T04:13:00.000Z",
      message: "Commit before response loss",
      changes: [{
        kind: "createFolder" as const,
        clientId: "folder",
        parent: { nodeId: initial.rootId as string },
        name: "committed",
      }],
    };

    await expect(withRepository(name, (repository) => repository.apply(request), "afterCommit"))
      .rejects.toThrow("Injected failure at afterCommit");
    await abortAllDurableObjects();

    const recovered = await withRepository(name, async (repository) => ({
      result: await repository.apply(request),
      history: await repository.getHistory(10),
    }));

    expect(recovered.history).toHaveLength(2);
    expect(recovered.result.head).toBe(recovered.history[0].oid);
    expect(recovered.history[0].message).toContain(request.operationId);
  });

  it("cleans an abandoned mutation before applying a different operation", async () => {
    const name = "abandoned-operation";
    const initial = await withRepository(name, (repository) =>
      repository.initialize({ id: "user:aleksey", name: "Aleksey" }));
    const abandoned = {
      operationId: "00000000-0000-4000-8000-000000000050",
      expectedHead: initial.head,
      actor: { id: "agent:7", name: "Agent 7" },
      timestamp: "2026-08-26T04:14:00.000Z",
      message: "Abandoned change",
      changes: [{
        kind: "createFolder" as const,
        clientId: "abandoned",
        parent: { nodeId: initial.rootId as string },
        name: "abandoned",
      }],
    };
    await expect(withRepository(
      name,
      (repository) => repository.apply(abandoned),
      "afterWorktree",
    )).rejects.toThrow("Injected failure at afterWorktree");
    await abortAllDurableObjects();

    const committed = await withRepository(name, async (repository) => {
      const result = await repository.apply({
        operationId: "00000000-0000-4000-8000-000000000051",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:15:00.000Z",
        message: "Accepted change",
        changes: [{
          kind: "createFolder",
          clientId: "accepted",
          parent: { nodeId: initial.rootId },
          name: "accepted",
        }],
      });
      return {
        accepted: await repository.getNode(result.created.accepted),
        children: await repository.list(initial.rootId),
        history: await repository.getHistory(10),
      };
    });

    expect(committed.accepted?.path).toBe("accepted");
    expect(committed.children.map((node) => node.name)).toEqual(["accepted"]);
    expect(committed.history).toHaveLength(2);
  });

  it("materializes versioned empty folders after recovery", async () => {
    const name = "empty-folder-recovery";
    const accepted = await withRepository(name, async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      return repository.apply({
        operationId: "00000000-0000-4000-8000-000000000055",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:15:30.000Z",
        message: "Create empty folder",
        changes: [{
          kind: "createFolder",
          clientId: "empty",
          parent: { nodeId: initial.rootId },
          name: "empty",
        }],
      });
    });
    await expect(withRepository(name, (repository) => repository.apply({
      operationId: "00000000-0000-4000-8000-000000000056",
      expectedHead: accepted.head,
      actor: { id: "agent:7", name: "Agent 7" },
      timestamp: "2026-08-26T04:15:31.000Z",
      message: "Abandoned change",
      changes: [{
        kind: "createFolder",
        clientId: "abandoned",
        parent: { nodeId: accepted.rootId },
        name: "abandoned",
      }],
    }), "afterWorktree")).rejects.toThrow("Injected failure at afterWorktree");
    await abortAllDurableObjects();

    const moved = await withRepository(name, async (repository) => repository.apply({
      operationId: "00000000-0000-4000-8000-000000000057",
      expectedHead: accepted.head,
      actor: { id: "user:aleksey", name: "Aleksey" },
      timestamp: "2026-08-26T04:15:32.000Z",
      message: "Rename empty folder",
      changes: [{
        kind: "move",
        nodeId: accepted.created.empty,
        parent: { nodeId: accepted.rootId },
        name: "renamed",
      }],
    }));

    expect(await withRepository(name, (repository) =>
      repository.getNode(accepted.created.empty))).toMatchObject({
      id: accepted.created.empty,
      path: "renamed",
    });
    expect(moved.head).not.toBe(accepted.head);
  });

  it("preserves files and folders when a move names their existing path", async () => {
    await withRepository("same-path-move", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const accepted = await repository.apply({
        operationId: "00000000-0000-4000-8000-000000000058",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:15:33.000Z",
        message: "Create same-path fixtures",
        changes: [{
          kind: "createFolder",
          clientId: "folder",
          parent: { nodeId: initial.rootId },
          name: "Documents",
        }, {
          kind: "createFile",
          clientId: "file",
          parent: { nodeId: initial.rootId },
          name: "notes.txt",
          content: new TextEncoder().encode("keep me"),
        }],
      });
      const repeated = await repository.apply({
        operationId: "00000000-0000-4000-8000-000000000059",
        expectedHead: accepted.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:15:34.000Z",
        message: "Keep existing names",
        changes: [{
          kind: "move",
          nodeId: accepted.created.folder,
          parent: { nodeId: initial.rootId },
          name: "Documents",
        }, {
          kind: "move",
          nodeId: accepted.created.file,
          parent: { nodeId: initial.rootId },
          name: "notes.txt",
        }],
      });

      expect(repeated.head).toBe(accepted.head);
      expect(new TextDecoder().decode(await repository.readFile(accepted.created.file)))
        .toBe("keep me");
      expect(await repository.getNode(accepted.created.folder)).toMatchObject({
        id: accepted.created.folder,
        path: "Documents",
      });
    });
  });

  it("spills large binary workspace files to R2 and reads them after eviction", async () => {
    const name = "r2-spillover";
    const content = new Uint8Array(1_600_000);
    content[0] = 1;
    content[content.length - 1] = 255;
    const created = await withRepository(name, async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      return repository.apply({
        operationId: "00000000-0000-4000-8000-000000000060",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:16:00.000Z",
        message: "Add large binary",
        changes: [{
          kind: "createFile",
          clientId: "large",
          parent: { nodeId: initial.rootId },
          name: "large.bin",
          content,
          mediaType: "application/octet-stream",
        }],
      });
    });

    expect((await env.WORKSPACE_FILES.list()).objects.length).toBeGreaterThan(0);
    await abortAllDurableObjects();

    const read = await withRepository(name, (repository) =>
      repository.readFile(created.created.large));
    expect(read.byteLength).toBe(content.byteLength);
    expect(read[0]).toBe(1);
    expect(read[read.length - 1]).toBe(255);
  });

  it("stages bounded opaque uploads for exactly one caller-owned operation", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const stream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    await withRepository("staged-upload", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const upload = await repository.stageUpload("user:aleksey", {
        content: stream(),
        size: bytes.byteLength,
        mediaType: "application/zip",
      });
      expect(upload.uploadId).toMatch(ROOT_ID_PATTERN);

      const request = {
        operationId: "00000000-0000-4000-8000-000000000061",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:17:00.000Z",
        message: "Add archive",
        changes: [{
          kind: "createFile" as const,
          clientId: "archive",
          parent: { nodeId: initial.rootId },
          name: "project.zip",
          uploadId: upload.uploadId,
        }],
      };
      const first = await repository.applyStaged(request);
      expect(await repository.applyStaged(request)).toEqual(first);
      expect(await repository.readFile(first.created.archive)).toEqual(bytes);

      await expect(repository.applyStaged({
        ...request,
        operationId: "00000000-0000-4000-8000-000000000062",
        expectedHead: first.head,
      })).rejects.toThrow(/already been used/i);

      const otherUpload = await repository.stageUpload("user:other", {
        content: stream(),
        size: bytes.byteLength,
      });
      await expect(repository.applyStaged({
        ...request,
        operationId: "00000000-0000-4000-8000-000000000063",
        expectedHead: first.head,
        changes: [{ ...request.changes[0], uploadId: otherUpload.uploadId }],
      })).rejects.toThrow(/profile that staged/i);

      expect(repository.getNextUploadExpiry()).toEqual(expect.any(Number));
      expect(await repository.cleanupExpiredUploads(Number.MAX_SAFE_INTEGER)).toBe(2);
      expect(repository.getNextUploadExpiry()).toBeUndefined();
    });
  });

  it("replays a committed staged operation after its upload is cleaned up", async () => {
    await withRepository("staged-upload-replay", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const upload = await repository.stageUpload("user:aleksey", {
        content: new Blob(["durable"]).stream(),
        size: 7,
        mediaType: "text/plain",
      });
      const request = {
        operationId: "00000000-0000-4000-8000-000000000065",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:18:01.000Z",
        message: "Add durable file",
        changes: [{
          kind: "createFile" as const,
          clientId: "file",
          parent: { nodeId: initial.rootId },
          name: "durable.txt",
          uploadId: upload.uploadId,
        }],
      };
      const first = await repository.applyStaged(request);
      expect(await repository.cleanupExpiredUploads(Number.MAX_SAFE_INTEGER)).toBe(1);
      const replay = await repository.applyStaged({
        ...request,
        timestamp: "2026-08-26T04:18:02.000Z",
      });
      expect(replay).toEqual(first);
    });
  });

  it("recovers a staged operation evicted after its Git commit", async () => {
    const name = "staged-upload-post-commit";
    const prepared = await withRepository(name, async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const upload = await repository.stageUpload("user:aleksey", {
        content: new Blob(["committed"]).stream(),
        size: 9,
      });
      return { initial, upload };
    });
    const request = {
      operationId: "00000000-0000-4000-8000-000000000066",
      expectedHead: prepared.initial.head,
      actor: { id: "user:aleksey", name: "Aleksey" },
      timestamp: "2026-08-26T04:18:03.000Z",
      message: "Commit before eviction",
      changes: [{
        kind: "createFile" as const,
        clientId: "file",
        parent: { nodeId: prepared.initial.rootId },
        name: "committed.txt",
        uploadId: prepared.upload.uploadId,
      }],
    };

    await expect(withRepository(
      name,
      (repository) => repository.applyStaged(request),
      "afterCommit",
    )).rejects.toThrow(/Injected failure/);
    await abortAllDurableObjects();

    const recovered = await withRepository(name, (repository) => repository.applyStaged({
      ...request,
      timestamp: "2026-08-26T04:18:04.000Z",
    }));
    expect(new TextDecoder().decode(await withRepository(name, (repository) =>
      repository.readFile(recovered.created.file)))).toBe("committed");
  });

  it("bounds all staged bytes and objects retained by one workspace", () => {
    expect(() => requirePendingUploadCapacity(1, 3, 3, 5))
      .toThrow(/pending upload storage/i);
    expect(() => requirePendingUploadCapacity(1_000, 0, 0, 5))
      .toThrow(/pending upload storage/i);
    expect(() => requirePendingUploadCapacity(1, 3, 2, 5)).not.toThrow();
  });

  it("releases pending capacity when a staged upload is committed", async () => {
    await withRepository("staged-upload-capacity-release", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const first = await repository.stageUpload("user:aleksey", {
        content: new Blob(["123"]).stream(),
        size: 3,
      });
      await repository.applyStaged({
        operationId: "00000000-0000-4000-8000-000000000068",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:18:06.000Z",
        message: "Consume first upload",
        changes: [{
          kind: "createFile",
          clientId: "file",
          parent: { nodeId: initial.rootId },
          name: "first.txt",
          uploadId: first.uploadId,
        }],
      });

      await expect(repository.stageUpload("user:aleksey", {
        content: new Blob(["456"]).stream(),
        size: 3,
      })).resolves.toMatchObject({ size: 3 });
    }, undefined, undefined, 5);
  });

  it("deletes every R2 object owned by the workspace without touching other prefixes", async () => {
    await env.WORKSPACE_FILES.put("other-workspace/keep", "keep");
    let prefix = "";
    await withRepository("workspace-r2-delete", async (repository, workspaceId) => {
      prefix = `workspaces/${workspaceId}/`;
      await repository.stageUpload("user:aleksey", {
        content: new Blob(["temporary"]).stream(),
        size: 9,
      });
      await repository.deleteAllWorkspaceFiles();
    });

    expect((await env.WORKSPACE_FILES.list({ prefix })).objects).toEqual([]);
    expect(await env.WORKSPACE_FILES.get("other-workspace/keep")).not.toBeNull();
  });

  it("does not hold the workspace lock while receiving an upload stream", async () => {
    let releaseSecondChunk: (() => void) | undefined;
    const secondChunkReady = new Promise<void>(resolve => {
      releaseSecondChunk = resolve;
    });
    let firstChunkReceived: (() => void) | undefined;
    const firstChunkWasReceived = new Promise<void>(resolve => {
      firstChunkReceived = resolve;
    });

    await withRepository("stalled-upload", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const upload = repository.stageUpload("user:aleksey", {
        size: 2,
        content: new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new Uint8Array([1]));
            firstChunkReceived?.();
            await secondChunkReady;
            controller.enqueue(new Uint8Array([2]));
            controller.close();
          },
        }),
      });
      await firstChunkWasReceived;

      await expect(Promise.race([
        repository.getRevision(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Workspace read remained locked by upload.")), 100);
        }),
      ])).resolves.toEqual(initial);

      releaseSecondChunk?.();
      await expect(upload).resolves.toMatchObject({ size: 2 });
    });
  });

  it("cleans an R2 object when upload finalization is interrupted", async () => {
    const name = "upload-put-recovery";
    let prefix = "";
    await expect(withRepository(name, async (repository, workspaceId) => {
      prefix = `workspaces/${workspaceId}/uploads/`;
      await repository.stageUpload("user:aleksey", {
        content: new Blob(["temporary"]).stream(),
        size: 9,
      });
    }, "afterUploadPut")).rejects.toThrow(/Injected failure/);

    expect((await env.WORKSPACE_FILES.list({ prefix })).objects).toEqual([]);
  });

  it("rejects staged content whose R2 bytes no longer match its digest", async () => {
    await withRepository("staged-upload-integrity", async (repository, workspaceId) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      const upload = await repository.stageUpload("user:aleksey", {
        content: new Blob(["original"]).stream(),
        size: 8,
      });
      const listed = await env.WORKSPACE_FILES.list({
        prefix: `workspaces/${workspaceId}/uploads/${upload.uploadId}`,
      });
      expect(listed.objects).toHaveLength(1);
      await env.WORKSPACE_FILES.put(listed.objects[0].key, "tampered");

      await expect(repository.applyStaged({
        operationId: "00000000-0000-4000-8000-000000000067",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:18:05.000Z",
        message: "Add corrupted file",
        changes: [{
          kind: "createFile",
          clientId: "file",
          parent: { nodeId: initial.rootId },
          name: "corrupt.txt",
          uploadId: upload.uploadId,
        }],
      })).rejects.toThrow(/integrity/i);
    });
  });

  it("rejects staged streams whose content does not match the declared size", async () => {
    await withRepository("staged-upload-size", async (repository) => {
      await expect(repository.stageUpload("user:aleksey", {
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        size: 2,
      })).rejects.toThrow(/exceeds its declared size|did not reach the expected length/i);
    });
  });

  it("rejects media types that could inject object metadata headers", () => {
    expect(() => parseWorkspaceUploadMediaType("text/plain\r\nx-workspace: injected"))
      .toThrow(/valid media type/i);
    expect(parseWorkspaceUploadMediaType("application/zip")).toBe("application/zip");
  });

  it("rejects mutations that exceed the workspace storage quota", async () => {
    await withRepository("workspace-quota", async (repository) => {
      const initial = await repository.initialize({ id: "user:aleksey", name: "Aleksey" });
      await expect(repository.apply({
        operationId: "00000000-0000-4000-8000-000000000064",
        expectedHead: initial.head,
        actor: { id: "user:aleksey", name: "Aleksey" },
        timestamp: "2026-08-26T04:18:00.000Z",
        message: "Exceed quota",
        changes: [{
          kind: "createFile",
          clientId: "too-large",
          parent: { nodeId: initial.rootId },
          name: "payload.bin",
          content: new Uint8Array(1_024),
        }],
      })).rejects.toThrow(/storage cannot exceed/i);
      expect(await repository.getRevision()).toEqual(initial);
      expect(await repository.list(initial.rootId)).toEqual([]);
    }, undefined, 512);
  });
});
