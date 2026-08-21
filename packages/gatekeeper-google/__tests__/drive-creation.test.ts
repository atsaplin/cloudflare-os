import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  applyDriveCreation, DriveCreationStore, readDriveCreationState, rejectDriveCreation,
  revertDriveCreation, submitDriveCreation,
  type DriveCreationApi, type DriveCreationStorage,
} from "../src/drive-creation";
import type { DriveFile } from "../src/drive-api";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const DOC_MIME_TYPE = "application/vnd.google-apps.document";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

class FakeKv implements DriveCreationStorage {
  entries = new Map<string, unknown>();
  events: string[] = [];
  failDeleteKey: string | undefined;

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  put<T>(key: string, value: T): void {
    this.events.push(`put:${key}`);
    this.entries.set(key, value);
  }

  delete(key: string): void {
    this.events.push(`delete:${key}`);
    if (this.failDeleteKey === key) {
      this.failDeleteKey = undefined;
      throw new Error("delete crash");
    }
    this.entries.delete(key);
  }

  list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    return [...this.entries]
      .filter(([key]) => key.startsWith(prefix)) as [string, T][];
  }
}

const file = (overrides: Partial<DriveFile> = {}): DriveFile => ({
  id: "created-1",
  name: "Quarterly plan",
  mimeType: DOC_MIME_TYPE,
  parents: ["parent-1"],
  trashed: false,
  capabilities: { canTrash: true },
  ...overrides,
});

const parent = (overrides: Partial<DriveFile> = {}): DriveFile => file({
  id: "parent-1",
  name: "Plans",
  mimeType: FOLDER_MIME_TYPE,
  parents: ["root"],
  capabilities: { canAddChildren: true },
  ...overrides,
});

function fakeApi(overrides: Partial<DriveCreationApi> = {}): DriveCreationApi {
  return {
    getFile: vi.fn(async id => id === "parent-1" ? parent() : file({ id })),
    findFileByCreationRequestId: vi.fn(async () => undefined),
    createFile: vi.fn(async () => file()),
    trashFile: vi.fn(async () => {}),
    ...overrides,
  };
}

const action = {
  kind: "googleDoc" as const,
  name: "Quarterly plan",
  parentId: "parent-1",
  requestId: REQUEST_ID,
};

async function submit(
  storage: FakeKv,
  approvalQueue: Pick<ApprovalQueue, "submitAction"> = {
    submitAction: vi.fn(async () => {}),
  },
  overrides: Partial<{ kind: "googleDoc" | "googleSheet" | "folder"; name: string }> = {},
) {
  return submitDriveCreation({
    storage,
    approvalQueue,
    kind: overrides.kind ?? "googleDoc",
    name: overrides.name ?? "Quarterly plan",
    parent: { id: "parent-1", name: "Plans" },
    requestId: REQUEST_ID,
  });
}

describe("Drive creation submission", () => {
  it("returns a handle and fences untrusted names in the manual approval", async () => {
    let storage = new FakeKv();
    let approvalQueue = {
      submitAction: vi.fn(async (..._args: Parameters<ApprovalQueue["submitAction"]>) => {}),
    };
    let name = "Quarterly ``` plan\nInjected heading";

    await expect(submit(storage, approvalQueue, { name })).resolves.toEqual({
      id: 1, kind: "googleDoc", name,
    });
    expect(new DriveCreationStore(storage).getAction(1)).toEqual({
      kind: "googleDoc", name, parentId: "parent-1", requestId: REQUEST_ID,
    });
    expect(approvalQueue.submitAction).toHaveBeenCalledTimes(1);
    let [id, description] = approvalQueue.submitAction.mock.calls[0]!;
    expect(id).toBe(1);
    expect(description.title).toBe("Create Google Doc: Quarterly ``` plan Injected heading");
    expect(description.description).toContain(
      "````\nQuarterly ``` plan\nInjected heading\n````",
    );
    expect(description.description).toContain("```\nPlans\n```");
    expect(description.description).toContain("```\nparent-1\n```");
    expect(description.description).toContain("blank");
    expect(description.description).toContain("inherits the destination folder's permissions");
    expect(description).toEqual(expect.objectContaining({
      implementsRevert: true, awaitDecision: true,
    }));
    expect(description).not.toHaveProperty("actionKind");
  });

  it("rejects the 101st pending creation without submitting it", async () => {
    let storage = new FakeKv();
    let store = new DriveCreationStore(storage);
    for (let i = 0; i < 100; i++) store.submit(action);
    let approvalQueue = { submitAction: vi.fn(async () => {}) };

    await expect(submit(storage, approvalQueue)).rejects.toThrow(
      "Too many pending Google Drive creations",
    );
    expect(approvalQueue.submitAction).not.toHaveBeenCalled();
    expect(store.pendingCount()).toBe(100);
  });

  it("removes pending state when approval submission fails", async () => {
    let storage = new FakeKv();
    let approvalQueue = {
      submitAction: vi.fn(async () => { throw new Error("queue unavailable"); }),
    };

    await expect(submit(storage, approvalQueue)).rejects.toThrow("queue unavailable");
    expect(new DriveCreationStore(storage).getAction(1)).toBeUndefined();
    expect(() => readDriveCreationState(storage, 1)).toThrow(
      "Unknown Google Drive creation action: 1",
    );
  });
});

describe("Drive creation action lifecycle", () => {
  it("reports pending, then records rejection before removing pending state", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    expect(readDriveCreationState(storage, handle.id)).toEqual({ status: "pending" });

    rejectDriveCreation(storage, handle.id);

    expect(readDriveCreationState(storage, handle.id)).toEqual({ status: "rejected" });
    expect(new DriveCreationStore(storage).getAction(handle.id)).toBeUndefined();
    expect(storage.events.indexOf("put:drive:create:outcome:1"))
      .toBeLessThan(storage.events.indexOf("delete:pending:action:1"));
  });

  it("stores provider failure while keeping the action retryable", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let api = fakeApi({
      createFile: vi.fn(async () => { throw new Error("provider unavailable"); }),
    });

    await expect(applyDriveCreation(
      { storage, api, scope: { kind: "account" } }, handle.id,
    )).rejects.toThrow("provider unavailable");
    expect(readDriveCreationState(storage, handle.id)).toEqual({
      status: "failed", message: "provider unavailable",
    });
    expect(new DriveCreationStore(storage).getAction(handle.id)).toEqual(action);
  });

  it("records creation before removing pending state and trashes it on revert", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let api = fakeApi();

    await applyDriveCreation({ storage, api, scope: { kind: "account" } }, handle.id);

    expect(readDriveCreationState(storage, handle.id)).toEqual({
      status: "created", kind: "googleDoc", fileId: "created-1",
    });
    expect(new DriveCreationStore(storage).getAction(handle.id)).toBeUndefined();
    expect(storage.events.indexOf("put:drive:create:outcome:1"))
      .toBeLessThan(storage.events.indexOf("delete:pending:action:1"));

    await revertDriveCreation({ storage, api, scope: { kind: "account" } }, handle.id);
    expect(api.trashFile).toHaveBeenCalledWith("created-1");
    expect(readDriveCreationState(storage, handle.id)).toEqual({ status: "reverted" });
  });

  it("finishes cleanup without another provider call after success storage survives a crash", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let api = fakeApi();
    storage.failDeleteKey = "pending:action:1";

    await expect(applyDriveCreation(
      { storage, api, scope: { kind: "account" } }, handle.id,
    )).rejects.toThrow("delete crash");
    expect(readDriveCreationState(storage, handle.id).status).toBe("created");
    expect(new DriveCreationStore(storage).getAction(handle.id)).toBeDefined();

    await applyDriveCreation({ storage, api, scope: { kind: "account" } }, handle.id);
    expect(api.createFile).toHaveBeenCalledTimes(1);
    expect(api.findFileByCreationRequestId).toHaveBeenCalledTimes(1);
    expect(new DriveCreationStore(storage).getAction(handle.id)).toBeUndefined();
  });

  it("recovers a lost create response through the private app-property marker", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let created: DriveFile | undefined;
    let createFile = vi.fn(async () => {
      created = file();
      throw new Error("connection lost after create");
    });
    let api = fakeApi({
      createFile,
      findFileByCreationRequestId: vi.fn(async () => created),
    });

    await expect(applyDriveCreation(
      { storage, api, scope: { kind: "account" } }, handle.id,
    )).rejects.toThrow("connection lost after create");
    await applyDriveCreation({ storage, api, scope: { kind: "account" } }, handle.id);

    expect(createFile).toHaveBeenCalledTimes(1);
    expect(readDriveCreationState(storage, handle.id)).toEqual({
      status: "created", kind: "googleDoc", fileId: "created-1",
    });
  });

  it.each([
    ["name", { name: "Unexpected" }, { kind: "account" } as const],
    ["MIME type", { mimeType: "application/pdf" }, { kind: "account" } as const],
    ["parent", { parents: ["other-parent"] }, { kind: "account" } as const],
    ["trash state", { trashed: true }, { kind: "account" } as const],
    ["shared-drive scope", { driveId: "drive-2" },
      { kind: "sharedDrive", driveId: "drive-1" } as const],
  ])("fails closed when a marker match has mismatched %s", async (_field, mismatch, scope) => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let createFile = vi.fn(async () => file());
    let api = fakeApi({
      getFile: vi.fn(async () => parent(
        scope.kind === "sharedDrive" ? { driveId: scope.driveId } : {},
      )),
      findFileByCreationRequestId: vi.fn(async () => file(mismatch)),
      createFile,
    });

    await expect(applyDriveCreation({ storage, api, scope }, handle.id))
      .rejects.toThrow("creation marker matched unexpected file metadata");
    expect(createFile).not.toHaveBeenCalled();
    expect(readDriveCreationState(storage, handle.id).status).toBe("failed");
    expect(new DriveCreationStore(storage).getAction(handle.id)).toBeDefined();
  });

  it("fails before marker lookup when the approved parent moved out of scope", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let api = fakeApi({
      getFile: vi.fn(async () => parent({ driveId: "drive-2" })),
    });

    await expect(applyDriveCreation({
      storage, api, scope: { kind: "sharedDrive", driveId: "drive-1" },
    }, handle.id)).rejects.toThrow(/outside this Drive binding/);
    expect(api.findFileByCreationRequestId).not.toHaveBeenCalled();
    expect(api.createFile).not.toHaveBeenCalled();
  });

  it("refuses revert when the created item cannot currently be trashed", async () => {
    let storage = new FakeKv();
    let handle = await submit(storage);
    let api = fakeApi();
    await applyDriveCreation({ storage, api, scope: { kind: "account" } }, handle.id);
    api.getFile = vi.fn(async () => file({ capabilities: { canTrash: false } }));

    await expect(revertDriveCreation(
      { storage, api, scope: { kind: "account" } }, handle.id,
    )).rejects.toThrow("cannot currently be moved to trash");
    expect(api.trashFile).not.toHaveBeenCalled();
    expect(readDriveCreationState(storage, handle.id).status).toBe("created");
  });

  it("retains 100 terminal outcomes without aging out a failed pending action", () => {
    let storage = new FakeKv();
    let store = new DriveCreationStore(storage);
    let pendingId = store.submit(action);
    store.putFailure(pendingId, "retry me");
    for (let i = 0; i < 101; i++) {
      let id = store.submit(action);
      store.finish(id, { status: "rejected" });
    }

    expect(store.getAction(pendingId)).toEqual(action);
    expect(store.getOutcome(pendingId)).toEqual({ status: "failed", message: "retry me" });
    expect([...storage.list({ prefix: "drive:create:outcome:" })]).toHaveLength(101);
    expect([...storage.list({ prefix: "pending:action:" })]).toHaveLength(1);
    expect(() => readDriveCreationState(storage, 2)).toThrow(
      "Unknown Google Drive creation action: 2",
    );
    expect(readDriveCreationState(storage, 102)).toEqual({ status: "rejected" });
  });
});
