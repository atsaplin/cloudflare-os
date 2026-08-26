import { describe, expect, it } from "vitest";
import {
  createWorkspaceNode,
  createEmptyWorkspaceIndex,
  deleteWorkspaceNode,
  getWorkspaceNode,
  listWorkspaceChildren,
  moveWorkspaceNode,
  parseWorkspaceIndex,
  resolveWorkspacePath,
  serializeWorkspaceIndex,
  updateWorkspaceFileMetadata,
  validateWorkspaceTree,
} from "../src/workspace-manifest";

const ROOT_ID = "00000000-0000-4000-8000-000000000001";
const FOLDER_ID = "00000000-0000-4000-8000-000000000002";
const FILE_ID = "00000000-0000-4000-8000-000000000003";

function context(createId: () => string = () => ROOT_ID) {
  return {
    actorId: "user:aleksey",
    now: "2026-08-26T04:00:00.000Z",
    createId,
  };
}

describe("workspace manifest", () => {
  it("creates a canonical empty workspace with a stable root identity", () => {
    const index = createEmptyWorkspaceIndex(context());

    expect(index).toEqual({
      version: 1,
      rootId: "00000000-0000-4000-8000-000000000001",
      nodes: {
        "00000000-0000-4000-8000-000000000001": {
          kind: "folder",
          parentId: null,
          name: "",
          createdAt: "2026-08-26T04:00:00.000Z",
          createdBy: "user:aleksey",
          updatedAt: "2026-08-26T04:00:00.000Z",
          updatedBy: "user:aleksey",
        },
      },
    });
    expect(new TextDecoder().decode(serializeWorkspaceIndex(index))).toBe(
      '{"version":1,"rootId":"00000000-0000-4000-8000-000000000001","nodes":' +
      '{"00000000-0000-4000-8000-000000000001":{"kind":"folder","parentId":null,' +
      '"name":"","createdAt":"2026-08-26T04:00:00.000Z","createdBy":"user:aleksey",' +
      '"updatedAt":"2026-08-26T04:00:00.000Z","updatedBy":"user:aleksey"}}}\n',
    );
  });

  it("round-trips only canonical, structurally valid indexes", () => {
    const bytes = serializeWorkspaceIndex(createEmptyWorkspaceIndex(context()));
    expect(parseWorkspaceIndex(bytes)).toEqual(createEmptyWorkspaceIndex(context()));

    const noncanonical = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace('{"version":1', '{ "version":1'),
    );
    expect(() => parseWorkspaceIndex(noncanonical)).toThrow(/canonical/i);
    expect(() => parseWorkspaceIndex(new TextEncoder().encode("{}\n"))).toThrow();
  });

  it("creates files and folders with server-generated identities", () => {
    const empty = createEmptyWorkspaceIndex(context());
    const folder = createWorkspaceNode(empty, {
      kind: "folder",
      parentId: ROOT_ID,
      name: "Documents",
    }, context(() => FOLDER_ID));
    const file = createWorkspaceNode(folder.index, {
      kind: "file",
      parentId: FOLDER_ID,
      name: "notes.txt",
      mediaType: "text/plain",
    }, context(() => FILE_ID));

    expect(folder.node.id).toBe(FOLDER_ID);
    expect(file.node.id).toBe(FILE_ID);
    expect(resolveWorkspacePath(file.index, FILE_ID)).toBe("Documents/notes.txt");
    expect(listWorkspaceChildren(file.index, FOLDER_ID)).toEqual([file.node]);
  });

  it("preserves identity across rename and move", () => {
    const empty = createEmptyWorkspaceIndex(context());
    const folder = createWorkspaceNode(empty, {
      kind: "folder",
      parentId: ROOT_ID,
      name: "Documents",
    }, context(() => FOLDER_ID));
    const file = createWorkspaceNode(folder.index, {
      kind: "file",
      parentId: FOLDER_ID,
      name: "notes.txt",
    }, context(() => FILE_ID));

    const moved = moveWorkspaceNode(file.index, FILE_ID, ROOT_ID, "renamed.txt", {
      ...context(),
      actorId: "agent:7",
      now: "2026-08-26T04:01:00.000Z",
    });

    expect(resolveWorkspacePath(moved, FILE_ID)).toBe("renamed.txt");
    expect(getWorkspaceNode(moved, FILE_ID)).toMatchObject({
      id: FILE_ID,
      createdBy: "user:aleksey",
      updatedBy: "agent:7",
    });
  });

  it("rejects invalid names, sibling collisions, and descendant moves", () => {
    const empty = createEmptyWorkspaceIndex(context());
    expect(() => createWorkspaceNode(empty, {
      kind: "folder",
      parentId: ROOT_ID,
      name: ".workspace",
    }, context(() => FOLDER_ID))).toThrow(/reserved/i);
    expect(() => createWorkspaceNode(empty, {
      kind: "file",
      parentId: ROOT_ID,
      name: "e\u0301.txt",
    }, context(() => FILE_ID))).toThrow(/NFC/i);

    const folder = createWorkspaceNode(empty, {
      kind: "folder",
      parentId: ROOT_ID,
      name: "Documents",
    }, context(() => FOLDER_ID));
    expect(() => createWorkspaceNode(folder.index, {
      kind: "folder",
      parentId: ROOT_ID,
      name: "Documents",
    }, context(() => FILE_ID))).toThrow(/sibling/i);
    expect(() => moveWorkspaceNode(folder.index, FOLDER_ID, FOLDER_ID, "Documents", context()))
      .toThrow(/descendant/i);
  });

  it("rejects malformed graphs during parsing", () => {
    const index = createEmptyWorkspaceIndex(context());
    index.nodes[FOLDER_ID] = {
      kind: "folder",
      parentId: FILE_ID,
      name: "a",
      createdAt: context().now,
      createdBy: context().actorId,
      updatedAt: context().now,
      updatedBy: context().actorId,
    };
    index.nodes[FILE_ID] = {
      kind: "folder",
      parentId: FOLDER_ID,
      name: "b",
      createdAt: context().now,
      createdBy: context().actorId,
      updatedAt: context().now,
      updatedBy: context().actorId,
    };
    expect(() => serializeWorkspaceIndex(index)).toThrow(/cycle|root/i);
  });

  it("updates file metadata without changing its identity or creation metadata", () => {
    const empty = createEmptyWorkspaceIndex(context());
    const file = createWorkspaceNode(empty, {
      kind: "file",
      parentId: ROOT_ID,
      name: "data",
    }, context(() => FILE_ID));
    const updated = updateWorkspaceFileMetadata(file.index, FILE_ID, "application/octet-stream", {
      ...context(),
      actorId: "agent:7",
      now: "2026-08-26T04:02:00.000Z",
    });

    expect(getWorkspaceNode(updated, FILE_ID)).toMatchObject({
      id: FILE_ID,
      mediaType: "application/octet-stream",
      createdBy: "user:aleksey",
      updatedBy: "agent:7",
    });
  });

  it("requires recursive deletion for nonempty folders", () => {
    const empty = createEmptyWorkspaceIndex(context());
    const folder = createWorkspaceNode(empty, {
      kind: "folder",
      parentId: ROOT_ID,
      name: "Documents",
    }, context(() => FOLDER_ID));
    const file = createWorkspaceNode(folder.index, {
      kind: "file",
      parentId: FOLDER_ID,
      name: "notes.txt",
    }, context(() => FILE_ID));

    expect(() => deleteWorkspaceNode(file.index, FOLDER_ID, false)).toThrow(/not empty/i);
    const deleted = deleteWorkspaceNode(file.index, FOLDER_ID, true);
    expect(deleted.deletedIds).toEqual([FILE_ID, FOLDER_ID]);
    expect(Object.keys(deleted.index.nodes)).toEqual([ROOT_ID]);
    expect(() => deleteWorkspaceNode(file.index, ROOT_ID, true)).toThrow(/root/i);
  });

  it("checks visible Git entries against stable identities while retaining empty folders", () => {
    const empty = createEmptyWorkspaceIndex(context());
    const folder = createWorkspaceNode(empty, {
      kind: "folder",
      parentId: ROOT_ID,
      name: "empty",
    }, context(() => FOLDER_ID));
    const file = createWorkspaceNode(folder.index, {
      kind: "file",
      parentId: ROOT_ID,
      name: "payload.bin",
    }, context(() => FILE_ID));

    expect(() => validateWorkspaceTree(file.index, new Map([
      [".workspace/index.json", "file"],
      ["payload.bin", "file"],
    ]))).not.toThrow();
    expect(() => validateWorkspaceTree(file.index, new Map([
      [".workspace/index.json", "file"],
      ["payload.bin", "symlink"],
    ]))).toThrow(/symlink/i);
    expect(() => validateWorkspaceTree(file.index, new Map([
      [".workspace/index.json", "file"],
    ]))).toThrow(/payload\.bin/);
  });
});
