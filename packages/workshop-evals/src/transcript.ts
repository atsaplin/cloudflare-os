import type { AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { toJsonValue, type JsonValue, type TranscriptEvent } from "vitest-evals";

function toolArguments(call: AiToolCall): Record<string, JsonValue> | undefined {
  const value = toJsonValue(call.input);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

/** Convert canonical Workshop history into the transcript format owned by vitest-evals. */
export function toTranscriptEvents(history: readonly AiChatMessage[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const message of history) {
    if (message.type !== "message") continue;
    const role = message.author.type === "user" ? "user"
      : message.author.type === "agent" ? "assistant" : undefined;
    if (role === undefined) continue;
    const metadata = {
      sequence: message.sequence,
      timestamp: message.timestamp.toISOString(),
    };
    if (message.message !== "") {
      events.push({ type: "message", role, content: message.message, metadata });
    }
    if (role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const argumentsValue = toolArguments(call);
      events.push({
        type: "tool_call",
        id: call.toolCallId,
        name: call.toolName,
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        metadata,
      });
      const output = "output" in call ? toJsonValue(call.output) : undefined;
      events.push({
        type: "tool_result",
        toolCallId: call.toolCallId,
        name: call.toolName,
        ...(call.error === undefined
          ? (output === undefined ? {} : { content: output })
          : { error: { name: "Error", message: call.error } }),
        metadata,
      });
    }
  }
  return events;
}

/** Product-specific counts not already shown as generic trace fields. */
export function measureHistory(history: readonly AiChatMessage[]) {
  let modelTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let agentErrors = 0;
  for (const message of history) {
    if (message.type === "error") {
      agentErrors++;
      continue;
    }
    if (message.type !== "message" || message.author.type !== "agent") continue;
    modelTurns++;
    for (const call of message.toolCalls ?? []) {
      toolCalls++;
      if (call.error !== undefined) toolErrors++;
    }
  }
  return { modelTurns, toolCalls, toolErrors, agentErrors };
}
