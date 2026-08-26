import { z } from "zod";

/** Repository path containing the versioned workspace identity index. */
export const WORKSPACE_INDEX_PATH = ".workspace/index.json";

/** Metadata for one versioned workspace file or folder identity. */
export interface WorkspaceIndexNode {
  kind: "file" | "folder";
  parentId: string | null;
  name: string;
  mediaType?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** The canonical version-one identity index committed beside workspace files. */
export interface WorkspaceIndexV1 {
  version: 1;
  rootId: string;
  nodes: Record<string, WorkspaceIndexNode>;
}

/** Server-owned values used when creating or changing workspace identities. */
export interface WorkspaceIndexContext {
  actorId: string;
  now: string;
  createId?: () => string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumActorIdBytes = 256;
const maximumNameBytes = 255;
const maximumMediaTypeBytes = 256;
const maximumManifestBytes = 4 * 1024 * 1024;

/** A workspace node together with its stable identity and current path. */
export interface WorkspaceNode extends WorkspaceIndexNode {
  id: string;
  path: string;
}

/** A Git tree entry kind understood by workspace index consistency checks. */
export type WorkspaceTreeEntryKind = "file" | "folder" | "symlink" | "submodule";

const nodeSchema: z.ZodType<WorkspaceIndexNode> = z.strictObject({
  kind: z.enum(["file", "folder"]),
  parentId: z.string().nullable(),
  name: z.string(),
  mediaType: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

const indexSchema: z.ZodType<WorkspaceIndexV1> = z.strictObject({
  version: z.literal(1),
  rootId: z.string(),
  nodes: z.record(z.string(), nodeSchema),
});

function requireUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new Error(`${field} must be a lowercase UUID v4.`);
}

function requireCanonicalTimestamp(value: string): void {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new Error("Workspace timestamps must be canonical UTC ISO strings.");
  }
}

function requireName(value: string): void {
  if (!value || value !== value.normalize("NFC")) {
    throw new Error("Workspace names must be non-empty and NFC-normalized.");
  }
  if (value === "." || value === ".." || value === ".git" || value === ".workspace") {
    throw new Error(`Workspace name ${JSON.stringify(value)} is reserved.`);
  }
  if (/[\\/\p{Cc}]/u.test(value)) {
    throw new Error("Workspace names must be single safe path segments.");
  }
  if (new TextEncoder().encode(value).byteLength > maximumNameBytes) {
    throw new Error(`Workspace names cannot exceed ${maximumNameBytes} UTF-8 bytes.`);
  }
}

function requireMediaType(value: string | undefined): void {
  if (value === undefined) return;
  if (!value || value !== value.trim() || /\p{Cc}/u.test(value) ||
      new TextEncoder().encode(value).byteLength > maximumMediaTypeBytes) {
    throw new Error("Workspace media types must be normalized and bounded.");
  }
}

function canonicalNode(node: WorkspaceIndexNode): WorkspaceIndexNode {
  return {
    kind: node.kind,
    parentId: node.parentId,
    name: node.name,
    ...(node.mediaType === undefined ? {} : { mediaType: node.mediaType }),
    createdAt: node.createdAt,
    createdBy: node.createdBy,
    updatedAt: node.updatedAt,
    updatedBy: node.updatedBy,
  };
}

function copyIndex(index: WorkspaceIndexV1): WorkspaceIndexV1 {
  return {
    version: 1,
    rootId: index.rootId,
    nodes: Object.fromEntries(
      Object.entries(index.nodes).map(([id, node]) => [id, canonicalNode(node)]),
    ),
  };
}

function requireFolder(index: WorkspaceIndexV1, nodeId: string): WorkspaceIndexNode {
  const node = index.nodes[nodeId];
  if (!node) throw new Error(`Workspace node ${nodeId} does not exist.`);
  if (node.kind !== "folder") throw new Error(`Workspace node ${nodeId} is not a folder.`);
  return node;
}

function requireNode(index: WorkspaceIndexV1, nodeId: string): WorkspaceIndexNode {
  const node = index.nodes[nodeId];
  if (!node) throw new Error(`Workspace node ${nodeId} does not exist.`);
  return node;
}

function childIds(index: WorkspaceIndexV1, parentId: string): string[] {
  return Object.entries(index.nodes)
    .filter(([, node]) => node.parentId === parentId)
    .map(([id]) => id)
    .toSorted();
}

function requireAvailableName(
  index: WorkspaceIndexV1,
  parentId: string,
  name: string,
  ignoredId?: string,
): void {
  const collision = Object.entries(index.nodes).some(([id, node]) =>
    id !== ignoredId && node.parentId === parentId && node.name === name);
  if (collision) throw new Error(`Workspace sibling name ${JSON.stringify(name)} already exists.`);
}

function requireActorId(value: string): void {
  if (!value || new TextEncoder().encode(value).byteLength > maximumActorIdBytes) {
    throw new Error(`Workspace actor IDs must contain 1 to ${maximumActorIdBytes} UTF-8 bytes.`);
  }
}

/** Creates the canonical identity index for a new, empty workspace repository. */
export function createEmptyWorkspaceIndex(context: WorkspaceIndexContext): WorkspaceIndexV1 {
  requireCanonicalTimestamp(context.now);
  requireActorId(context.actorId);
  const rootId = (context.createId ?? (() => crypto.randomUUID()))();
  requireUuid(rootId, "Workspace root ID");

  return {
    version: 1,
    rootId,
    nodes: {
      [rootId]: {
        kind: "folder",
        parentId: null,
        name: "",
        createdAt: context.now,
        createdBy: context.actorId,
        updatedAt: context.now,
        updatedBy: context.actorId,
      },
    },
  };
}

/** Validates the complete graph and metadata invariants of a workspace index. */
export function validateWorkspaceIndex(index: WorkspaceIndexV1): void {
  requireUuid(index.rootId, "Workspace root ID");
  const root = index.nodes[index.rootId];
  if (!root || root.kind !== "folder" || root.parentId !== null || root.name !== "") {
    throw new Error("Workspace root must be the sole unnamed folder with no parent.");
  }

  const siblings = new Set<string>();
  for (const [id, node] of Object.entries(index.nodes)) {
    requireUuid(id, "Workspace node ID");
    requireCanonicalTimestamp(node.createdAt);
    requireCanonicalTimestamp(node.updatedAt);
    requireActorId(node.createdBy);
    requireActorId(node.updatedBy);
    requireMediaType(node.mediaType);
    if (node.kind === "folder" && node.mediaType !== undefined) {
      throw new Error("Workspace folders cannot have media types.");
    }
    if (id === index.rootId) continue;
    if (node.parentId === null) throw new Error("Only the workspace root can have no parent.");
    requireName(node.name);
    const parent = index.nodes[node.parentId];
    if (!parent || parent.kind !== "folder") {
      throw new Error(`Workspace node ${id} must have an existing folder parent.`);
    }
    const siblingKey = `${node.parentId}\0${node.name}`;
    if (siblings.has(siblingKey)) throw new Error(`Workspace sibling name ${node.name} is duplicated.`);
    siblings.add(siblingKey);

    const ancestors = new Set([id]);
    let ancestorId: string | null = node.parentId;
    while (ancestorId !== null) {
      if (ancestors.has(ancestorId)) throw new Error("Workspace index contains a parent cycle.");
      ancestors.add(ancestorId);
      const ancestor: WorkspaceIndexNode | undefined = index.nodes[ancestorId];
      if (!ancestor) throw new Error(`Workspace node ${id} is disconnected from the root.`);
      ancestorId = ancestor.parentId;
    }
    if (!ancestors.has(index.rootId)) {
      throw new Error(`Workspace node ${id} is disconnected from the root.`);
    }
  }
}

/** Serializes a workspace identity index using stable field and node ordering. */
export function serializeWorkspaceIndex(index: WorkspaceIndexV1): Uint8Array {
  validateWorkspaceIndex(index);
  const nodes: Record<string, WorkspaceIndexNode> = {};
  for (const id of Object.keys(index.nodes).toSorted()) nodes[id] = canonicalNode(index.nodes[id]);
  return new TextEncoder().encode(JSON.stringify({
    version: index.version,
    rootId: index.rootId,
    nodes,
  }) + "\n");
}

/** Parses a canonical workspace index and rejects malformed or noncanonical bytes. */
export function parseWorkspaceIndex(bytes: Uint8Array): WorkspaceIndexV1 {
  if (bytes.byteLength > maximumManifestBytes) {
    throw new Error(`Workspace index exceeds ${maximumManifestBytes} bytes.`);
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Workspace index must contain valid JSON.", { cause: error });
  }
  const index = indexSchema.parse(value);
  validateWorkspaceIndex(index);
  if (new TextDecoder().decode(serializeWorkspaceIndex(index)) !== text) {
    throw new Error("Workspace index JSON must use canonical serialization.");
  }
  return index;
}

/** Resolves a stable node identity to its current repository-relative path. */
export function resolveWorkspacePath(index: WorkspaceIndexV1, nodeId: string): string {
  validateWorkspaceIndex(index);
  if (nodeId === index.rootId) return "";
  const segments: string[] = [];
  let currentId: string | null = nodeId;
  while (currentId !== null && currentId !== index.rootId) {
    const node: WorkspaceIndexNode = requireNode(index, currentId);
    segments.push(node.name);
    currentId = node.parentId;
  }
  return segments.toReversed().join("/");
}

/** Returns one node with its stable identity and current path. */
export function getWorkspaceNode(
  index: WorkspaceIndexV1,
  nodeId: string,
): WorkspaceNode | undefined {
  const node = index.nodes[nodeId];
  if (!node) return undefined;
  return { id: nodeId, path: resolveWorkspacePath(index, nodeId), ...canonicalNode(node) };
}

/** Lists a folder's immediate children in deterministic name order. */
export function listWorkspaceChildren(index: WorkspaceIndexV1, parentId: string): WorkspaceNode[] {
  validateWorkspaceIndex(index);
  requireFolder(index, parentId);
  return Object.entries(index.nodes)
    .filter(([, node]) => node.parentId === parentId)
    .map(([id, node]) => ({
      id,
      path: resolveWorkspacePath(index, id),
      ...canonicalNode(node),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Creates one file or folder identity without mutating the input index. */
export function createWorkspaceNode(
  index: WorkspaceIndexV1,
  operation: {
    kind: "file" | "folder";
    parentId: string;
    name: string;
    mediaType?: string;
  },
  context: WorkspaceIndexContext,
): { index: WorkspaceIndexV1; node: WorkspaceNode } {
  validateWorkspaceIndex(index);
  requireFolder(index, operation.parentId);
  requireName(operation.name);
  requireMediaType(operation.mediaType);
  if (operation.kind === "folder" && operation.mediaType !== undefined) {
    throw new Error("Workspace folders cannot have media types.");
  }
  requireCanonicalTimestamp(context.now);
  requireActorId(context.actorId);
  requireAvailableName(index, operation.parentId, operation.name);
  const id = (context.createId ?? (() => crypto.randomUUID()))();
  requireUuid(id, "Workspace node ID");
  if (index.nodes[id]) throw new Error(`Workspace node ID ${id} already exists.`);

  const next = copyIndex(index);
  next.nodes[id] = {
    kind: operation.kind,
    parentId: operation.parentId,
    name: operation.name,
    ...(operation.mediaType === undefined ? {} : { mediaType: operation.mediaType }),
    createdAt: context.now,
    createdBy: context.actorId,
    updatedAt: context.now,
    updatedBy: context.actorId,
  };
  validateWorkspaceIndex(next);
  const node = getWorkspaceNode(next, id);
  if (!node) throw new Error("Created workspace node could not be resolved.");
  return { index: next, node };
}

/** Renames or moves one node while preserving its stable identity. */
export function moveWorkspaceNode(
  index: WorkspaceIndexV1,
  nodeId: string,
  parentId: string,
  name: string,
  context: WorkspaceIndexContext,
): WorkspaceIndexV1 {
  validateWorkspaceIndex(index);
  if (nodeId === index.rootId) throw new Error("The workspace root cannot be moved.");
  requireNode(index, nodeId);
  requireFolder(index, parentId);
  requireName(name);
  requireCanonicalTimestamp(context.now);
  requireActorId(context.actorId);
  requireAvailableName(index, parentId, name, nodeId);

  let ancestorId: string | null = parentId;
  while (ancestorId !== null) {
    if (ancestorId === nodeId) throw new Error("A workspace folder cannot move into its descendant.");
    ancestorId = requireNode(index, ancestorId).parentId;
  }

  const next = copyIndex(index);
  next.nodes[nodeId] = {
    ...next.nodes[nodeId],
    parentId,
    name,
    updatedAt: context.now,
    updatedBy: context.actorId,
  };
  validateWorkspaceIndex(next);
  return next;
}

/** Updates mutable file metadata while preserving identity and creation metadata. */
export function updateWorkspaceFileMetadata(
  index: WorkspaceIndexV1,
  nodeId: string,
  mediaType: string | undefined,
  context: WorkspaceIndexContext,
): WorkspaceIndexV1 {
  validateWorkspaceIndex(index);
  const node = requireNode(index, nodeId);
  if (node.kind !== "file") throw new Error(`Workspace node ${nodeId} is not a file.`);
  requireMediaType(mediaType);
  requireCanonicalTimestamp(context.now);
  requireActorId(context.actorId);
  const next = copyIndex(index);
  next.nodes[nodeId] = {
    ...next.nodes[nodeId],
    ...(mediaType === undefined ? { mediaType: undefined } : { mediaType }),
    updatedAt: context.now,
    updatedBy: context.actorId,
  };
  validateWorkspaceIndex(next);
  return next;
}

/** Deletes one node, optionally including all descendants, without mutating the input index. */
export function deleteWorkspaceNode(
  index: WorkspaceIndexV1,
  nodeId: string,
  recursive: boolean,
): { index: WorkspaceIndexV1; deletedIds: string[] } {
  validateWorkspaceIndex(index);
  if (nodeId === index.rootId) throw new Error("The workspace root cannot be deleted.");
  requireNode(index, nodeId);
  const directChildren = childIds(index, nodeId);
  if (!recursive && directChildren.length > 0) throw new Error("Workspace folder is not empty.");

  const deletedIds: string[] = [];
  const collect = (id: string): void => {
    for (const childId of childIds(index, id)) collect(childId);
    deletedIds.push(id);
  };
  collect(nodeId);
  const next = copyIndex(index);
  for (const id of deletedIds) delete next.nodes[id];
  validateWorkspaceIndex(next);
  return { index: next, deletedIds };
}

/** Verifies that visible Git entries and versioned workspace identities describe the same tree. */
export function validateWorkspaceTree(
  index: WorkspaceIndexV1,
  tree: ReadonlyMap<string, WorkspaceTreeEntryKind>,
): void {
  validateWorkspaceIndex(index);
  const files = new Map<string, string>();
  const folders = new Set<string>();
  for (const [id, node] of Object.entries(index.nodes)) {
    if (id === index.rootId) continue;
    const path = resolveWorkspacePath(index, id);
    if (node.kind === "file") files.set(path, id);
    else folders.add(path);
  }

  const seenFiles = new Set<string>();
  for (const [path, kind] of tree) {
    if (path === WORKSPACE_INDEX_PATH) continue;
    if (path === ".workspace" && kind === "folder") continue;
    if (path.startsWith(".workspace/")) throw new Error(`Reserved workspace path: ${path}`);
    if (kind === "symlink" || kind === "submodule") {
      throw new Error(`Workspace tree contains unsupported ${kind}: ${path}`);
    }
    if (kind === "folder") {
      if (!folders.has(path)) throw new Error(`Workspace tree folder has no identity: ${path}`);
      continue;
    }
    if (!files.has(path)) throw new Error(`Workspace tree file has no identity: ${path}`);
    seenFiles.add(path);
  }
  for (const path of files.keys()) {
    if (!seenFiles.has(path)) throw new Error(`Workspace file identity has no Git blob: ${path}`);
  }
}
