import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_ERROR_CODES,
  type FileRef,
  type WorkspaceAccessRole,
  type WorkspaceFileMutation,
  type WorkspaceGrant,
  type WorkspaceRight,
  type WriteTarget,
  workspaceRightsForRole,
} from "@gadgets/workshop-shared/api";
import {
  createEmptyWorkspaceIndex,
  createWorkspaceNode,
  type WorkspaceIndexV1,
} from "../src/workspace-manifest";
import {
  requireWorkspaceSubtreeAccess,
  type WorkspaceSubtreeOperation,
} from "../src/workspace-access";
import {
  digestRequest,
  digestStagedRequest,
  requireFileRef,
  requireWriteTarget,
  type StagedWorkspaceMutationRequest,
  type WorkspaceActor,
  type WorkspaceMutationRequest,
} from "../src/workspace-files";

const SOURCE_WORKSPACE_ID = "source-workspace";
const TARGET_WORKSPACE_ID = "target-workspace";
const ACTOR: WorkspaceActor = { id: "user:owner", name: "Owner" };
const NOW = "2026-08-26T00:00:00.000Z";
const HEAD = "a".repeat(40);
const ROOT_ID = "00000000-0000-4000-8000-000000000001";
const DOCS_ID = "00000000-0000-4000-8000-000000000002";
const FILE_ID = "00000000-0000-4000-8000-000000000003";
const OUTSIDE_ID = "00000000-0000-4000-8000-000000000004";

function workspaceIndex(): WorkspaceIndexV1 {
  const empty = createEmptyWorkspaceIndex({
    actorId: ACTOR.id,
    now: NOW,
    createId: () => ROOT_ID,
  });
  const withDocs = createWorkspaceNode(empty, {
    kind: "folder",
    parentId: ROOT_ID,
    name: "docs",
  }, {
    actorId: ACTOR.id,
    now: NOW,
    createId: () => DOCS_ID,
  });
  const withFile = createWorkspaceNode(withDocs.index, {
    kind: "file",
    parentId: DOCS_ID,
    name: "readme.md",
    size: 1,
  }, {
    actorId: ACTOR.id,
    now: NOW,
    createId: () => FILE_ID,
  });
  return createWorkspaceNode(withFile.index, {
    kind: "file",
    parentId: ROOT_ID,
    name: "outside.txt",
    size: 1,
  }, {
    actorId: ACTOR.id,
    now: NOW,
    createId: () => OUTSIDE_ID,
  }).index;
}

const grant: WorkspaceGrant = {
  sourceWorkspaceId: SOURCE_WORKSPACE_ID,
  targetWorkspaceId: TARGET_WORKSPACE_ID,
  rootNodeId: DOCS_ID,
  permission: "write",
};

function access(
  index: WorkspaceIndexV1,
  right: WorkspaceRight,
  operation: WorkspaceSubtreeOperation,
  override: Partial<WorkspaceGrant> = {},
): void {
  requireWorkspaceSubtreeAccess({
    index,
    sourceWorkspaceId: SOURCE_WORKSPACE_ID,
    targetWorkspaceId: TARGET_WORKSPACE_ID,
    right,
    grant: { ...grant, ...override },
    operation,
  });
}

function mutation(change: WorkspaceFileMutation): WorkspaceSubtreeOperation {
  return { kind: "mutation", changes: [change] };
}

describe("workspace public contracts", () => {
  it("represents accepted and chat-fork file revisions with one FileRef", () => {
    const accepted: FileRef = {
      workspaceId: SOURCE_WORKSPACE_ID,
      nodeId: FILE_ID,
      revision: { kind: "accepted", commit: HEAD },
    };
    const chat: FileRef = {
      workspaceId: SOURCE_WORKSPACE_ID,
      nodeId: FILE_ID,
      revision: { kind: "chat", chatId: 17, epoch: 2, commit: HEAD },
    };

    expect(accepted.revision.kind).toBe("accepted");
    expect(chat.revision).toEqual({ kind: "chat", chatId: 17, epoch: 2, commit: HEAD });
  });

  it("derives workspace rights from owner, build, and use roles", () => {
    const roles: WorkspaceAccessRole[] = ["owner", "build", "use"];
    expect(roles).toEqual(["owner", "build", "use"]);
    expect(workspaceRightsForRole("owner")).toEqual(["read", "write", "execute", "manage"]);
    expect(workspaceRightsForRole("build")).toEqual(["read", "write", "execute", "manage"]);
    expect(workspaceRightsForRole("use")).toEqual([]);
    expect(workspaceRightsForRole("admin")).toEqual([]);
  });

  it("accepts the planned grant shape and target variants", () => {
    const accepted: WriteTarget = { kind: "accepted" };
    const chat: WriteTarget = { kind: "chat", chatId: 17, epoch: 2 };
    expect(accepted).toEqual({ kind: "accepted" });
    expect(chat).toEqual({ kind: "chat", chatId: 17, epoch: 2 });
    expect(grant).toEqual({
      sourceWorkspaceId: SOURCE_WORKSPACE_ID,
      targetWorkspaceId: TARGET_WORKSPACE_ID,
      rootNodeId: DOCS_ID,
      permission: "write",
    });
  });
});

describe("workspace subtree access", () => {
  it("allows reads inside the granted subtree and rejects escapes", () => {
    const index = workspaceIndex();
    expect(() => access(index, "read", { kind: "read", nodeId: FILE_ID })).not.toThrow();
    expect(() => access(index, "read", { kind: "list", nodeId: DOCS_ID })).not.toThrow();
    try {
      access(index, "read", { kind: "read", nodeId: OUTSIDE_ID });
      throw new Error("Expected subtree access to be denied.");
    } catch (error) {
      expect(error).toMatchObject({ code: WORKSPACE_FILE_ERROR_CODES.accessDenied });
    }
  });

  it("validates grant source, target, and right before reading", () => {
    const index = workspaceIndex();
    expect(() => access(index, "read", { kind: "read", nodeId: FILE_ID }, {
      sourceWorkspaceId: TARGET_WORKSPACE_ID,
    })).toThrow(/source workspace/);
    expect(() => access(index, "read", { kind: "read", nodeId: FILE_ID }, {
      targetWorkspaceId: SOURCE_WORKSPACE_ID,
    })).toThrow(/target workspace/);
    expect(() => access(index, "write", { kind: "read", nodeId: FILE_ID }, {
      permission: "read",
    })).toThrow(/right/);
  });

  it("checks every mutation kind against the granted subtree", () => {
    const index = workspaceIndex();
    const changes: WorkspaceSubtreeOperation[] = [
      mutation({
        kind: "createFolder",
        clientId: "new-folder",
        parent: { nodeId: DOCS_ID },
        name: "nested",
      }),
      mutation({
        kind: "createFile",
        clientId: "new-file",
        parent: { nodeId: DOCS_ID },
        name: "new.txt",
        uploadId: "upload",
      }),
      mutation({ kind: "replaceFile", nodeId: FILE_ID, uploadId: "upload" }),
      mutation({
        kind: "move",
        nodeId: FILE_ID,
        parent: { nodeId: DOCS_ID },
        name: "renamed.md",
      }),
      mutation({ kind: "delete", nodeId: FILE_ID }),
    ];
    for (const operation of changes) {
      expect(() => access(index, "write", operation)).not.toThrow();
    }
  });

  it("rejects mutation sources and destinations outside the subtree", () => {
    const index = workspaceIndex();
    const escaped: WorkspaceSubtreeOperation[] = [
      mutation({
        kind: "createFolder",
        clientId: "escaped-folder",
        parent: { nodeId: ROOT_ID },
        name: "escaped",
      }),
      mutation({
        kind: "createFile",
        clientId: "escaped-file",
        parent: { nodeId: ROOT_ID },
        name: "escaped.txt",
        uploadId: "upload",
      }),
      mutation({ kind: "replaceFile", nodeId: OUTSIDE_ID, uploadId: "upload" }),
      mutation({
        kind: "move",
        nodeId: FILE_ID,
        parent: { nodeId: ROOT_ID },
        name: "escaped.md",
      }),
      mutation({ kind: "move", nodeId: OUTSIDE_ID, parent: { nodeId: DOCS_ID }, name: "inside.txt" }),
      mutation({ kind: "delete", nodeId: OUTSIDE_ID }),
    ];
    for (const operation of escaped) {
      expect(() => access(index, "write", operation)).toThrow(/subtree/);
    }
  });

  it("resolves newly created client IDs without allowing a created subtree to escape", () => {
    const index = workspaceIndex();
    const operation: WorkspaceSubtreeOperation = {
      kind: "mutation",
      changes: [
        {
          kind: "createFolder",
          clientId: "new-folder",
          parent: { nodeId: DOCS_ID },
          name: "nested",
        },
        {
          kind: "createFile",
          clientId: "new-file",
          parent: { clientId: "new-folder" },
          name: "new.txt",
          uploadId: "upload",
        },
        {
          kind: "move",
          nodeId: FILE_ID,
          parent: { clientId: "new-folder" },
          name: "moved.md",
        },
      ],
    };
    expect(() => access(index, "write", operation)).not.toThrow();
    expect(() => access(index, "write", {
      kind: "mutation",
      changes: [{
        kind: "move",
        nodeId: FILE_ID,
        parent: { clientId: "missing" },
        name: "moved.md",
      }],
    })).toThrow(/client ID/);
  });
});

describe("workspace operation digests", () => {
  const baseRequest = {
    operationId: "00000000-0000-4000-8000-000000000010",
    expectedHead: HEAD,
    actor: ACTOR,
    timestamp: NOW,
    message: "Create file",
    changes: [{
      kind: "createFile" as const,
      clientId: "file",
      parent: { nodeId: ROOT_ID },
      content: new Uint8Array([1]),
      name: "file.txt",
    }],
  };

  it("includes accepted or chat target identity in accepted and staged digests", async () => {
    const accepted: WorkspaceMutationRequest = { ...baseRequest, target: { kind: "accepted" } };
    const chat: WorkspaceMutationRequest = {
      ...baseRequest,
      target: { kind: "chat", chatId: 1, epoch: 0 },
    };
    expect(await digestRequest(accepted)).not.toBe(await digestRequest(chat));

    const stagedBase: StagedWorkspaceMutationRequest = {
      ...baseRequest,
      target: { kind: "accepted" },
      changes: [{
        kind: "createFile",
        clientId: "file",
        parent: { nodeId: ROOT_ID },
        uploadId: "upload",
      }],
    };
    const stagedChat: StagedWorkspaceMutationRequest = {
      ...stagedBase,
      target: { kind: "chat", chatId: 1, epoch: 0 },
    };
    expect(await digestStagedRequest(stagedBase)).not.toBe(await digestStagedRequest(stagedChat));
  });

  it("canonicalizes chat target fields before hashing", async () => {
    const first: WorkspaceMutationRequest = {
      ...baseRequest,
      target: { kind: "chat", chatId: 17, epoch: 2 },
    };
    const reordered: WorkspaceMutationRequest = {
      ...baseRequest,
      target: { epoch: 2, chatId: 17, kind: "chat" },
    };

    expect(await digestRequest(first)).toBe(await digestRequest(reordered));
    expect(await digestStagedRequest({
      ...first,
      changes: [{
        kind: "createFile",
        clientId: "file",
        parent: { nodeId: ROOT_ID },
        uploadId: "upload",
      }],
    })).toBe(await digestStagedRequest({
      ...reordered,
      changes: [{
        kind: "createFile",
        clientId: "file",
        parent: { nodeId: ROOT_ID },
        uploadId: "upload",
      }],
    }));
  });

  it("validates immutable file references and nonnegative chat targets", () => {
    expect(() => requireFileRef({
      workspaceId: SOURCE_WORKSPACE_ID,
      nodeId: FILE_ID,
      revision: { kind: "accepted", commit: HEAD },
    })).not.toThrow();
    expect(() => requireFileRef({
      workspaceId: SOURCE_WORKSPACE_ID,
      nodeId: FILE_ID,
      revision: { kind: "chat", chatId: -1, epoch: 2, commit: HEAD },
    })).toThrow(/chat/);
    expect(() => requireFileRef({
      workspaceId: SOURCE_WORKSPACE_ID,
      nodeId: FILE_ID,
      revision: { kind: "accepted", commit: "not-a-commit" },
    })).toThrow(/commit/);
    expect(() => requireWriteTarget({ kind: "chat", chatId: -1, epoch: 0 })).toThrow(/target/);
  });
});
