import type { JsonValue } from "vitest-evals";
import type { EvalVerifier } from "./verifier.js";

/** Whether a task should gate a run or only report frontier capability. */
export type EvalExpectation = "required" | "frontier";

/** Result of one deterministic observation of the Gadget the agent built. */
export type EvalCheckOutcome = boolean | {
  pass: boolean;
  evidence?: unknown;
};

/** JSON-safe observation retained in the vitest-evals output. */
export type EvalCheck = {
  id: string;
  pass: boolean;
  evidence?: JsonValue;
};

/** One prompt and the behavioral verification performed after it settles. */
export type EvalTurn = {
  prompt: string;
  verify(verifier: EvalVerifier): Promise<void>;
};

/** A real Workshop task run through the production agent. */
export type EvalTask = {
  id: string;
  title: string;
  expectation: EvalExpectation;
  turns: readonly [EvalTurn, ...EvalTurn[]];
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate one authored task at module load, before it can spend inference. */
export function defineEvalTask(task: EvalTask): EvalTask {
  if (!ID_PATTERN.test(task.id)) throw new Error(`Invalid eval task ID ${JSON.stringify(task.id)}`);
  if (task.title.trim() === "") throw new Error(`Eval task ${task.id} needs a title`);
  task.turns.forEach((turn, index) => {
    if (turn.prompt.trim() === "") throw new Error(`Eval task ${task.id} turn ${index} is empty`);
  });
  return task;
}

/** One model repetition of an authored task. */
export type EvalRunInput = {
  model: string;
  trial: number;
};

/** Checks and timings recorded after one agent turn. */
export type EvalTurnResult = {
  index: number;
  checks: EvalCheck[];
  agentDurationMs: number;
  verificationDurationMs: number;
};

/** Cloudflare-specific result returned through the generic vitest-evals harness. */
export type EvalRunOutput = {
  taskId: string;
  taskTitle: string;
  expectation: EvalExpectation;
  target: "local" | "preview";
  model: string;
  trial: number;
  workspaceId: string;
  chatId: number;
  passed: boolean;
  turns: EvalTurnResult[];
  workpieces: Array<{ id: number; type: string; title: string }>;
  metrics: {
    modelTurns: number;
    toolCalls: number;
    toolErrors: number;
    agentErrors: number;
  };
};
