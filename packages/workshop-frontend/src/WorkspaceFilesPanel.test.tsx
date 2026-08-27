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

const WORKSPACE_ID = 'workspace-test'

function revision(head: string) {
  return {
    workspaceId: WORKSPACE_ID,
    revision: { kind: 'accepted' as const, commit: head },
    head,
    rootId: 'root',
  }
}

function chatRevision(head: string) {
  return {
    workspaceId: WORKSPACE_ID,
    revision: { kind: 'chat' as const, chatId: 0, epoch: 0, commit: head },
    head,
    rootId: 'root',
  }
}

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
type SaveStreamToFile = typeof import('./fileTransfers').saveStreamToFile

vi.mock('./components/DeleteConfirmationDialog', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => (
    open ? <button onClick={onConfirm}>Confirm delete</button> : null
  ),
}))

const { saveStreamToFile } = vi.hoisted(() => ({
  saveStreamToFile: vi.fn<SaveStreamToFile>(),
}))
vi.mock('./fileTransfers', () => ({ saveStreamToFile }))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: React.ComponentProps<'button'> & { danger?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  WorkshopInput: (props: React.ComponentProps<'input'>) => <input {...props} />,
}))

vi.mock('./WorkspaceFileEditor', () => ({
  default: ({ node: file, onDownload }: {
    node: WorkspaceFileNode
    onDownload?: () => void
  }) => (
    <div data-testid="workspace-file-editor">
      Open {file.name}
      {onDownload && <button aria-label="Download open file" onClick={onDownload}>Download</button>}
    </div>
  ),
}))

import WorkspaceFilesPanel from './WorkspaceFilesPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toast.mockReset()
  saveStreamToFile.mockReset()
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
  it('keeps a deleted file open at its requested immutable revision', async () => {
    const current = 'a'.repeat(40)
    const historical = 'b'.repeat(40)
    const deletedFile = node({ id: 'file', name: 'deleted.txt', path: 'deleted.txt' })
    const getWorkspaceNode = vi.fn<Overseer['getWorkspaceNode']>(async request => {
      if (request.revision.commit === historical) return deletedFile
      throw createWorkspaceFileError(WORKSPACE_FILE_ERROR_CODES.invalidRequest)
    })
    const readWorkspaceFile = vi.fn<Overseer['readWorkspaceFile']>(async () => (
      new Blob(['historical content']).stream()
    ))
    const onSelectionChange = vi.fn<(
      nodeId: string | undefined,
      revision: string | undefined,
    ) => void>()
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision(current)),
      listWorkspaceChildren: vi.fn<Overseer['listWorkspaceChildren']>(async () => []),
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      getWorkspaceNode,
      readWorkspaceFile,
    } as unknown as RpcStub<Overseer>
    saveStreamToFile.mockImplementation(async read => { await read() })

    await act(async () => root.render(
      <WorkspaceFilesPanel
        overseer={overseer}
        selectedNodeId="file"
        selectedRevision={historical}
        onSelectionChange={onSelectionChange}
      />,
    ))
    await act(async () => {})

    expect(container.textContent).toContain('Open deleted.txt')
    expect(onSelectionChange).not.toHaveBeenCalled()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Download open file"]')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(readWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'file',
      revision: { kind: 'accepted', commit: historical },
    }))
  })

  it('reloads the same chat target after a command closes its pending fork', async () => {
    const initial = chatRevision('a'.repeat(40))
    const reset = chatRevision('b'.repeat(40))
    const target = { kind: 'chat' as const, chatId: 0, epoch: 0 }
    const file = node({ id: 'file', name: 'discarded.txt', path: 'discarded.txt' })
    const getWorkspaceRevision = vi.fn<Overseer['getWorkspaceRevision']>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(reset)
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([file])
      .mockResolvedValueOnce([])
    const getWorkspaceNode = vi.fn<Overseer['getWorkspaceNode']>(async request => {
      if (request.revision.commit === initial.head) return file
      throw createWorkspaceFileError(WORKSPACE_FILE_ERROR_CODES.invalidRequest)
    })
    const onSelectionChange = vi.fn<(
      nodeId: string | undefined,
      revision: string | undefined,
    ) => void>()
    const overseer = {
      getWorkspaceRevision,
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      getWorkspaceNode,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <WorkspaceFilesPanel
        overseer={overseer}
        target={target}
        selectedNodeId="file"
        refreshToken={0}
        onSelectionChange={onSelectionChange}
      />,
    ))
    await act(async () => {})
    expect(container.textContent).toContain('Open discarded.txt')

    await act(async () => root.render(
      <WorkspaceFilesPanel
        overseer={overseer}
        target={target}
        selectedNodeId="file"
        refreshToken={1}
        onSelectionChange={onSelectionChange}
      />,
    ))
    await act(async () => {})

    expect(getWorkspaceRevision).toHaveBeenCalledTimes(2)
    expect(listWorkspaceChildren).toHaveBeenNthCalledWith(2, expect.objectContaining({
      revision: expect.objectContaining({ commit: reset.head }),
    }))
    expect(container.textContent).toContain('This folder is empty.')
    expect(container.querySelector('[data-testid="workspace-file-editor"]')).toBeNull()
    expect(onSelectionChange).toHaveBeenCalledWith(undefined, undefined)
  })

  it('moves a file by dragging its stable node onto a folder', async () => {
    const documents = node({ id: 'docs', kind: 'folder', name: 'Documents', size: 0 })
    const report = node({ id: 'report', name: 'report.txt', path: 'report.txt' })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([documents, report])
      .mockResolvedValueOnce([documents])
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...revision('b'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision('a'.repeat(40))),
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})

    const values = new Map<string, string>()
    const dataTransfer = {
      files: [] as unknown as FileList,
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => values.set(type, value),
    }
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'))
    const reportRow = rows.find(row => row.textContent?.includes('report.txt'))!
    const documentsRow = rows.find(row => row.textContent?.includes('Documents'))!
    const dragStart = new Event('dragstart', { bubbles: true })
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    await act(async () => {
      reportRow.dispatchEvent(dragStart)
      documentsRow.dispatchEvent(drop)
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{
        kind: 'move',
        nodeId: 'report',
        parent: { nodeId: 'docs' },
        name: 'report.txt',
      }],
    }))
  })

  it('creates folders, downloads files, and deletes files through authoritative mutations', async () => {
    const documents = node({ id: 'docs', kind: 'folder', name: 'Documents', size: 0 })
    const report = node({ id: 'report', name: 'report.txt', mediaType: 'text/plain' })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([report])
      .mockResolvedValueOnce([documents, report])
      .mockResolvedValueOnce([documents])
    let mutation = 0
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => {
      mutation += 1
      const created: Record<string, string> = mutation === 1 ? { folder: 'docs' } : {}
      return {
        ...revision(String.fromCharCode(97 + mutation).repeat(40)),
        outcome: 'applied',
        operationId: request.operationId,
        target: request.target,
        created,
      }
    })
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision('a'.repeat(40))),
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async () => new Blob(['report']).stream()),
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'New folder')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'Documents')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Create')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(applyWorkspaceMutation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      changes: [{
        kind: 'createFolder',
        clientId: 'folder',
        parent: { nodeId: 'root' },
        name: 'Documents',
      }],
    }))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Download report.txt"]')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(saveStreamToFile).toHaveBeenCalledTimes(1)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Delete report.txt"]')?.click()
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Confirm delete')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(applyWorkspaceMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      changes: [{ kind: 'delete', nodeId: 'report', recursive: false }],
    }))
  })

  it('restores a stable file selection and creates an empty text file', async () => {
    const notes = node({
      id: 'notes',
      name: 'notes.md',
      path: 'notes.md',
      mediaType: 'text/markdown',
    })
    const created = node({ id: 'created', name: 'new.md', path: 'new.md' })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([notes])
      .mockResolvedValueOnce([notes, created])
    const stageWorkspaceFileUpload = vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => {
      expect(request.size).toBe(0)
      expect(await new Response(request.content).text()).toBe('')
      return {
        uploadId: '00000000-0000-4000-8000-000000000092',
        size: 0,
        mediaType: 'text/plain',
        expiresAt: new Date('2026-08-28T00:00:00.000Z'),
      }
    })
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...revision('b'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: { file: 'created' },
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision('a'.repeat(40))),
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async () => notes),
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      stageWorkspaceFileUpload,
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>
    const onSelectionChange = vi.fn<(
      nodeId: string | undefined,
      revision: string | undefined,
    ) => void>()

    await act(async () => root.render(
      <WorkspaceFilesPanel
        overseer={overseer}
        selectedNodeId="notes"
        onSelectionChange={onSelectionChange}
      />,
    ))
    await act(async () => {})

    expect(container.textContent).toContain('Open notes.md')
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'New file')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="New file name"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'new.md')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Create')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{
        kind: 'createFile',
        clientId: 'file',
        parent: { nodeId: 'root' },
        name: 'new.md',
        uploadId: '00000000-0000-4000-8000-000000000092',
      }],
    }))
    expect(onSelectionChange).toHaveBeenCalledWith('created', undefined)
  })

  it('navigates folders and uploads arbitrary files larger than one megabyte', async () => {
    const rootNodes = [
      node({ id: 'docs', kind: 'folder', name: 'Documents', path: 'Documents', size: 0 }),
      node({ id: 'archive-folder', kind: 'folder', name: 'Archive', path: 'Archive', size: 0 }),
    ]
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
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
      ...revision('b'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: { upload: 'archive' },
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(
        async () => revision('a'.repeat(40)),
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
    expect(listWorkspaceChildren).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      nodeId: 'docs',
    }))

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

  it('uploads dropped files into the folder receiving the drop', async () => {
    const documents = node({ id: 'docs', kind: 'folder', name: 'Documents', size: 0 })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([documents])
      .mockResolvedValueOnce([])
    const stageWorkspaceFileUpload = vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => ({
      uploadId: '00000000-0000-4000-8000-000000000094',
      size: request.size,
      mediaType: request.mediaType,
      expiresAt: new Date('2026-08-28T00:00:00.000Z'),
    }))
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...revision('b'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision('a'.repeat(40))),
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      stageWorkspaceFileUpload,
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})

    const values = new Map<string, string>()
    const file = new File(['contents'], 'dropped.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('contents'))
          controller.close()
        },
      }),
    })
    const dataTransfer = {
      files: [file] as unknown as FileList,
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => values.set(type, value),
    }
    const documentsRow = Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'))
      .find(row => row.textContent?.includes('Documents'))!
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    await act(async () => {
      documentsRow.dispatchEvent(drop)
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{
        kind: 'createFile',
        clientId: 'upload-0',
        parent: { nodeId: 'docs' },
        name: 'dropped.txt',
        uploadId: '00000000-0000-4000-8000-000000000094',
      }],
    }))
  })

  it('offers a retry when the initial workspace load fails', async () => {
    const getWorkspaceRevision = vi.fn<Overseer['getWorkspaceRevision']>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(revision('a'.repeat(40)))
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

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh workspace files"]')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(getWorkspaceRevision).toHaveBeenCalledTimes(3)
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
      ...revision('b'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(
        async () => revision('a'.repeat(40)),
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

  it('refreshes the selected file metadata after renaming it', async () => {
    const original = node({ id: 'file', name: 'notes.txt', path: 'notes.txt', mediaType: 'text/plain' })
    const renamed = node({ id: 'file', name: 'notes.ts', path: 'notes.ts', mediaType: 'text/typescript' })
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([renamed])
    const getWorkspaceNode = vi.fn<Overseer['getWorkspaceNode']>(async () => renamed)
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...revision('b'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision('a'.repeat(40))),
      getWorkspaceNode,
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent?.includes('notes.txt'))?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Rename notes.txt"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Rename notes.txt"]')!
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, 'notes.ts')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Save')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(getWorkspaceNode).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'file',
      revision: expect.objectContaining({ commit: 'b'.repeat(40) }),
    }))
    expect(container.textContent).toContain('Open notes.ts')
  })

  it('downloads the selected immutable revision', async () => {
    const selected = 'c'.repeat(40)
    const file = node({ id: 'file', name: 'notes.txt', mediaType: 'text/plain' })
    const readWorkspaceFile = vi.fn<Overseer['readWorkspaceFile']>(async () => (
      new ReadableStream({ start(controller) { controller.close() } })
    ))
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision('a'.repeat(40))),
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async () => file),
      listWorkspaceChildren: vi.fn<Overseer['listWorkspaceChildren']>(async () => [file]),
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      readWorkspaceFile,
    } as unknown as RpcStub<Overseer>
    saveStreamToFile.mockImplementation(async (
      read: () => Promise<ReadableStream<Uint8Array>>,
    ) => { await read() })

    await act(async () => root.render(
      <WorkspaceFilesPanel overseer={overseer} selectedNodeId="file" selectedRevision={selected} />,
    ))
    await act(async () => {})
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Download notes.txt"]')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(readWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'file',
      revision: { kind: 'accepted', commit: selected },
    }))
  })

  it('refreshes accepted files after a stale mutation conflict', async () => {
    const getWorkspaceRevision = vi.fn<Overseer['getWorkspaceRevision']>()
      .mockResolvedValueOnce(revision('a'.repeat(40)))
      .mockResolvedValueOnce(revision('b'.repeat(40)))
    const listWorkspaceChildren = vi.fn<Overseer['listWorkspaceChildren']>()
      .mockResolvedValueOnce([node({ id: 'file', name: 'original.txt' })])
      .mockResolvedValueOnce([node({ id: 'file', name: 'original.txt' })])
    const overseer = {
      getWorkspaceRevision,
      listWorkspaceChildren,
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => []),
      applyWorkspaceMutation: vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
        outcome: 'stale',
        operationId: request.operationId,
        target: request.target,
        expectedHead: request.expectedHead,
        currentHead: 'b'.repeat(40),
      })),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(<WorkspaceFilesPanel overseer={overseer} />))
    await act(async () => {})
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Rename original.txt"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Rename original.txt"]')!
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'draft.txt')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const rename = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save')
    await act(async () => {
      rename?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(getWorkspaceRevision).toHaveBeenCalledTimes(2)
    expect(listWorkspaceChildren).toHaveBeenCalledTimes(2)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Rename original.txt"]')?.value)
      .toBe('draft.txt')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Workspace changed. Files refreshed; try again.',
    }))
  })
})
