import { useCallback, useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowLeft,
  ArrowRight,
  DownloadSimple,
  File,
  Folder,
  FolderPlus,
  Pencil,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import {
  getWorkspaceFileErrorCode,
  MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES,
  WORKSPACE_FILE_ERROR_CODES,
  type CommitInfo,
  type Overseer,
  type WorkspaceFileMutation,
  type WorkspaceFileNode,
  type WorkspaceFileRevision,
} from '@gadgets/workshop-shared/api'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { saveStreamToFile } from './fileTransfers'
import { reportIssue } from './errorReporting'

interface WorkspaceFilesPanelProps {
  overseer: RpcStub<Overseer>
}

interface FolderLocation {
  id: string
  name: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function extensionFor(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot) : '.bin'
}

function historySummary(message: string): string {
  return message.split('\n', 1)[0].trim() || 'Workspace update'
}

export default function WorkspaceFilesPanel({ overseer }: WorkspaceFilesPanelProps) {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [revision, setRevision] = useState<WorkspaceFileRevision | null>(null)
  const [folders, setFolders] = useState<FolderLocation[]>([])
  const [nodes, setNodes] = useState<WorkspaceFileNode[]>([])
  const [history, setHistory] = useState<CommitInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [renaming, setRenaming] = useState<WorkspaceFileNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moving, setMoving] = useState<WorkspaceFileNode | null>(null)
  const [deleting, setDeleting] = useState<WorkspaceFileNode | null>(null)

  const currentFolderId = folders.at(-1)?.id ?? revision?.rootId

  const loadFolder = useCallback(async (folderId: string): Promise<void> => {
    setNodes(await overseer.listWorkspaceChildren(folderId))
  }, [overseer])

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistory(await overseer.getWorkspaceHistory(20))
  }, [overseer])

  const refreshAcceptedWorkspace = useCallback(async (): Promise<void> => {
    const [nextRevision, nextHistory] = await Promise.all([
      overseer.getWorkspaceRevision(),
      overseer.getWorkspaceHistory(20),
    ])
    const requestedFolderId = currentFolderId ?? nextRevision.rootId
    try {
      const nextNodes = await overseer.listWorkspaceChildren(requestedFolderId)
      setRevision(nextRevision)
      setNodes(nextNodes)
      setHistory(nextHistory)
    } catch (error) {
      if (requestedFolderId === nextRevision.rootId) throw error
      const nextNodes = await overseer.listWorkspaceChildren(nextRevision.rootId)
      setRevision(nextRevision)
      setFolders([{ id: nextRevision.rootId, name: 'Files' }])
      setNodes(nextNodes)
      setHistory(nextHistory)
    }
  }, [currentFolderId, overseer])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    Promise.all([overseer.getWorkspaceRevision(), overseer.getWorkspaceHistory(20)])
      .then(async ([nextRevision, nextHistory]) => {
        const nextNodes = await overseer.listWorkspaceChildren(nextRevision.rootId)
        if (cancelled) return
        setRevision(nextRevision)
        setFolders([{ id: nextRevision.rootId, name: 'Files' }])
        setNodes(nextNodes)
        setHistory(nextHistory)
      })
      .catch(error => {
        if (!cancelled) {
          reportIssue('workspace-files.load', error)
          setLoadFailed(true)
          toastsRef.current.add({ title: 'Could not load workspace files.', variant: 'error' })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [loadAttempt, overseer])

  const applyMutation = useCallback(async (
    message: string,
    changes: WorkspaceFileMutation[],
  ): Promise<void> => {
    if (!revision || !currentFolderId) return
    const result = await overseer.applyWorkspaceMutation({
      operationId: crypto.randomUUID(),
      expectedHead: revision.head,
      message,
      changes,
    })
    setRevision({ head: result.head, rootId: result.rootId })
    await Promise.all([loadFolder(currentFolderId), refreshHistory()])
  }, [currentFolderId, loadFolder, overseer, refreshHistory, revision])

  const runMutation = useCallback(async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } catch (error) {
      reportIssue('workspace-files.mutate', error)
      if (getWorkspaceFileErrorCode(error) === WORKSPACE_FILE_ERROR_CODES.conflict) {
        try {
          await refreshAcceptedWorkspace()
          toastsRef.current.add({
            title: 'Workspace changed. Files refreshed; try again.',
            variant: 'error',
          })
          return
        } catch (refreshError) {
          reportIssue('workspace-files.conflict-refresh', refreshError)
        }
      }
      toastsRef.current.add({
        title: error instanceof Error ? error.message : 'File operation failed.',
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }, [refreshAcceptedWorkspace])

  const uploadFiles = (files: FileList | File[]): void => {
    void runMutation(async () => {
      if (!currentFolderId) return
      const selected = Array.from(files)
      const totalSize = selected.reduce((sum, file) => sum + file.size, 0)
      if (totalSize > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
        throw new Error('Selected files exceed the 25 MB operation limit.')
      }
      const selectedNames = new Set<string>()
      const existingByName = new Map(nodes.map(node => [node.name, node]))
      const changes: WorkspaceFileMutation[] = []
      for (const [index, file] of selected.entries()) {
        if (selectedNames.has(file.name)) {
          throw new Error(`More than one selected file is named ${file.name}.`)
        }
        selectedNames.add(file.name)
        const existing = existingByName.get(file.name)
        if (existing?.kind === 'folder') {
          throw new Error(`A folder named ${file.name} already exists.`)
        }
        const upload = await overseer.stageWorkspaceFileUpload({
          content: file.stream(),
          size: file.size,
          ...(file.type ? { mediaType: file.type } : {}),
        })
        changes.push(existing ? {
          kind: 'replaceFile',
          nodeId: existing.id,
          uploadId: upload.uploadId,
        } : {
          kind: 'createFile',
          clientId: `upload-${index}`,
          parent: { nodeId: currentFolderId },
          name: file.name,
          uploadId: upload.uploadId,
        })
      }
      if (changes.length > 0) {
        const message = changes.length === 1
          ? `Add ${selected[0].name}`
          : `Add ${changes.length} files`
        await applyMutation(message, changes)
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    })
  }

  const createFolder = (): void => {
    const name = newFolderName.trim()
    if (!name || !currentFolderId) return
    void runMutation(async () => {
      await applyMutation(`Create ${name}`, [{
        kind: 'createFolder',
        clientId: 'folder',
        parent: { nodeId: currentFolderId },
        name,
      }])
      setNewFolderName('')
      setCreatingFolder(false)
    })
  }

  const renameNode = (): void => {
    const name = renameValue.trim()
    if (!renaming || !name || !currentFolderId) return
    if (name === renaming.name) {
      setRenaming(null)
      return
    }
    void runMutation(async () => {
      await applyMutation(`Rename ${renaming.name} to ${name}`, [{
        kind: 'move',
        nodeId: renaming.id,
        parent: { nodeId: currentFolderId },
        name,
      }])
      setRenaming(null)
    })
  }

  const deleteNode = (): void => {
    if (!deleting) return
    void runMutation(async () => {
      await applyMutation(`Delete ${deleting.name}`, [{
        kind: 'delete',
        nodeId: deleting.id,
        recursive: deleting.kind === 'folder',
      }])
      setDeleting(null)
    })
  }

  const moveNode = (): void => {
    if (!moving || !currentFolderId || moving.parentId === currentFolderId) return
    void runMutation(async () => {
      await applyMutation(`Move ${moving.name}`, [{
        kind: 'move',
        nodeId: moving.id,
        parent: { nodeId: currentFolderId },
        name: moving.name,
      }])
      setMoving(null)
    })
  }

  const openFolder = (folder: WorkspaceFileNode): void => {
    if (folder.kind !== 'folder') return
    void runMutation(async () => {
      await loadFolder(folder.id)
      setRenaming(null)
      setRenameValue('')
      setFolders(current => [...current, { id: folder.id, name: folder.name }])
    })
  }

  const goBack = (): void => {
    if (folders.length <= 1) return
    const parent = folders[folders.length - 2]
    void runMutation(async () => {
      await loadFolder(parent.id)
      setRenaming(null)
      setRenameValue('')
      setFolders(current => current.slice(0, -1))
    })
  }

  const downloadFile = (file: WorkspaceFileNode): void => {
    void runMutation(() => saveStreamToFile(
      () => overseer.readWorkspaceFile(file.id),
      file.name,
      {
        description: file.name,
        contentType: file.mediaType ?? 'application/octet-stream',
        extension: extensionFor(file.name),
      },
    ))
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">Loading files…</div>
  }

  if (loadFailed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-kumo-default">Could not load workspace files.</p>
        <WorkshopButton onClick={() => setLoadAttempt(current => current + 1)}>Retry</WorkshopButton>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <div className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-4 py-3">
        <WorkshopIconButton
          aria-label="Back to parent folder"
          disabled={folders.length <= 1 || busy}
          onClick={goBack}
        >
          <ArrowLeft size={16} />
        </WorkshopIconButton>
        <div className="min-w-0 flex-1 truncate text-[13px] text-kumo-subtle">
          {folders.map(folder => folder.name).join(' / ')}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={event => {
            if (event.target.files) uploadFiles(event.target.files)
          }}
        />
        <WorkshopButton disabled={busy} onClick={() => fileInputRef.current?.click()}>
          <UploadSimple size={15} />
          Upload
        </WorkshopButton>
        <WorkshopButton disabled={busy} onClick={() => setCreatingFolder(true)}>
          <FolderPlus size={15} />
          New folder
        </WorkshopButton>
      </div>

      {creatingFolder && (
        <div className="flex items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
          <WorkshopInput
            autoFocus
            aria-label="New folder name"
            value={newFolderName}
            onChange={event => setNewFolderName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') createFolder()
              if (event.key === 'Escape') setCreatingFolder(false)
            }}
          />
          <WorkshopButton tone="primary" disabled={!newFolderName.trim() || busy} onClick={createFolder}>
            Create
          </WorkshopButton>
          <WorkshopButton disabled={busy} onClick={() => setCreatingFolder(false)}>Cancel</WorkshopButton>
        </div>
      )}

      {moving && (
        <div className="flex flex-wrap items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] text-kumo-subtle">
            Choose a destination for <span className="font-medium text-kumo-default">{moving.name}</span>.
          </span>
          <WorkshopButton
            tone="primary"
            disabled={busy || moving.parentId === currentFolderId}
            onClick={moveNode}
          >
            Move {moving.name} here
          </WorkshopButton>
          <WorkshopButton disabled={busy} onClick={() => setMoving(null)}>Cancel</WorkshopButton>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Folder size={32} className="text-kumo-inactive" />
            <p className="text-sm text-kumo-default">This folder is empty.</p>
            <p className="text-xs text-kumo-subtle">Upload any file type, up to 25 MB at a time.</p>
          </div>
        ) : (
          <div role="list" aria-label="Workspace files" className="divide-y divide-kumo-line">
            {nodes.map(node => (
              <div key={node.id} role="listitem" className="group flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-kumo-tint/40">
                {renaming?.id === node.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {node.kind === 'folder'
                      ? <Folder size={19} className="shrink-0 text-kumo-brand" weight="fill" />
                      : <File size={19} className="shrink-0 text-kumo-subtle" />}
                    <div className="min-w-0 flex-1">
                      <WorkshopInput
                        autoFocus
                        aria-label={`Rename ${node.name}`}
                        value={renameValue}
                        onChange={event => setRenameValue(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') renameNode()
                          if (event.key === 'Escape') setRenaming(null)
                        }}
                      />
                      <span className="block truncate text-[11px] text-kumo-inactive">
                        {node.kind === 'file' ? `${formatBytes(node.size)} · ` : ''}
                        Modified by {node.updatedBy}
                      </span>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy || node.kind !== 'folder'}
                    onClick={() => openFolder(node)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                  >
                    {node.kind === 'folder'
                      ? <Folder size={19} className="shrink-0 text-kumo-brand" weight="fill" />
                      : <File size={19} className="shrink-0 text-kumo-subtle" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-kumo-default">{node.name}</span>
                      <span className="block truncate text-[11px] text-kumo-inactive">
                        {node.kind === 'file' ? `${formatBytes(node.size)} · ` : ''}
                        Modified by {node.updatedBy}
                      </span>
                    </span>
                  </button>
                )}
                {renaming?.id === node.id ? (
                  <WorkshopButton
                    disabled={busy || !renameValue.trim() || renameValue.trim() === renaming.name}
                    onClick={renameNode}
                  >
                    Save
                  </WorkshopButton>
                ) : (
                  <>
                    {node.kind === 'file' && (
                      <WorkshopIconButton aria-label={`Download ${node.name}`} disabled={busy} onClick={() => downloadFile(node)}>
                        <DownloadSimple size={16} />
                      </WorkshopIconButton>
                    )}
                    <WorkshopIconButton
                      aria-label={`Rename ${node.name}`}
                      disabled={busy}
                      onClick={() => { setRenaming(node); setRenameValue(node.name) }}
                    >
                      <Pencil size={16} />
                    </WorkshopIconButton>
                    <WorkshopIconButton
                      aria-label={`Move ${node.name}`}
                      disabled={busy}
                      onClick={() => setMoving(node)}
                    >
                      <ArrowRight size={16} />
                    </WorkshopIconButton>
                    <WorkshopIconButton aria-label={`Delete ${node.name}`} danger disabled={busy} onClick={() => setDeleting(node)}>
                      <Trash size={16} />
                    </WorkshopIconButton>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <details className="shrink-0 border-t border-kumo-line px-4 py-3">
        <summary className="cursor-pointer text-[12px] font-medium text-kumo-default">
          Version history ({history.length})
        </summary>
        <div className="mt-2 max-h-40 space-y-2 overflow-auto">
          {history.map(commit => (
            <div key={commit.oid} className="text-[11px] text-kumo-subtle">
              <div className="truncate font-medium text-kumo-default">{historySummary(commit.message)}</div>
              <div>{commit.author.name} · {commit.timestamp.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </details>

      <DeleteConfirmationDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'item'}?`}
        description="This creates a new workspace version without the selected item."
        isDeleting={busy}
        onOpenChange={open => { if (!open) setDeleting(null) }}
        onConfirm={deleteNode}
      />
    </div>
  )
}
