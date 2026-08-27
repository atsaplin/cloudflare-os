// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createWorkspaceFileError,
  WORKSPACE_FILE_ERROR_CODES,
  type CommitInfo,
  type Overseer,
  type WorkspaceFileNode,
  type WorkspaceFileRevision,
} from '@gadgets/workshop-shared/api'

vi.mock('./CodeEditor', () => ({
  default: ({
    filename,
    text,
    onTextChange,
  }: {
    filename: string | null
    text?: string | null
    onTextChange?: (text: string) => void
  }) => (
    <textarea
      aria-label={filename ? `Edit ${filename}` : 'No file'}
      value={text ?? ''}
      readOnly={!onTextChange}
      onChange={event => onTextChange?.(event.target.value)}
    />
  ),
}))

vi.mock('./CodeDiffEditor', () => ({
  default: ({ original, text }: { original: string | null; text?: string | null }) => (
    <div data-testid="diff">{original ?? '<missing>'}|{text ?? '<missing>'}</div>
  ),
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

vi.mock('./components/DeleteConfirmationDialog', () => ({
  default: () => null,
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<(value: unknown) => void>() }),
}))

import WorkspaceFilesPanel from './WorkspaceFilesPanel'

const WORKSPACE_ID = 'workspace-test'
const BASELINE = '0'.repeat(40)
const CREATED = 'a'.repeat(40)
const SAVED = 'b'.repeat(40)

function revision(head: string): WorkspaceFileRevision {
  return {
    workspaceId: WORKSPACE_ID,
    revision: { kind: 'chat', chatId: 0, epoch: 0, commit: head },
    head,
    rootId: 'root',
  }
}

function node(commit: string): WorkspaceFileNode {
  return {
    id: 'file',
    parentId: 'root',
    kind: 'file',
    name: 'notes.md',
    path: 'notes.md',
    size: commit === SAVED ? 5 : 6,
    mediaType: 'text/markdown',
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    createdBy: 'aleksey',
    updatedAt: new Date(commit === SAVED ? '2026-08-27T01:00:00.000Z' : '2026-08-27T00:00:00.000Z'),
    updatedBy: 'aleksey',
  }
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function setInputValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('WorkspaceFilesPanel chat-target save', () => {
  it('keeps a chat-created file open while concurrent refreshes observe its new revision', async () => {
    const creation: CommitInfo = {
      oid: CREATED,
      parents: [BASELINE],
      message: 'Create notes.md',
      author: { name: 'Aleksey', email: 'aleksey@localhost' },
      timestamp: new Date('2026-08-27T00:00:00.000Z'),
    }
    const edit: CommitInfo = {
      oid: SAVED,
      parents: [CREATED],
      message: 'Edit notes.md',
      author: { name: 'Aleksey', email: 'aleksey@localhost' },
      timestamp: new Date('2026-08-27T01:00:00.000Z'),
    }
    const getWorkspaceNode = vi.fn<Overseer['getWorkspaceNode']>(async reference => {
      if (reference.revision.commit === BASELINE) {
        throw createWorkspaceFileError(WORKSPACE_FILE_ERROR_CODES.invalidRequest)
      }
      if (reference.revision.commit === CREATED || reference.revision.commit === SAVED) {
        return node(reference.revision.commit)
      }
      throw new Error(`Unexpected node revision ${reference.revision.commit}`)
    })
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...revision(SAVED),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    let releaseSavedRead: ((value: ReadableStream<Uint8Array>) => void) | undefined
    const savedRead = new Promise<ReadableStream<Uint8Array>>(resolve => {
      releaseSavedRead = resolve
    })
    const overseer = {
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => revision(CREATED)),
      getWorkspaceHistory: vi.fn<Overseer['getWorkspaceHistory']>(async () => [edit, creation]),
      listWorkspaceChildren: vi.fn<Overseer['listWorkspaceChildren']>(async () => [node(CREATED)]),
      getWorkspaceNode,
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async reference => (
        reference.revision.commit === SAVED ? savedRead : stream('before')
      )),
      stageWorkspaceFileUpload: vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => ({
        uploadId: '00000000-0000-4000-8000-000000000096',
        size: request.size,
        mediaType: request.mediaType,
        expiresAt: new Date('2026-08-28T00:00:00.000Z'),
      })),
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <StrictMode>
        <WorkspaceFilesPanel
          overseer={overseer}
          target={{ kind: 'chat', chatId: 0, epoch: 0 }}
          selectedNodeId="file"
        />
      </StrictMode>,
    ))
    await act(async () => {})

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.md"]')
    expect(editor?.value).toBe('before')
    await act(async () => setInputValue(editor!, 'after'))
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Save')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    await act(async () => {})

    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'chat', chatId: 0, epoch: 0 },
      expectedHead: CREATED,
    }))
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.md"]')?.value)
      .toBe('after')
    expect(container.textContent).not.toContain('Opening file…')
    expect(getWorkspaceNode).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'file',
      revision: expect.objectContaining({
        kind: 'chat',
        chatId: 0,
        epoch: 0,
        commit: SAVED,
      }),
    }))
    releaseSavedRead?.(stream('after'))
    await act(async () => {})
  })
})
