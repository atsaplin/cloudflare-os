import {
  getSandbox,
  type ExecOptions,
  type Sandbox,
  type SandboxCommand,
  type SandboxProcess,
} from "@cloudflare/sandbox";
import {
  WORKSPACE_INDEX_PATH,
  createEmptyWorkspaceIndex,
  parseWorkspaceIndex,
  serializeWorkspaceIndex,
} from "./workspace-manifest";
import type { CommitInfo } from "@gadgets/workshop-shared/api";
import type { WorkspaceActor } from "./workspace-files";

const gitOidPattern = /^[0-9a-f]{40}$/;
const maximumEpoch = 1_000_000_000;
const maximumCommitHistoryDepth = 100;
const defaultCommitHistoryDepth = 50;
const maximumCommitParents = 32;
const maximumCommitMessageBytes = 64 * 1024;
const maximumCommitIdentityBytes = 4 * 1024;
const maximumCommitTimestampSeconds = 1_000_000_000_000;
const maximumMutationOperations = 1_000;
const maximumRepositoryPathBytes = 4_096;
const maximumRepositorySegmentBytes = 255;
const maximumRepositoryTreeDepth = 128;
const maximumRepositoryTreeEntries = 100_000;

/** The Artifacts repo surface used by the workspace lifecycle. */
export interface WorkspaceArtifactRepo {
  readonly name: string;
  readonly remote: string;
  readonly defaultBranch: string;
  createToken(scope: "read" | "write", ttl?: number): Promise<{
    id: string;
    plaintext: string;
    scope: "read" | "write";
  }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(name: string, options?: {
    description?: string;
    readOnly?: boolean;
    defaultBranchOnly?: boolean;
  }): Promise<{
    name: string;
    remote: string;
    defaultBranch: string;
    token: string;
  }>;
}

/** The namespace-level Artifacts operations used by the workspace lifecycle. */
export interface WorkspaceArtifactControlPlane {
  create(name: string, options?: {
    description?: string;
    readOnly?: boolean;
    setDefaultBranch?: string;
  }): Promise<{
    name: string;
    remote: string;
    defaultBranch: string;
    token: string;
  }>;
  get(name: string): Promise<WorkspaceArtifactRepo>;
  delete(name: string): Promise<boolean>;
}

/** Bounded read access to repository refs and files. */
export interface WorkspaceArtifactReader {
  getHead(repositoryName: string): Promise<string | undefined>;
  listFiles(repositoryName: string, ref: string): Promise<string[]>;
  readFile(
    repositoryName: string,
    ref: string,
    path: string,
    maximumBytes?: number,
  ): Promise<Uint8Array>;
}

interface WorkspaceArtifactHistoryRepo extends WorkspaceArtifactRepo {
  log(options: { ref: string; limit: number }): Promise<unknown>;
}

interface WorkspaceArtifactInspectionRepo extends WorkspaceArtifactRepo {
  readCommit(hash: string): Promise<unknown>;
  readTree(hash: string): Promise<unknown>;
}

interface WorkspaceArtifactTreeEntry {
  name: string;
  hash: string;
  mode: string;
  type: string;
}

export interface CloudflareWorkspaceArtifactReaderOptions {
  artifacts: WorkspaceArtifactControlPlane;
  accountId: string;
  namespace: string;
  apiToken: string;
  fetch?: (request: Request) => Promise<Response>;
}

function requireConfigurationValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error(`${label} is invalid.`);
  return trimmed;
}

function hasRepositoryLog(repo: WorkspaceArtifactRepo): repo is WorkspaceArtifactHistoryRepo {
  return "log" in repo && typeof repo.log === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireBoundedCommitText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" ||
      new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseCommitIdentity(value: unknown): { name: string; email: string } {
  if (!isRecord(value)) throw new Error("Artifacts commit identity is invalid.");
  return {
    name: requireBoundedCommitText(value.name, "Artifacts commit author name",
      maximumCommitIdentityBytes),
    email: requireBoundedCommitText(value.email, "Artifacts commit author email",
      maximumCommitIdentityBytes),
  };
}

function parseCommitTimestamp(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < -maximumCommitTimestampSeconds || value > maximumCommitTimestampSeconds) {
    throw new Error("Artifacts commit author timestamp is invalid.");
  }
  const timestamp = new Date(value * 1_000);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Artifacts commit author timestamp is invalid.");
  }
  return timestamp;
}

function parseCommit(value: unknown): CommitInfo {
  if (!isRecord(value)) throw new Error("Artifacts commit history entry is invalid.");
  const hash = requireOid(
    requireBoundedCommitText(value.hash, "Artifacts commit hash", 40),
    "Artifacts commit hash",
  );
  requireOid(
    requireBoundedCommitText(value.treeHash, "Artifacts commit tree", 40),
    "Artifacts commit tree",
  );
  if (!Array.isArray(value.parents) || value.parents.length > maximumCommitParents) {
    throw new Error("Artifacts commit parents are invalid.");
  }
  const parents = value.parents.map(parent => requireOid(
    requireBoundedCommitText(parent, "Artifacts commit parent", 40),
    "Artifacts commit parent",
  ));
  return {
    oid: hash,
    parents,
    message: requireBoundedCommitText(value.message, "Artifacts commit message",
      maximumCommitMessageBytes),
    author: parseCommitIdentity(value.author),
    timestamp: parseCommitTimestamp(value.authoredAt),
  };
}

function parseCommitLog(value: unknown, limit: number): CommitInfo[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("Artifacts commit history response is invalid.");
  }
  return value.map(parseCommit);
}

function requireCommitHistoryDepth(depth: number | undefined, defaultDepth: number): number {
  const resolved = depth ?? defaultDepth;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximumCommitHistoryDepth) {
    throw new Error("Workspace history limit must be an integer from 1 to 100.");
  }
  return resolved;
}

function hasRepositoryInspection(
  repo: WorkspaceArtifactRepo,
): repo is WorkspaceArtifactInspectionRepo {
  return "readCommit" in repo && typeof repo.readCommit === "function" &&
    "readTree" in repo && typeof repo.readTree === "function";
}

function parseCommitTree(value: unknown): string {
  if (!isRecord(value) || typeof value.treeHash !== "string") {
    throw new Error("Artifacts commit response is invalid.");
  }
  return requireOid(value.treeHash, "Artifacts commit tree");
}

function parseTreeEntries(value: unknown): WorkspaceArtifactTreeEntry[] {
  if (!Array.isArray(value)) throw new Error("Artifacts tree response is invalid.");
  return value.map(entry => {
    if (typeof entry !== "object" || entry === null || !("name" in entry) ||
        !("hash" in entry) || !("mode" in entry) || !("type" in entry) ||
        typeof entry.name !== "string" || typeof entry.hash !== "string" ||
        typeof entry.mode !== "string" || typeof entry.type !== "string") {
      throw new Error("Artifacts tree entry is invalid.");
    }
    return {
      name: entry.name,
      hash: requireOid(entry.hash, "Artifacts tree entry hash"),
      mode: entry.mode,
      type: entry.type,
    };
  });
}

/** Reads bounded repository content without starting a Sandbox. */
export class CloudflareWorkspaceArtifactReader implements WorkspaceArtifactReader {
  readonly #artifacts: WorkspaceArtifactControlPlane;
  readonly #accountId: string;
  readonly #namespace: string;
  readonly #apiToken: string;
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(options: CloudflareWorkspaceArtifactReaderOptions) {
    this.#artifacts = options.artifacts;
    this.#accountId = requireConfigurationValue(options.accountId, "Artifacts account ID");
    this.#namespace = requireConfigurationValue(options.namespace, "Artifacts namespace");
    this.#apiToken = requireConfigurationValue(options.apiToken, "Artifacts API token");
    this.#fetch = options.fetch ?? (request => fetch(request));
  }

  async getHead(repositoryName: string): Promise<string | undefined> {
    const repo = await this.#artifacts.get(repositoryName);
    if (!hasRepositoryLog(repo)) {
      throw new Error("The Artifacts binding does not expose repository history.");
    }
    const commits = parseCommitLog(await repo.log({ ref: repo.defaultBranch, limit: 1 }), 1);
    return commits[0]?.oid;
  }

  async listFiles(repositoryName: string, ref: string): Promise<string[]> {
    const commit = requireOid(ref, "Workspace tree ref");
    const repo = await this.#artifacts.get(repositoryName);
    if (!hasRepositoryInspection(repo)) {
      throw new Error("The Artifacts binding does not expose repository tree inspection.");
    }
    const rootTree = parseCommitTree(await repo.readCommit(commit));
    const files: string[] = [];
    let entryCount = 0;
    const visit = async (treeHash: string, prefix: string, depth: number): Promise<void> => {
      if (depth > maximumRepositoryTreeDepth) {
        throw new Error("Artifacts workspace tree exceeds the depth limit.");
      }
      for (const entry of parseTreeEntries(await repo.readTree(treeHash))) {
        entryCount += 1;
        if (entryCount > maximumRepositoryTreeEntries) {
          throw new Error("Artifacts workspace tree exceeds the entry limit.");
        }
        const path = requireRepositoryPath(prefix ? `${prefix}/${entry.name}` : entry.name);
        if (entry.type === "tree" && entry.mode === "040000") {
          await visit(entry.hash, path, depth + 1);
        } else if (entry.type === "blob" &&
            (entry.mode === "100644" || entry.mode === "100755")) {
          files.push(path);
        } else {
          throw new Error(`Artifacts workspace tree entry ${path} has an unsupported type.`);
        }
      }
    };
    await visit(rootTree, "", 0);
    return files.toSorted();
  }

  async readFile(
    repositoryName: string,
    ref: string,
    path: string,
    maximumBytes = 4 * 1024 * 1024,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("Workspace file read bound is invalid.");
    }
    requireOid(ref, "Workspace file ref");
    const repositoryPath = requireRepositoryPath(path);
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.#accountId)}` +
      `/artifacts/namespaces/${encodeURIComponent(this.#namespace)}` +
      `/repos/${encodeURIComponent(repositoryName)}/file`,
    );
    url.searchParams.set("ref", ref);
    url.searchParams.set("path", repositoryPath);
    const response = await this.#fetch(new Request(url, {
      headers: { Authorization: `Bearer ${this.#apiToken}` },
    }));
    if (!response.ok) {
      throw new Error(`Artifacts file read failed with status ${response.status}.`);
    }
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error("Artifacts file response length is invalid.");
      }
      if (length > maximumBytes) throw new Error("Artifacts file exceeds the read bound.");
    }
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumBytes) {
          await reader.cancel("Artifacts file exceeds the read bound.");
          throw new Error("Artifacts file exceeds the read bound.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

/** Trusted Git operations executed in disposable Cloudflare Sandboxes. */
export interface WorkspaceArtifactGitRuntime {
  initialize(request: {
    repositoryName: string;
    remote: string;
    token: string;
    defaultBranch: string;
    index: Uint8Array;
  }): Promise<string>;
  promote(request: {
    canonicalRepositoryName: string;
    canonicalRemote: string;
    canonicalToken: string;
    forkRepositoryName: string;
    forkRemote: string;
    forkToken: string;
    expectedCanonicalHead: string;
    canonicalDefaultBranch: string;
  }): Promise<string>;
  prepareChat(request: {
    sandboxId: string;
    remote: string;
    token: string;
    expectedHead: string;
  }): Promise<void>;
  checkpointChat(request: {
    sandboxId: string;
    remote: string;
    token: string;
    defaultBranch: string;
    expectedHead: string;
    actor: WorkspaceActor;
    message: string;
  }): Promise<string>;
  stageChatMutation(request: {
    sandboxId: string;
    remote: string;
    token: string;
    defaultBranch: string;
    expectedHead: string;
    actor: WorkspaceActor;
    message: string;
    mutation: WorkspaceArtifactMutation;
  }): Promise<string>;
  destroy(sandboxId: string): Promise<void>;
}

export type WorkspaceArtifactMutationOperation =
  | { kind: "delete"; path: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "write"; path: string; content: Uint8Array };

/** File changes applied to one chat fork before its next durable checkpoint. */
export interface WorkspaceArtifactMutation {
  operations: readonly WorkspaceArtifactMutationOperation[];
}

/** Minimal Sandbox client used by trusted repository Git operations. */
export interface WorkspaceArtifactSandbox {
  registerGitAuthInterceptor(params: {
    hosts: Record<string, { token: string; type: "bearer" }>;
  }): Promise<void>;
  exists(path: string): Promise<{ exists: boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  exec(command: SandboxCommand, options?: ExecOptions): Promise<Pick<SandboxProcess, "output">>;
  writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<unknown>;
  destroy(): Promise<void>;
}

/** Resolves a lazy Sandbox handle without starting its container. */
export type WorkspaceArtifactSandboxFactory = (sandboxId: string) => WorkspaceArtifactSandbox;

/** Durable projection of one workspace's canonical Artifacts repository. */
export interface WorkspaceArtifactCanonical {
  repositoryName: string;
  remote: string;
  defaultBranch: string;
  head: string;
  rootId: string;
}

/** Durable identity and baseline for one chat's private Artifacts fork. */
export interface WorkspaceArtifactChatFork {
  chatId: string;
  epoch: number;
  repositoryName: string;
  remote: string;
  defaultBranch: string;
  baselineHead: string;
  latestHead: string;
  sandboxId: string;
}

export interface WorkspaceArtifactForkStatus extends WorkspaceArtifactChatFork {
  state: "creating" | "open" | "accepting" | "accepted" | "discarding";
  acceptedHead?: string;
}

/** Result of accepting a chat fork through the existing proposal lifecycle. */
export type WorkspaceArtifactAcceptResult =
  | { status: "merged"; head: string }
  | { status: "stale"; expectedHead: string; currentHead: string };

interface CanonicalRow {
  [key: string]: string | number;
  repository_name: string;
  remote: string;
  default_branch: string;
  head: string;
  root_id: string;
}

interface ForkRow {
  [key: string]: string | number | null;
  chat_id: string;
  epoch: number;
  repository_name: string;
  remote: string;
  default_branch: string;
  baseline_head: string;
  latest_head: string;
  sandbox_id: string;
  state: string;
  accepted_head: string | null;
}

/** Dependencies for one workspace-owned Artifacts lifecycle. */
export interface WorkspaceArtifactLifecycleOptions {
  state: DurableObjectState;
  workspaceId: string;
  artifacts: WorkspaceArtifactControlPlane;
  reader: WorkspaceArtifactReader;
  gitRuntime: WorkspaceArtifactGitRuntime;
}

/** Builds the production lifecycle from the Workshop Worker's native Cloudflare bindings. */
export function createWorkspaceArtifactLifecycle(
  state: DurableObjectState,
  env: Cloudflare.Env,
  workspaceId: string,
): WorkspaceArtifactLifecycle {
  const reader = new CloudflareWorkspaceArtifactReader({
    artifacts: env.ARTIFACTS,
    accountId: env.ARTIFACTS_ACCOUNT_ID,
    namespace: env.ARTIFACTS_NAMESPACE,
    apiToken: env.ARTIFACTS_API_TOKEN,
  });
  const runtime = new SandboxWorkspaceArtifactGitRuntime(
    sandboxId => getSandbox<Sandbox>(env.Sandbox, sandboxId),
  );
  return new WorkspaceArtifactLifecycle({
    state,
    workspaceId,
    artifacts: env.ARTIFACTS,
    reader,
    gitRuntime: runtime,
  });
}

function isArtifactsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function requireOid(value: string, label: string): string {
  if (!gitOidPattern.test(value)) throw new Error(`${label} is not a Git commit SHA.`);
  return value;
}

function artifactRemoteHost(remote: string): string {
  const url = new URL(remote);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("Artifacts Git remote is invalid.");
  }
  return url.hostname;
}

function requireBranch(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) || value.includes("..") ||
      value.includes("//") || value.includes("@{") || value.endsWith("/") ||
      value.endsWith(".") || value.endsWith(".lock")) {
    throw new Error("Artifacts default branch is invalid.");
  }
  return value;
}

function requireRepositoryPath(value: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.endsWith("/") || value.includes("\0") ||
      value.includes("\\") || value !== value.normalize("NFC") || /\p{Cc}/u.test(value) ||
      new TextEncoder().encode(value).byteLength > maximumRepositoryPathBytes) {
    throw new Error("Workspace repository path is invalid.");
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." ||
      segment.toLowerCase() === ".git" ||
      new TextEncoder().encode(segment).byteLength > maximumRepositorySegmentBytes)) {
    throw new Error("Workspace repository path is invalid.");
  }
  return value;
}

function pathConflicts(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function requireOrderedMutation(
  operations: readonly WorkspaceArtifactMutationOperation[],
): WorkspaceArtifactMutationOperation[] {
  if (operations.length > maximumMutationOperations) {
    throw new Error("Workspace repository mutation has too many operations.");
  }
  return operations.map(operation => {
    if (!isRecord(operation) || typeof operation.kind !== "string") {
      throw new Error("Workspace repository mutation operation is invalid.");
    }
    if (operation.kind === "delete" || operation.kind === "write") {
      const path = requireRepositoryPath(operation.path);
      if (operation.kind === "write" && !(operation.content instanceof Uint8Array)) {
        throw new Error(`Workspace repository file ${path} content is invalid.`);
      }
      return operation.kind === "delete"
        ? { kind: "delete", path }
        : { kind: "write", path, content: operation.content };
    }
    if (operation.kind !== "move") {
      throw new Error("Workspace repository mutation operation is invalid.");
    }
    const from = requireRepositoryPath(operation.from);
    const to = requireRepositoryPath(operation.to);
    if (pathConflicts(from, to)) {
      throw new Error(`Workspace repository paths ${from} and ${to} conflict.`);
    }
    return { kind: "move", from, to };
  });
}

function requireMutation(mutation: WorkspaceArtifactMutation): WorkspaceArtifactMutation {
  if (!Array.isArray(mutation.operations)) {
    throw new Error("Workspace repository mutation operations are invalid.");
  }
  return { operations: requireOrderedMutation(mutation.operations) };
}

function byteStream(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(content);
      controller.close();
    },
  });
}

function noop(): void {}

/** Trusted Sandbox implementation of repository initialization and fast-forward promotion. */
export class SandboxWorkspaceArtifactGitRuntime implements WorkspaceArtifactGitRuntime {
  readonly #sandbox: WorkspaceArtifactSandboxFactory;

  constructor(sandbox: WorkspaceArtifactSandboxFactory) {
    this.#sandbox = sandbox;
  }

  async #run(sandbox: WorkspaceArtifactSandbox, command: SandboxCommand): Promise<string> {
    const process = await sandbox.exec(command, { timeout: 120_000 });
    const output = await process.output({ encoding: "utf8", maxBytes: 256 * 1024 });
    if (output.timedOut) throw new Error("Workspace Git operation timed out.");
    if (output.truncated) throw new Error("Workspace Git operation output exceeded its bound.");
    if (output.exitCode !== 0) {
      throw new Error(`Workspace Git operation exited with code ${output.exitCode}.`);
    }
    return output.stdout;
  }

  /** Creates the first commit in a newly created Artifacts repository. */
  async initialize(request: {
    repositoryName: string;
    remote: string;
    token: string;
    defaultBranch: string;
    index: Uint8Array;
  }): Promise<string> {
    const sandbox = this.#sandbox(`workspace-initialize-${request.repositoryName}`);
    const directory = "/workspace/repo";
    try {
      await sandbox.registerGitAuthInterceptor({
        hosts: { [artifactRemoteHost(request.remote)]: { token: request.token, type: "bearer" } },
      });
      await this.#run(sandbox, ["git", "clone", request.remote, directory]);
      await this.#run(sandbox, ["mkdir", "-p", `${directory}/.workspace`]);
      await sandbox.writeFile(
        `${directory}/${WORKSPACE_INDEX_PATH}`,
        new TextDecoder().decode(request.index),
      );
      await this.#run(sandbox, ["git", "-C", directory, "add", "-A"]);
      await this.#run(sandbox, [
        "git", "-C", directory,
        "-c", "user.name=Cloudflare OS",
        "-c", "user.email=workspace@cloudflare-os.invalid",
        "commit", "-m", "Initialize workspace",
      ]);
      await this.#run(sandbox, [
        "git", "-C", directory, "push", request.remote, `HEAD:${request.defaultBranch}`,
      ]);
      return requireOid(
        (await this.#run(sandbox, ["git", "-C", directory, "rev-parse", "HEAD"])).trim(),
        "Initialized workspace head",
      );
    } finally {
      await sandbox.destroy();
    }
  }

  /** Promotes a chat fork through a clean Sandbox that is never exposed to an agent. */
  async promote(request: {
    canonicalRepositoryName: string;
    canonicalRemote: string;
    canonicalToken: string;
    forkRepositoryName: string;
    forkRemote: string;
    forkToken: string;
    expectedCanonicalHead: string;
    canonicalDefaultBranch: string;
  }): Promise<string> {
    const sandbox = this.#sandbox(
      `workspace-promote-${request.canonicalRepositoryName}-${request.forkRepositoryName}`,
    );
    const directory = "/workspace/repo";
    try {
      await sandbox.registerGitAuthInterceptor({
        hosts: { [artifactRemoteHost(request.forkRemote)]: {
          token: request.forkToken,
          type: "bearer",
        } },
      });
      await this.#run(sandbox, ["git", "clone", request.forkRemote, directory]);
      await this.#run(sandbox, [
        "git", "-C", directory, "merge-base", "--is-ancestor",
        requireOid(request.expectedCanonicalHead, "Expected canonical head"), "HEAD",
      ]);
      await this.#run(sandbox, [
        "git", "-C", directory, "remote", "set-url", "origin", request.canonicalRemote,
      ]);
      await sandbox.registerGitAuthInterceptor({
        hosts: { [artifactRemoteHost(request.canonicalRemote)]: {
          token: request.canonicalToken,
          type: "bearer",
        } },
      });
      await this.#run(sandbox, [
        "git", "-C", directory, "push", "origin",
        `--force-with-lease=refs/heads/${request.canonicalDefaultBranch}:` +
          requireOid(request.expectedCanonicalHead, "Expected canonical head"),
        `HEAD:refs/heads/${request.canonicalDefaultBranch}`,
      ]);
      return requireOid(
        (await this.#run(sandbox, ["git", "-C", directory, "rev-parse", "HEAD"])).trim(),
        "Promoted workspace head",
      );
    } finally {
      await sandbox.destroy();
    }
  }

  /** Lazily materializes one chat fork with a short-lived, subsequently revoked credential. */
  async prepareChat(request: {
    sandboxId: string;
    remote: string;
    token: string;
    expectedHead: string;
  }): Promise<void> {
    const sandbox = this.#sandbox(request.sandboxId);
    const directory = "/workspace/repo";
    if (!(await sandbox.exists(`${directory}/.git`)).exists) {
      await sandbox.registerGitAuthInterceptor({
        hosts: { [artifactRemoteHost(request.remote)]: {
          token: request.token,
          type: "bearer",
        } },
      });
      await this.#run(sandbox, ["git", "clone", request.remote, directory]);
    }
    const head = requireOid(
      (await this.#run(sandbox, ["git", "-C", directory, "rev-parse", "HEAD"])).trim(),
      "Chat Sandbox head",
    );
    if (head !== requireOid(request.expectedHead, "Expected chat fork head")) {
      throw new Error("Chat Sandbox does not match its Artifacts fork.");
    }
  }

  /** Commits and CAS-pushes the chat Sandbox working tree to its private Artifacts fork. */
  async checkpointChat(request: {
    sandboxId: string;
    remote: string;
    token: string;
    defaultBranch: string;
    expectedHead: string;
    actor: WorkspaceActor;
    message: string;
  }): Promise<string> {
    const sandbox = this.#sandbox(request.sandboxId);
    const directory = "/workspace/repo";
    if (!(await sandbox.exists(`${directory}/.git`)).exists) {
      throw new Error("Chat Sandbox working copy does not exist.");
    }
    const expectedHead = requireOid(request.expectedHead, "Expected chat fork head");
    const currentHead = requireOid(
      (await this.#run(sandbox, ["git", "-C", directory, "rev-parse", "HEAD"])).trim(),
      "Chat Sandbox head",
    );
    if (currentHead !== expectedHead) throw new Error("Chat Sandbox checkpoint is stale.");
    await this.#run(sandbox, ["git", "-C", directory, "add", "-A"]);
    const status = await this.#run(sandbox, ["git", "-C", directory, "status", "--porcelain"]);
    if (!status) return currentHead;
    const message = request.message.trim();
    if (!message) throw new Error("Workspace checkpoint message is required.");
    if (!request.actor.name.trim()) throw new Error("Workspace checkpoint actor is required.");
    await this.#run(sandbox, [
      "git", "-C", directory,
      "-c", `user.name=${request.actor.name}`,
      "-c", "user.email=workspace@cloudflare-os.invalid",
      "commit", "-m", message,
    ]);
    const branch = requireBranch(request.defaultBranch);
    await this.#run(sandbox, ["git", "-C", directory, "remote", "set-url", "origin", request.remote]);
    await sandbox.registerGitAuthInterceptor({
      hosts: { [artifactRemoteHost(request.remote)]: {
        token: request.token,
        type: "bearer",
      } },
    });
    await this.#run(sandbox, [
      "git", "-C", directory, "push", "origin",
      `--force-with-lease=refs/heads/${branch}:${expectedHead}`,
      `HEAD:refs/heads/${branch}`,
    ]);
    return requireOid(
      (await this.#run(sandbox, ["git", "-C", directory, "rev-parse", "HEAD"])).trim(),
      "Chat checkpoint head",
    );
  }

  /** Applies one validated file mutation and persists it as a fork checkpoint. */
  async stageChatMutation(request: {
    sandboxId: string;
    remote: string;
    token: string;
    defaultBranch: string;
    expectedHead: string;
    actor: WorkspaceActor;
    message: string;
    mutation: WorkspaceArtifactMutation;
  }): Promise<string> {
    const mutation = requireMutation(request.mutation);
    await this.prepareChat(request);
    const sandbox = this.#sandbox(request.sandboxId);
    const directory = "/workspace/repo";
    const expectedHead = requireOid(request.expectedHead, "Expected chat fork head");
    await this.#run(sandbox, ["git", "-C", directory, "reset", "--hard", expectedHead]);
    await this.#run(sandbox, ["git", "-C", directory, "clean", "-fdx"]);
    for (const operation of mutation.operations) {
      if (operation.kind === "delete") {
        await this.#run(sandbox, [
          "rm", "-rf", "--", `${directory}/${operation.path}`,
        ]);
      } else if (operation.kind === "move") {
        const slash = operation.to.lastIndexOf("/");
        if (slash !== -1) {
          await sandbox.mkdir(`${directory}/${operation.to.slice(0, slash)}`, { recursive: true });
        }
        await this.#run(sandbox, [
          "mv", "--", `${directory}/${operation.from}`, `${directory}/${operation.to}`,
        ]);
      } else {
        const slash = operation.path.lastIndexOf("/");
        if (slash !== -1) {
          await sandbox.mkdir(`${directory}/${operation.path.slice(0, slash)}`, { recursive: true });
        }
        await sandbox.writeFile(`${directory}/${operation.path}`, byteStream(operation.content));
      }
    }
    return this.checkpointChat(request);
  }

  /** Destroys the chat's disposable Sandbox if it exists. */
  async destroy(sandboxId: string): Promise<void> {
    await this.#sandbox(sandboxId).destroy();
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalFromRow(row: CanonicalRow): WorkspaceArtifactCanonical {
  return {
    repositoryName: row.repository_name,
    remote: row.remote,
    defaultBranch: row.default_branch,
    head: row.head,
    rootId: row.root_id,
  };
}

function forkFromRow(row: ForkRow): WorkspaceArtifactChatFork {
  return {
    chatId: row.chat_id,
    epoch: row.epoch,
    repositoryName: row.repository_name,
    remote: row.remote,
    defaultBranch: row.default_branch,
    baselineHead: row.baseline_head,
    latestHead: row.latest_head,
    sandboxId: row.sandbox_id,
  };
}

function forkStatusFromRow(row: ForkRow): WorkspaceArtifactForkStatus {
  const fork = forkFromRow(row);
  if (row.state !== "creating" && row.state !== "open" && row.state !== "accepting" &&
      row.state !== "accepted" && row.state !== "discarding") {
    throw new Error(`Workspace fork ${row.chat_id}/${row.epoch} has invalid state.`);
  }
  return {
    ...fork,
    state: row.state,
    ...(row.accepted_head === null ? {} : { acceptedHead: row.accepted_head }),
  };
}

/**
 * Owns canonical workspace repository and per-chat fork lifecycle metadata.
 *
 * Artifacts owns Git refs and bytes. This object stores only authorization-adjacent identities and
 * projections needed to connect those repositories to the existing chat Accept/Discard lifecycle.
 */
export class WorkspaceArtifactLifecycle {
  readonly #state: DurableObjectState;
  readonly #workspaceId: string;
  readonly #artifacts: WorkspaceArtifactControlPlane;
  readonly #reader: WorkspaceArtifactReader;
  readonly #gitRuntime: WorkspaceArtifactGitRuntime;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceArtifactLifecycleOptions) {
    if (!options.workspaceId) throw new Error("Workspace ID is required.");
    this.#state = options.state;
    this.#workspaceId = options.workspaceId;
    this.#artifacts = options.artifacts;
    this.#reader = options.reader;
    this.#gitRuntime = options.gitRuntime;
  }

  #ensureTables(): void {
    this.#state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_artifact_repository (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        repository_name TEXT NOT NULL UNIQUE,
        remote TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        head TEXT NOT NULL,
        root_id TEXT NOT NULL
      )
    `);
    this.#state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_artifact_forks (
        chat_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        repository_name TEXT NOT NULL UNIQUE,
        remote TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        baseline_head TEXT NOT NULL,
        latest_head TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('creating', 'open', 'accepting', 'accepted', 'discarding')),
        accepted_head TEXT,
        PRIMARY KEY (chat_id, epoch)
      )
    `);
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = noop;
    this.#tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #canonicalRow(): CanonicalRow | undefined {
    this.#ensureTables();
    return [...this.#state.storage.sql.exec<CanonicalRow>(`
      SELECT repository_name, remote, default_branch, head, root_id
      FROM workspace_artifact_repository
      WHERE singleton = 1
    `)][0];
  }

  #forkRow(chatId: string, epoch: number): ForkRow | undefined {
    this.#ensureTables();
    return [...this.#state.storage.sql.exec<ForkRow>(`
      SELECT chat_id, epoch, repository_name, remote, default_branch, baseline_head,
             latest_head, sandbox_id, state, accepted_head
      FROM workspace_artifact_forks
      WHERE chat_id = ? AND epoch = ?
    `, chatId, epoch)][0];
  }

  async #reconcileOpenForkHead(row: ForkRow): Promise<ForkRow> {
    const liveHead = await this.#reader.getHead(row.repository_name);
    if (liveHead === undefined) throw new Error("Chat fork has no head.");
    requireOid(liveHead, "Chat fork head");
    if (liveHead === row.latest_head) return row;
    this.#state.storage.sql.exec(`
      UPDATE workspace_artifact_forks SET latest_head = ?
      WHERE chat_id = ? AND epoch = ? AND state = 'open' AND latest_head = ?
    `, liveHead, row.chat_id, row.epoch, row.latest_head);
    const reconciled = this.#forkRow(row.chat_id, row.epoch);
    if (!reconciled || reconciled.state !== "open" || reconciled.latest_head !== liveHead) {
      throw new Error("Chat fork checkpoint recovery did not persist.");
    }
    return reconciled;
  }

  async #canonicalRepositoryName(): Promise<string> {
    return `workspace-${(await sha256Hex(this.#workspaceId)).slice(0, 40)}`;
  }

  async #forkRepositoryName(chatId: string, epoch: number): Promise<string> {
    const [workspaceHash, chatHash] = await Promise.all([
      sha256Hex(this.#workspaceId),
      sha256Hex(chatId),
    ]);
    return `workspace-${workspaceHash.slice(0, 24)}-chat-${chatHash.slice(0, 24)}-e${epoch}`;
  }

  async #getReadyRepository(name: string): Promise<WorkspaceArtifactRepo> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.#artifacts.get(name);
      } catch (error) {
        if (!isArtifactsError(error, "FORK_IN_PROGRESS") || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    throw new Error(`Artifacts repository ${name} did not become ready.`);
  }

  async #revokeToken(repo: WorkspaceArtifactRepo, tokenOrId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await repo.revokeToken(tokenOrId);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Could not revoke a workspace Artifacts token.", { cause: lastError });
  }

  /** Creates or resolves the workspace's one canonical Artifacts repository. */
  ensureCanonical(actor: WorkspaceActor): Promise<WorkspaceArtifactCanonical> {
    return this.#withLock(async () => {
      const stored = this.#canonicalRow();
      if (stored) return canonicalFromRow(stored);

      const repositoryName = await this.#canonicalRepositoryName();
      let initialToken: string | undefined;
      try {
        const created = await this.#artifacts.create(repositoryName, {
          description: `Workspace ${this.#workspaceId}`,
          readOnly: false,
          setDefaultBranch: "main",
        });
        initialToken = created.token;
      } catch (error) {
        if (!isArtifactsError(error, "ALREADY_EXISTS")) throw error;
      }

      const repo = await this.#getReadyRepository(repositoryName);
      let head = await this.#reader.getHead(repositoryName);
      let rootId: string;
      if (head === undefined) {
        const index = createEmptyWorkspaceIndex({
          actorId: actor.id,
          now: new Date().toISOString(),
        });
        const minted = initialToken === undefined ? await repo.createToken("write", 900) : undefined;
        const token = initialToken ?? minted?.plaintext;
        if (token === undefined) throw new Error("Workspace initialization has no Git token.");
        try {
          head = requireOid(await this.#gitRuntime.initialize({
            repositoryName,
            remote: repo.remote,
            token,
            defaultBranch: repo.defaultBranch,
            index: serializeWorkspaceIndex(index),
          }), "Initialized workspace head");
        } finally {
          await this.#revokeToken(repo, minted?.id ?? token);
        }
        rootId = index.rootId;
      } else {
        requireOid(head, "Workspace head");
        const index = parseWorkspaceIndex(
          await this.#reader.readFile(repositoryName, head, WORKSPACE_INDEX_PATH),
        );
        rootId = index.rootId;
        if (initialToken !== undefined) await this.#revokeToken(repo, initialToken);
      }

      this.#state.storage.sql.exec(`
        INSERT INTO workspace_artifact_repository (
          singleton, repository_name, remote, default_branch, head, root_id
        ) VALUES (1, ?, ?, ?, ?, ?)
      `, repositoryName, repo.remote, repo.defaultBranch, head, rootId);
      return { repositoryName, remote: repo.remote, defaultBranch: repo.defaultBranch, head, rootId };
    });
  }

  /** Returns the initialized canonical repository without creating it. */
  getCanonical(): Promise<WorkspaceArtifactCanonical | undefined> {
    return this.#withLock(async () => {
      const row = this.#canonicalRow();
      return row === undefined ? undefined : canonicalFromRow(row);
    });
  }

  async #readRepositoryCommitLog(
    repositoryName: string,
    ref: string,
    limit: number,
  ): Promise<CommitInfo[]> {
    const repo = await this.#getReadyRepository(repositoryName);
    if (!hasRepositoryLog(repo)) {
      throw new Error("The Artifacts binding does not expose repository history.");
    }
    return parseCommitLog(await repo.log({ ref, limit }), limit);
  }

  /** Returns bounded commit metadata from the canonical Artifacts repository. */
  readCommitLog(oid: string, options: { depth?: number } = {}): Promise<CommitInfo[]> {
    const ref = requireOid(oid, "Workspace commit");
    const limit = requireCommitHistoryDepth(options.depth, maximumCommitHistoryDepth);
    return this.#withLock(async () => {
      const row = this.#canonicalRow();
      if (!row) throw new Error("Canonical workspace repository is not initialized.");
      return this.#readRepositoryCommitLog(row.repository_name, ref, limit);
    });
  }

  /** Returns bounded commit metadata from one existing chat fork. */
  readChatCommitLog(
    chatId: string,
    epoch: number,
    oid: string,
    options: { depth?: number } = {},
  ): Promise<CommitInfo[]> {
    if (!chatId || !Number.isInteger(epoch) || epoch < 0 || epoch > maximumEpoch) {
      throw new Error("Chat fork identity is invalid.");
    }
    const ref = requireOid(oid, "Chat fork commit");
    const limit = requireCommitHistoryDepth(options.depth, maximumCommitHistoryDepth);
    return this.#withLock(async () => {
      const row = this.#forkRow(chatId, epoch);
      if (!row) throw new Error("Chat fork does not exist.");
      return this.#readRepositoryCommitLog(row.repository_name, ref, limit);
    });
  }

  /** Returns recent commits from the canonical repository's default branch. */
  getHistory(limit = defaultCommitHistoryDepth): Promise<CommitInfo[]> {
    const depth = requireCommitHistoryDepth(limit, defaultCommitHistoryDepth);
    return this.#withLock(async () => {
      const row = this.#canonicalRow();
      if (!row) throw new Error("Canonical workspace repository is not initialized.");
      const repo = await this.#getReadyRepository(row.repository_name);
      if (!hasRepositoryLog(repo)) {
        throw new Error("The Artifacts binding does not expose repository history.");
      }
      return parseCommitLog(
        await repo.log({ ref: repo.defaultBranch, limit: depth }),
        depth,
      );
    });
  }

  /** Returns one open chat fork without creating it. */
  getChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactChatFork | undefined> {
    return this.#withLock(async () => {
      let row = this.#forkRow(chatId, epoch);
      if (row?.state === "open") row = await this.#reconcileOpenForkHead(row);
      return row?.state === "open" ? forkFromRow(row) : undefined;
    });
  }

  /** Returns durable lifecycle state for one existing fork without creating it. */
  getForkStatus(chatId: string, epoch: number): Promise<WorkspaceArtifactForkStatus | undefined> {
    return this.#withLock(async () => {
      let row = this.#forkRow(chatId, epoch);
      if (!row) return undefined;
      if (row.state === "open") row = await this.#reconcileOpenForkHead(row);
      return forkStatusFromRow(row);
    });
  }

  /** Creates or resolves one private Artifacts fork for a writable chat epoch. */
  ensureChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactChatFork> {
    return this.#withLock(async () => {
      if (!chatId || !Number.isInteger(epoch) || epoch < 0 || epoch > maximumEpoch) {
        throw new Error("Chat fork identity is invalid.");
      }
      const existing = this.#forkRow(chatId, epoch);
      if (existing?.state === "open") return forkFromRow(existing);
      if (existing && existing.state !== "creating") {
        throw new Error(`Chat fork ${chatId}/${epoch} is ${existing.state}.`);
      }

      const canonicalRow = this.#canonicalRow();
      if (!canonicalRow) throw new Error("Canonical workspace repository is not initialized.");
      const liveHead = await this.#reader.getHead(canonicalRow.repository_name);
      if (liveHead === undefined) throw new Error("Canonical workspace repository has no head.");
      requireOid(liveHead, "Canonical workspace head");
      const baselineHead = existing?.baseline_head ?? liveHead;
      const repositoryName = existing?.repository_name ??
        await this.#forkRepositoryName(chatId, epoch);
      const sandboxId = existing?.sandbox_id ?? `workspace-chat-${await sha256Hex(repositoryName)}`;

      if (!existing) {
        this.#state.storage.sql.exec(`
          INSERT INTO workspace_artifact_forks (
            chat_id, epoch, repository_name, remote, default_branch, baseline_head,
            latest_head, sandbox_id, state, accepted_head
          ) VALUES (?, ?, ?, '', 'main', ?, ?, ?, 'creating', NULL)
        `, chatId, epoch, repositoryName, baselineHead, baselineHead, sandboxId);
      }

      let initialToken: string | undefined;
      try {
        const canonical = await this.#getReadyRepository(canonicalRow.repository_name);
        const forked = await canonical.fork(repositoryName, {
          description: `Workspace chat ${chatId} epoch ${epoch}`,
          readOnly: false,
          defaultBranchOnly: true,
        });
        initialToken = forked.token;
      } catch (error) {
        if (!isArtifactsError(error, "ALREADY_EXISTS")) throw error;
      }

      const repo = await this.#getReadyRepository(repositoryName);
      if (initialToken !== undefined) await this.#revokeToken(repo, initialToken);
      const forkHead = await this.#reader.getHead(repositoryName);
      if (forkHead === undefined) throw new Error("Chat fork has no head.");
      requireOid(forkHead, "Chat fork head");
      if (forkHead !== baselineHead) {
        throw new Error(`Chat fork ${repositoryName} does not match its recorded baseline.`);
      }

      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_forks
        SET remote = ?, default_branch = ?, baseline_head = ?, latest_head = ?, state = 'open'
        WHERE chat_id = ? AND epoch = ? AND state = 'creating'
      `, repo.remote, repo.defaultBranch, baselineHead, forkHead, chatId, epoch);
      const ready = this.#forkRow(chatId, epoch);
      if (!ready || ready.state !== "open") throw new Error("Chat fork did not become ready.");
      return forkFromRow(ready);
    });
  }

  /** Lazily clones one chat fork into its persistent Sandbox working copy. */
  async prepareChatWorkingCopy(
    chatId: string,
    epoch: number,
  ): Promise<WorkspaceArtifactChatFork> {
    await this.ensureChatFork(chatId, epoch);
    return this.#withLock(async () => {
      let row = this.#forkRow(chatId, epoch);
      if (!row || row.state !== "open") throw new Error("Chat fork is not open.");
      row = await this.#reconcileOpenForkHead(row);
      const repo = await this.#getReadyRepository(row.repository_name);
      const token = await repo.createToken("write", 900);
      try {
        await this.#gitRuntime.prepareChat({
          sandboxId: row.sandbox_id,
          remote: repo.remote,
          token: token.plaintext,
          expectedHead: row.latest_head,
        });
      } finally {
        await this.#revokeToken(repo, token.id);
      }
      return forkFromRow(row);
    });
  }

  /** Commits and pushes one chat Sandbox checkpoint to its private fork. */
  checkpointChatWorkingCopy(
    chatId: string,
    epoch: number,
    actor: WorkspaceActor,
    message: string,
  ): Promise<WorkspaceArtifactChatFork> {
    return this.#withLock(async () => {
      let row = this.#forkRow(chatId, epoch);
      if (!row || row.state !== "open") throw new Error("Chat fork is not open.");
      row = await this.#reconcileOpenForkHead(row);
      const repo = await this.#getReadyRepository(row.repository_name);
      const token = await repo.createToken("write", 900);
      let head: string;
      try {
        head = requireOid(await this.#gitRuntime.checkpointChat({
          sandboxId: row.sandbox_id,
          remote: repo.remote,
          token: token.plaintext,
          defaultBranch: repo.defaultBranch,
          expectedHead: row.latest_head,
          actor,
          message,
        }), "Chat checkpoint head");
      } finally {
        await this.#revokeToken(repo, token.id);
      }
      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_forks SET latest_head = ?
        WHERE chat_id = ? AND epoch = ? AND state = 'open' AND latest_head = ?
      `, head, chatId, epoch, row.latest_head);
      const checkpoint = this.#forkRow(chatId, epoch);
      if (!checkpoint || checkpoint.state !== "open" || checkpoint.latest_head !== head) {
        throw new Error("Chat checkpoint metadata did not persist.");
      }
      return forkFromRow(checkpoint);
    });
  }

  /** Applies one file mutation to a chat fork and records the resulting durable checkpoint. */
  async stageChatMutation(
    chatId: string,
    epoch: number,
    actor: WorkspaceActor,
    message: string,
    mutation: WorkspaceArtifactMutation,
  ): Promise<WorkspaceArtifactChatFork> {
    await this.ensureChatFork(chatId, epoch);
    return this.#withLock(async () => {
      let row = this.#forkRow(chatId, epoch);
      if (!row || row.state !== "open") throw new Error("Chat fork is not open.");
      row = await this.#reconcileOpenForkHead(row);
      const repo = await this.#getReadyRepository(row.repository_name);
      const token = await repo.createToken("write", 900);
      let head: string;
      try {
        head = requireOid(await this.#gitRuntime.stageChatMutation({
          sandboxId: row.sandbox_id,
          remote: repo.remote,
          token: token.plaintext,
          defaultBranch: repo.defaultBranch,
          expectedHead: row.latest_head,
          actor,
          message,
          mutation,
        }), "Chat checkpoint head");
      } finally {
        await this.#revokeToken(repo, token.id);
      }
      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_forks SET latest_head = ?
        WHERE chat_id = ? AND epoch = ? AND state = 'open' AND latest_head = ?
      `, head, chatId, epoch, row.latest_head);
      const checkpoint = this.#forkRow(chatId, epoch);
      if (!checkpoint || checkpoint.state !== "open" || checkpoint.latest_head !== head) {
        throw new Error("Chat checkpoint metadata did not persist.");
      }
      return forkFromRow(checkpoint);
    });
  }

  /** Accepts one chat fork only when canonical main still matches its recorded baseline. */
  acceptChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactAcceptResult> {
    return this.#withLock(async () => {
      const canonicalRow = this.#canonicalRow();
      if (!canonicalRow) throw new Error("Canonical workspace repository is not initialized.");
      const row = this.#forkRow(chatId, epoch);
      if (!row) {
        const head = await this.#reader.getHead(canonicalRow.repository_name);
        if (head === undefined) throw new Error("Canonical workspace repository has no head.");
        return { status: "merged", head: requireOid(head, "Canonical workspace head") };
      }
      if (row.state === "accepted") return this.#acceptedForkResult(row);
      if (row.state !== "open" && row.state !== "accepting") {
        throw new Error(`Chat fork ${chatId}/${epoch} is ${row.state}.`);
      }

      const currentHead = await this.#reader.getHead(canonicalRow.repository_name);
      if (currentHead === undefined) throw new Error("Canonical workspace repository has no head.");
      requireOid(currentHead, "Canonical workspace head");
      if (row.state === "accepting" && currentHead === row.latest_head) {
        this.#state.storage.sql.exec(
          "UPDATE workspace_artifact_repository SET head = ? WHERE singleton = 1",
          currentHead,
        );
        this.#state.storage.sql.exec(`
          UPDATE workspace_artifact_forks SET state = 'accepted', accepted_head = ?
          WHERE chat_id = ? AND epoch = ? AND state = 'accepting'
        `, currentHead, chatId, epoch);
        const recovered = this.#forkRow(chatId, epoch);
        if (!recovered || recovered.state !== "accepted") {
          throw new Error("Accepted chat fork recovery did not persist.");
        }
        return this.#acceptedForkResult(recovered);
      }
      if (currentHead !== row.baseline_head) {
        if (row.state === "accepting") {
          this.#state.storage.sql.exec(`
            UPDATE workspace_artifact_forks SET state = 'open'
            WHERE chat_id = ? AND epoch = ? AND state = 'accepting'
          `, chatId, epoch);
        }
        return { status: "stale", expectedHead: row.baseline_head, currentHead };
      }
      const forkHead = await this.#reader.getHead(row.repository_name);
      if (forkHead === undefined) throw new Error("Chat fork has no head.");
      requireOid(forkHead, "Chat fork head");
      await this.#reader.listFiles(row.repository_name, forkHead);

      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_forks SET state = 'accepting', latest_head = ?
        WHERE chat_id = ? AND epoch = ?
      `, forkHead, chatId, epoch);
      const canonical = await this.#getReadyRepository(canonicalRow.repository_name);
      const fork = await this.#getReadyRepository(row.repository_name);
      const canonicalToken = await canonical.createToken("write", 900);
      let forkToken: Awaited<ReturnType<WorkspaceArtifactRepo["createToken"]>>;
      try {
        forkToken = await fork.createToken("read", 900);
      } catch (error) {
        await this.#revokeToken(canonical, canonicalToken.id);
        throw error;
      }
      let acceptedHead: string;
      try {
        try {
          acceptedHead = requireOid(await this.#gitRuntime.promote({
            canonicalRepositoryName: canonical.name,
            canonicalRemote: canonical.remote,
            canonicalToken: canonicalToken.plaintext,
            forkRepositoryName: fork.name,
            forkRemote: fork.remote,
            forkToken: forkToken.plaintext,
            expectedCanonicalHead: row.baseline_head,
            canonicalDefaultBranch: canonical.defaultBranch,
          }), "Accepted workspace head");
        } catch (error) {
          const recoveredHead = await this.#reader.getHead(canonicalRow.repository_name);
          if (recoveredHead === forkHead) {
            acceptedHead = forkHead;
          } else if (recoveredHead !== undefined && recoveredHead !== row.baseline_head) {
            this.#state.storage.sql.exec(`
              UPDATE workspace_artifact_forks SET state = 'open'
              WHERE chat_id = ? AND epoch = ? AND state = 'accepting'
            `, chatId, epoch);
            return {
              status: "stale",
              expectedHead: row.baseline_head,
              currentHead: requireOid(recoveredHead, "Canonical workspace head"),
            };
          } else {
            this.#state.storage.sql.exec(`
              UPDATE workspace_artifact_forks SET state = 'open'
              WHERE chat_id = ? AND epoch = ? AND state = 'accepting'
            `, chatId, epoch);
            throw error;
          }
        }
      } finally {
        await Promise.all([
          this.#revokeToken(canonical, canonicalToken.id),
          this.#revokeToken(fork, forkToken.id),
        ]);
      }

      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_repository SET head = ? WHERE singleton = 1
      `, acceptedHead);
      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_forks SET state = 'accepted', accepted_head = ?
        WHERE chat_id = ? AND epoch = ?
      `, acceptedHead, chatId, epoch);
      const accepted = this.#forkRow(chatId, epoch);
      if (!accepted) throw new Error("Accepted chat fork metadata disappeared.");
      return this.#acceptedForkResult(accepted);
    });
  }

  #acceptedForkResult(row: ForkRow): WorkspaceArtifactAcceptResult {
    if (!row.accepted_head) throw new Error("Accepted chat fork has no accepted head.");
    return { status: "merged", head: requireOid(row.accepted_head, "Accepted workspace head") };
  }

  /** Deletes an accepted fork only after the Overseer commits its matching merge boundary. */
  completeAcceptedChatFork(chatId: string, epoch: number, acceptedHead: string): Promise<void> {
    return this.#withLock(async () => {
      const row = this.#forkRow(chatId, epoch);
      if (!row) return;
      const expectedHead = requireOid(acceptedHead, "Accepted workspace head");
      if (row.state !== "accepted" || row.accepted_head !== expectedHead) {
        throw new Error("Chat fork does not match the completed acceptance.");
      }
      await this.#cleanupFork(row);
    });
  }

  async #cleanupFork(row: ForkRow): Promise<void> {
    await this.#gitRuntime.destroy(row.sandbox_id);
    await this.#artifacts.delete(row.repository_name);
    this.#state.storage.sql.exec(
      "DELETE FROM workspace_artifact_forks WHERE chat_id = ? AND epoch = ?",
      row.chat_id,
      row.epoch,
    );
  }

  /** Closes a chat fork before deleting its Sandbox and Artifacts repository. */
  discardChatFork(chatId: string, epoch: number): Promise<void> {
    return this.#withLock(async () => {
      const row = this.#forkRow(chatId, epoch);
      if (!row) return;
      if (row.state === "accepted") throw new Error("An accepted chat fork cannot be discarded.");
      this.#state.storage.sql.exec(`
        UPDATE workspace_artifact_forks SET state = 'discarding'
        WHERE chat_id = ? AND epoch = ?
      `, chatId, epoch);
      await this.#cleanupFork({ ...row, state: "discarding" });
    });
  }

  /** Deletes the canonical repository and every fork and Sandbox owned by this workspace. */
  deleteWorkspaceRepositories(): Promise<void> {
    return this.#withLock(async () => {
      this.#ensureTables();
      const forks = [...this.#state.storage.sql.exec<ForkRow>(`
        SELECT chat_id, epoch, repository_name, remote, default_branch, baseline_head,
               latest_head, sandbox_id, state, accepted_head
        FROM workspace_artifact_forks
        ORDER BY chat_id, epoch
      `)];
      for (const fork of forks) await this.#cleanupFork(fork);
      const canonical = this.#canonicalRow();
      if (!canonical) return;
      await this.#artifacts.delete(canonical.repository_name);
      this.#state.storage.sql.exec(
        "DELETE FROM workspace_artifact_repository WHERE singleton = 1",
      );
    });
  }
}

const workspaceGadgetRoot = ".workspace/gadgets";
const maximumGadgetSnapshotBytes = 16 * 1024 * 1024;

export interface ArtifactsWorkspaceRepositoryOptions {
  lifecycle: WorkspaceArtifactLifecycle;
  reader: WorkspaceArtifactReader;
}

export interface WorkspaceCodeRepository {
  ensureCanonical(actor: WorkspaceActor): Promise<WorkspaceArtifactCanonical>;
  readCommitLog(oid: string, options?: { depth?: number }): Promise<CommitInfo[]>;
  getHistory(limit?: number): Promise<CommitInfo[]>;
  readGadgetFiles(gadgetId: number, ref: string): Promise<Map<string, string>>;
  changedGadgetPaths(
    gadgetId: number,
    previousRef: string | undefined,
    currentRef: string | undefined,
  ): Promise<Set<string>>;
  stageGadgetFiles(
    chatId: string,
    epoch: number,
    actor: WorkspaceActor,
    message: string,
    gadgets: ReadonlyMap<number, ReadonlyMap<string, string>>,
  ): Promise<WorkspaceArtifactChatFork>;
  commitGadgetFiles(
    operationId: string,
    actor: WorkspaceActor,
    message: string,
    gadgetId: number,
    files: ReadonlyMap<string, string>,
  ): Promise<string>;
  completeGadgetFiles(operationId: string, acceptedHead: string): Promise<void>;
  acceptChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactAcceptResult>;
  completeAcceptedChatFork(chatId: string, epoch: number, acceptedHead: string): Promise<void>;
  discardChatFork(chatId: string, epoch: number): Promise<void>;
}

export interface WorkspaceArtifactServices {
  lifecycle: WorkspaceArtifactLifecycle;
  reader: WorkspaceArtifactReader;
  codeRepository: ArtifactsWorkspaceRepository;
}

export function createWorkspaceArtifactServices(
  state: DurableObjectState,
  env: Cloudflare.Env,
  workspaceId: string,
): WorkspaceArtifactServices {
  const reader = new CloudflareWorkspaceArtifactReader({
    artifacts: env.ARTIFACTS,
    accountId: env.ARTIFACTS_ACCOUNT_ID,
    namespace: env.ARTIFACTS_NAMESPACE,
    apiToken: env.ARTIFACTS_API_TOKEN,
  });
  const lifecycle = new WorkspaceArtifactLifecycle({
    state,
    workspaceId,
    artifacts: env.ARTIFACTS,
    reader,
    gitRuntime: new SandboxWorkspaceArtifactGitRuntime(
      sandboxId => getSandbox<Sandbox>(env.Sandbox, sandboxId),
    ),
  });
  return {
    lifecycle,
    reader,
    codeRepository: new ArtifactsWorkspaceRepository({ lifecycle, reader }),
  };
}

/** Maps workspace-level Artifacts revisions to the gadget source subtrees they contain. */
export class ArtifactsWorkspaceRepository implements WorkspaceCodeRepository {
  readonly #lifecycle: WorkspaceArtifactLifecycle;
  readonly #reader: WorkspaceArtifactReader;

  constructor(options: ArtifactsWorkspaceRepositoryOptions) {
    this.#lifecycle = options.lifecycle;
    this.#reader = options.reader;
  }

  ensureCanonical(actor: WorkspaceActor): Promise<WorkspaceArtifactCanonical> {
    return this.#lifecycle.ensureCanonical(actor);
  }

  readCommitLog(oid: string, options?: { depth?: number }): Promise<CommitInfo[]> {
    return this.#lifecycle.readCommitLog(oid, options);
  }

  getHistory(limit?: number): Promise<CommitInfo[]> {
    return this.#lifecycle.getHistory(limit);
  }

  async #canonical(): Promise<WorkspaceArtifactCanonical> {
    const canonical = await this.#lifecycle.getCanonical();
    if (!canonical) throw new Error("Canonical workspace repository is not initialized.");
    return canonical;
  }

  async readGadgetFiles(gadgetId: number, ref: string): Promise<Map<string, string>> {
    if (!Number.isSafeInteger(gadgetId) || gadgetId < 0) {
      throw new Error("Workspace gadget ID is invalid.");
    }
    const canonical = await this.#canonical();
    const prefix = `${workspaceGadgetRoot}/${gadgetId}/`;
    const paths = (await this.#reader.listFiles(canonical.repositoryName, ref))
      .filter(path => path.startsWith(prefix));
    const files = new Map<string, string>();
    let totalBytes = 0;
    for (const path of paths) {
      const bytes = await this.#reader.readFile(canonical.repositoryName, ref, path);
      totalBytes += bytes.byteLength;
      if (totalBytes > maximumGadgetSnapshotBytes) {
        throw new Error("Workspace gadget source exceeds the read bound.");
      }
      const relativePath = path.slice(prefix.length);
      files.set(relativePath,
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    }
    return files;
  }

  async changedGadgetPaths(
    gadgetId: number,
    previousRef: string | undefined,
    currentRef: string | undefined,
  ): Promise<Set<string>> {
    const [previous, current] = await Promise.all([
      previousRef === undefined ? new Map<string, string>()
        : this.readGadgetFiles(gadgetId, previousRef),
      currentRef === undefined ? new Map<string, string>()
        : this.readGadgetFiles(gadgetId, currentRef),
    ]);
    const changed = new Set<string>();
    for (const path of new Set([...previous.keys(), ...current.keys()])) {
      if (previous.get(path) !== current.get(path)) changed.add(path);
    }
    return changed;
  }

  stageGadgetFiles(
    chatId: string,
    epoch: number,
    actor: WorkspaceActor,
    message: string,
    gadgets: ReadonlyMap<number, ReadonlyMap<string, string>>,
  ): Promise<WorkspaceArtifactChatFork> {
    const operations: WorkspaceArtifactMutationOperation[] = [];
    for (const [gadgetId, files] of [...gadgets].toSorted((left, right) => left[0] - right[0])) {
      if (!Number.isSafeInteger(gadgetId) || gadgetId < 0) {
        throw new Error("Workspace gadget ID is invalid.");
      }
      const root = `${workspaceGadgetRoot}/${gadgetId}`;
      operations.push({ kind: "delete", path: root });
      for (const [path, content] of [...files].toSorted((left, right) =>
        left[0].localeCompare(right[0]))) {
        operations.push({
          kind: "write",
          path: requireRepositoryPath(`${root}/${path}`),
          content: new TextEncoder().encode(content),
        });
      }
    }
    return this.#lifecycle.stageChatMutation(chatId, epoch, actor, message, { operations });
  }

  async commitGadgetFiles(
    operationId: string,
    actor: WorkspaceActor,
    message: string,
    gadgetId: number,
    files: ReadonlyMap<string, string>,
  ): Promise<string> {
    const chatId = `trusted-gadget-operation:${operationId}`;
    const epoch = 0;
    await this.ensureCanonical(actor);
    let existing = await this.#lifecycle.getForkStatus(chatId, epoch);
    if (existing?.state === "discarding") {
      await this.#lifecycle.discardChatFork(chatId, epoch);
      existing = undefined;
    }
    if (!existing || existing.state === "creating" || existing.state === "open") {
      await this.stageGadgetFiles(
        chatId,
        epoch,
        actor,
        message,
        new Map([[gadgetId, files]]),
      );
    }
    const accepted = await this.#lifecycle.acceptChatFork(chatId, epoch);
    if (accepted.status === "stale") {
      await this.#lifecycle.discardChatFork(chatId, epoch);
      throw new Error("Workspace changed while committing trusted gadget files.");
    }
    return accepted.head;
  }

  completeGadgetFiles(operationId: string, acceptedHead: string): Promise<void> {
    return this.#lifecycle.completeAcceptedChatFork(
      `trusted-gadget-operation:${operationId}`,
      0,
      acceptedHead,
    );
  }

  acceptChatFork(chatId: string, epoch: number): Promise<WorkspaceArtifactAcceptResult> {
    return this.#lifecycle.acceptChatFork(chatId, epoch);
  }

  completeAcceptedChatFork(
    chatId: string,
    epoch: number,
    acceptedHead: string,
  ): Promise<void> {
    return this.#lifecycle.completeAcceptedChatFork(chatId, epoch, acceptedHead);
  }

  discardChatFork(chatId: string, epoch: number): Promise<void> {
    return this.#lifecycle.discardChatFork(chatId, epoch);
  }
}
