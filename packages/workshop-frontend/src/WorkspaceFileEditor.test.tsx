// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  CommitInfo,
  Overseer,
  WorkspaceFileNode,
  WorkspaceFileRevision,
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
}))

import WorkspaceFileEditor from './WorkspaceFileEditor'

const WORKSPACE_ID = 'workspace-test'
const initial = workspaceRevision('a'.repeat(40))

function workspaceRevision(head: string): WorkspaceFileRevision {
  return {
    workspaceId: WORKSPACE_ID,
    revision: { kind: 'accepted', commit: head },
    head,
    rootId: 'root',
  }
}

function fileNode(overrides: Partial<WorkspaceFileNode> = {}): WorkspaceFileNode {
  return {
    id: 'file',
    parentId: 'root',
    kind: 'file',
    name: 'notes.md',
    path: 'notes.md',
    size: 5,
    mediaType: 'text/markdown',
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    createdBy: 'aleksey',
    updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    updatedBy: 'aleksey',
    ...overrides,
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

describe('WorkspaceFileEditor', () => {
  it('renders Markdown as a derived preview without another editor', async () => {
    const overseer = {
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async () => stream('# Heading')),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <WorkspaceFileEditor
        overseer={overseer}
        target={{ kind: 'accepted' }}
        revision={initial}
        node={fileNode({ size: 9 })}
        history={[]}
        onRevisionChange={() => {}}
        onSaved={() => {}}
      />,
    ))
    await act(async () => {})
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Preview')?.click()
    })

    expect(container.querySelector('h1')?.textContent).toBe('Heading')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('uses an object URL image viewer for binary image bytes', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const bytes = new Uint8Array([137, 80, 78, 71])
    const overseer = {
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async () => new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <WorkspaceFileEditor
        overseer={overseer}
        target={{ kind: 'accepted' }}
        revision={initial}
        node={fileNode({ name: 'image.png', path: 'image.png', mediaType: 'image/png' })}
        history={[]}
        onRevisionChange={() => {}}
        onSaved={() => {}}
      />,
    ))
    await act(async () => {})

    expect(container.querySelector<HTMLImageElement>('img[alt="image.png"]')?.src).toBe('blob:image')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image')
    root = createRoot(container)
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  it('loads text into CodeEditor and saves an explicit replace mutation', async () => {
    const stageWorkspaceFileUpload = vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => {
      expect(await new Response(request.content).text()).toBe('after')
      return {
        uploadId: '00000000-0000-4000-8000-000000000090',
        size: request.size,
        mediaType: request.mediaType,
        expiresAt: new Date('2026-08-28T00:00:00.000Z'),
      }
    })
    const saved = workspaceRevision('b'.repeat(40))
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...saved,
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    const overseer = {
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async () => stream('before')),
      stageWorkspaceFileUpload,
      applyWorkspaceMutation,
    } as unknown as RpcStub<Overseer>
    const onSaved = vi.fn<(revision: WorkspaceFileRevision) => void>()

    await act(async () => root.render(
      <WorkspaceFileEditor
        overseer={overseer}
        target={{ kind: 'accepted' }}
        revision={initial}
        node={fileNode()}
        history={[]}
        onRevisionChange={() => {}}
        onSaved={onSaved}
      />,
    ))
    await act(async () => {})

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.md"]')!
    expect(editor.value).toBe('before')
    await act(async () => setInputValue(editor, 'after'))
    expect(container.textContent).toContain('Unsaved changes')

    const save = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save')
    await act(async () => {
      save?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(stageWorkspaceFileUpload).toHaveBeenCalledWith(expect.objectContaining({
      size: 5,
      mediaType: 'text/markdown',
    }))
    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      expectedHead: initial.head,
      target: { kind: 'accepted' },
      changes: [{
        kind: 'replaceFile',
        nodeId: 'file',
        uploadId: '00000000-0000-4000-8000-000000000090',
      }],
    }))
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining(saved))
    expect(container.textContent).not.toContain('Unsaved changes')
  })

  it('preserves the local buffer and exposes the latest text after a stale save', async () => {
    const latest = workspaceRevision('b'.repeat(40))
    const readWorkspaceFile = vi.fn<Overseer['readWorkspaceFile']>()
      .mockResolvedValueOnce(stream('before'))
      .mockResolvedValueOnce(stream('remote'))
    const overseer = {
      readWorkspaceFile,
      stageWorkspaceFileUpload: vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => ({
        uploadId: '00000000-0000-4000-8000-000000000091',
        size: request.size,
        mediaType: request.mediaType,
        expiresAt: new Date('2026-08-28T00:00:00.000Z'),
      })),
      applyWorkspaceMutation: vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
        outcome: 'stale',
        operationId: request.operationId,
        target: request.target,
        expectedHead: request.expectedHead,
        currentHead: latest.head,
      })),
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => latest),
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async () => fileNode({ size: 6 })),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <WorkspaceFileEditor
        overseer={overseer}
        target={{ kind: 'accepted' }}
        revision={initial}
        node={fileNode()}
        history={[]}
        onRevisionChange={() => {}}
        onSaved={() => {}}
      />,
    ))
    await act(async () => {})
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.md"]')!
    await act(async () => setInputValue(editor, 'local'))
    const save = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save')
    await act(async () => {
      save?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Workspace changed before this file was saved.')
    expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe('remote|local')
    expect(container.textContent).toContain('Unsaved changes')
  })

  it('keeps a dirty buffer and safely rebases it when an unrelated mutation advances the workspace', async () => {
    const advanced = workspaceRevision('b'.repeat(40))
    const readWorkspaceFile = vi.fn<Overseer['readWorkspaceFile']>()
      .mockResolvedValueOnce(stream('before'))
      .mockResolvedValueOnce(stream('before'))
      .mockResolvedValueOnce(stream('before'))
    const applyWorkspaceMutation = vi.fn<Overseer['applyWorkspaceMutation']>(async request => ({
      ...workspaceRevision('c'.repeat(40)),
      outcome: 'applied',
      operationId: request.operationId,
      target: request.target,
      created: {},
    }))
    const overseer = {
      readWorkspaceFile,
      stageWorkspaceFileUpload: vi.fn<Overseer['stageWorkspaceFileUpload']>(async request => ({
        uploadId: '00000000-0000-4000-8000-000000000093',
        size: request.size,
        mediaType: request.mediaType,
        expiresAt: new Date('2026-08-28T00:00:00.000Z'),
      })),
      applyWorkspaceMutation,
      getWorkspaceRevision: vi.fn<Overseer['getWorkspaceRevision']>(async () => advanced),
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async () => fileNode()),
    } as unknown as RpcStub<Overseer>
    const props = {
      overseer,
      target: { kind: 'accepted' as const },
      node: fileNode(),
      history: [] as CommitInfo[],
      onRevisionChange: () => {},
      onSaved: () => {},
    }

    await act(async () => root.render(<WorkspaceFileEditor {...props} revision={initial} />))
    await act(async () => {})
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.md"]')!
    await act(async () => setInputValue(editor, 'local'))

    await act(async () => root.render(<WorkspaceFileEditor {...props} revision={advanced} />))
    await act(async () => {})
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.md"]')?.value)
      .toBe('local')

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Save')?.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(applyWorkspaceMutation).toHaveBeenCalledWith(expect.objectContaining({
      expectedHead: advanced.head,
    }))
  })

  it('shows an immutable revision diff against its parent', async () => {
    const parent = '1'.repeat(40)
    const selected = '2'.repeat(40)
    const history: CommitInfo[] = [{
      oid: selected,
      parents: [parent],
      message: 'Edit notes\n',
      author: { name: 'Aleksey', email: 'aleksey@localhost' },
      timestamp: new Date('2026-08-27T01:00:00.000Z'),
    }]
    const overseer = {
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async reference => fileNode({
        size: reference.revision.commit === selected ? 3 : 3,
      })),
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async reference => (
        stream(reference.revision.commit === selected ? 'new' : 'old')
      )),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <WorkspaceFileEditor
        overseer={overseer}
        target={{ kind: 'accepted' }}
        revision={initial}
        node={fileNode()}
        history={history}
        selectedCommit={selected}
        onRevisionChange={() => {}}
        onSaved={() => {}}
      />,
    ))
    await act(async () => {})

    expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe('old|new')
    expect(container.textContent).toContain('Historical revision')
    expect(container.textContent).not.toContain('Save')
  })

  it('keeps dirty edits out of history until explicitly discarded', async () => {
    const selected = '2'.repeat(40)
    const history: CommitInfo[] = [{
      oid: selected,
      parents: ['1'.repeat(40)],
      message: 'Earlier edit',
      author: { name: 'Aleksey', email: 'aleksey@localhost' },
      timestamp: new Date('2026-08-27T01:00:00.000Z'),
    }]
    const onRevisionChange = vi.fn<(commit: string | undefined) => void>()
    const overseer = {
      readWorkspaceFile: vi.fn<Overseer['readWorkspaceFile']>(async reference => (
        stream(reference.revision.commit === selected ? 'historical' : 'current')
      )),
      getWorkspaceNode: vi.fn<Overseer['getWorkspaceNode']>(async reference => fileNode({
        updatedAt: new Date(reference.revision.commit === selected
          ? '2026-08-27T01:00:00.000Z'
          : '2026-08-27T00:00:00.000Z'),
      })),
    } as unknown as RpcStub<Overseer>

    await act(async () => root.render(
      <WorkspaceFileEditor
        overseer={overseer}
        target={{ kind: 'accepted' }}
        revision={initial}
        node={fileNode({ name: 'notes.txt', mediaType: 'text/plain' })}
        history={history}
        onRevisionChange={onRevisionChange}
        onSaved={() => {}}
      />,
    ))
    await act(async () => {})
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.txt"]')!
    await act(async () => setInputValue(editor, 'local edit'))

    const historyButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Earlier edit'))!
    expect(historyButton.disabled).toBe(true)
    expect(container.textContent).toContain('Save or discard changes to view history.')
    expect(onRevisionChange).not.toHaveBeenCalled()

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Discard changes')?.click()
    })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Edit notes.txt"]')?.value)
      .toBe('current')
    expect(historyButton.disabled).toBe(false)

    await act(async () => historyButton.click())
    expect(onRevisionChange).toHaveBeenCalledWith(selected)
  })
})
