import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, AiChatHistoryPage, AiChatMessage, AiChatMetadata }
  from "@gadgets/workshop-shared/api";
import {
  finalAssistantText,
} from "../src/agent-session.js";
import { AgentTurnCompletion, loadAllChatHistory } from "../src/agent-session-internals.js";

function metadata(active: boolean): AiChatMetadata {
  const result: AiChatMetadata = {
    id: 7,
    title: "test",
    started: new Date(0),
    lastActive: new Date(0),
  };
  if (active) result.activeAgent = { type: "agent", id: "model", name: "Model" };
  return result;
}

function message(sequence: number): AiChatMessage {
  return {
    chatId: 7,
    sequence,
    timestamp: new Date(sequence),
    author: { type: "user", id: "user", name: "User" },
    type: "message",
    message: String(sequence),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentTurnCompletion", () => {
  it("settles after active becomes idle for the debounce period", async () => {
    vi.useFakeTimers();
    const completion = new AgentTurnCompletion(7, () => Promise.resolve(), 1_000, 25);
    completion.metadata(metadata(true));
    completion.metadata(metadata(false));

    await vi.advanceTimersByTimeAsync(24);
    expect(completion.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(completion.promise).resolves.toBeUndefined();
  });

  it("retains the final chat usage metadata", async () => {
    vi.useFakeTimers();
    const completion = new AgentTurnCompletion(7, () => Promise.resolve(), 1_000, 25);
    completion.metadata(metadata(true));
    completion.metadata({ ...metadata(false), totalTokens: 123, totalCost: 0.45 });
    await vi.advanceTimersByTimeAsync(25);
    await completion.promise;

    expect(completion.lastMetadata).toMatchObject({ totalTokens: 123, totalCost: 0.45 });
  });

  it("resets idle settlement when a callback restarts the agent", async () => {
    vi.useFakeTimers();
    const completion = new AgentTurnCompletion(7, () => Promise.resolve(), 1_000, 25);
    completion.metadata(metadata(true));
    completion.metadata(metadata(false));
    await vi.advanceTimersByTimeAsync(20);
    completion.metadata(metadata(true));
    await vi.advanceTimersByTimeAsync(20);
    expect(completion.settled).toBe(false);

    completion.metadata(metadata(false));
    await vi.advanceTimersByTimeAsync(25);
    await expect(completion.promise).resolves.toBeUndefined();
  });

  it("stops the agent on timeout", async () => {
    vi.useFakeTimers();
    let stops = 0;
    const completion = new AgentTurnCompletion(
        7, () => { stops++; return Promise.resolve(); }, 100, 25);
    await vi.advanceTimersByTimeAsync(100);

    await expect(completion.promise).rejects.toThrow("Timed out after 100ms");
    expect(stops).toBe(1);
  });

  it("stops the agent when cancelled", async () => {
    let stops = 0;
    const controller = new AbortController();
    const completion = new AgentTurnCompletion(
        7, () => { stops++; return Promise.resolve(); }, 1_000, 25, controller.signal);
    controller.abort();

    await expect(completion.promise).rejects.toThrow("Agent turn was cancelled");
    expect(stops).toBe(1);
  });

  it("clears timers and abort listeners when disposed", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const completion = new AgentTurnCompletion(
        7, () => Promise.resolve(), 1_000, 25, controller.signal);
    completion.dispose();
    controller.abort();
    vi.runAllTimers();
    expect(completion.settled).toBe(false);
  });
});

it("loads history pages in authoritative ascending order", async () => {
  const pages = new Map<number | undefined, AiChatHistoryPage>([
    [undefined, { messages: [message(4), message(5)], compacted: { to: 4, summary: "tail" } }],
    [4, { messages: [message(2), message(3)], compacted: { to: 2, summary: "middle" } }],
    [2, { messages: [message(0), message(1)] }],
  ]);
  const history = await loadAllChatHistory(before => {
    const page = pages.get(before);
    if (!page) throw new Error(`No page for ${before}`);
    return Promise.resolve(page);
  });
  expect(history.map(entry => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
});

it("returns the final non-empty assistant message from canonical history", () => {
  const agent: AiChatAuthorInfo = { type: "agent", id: "model", name: "Model" };
  const history = [
    message(0),
    { ...message(1), author: agent, message: "first" },
    { ...message(2), author: agent, message: "" },
  ];

  expect(finalAssistantText(history)).toBe("first");
});

