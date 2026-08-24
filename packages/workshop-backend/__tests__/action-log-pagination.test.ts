import { describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { ActionLogEntry, ActionsSubscriber } from "@gadgets/workshop-shared/api";
import {
  HISTORY_PAGE_DEFAULT_LIMIT, HISTORY_PAGE_SCAN_CAP, PENDING_SCAN_PAGE_SIZE,
} from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import {
  makeActionStorage, makePreIndexActionStorage, openFakeOverseer, putAction,
} from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

// Hand-rolled ActionsSubscriber stub. `events` interleaves entry ids with "ready", so tests can
// assert both content and ordering of the delivered stream.
function makeSubscriber(entry?: (record: ActionLogEntry) => Promise<void>) {
  let events: Array<number | "ready"> = [];
  let subscriber = {
    entry: entry ?? (async (record: ActionLogEntry) => { events.push(record.id); }),
    ready: async () => { events.push("ready"); },
    dup: () => subscriber,
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  };
  return { subscriber: subscriber as unknown as RpcStub<ActionsSubscriber>, events };
}

describe("subscribeToActions", () => {
  it("delivers no pre-existing records: ready fires immediately", async () => {
    // Live deltas only — the current pending set is queried via listActions({filter: "pending"}).
    let storage = makeActionStorage();
    putAction(storage, 0);                                          // pending action
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "pending" });  // pending, non-action type
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber);
    expect(events).toEqual(["ready"]);
  });

  it("delivers adds and resolutions live, in stream order", async () => {
    let storage = makeActionStorage();
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber);
    putAction(storage, 0);
    let record = storage.actions.get(0)!;
    record.state = "approved";
    storage.actions.put(record);

    expect(events).toEqual(["ready", 0, 0]);  // the add, then the resolving update
  });

  it("replays every record, resolved included, for the deprecated startAfter", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "observation", state: "rejected" });
    putAction(storage, 3, { type: "bindHook", state: "pending" });
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber, new Date(0));
    expect(events).toEqual([0, 1, 2, 3, "ready"]);
  });

  it("rejects the deprecated full replay when the subscriber fails mid-sweep", async () => {
    let storage = makeActionStorage();
    // More than one page, so the sweep crosses a yield after the entry rejections settle.
    for (let id = 0; id <= PENDING_SCAN_PAGE_SIZE; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber(async () => { throw new Error("entry failed"); });

    await expect(client.subscribeToActions(subscriber, new Date(0)))
        .rejects.toThrow("Action subscriber failed during replay");
    expect(events).not.toContain("ready");
  });

  it("stops delivering after the subscription is disposed", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    let sub = await client.subscribeToActions(subscriber);
    sub[Symbol.dispose]();
    await scheduler.wait(0);  // let the stub's disposer run
    putAction(storage, 1);

    expect(events).toEqual(["ready"]);
  });
});

describe("listActions", () => {
  it("returns resolved records newest-first, excluding pending", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { state: "approved" });
    putAction(storage, 1);  // pending
    putAction(storage, 2, { state: "rejected" });
    putAction(storage, 3, { type: "observation", state: "approved" });
    let client = await openFakeOverseer(storage);

    let page = await client.listActions();
    expect(page.entries.map(e => e.id)).toEqual([3, 2, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("filters by record type", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { state: "approved" });
    putAction(storage, 1, { type: "observation", state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "approved" });
    let client = await openFakeOverseer(storage);

    let page = await client.listActions({ filter: "observation" });
    expect(page.entries.map(e => e.id)).toEqual([1]);
  });

  it("applies the default limit and reports more history", async () => {
    let storage = makeActionStorage();
    let total = HISTORY_PAGE_DEFAULT_LIMIT + 10;
    for (let id = 0; id < total; id++) putAction(storage, id, { state: "approved" });
    let client = await openFakeOverseer(storage);

    let first = await client.listActions();
    expect(first.entries.length).toBe(HISTORY_PAGE_DEFAULT_LIMIT);
    expect(first.nextBeforeId).toBe(total - HISTORY_PAGE_DEFAULT_LIMIT);

    let second = await client.listActions({ beforeId: first.nextBeforeId });
    expect(second.entries.length).toBe(10);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("caps raw records scanned, returning a short page with a cursor", async () => {
    let storage = makeActionStorage();
    // Old resolved records buried under more than a scan-cap of pending ones.
    for (let id = 0; id < 10; id++) putAction(storage, id, { state: "approved" });
    for (let id = 10; id < 10 + HISTORY_PAGE_SCAN_CAP + 20; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);

    let first = await client.listActions();
    expect(first.entries).toEqual([]);
    expect(first.nextBeforeId).toBe(30);

    let second = await client.listActions({ beforeId: first.nextBeforeId });
    expect(second.entries.map(e => e.id)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("pages without overlap or gaps", async () => {
    let storage = makeActionStorage();
    let expected: number[] = [];
    for (let id = 0; id < 130; id++) {
      let resolved = id % 4 !== 0;
      putAction(storage, id, { state: resolved ? "approved" : "pending" });
      if (resolved) expected.unshift(id);
    }
    let client = await openFakeOverseer(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ beforeId });
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("rejects an invalid beforeId", async () => {
    let client = await openFakeOverseer(makeActionStorage());

    await expect(client.listActions({ beforeId: -1 })).rejects.toThrow("Invalid beforeId");
  });
});

describe("listActions with the pending filter", () => {
  it("returns pendings of any type newest-first across gatekeepers, excluding resolved",
      async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { gatekeeperId: 2 });
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "pending", gatekeeperId: 1 });
    putAction(storage, 3, { state: "rejected" });
    putAction(storage, 4, { gatekeeperId: 3 });
    let client = await openFakeOverseer(storage);

    // The index groups by gatekeeper; the page must still be one id-ordered (descending) stream.
    let page = await client.listActions({ filter: "pending" });
    expect(page.entries.map(e => e.id)).toEqual([4, 2, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("pages to exhaustion without overlap or gaps", async () => {
    let storage = makeActionStorage();
    let expected: number[] = [];
    for (let id = 0; id < HISTORY_PAGE_DEFAULT_LIMIT * 2 + 30; id++) {
      let pending = id % 3 !== 0;
      putAction(storage, id, { state: pending ? "pending" : "approved", gatekeeperId: id % 4 });
      if (pending) expected.unshift(id);
    }
    let client = await openFakeOverseer(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ filter: "pending", beforeId });
      expect(page.entries.length).toBeLessThanOrEqual(HISTORY_PAGE_DEFAULT_LIMIT);
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("reflects a resolution between pages: the record stops appearing", async () => {
    let storage = makeActionStorage();
    let total = HISTORY_PAGE_DEFAULT_LIMIT + 10;
    for (let id = 0; id < total; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);

    let first = await client.listActions({ filter: "pending" });
    expect(first.entries.length).toBe(HISTORY_PAGE_DEFAULT_LIMIT);
    expect(first.nextBeforeId).toBe(10);

    // Resolve a record that would have been on the second page.
    let record = storage.actions.get(5)!;
    record.state = "approved";
    storage.actions.put(record);

    let second = await client.listActions({ filter: "pending", beforeId: first.nextBeforeId });
    expect(second.entries.map(e => e.id)).toEqual([9, 8, 7, 6, 4, 3, 2, 1, 0]);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("sees pendings written before the index existed once a rebuild backfills it", async () => {
    // Mirrors the version-3 migration: records predate the pendingByGatekeeper declaration, so
    // the index starts empty until the migration's rebuild() runs.
    let mock = makeMockStorage();
    let legacy = makePreIndexActionStorage(mock);
    putAction(legacy, 0);
    putAction(legacy, 1, { state: "approved" });
    putAction(legacy, 2);

    let storage = makeActionStorage(mock);
    storage.actions.pendingByGatekeeper.rebuild();
    let client = await openFakeOverseer(storage);

    let page = await client.listActions({ filter: "pending" });
    expect(page.entries.map(e => e.id)).toEqual([2, 0]);
  });
});

describe("UseOverseerInterface", () => {
  it("answers listActions with an empty terminal page and the subscription inertly", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    putAction(storage, 1, { state: "approved" });
    let client = await openFakeOverseer(storage, { role: "use" });
    let { subscriber, events } = makeSubscriber();

    expect(await client.listActions()).toEqual({ entries: [] });
    expect(await client.listActions({ filter: "pending" })).toEqual({ entries: [] });

    using _sub = await client.subscribeToActions(subscriber);
    putAction(storage, 2);
    expect(events).toEqual(["ready"]);  // settled empty; nothing replayed or delivered
  });
});
