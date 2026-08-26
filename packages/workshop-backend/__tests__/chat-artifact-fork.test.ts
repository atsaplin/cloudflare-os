import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-artifact-fork-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as {impl: any}).impl);
  });
}

function addChat(impl: any, id: number): void {
  impl.storage.chatMeta.put({
    id, title: "Chat", started: new Date(0), lastActive: new Date(0),
  });
}

async function firstWorkspaceAgentWrite(impl: any, chatId: number): Promise<void> {
  let ensure = impl.ensureChatArtifactFork;
  expect(ensure).toEqual(expect.any(Function));
  await ensure.call(impl, chatId);
}

function artifactForks(impl: any, chatId: number): any[] {
  expect(impl.storage.chatArtifactForks).toBeDefined();
  let fork = impl.storage.chatArtifactForks.get(chatId);
  return fork === undefined ? [] : [fork];
}

describe("chat Artifacts fork lifecycle", () => {
  it("creates fork metadata on the first workspace agent write", () => withImpl(async impl => {
    addChat(impl, 1);

    await firstWorkspaceAgentWrite(impl, 1);

    expect(artifactForks(impl, 1)).toHaveLength(1);
  }));

  it("includes a workspace fork in hasProposedChanges", () => withImpl(async impl => {
    addChat(impl, 1);

    await firstWorkspaceAgentWrite(impl, 1);

    expect(impl.storage.chatMeta.get(1)!.hasProposedChanges).toBe(true);
  }));

  it("accepts the workspace fork through mergeChanges", () => withImpl(async impl => {
    addChat(impl, 1);
    await firstWorkspaceAgentWrite(impl, 1);

    expect(await impl.mergeChanges(1, {profile: USER}, "user-do-id"))
        .toEqual({outcome: "merged"});
    expect(artifactForks(impl, 1)).toEqual([]);
  }));

  it("removes the workspace fork when discard-all reverts the chat", () => withImpl(async impl => {
    addChat(impl, 1);
    await firstWorkspaceAgentWrite(impl, 1);

    await impl.revertChanges(1, 0, USER);

    expect(artifactForks(impl, 1)).toEqual([]);
  }));

  it("keeps ordinary chat attachments outside the fork lifecycle", () => withImpl(async impl => {
    addChat(impl, 1);
    let id = "00000000-0000-4000-8000-000000000001";
    let attachment: AiChatMessage = {
      chatId: 1,
      sequence: 1,
      timestamp: new Date(0),
      author: USER,
      type: "message",
      message: "Attached notes",
      attachments: [{id, mimeType: "text/plain", name: "notes.txt", size: 5}],
    };
    impl.storage.chats.put(attachment);
    impl.storage.chatAttachmentContent.put({
      fileId: id,
      data: new Uint8Array([110, 111, 116, 101, 115]),
      state: {type: "committed", chatId: 1},
    });

    await impl.revertChanges(1, 0, USER);

    expect(impl.storage.chatAttachmentContent.get(id)).toMatchObject({
      fileId: id,
      state: {type: "committed", chatId: 1},
    });
  }));
});
