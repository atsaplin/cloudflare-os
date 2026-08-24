import type { AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { toJsonValue, type JsonValue, type TranscriptEvent } from "vitest-evals";
import { z } from "zod";

const ToolArgumentsSchema = z.record(z.string(), z.json());

function toolArguments(call: AiToolCall): Record<string, JsonValue> | undefined {
  const result = ToolArgumentsSchema.safeParse(call.input);
  return result.success ? result.data : undefined;
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
      const toolCall = {
        type: "tool_call",
        id: call.toolCallId,
        name: call.toolName,
        metadata,
      } satisfies TranscriptEvent;
      events.push(argumentsValue === undefined
        ? toolCall
        : { ...toolCall, arguments: argumentsValue });

      if (call.error !== undefined) {
        events.push({
          type: "tool_result",
          toolCallId: call.toolCallId,
          name: call.toolName,
          error: { name: "Error", message: call.error },
          metadata,
        });
        continue;
      }
      const output = "output" in call ? toJsonValue(call.output) : undefined;
      const result = {
        type: "tool_result",
        toolCallId: call.toolCallId,
        name: call.toolName,
        metadata,
      } satisfies TranscriptEvent;
      events.push(output === undefined ? result : { ...result, content: output });
    }
  }
  return events;
}

/** Product-specific diagnostics not already shown as generic trace fields. */
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
