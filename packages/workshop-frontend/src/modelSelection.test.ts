import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { filterModels } from "./modelSelection";

const MODELS: AiChatAuthorInfo[] = [
  { type: "agent", id: "@cf/example/kimi", name: "Kimi (Workers AI)" },
  {
    type: "agent",
    id: "openrouter:anthropic/claude-sonnet",
    name: "Claude Sonnet (OpenRouter)",
  },
];

describe("filterModels", () => {
  it("matches model names and provider-qualified IDs without case sensitivity", () => {
    expect(filterModels(MODELS, "WORKERS")).toEqual([MODELS[0]]);
    expect(filterModels(MODELS, "anthropic/claude")).toEqual([MODELS[1]]);
  });

  it("returns every model for a blank query", () => {
    expect(filterModels(MODELS, "  ")).toEqual(MODELS);
  });
});
