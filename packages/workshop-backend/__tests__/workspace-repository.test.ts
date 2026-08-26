import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import {
  WorkspaceRepository,
  WorkspaceRepositoryConflictError,
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
  run: (repository: WorkspaceRepository) => Promise<T>,
  failAt?: WorkspaceRepositoryFailurePoint,
): Promise<T> {
  return runInDurableObject(workspace(name), (_instance, state) => run(new WorkspaceRepository({
    state,
    bucket: env.WORKSPACE_FILES,
    workspaceId: state.id.toString(),
    ...(failAt === undefined ? {} : {
      injectFailure: (point) => {
        if (point === failAt) throw new Error(`Injected failure at ${point}`);
      },
    }),
  })));
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
        file: await repository.getNode(fileId),
        content: await repository.readFile(fileId),
        history: await repository.getHistory(10),
      };
    });

    expect(result.second).toEqual(result.first);
    expect(result.file).toMatchObject({
      id: result.first.created.file,
      path: "project/payload.bin",
      mediaType: "application/octet-stream",
    });
    expect(result.content).toEqual(new Uint8Array([0, 255, 1, 128]));
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
});
