import { AgentSession } from "@gadgets/integration-tests/agent-session";
import { startHarness, type WorkerConfig } from "@gadgets/integration-tests/harness";

/** Existing credentials used to run models from a local workerd Workshop. */
export type LocalModelAccess = {
  kind: "gateway";
  gateway: string;
  accountId: string;
  apiToken: string;
} | {
  kind: "direct";
  accountId: string;
  apiToken: string;
};

/** Where one eval trial runs. Scenario definitions are target-independent. */
export type WorkshopTarget = {
  kind: "local";
  modelAccess: LocalModelAccess;
} | {
  kind: "preview";
  url: URL;
  accessToken: string;
};

/** One isolated Workshop session plus its target-specific cleanup. */
export type OpenedWorkshop = {
  session: AgentSession;
  close(): Promise<void>;
};

function value(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const candidate = environment[key]?.trim();
  return candidate ? candidate : undefined;
}

/** Resolve the local or deployed-preview target from the eval process environment. */
export function resolveWorkshopTarget(
    environment: NodeJS.ProcessEnv = process.env): WorkshopTarget {
  const configuredTarget = value(environment, "WORKSHOP_EVAL_TARGET");
  if (configuredTarget !== undefined && configuredTarget !== "local") {
    let url: URL;
    try {
      url = new URL(configuredTarget);
    } catch {
      throw new Error("WORKSHOP_EVAL_TARGET must be local or an absolute HTTP(S) URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("WORKSHOP_EVAL_TARGET must be local or an absolute HTTP(S) URL");
    }
    const accessToken = value(environment, "CF_ACCESS_TOKEN");
    if (accessToken === undefined) {
      throw new Error("CF_ACCESS_TOKEN is required when WORKSHOP_EVAL_TARGET is a preview URL");
    }
    return { kind: "preview", url, accessToken };
  }

  const gateway = value(environment, "CF_AI_GATEWAY");
  const gatewayAccountId = value(environment, "CF_AI_GATEWAY_ACCOUNT_ID");
  const gatewayApiToken = value(environment, "CF_AI_GATEWAY_API_TOKEN");
  const gatewayValues = [gateway, gatewayAccountId, gatewayApiToken];
  if (gatewayValues.some(Boolean)) {
    if (!gateway || !gatewayAccountId || !gatewayApiToken) {
      throw new Error(
        "Local AI Gateway evals require CF_AI_GATEWAY, CF_AI_GATEWAY_ACCOUNT_ID, and " +
        "CF_AI_GATEWAY_API_TOKEN together",
      );
    }
    return {
      kind: "local",
      modelAccess: {
        kind: "gateway",
        gateway,
        accountId: gatewayAccountId,
        apiToken: gatewayApiToken,
      },
    };
  }

  const accountId = value(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = value(environment, "CLOUDFLARE_API_TOKEN");
  if (accountId && apiToken) {
    return { kind: "local", modelAccess: { kind: "direct", accountId, apiToken } };
  }
  throw new Error(
    "Local Workshop evals need existing model credentials: configure the CF_AI_GATEWAY trio or " +
    "CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN",
  );
}

function configureGateway(config: WorkerConfig, access: Extract<LocalModelAccess, {kind: "gateway"}>) {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: access.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: access.accountId,
    CF_AI_GATEWAY_API_TOKEN: access.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
  };
}

/** Open one isolated trial against local workerd or a deployed Access preview. */
export async function openWorkshopTarget(
    target: WorkshopTarget, model: string, timeoutMs: number): Promise<OpenedWorkshop> {
  if (target.kind === "preview") {
    let session: AgentSession | undefined;
    try {
      session = await AgentSession.create(target.url, {
        accessToken: target.accessToken,
        modelId: model,
        timeoutMs,
      });
      await session.waitForOutputFormats();
      const openedSession = session;
      return {
        session: openedSession,
        close: async () => {
          try {
            await openedSession.deleteWorkspace();
          } finally {
            openedSession[Symbol.dispose]();
          }
        },
      };
    } catch (error) {
      session?.[Symbol.dispose]();
      throw error;
    }
  }

  const modelAccess = target.modelAccess;
  const harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    ...(modelAccess.kind === "gateway"
      ? { patchWorkshop: config => configureGateway(config, modelAccess) }
      : {}),
  });
  try {
    const session = await AgentSession.create(harness.url, {
      modelId: model,
      ...(modelAccess.kind === "direct" ? {
        userModel: {
          profile: { type: "agent", id: model, name: model },
          config: {
            provider: "cloudflare",
            model,
            accountId: modelAccess.accountId,
            apiToken: modelAccess.apiToken,
          },
        },
      } : {}),
      timeoutMs,
    });
    await session.waitForOutputFormats();
    return {
      session,
      close: async () => {
        session[Symbol.dispose]();
        await harness.server.close();
      },
    };
  } catch (error) {
    await harness.server.close();
    throw error;
  }
}
