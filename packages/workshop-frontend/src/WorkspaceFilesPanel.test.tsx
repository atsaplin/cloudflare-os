// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createWorkspaceFileError,
  WORKSPACE_FILE_ERROR_CODES,
  type Overseer,
  type WorkspaceFileNode,
} from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const toast = vi.fn<(value: unknown) => void>()
vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => toastManager,
}))
const toastManager = { add: toast }

vi.mock('./components/DeleteConfirmationDialog', () => ({
  default: () => null,
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: React.ComponentProps<'button'> & { danger?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  WorkshopInput: (props: React.ComponentProps<'input'>) => <input {...props} />,
}))

import WorkspaceFilesPanel from './WorkspaceFilesPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function node(overrides: Partial<WorkspaceFileNode>): WorkspaceFileNode {
  return {
    id: 'node',
    parentId: 'root',
    kind: 'file',
    name: 'file.bin',
    path: 'file.bin',
    size: 4,
    createdAt: new Date('2026-08-26T04:00:00.000Z'),
    createdBy: 'aleksey',
    updatedAt: new Date('2026-08-26T04:00:00.000Z'),
    updatedBy: 'aleksey',
    ...overrides,
  }
}

describe('WorkspaceFilesPanel', () => {
  it('navigates folders and uploads arbitrary files larger than one megabyte', async () => {
    const rootNodes = [
      node({ id: 'docs', kind: 'folder', name: 'Documents', path: 'Documents', size: 0 }),
      node({ id: 'archive-folder', kind: 'folder', name: 'Archive', path: 'Archive', size: 0 }),
    ]
    const listWorkspaceChildren = vi.fn<(folderId: string) => Promise<WorkspaceFileNode[]>>()
      .mockResolvedValueOnce(rootNodes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([node({
        id: 'archive',
        parentId: 'docs',
        name: 'project.zip',
        path: 'Documents/project.zip',
        size: 2 * 1024 * 1024,
        mediaType: 'application/zip',
      })])
      .mockResolvedValueOnce(rootNodes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const stageWorkspaceFileUpload = vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => {
      expect(new Uint8Array(await new Response(request.content).arrayBuffer()).byteLength)
        .toBe(2 * 1024 * 1024)
      return {
        uploadId: '00000000-0000-4000-8000-000000000080',
        size: request.size,
        mediaType: request.mediaType,
        expiresAt: new Date('2026-08-27T04:00:00.000Z'),
      }
    })
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      operationId: request.operationId,
      head: 'b'.repeat(40),
      rootId: 'root',
      created: { upload: 'archive' },
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(
        async () => ({ head: 'a'.repeat(40), rootId: 'root' }),
      ),
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => [{
        oid: 'c'.repeat(40),
        parents: [],
        message: 'Add project archive\n\nWorkspace-Operation: internal\n',
        author: { name: 'Aleksey', email: 'aleksey@localhost' },
        timestamp: new Date('2026-08-26T04:00:00.000Z'),
      }]),
      stageWorkspaceFileUpload,
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})

    const documents = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Documents'))
    await act(async () => documents?.click())
    expect(listWorkspaceChildren).toHaveBeenNthCalledWith(2, 'docs')

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe('')
    const bytes = new Uint8Array(2 * 1024 * 1024)
    bytes.set([0x50, 0x4b, 0x03, 0x04])
    const file = new File([bytes], 'project.zip', { type: 'application/zip' })
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(stageWorkspaceFileUpload).toHaveBeenCalledWith(expect.objectContaining({
      size: file.size,
      mediaType: 'application/zip',
    }))
    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      expectedHead: 'a'.repeat(40),
      changes: [expect.objectContaining({
        kind: 'createFile',
        name: 'project.zip',
        parent: { nodeId: 'docs' },
        uploadId: '00000000-0000-4000-8000-000000000080',
      })],
    }))
    expect(container.textContent).toContain('project.zip')
    expect(container.textContent).toContain('Add project archive')
    expect(container.textContent).not.toContain('Workspace-Operation')

    const rename = container.querySelector<HTMLButtonElement>('[aria-label="Rename project.zip"]')
    await act(async () => rename?.click())
    const renameInput = container.querySelector<HTMLInputElement>('[aria-label="Rename project.zip"]')
    const saveRename = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save')
    expect(renameInput?.value).toBe('project.zip')
    expect(saveRename?.disabled).toBe(true)
    await act(async () => {
      renameInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(applyWorkspaceMutation).toHaveBeenCalledTimes(1)
    await act(async () => {
      renameInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    const move = container.querySelector<HTMLButtonElement>('[aria-label="Move project.zip"]')
    await act(async () => move?.click())
    expect(container.textContent).toContain('Move project.zip here')

    const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to parent folder"]')
    await act(async () => back?.click())
    const archiveFolder = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Archive'))
    await act(async () => archiveFolder?.click())
    const moveHere = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Move project.zip here'))
    await act(async () => moveHere?.click())

    expect(applyWorkspaceMutation).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedHead: 'b'.repeat(40),
      changes: [{
        kind: 'move',
        nodeId: 'archive',
        parent: { nodeId: 'archive-folder' },
        name: 'project.zip',
      }],
    }))
  })

  it('offers a retry when the initial workspace load fails', async () => {
    const getWorkspaceRevision = vi.fn<Overseer['getWorkspaceRevision']>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ head: 'a'.repeat(40), rootId: 'root' })
    const overseer = {
      getWorkspaceRevision,
      listWorkspaceChildren: vi.fn<Overseer['listWorkspaceChildren']>(async () => []),
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})

    expect(container.textContent).toContain('Could not load workspace files.')
    const retry = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Retry')
    expect(retry).toBeDefined()

    await act(async () => retry?.click())
    await act(async () => {})

    expect(getWorkspaceRevision).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('This folder is empty.')
  })

  it('renames a file and clears the pending rename when navigating', async () => {
    const documents = node({
      id: 'docs',
      kind: 'folder',
      name: 'Documents',
      path: 'Documents',
      size: 0,
    })
    const original = node({ id: 'file', name: 'original.bin', path: 'original.bin' })
    const renamed = node({ id: 'file', name: 'renamed.bin', path: 'renamed.bin' })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([documents, original])
      .mockResolvedValueOnce([documents, renamed])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([documents, renamed])
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      operationId: request.operationId,
      head: 'b'.repeat(40),
      rootId: 'root',
      created: {},
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(
        async () => ({ head: 'a'.repeat(40), rootId: 'root' }),
      ),
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Rename original.bin"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Rename original.bin"]')!
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, 'renamed.bin')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save')
    await act(async () => save?.click())

    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{
        kind: 'move',
        nodeId: 'file',
        parent: { nodeId: 'root' },
        name: 'renamed.bin',
      }],
    }))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Rename renamed.bin"]')?.click()
    })
    const folder = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Documents'))
    await act(async () => folder?.click())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Back to parent folder"]')?.click()
    })

    expect(container.querySelector('input[aria-label="Rename renamed.bin"]')).toBeNull()
  })

  it('refreshes accepted files after a stale mutation conflict', async () => {
    const getWorkspaceRevision = vi.fn<Overseer['getWorkspaceRevision']>()
      .mockResolvedValueOnce({ head: 'a'.repeat(40), rootId: 'root' })
      .mockResolvedValueOnce({ head: 'b'.repeat(40), rootId: 'root' })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([node({ id: 'accepted', name: 'accepted.txt' })])
    const overseer = {
      getWorkspaceRevision,
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      applyWorkspaceMutation: vi.fn<Overseer['applyWorkspaceMutation']>(async () => {
        throw createWorkspaceFileError(WORKSPACE_FILE_ERROR_CODES.conflict)
      }),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})
    const newFolder = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('New folder'))
    await act(async () => newFolder?.click())
    const input = container.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'Drafts')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const create = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Create')
    await act(async () => {
      create?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(getWorkspaceRevision).toHaveBeenCalledTimes(2)
    expect(listWorkspaceChildren).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('accepted.txt')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Workspace changed. Files refreshed; try again.',
    }))
  })
})
