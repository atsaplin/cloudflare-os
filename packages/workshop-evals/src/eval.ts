import { createJudge, describeEval } from "vitest-evals";
import { expect } from "vitest";
import { evalMatrix } from "./config.js";
import { createWorkshopHarness } from "./harness.js";
import type { EvalRunInput, EvalRunOutput, EvalTask } from "./task.js";
import { resolveWorkshopTarget } from "./target.js";

const ChecksJudge = createJudge<EvalRunInput, EvalRunOutput>(
  "behavioral checks",
  ({ output }) => {
    const checks = output.turns.flatMap(turn => turn.checks);
    const passed = checks.filter(check => check.pass).length;
    return {
      score: checks.length === 0 ? 0 : passed / checks.length,
      metadata: {
        passed,
        total: checks.length,
        failed: checks.filter(check => !check.pass).map(check => check.id),
      },
    };
  },
);

/** Register one real Gadget task using native Vitest cases and vitest-evals reporting. */
export function defineTaskEval(task: EvalTask): void {
  const target = resolveWorkshopTarget();
  const matrix = evalMatrix();
  const cases = matrix.models.flatMap(model =>
    Array.from({ length: matrix.trials }, (_unused, trial) => ({
      name: `${model} | trial ${trial + 1}`,
      model,
      trial,
    })));
  const harness = createWorkshopHarness(task, target);

  describeEval(task.id, { harness }, it => {
    it.for(cases)("$name", async ({ model, trial }, { run }) => {
      const result = await run({ model, trial });
      await expect(result).toSatisfyJudge(ChecksJudge, {
        threshold: task.expectation === "required" ? 1 : null,
      });
    });
  });
}
