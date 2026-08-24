import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20 * 60_000,
    hookTimeout: 3 * 60_000,
  },
});
