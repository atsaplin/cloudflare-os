import type { RpcCompatible, RpcStub } from "capnweb";
import type {
  AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AiChatAuthorInfo, AiModelConfig,
  AuthenticatedApi, GadgetClient, OutputFormatOffer, Overseer, PublicApi, WorkpieceId,
  WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import { AgentTurnCompletion, loadAllChatHistory } from "./agent-session-internals.js";
import { RpcTarget, connect, nextUsernames, signUp, stubFor, waitFor } from "./rpc-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_DEBOUNCE_MS = 500;

function connectTyped<Session extends RpcCompatible<Session>>(
    gadget: RpcStub<GadgetClient>, chatId?: number): Promise<RpcStub<Session>>;
function connectTyped(gadget: RpcStub<GadgetClient>, chatId?: number) {
  return gadget.connectToGadget(chatId);
}

/** Options for creating an isolated production Workshop agent session. */
export type AgentSessionOptions = {
  /** Model to use. It must appear in the new workspace's `listModels()` result. Defaults to the first. */
  modelId?: string;
  /** Access application JWT. When present, authenticate as its Access identity instead of signing up. */
  accessToken?: string;
  /** Optional model to add to the fresh local account before its workspace opens. */
  userModel?: { profile: AiChatAuthorInfo; config: AiModelConfig };
  /** Alphanumeric prefix for the fresh account name. */
  usernamePrefix?: string;
  /** Hard limit for each agent turn. Defaults to two minutes. */
  timeoutMs?: number;
};

/** Options for one prompt in an agent session. */
export type AgentTurnOptions = {
  /** Merge all proposed changes, including the current live draft, after the agent settles. */
  acceptChanges?: boolean;
  /** Cancels the turn by calling `stopAgent()` and rejecting the run. */
  signal?: AbortSignal;
};

/** The branch a verifier should connect to. */
export type AgentGadgetBranch = "accepted" | "chat";


/** Authoritative state returned after one agent turn settles. */
export type AgentTurnResult = {
  /** Chat created by the first turn and reused by later turns. */
  chatId: number;
  /** Complete canonical chat history in ascending sequence order. */
  history: AiChatMessage[];
  /** Workpieces known when the turn finished. */
  workpieces: WorkpieceSummary[];
  /** Agent error messages posted during the turn. Empty when the turn completed normally. */
  agentErrors: string[];
  /** Provider usage available from chat metadata after this turn. */
  usage: { totalTokens?: number; costUsd?: number };
};

/** Return the final user-visible assistant text from canonical chat history. */
export function finalAssistantText(history: readonly AiChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry?.type === "message" && entry.author.type === "agent" && entry.message !== "") {
      return entry.message;
    }
  }
  return "";
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  completion: AgentTurnCompletion | undefined;

  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void { this.completion?.metadata(chat); }
  deleted(_chatId: number): void {}
  message(_entry: AiChatMessage): void {}
  changeApplied(
      _chatId: number, _generation: number, _revision: number, _author: AiChatAuthorInfo,
      _change: CodeChange, _submission?: {clientId: string; seq: number}): void {}
  stream(_chatId: number, _event: AiChatStreamEvent): void {}
}

class WorkpieceSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly readyPromise: Promise<void>;
  #resolveReady: () => void = () => {};

  constructor() {
    super();
    this.readyPromise = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  }

  entry(summary: WorkpieceSummary): void { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.entries.delete(id); }
  ready(): void { this.#resolveReady(); }
}


/**
 * Drives the production Workshop RPC lifecycle for one fresh user and workspace.
 *
 * The class deliberately does not interpret agent output. Callers own verification and evaluation.
 * Dispose the session when finished; verifier stubs returned by this class remain caller-owned.
 */
export class AgentSession implements Disposable {
  /** Model selected from the workspace's `listModels()` result. */
  readonly modelId: string;
  /** ID of the fresh workspace owned by this session's fresh user. */
  readonly workspaceId: string;
  #publicApi: RpcStub<PublicApi>;
  #authenticatedApi: RpcStub<AuthenticatedApi>;
  #overseer: RpcStub<Overseer>;
  #chatSubscriber = new ChatSubscriber();
  #chatSubscriberStub: RpcStub<ChatSubscriber> | undefined;
  #chatSubscription: RpcStub<{}> | undefined;
  #workpieceSubscriber = new WorkpieceSubscriber();
  #workpieceSubscriberStub: RpcStub<WorkpieceSubscriber> | undefined;
  #workpieceSubscription: RpcStub<{}> | undefined;
  #chatId: number | undefined;
  #turn: AgentTurnCompletion | undefined;
  #timeoutMs: number;
  #settleDebounceMs: number;
  #disposed = false;
  #failed = false;

  private constructor(
      publicApi: RpcStub<PublicApi>,
      authenticatedApi: RpcStub<AuthenticatedApi>,
      overseer: RpcStub<Overseer>,
      workspaceId: string,
      modelId: string,
      timeoutMs: number) {
    this.#publicApi = publicApi;
    this.#authenticatedApi = authenticatedApi;
    this.#overseer = overseer;
    this.workspaceId = workspaceId;
    this.modelId = modelId;
    this.#timeoutMs = timeoutMs;
    this.#settleDebounceMs = DEFAULT_SETTLE_DEBOUNCE_MS;
  }

  /** Create a fresh account and workspace, then establish subscriptions before any chat starts. */
  static async create(baseUrl: URL, options: AgentSessionOptions = {}): Promise<AgentSession> {
    const publicApi = connect(baseUrl, { accessToken: options.accessToken });
    let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
    let overseer: RpcStub<Overseer> | undefined;
    let session: AgentSession | undefined;
    try {
      if (options.accessToken === undefined) {
        const username = nextUsernames(options.usernamePrefix ?? "agent").at(0);
        if (username === undefined) throw new Error("Failed to allocate an integration-test username");
        authenticatedApi = await signUp(publicApi, username);
      } else {
        authenticatedApi = await publicApi.authenticateFromCfAccess();
      }
      if (options.userModel !== undefined) {
        await authenticatedApi.addModel(options.userModel.profile, options.userModel.config);
      }
      overseer = await authenticatedApi.newGadget();
      const [metadata, models] = await Promise.all([
        overseer.getMetadata(),
        overseer.listModels(),
      ]);
      const modelId = AgentSession.#selectModel(models, options.modelId);
      session = new AgentSession(
          publicApi, authenticatedApi, overseer, metadata.id, modelId,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await session.#initializeSubscriptions();
      return session;
    } catch (error) {
      if (session === undefined) {
        overseer?.[Symbol.dispose]();
        authenticatedApi?.[Symbol.dispose]();
        publicApi[Symbol.dispose]();
      } else {
        session[Symbol.dispose]();
      }
      throw error;
    }
  }

  /**
   * Send a prompt. The first call creates a chat; later calls continue that same chat.
   * History is fetched through every compaction page after the turn settles.
   */
  async run(prompt: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("An agent turn is already running");

    const existingChatId = this.#chatId ?? null;
    const completion = new AgentTurnCompletion(
        existingChatId,
        () => this.#stopCurrentAgent(),
        this.#timeoutMs,
        this.#settleDebounceMs,
        options.signal);
    this.#turn = completion;
    this.#chatSubscriber.completion = completion;
    try {
      if (this.#chatId === undefined) {
        this.#chatId = await this.#overseer.newChat(prompt, this.modelId);
        completion.attach(this.#chatId);
      } else {
        await this.#overseer.sendChatMessage(this.#chatId, prompt, this.modelId);
      }
      await completion.promise;

      let history = await this.#loadHistory(this.#chatId);
      if (options.acceptChanges) {
        await this.acceptChanges();
        history = await this.#loadHistory(this.#chatId);
      }
      const usage: AgentTurnResult["usage"] = {};
      if (completion.lastMetadata?.totalTokens !== undefined) {
        usage.totalTokens = completion.lastMetadata.totalTokens;
      }
      if (completion.lastMetadata?.totalCost !== undefined) {
        usage.costUsd = completion.lastMetadata.totalCost;
      }
      return {
        chatId: this.#chatId,
        history,
        workpieces: this.workpieces(),
        agentErrors: history.flatMap(entry => entry.type === "error" ? [entry.message] : []),
        usage,
      };
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      completion.dispose();
      if (this.#chatSubscriber.completion === completion) {
        this.#chatSubscriber.completion = undefined;
      }
      if (this.#turn === completion) this.#turn = undefined;
    }
  }

  /** Stop and reject the active turn. Does nothing while idle. */
  cancel(): void {
    this.#turn?.cancel();
  }

  /** Current workpieces discovered through `subscribeToWorkpieces()`. */
  workpieces(): WorkpieceSummary[] {
    return [...this.#workpieceSubscriber.entries.values()];
  }

  /** Obtain a caller-owned verifier capability for one gadget workpiece. */
  getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    this.#assertUsable();
    return this.#overseer.getGadget(id);
  }

  /**
   * Connect a caller-owned, typed verifier stub to accepted code or this session's chat branch.
   */
  async connectToGadget<Session extends RpcCompatible<Session>>(
      id: WorkpieceId, branch: AgentGadgetBranch = "chat"): Promise<RpcStub<Session>> {
    this.#assertUsable();
    using gadget = await this.#overseer.getGadget(id);
    if (branch === "chat" && this.#chatId === undefined) {
      throw new Error("The session has no chat branch yet");
    }
    return connectTyped<Session>(gadget, branch === "chat" ? this.#chatId : undefined);
  }

  /**
   * Wait until the deployment's standard output formats are installed.
   * The first API request starts format installation without waiting for it. Wait here so the first
   * agent prompt always sees the installed formats.
   */
  async waitForOutputFormats(): Promise<OutputFormatOffer[]> {
    this.#assertUsable();
    return waitFor(
        "the output formats to install (is workshop-backend built? see its README)", async () => {
      const offers = await this.#authenticatedApi.listOutputFormats();
      return offers.length > 0 ? offers : null;
    });
  }

  /** Accept every change proposed by the current chat. */
  async acceptChanges(): Promise<void> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("Cannot accept changes while an agent turn is running");
    if (this.#chatId === undefined) throw new Error("The session has no chat branch to accept");
    const result = await this.#overseer.mergeChanges(this.#chatId);
    if (result.outcome !== "merged") {
      throw new Error("The chat became stale before its changes could be accepted");
    }
  }

  /** Delete the isolated workspace, then dispose every capability held by the session. */
  async deleteWorkspace(): Promise<void> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("Cannot delete the workspace during an agent turn");
    await this.#overseer.deleteSelf();
    this[Symbol.dispose]();
  }

  /** Dispose subscriptions, callback targets, RPC capabilities, and the WebSocket session. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#turn?.cancel();
    this.#turn?.dispose();
    this.#chatSubscription?.[Symbol.dispose]();
    this.#workpieceSubscription?.[Symbol.dispose]();
    this.#chatSubscriberStub?.[Symbol.dispose]();
    this.#workpieceSubscriberStub?.[Symbol.dispose]();
    this.#overseer[Symbol.dispose]();
    this.#authenticatedApi[Symbol.dispose]();
    this.#publicApi[Symbol.dispose]();
  }

  async #initializeSubscriptions(): Promise<void> {
    this.#chatSubscriberStub = stubFor(this.#chatSubscriber);
    this.#chatSubscription = await this.#overseer.subscribeToChat(this.#chatSubscriberStub);
    this.#workpieceSubscriberStub = stubFor(this.#workpieceSubscriber);
    this.#workpieceSubscription = await this.#overseer.subscribeToWorkpieces(
        this.#workpieceSubscriberStub);
    await this.#workpieceSubscriber.readyPromise;
  }

  async #loadHistory(chatId: number): Promise<AiChatMessage[]> {
    return loadAllChatHistory(before => this.#overseer.getChatHistory(chatId, before));
  }


  #stopCurrentAgent(): Promise<void> {
    if (this.#chatId === undefined) return Promise.resolve();
    return this.#overseer.stopAgent(this.#chatId);
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#failed) throw new Error("AgentSession cannot be reused after a failed or cancelled turn");
  }

  static #selectModel(models: AiChatAuthorInfo[], requested: string | undefined): string {
    if (models.length === 0) throw new Error("The Workshop exposes no configured agent models");
    if (requested === undefined) {
      const first = models.at(0);
      if (first === undefined) throw new Error("The Workshop exposes no configured agent models");
      return first.id;
    }
    if (!models.some(model => model.id === requested)) {
      throw new Error(`Model "${requested}" is not exposed by this workspace`);
    }
    return requested;
  }
}
