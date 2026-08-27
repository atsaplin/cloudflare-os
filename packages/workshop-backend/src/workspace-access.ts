import {
  WORKSPACE_FILE_ERROR_CODES,
  type WorkspaceFileMutation,
  type WorkspaceFileNodeReference,
  type WorkspaceGrant,
  type WorkspaceRight,
} from "@gadgets/workshop-shared/api";
import {
  getWorkspaceNode,
  validateWorkspaceIndex,
  type WorkspaceIndexV1,
  type WorkspaceNode,
} from "./workspace-manifest";
import { expectedError } from "./workspace-files";

/** One workspace read or target-aware mutation checked against a granted subtree. */
export type WorkspaceSubtreeOperation =
  | { kind: "list"; nodeId: string }
  | { kind: "read"; nodeId: string }
  | { kind: "mutation"; changes: WorkspaceFileMutation[] };

/** Inputs authorized by the single workspace subtree policy. */
export type WorkspaceSubtreeAccessRequest = {
  index: WorkspaceIndexV1;
  grant: WorkspaceGrant;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  right: WorkspaceRight;
  operation: WorkspaceSubtreeOperation;
};

function deny(message: string): never {
  return expectedError(WORKSPACE_FILE_ERROR_CODES.accessDenied, message);
}

function invalid(message: string): never {
  return expectedError(WORKSPACE_FILE_ERROR_CODES.invalidRequest, message);
}

function requireWorkspaceId(value: string, label: string): void {
  if (!value || new TextEncoder().encode(value).byteLength > 256 || /[\r\n]/.test(value)) {
    invalid(`${label} is invalid.`);
  }
}

function requireGrant(
  grant: WorkspaceGrant,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  right: WorkspaceRight,
): void {
  requireWorkspaceId(sourceWorkspaceId, "Source workspace");
  requireWorkspaceId(targetWorkspaceId, "Target workspace");
  requireWorkspaceId(grant.sourceWorkspaceId, "Grant source workspace");
  requireWorkspaceId(grant.targetWorkspaceId, "Grant target workspace");
  if (sourceWorkspaceId === targetWorkspaceId) {
    invalid("Source and target workspaces must differ.");
  }
  if (grant.sourceWorkspaceId !== sourceWorkspaceId) {
    deny("Grant source workspace does not match the operation source workspace.");
  }
  if (grant.targetWorkspaceId !== targetWorkspaceId) {
    deny("Grant target workspace does not match the operation target workspace.");
  }
  if (right !== "read" && right !== "write") invalid("Workspace right is invalid.");
  if (grant.permission !== "read" && grant.permission !== "write") {
    invalid("Workspace grant permission is invalid.");
  }
  if (grant.permission === "read" && right !== "read") {
    deny("Workspace grant does not provide the requested right.");
  }
}

function requireNode(index: WorkspaceIndexV1, nodeId: string): WorkspaceNode {
  const node = getWorkspaceNode(index, nodeId);
  if (!node) invalid(`Workspace node ${nodeId} does not exist.`);
  return node;
}

function requireWithinSubtree(
  index: WorkspaceIndexV1,
  rootNodeId: string,
  nodeId: string,
): WorkspaceNode {
  const node = requireNode(index, nodeId);
  let current: string | null = node.id;
  while (current !== null) {
    if (current === rootNodeId) return node;
    const ancestor = requireNode(index, current);
    current = ancestor.parentId;
  }
  deny(`Workspace node ${nodeId} is outside the granted subtree.`);
}

function requireReference(
  index: WorkspaceIndexV1,
  rootNodeId: string,
  reference: WorkspaceFileNodeReference,
  created: Map<string, "file" | "folder">,
): { id: string; kind: "file" | "folder" } {
  if ("clientId" in reference) {
    const kind = created.get(reference.clientId);
    if (!kind) invalid(`Unknown workspace mutation client ID: ${reference.clientId}`);
    return { id: reference.clientId, kind };
  }
  const node = requireWithinSubtree(index, rootNodeId, reference.nodeId);
  return { id: node.id, kind: node.kind };
}

function requireParent(
  index: WorkspaceIndexV1,
  rootNodeId: string,
  reference: WorkspaceFileNodeReference,
  created: Map<string, "file" | "folder">,
): void {
  const parent = requireReference(index, rootNodeId, reference, created);
  if (parent.kind !== "folder") invalid("Workspace mutation parent is not a folder.");
}

function requireMutationAccess(
  index: WorkspaceIndexV1,
  rootNodeId: string,
  changes: WorkspaceFileMutation[],
): void {
  if (changes.length === 0) invalid("Workspace mutations must contain at least one change.");
  const created = new Map<string, "file" | "folder">();
  for (const change of changes) {
    if (change.kind === "createFolder") {
      if (!change.clientId || created.has(change.clientId)) {
        invalid("Created workspace nodes require unique non-empty client IDs.");
      }
      requireParent(index, rootNodeId, change.parent, created);
      created.set(change.clientId, "folder");
    } else if (change.kind === "createFile") {
      if (!change.clientId || created.has(change.clientId)) {
        invalid("Created workspace nodes require unique non-empty client IDs.");
      }
      requireParent(index, rootNodeId, change.parent, created);
      created.set(change.clientId, "file");
    } else if (change.kind === "replaceFile") {
      const node = requireWithinSubtree(index, rootNodeId, change.nodeId);
      if (node.kind !== "file") invalid("Workspace replacement target is not a file.");
    } else if (change.kind === "move") {
      requireWithinSubtree(index, rootNodeId, change.nodeId);
      requireParent(index, rootNodeId, change.parent, created);
    } else {
      requireWithinSubtree(index, rootNodeId, change.nodeId);
    }
  }
}

/** Enforces grant direction, right, manifest identity, and subtree boundaries. */
export function requireWorkspaceSubtreeAccess(
  request: WorkspaceSubtreeAccessRequest,
): void {
  validateWorkspaceIndex(request.index);
  requireGrant(
    request.grant,
    request.sourceWorkspaceId,
    request.targetWorkspaceId,
    request.right,
  );
  const root = requireNode(request.index, request.grant.rootNodeId);
  if (root.kind !== "folder") invalid("Workspace grant root must be a folder.");
  if (request.operation.kind === "list") {
    const node = requireWithinSubtree(request.index, root.id, request.operation.nodeId);
    if (node.kind !== "folder") invalid("Workspace list target is not a folder.");
  } else if (request.operation.kind === "read") {
    const node = requireWithinSubtree(request.index, root.id, request.operation.nodeId);
    if (node.kind !== "file") invalid("Workspace read target is not a file.");
  } else {
    requireMutationAccess(request.index, root.id, request.operation.changes);
  }
}
