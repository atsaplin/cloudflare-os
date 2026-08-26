import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ArtifactsWorkspaceFiles,
  type ArtifactsWorkspaceFileLifecycle,
  type ArtifactsWorkspaceFileUploadStore,
} from "../src/artifacts-workspace-files";
import {
  WORKSPACE_INDEX_PATH,
  createEmptyWorkspaceIndex,
  createWorkspaceNode,
  serializeWorkspaceIndex,
} from "../src/workspace-manifest";
import { MAXIMUM_WORKSPACE_TOTAL_BYTES } from "@gadgets/workshop-shared/api";
import type {
  WorkspaceArtifactAcceptResult,
  WorkspaceArtifactCanonical,
  WorkspaceArtifactForkStatus,
  WorkspaceArtifactMutation,
  WorkspaceArtifactReader,
} from "../src/workspace-artifacts";
import type {
  WorkspaceMutationRequest,
  WorkspaceUpload,
  WorkspaceUploadRequest,
} from "../src/workspace-files";
import { WorkspaceRepositoryConflictError } from "../src/workspace-files";
import type { CommitInfo } from "@gadgets/workshop-shared/api";
import type { WorkspaceActor } from "../src/workspace-files";
import type { WorkspaceUploadContent } from "../src/workspace-upload-store";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<unknown>;
  }
}

const ACTOR = { id: "user:aleksey", name: "Aleksey" };
const INITIAL_HEAD = "a".repeat(40);
const ROOT_ID = "00000000-0000-4000-8000-000000000100";

type Snapshot = Map<string, Uint8Array>;

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return new Map([...snapshot].map(([path, content]) => [path, new Uint8Array(content)]));
}

function nextHead(counter: number): string {
  return counter.toString(16).padStart(40, "0");
}

class InMemoryArtifacts implements ArtifactsWorkspaceFileLifecycle, WorkspaceArtifactReader {
  readonly canonical: WorkspaceArtifactCanonical;
  readonly snapshots = new Map<string, Map<string, Snapshot>>();
  readonly forks = new Map<string, WorkspaceArtifactForkStatus>();
  readonly stagedMutations: WorkspaceArtifactMutation[] = [];
  throwBeforeStage = false;
  throwAfterStage = false;
  throwAfterAccept = false;
  failCleanupOnce = false;
  deleted = false;
  #counter = 1;

  constructor() {
    const index = createEmptyWorkspaceIndex({
      actorId: ACTOR.id,
      now: "2026-08-26T00:00:00.000Z",
      createId: () => ROOT_ID,
    });
    this.canonical = {
      repositoryName: "workspace-canonical",
      remote: "https://artifacts.example/canonical",
      defaultBranch: "main",
      head: INITIAL_HEAD,
      rootId: index.rootId,
    };
    this.snapshots.set(this.canonical.repositoryName, new Map([
      [INITIAL_HEAD, new Map([[WORKSPACE_INDEX_PATH, serializeWorkspaceIndex(index)]])],
    ]));
  }

  seedMaximumFile(): void {
    const repository = this.snapshots.get(this.canonical.repositoryName);
    const snapshot = repository?.get(this.canonical.head);
    if (!snapshot) throw new Error("Test canonical snapshot is missing.");
    const index = createEmptyWorkspaceIndex({
      actorId: ACTOR.id,
      now: "2026-08-26T00:00:00.000Z",
      createId: () => ROOT_ID,
    });
    const file = createWorkspaceNode(index, {
      kind: "file",
      parentId: ROOT_ID,
      name: "maximum.bin",
      size: MAXIMUM_WORKSPACE_TOTAL_BYTES,
    }, {
      actorId: ACTOR.id,
      now: "2026-08-26T00:00:00.000Z",
      createId: () => "00000000-0000-4000-8000-000000000101",
    });
    snapshot.set(WORKSPACE_INDEX_PATH, serializeWorkspaceIndex(file.index));
  }

  ensureCanonical(): Promise<WorkspaceArtifactCanonical> {
    return Promise.resolve(this.canonical);
  }

  getCanonical(): Promise<WorkspaceArtifactCanonical> {
    return Promise.resolve(this.canonical);
  }

  getForkStatus(chatId: string, epoch: number): Promise<WorkspaceArtifactForkStatus | undefined> {
    const fork = this.forks.get(`${chatId}:${epoch}`);
    return Promise.resolve(fork === undefined ? undefined : { ...fork });
  }

  stageChatMutation(
    chatId: string,
    epoch: number,
    actor: WorkspaceActor,
    message: string,
    mutation: WorkspaceArtifactMutation,
  ): Promise<WorkspaceArtifactForkStatus> {
    void actor;
    void message;
    if (this.throwBeforeStage) throw new Error("Test failed before staging.");
    const key = `${chatId}:${epoch}`;
    const existing = this.forks.get(key);
    const baselineHead = existing?.baselineHead ?? this.canonical.head;
    const base = existing === undefined
      ? this.snapshots.get(this.canonical.repositoryName)?.get(baselineHead)
      : this.snapshots.get(existing.repositoryName)?.get(existing.latestHead);
    if (base === undefined) throw new Error("Test snapshot is missing.");
    const repositoryName = existing?.repositoryName ?? `fork-${chatId}`;
    const head = nextHead(this.#counter++);
    const snapshot = cloneSnapshot(base);
    for (const operation of mutation.operations) {
      if (operation.kind === "write") snapshot.set(operation.path, new Uint8Array(operation.content));
      else if (operation.kind === "delete") {
        for (const path of snapshot.keys()) {
          if (path === operation.path || path.startsWith(`${operation.path}/`)) snapshot.delete(path);
        }
      } else {
        const moved = [...snapshot.entries()]
          .filter(([path]) => path === operation.from || path.startsWith(`${operation.from}/`));
        for (const [path] of moved) snapshot.delete(path);
        for (const [path, content] of moved) {
          const suffix = path.slice(operation.from.length);
          snapshot.set(`${operation.to}${suffix}`, content);
        }
      }
    }
    const repoSnapshots = this.snapshots.get(repositoryName) ?? new Map<string, Snapshot>();
    repoSnapshots.set(head, snapshot);
    this.snapshots.set(repositoryName, repoSnapshots);
    const fork: WorkspaceArtifactForkStatus = {
      chatId,
      epoch,
      repositoryName,
      remote: `https://artifacts.example/${repositoryName}`,
      defaultBranch: "main",
      baselineHead,
      latestHead: head,
      sandboxId: `sandbox-${repositoryName}`,
      state: "open",
    };
    this.forks.set(key, fork);
    this.stagedMutations.push(mutation);
    if (this.throwAfterStage) throw new Error("Test lost the staged response.");
    return Promise.resolve(fork);
  }

  acceptChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactAcceptResult> {
    const key = `${chatId}:${epoch}`;
    const fork = this.forks.get(key);
    if (fork === undefined) return Promise.resolve({ status: "merged", head: this.canonical.head });
    if (fork.state === "accepted") {
      return Promise.resolve({ status: "merged", head: fork.acceptedHead ?? fork.latestHead });
    }
    if (fork.baselineHead !== this.canonical.head) {
      return Promise.resolve({
        status: "stale",
        expectedHead: fork.baselineHead,
        currentHead: this.canonical.head,
      });
    }
    const source = this.snapshots.get(fork.repositoryName)?.get(fork.latestHead);
    if (source === undefined) throw new Error("Test fork snapshot is missing.");
    const canonicalSnapshots = this.snapshots.get(this.canonical.repositoryName);
    if (canonicalSnapshots === undefined) throw new Error("Test canonical snapshot is missing.");
    canonicalSnapshots.set(fork.latestHead, cloneSnapshot(source));
    this.canonical.head = fork.latestHead;
    fork.state = "accepted";
    fork.acceptedHead = fork.latestHead;
    if (this.throwAfterAccept) throw new Error("Test lost the accepted response.");
    return Promise.resolve({ status: "merged", head: fork.latestHead });
  }

  completeAcceptedChatFork(chatId: string, epoch: number): Promise<void> {
    if (this.failCleanupOnce) {
      this.failCleanupOnce = false;
      throw new Error("Test lost the cleanup response.");
    }
    this.forks.delete(`${chatId}:${epoch}`);
    return Promise.resolve();
  }

  discardChatFork(chatId: string, epoch: number): Promise<void> {
    this.forks.delete(`${chatId}:${epoch}`);
    return Promise.resolve();
  }

  readCommitLog(): Promise<CommitInfo[]> {
    return Promise.resolve([]);
  }

  getHistory(): Promise<CommitInfo[]> {
    return Promise.resolve([]);
  }

  deleteWorkspaceRepositories(): Promise<void> {
    this.deleted = true;
    return Promise.resolve();
  }

  getHead(repositoryName: string): Promise<string | undefined> {
    if (repositoryName === this.canonical.repositoryName) return Promise.resolve(this.canonical.head);
    const snapshots = this.snapshots.get(repositoryName);
    return Promise.resolve(snapshots === undefined ? undefined : [...snapshots.keys()].at(-1));
  }

  listFiles(repositoryName: string, ref: string): Promise<string[]> {
    return Promise.resolve([...this.snapshots.get(repositoryName)?.get(ref)?.keys() ?? []]);
  }

  readFile(repositoryName: string, ref: string, path: string): Promise<Uint8Array> {
    const content = this.snapshots.get(repositoryName)?.get(ref)?.get(path);
    if (content === undefined) throw new Error(`Test file ${path} is missing.`);
    return Promise.resolve(new Uint8Array(content));
  }
}

class InMemoryUploads implements ArtifactsWorkspaceFileUploadStore {
  readonly values = new Map<string, WorkspaceUploadContent>();
  deleted = false;
  #counter = 200;

  async stageUpload(ownerId: string, request: WorkspaceUploadRequest): Promise<WorkspaceUpload> {
    const uploadId = `00000000-0000-4000-8000-${this.#counter.toString().padStart(12, "0")}`;
    this.#counter += 1;
    const content = new Uint8Array(await new Response(request.content).arrayBuffer());
    this.values.set(uploadId, {
      uploadId,
      size: content.byteLength,
      ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
      content,
    });
    void ownerId;
    return {
      uploadId,
      size: content.byteLength,
      ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
      expiresAt: "2026-08-27T00:00:00.000Z",
    };
  }

  getNextUploadExpiry(): number | undefined { return undefined; }

  cleanupExpiredUploads(): Promise<number> { return Promise.resolve(0); }

  deleteAllUploads(): Promise<void> {
    this.deleted = true;
    this.values.clear();
    return Promise.resolve();
  }

  consumeUpload(uploadId: string): Promise<WorkspaceUploadContent> {
    const value = this.values.get(uploadId);
    if (value === undefined) throw new Error("Test upload is missing.");
    return Promise.resolve({ ...value, content: new Uint8Array(value.content) });
  }
}

function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  return operation.then(
    () => { throw new Error(`Expected ${code}.`); },
    error => { expect(error).toMatchObject({ code }); },
  );
}

async function withFiles<T>(name: string, run: (files: ArtifactsWorkspaceFiles, artifacts: InMemoryArtifacts, uploads: InMemoryUploads) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`artifacts-workspace-files:${name}`), (_instance, state) => {
    const artifacts = new InMemoryArtifacts();
    const uploads = new InMemoryUploads();
    return run(new ArtifactsWorkspaceFiles({ state, lifecycle: artifacts, reader: artifacts, uploadStore: uploads }), artifacts, uploads);
  });
}

function textBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }

describe("ArtifactsWorkspaceFiles", () => {
  it("initializes, lists, reads, and commits stable-ID files with the manifest", async () => {
    const result = await withFiles("basic", async (files, artifacts) => {
      const initial = await files.initialize(ACTOR);
      const mutation: WorkspaceMutationRequest = {
        operationId: "00000000-0000-4000-8000-000000000201",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:00:00.000Z",
        message: "Add readme",
        changes: [
          { kind: "createFolder", clientId: "docs", parent: { nodeId: initial.rootId }, name: "docs" },
          { kind: "createFile", clientId: "readme", parent: { clientId: "docs" }, name: "README.md", content: textBytes("hello") },
        ],
      };
      const accepted = await files.apply(mutation);
      const node = await files.getNode(accepted.created.readme);
      return {
        accepted,
        node,
        bytes: await files.readFile(accepted.created.readme),
        operations: artifacts.stagedMutations[0]?.operations.map(operation => operation.kind === "write" ? operation.path : operation.kind),
        history: await files.getHistory(),
      };
    });

    expect(result.node).toMatchObject({ id: result.accepted.created.readme, path: "docs/README.md", size: 5 });
    expect(result.bytes).toEqual(textBytes("hello"));
    expect(result.operations).toEqual(["docs/README.md", WORKSPACE_INDEX_PATH]);
    expect(result.history).toEqual([]);
  });

  it("resolves sequential replace, move, and delete operations", async () => {
    const result = await withFiles("sequential", async files => {
      const initial = await files.initialize(ACTOR);
      const created = await files.apply({
        operationId: "00000000-0000-4000-8000-000000000202",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:00:00.000Z",
        message: "Create file",
        changes: [{ kind: "createFile", clientId: "file", parent: { nodeId: initial.rootId }, name: "old.txt", content: textBytes("old") }],
      });
      const moved = await files.apply({
        operationId: "00000000-0000-4000-8000-000000000203",
        expectedHead: created.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:01:00.000Z",
        message: "Move file",
        changes: [
          { kind: "replaceFile", nodeId: created.created.file, content: textBytes("new") },
          { kind: "move", nodeId: created.created.file, parent: { nodeId: initial.rootId }, name: "new.txt" },
        ],
      });
      const deleted = await files.apply({
        operationId: "00000000-0000-4000-8000-000000000204",
        expectedHead: moved.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:02:00.000Z",
        message: "Delete file",
        changes: [{ kind: "delete", nodeId: created.created.file }],
      });
      return { deleted, node: await files.getNode(created.created.file), root: await files.list(initial.rootId) };
    });
    expect(result.node).toBeUndefined();
    expect(result.root).toEqual([]);
    expect(result.deleted.created).toEqual({});
  });

  it("keeps empty-folder moves in the manifest without inventing Git paths", async () => {
    const result = await withFiles("empty-folder", async (files, artifacts) => {
      const initial = await files.initialize(ACTOR);
      const created = await files.apply({
        operationId: "00000000-0000-4000-8000-000000000208",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:02:00.000Z",
        message: "Create folder",
        changes: [{ kind: "createFolder", clientId: "folder", parent: { nodeId: initial.rootId }, name: "old" }],
      });
      await files.apply({
        operationId: "00000000-0000-4000-8000-000000000209",
        expectedHead: created.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:03:00.000Z",
        message: "Move folder",
        changes: [{ kind: "move", nodeId: created.created.folder, parent: { nodeId: initial.rootId }, name: "new" }],
      });
      return { node: await files.getNode(created.created.folder), operations: artifacts.stagedMutations[1]?.operations.map(operation => operation.kind === "write" ? operation.path : operation.kind) };
    });
    expect(result.node).toMatchObject({ path: "new", kind: "folder" });
    expect(result.operations).toEqual([WORKSPACE_INDEX_PATH]);
  });

  it("resolves staged uploads and retries an accepted operation exactly", async () => {
    const result = await withFiles("staged-retry", async (files, artifacts, uploads) => {
      const initial = await files.initialize(ACTOR);
      const upload = await files.stageUpload(ACTOR.id, {
        content: new ReadableStream({ start(controller): void { controller.enqueue(textBytes("staged")); controller.close(); } }),
        size: 6,
        mediaType: "text/plain",
      });
      const request = {
        operationId: "00000000-0000-4000-8000-000000000205",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:03:00.000Z",
        message: "Add staged file",
        changes: [{ kind: "createFile" as const, clientId: "file", parent: { nodeId: initial.rootId }, name: "staged.txt", uploadId: upload.uploadId }],
      };
      const first = await files.applyStaged(request);
      const second = await files.applyStaged({
        ...request,
        actor: { ...ACTOR, name: "Aleksey Tsaplin" },
        timestamp: "2026-08-26T01:04:00.000Z",
      });
      return { first, second, content: await files.readFile(first.created.file), stageCount: artifacts.stagedMutations.length, uploadCount: uploads.values.size };
    });
    expect(result.second).toEqual(result.first);
    expect(result.content).toEqual(textBytes("staged"));
    expect(result.stageCount).toBe(1);
    expect(result.uploadCount).toBe(1);
  });

  it("recovers an open fork when the staged response is lost", async () => {
    const result = await withFiles("staged-response", async (files, artifacts) => {
      const initial = await files.initialize(ACTOR);
      artifacts.throwAfterStage = true;
      const request: WorkspaceMutationRequest = {
        operationId: "00000000-0000-4000-8000-000000000210",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:05:00.000Z",
        message: "Recover staged response",
        changes: [{ kind: "createFile", clientId: "file", parent: { nodeId: initial.rootId }, name: "recovered.txt", content: textBytes("ok") }],
      };
      await expect(files.apply(request)).rejects.toThrow("lost the staged response");
      artifacts.throwAfterStage = false;
      const recovered = await files.apply(request);
      return { recovered, forks: artifacts.forks.size, stages: artifacts.stagedMutations.length };
    });
    expect(result.recovered.created.file).toMatch(/[0-9a-f-]{36}/);
    expect(result.forks).toBe(0);
    expect(result.stages).toBe(1);
  });

  it("reuses the original manifest metadata after a pre-stage retry", async () => {
    const result = await withFiles("pre-stage-retry", async (files, artifacts) => {
      const initial = await files.initialize(ACTOR);
      const request: WorkspaceMutationRequest = {
        operationId: "00000000-0000-4000-8000-000000000214",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:09:00.000Z",
        message: "Recover before stage",
        changes: [{
          kind: "createFolder",
          clientId: "folder",
          parent: { nodeId: initial.rootId },
          name: "folder",
        }],
      };
      artifacts.throwBeforeStage = true;
      await expect(files.apply(request)).rejects.toThrow("failed before staging");
      artifacts.throwBeforeStage = false;
      const accepted = await files.apply({
        ...request,
        actor: { ...ACTOR, name: "Aleksey Tsaplin" },
        timestamp: "2026-08-26T01:10:00.000Z",
      });
      return files.getNode(accepted.created.folder);
    });
    expect(result).toMatchObject({
      createdBy: ACTOR.id,
      createdAt: "2026-08-26T01:09:00.000Z",
    });
  });

  it("retries a committed operation to finish accepted-fork cleanup", async () => {
    const result = await withFiles("accepted-response", async (files, artifacts) => {
      const initial = await files.initialize(ACTOR);
      const request: WorkspaceMutationRequest = {
        operationId: "00000000-0000-4000-8000-000000000211",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:06:00.000Z",
        message: "Recover accepted response",
        changes: [{ kind: "createFolder", clientId: "folder", parent: { nodeId: initial.rootId }, name: "folder" }],
      };
      artifacts.failCleanupOnce = true;
      await expect(files.apply(request)).rejects.toThrow("lost the cleanup response");
      const second = await files.apply(request);
      return { second, forks: artifacts.forks.size };
    });
    expect(result.second.operationId).toBe("00000000-0000-4000-8000-000000000211");
    expect(result.forks).toBe(0);
  });

  it("recovers when the accepted response is lost after canonical advances", async () => {
    const result = await withFiles("lost-accepted-response", async (files, artifacts) => {
      const initial = await files.initialize(ACTOR);
      const request: WorkspaceMutationRequest = {
        operationId: "00000000-0000-4000-8000-000000000213",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:08:00.000Z",
        message: "Recover accepted response",
        changes: [{
          kind: "createFolder",
          clientId: "folder",
          parent: { nodeId: initial.rootId },
          name: "folder",
        }],
      };
      artifacts.throwAfterAccept = true;
      await expect(files.apply(request)).rejects.toThrow("lost the accepted response");
      artifacts.throwAfterAccept = false;
      const recovered = await files.apply(request);
      return { recovered, canonicalHead: artifacts.canonical.head, forks: artifacts.forks.size };
    });
    expect(result.recovered.head).toBe(result.canonicalHead);
    expect(result.forks).toBe(0);
  });

  it("enforces the aggregate manifest file-size quota before staging", async () => {
    await withFiles("quota", async (files, artifacts) => {
      artifacts.seedMaximumFile();
      const initial = await files.initialize(ACTOR);
      await expectCode(files.apply({
        operationId: "00000000-0000-4000-8000-000000000212",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:07:00.000Z",
        message: "Exceed quota",
        changes: [{ kind: "createFile", clientId: "too-large", parent: { nodeId: initial.rootId }, name: "too-large.txt", content: textBytes("x") }],
      }), "WORKSPACE_FILE_QUOTA_EXCEEDED");
      expect(artifacts.stagedMutations).toHaveLength(0);
    });
  });

  it("deletes staged uploads and every workspace Artifacts repository", async () => {
    const result = await withFiles("delete-all", async (files, artifacts, uploads) => {
      await files.deleteAllWorkspaceFiles();
      return { artifactsDeleted: artifacts.deleted, uploadsDeleted: uploads.deleted };
    });
    expect(result).toEqual({ artifactsDeleted: true, uploadsDeleted: true });
  });

  it("persists operation identity before staging and rejects reuse or stale heads", async () => {
    await withFiles("operation", async files => {
      const initial = await files.initialize(ACTOR);
      const request = {
        operationId: "00000000-0000-4000-8000-000000000206",
        expectedHead: initial.head,
        actor: ACTOR,
        timestamp: "2026-08-26T01:04:00.000Z",
        message: "Create file",
        changes: [{ kind: "createFile" as const, clientId: "file", parent: { nodeId: initial.rootId }, name: "one.txt", content: textBytes("one") }],
      };
      await files.apply(request);
      await expectCode(files.apply({ ...request, changes: [{ ...request.changes[0], name: "different.txt" }] }), "WORKSPACE_FILE_OPERATION_REUSED");
      await expect(files.apply({
        ...request,
        operationId: "00000000-0000-4000-8000-000000000207",
        changes: [{ kind: "createFolder", clientId: "stale", parent: { nodeId: initial.rootId }, name: "stale" }],
      })).rejects.toBeInstanceOf(WorkspaceRepositoryConflictError);
    });
  });
});
