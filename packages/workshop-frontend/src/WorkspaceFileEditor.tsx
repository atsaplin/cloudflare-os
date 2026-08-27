import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RpcStub } from 'capnweb'
import {
  getWorkspaceFileErrorCode,
  WORKSPACE_FILE_ERROR_CODES,
} from '@gadgets/workshop-shared/api'
import type {
  CommitInfo,
  FileRef,
  Overseer,
  WorkspaceFileNode,
  WorkspaceFileRevision,
  WriteTarget,
} from '@gadgets/workshop-shared/api'
import CodeDiffEditor from './CodeDiffEditor'
import CodeEditor from './CodeEditor'
import { WorkshopButton } from './components/WorkshopControls'
import { classifyWorkspaceFile, type WorkspaceFileContent } from './workspaceFileContent'
import { filterWorkspaceFileHistory } from './workspaceFileHistory'

interface WorkspaceFileEditorProps {
  overseer: RpcStub<Overseer>
  target: WriteTarget
  revision: WorkspaceFileRevision
  node: WorkspaceFileNode
  history: CommitInfo[]
  selectedCommit?: string
  onRevisionChange(commit: string | undefined): void
  onSaved(revision: WorkspaceFileRevision): void
  onDirtyChange?(dirty: boolean): void
}

interface LoadedFile {
  node: WorkspaceFileNode
  bytes: Uint8Array
  content: WorkspaceFileContent
  parentText: string | null
  commit: string
}

interface SaveConflict {
  latestRevision: WorkspaceFileRevision
  latestText: string
}

type EditorMode = 'edit' | 'preview' | 'diff'

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

async function readBytes(overseer: RpcStub<Overseer>, reference: FileRef): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await overseer.readWorkspaceFile(reference)).arrayBuffer())
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function readTextIfPresent(
  overseer: RpcStub<Overseer>,
  revision: WorkspaceFileRevision,
  nodeId: string,
  commit: string | undefined,
): Promise<string | null> {
  if (!commit) return null
  const reference = referenceAt(revision, nodeId, commit)
  try {
    const node = await overseer.getWorkspaceNode(reference)
    const content = classifyWorkspaceFile(node, await readBytes(overseer, reference))
    return content.kind === 'text' ? content.text : null
  } catch (error) {
    if (getWorkspaceFileErrorCode(error) === WORKSPACE_FILE_ERROR_CODES.invalidRequest) return null
    throw error
  }
}

function useLoadedFile(
  overseer: RpcStub<Overseer>,
  revision: WorkspaceFileRevision,
  node: WorkspaceFileNode,
  history: CommitInfo[],
  selectedCommit: string | undefined,
): { loaded: LoadedFile | null; error: string | null } {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const commit = selectedCommit ?? revision.head

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    const reference = referenceAt(revision, node.id, commit)
    const selectedHistory = history.find(item => item.oid === commit)
    Promise.all([
      selectedCommit ? overseer.getWorkspaceNode(reference) : Promise.resolve(node),
      readBytes(overseer, reference),
      readTextIfPresent(overseer, revision, node.id, selectedHistory?.parents[0]),
    ]).then(([selectedNode, bytes, parentText]) => {
      if (cancelled) return
      setLoaded({
        node: selectedNode,
        bytes,
        content: classifyWorkspaceFile(selectedNode, bytes),
        parentText,
        commit,
      })
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open this file.')
    })
    return () => { cancelled = true }
  }, [commit, history, node, overseer, revision, selectedCommit])

  return { loaded, error }
}

function useObjectUrl(bytes: Uint8Array | undefined, mediaType: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bytes) {
      setUrl(null)
      return
    }
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const next = URL.createObjectURL(new Blob([buffer], { type: mediaType }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, mediaType])
  return url
}

function BinaryPreview({ loaded }: { loaded: LoadedFile }) {
  const url = useObjectUrl(loaded.bytes, loaded.node.mediaType)
  if (!url) return null
  if (loaded.content.kind !== 'binary') return null
  if (loaded.content.preview === 'image') {
    return <img src={url} alt={loaded.node.name} className="max-h-full max-w-full object-contain" />
  }
  if (loaded.content.preview === 'pdf') {
    return <iframe src={url} title={loaded.node.name} className="h-full w-full border-0" />
  }
  if (loaded.content.preview === 'audio') return <audio src={url} controls className="max-w-full" />
  if (loaded.content.preview === 'video') {
    return <video src={url} controls className="max-h-full max-w-full" />
  }
  return <p className="text-sm text-kumo-subtle">No browser preview is available for this file.</p>
}

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.mdx')
}

function FilePreview({ loaded }: { loaded: LoadedFile }) {
  if (loaded.content.kind === 'binary') return <BinaryPreview loaded={loaded} />
  if (!isMarkdown(loaded.node.name)) {
    return <CodeEditor filename={loaded.node.name} text={loaded.content.text} readOnly />
  }
  return (
    <article className="prose prose-sm max-w-none overflow-auto p-6 text-kumo-default">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{loaded.content.text}</ReactMarkdown>
    </article>
  )
}

function useFileHistory(
  overseer: RpcStub<Overseer>,
  revision: WorkspaceFileRevision,
  nodeId: string,
  workspaceHistory: CommitInfo[],
): { history: CommitInfo[]; loading: boolean; error: string | null } {
  const [history, setHistory] = useState<CommitInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    filterWorkspaceFileHistory(overseer, revision, nodeId, workspaceHistory)
      .then(nextHistory => { if (!cancelled) setHistory(nextHistory) })
      .catch(cause => {
        if (!cancelled) {
          setHistory([])
          setError(cause instanceof Error ? cause.message : 'Could not load file history.')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [nodeId, overseer, revision, workspaceHistory])
  return { history, loading, error }
}

function VersionHistory({
  history,
  loading,
  error,
  selectedCommit,
  dirty,
  onRevisionChange,
}: Pick<WorkspaceFileEditorProps, 'history' | 'selectedCommit' | 'onRevisionChange'> & {
  dirty: boolean
  loading: boolean
  error: string | null
}) {
  return (
    <details className="border-t border-kumo-line px-4 py-3">
      <summary className="cursor-pointer text-xs font-medium text-kumo-default">
        Version history ({history.length})
      </summary>
      <div className="mt-2 max-h-40 space-y-1 overflow-auto">
        {loading && <p className="text-xs text-kumo-subtle">Loading file history…</p>}
        {error && <p className="text-xs text-kumo-danger">{error}</p>}
        {dirty && (
          <p className="text-xs text-kumo-warning">Save or discard changes to view history.</p>
        )}
        {selectedCommit && (
          <button
            type="button"
            disabled={dirty}
            className="block text-xs text-kumo-brand disabled:cursor-default disabled:opacity-50"
            onClick={() => onRevisionChange(undefined)}
          >
            Return to current version
          </button>
        )}
        {history.map(commit => (
          <button
            key={commit.oid}
            type="button"
            disabled={dirty}
            className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-kumo-tint"
            aria-pressed={selectedCommit === commit.oid}
            onClick={() => onRevisionChange(commit.oid)}
          >
            <span className="block truncate font-medium text-kumo-default">
              {commit.message.split('\n', 1)[0] || 'Workspace update'}
            </span>
            <span className="text-kumo-subtle">
              {commit.author.name} · {commit.timestamp.toLocaleString()}
            </span>
          </button>
        ))}
      </div>
    </details>
  )
}

interface EditorToolbarProps {
  filename: string
  selectedCommit: string | undefined
  dirty: boolean
  textFile: boolean
  mode: EditorMode
  canPreview: boolean
  saving: boolean
  conflict: boolean
  onModeChange(mode: EditorMode): void
  onSave(): void
  onDiscard(): void
}

function EditorToolbar({
  filename,
  selectedCommit,
  dirty,
  textFile,
  mode,
  canPreview,
  saving,
  conflict,
  onModeChange,
  onSave,
  onDiscard,
}: EditorToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">{filename}</span>
      {selectedCommit && <span className="text-xs text-kumo-subtle">Historical revision</span>}
      {dirty && <span className="text-xs text-kumo-warning">Unsaved changes</span>}
      {textFile && (
        <>
          <WorkshopButton disabled={mode === 'edit'} onClick={() => onModeChange('edit')}>Edit</WorkshopButton>
          {canPreview && (
            <WorkshopButton disabled={mode === 'preview'} onClick={() => onModeChange('preview')}>
              Preview
            </WorkshopButton>
          )}
          <WorkshopButton disabled={mode === 'diff'} onClick={() => onModeChange('diff')}>Diff</WorkshopButton>
          {!selectedCommit && (
            <>
              <WorkshopButton
                tone="primary"
                disabled={!dirty || saving || conflict}
                onClick={onSave}
              >
                {saving ? 'Saving…' : 'Save'}
              </WorkshopButton>
              {dirty && <WorkshopButton disabled={saving} onClick={onDiscard}>Discard changes</WorkshopButton>}
            </>
          )}
        </>
      )}
    </div>
  )
}

export default function WorkspaceFileEditor({
  overseer,
  target,
  revision,
  node,
  history,
  selectedCommit,
  onRevisionChange,
  onSaved,
  onDirtyChange,
}: WorkspaceFileEditorProps) {
  const { loaded, error } = useLoadedFile(overseer, revision, node, history, selectedCommit)
  const fileHistory = useFileHistory(overseer, revision, node.id, history)
  const [buffer, setBuffer] = useState('')
  const [baseText, setBaseText] = useState('')
  const [baseHead, setBaseHead] = useState<string | null>(null)
  const [mode, setMode] = useState<EditorMode>(selectedCommit ? 'diff' : 'edit')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<SaveConflict | null>(null)
  const dirty = baseHead !== null && buffer !== baseText
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const editorIdentityRef = useRef<string | null>(null)

  useEffect(() => {
    if (loaded?.content.kind !== 'text') return
    const identity = `${loaded.node.id}:${selectedCommit ?? 'current'}`
    const preserveDirtyBuffer = editorIdentityRef.current === identity &&
      dirtyRef.current && selectedCommit === undefined
    editorIdentityRef.current = identity
    if (preserveDirtyBuffer) {
      if (loaded.content.text === baseText) {
        setBaseHead(loaded.commit)
      } else {
        setConflict({ latestRevision: revision, latestText: loaded.content.text })
        setMode('diff')
      }
      return
    }
    setBaseText(loaded.content.text)
    setBuffer(loaded.content.text)
    setBaseHead(loaded.commit)
    setConflict(null)
    setMode(selectedCommit ? 'diff' : 'edit')
  }, [baseText, loaded, revision, selectedCommit])

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  const save = useCallback(async (): Promise<void> => {
    if (!dirty || !baseHead || saving || conflict ||
        loaded?.content.kind !== 'text' || selectedCommit) return
    setSaving(true)
    setSaveError(null)
    try {
      const bytes = new TextEncoder().encode(buffer)
      const upload = await overseer.stageWorkspaceFileUpload({
        content: byteStream(bytes),
        size: bytes.byteLength,
        ...(loaded.node.mediaType ? { mediaType: loaded.node.mediaType } : {}),
      })
      const result = await overseer.applyWorkspaceMutation({
        operationId: crypto.randomUUID(),
        expectedHead: baseHead,
        target,
        message: `Edit ${loaded.node.path}`,
        changes: [{ kind: 'replaceFile', nodeId: loaded.node.id, uploadId: upload.uploadId }],
      })
      if (result.outcome === 'applied') {
        setBaseText(buffer)
        setBaseHead(result.head)
        onSaved(result)
        return
      }
      const latestRevision = await overseer.getWorkspaceRevision(target)
      const reference = referenceAt(latestRevision, loaded.node.id, latestRevision.head)
      const latestNode = await overseer.getWorkspaceNode(reference)
      const latestContent = classifyWorkspaceFile(latestNode, await readBytes(overseer, reference))
      if (latestContent.kind !== 'text') throw new Error('The latest file is no longer text.')
      setConflict({ latestRevision, latestText: latestContent.text })
      setMode('diff')
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not save this file.')
    } finally {
      setSaving(false)
    }
  }, [baseHead, buffer, conflict, dirty, loaded, onSaved, overseer, saving, selectedCommit, target])

  const reloadConflict = (): void => {
    if (!conflict) return
    setBaseText(conflict.latestText)
    setBuffer(conflict.latestText)
    setBaseHead(conflict.latestRevision.head)
    setConflict(null)
    setMode('edit')
    onSaved(conflict.latestRevision)
  }

  const discardChanges = (): void => {
    if (!dirty || selectedCommit) return
    setBuffer(baseText)
    setConflict(null)
    setSaveError(null)
    setMode('edit')
  }

  const diffOriginal = conflict?.latestText ?? loaded?.parentText ?? null
  const canPreview = loaded?.content.kind === 'binary' || isMarkdown(loaded?.node.name ?? '')

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-kumo-danger">{error}</p>
        {selectedCommit && (
          <WorkshopButton onClick={() => onRevisionChange(undefined)}>Return to current version</WorkshopButton>
        )}
      </div>
    )
  }
  if (!loaded) return <div className="p-6 text-sm text-kumo-subtle">Opening file…</div>

  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <EditorToolbar
        filename={loaded.node.name}
        selectedCommit={selectedCommit}
        dirty={dirty}
        textFile={loaded.content.kind === 'text'}
        mode={mode}
        canPreview={canPreview}
        saving={saving}
        conflict={conflict !== null}
        onModeChange={setMode}
        onSave={() => void save()}
        onDiscard={discardChanges}
      />

      {conflict && (
        <div className="flex items-center gap-3 border-b border-kumo-line bg-kumo-warning/10 px-4 py-2 text-xs text-kumo-default">
          <span className="flex-1">Workspace changed before this file was saved.</span>
          <WorkshopButton onClick={() => setMode(mode === 'diff' ? 'edit' : 'diff')}>
            {mode === 'diff' ? 'Keep editing' : 'Compare latest'}
          </WorkshopButton>
          <WorkshopButton onClick={reloadConflict}>Reload latest</WorkshopButton>
        </div>
      )}
      {saveError && <div className="border-b border-kumo-line px-4 py-2 text-xs text-kumo-danger">{saveError}</div>}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loaded.content.kind === 'binary' ? (
          <div className="flex h-full items-center justify-center overflow-auto p-6">
            <BinaryPreview loaded={loaded} />
          </div>
        ) : mode === 'preview' ? (
          <FilePreview loaded={{ ...loaded, content: { kind: 'text', text: buffer } }} />
        ) : mode === 'diff' ? (
          <CodeDiffEditor
            filename={loaded.node.name}
            original={diffOriginal}
            text={selectedCommit ? loaded.content.text : buffer}
            readOnly
          />
        ) : (
          <CodeEditor
            filename={loaded.node.name}
            text={buffer}
            onTextChange={selectedCommit ? undefined : setBuffer}
            onSave={selectedCommit ? undefined : () => void save()}
            readOnly={selectedCommit !== undefined}
          />
        )}
      </div>

      <VersionHistory
        history={fileHistory.history}
        loading={fileHistory.loading}
        error={fileHistory.error}
        selectedCommit={selectedCommit}
        dirty={dirty}
        onRevisionChange={onRevisionChange}
      />
    </div>
  )
}
