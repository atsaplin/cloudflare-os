import type {
  AgentSourceSnapshot, AgentTurnResult,
} from "@gadgets/integration-tests/agent-session";
import type { AiChatMessage, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { createHarness } from "vitest-evals";
import type { EvalRunInput, EvalRunOutput, EvalTask, EvalTurnResult } from "./task.js";
import { measureHistory, toTranscriptEvents } from "./transcript.js";
import { openWorkshopTarget } from "./target.js";
import type { WorkshopTarget } from "./target.js";
import { EvalVerifier } from "./verifier.js";

const TEST_TIMEOUT_MS = 30 * 60_000;
const HARNESS_OVERHEAD_MS = 2 * 60_000;

function serializeSource(snapshot: AgentSourceSnapshot, workpieces: readonly WorkpieceSummary[]) {
  return workpieces.flatMap(workpiece => {
    if (workpiece.type !== "gadget" || workpiece.filesRoot === undefined) return [];
    const source = snapshot.workpieces.get(workpiece.filesRoot);
    if (source === undefined) return [];
    return [{
      id: workpiece.id,
      title: workpiece.title,
      files: Object.fromEntries(source.files),
    }];
  });
}

/** Adapt one real Workshop task to the generic vitest-evals harness contract. */
export function createWorkshopHarness(task: EvalTask, target: WorkshopTarget) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal, setArtifact }) => {
      const startedAt = Date.now();
      const turnTimeoutMs = Math.floor(
        (TEST_TIMEOUT_MS - HARNESS_OVERHEAD_MS) / task.turns.length,
      );
      setArtifact("scenario", {
        id: task.id,
        title: task.title,
        expectation: task.expectation,
        model: input.model,
        trial: input.trial,
        target: target.kind,
      });

      const opened = await openWorkshopTarget(target, input.model, turnTimeoutMs);
      try {
        const turns: EvalTurnResult[] = [];
        let history: AiChatMessage[] = [];
        let workpieces: WorkpieceSummary[] = [];
        let chatId: number | undefined;
        let usage: AgentTurnResult["usage"] = {};

        for (const [index, turn] of task.turns.entries()) {
          const agentStartedAt = Date.now();
          const result = await opened.session.run(turn.prompt, { signal });
          const agentDurationMs = Date.now() - agentStartedAt;
          ({ chatId, history, workpieces } = result);
          usage = result.usage;

          const verificationStartedAt = Date.now();
          const verifier = new EvalVerifier(opened.session, result.chatId, result.workpieces);
          turns.push({
            index,
            checks: await verifier.collect(turn.verify),
            agentDurationMs,
            verificationDurationMs: Date.now() - verificationStartedAt,
          });
        }
        if (chatId === undefined) throw new Error(`Eval task ${task.id} has no turns`);

        const source = await opened.session.acceptChanges();
        setArtifact("source", serializeSource(source, workpieces));
        const checks = turns.flatMap(turn => turn.checks);
        const metrics = measureHistory(history);
        const output: EvalRunOutput = {
          taskId: task.id,
          taskTitle: task.title,
          expectation: task.expectation,
          target: target.kind,
          model: input.model,
          trial: input.trial,
          workspaceId: opened.session.workspaceId,
          chatId,
          passed: checks.length > 0 && checks.every(check => check.pass),
          turns,
          workpieces: workpieces.map(({ id, type, title }) => ({ id, type, title })),
          metrics,
        };

        return {
          output,
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
