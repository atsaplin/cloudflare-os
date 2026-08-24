import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverOpenRouterModels,
  discoverWorkersAiModels,
} from "../src/ai-gateway-models.js";

function workersModel(name: string, contextWindow: string): AiModelsSearchObject {
  return {
    id: name,
    source: 1,
    name,
    description: "Agent model",
    task: { id: "text", name: "Text Generation", description: "" },
    tags: [],
    properties: [
      { property_id: "context_window", value: contextWindow },
      { property_id: "function_calling", value: "true" },
    ],
  };
}

describe("AI Gateway model catalog caching", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses the OpenRouter catalog during the cache lifetime", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: [{
        id: "example/tool-model",
        name: "Example Tool Model",
        context_length: 128_000,
        architecture: { output_modalities: ["text"] },
        supported_parameters: ["tools"],
        top_provider: { max_completion_tokens: 16_000 },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await discoverOpenRouterModels();
    const second = await discoverOpenRouterModels();

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the Workers AI catalog during the cache lifetime", async () => {
    const models = vi.fn(async () => [{
      id: "workers-id",
      source: 1,
      name: "@cf/example/tool-model",
      description: "Agent model",
      task: { id: "text", name: "Text Generation", description: "" },
      tags: [],
      properties: [
        { property_id: "context_window", value: "64000" },
        { property_id: "function_calling", value: "true" },
      ],
    }]);
    const ai = { models } as unknown as Ai;

    const first = await discoverWorkersAiModels(ai);
    const second = await discoverWorkersAiModels(ai);

    expect(second).toEqual(first);
    expect(models).toHaveBeenCalledTimes(1);
  });

  it("returns the stale OpenRouter catalog when a refresh fails", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        data: [{
          id: "example/tool-model",
          name: "Example Tool Model",
          context_length: 128_000,
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
          top_provider: { max_completion_tokens: 16_000 },
        }],
      }))
      .mockRejectedValueOnce(new Error("provider unavailable"));

    const first = await discoverOpenRouterModels(fetchMock);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    const second = await discoverOpenRouterModels(fetchMock);

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("AI Gateway model catalog parsing", () => {
  it("skips malformed OpenRouter entries without hiding valid models", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: [
        {
          id: "example/broken-model",
          name: "Broken Model",
          context_length: "unknown",
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
          top_provider: { max_completion_tokens: 16_000 },
        },
        {
          id: "example/tool-model",
          name: "Example Tool Model",
          context_length: 128_000,
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
          top_provider: { max_completion_tokens: 16_000 },
        },
      ],
    }));

    const models = await discoverOpenRouterModels(fetchMock);

    expect(models.map((model) => model.config.model)).toEqual(["example/tool-model"]);
  });

  it("excludes OpenRouter models that can return non-text output", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: [
        {
          id: "example/image-model",
          name: "Image Model",
          context_length: 128_000,
          architecture: { output_modalities: ["image", "text"] },
          supported_parameters: ["tools"],
          top_provider: { max_completion_tokens: 16_000 },
        },
        {
          id: "example/text-model",
          name: "Text Model",
          context_length: 128_000,
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
          top_provider: { max_completion_tokens: 16_000 },
        },
      ],
    }));

    const models = await discoverOpenRouterModels(fetchMock);

    expect(models.map((model) => model.config.model)).toEqual(["example/text-model"]);
  });

  it("skips malformed Workers AI entries without hiding valid models", async () => {
    const models = vi.fn(async () => [
      workersModel("@cf/example/broken-model", "unknown"),
      workersModel("@cf/example/tool-model", "64000"),
    ]);

    const discovered = await discoverWorkersAiModels({ models } as unknown as Ai);

    expect(discovered.map((entry) => entry.config.model))
      .toEqual(["@cf/example/tool-model"]);
  });
});
