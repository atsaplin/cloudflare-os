import { env, runInDurableObject } from "cloudflare:test";
import type { ExecOptions, SandboxCommand } from "@cloudflare/sandbox";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import {
  CloudflareWorkspaceArtifactReader,
  ArtifactsWorkspaceRepository,
  SandboxWorkspaceArtifactGitRuntime,
  WorkspaceArtifactLifecycle,
  type WorkspaceArtifactControlPlane,
  type WorkspaceArtifactGitRuntime,
  type WorkspaceArtifactReader,
  type WorkspaceArtifactRepo,
  type WorkspaceArtifactSandbox,
  type WorkspaceArtifactMutation,
} from "../src/workspace-artifacts";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const INITIAL_HEAD = "1".repeat(40);
const CHECKPOINT_HEAD = "2".repeat(40);
const INITIAL_TREE = "a".repeat(40);

function commitFixture(hash: string, parents: string[] = []): Record<string, unknown> {
  return {
    hash,
    treeHash: INITIAL_TREE,
    message: "Workspace change\n",
    author: { name: "Aleksey", email: "aleksey@example.com" },
    committer: { name: "Aleksey", email: "aleksey@example.com" },
    parents,
    authoredAt: 1_700_000_000,
    committedAt: 1_700_000_000,
  };
}

class FakeRepo implements WorkspaceArtifactRepo {
  readonly tokens = new Map<string, "read" | "write">();
  readonly revoked: string[] = [];
  readonly commits = new Map<string, unknown>();
  readonly trees = new Map<string, unknown>();
  history: unknown = [];
  readonly logCalls: Array<{ ref: string; limit: number }> = [];

  constructor(
    readonly name: string,
    readonly remote: string,
    readonly defaultBranch = "main",
    readonly forkRepo?: (name: string) => Promise<FakeRepo>,
  ) {}

  async createToken(scope: "read" | "write"): Promise<{
    id: string;
    plaintext: string;
    scope: "read" | "write";
  }> {
    const id = `${this.name}-${scope}-${this.tokens.size}`;
    this.tokens.set(id, scope);
    return { id, plaintext: `${id}-secret`, scope };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    this.revoked.push(tokenOrId);
    this.tokens.delete(tokenOrId);
    return true;
  }

  async fork(name: string): Promise<{
    name: string;
    remote: string;
    defaultBranch: string;
    token: string;
  }> {
    if (!this.forkRepo) throw new Error("Forking is not configured.");
    const fork = await this.forkRepo(name);
    return {
      name: fork.name,
      remote: fork.remote,
      defaultBranch: fork.defaultBranch,
      token: `${fork.name}-initial-secret`,
    };
  }

  async log(options: { ref: string; limit: number }): Promise<unknown> {
    this.logCalls.push(options);
    return this.history;
  }

  readCommit(hash: string): Promise<unknown> {
    const commit = this.commits.get(hash);
    if (commit === undefined) throw new Error(`Missing commit fixture ${hash}`);
    return Promise.resolve(commit);
  }

  readTree(hash: string): Promise<unknown> {
    const tree = this.trees.get(hash);
    if (tree === undefined) throw new Error(`Missing tree fixture ${hash}`);
    return Promise.resolve(tree);
  }
}

class FakeArtifacts implements WorkspaceArtifactControlPlane {
  readonly repos = new Map<string, FakeRepo>();
  readonly deleted: string[] = [];
  creates = 0;
  forks = 0;

  constructor(readonly reader: FakeReader) {}

  async create(name: string): Promise<{
    name: string;
    remote: string;
    defaultBranch: string;
    token: string;
  }> {
    this.creates += 1;
    if (this.repos.has(name)) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
    const repo = this.makeRepo(name);
    this.repos.set(name, repo);
    return {
      name,
      remote: repo.remote,
      defaultBranch: repo.defaultBranch,
      token: `${name}-initial-secret`,
    };
  }

  async get(name: string): Promise<FakeRepo> {
    const repo = this.repos.get(name);
    if (!repo) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    return repo;
  }

  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.repos.delete(name);
  }

  private makeRepo(name: string): FakeRepo {
    return new FakeRepo(name, `https://artifacts.example/${name}.git`, "main", async forkName => {
      this.forks += 1;
      const fork = this.makeRepo(forkName);
      this.repos.set(forkName, fork);
      const head = this.reader.heads.get(name);
      if (head !== undefined) this.reader.heads.set(forkName, head);
      return fork;
    });
  }
}

class FakeReader implements WorkspaceArtifactReader {
  readonly heads = new Map<string, string>();
  readonly files = new Map<string, Uint8Array>();
  readonly listedFiles = new Map<string, string[]>();
  readonly listErrors = new Map<string, Error>();
  readonly listed: string[] = [];

  getHead(repoName: string): Promise<string | undefined> {
    return Promise.resolve(this.heads.get(repoName));
  }

  listFiles(repoName: string, ref: string): Promise<string[]> {
    this.listed.push(repoName);
    const error = this.listErrors.get(repoName);
    if (error) return Promise.reject(error);
    return Promise.resolve(this.listedFiles.get(`${repoName}:${ref}`) ?? []);
  }

  readFile(repoName: string, ref: string, path: string): Promise<Uint8Array> {
    const bytes = this.files.get(`${repoName}:${ref}:${path}`);
    if (!bytes) throw new Error(`Missing fixture ${repoName}:${ref}:${path}`);
    return Promise.resolve(bytes);
  }
}

class FakeGitRuntime implements WorkspaceArtifactGitRuntime {
  readonly initialized: string[] = [];
  readonly promotions: Array<{ canonical: string; fork: string; expectedHead: string }> = [];
  readonly destroyed: string[] = [];
  readonly prepared: string[] = [];
  readonly checkpoints: string[] = [];
  readonly stagedMutations: string[] = [];
  readonly mutations: WorkspaceArtifactMutation[] = [];
  readonly mutationExpectedHeads: string[] = [];
  promotionError: Error | undefined;
  beforePromotion: (() => void) | undefined;

  constructor(readonly reader: FakeReader) {}

  async initialize(request: {
    repositoryName: string;
    remote: string;
    token: string;
    index: Uint8Array;
  }): Promise<string> {
    this.initialized.push(request.repositoryName);
    this.reader.heads.set(request.repositoryName, INITIAL_HEAD);
    this.reader.files.set(
      `${request.repositoryName}:${INITIAL_HEAD}:.workspace/index.json`,
      request.index,
    );
    return INITIAL_HEAD;
  }

  async promote(request: {
    canonicalRepositoryName: string;
    canonicalRemote: string;
    canonicalToken: string;
    forkRepositoryName: string;
    forkRemote: string;
    forkToken: string;
    expectedCanonicalHead: string;
  }): Promise<string> {
    this.promotions.push({
      canonical: request.canonicalRepositoryName,
      fork: request.forkRepositoryName,
      expectedHead: request.expectedCanonicalHead,
    });
    this.beforePromotion?.();
    if (this.promotionError) throw this.promotionError;
    const head = this.reader.heads.get(request.forkRepositoryName);
    if (!head) throw new Error("Fork has no head.");
    this.reader.heads.set(request.canonicalRepositoryName, head);
    return head;
  }

  async destroy(sandboxId: string): Promise<void> {
    this.destroyed.push(sandboxId);
  }

  prepareChat(request: { sandboxId: string }): Promise<void> {
    this.prepared.push(request.sandboxId);
    return Promise.resolve();
  }

  checkpointChat(request: { sandboxId: string }): Promise<string> {
    this.checkpoints.push(request.sandboxId);
    return Promise.resolve(CHECKPOINT_HEAD);
  }

  stageChatMutation(request: {
    sandboxId: string;
    expectedHead: string;
    mutation: WorkspaceArtifactMutation;
  }): Promise<string> {
    this.stagedMutations.push(request.sandboxId);
    this.mutations.push(request.mutation);
    this.mutationExpectedHeads.push(request.expectedHead);
    return Promise.resolve(CHECKPOINT_HEAD);
  }
}

function fixture(): {
  artifacts: FakeArtifacts;
  reader: FakeReader;
  runtime: FakeGitRuntime;
} {
  const reader = new FakeReader();
  const artifacts = new FakeArtifacts(reader);
  return { artifacts, reader, runtime: new FakeGitRuntime(reader) };
}

function withLifecycle<T>(
  name: string,
  run: (
    lifecycle: WorkspaceArtifactLifecycle,
    fixtures: ReturnType<typeof fixture>,
    state: DurableObjectState,
  ) => Promise<T>,
): Promise<T> {
  const fixtures = fixture();
  return runInDurableObject(
    env.TEST_OVERSEER.getByName(`workspace-artifacts:${name}`),
    (_instance, state) => run(new WorkspaceArtifactLifecycle({
      state,
      workspaceId: state.id.toString(),
      artifacts: fixtures.artifacts,
      reader: fixtures.reader,
      gitRuntime: fixtures.runtime,
    }), fixtures, state),
  );
}

describe("WorkspaceArtifactLifecycle", () => {
  it("initializes one canonical Artifacts repository and stores no Git token", async () => {
    await withLifecycle("initialize", async (lifecycle, fixtures) => {
      const first = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const second = await lifecycle.ensureCanonical({ id: "user:other", name: "Other" });

      expect(second).toEqual(first);
      expect(first.head).toBe(INITIAL_HEAD);
      expect(first.repositoryName).toMatch(/^workspace-[0-9a-f]{40}$/);
      expect(fixtures.artifacts.creates).toBe(1);
      expect(fixtures.runtime.initialized).toEqual([first.repositoryName]);
      expect(JSON.stringify(first)).not.toContain("secret");
    });
  });

  it("creates one durable fork for a writable chat epoch", async () => {
    await withLifecycle("fork", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const first = await lifecycle.ensureChatFork("chat/one", 3);
      const second = await lifecycle.ensureChatFork("chat/one", 3);

      expect(second).toEqual(first);
      expect(first.baselineHead).toBe(canonical.head);
      expect(first.repositoryName).toMatch(/^workspace-[0-9a-f]{24}-chat-[0-9a-f]{24}-e3$/);
      expect(fixtures.artifacts.forks).toBe(1);
      expect(JSON.stringify(first)).not.toContain("secret");
    });
  });

  it("prepares and checkpoints the chat working copy with ephemeral credentials", async () => {
    await withLifecycle("working-copy", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.prepareChatWorkingCopy("chat-one", 1);

      expect(fixtures.runtime.prepared).toEqual([fork.sandboxId]);
      await expect(lifecycle.checkpointChatWorkingCopy("chat-one", 1, {
        id: "user:aleksey",
        name: "Aleksey",
      }, "Update notes")).resolves.toEqual({
        ...fork,
        latestHead: CHECKPOINT_HEAD,
      });
      expect(fixtures.runtime.checkpoints).toEqual([fork.sandboxId]);
      expect((await fixtures.artifacts.get(fork.repositoryName)).tokens.size).toBe(0);
    });
  });

  it("stages a file mutation into the chat fork and records its durable checkpoint", async () => {
    await withLifecycle("stage-mutation", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });

      const checkpoint = await lifecycle.stageChatMutation("chat-one", 1, {
        id: "user:aleksey",
        name: "Aleksey",
      }, "Update workspace", {
        operations: [
          { kind: "delete", path: "old.txt" },
          { kind: "write", path: "new.txt", content: new TextEncoder().encode("new\n") },
        ],
      });

      expect(checkpoint.latestHead).toBe(CHECKPOINT_HEAD);
      expect(fixtures.runtime.stagedMutations).toEqual([checkpoint.sandboxId]);
      expect((await fixtures.artifacts.get(checkpoint.repositoryName)).tokens.size).toBe(0);
    });
  });

  it("recovers a fork checkpoint pushed before its metadata persisted", async () => {
    await withLifecycle("stage-recovery", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);

      const checkpoint = await lifecycle.stageChatMutation("chat-one", 1, {
        id: "user:aleksey",
        name: "Aleksey",
      }, "Retry workspace update", { operations: [] });

      expect(checkpoint.latestHead).toBe(CHECKPOINT_HEAD);
      expect(fixtures.runtime.mutationExpectedHeads).toEqual([CHECKPOINT_HEAD]);
    });
  });

  it("reconciles a pushed fork head when reading its lifecycle status", async () => {
    await withLifecycle("fork-status-recovery", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("operation-one", 0);
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);

      await expect(lifecycle.getForkStatus("operation-one", 0)).resolves.toMatchObject({
        state: "open",
        baselineHead: INITIAL_HEAD,
        latestHead: CHECKPOINT_HEAD,
      });
      await expect(lifecycle.getChatFork("operation-one", 0)).resolves.toMatchObject({
        latestHead: CHECKPOINT_HEAD,
      });
    });
  });

  it("persists acceptance before deleting the chat fork", async () => {
    await withLifecycle("accept", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);

      const accepted = await lifecycle.acceptChatFork("chat-one", 1);

      expect(accepted).toEqual({ status: "merged", head: CHECKPOINT_HEAD });
      expect(fixtures.runtime.promotions).toEqual([{
        canonical: canonical.repositoryName,
        fork: fork.repositoryName,
        expectedHead: INITIAL_HEAD,
      }]);
      expect(fixtures.artifacts.deleted).not.toContain(fork.repositoryName);
      expect(fixtures.runtime.destroyed).not.toContain(fork.sandboxId);
      expect(await lifecycle.getChatFork("chat-one", 1)).toBeUndefined();

      await lifecycle.completeAcceptedChatFork("chat-one", 1, CHECKPOINT_HEAD);

      expect(fixtures.artifacts.deleted).toContain(fork.repositoryName);
      expect(fixtures.runtime.destroyed).toContain(fork.sandboxId);
    });
  });

  it("deletes every fork Sandbox and repository with the canonical workspace", async () => {
    await withLifecycle("delete-workspace", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const first = await lifecycle.ensureChatFork("chat-one", 1);
      const second = await lifecycle.ensureChatFork("chat-two", 1);

      await lifecycle.deleteWorkspaceRepositories();

      expect(fixtures.runtime.destroyed).toEqual([first.sandboxId, second.sandboxId]);
      expect(fixtures.artifacts.deleted).toEqual([
        first.repositoryName,
        second.repositoryName,
        canonical.repositoryName,
      ]);
      await expect(lifecycle.getCanonical()).resolves.toBeUndefined();
      await expect(lifecycle.getForkStatus("chat-one", 1)).resolves.toBeUndefined();
      await expect(lifecycle.deleteWorkspaceRepositories()).resolves.toBeUndefined();
    });
  });

  it("returns stale without promoting when canonical main moved", async () => {
    await withLifecycle("stale", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);
      fixtures.reader.heads.set(canonical.repositoryName, "f".repeat(40));
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);

      await expect(lifecycle.acceptChatFork("chat-one", 1)).resolves.toEqual({
        status: "stale",
        expectedHead: INITIAL_HEAD,
        currentHead: "f".repeat(40),
      });
      expect(fixtures.runtime.promotions).toEqual([]);
      expect(await lifecycle.getChatFork("chat-one", 1)).toMatchObject({
        repositoryName: fork.repositoryName,
        baselineHead: fork.baselineHead,
        latestHead: CHECKPOINT_HEAD,
      });
    });
  });

  it("returns stale when canonical main races the promotion", async () => {
    await withLifecycle("promotion-race", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);
      fixtures.runtime.promotionError = new Error("non-fast-forward");
      fixtures.runtime.beforePromotion = () => {
        fixtures.reader.heads.set(canonical.repositoryName, "f".repeat(40));
      };

      await expect(lifecycle.acceptChatFork("chat-one", 1)).resolves.toEqual({
        status: "stale",
        expectedHead: INITIAL_HEAD,
        currentHead: "f".repeat(40),
      });
      expect(await lifecycle.getChatFork("chat-one", 1)).toMatchObject({
        repositoryName: fork.repositoryName,
        baselineHead: fork.baselineHead,
        latestHead: CHECKPOINT_HEAD,
      });
    });
  });

  it("rejects an unsafe fork tree before promotion", async () => {
    await withLifecycle("unsafe-tree", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);
      fixtures.reader.listErrors.set(fork.repositoryName, new Error("unsupported symlink"));

      await expect(lifecycle.acceptChatFork("chat-one", 1)).rejects.toThrow(/symlink/i);

      expect(fixtures.reader.listed).toContain(fork.repositoryName);
      expect(fixtures.runtime.promotions).toEqual([]);
    });
  });

  it("finishes an accepted promotion after a Durable Object reset", async () => {
    await withLifecycle("accept-recovery", async (lifecycle, fixtures, state) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);
      fixtures.reader.heads.set(canonical.repositoryName, CHECKPOINT_HEAD);
      fixtures.reader.heads.set(fork.repositoryName, CHECKPOINT_HEAD);
      state.storage.sql.exec(`
        UPDATE workspace_artifact_forks
        SET state = 'accepting', latest_head = ?
        WHERE chat_id = ? AND epoch = ?
      `, CHECKPOINT_HEAD, "chat-one", 1);

      await expect(lifecycle.acceptChatFork("chat-one", 1)).resolves.toEqual({
        status: "merged",
        head: CHECKPOINT_HEAD,
      });
      expect(fixtures.runtime.promotions).toEqual([]);

      await lifecycle.completeAcceptedChatFork("chat-one", 1, CHECKPOINT_HEAD);

      expect(fixtures.artifacts.deleted).toContain(fork.repositoryName);
    });
  });

  it("discards a chat fork idempotently", async () => {
    await withLifecycle("discard", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const fork = await lifecycle.ensureChatFork("chat-one", 1);

      await lifecycle.discardChatFork("chat-one", 1);
      await lifecycle.discardChatFork("chat-one", 1);

      expect(fixtures.artifacts.deleted.filter(name => name === fork.repositoryName)).toHaveLength(1);
      expect(fixtures.runtime.destroyed.filter(id => id === fork.sandboxId)).toHaveLength(1);
    });
  });
});

describe("ArtifactsWorkspaceRepository", () => {
  it("reads bounded workspace history from the canonical Artifacts repository", async () => {
    await withLifecycle("repository-history", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "alice", name: "Alice" });
      const parent = "3".repeat(40);
      const head = "4".repeat(40);
      const artifactRepo = await fixtures.artifacts.get(canonical.repositoryName);
      artifactRepo.history = [commitFixture(head, [parent]), commitFixture(parent)];
      const repository = new ArtifactsWorkspaceRepository({ lifecycle, reader: fixtures.reader });

      await expect(repository.readCommitLog(head, { depth: 2 })).resolves.toEqual([
        {
          oid: head,
          parents: [parent],
          message: "Workspace change\n",
          author: { name: "Aleksey", email: "aleksey@example.com" },
          timestamp: new Date(1_700_000_000 * 1_000),
        },
        {
          oid: parent,
          parents: [],
          message: "Workspace change\n",
          author: { name: "Aleksey", email: "aleksey@example.com" },
          timestamp: new Date(1_700_000_000 * 1_000),
        },
      ]);
      expect(artifactRepo.logCalls).toEqual([{ ref: head, limit: 2 }]);
    });
  });

  it("reads default-branch history with the workspace history bound", async () => {
    await withLifecycle("repository-default-history", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "alice", name: "Alice" });
      const artifactRepo = await fixtures.artifacts.get(canonical.repositoryName);
      artifactRepo.history = [commitFixture(INITIAL_HEAD)];
      const repository = new ArtifactsWorkspaceRepository({ lifecycle, reader: fixtures.reader });

      await expect(repository.getHistory()).resolves.toHaveLength(1);
      expect(artifactRepo.logCalls).toEqual([{ ref: "main", limit: 50 }]);
    });
  });

  it("rejects malformed or over-sized Artifacts history responses", async () => {
    await withLifecycle("repository-history-bounds", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "alice", name: "Alice" });
      const artifactRepo = await fixtures.artifacts.get(canonical.repositoryName);
      const repository = new ArtifactsWorkspaceRepository({ lifecycle, reader: fixtures.reader });

      await expect(Promise.resolve().then(() => repository.getHistory(101)))
        .rejects.toThrow(/1 to 100/);
      artifactRepo.history = [commitFixture(INITIAL_HEAD), commitFixture("2".repeat(40))];
      await expect(repository.getHistory(1)).rejects.toThrow(/history response/i);
      artifactRepo.history = [{ ...commitFixture(INITIAL_HEAD), parents: ["not-a-sha"] }];
      await expect(repository.getHistory()).rejects.toThrow(/parent/i);
    });
  });

  it("reads one gadget subtree at an explicit workspace revision", async () => {
    await withLifecycle("repository-read", async (lifecycle, fixtures) => {
      const canonical = await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      fixtures.reader.listFiles = () => Promise.resolve([
        ".workspace/gadgets/7/client.js",
        ".workspace/gadgets/7/nested/data.json",
        ".workspace/gadgets/8/server.js",
      ]);
      fixtures.reader.files.set(
        `${canonical.repositoryName}:${canonical.head}:.workspace/gadgets/7/client.js`,
        new TextEncoder().encode("client\n"),
      );
      fixtures.reader.files.set(
        `${canonical.repositoryName}:${canonical.head}:.workspace/gadgets/7/nested/data.json`,
        new TextEncoder().encode("{}\n"),
      );
      const repository = new ArtifactsWorkspaceRepository({ lifecycle, reader: fixtures.reader });

      await expect(repository.readGadgetFiles(7, canonical.head)).resolves.toEqual(new Map([
        ["client.js", "client\n"],
        ["nested/data.json", "{}\n"],
      ]));
    });
  });

  it("stages changed gadgets as one chat-fork checkpoint", async () => {
    await withLifecycle("repository-stage", async (lifecycle, fixtures) => {
      await lifecycle.ensureCanonical({ id: "user:aleksey", name: "Aleksey" });
      const repository = new ArtifactsWorkspaceRepository({ lifecycle, reader: fixtures.reader });

      const checkpoint = await repository.stageGadgetFiles("chat-one", 1, {
        id: "user:aleksey",
        name: "Aleksey",
      }, "Accept changes", new Map([
        [7, new Map([["client.js", "client\n"]])],
        [8, new Map([["server.js", "server\n"]])],
      ]));

      expect(checkpoint.latestHead).toBe(CHECKPOINT_HEAD);
      expect(fixtures.runtime.mutations).toEqual([{
        operations: [
          { kind: "delete", path: ".workspace/gadgets/7" },
          {
            kind: "write",
            path: ".workspace/gadgets/7/client.js",
            content: new TextEncoder().encode("client\n"),
          },
          { kind: "delete", path: ".workspace/gadgets/8" },
          {
            kind: "write",
            path: ".workspace/gadgets/8/server.js",
            content: new TextEncoder().encode("server\n"),
          },
        ],
      }]);
    });
  });

  it("compares one gadget subtree across workspace revisions", async () => {
    await withLifecycle("gadget-diff", async (lifecycle, { reader }) => {
      const canonical = await lifecycle.ensureCanonical({ id: "alice", name: "Alice" });
      const repository = new ArtifactsWorkspaceRepository({ lifecycle, reader });
      const previous = "3".repeat(40);
      const current = "4".repeat(40);
      reader.listedFiles.set(`${canonical.repositoryName}:${previous}`, [
        ".workspace/gadgets/7/client.js",
        ".workspace/gadgets/7/removed.txt",
        ".workspace/gadgets/8/server.js",
      ]);
      reader.listedFiles.set(`${canonical.repositoryName}:${current}`, [
        ".workspace/gadgets/7/client.js",
        ".workspace/gadgets/7/added.txt",
        ".workspace/gadgets/8/server.js",
      ]);
      reader.files.set(
        `${canonical.repositoryName}:${previous}:.workspace/gadgets/7/client.js`,
        new TextEncoder().encode("same"),
      );
      reader.files.set(
        `${canonical.repositoryName}:${previous}:.workspace/gadgets/7/removed.txt`,
        new TextEncoder().encode("gone"),
      );
      reader.files.set(
        `${canonical.repositoryName}:${current}:.workspace/gadgets/7/client.js`,
        new TextEncoder().encode("same"),
      );
      reader.files.set(
        `${canonical.repositoryName}:${current}:.workspace/gadgets/7/added.txt`,
        new TextEncoder().encode("new"),
      );

      await expect(repository.changedGadgetPaths(7, previous, current)).resolves.toEqual(
        new Set(["added.txt", "removed.txt"]),
      );
    });
  });
});

describe("CloudflareWorkspaceArtifactReader", () => {
  it("reads the current head from the binding and one bounded file from REST", async () => {
    const readerState = new FakeReader();
    const artifacts = new FakeArtifacts(readerState);
    const repo = await artifacts.create("workspace-one");
    readerState.heads.set(repo.name, INITIAL_HEAD);
    const artifactRepo = await artifacts.get(repo.name);
    artifactRepo.history = [commitFixture(INITIAL_HEAD)];
    const requests: Request[] = [];
    const reader = new CloudflareWorkspaceArtifactReader({
      artifacts,
      accountId: "62f4d80db4b47c969f575420fa2aae29",
      namespace: "workshop-workspaces",
      apiToken: "rest-secret",
      fetch: async request => {
        requests.push(request);
        return new Response(new Uint8Array([0, 255, 1]), {
          headers: { "Content-Length": "3" },
        });
      },
    });

    await expect(reader.getHead(repo.name)).resolves.toBe(INITIAL_HEAD);
    await expect(reader.readFile(repo.name, INITIAL_HEAD, "folder/payload.bin", 3))
      .resolves.toEqual(new Uint8Array([0, 255, 1]));
    expect(requests[0].url).toContain(
      "/artifacts/namespaces/workshop-workspaces/repos/workspace-one/file?",
    );
    expect(new URL(requests[0].url).searchParams.get("ref")).toBe(INITIAL_HEAD);
    expect(new URL(requests[0].url).searchParams.get("path")).toBe("folder/payload.bin");
    expect(requests[0].headers.get("Authorization")).toBe("Bearer rest-secret");
  });

  it("rejects a declared file larger than the caller's bound before reading it", async () => {
    const readerState = new FakeReader();
    const artifacts = new FakeArtifacts(readerState);
    const reader = new CloudflareWorkspaceArtifactReader({
      artifacts,
      accountId: "62f4d80db4b47c969f575420fa2aae29",
      namespace: "workshop-workspaces",
      apiToken: "rest-secret",
      fetch: () => Promise.resolve(new Response("payload", {
        headers: { "Content-Length": "7" },
      })),
    });

    await expect(reader.readFile("workspace-one", INITIAL_HEAD, "payload.bin", 3))
      .rejects.toThrow(/exceeds/i);
  });

  it("rejects an undeclared response body larger than the caller's bound", async () => {
    const artifacts = new FakeArtifacts(new FakeReader());
    const reader = new CloudflareWorkspaceArtifactReader({
      artifacts,
      accountId: "62f4d80db4b47c969f575420fa2aae29",
      namespace: "workshop-workspaces",
      apiToken: "rest-secret",
      fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]))),
    });

    await expect(reader.readFile("workspace-one", INITIAL_HEAD, "payload.bin", 3))
      .rejects.toThrow(/exceeds/i);
  });

  it("rejects an invalid repository path before issuing the request", async () => {
    const artifacts = new FakeArtifacts(new FakeReader());
    let requested = false;
    const reader = new CloudflareWorkspaceArtifactReader({
      artifacts,
      accountId: "62f4d80db4b47c969f575420fa2aae29",
      namespace: "workshop-workspaces",
      apiToken: "rest-secret",
      fetch: () => {
        requested = true;
        return Promise.resolve(new Response());
      },
    });

    await expect(reader.readFile("workspace-one", INITIAL_HEAD, "../secret"))
      .rejects.toThrow(/path is invalid/i);
    expect(requested).toBe(false);
  });

  it("lists regular files recursively from the Artifacts binding", async () => {
    const artifacts = new FakeArtifacts(new FakeReader());
    const created = await artifacts.create("workspace-one");
    const repo = await artifacts.get(created.name);
    const rootTree = "3".repeat(40);
    const nestedTree = "4".repeat(40);
    repo.commits.set(INITIAL_HEAD, { hash: INITIAL_HEAD, treeHash: rootTree });
    repo.trees.set(rootTree, [
      { name: ".workspace", hash: nestedTree, mode: "040000", type: "tree" },
      { name: "README.md", hash: "5".repeat(40), mode: "100644", type: "blob" },
    ]);
    repo.trees.set(nestedTree, [
      { name: "index.json", hash: "6".repeat(40), mode: "100644", type: "blob" },
    ]);
    const reader = new CloudflareWorkspaceArtifactReader({
      artifacts,
      accountId: "62f4d80db4b47c969f575420fa2aae29",
      namespace: "workshop-workspaces",
      apiToken: "rest-secret",
    });

    await expect(reader.listFiles(created.name, INITIAL_HEAD)).resolves.toEqual([
      ".workspace/index.json",
      "README.md",
    ]);
  });

  it("rejects symlinks in an Artifacts workspace tree", async () => {
    const artifacts = new FakeArtifacts(new FakeReader());
    const created = await artifacts.create("workspace-one");
    const repo = await artifacts.get(created.name);
    const rootTree = "3".repeat(40);
    repo.commits.set(INITIAL_HEAD, { hash: INITIAL_HEAD, treeHash: rootTree });
    repo.trees.set(rootTree, [
      { name: "escape", hash: "5".repeat(40), mode: "120000", type: "blob" },
    ]);
    const reader = new CloudflareWorkspaceArtifactReader({
      artifacts,
      accountId: "62f4d80db4b47c969f575420fa2aae29",
      namespace: "workshop-workspaces",
      apiToken: "rest-secret",
    });

    await expect(reader.listFiles(created.name, INITIAL_HEAD)).rejects.toThrow(/unsupported/i);
  });
});

class FakeSandbox implements WorkspaceArtifactSandbox {
  readonly commands: string[][] = [];
  readonly events: string[] = [];
  readonly files = new Map<string, string | Uint8Array>();
  readonly directories: string[] = [];
  readonly gitAuth: Array<Record<string, { token: string; type: "bearer" }>> = [];
  destroyed = false;
  repositoryExists = false;
  status = "";
  head = INITIAL_HEAD;

  async registerGitAuthInterceptor(params: {
    hosts: Record<string, { token: string; type: "bearer" }>;
  }): Promise<void> {
    this.gitAuth.push(params.hosts);
  }

  exists(_path: string): Promise<{ exists: boolean }> {
    return Promise.resolve({ exists: this.repositoryExists });
  }

  async mkdir(path: string): Promise<void> {
    this.directories.push(path);
    this.events.push(`mkdir:${path}`);
  }

  async exec(command: SandboxCommand, _options?: ExecOptions): Promise<{
    output(): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
      truncated: boolean;
    }>;
  }> {
    this.commands.push([...command]);
    this.events.push(`exec:${command.join(" ")}`);
    if (command.includes("commit")) this.head = CHECKPOINT_HEAD;
    const stdout = command.includes("rev-parse")
      ? `${this.head}\n`
      : command.includes("status") ? this.status : "";
    return {
      output: () => Promise.resolve({
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      }),
    };
  }

  async writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<void> {
    this.events.push(`write:${path}`);
    if (typeof content === "string") {
      this.files.set(path, content);
      return;
    }
    this.files.set(path, new Uint8Array(await new Response(content).arrayBuffer()));
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

describe("SandboxWorkspaceArtifactGitRuntime", () => {
  it("initializes an empty repository through Sandbox's Git auth interceptor", async () => {
    const sandbox = new FakeSandbox();
    sandbox.head = CHECKPOINT_HEAD;
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.initialize({
      repositoryName: "workspace-123",
      remote: "https://artifacts.example/workspace-123.git",
      token: "one-use-secret",
      defaultBranch: "main",
      index: new TextEncoder().encode("{\"version\":1}\n"),
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.files.get("/workspace/repo/.workspace/index.json"))
      .toBe("{\"version\":1}\n");
    expect(sandbox.commands[0]).toEqual([
      "git",
      "clone",
      "https://artifacts.example/workspace-123.git",
      "/workspace/repo",
    ]);
    expect(sandbox.gitAuth).toEqual([{
      "artifacts.example": { token: "one-use-secret", type: "bearer" },
    }]);
    expect(sandbox.commands.flat()).not.toContain("one-use-secret");
    expect(sandbox.commands.flat().filter(argument => argument.startsWith("https://")))
      .toEqual([
        "https://artifacts.example/workspace-123.git",
        "https://artifacts.example/workspace-123.git",
      ]);
    expect(sandbox.destroyed).toBe(true);
  });

  it("promotes from a clean trusted sandbox with separate fork and canonical credentials", async () => {
    const sandbox = new FakeSandbox();
    sandbox.head = CHECKPOINT_HEAD;
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.promote({
      canonicalRepositoryName: "workspace-canonical",
      canonicalRemote: "https://artifacts.example/canonical.git",
      canonicalToken: "canonical-secret",
      forkRepositoryName: "workspace-fork",
      forkRemote: "https://artifacts.example/fork.git",
      forkToken: "fork-secret",
      expectedCanonicalHead: INITIAL_HEAD,
      canonicalDefaultBranch: "main",
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.gitAuth).toEqual([
      { "artifacts.example": { token: "fork-secret", type: "bearer" } },
      { "artifacts.example": { token: "canonical-secret", type: "bearer" } },
    ]);
    expect(sandbox.commands.flat()).not.toContain("fork-secret");
    expect(sandbox.commands.flat()).not.toContain("canonical-secret");
    expect(sandbox.commands.find(command => command.includes("--is-ancestor")))
      .toContain(INITIAL_HEAD);
    expect(sandbox.commands.find(command => command.includes("set-url")))
      .toContain("https://artifacts.example/canonical.git");
    expect(sandbox.commands.find(command => command.includes("push")))
      .toContain(`--force-with-lease=refs/heads/main:${INITIAL_HEAD}`);
    expect(sandbox.destroyed).toBe(true);
  });

  it("lazily clones a chat fork without exposing its Git credential in argv", async () => {
    const sandbox = new FakeSandbox();
    sandbox.head = CHECKPOINT_HEAD;
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await runtime.prepareChat({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      expectedHead: CHECKPOINT_HEAD,
    });

    expect(sandbox.commands[0]).toEqual([
      "git", "clone", "https://artifacts.example/fork.git", "/workspace/repo",
    ]);
    expect(sandbox.gitAuth.at(-1)).toEqual({
      "artifacts.example": { token: "fork-write-secret", type: "bearer" },
    });
    expect(sandbox.destroyed).toBe(false);
  });

  it("checkpoints chat changes with an expected-head push and intercepted credential", async () => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    sandbox.status = " M notes.txt\n";
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.checkpointChat({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Update notes",
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.commands.find(command => command.includes("push")))
      .toContain(`--force-with-lease=refs/heads/main:${INITIAL_HEAD}`);
    expect(sandbox.gitAuth.at(-1)).toEqual({
      "artifacts.example": { token: "fork-write-secret", type: "bearer" },
    });
    expect(sandbox.destroyed).toBe(false);
  });

  it("applies one file mutation before checkpointing the chat fork", async () => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    sandbox.status = " D old.txt\n M notes.txt\n";
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.stageChatMutation({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Update workspace files",
      mutation: {
        operations: [
          { kind: "delete", path: "old.txt" },
          { kind: "write", path: "notes.txt", content: new TextEncoder().encode("updated\n") },
          { kind: "write", path: "nested/data.bin", content: new Uint8Array([0, 255, 1]) },
        ],
      },
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.commands).toContainEqual([
      "rm", "-rf", "--", "/workspace/repo/old.txt",
    ]);
    expect(sandbox.files.get("/workspace/repo/notes.txt"))
      .toEqual(new TextEncoder().encode("updated\n"));
    expect(sandbox.files.get("/workspace/repo/nested/data.bin")).toEqual(new Uint8Array([0, 255, 1]));
    expect(sandbox.commands.find(command => command.includes("push")))
      .toContain(`--force-with-lease=refs/heads/main:${INITIAL_HEAD}`);
    expect(sandbox.gitAuth.at(-1)).toEqual({
      "artifacts.example": { token: "fork-write-secret", type: "bearer" },
    });
  });

  it("applies an ordered mutation sequence with explicit filesystem arguments", async () => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    sandbox.status = " M renamed.txt\n D old.txt\n";
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.stageChatMutation({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Reorganize workspace files",
      mutation: {
        operations: [
          { kind: "move", from: "notes.txt", to: "archive/renamed.txt" },
          { kind: "delete", path: "old.txt" },
          { kind: "write", path: "nested/data.bin", content: new Uint8Array([0, 255, 1]) },
        ],
      },
    })).resolves.toBe(CHECKPOINT_HEAD);

    const moveIndex = sandbox.events.findIndex(event => event.startsWith("exec:mv "));
    const deleteIndex = sandbox.events.findIndex(event => event.startsWith("exec:rm "));
    const writeIndex = sandbox.events.findIndex(event => event === "write:/workspace/repo/nested/data.bin");
    expect(sandbox.commands.find(command => command[0] === "mv")).toEqual([
      "mv", "--", "/workspace/repo/notes.txt", "/workspace/repo/archive/renamed.txt",
    ]);
    expect(sandbox.directories).toContain("/workspace/repo/archive");
    expect(moveIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(writeIndex);
    expect(sandbox.files.get("/workspace/repo/nested/data.bin"))
      .toEqual(new Uint8Array([0, 255, 1]));
  });

  it.each([
    "nested/.git/config",
    "nested\\file.txt",
    "e\u0301.txt",
    `${"x".repeat(256)}.txt`,
  ])("rejects unsafe repository path %s before changing the working tree", async path => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.stageChatMutation({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Unsafe write",
      mutation: {
        operations: [{ kind: "write", path, content: new Uint8Array() }],
      },
    })).rejects.toThrow(/path/i);

    expect(sandbox.commands).toHaveLength(0);
  });

  it("rejects unsafe move paths before changing the working tree", async () => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.stageChatMutation({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Unsafe move",
      mutation: {
        operations: [{ kind: "move", from: "safe.txt", to: "nested/.git/config" }],
      },
    })).rejects.toThrow(/path/i);

    expect(sandbox.commands).toHaveLength(0);
  });

  it("allows an ordered move followed by a replacement at its destination", async () => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    sandbox.status = "R  notes.txt -> renamed.txt\n";
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.stageChatMutation({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Move and replace",
      mutation: {
        operations: [
          { kind: "move", from: "notes.txt", to: "renamed.txt" },
          { kind: "write", path: "renamed.txt", content: new Uint8Array() },
        ],
      },
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.commands.find(command => command[0] === "mv")).toEqual([
      "mv", "--", "/workspace/repo/notes.txt", "/workspace/repo/renamed.txt",
    ]);
    expect(sandbox.files.get("/workspace/repo/renamed.txt")).toEqual(new Uint8Array());
  });

  it("rejects a move into its own descendant before changing the working tree", async () => {
    const sandbox = new FakeSandbox();
    sandbox.repositoryExists = true;
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.stageChatMutation({
      sandboxId: "chat-sandbox",
      remote: "https://artifacts.example/fork.git",
      token: "fork-write-secret",
      defaultBranch: "main",
      expectedHead: INITIAL_HEAD,
      actor: { id: "user:aleksey", name: "Aleksey" },
      message: "Invalid move",
      mutation: {
        operations: [{ kind: "move", from: "folder", to: "folder/nested" }],
      },
    })).rejects.toThrow(/conflict/i);

    expect(sandbox.commands).toHaveLength(0);
  });
});
