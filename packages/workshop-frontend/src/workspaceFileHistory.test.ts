import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createWorkspaceFileError,
  WORKSPACE_FILE_ERROR_CODES,
  type CommitInfo,
  type Overseer,
  type WorkspaceFileNode,
  type WorkspaceFileRevision,
} from '@gadgets/workshop-shared/api'
import { filterWorkspaceFileHistory } from './workspaceFileHistory'

const revision: WorkspaceFileRevision = {
  workspaceId: 'workspace',
  revision: { kind: 'accepted', commit: 'c'.repeat(40) },
  head: 'c'.repeat(40),
  rootId: 'root',
}

function commit(oid: string, parent: string, message: string): CommitInfo {
  return {
    oid,
    parents: [parent],
    message,
    author: { name: 'Aleksey', email: 'aleksey@localhost' },
    timestamp: new Date('2026-08-27T00:00:00.000Z'),
  }
}

function node(path: string, updatedAt: string): WorkspaceFileNode {
  return {
    id: 'file',
    parentId: 'root',
    kind: 'file',
    name: path.split('/').at(-1) ?? path,
    path,
    size: 5,
    mediaType: 'text/plain',
    createdAt: new Date('2026-08-26T00:00:00.000Z'),
    createdBy: 'aleksey',
    updatedAt: new Date(updatedAt),
    updatedBy: 'aleksey',
  }
}

describe('filterWorkspaceFileHistory', () => {
  it('keeps creation, content, and path changes while removing unrelated workspace commits', async () => {
    const created = '1'.repeat(40)
    const renamed = '2'.repeat(40)
    const unrelated = '3'.repeat(40)
    const beforeCreation = '0'.repeat(40)
    const nodes = new Map<string, WorkspaceFileNode>([
      [created, node('notes.txt', '2026-08-27T00:00:00.000Z')],
      [renamed, node('docs/notes.txt', '2026-08-27T01:00:00.000Z')],
      [unrelated, node('docs/notes.txt', '2026-08-27T01:00:00.000Z')],
    ])
    const overseer = {
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async reference => {
        const result = nodes.get(reference.revision.commit)
        if (!result) throw createWorkspaceFileError(WORKSPACE_FILE_ERROR_CODES.invalidRequest)
        return result
      }),
    } as unknown as RpcStub<Overseer>
    const history = [
      commit(unrelated, renamed, 'Unrelated change'),
      commit(renamed, created, 'Move notes'),
      commit(created, beforeCreation, 'Create notes'),
    ]

    expect(await filterWorkspaceFileHistory(overseer, revision, 'file', history)).toEqual([
      history[1],
      history[2],
    ])
  })
})
