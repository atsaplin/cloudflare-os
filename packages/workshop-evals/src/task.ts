import type { JsonValue } from "vitest-evals";
import type { EvalVerifier } from "./verifier.js";

/** Whether a task should gate a run or only report frontier capability. */
export type EvalExpectation = "required" | "frontier";

/** Result of one deterministic observation of the Gadget the agent built. */
export type EvalCheckOutcome = {
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
  expectation: EvalExpectation;
  turns: readonly [EvalTurn, ...EvalTurn[]];
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate one authored task at module load, before it can spend inference. */
export function defineEvalTask(task: EvalTask): EvalTask {
  if (!ID_PATTERN.test(task.id)) throw new Error(`Invalid eval task ID ${JSON.stringify(task.id)}`);
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
  checks: EvalCheck[];
  agentDurationMs: number;
  verificationDurationMs: number;
};

/** Product-specific observations returned through the vitest-evals harness. */
export type EvalRunOutput = {
  turns: EvalTurnResult[];
  metrics: {
    modelTurns: number;
    toolCalls: number;
    toolErrors: number;
    agentErrors: number;
  };
};
