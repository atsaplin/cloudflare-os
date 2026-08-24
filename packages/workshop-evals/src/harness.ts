import type { AgentTurnResult } from "@gadgets/integration-tests/agent-session";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { createHarness } from "vitest-evals";
import { EVAL_RUN_BUDGET_MS } from "./config.js";
import type { EvalRunInput, EvalRunOutput, EvalTask, EvalTurnResult } from "./task.js";
import { measureHistory, toTranscriptEvents } from "./transcript.js";
import { openWorkshopTarget } from "./target.js";
import type { WorkshopTarget } from "./target.js";
import { EvalVerifier } from "./verifier.js";

const HARNESS_OVERHEAD_MS = 2 * 60_000;


/** Adapt one real Workshop task to the generic vitest-evals harness contract. */
export function createWorkshopHarness(task: EvalTask, target: WorkshopTarget) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal }) => {
      const startedAt = Date.now();
      const turnTimeoutMs = Math.floor(
        (EVAL_RUN_BUDGET_MS - HARNESS_OVERHEAD_MS) / task.turns.length,
      );

      const opened = await openWorkshopTarget(target, input.model, turnTimeoutMs);
      try {
        const turns: EvalTurnResult[] = [];
        let history: AiChatMessage[] = [];
        let usage: AgentTurnResult["usage"] = {};

        for (const turn of task.turns) {
          const agentStartedAt = Date.now();
          const result = await opened.session.run(turn.prompt, { signal });
          const agentDurationMs = Date.now() - agentStartedAt;
          ({ history } = result);
          usage = result.usage;

          const verificationStartedAt = Date.now();
          const verifier = new EvalVerifier(opened.session, result.workpieces);
          turns.push({
            checks: await verifier.collect(turn.verify),
            agentDurationMs,
            verificationDurationMs: Date.now() - verificationStartedAt,
          });
        }

        const metrics = measureHistory(history);

        return {
          output: { turns, metrics },
          events: toTranscriptEvents(history),
          usage: {
            provider: "cloudflare",
            model: input.model,
            totalTokens: usage.totalTokens,
            toolCalls: metrics.toolCalls,
            metadata: {
              ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
              tokenScope: "last-model-step",
            },
          },
          timings: { totalMs: Date.now() - startedAt },
          errors: history.flatMap(message =>
            message.type === "error" ? [{ name: "AgentError", message: message.message }] : []),
          metadata: {
            taskId: task.id,
            expectation: task.expectation,
            target: target.kind,
          },
        };
      } finally {
        await opened.close();
      }
    },
  });
}
