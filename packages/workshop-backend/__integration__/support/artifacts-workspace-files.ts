import type { CommitInfo } from "@gadgets/workshop-shared/api";
import {
  ArtifactsWorkspaceFiles,
  type ArtifactsWorkspaceFileLifecycle,
  type CreateArtifactsWorkspaceFilesOptions,
} from "../../src/artifacts-workspace-files";
import {
  createEmptyWorkspaceIndex,
  serializeWorkspaceIndex,
  WORKSPACE_INDEX_PATH,
} from "../../src/workspace-manifest";
import { WorkspaceUploadStore } from "../../src/workspace-upload-store";
import { ArtifactsWorkspaceRepository } from "../../src/workspace-artifacts";
import type {
  WorkspaceArtifactAcceptResult,
  WorkspaceArtifactCanonical,
  WorkspaceArtifactChatFork,
  WorkspaceArtifactForkStatus,
  WorkspaceArtifactMutation,
  WorkspaceArtifactReader,
  WorkspaceCodeRepository,
} from "../../src/workspace-artifacts";
import type { WorkspaceActor } from "../../src/workspace-files";

interface LocalRevision {
  files: Map<string, Uint8Array>;
  commit: CommitInfo;
}

interface LocalRepository {
  head: string;
}

interface LocalArtifactsState {
  canonical?: WorkspaceArtifactCanonical;
  repositories: Map<string, LocalRepository>;
  revisions: Map<string, LocalRevision>;
  forks: Map<string, WorkspaceArtifactForkStatus>;
  nextRevision: number;
}

const states = new Map<string, LocalArtifactsState>();

function stateFor(workspaceId: string): LocalArtifactsState {
  let state = states.get(workspaceId);
  if (!state) {
    state = {
      repositories: new Map(),
      revisions: new Map(),
      forks: new Map(),
      nextRevision: 1,
    };
    states.set(workspaceId, state);
  }
  return state;
}

function forkKey(chatId: string, epoch: number): string {
  return `${chatId}:${epoch}`;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function copyFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].map(([path, content]) => [path, copyBytes(content)]));
}

class LocalArtifacts implements WorkspaceArtifactReader, ArtifactsWorkspaceFileLifecycle {
  readonly #workspaceId: string;
  readonly #state: LocalArtifactsState;

  constructor(workspaceId: string) {
    this.#workspaceId = workspaceId;
    this.#state = stateFor(workspaceId);
  }

  #nextOid(): string {
    return (this.#state.nextRevision++).toString(16).padStart(40, "0");
  }

  #commit(
    files: ReadonlyMap<string, Uint8Array>,
    parents: string[],
    actor: WorkspaceActor,
    message: string,
  ): string {
    const oid = this.#nextOid();
    this.#state.revisions.set(oid, {
      files: copyFiles(files),
      commit: {
        oid,
        parents,
        message,
        author: { name: actor.name, email: "workspace@test.invalid" },
        timestamp: new Date(),
      },
    });
    return oid;
  }

  #revision(oid: string): LocalRevision {
    const revision = this.#state.revisions.get(oid);
    if (!revision) throw new Error(`Test Artifacts revision ${oid} does not exist.`);
    return revision;
  }

  #repository(name: string): LocalRepository {
    const repository = this.#state.repositories.get(name);
    if (!repository) throw new Error(`Test Artifacts repository ${name} does not exist.`);
    return repository;
  }

  async ensureCanonical(actor: WorkspaceActor): Promise<WorkspaceArtifactCanonical> {
    if (this.#state.canonical) return this.#state.canonical;
    const index = createEmptyWorkspaceIndex({
      actorId: actor.id,
      now: new Date().toISOString(),
    });
    const repositoryName = `test-workspace-${this.#workspaceId}`;
    const head = this.#commit(
      new Map([[WORKSPACE_INDEX_PATH, serializeWorkspaceIndex(index)]]),
      [],
      actor,
      "Initialize workspace\n",
    );
    this.#state.repositories.set(repositoryName, { head });
    this.#state.canonical = {
      repositoryName,
      remote: `https://artifacts.test/${repositoryName}.git`,
      defaultBranch: "main",
      head,
      rootId: index.rootId,
    };
    return this.#state.canonical;
  }

  getCanonical(): Promise<WorkspaceArtifactCanonical | undefined> {
    return Promise.resolve(this.#state.canonical);
  }

  getRepositoryMetadata(repositoryName: string): Promise<{
    name: string;
    remote: string;
    defaultBranch: string;
  }> {
    return Promise.resolve({
      name: repositoryName,
      remote: `https://artifacts.test/${repositoryName}.git`,
      defaultBranch: "main",
    });
  }

  getHead(repositoryName: string, _defaultBranch: string): Promise<string | undefined> {
    return Promise.resolve(this.#state.repositories.get(repositoryName)?.head);
  }

  listFiles(repositoryName: string, ref: string): Promise<string[]> {
    this.#repository(repositoryName);
    return Promise.resolve([...this.#revision(ref).files.keys()].toSorted());
  }

  readFile(
    repositoryName: string,
    ref: string,
    path: string,
    maximumBytes?: number,
  ): Promise<Uint8Array> {
    this.#repository(repositoryName);
    const content = this.#revision(ref).files.get(path);
    if (!content) throw new Error(`Test Artifacts file ${path} does not exist.`);
    if (maximumBytes !== undefined && content.byteLength > maximumBytes) {
      throw new Error(`Test Artifacts file ${path} exceeds its read bound.`);
    }
    return Promise.resolve(copyBytes(content));
  }

  getForkStatus(chatId: string, epoch: number): Promise<WorkspaceArtifactForkStatus | undefined> {
    return Promise.resolve(this.#state.forks.get(forkKey(chatId, epoch)));
  }

  async stageChatMutation(
    chatId: string,
    epoch: number,
    actor: WorkspaceActor,
    message: string,
    mutation: WorkspaceArtifactMutation,
  ): Promise<WorkspaceArtifactChatFork> {
    const canonical = await this.ensureCanonical(actor);
    const key = forkKey(chatId, epoch);
    let fork = this.#state.forks.get(key);
    if (!fork) {
      const repositoryName = `${canonical.repositoryName}-fork-${crypto.randomUUID()}`;
      fork = {
        chatId,
        epoch,
        repositoryName,
        remote: `https://artifacts.test/${repositoryName}.git`,
        defaultBranch: "main",
        baselineHead: canonical.head,
        latestHead: canonical.head,
        sandboxId: `sandbox-${repositoryName}`,
        state: "open",
      };
      this.#state.forks.set(key, fork);
      this.#state.repositories.set(repositoryName, { head: canonical.head });
    }
    if (fork.state !== "open") throw new Error("Test Artifacts fork is not open.");

    const files = copyFiles(this.#revision(fork.latestHead).files);
    for (const operation of mutation.operations) {
      if (operation.kind === "write") {
        files.set(operation.path, copyBytes(operation.content));
      } else if (operation.kind === "delete") {
        for (const path of files.keys()) {
          if (path === operation.path || path.startsWith(`${operation.path}/`)) files.delete(path);
        }
      } else {
        const moved = [...files].filter(([path]) =>
          path === operation.from || path.startsWith(`${operation.from}/`));
        for (const [path] of moved) files.delete(path);
        for (const [path, content] of moved) {
          files.set(`${operation.to}${path.slice(operation.from.length)}`, content);
        }
      }
    }
    const head = this.#commit(files, [fork.latestHead], actor, message);
    fork = { ...fork, latestHead: head };
    this.#state.forks.set(key, fork);
    this.#repository(fork.repositoryName).head = head;
    return fork;
  }

  acceptChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactAcceptResult> {
    const canonical = this.#state.canonical;
    if (!canonical) throw new Error("Test canonical repository does not exist.");
    const key = forkKey(chatId, epoch);
    const fork = this.#state.forks.get(key);
    if (!fork) return Promise.resolve({ status: "merged", head: canonical.head });
    if (fork.state === "accepted") {
      return Promise.resolve({ status: "merged", head: fork.acceptedHead ?? fork.latestHead });
    }
    if (canonical.head !== fork.baselineHead) {
      return Promise.resolve({
        status: "stale",
        expectedHead: fork.baselineHead,
        currentHead: canonical.head,
      });
    }
    canonical.head = fork.latestHead;
    this.#repository(canonical.repositoryName).head = fork.latestHead;
    this.#state.forks.set(key, {
      ...fork,
      state: "accepted",
      acceptedHead: fork.latestHead,
    });
    return Promise.resolve({ status: "merged", head: fork.latestHead });
  }

  completeAcceptedChatFork(chatId: string, epoch: number, acceptedHead: string): Promise<void> {
    const key = forkKey(chatId, epoch);
    const fork = this.#state.forks.get(key);
    if (!fork || fork.state !== "accepted" || fork.acceptedHead !== acceptedHead) {
      throw new Error("Test accepted Artifacts fork does not match.");
    }
    this.#state.repositories.delete(fork.repositoryName);
    this.#state.forks.delete(key);
    return Promise.resolve();
  }

  discardChatFork(chatId: string, epoch: number): Promise<void> {
    const key = forkKey(chatId, epoch);
    const fork = this.#state.forks.get(key);
    if (fork) this.#state.repositories.delete(fork.repositoryName);
    this.#state.forks.delete(key);
    return Promise.resolve();
  }

  readCommitLog(oid: string, options?: { depth?: number }): Promise<CommitInfo[]> {
    const commits: CommitInfo[] = [];
    let current: string | undefined = oid;
    while (current !== undefined && commits.length < (options?.depth ?? 50)) {
      const commit = this.#revision(current).commit;
      commits.push(commit);
      current = commit.parents[0];
    }
    return Promise.resolve(commits);
  }

  readChatCommitLog(
    chatId: string,
    epoch: number,
    oid: string,
    options?: { depth?: number },
  ): Promise<CommitInfo[]> {
    const fork = this.#state.forks.get(forkKey(chatId, epoch));
    if (!fork || !this.#state.repositories.has(fork.repositoryName)) {
      throw new Error("Test chat fork does not exist.");
    }
    return this.readCommitLog(oid, options);
  }

  getHistory(limit?: number): Promise<CommitInfo[]> {
    const canonical = this.#state.canonical;
    if (!canonical) throw new Error("Test canonical repository does not exist.");
    return this.readCommitLog(canonical.head, { depth: limit });
  }

  deleteWorkspaceRepositories(): Promise<void> {
    this.#state.repositories.clear();
    this.#state.revisions.clear();
    this.#state.forks.clear();
    this.#state.canonical = undefined;
    states.delete(this.#workspaceId);
    return Promise.resolve();
  }
}

export function createArtifactsWorkspaceFiles(
  options: CreateArtifactsWorkspaceFilesOptions,
): ArtifactsWorkspaceFiles {
  const artifacts = new LocalArtifacts(options.workspaceId);
  return new ArtifactsWorkspaceFiles({
    state: options.state,
    lifecycle: artifacts,
    reader: artifacts,
    uploadStore: new WorkspaceUploadStore({
      state: options.state,
      bucket: options.bucket,
      workspaceId: options.workspaceId,
    }),
  });
}

/** Creates the shared in-memory code repository for a Worker integration workspace. */
export function createWorkspaceCodeRepository(workspaceId: string): WorkspaceCodeRepository {
  const artifacts = new LocalArtifacts(workspaceId);
  return new ArtifactsWorkspaceRepository({ lifecycle: artifacts, reader: artifacts });
}
