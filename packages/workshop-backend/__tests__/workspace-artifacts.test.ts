import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import {
  CloudflareWorkspaceArtifactReader,
  SandboxWorkspaceArtifactGitRuntime,
  WorkspaceArtifactLifecycle,
  type WorkspaceArtifactControlPlane,
  type WorkspaceArtifactGitRuntime,
  type WorkspaceArtifactReader,
  type WorkspaceArtifactRepo,
  type WorkspaceArtifactSandbox,
} from "../src/workspace-artifacts";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const INITIAL_HEAD = "1".repeat(40);
const CHECKPOINT_HEAD = "2".repeat(40);

class FakeRepo implements WorkspaceArtifactRepo {
  readonly tokens = new Map<string, "read" | "write">();
  readonly revoked: string[] = [];

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

  async log(): Promise<Array<{ hash: string }>> {
    return [];
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

  getHead(repoName: string): Promise<string | undefined> {
    return Promise.resolve(this.heads.get(repoName));
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
  run: (lifecycle: WorkspaceArtifactLifecycle, fixtures: ReturnType<typeof fixture>) => Promise<T>,
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
    }), fixtures),
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

  it("fast-forwards the existing chat proposal and deletes its fork", async () => {
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
      expect(fixtures.artifacts.deleted).toContain(fork.repositoryName);
      expect(fixtures.runtime.destroyed).toContain(fork.sandboxId);
      expect(await lifecycle.getChatFork("chat-one", 1)).toBeUndefined();
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
        latestHead: INITIAL_HEAD,
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

describe("CloudflareWorkspaceArtifactReader", () => {
  it("reads the current head from the binding and one bounded file from REST", async () => {
    const readerState = new FakeReader();
    const artifacts = new FakeArtifacts(readerState);
    const repo = await artifacts.create("workspace-one");
    readerState.heads.set(repo.name, INITIAL_HEAD);
    const artifactRepo = await artifacts.get(repo.name);
    artifactRepo.log = () => Promise.resolve([{ hash: INITIAL_HEAD }]);
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
});

class FakeSandbox implements WorkspaceArtifactSandbox {
  readonly commands: string[][] = [];
  readonly files = new Map<string, string>();
  destroyed = false;

  async exec(command: string[]): Promise<{
    output(): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
      truncated: boolean;
    }>;
  }> {
    this.commands.push(command);
    const stdout = command.includes("rev-parse") ? `${CHECKPOINT_HEAD}\n` : "";
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

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

describe("SandboxWorkspaceArtifactGitRuntime", () => {
  it("initializes an empty repository without putting its token in the remote", async () => {
    const sandbox = new FakeSandbox();
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.initialize({
      repositoryName: "workspace-123",
      remote: "https://artifacts.example/workspace-123.git",
      token: "one-use-secret",
      index: new TextEncoder().encode("{\"version\":1}\n"),
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.files.get("/workspace/repo/.workspace/index.json"))
      .toBe("{\"version\":1}\n");
    expect(sandbox.commands[0]).toEqual([
      "git",
      "-c",
      "http.extraHeader=Authorization: Bearer one-use-secret",
      "clone",
      "https://artifacts.example/workspace-123.git",
      "/workspace/repo",
    ]);
    expect(sandbox.commands.find(command => command.includes("push")))
      .toContain("http.extraHeader=Authorization: Bearer one-use-secret");
    expect(sandbox.commands.flat().filter(argument => argument.startsWith("https://")))
      .toEqual([
        "https://artifacts.example/workspace-123.git",
        "https://artifacts.example/workspace-123.git",
      ]);
    expect(sandbox.destroyed).toBe(true);
  });

  it("promotes from a clean trusted sandbox with separate fork and canonical credentials", async () => {
    const sandbox = new FakeSandbox();
    const runtime = new SandboxWorkspaceArtifactGitRuntime(() => sandbox);

    await expect(runtime.promote({
      canonicalRepositoryName: "workspace-canonical",
      canonicalRemote: "https://artifacts.example/canonical.git",
      canonicalToken: "canonical-secret",
      forkRepositoryName: "workspace-fork",
      forkRemote: "https://artifacts.example/fork.git",
      forkToken: "fork-secret",
      expectedCanonicalHead: INITIAL_HEAD,
    })).resolves.toBe(CHECKPOINT_HEAD);

    expect(sandbox.commands[0]).toContain("http.extraHeader=Authorization: Bearer fork-secret");
    expect(sandbox.commands.find(command => command.includes("--is-ancestor")))
      .toContain(INITIAL_HEAD);
    expect(sandbox.commands.find(command => command.includes("push")))
      .toContain("http.extraHeader=Authorization: Bearer canonical-secret");
    expect(sandbox.destroyed).toBe(true);
  });
});
