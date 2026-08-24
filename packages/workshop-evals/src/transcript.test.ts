import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { expect, it } from "vitest";
import { measureHistory, toTranscriptEvents } from "./transcript.js";

const user = { type: "user", id: "user", name: "User" } as const;
const agent = { type: "agent", id: "model", name: "Model" } as const;

it("normalizes Workshop messages and failed tools for vitest-evals", () => {
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 0,
    timestamp: new Date(0),
    author: user,
    type: "message",
    message: "Build it",
  }, {
    chatId: 1,
    sequence: 1,
    timestamp: new Date(1),
    author: agent,
    type: "message",
    message: "Trying",
    toolCalls: [{
      toolCallId: "call-1",
      toolName: "listBlueprints",
      input: {},
      error: "catalog unavailable",
    }],
  }, {
    chatId: 1,
    sequence: 2,
    timestamp: new Date(2),
    author: agent,
    type: "error",
    message: "model stopped",
  }];

  expect(toTranscriptEvents(history)).toMatchObject([
    { type: "message", role: "user", content: "Build it" },
    { type: "message", role: "assistant", content: "Trying" },
    { type: "tool_call", id: "call-1", name: "listBlueprints" },
    {
      type: "tool_result",
      toolCallId: "call-1",
      name: "listBlueprints",
      error: { message: "catalog unavailable" },
    },
  ]);
  expect(measureHistory(history)).toEqual({
    modelTurns: 1,
    toolCalls: 1,
    toolErrors: 1,
    agentErrors: 1,
  });
});
