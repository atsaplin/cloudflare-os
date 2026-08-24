import { expect, it } from "vitest";
import { EVAL_RUN_BUDGET_MS, EVAL_TEST_TIMEOUT_MS, evalMatrix } from "./config.js";

it("reserves cleanup time outside the agent run budget", () => {
  expect(EVAL_TEST_TIMEOUT_MS).toBeGreaterThan(EVAL_RUN_BUDGET_MS);
});

it("uses both Workers AI models and one trial by default", () => {
  expect(evalMatrix({})).toEqual({
    models: ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"],
    trials: 1,
  });
});

it("accepts model and trial overrides", () => {
  expect(evalMatrix({
    WORKSHOP_EVAL_MODELS: " model-a, model-b ",
    WORKSHOP_EVAL_TRIALS: "3",
  })).toEqual({ models: ["model-a", "model-b"], trials: 3 });
});

it("rejects an invalid trial count", () => {
  expect(() => evalMatrix({ WORKSHOP_EVAL_TRIALS: "0" })).toThrow("positive integer");
});
