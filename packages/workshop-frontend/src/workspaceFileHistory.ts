import type { RpcStub } from 'capnweb'
import {
  getWorkspaceFileErrorCode,
  WORKSPACE_FILE_ERROR_CODES,
  type CommitInfo,
  type FileRef,
  type Overseer,
  type WorkspaceFileNode,
  type WorkspaceFileRevision,
} from '@gadgets/workshop-shared/api'

function referenceAt(
  revision: WorkspaceFileRevision,
  nodeId: string,
  commit: string,
): FileRef {
  return {
    workspaceId: revision.workspaceId,
    nodeId,
    revision: { ...revision.revision, commit },
  }
}

async function readNode(
  overseer: RpcStub<Overseer>,
  reference: FileRef,
): Promise<WorkspaceFileNode | null> {
  try {
    return await overseer.getWorkspaceNode(reference)
  } catch (error) {
    if (getWorkspaceFileErrorCode(error) === WORKSPACE_FILE_ERROR_CODES.invalidRequest) return null
    throw error
  }
}

function nodeIdentity(node: WorkspaceFileNode | null): string | null {
  if (!node) return null
  return JSON.stringify({
    parentId: node.parentId,
    kind: node.kind,
    name: node.name,
    path: node.path,
    mediaType: node.mediaType,
    size: node.size,
    updatedAt: node.updatedAt.toISOString(),
    updatedBy: node.updatedBy,
  })
}

export async function filterWorkspaceFileHistory(
  overseer: RpcStub<Overseer>,
  revision: WorkspaceFileRevision,
  nodeId: string,
  history: CommitInfo[],
): Promise<CommitInfo[]> {
  const nodes = new Map<string, Promise<WorkspaceFileNode | null>>()
  const nodeAt = (commit: string): Promise<WorkspaceFileNode | null> => {
    const existing = nodes.get(commit)
    if (existing) return existing
    const pending = readNode(overseer, referenceAt(revision, nodeId, commit))
    nodes.set(commit, pending)
    return pending
  }

  const relevant = await Promise.all(history.map(async commit => {
    const parent = commit.parents[0]
    const [currentNode, parentNode] = await Promise.all([
      nodeAt(commit.oid),
      parent ? nodeAt(parent) : Promise.resolve(null),
    ])
    return nodeIdentity(currentNode) !== nodeIdentity(parentNode)
  }))
  return history.filter((_commit, index) => relevant[index])
}
