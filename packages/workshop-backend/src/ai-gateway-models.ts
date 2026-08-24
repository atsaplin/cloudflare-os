import type { Api, Model } from "@earendil-works/pi-ai";
import { CLOUDFLARE_WORKERS_AI_MODELS }
  from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import {
  type AiChatAuthorInfo,
  type AiModelConfig,
  WORKERS_AI_OUTPUT_LIMIT,
} from "@gadgets/workshop-shared/api";
import type { UserAiModelRecord } from "./user.js";

const OPENROUTER_MODELS_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=tools";
const OPENROUTER_PROFILE_PREFIX = "openrouter:";
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

type CatalogCacheEntry<T> = {
  value?: T;
  expiresAt: number;
  refresh?: Promise<T>;
};

class CatalogCache<K extends object, T> {
  readonly #entries = new WeakMap<K, CatalogCacheEntry<T>>();

  constructor(readonly ttlMs: number) {}

  async get(key: K, load: () => Promise<T>): Promise<T> {
    const entry = this.#entries.get(key) ?? { expiresAt: 0 };
    this.#entries.set(key, entry);
    if (entry.value !== undefined && Date.now() < entry.expiresAt) return entry.value;
    if (entry.refresh) return entry.refresh;

    entry.refresh = this.#refresh(entry, load);
    return entry.refresh;
  }

  async #refresh(entry: CatalogCacheEntry<T>, load: () => Promise<T>): Promise<T> {
    try {
      const value = await load();
      entry.value = value;
      entry.expiresAt = Date.now() + this.ttlMs;
      return value;
    } catch (error) {
      if (entry.value !== undefined) return entry.value;
      throw error;
    } finally {
      entry.refresh = undefined;
    }
  }
}

const openRouterCatalogCache =
  new CatalogCache<typeof fetch, UserAiModelRecord[]>(MODEL_CATALOG_TTL_MS);
const workersAiCatalogCache =
  new CatalogCache<Ai, UserAiModelRecord[]>(MODEL_CATALOG_TTL_MS);

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function workersProperty(model: AiModelsSearchObject, id: string): unknown {
  return model.properties.find((property) => property.property_id === id)?.value;
}

function workersDisplayName(modelId: string): string {
  const catalog = (CLOUDFLARE_WORKERS_AI_MODELS as Record<string, Model<Api>>)[modelId];
  return `${catalog?.name ?? modelId} (Workers AI)`;
}

function workersModel(model: AiModelsSearchObject): UserAiModelRecord | undefined {
  if (workersProperty(model, "function_calling") !== "true") return undefined;
  const contextWindow = positiveInteger(workersProperty(model, "context_window"));
  if (contextWindow === undefined) return undefined;
  return {
    profile: {
      type: "agent",
      id: model.name,
      name: workersDisplayName(model.name),
    },
    config: {
      provider: "cloudflare",
      model: model.name,
      apiToken: "",
      contextWindow,
      outputLimit: WORKERS_AI_OUTPUT_LIMIT,
    },
  };
}

/** Discover agent-compatible Workers AI models through the account-bound runtime API. */
export async function discoverWorkersAiModels(ai: Ai): Promise<UserAiModelRecord[]> {
  return workersAiCatalogCache.get(ai, async () => {
    const models = await ai.models({ task: "Text Generation" });
    return models
      .map(workersModel)
      .filter((model) => model !== undefined);
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function openRouterModel(value: unknown): UserAiModelRecord | undefined {
  const model = record(value);
  if (!model || typeof model.id !== "string" || typeof model.name !== "string") return undefined;
  const architecture = record(model.architecture);
  const outputs = stringArray(architecture?.output_modalities);
  const parameters = stringArray(model.supported_parameters);
  if (outputs?.length !== 1 || outputs[0] !== "text" || !parameters?.includes("tools")) {
    return undefined;
  }

  const contextWindow = positiveInteger(model.context_length);
  if (contextWindow === undefined) return undefined;
  const topProvider = record(model.top_provider);
  const rawOutputLimit = topProvider?.max_completion_tokens;
  const outputLimit = rawOutputLimit === null || rawOutputLimit === undefined
    ? undefined
    : positiveInteger(rawOutputLimit);
  if (rawOutputLimit !== null && rawOutputLimit !== undefined && outputLimit === undefined) {
    return undefined;
  }
  const profile: AiChatAuthorInfo = {
    type: "agent",
    id: `${OPENROUTER_PROFILE_PREFIX}${model.id}`,
    name: `${model.name} (OpenRouter)`,
  };
  const config: AiModelConfig = {
    provider: "openrouter",
    model: model.id,
    apiToken: "",
    contextWindow,
    ...(outputLimit === undefined ? {} : { outputLimit }),
  };
  return { profile, config };
}

/** Discover agent-compatible OpenRouter models from its edge-cached public catalog. */
export async function discoverOpenRouterModels(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<UserAiModelRecord[]> {
  return openRouterCatalogCache.get(fetcher, async () => {
    const response = await fetcher(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter model discovery failed with status ${response.status}.`);
    }
    const body: unknown = await response.json();
    const data = record(body)?.data;
    if (!Array.isArray(data)) {
      throw new Error("OpenRouter model discovery returned malformed data.");
    }
    return data.map(openRouterModel).filter((model) => model !== undefined);
  });
}
