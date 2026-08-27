import { useCallback, useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  getWorkspaceFileErrorCode,
  MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES,
  WORKSPACE_FILE_ERROR_CODES,
  type CommitInfo,
  type Overseer,
  type WorkspaceFileMutation,
  type WorkspaceFileMutationResult,
  type WorkspaceFileNode,
  type WorkspaceFileRevision,
  type FileRef,
  type WriteTarget,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './components/WorkshopControls'
import { saveStreamToFile } from './fileTransfers'
import { reportIssue } from './errorReporting'
import WorkspaceFilesBrowser, { type WorkspaceFilesFolder } from './WorkspaceFilesBrowser'
import WorkspaceFileEditor from './WorkspaceFileEditor'

interface WorkspaceFilesPanelProps {
  overseer: RpcStub<Overseer>
  target?: WriteTarget | null
  selectedNodeId?: string
  selectedRevision?: string
  onSelectionChange?(nodeId: string | undefined, revision: string | undefined): void
}

const ACCEPTED_TARGET = { kind: 'accepted' } as const

function extensionFor(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot) : '.bin'
}

function selectUploads(files: FileList | File[]): File[] {
  const selected = Array.from(files)
  const totalSize = selected.reduce((sum, file) => sum + file.size, 0)
  if (totalSize > MAXIMUM_WORKSPACE_FILE_UPLOAD_BYTES) {
    throw new Error('Selected files exceed the 25 MB operation limit.')
  }
  if (new Set(selected.map(file => file.name)).size !== selected.length) {
    throw new Error('Selected files must have unique names.')
  }
  return selected
}

async function stageUploadChange(
  overseer: RpcStub<Overseer>,
  file: File,
  existing: WorkspaceFileNode | undefined,
  parentId: string,
  index: number,
): Promise<WorkspaceFileMutation> {
  if (existing?.kind === 'folder') throw new Error(`A folder named ${file.name} already exists.`)
  const upload = await overseer.stageWorkspaceFileUpload({
    content: file.stream(),
    size: file.size,
    ...(file.type ? { mediaType: file.type } : {}),
  })
  return existing ? {
    kind: 'replaceFile',
    nodeId: existing.id,
    uploadId: upload.uploadId,
  } : {
    kind: 'createFile',
    clientId: `upload-${index}`,
    parent: { nodeId: parentId },
    name: file.name,
    uploadId: upload.uploadId,
  }
}

export default function WorkspaceFilesPanel({
  overseer,
  target,
  selectedNodeId,
  selectedRevision,
  onSelectionChange,
}: WorkspaceFilesPanelProps) {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const [revision, setRevision] = useState<WorkspaceFileRevision | null>(null)
  const [folders, setFolders] = useState<WorkspaceFilesFolder[]>([])
  const [nodes, setNodes] = useState<WorkspaceFileNode[]>([])
  const [history, setHistory] = useState<CommitInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [creatingFile, setCreatingFile] = useState(false)
  const [renaming, setRenaming] = useState<WorkspaceFileNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moving, setMoving] = useState<WorkspaceFileNode | null>(null)
  const [deleting, setDeleting] = useState<WorkspaceFileNode | null>(null)
  const [selectedNode, setSelectedNode] = useState<WorkspaceFileNode | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)

  const activeTarget = target === undefined ? ACCEPTED_TARGET : target

  const currentFolderId = folders.at(-1)?.id ?? revision?.rootId
  const folderReference = useCallback((folderId: string, source: WorkspaceFileRevision): FileRef => ({
    workspaceId: source.workspaceId,
    nodeId: folderId,
    revision: source.revision,
  }), [])

  const loadFolder = useCallback(async (folderId: string): Promise<void> => {
    if (!revision) return
    setNodes(await overseer.listWorkspaceChildren(folderReference(folderId, revision)))
  }, [folderReference, overseer, revision])

  const refreshHistory = useCallback(async (): Promise<void> => {
    if (!activeTarget) return
    setHistory(await overseer.getWorkspaceHistory(activeTarget, 50))
  }, [activeTarget, overseer])

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (!activeTarget) return
    const [nextRevision, nextHistory] = await Promise.all([
      overseer.getWorkspaceRevision(activeTarget),
      overseer.getWorkspaceHistory(activeTarget, 50),
    ])
    const requestedFolderId = currentFolderId ?? nextRevision.rootId
    try {
      const nextNodes = await overseer.listWorkspaceChildren(
        folderReference(requestedFolderId, nextRevision),
      )
      setRevision(nextRevision)
      setNodes(nextNodes)
      setHistory(nextHistory)
    } catch (error) {
      if (requestedFolderId === nextRevision.rootId) throw error
      const nextNodes = await overseer.listWorkspaceChildren(
        folderReference(nextRevision.rootId, nextRevision),
      )
      setRevision(nextRevision)
      setFolders([{ id: nextRevision.rootId, name: 'Files' }])
      setNodes(nextNodes)
      setHistory(nextHistory)
    }
  }, [activeTarget, currentFolderId, folderReference, overseer])

  useEffect(() => {
    if (!activeTarget) {
      setLoading(true)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    Promise.all([
      overseer.getWorkspaceRevision(activeTarget),
      overseer.getWorkspaceHistory(activeTarget, 50),
    ])
      .then(async ([nextRevision, nextHistory]) => {
        const nextNodes = await overseer.listWorkspaceChildren(
          folderReference(nextRevision.rootId, nextRevision),
        )
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
  }, [activeTarget, folderReference, loadAttempt, overseer])

  useEffect(() => {
    if (!selectedNodeId) return
    if (!revision) {
      setSelectedNode(null)
      return
    }
    let cancelled = false
    overseer.getWorkspaceNode({
      workspaceId: revision.workspaceId,
      nodeId: selectedNodeId,
      revision: revision.revision,
    }).then(node => {
      if (!cancelled) setSelectedNode(node.kind === 'file' ? node : null)
    }).catch(error => {
      if (cancelled) return
      reportIssue('workspace-files.selection', error)
      setSelectedNode(null)
      onSelectionChange?.(undefined, undefined)
    })
    return () => { cancelled = true }
  }, [onSelectionChange, overseer, revision, selectedNodeId])

  const resolveSelectedNode = useCallback(async (
    nextRevision: WorkspaceFileRevision,
  ): Promise<WorkspaceFileNode | null | undefined> => {
    const nodeId = selectedNode?.id ?? selectedNodeId
    if (!nodeId) return undefined
    try {
      const nextNode = await overseer.getWorkspaceNode({
        workspaceId: nextRevision.workspaceId,
        nodeId,
        revision: nextRevision.revision,
      })
      return nextNode.kind === 'file' ? nextNode : null
    } catch (error) {
      if (getWorkspaceFileErrorCode(error) === WORKSPACE_FILE_ERROR_CODES.invalidRequest) {
        return null
      }
      reportIssue('workspace-files.selection-refresh', error)
      return undefined
    }
  }, [onSelectionChange, overseer, selectedNode, selectedNodeId])

  const applyMutation = useCallback(async (
    message: string,
    changes: WorkspaceFileMutation[],
  ): Promise<WorkspaceFileMutationResult | null> => {
    if (!revision || !currentFolderId || !activeTarget) return null
    const result = await overseer.applyWorkspaceMutation({
      operationId: crypto.randomUUID(),
      expectedHead: revision.head,
      target: activeTarget,
      message,
      changes,
    })
    if (result.outcome === 'stale') {
      await refreshWorkspace()
      toastsRef.current.add({
        title: 'Workspace changed. Files refreshed; try again.',
        variant: 'error',
      })
      return null
    }
    setRevision(result)
    const nextSelectedNode = await resolveSelectedNode(result)
    if (nextSelectedNode !== undefined) {
      setSelectedNode(nextSelectedNode)
      if (!nextSelectedNode) onSelectionChange?.(undefined, undefined)
    }
    await Promise.all([
      overseer.listWorkspaceChildren(folderReference(currentFolderId, result)).then(setNodes),
      refreshHistory(),
    ])
    return result
  }, [activeTarget, currentFolderId, folderReference, onSelectionChange, overseer, refreshHistory, refreshWorkspace, resolveSelectedNode, revision])

  const runMutation = useCallback(async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } catch (error) {
      reportIssue('workspace-files.mutate', error)
      if (getWorkspaceFileErrorCode(error) === WORKSPACE_FILE_ERROR_CODES.conflict) {
        try {
          await refreshWorkspace()
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
  }, [refreshWorkspace])

  const uploadFiles = (files: FileList | File[], parentId = currentFolderId): void => {
    void runMutation(async () => {
      if (!parentId || !revision) return
      const selected = selectUploads(files)
      const destinationNodes = parentId === currentFolderId
        ? nodes
        : await overseer.listWorkspaceChildren(folderReference(parentId, revision))
      const existingByName = new Map(destinationNodes.map(node => [node.name, node]))
      const changes = await Promise.all(selected.map((file, index) =>
        stageUploadChange(overseer, file, existingByName.get(file.name), parentId, index)))
      if (changes.length > 0) {
        const message = changes.length === 1
          ? `Add ${selected[0].name}`
          : `Add ${changes.length} files`
        await applyMutation(message, changes)
      }
    })
  }

  const createFolder = (): void => {
    const name = newFolderName.trim()
    if (!name || !currentFolderId) return
    void runMutation(async () => {
      const applied = await applyMutation(`Create ${name}`, [{
        kind: 'createFolder',
        clientId: 'folder',
        parent: { nodeId: currentFolderId },
        name,
      }])
      if (applied) {
        setNewFolderName('')
        setCreatingFolder(false)
      }
    })
  }

  const createFile = (): void => {
    const name = newFileName.trim()
    if (!name || !currentFolderId) return
    void runMutation(async () => {
      const upload = await overseer.stageWorkspaceFileUpload({
        content: new ReadableStream({ start(controller) { controller.close() } }),
        size: 0,
        mediaType: 'text/plain',
      })
      const applied = await applyMutation(`Create ${name}`, [{
        kind: 'createFile',
        clientId: 'file',
        parent: { nodeId: currentFolderId },
        name,
        uploadId: upload.uploadId,
      }])
      const createdId = applied?.created.file
      if (!createdId) return
      setNewFileName('')
      setCreatingFile(false)
      onSelectionChange?.(createdId, undefined)
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
      const applied = await applyMutation(`Rename ${renaming.name} to ${name}`, [{
        kind: 'move',
        nodeId: renaming.id,
        parent: { nodeId: currentFolderId },
        name,
      }])
      if (applied) setRenaming(null)
    })
  }

  const deleteNode = (): void => {
    if (!deleting) return
    void runMutation(async () => {
      const applied = await applyMutation(`Delete ${deleting.name}`, [{
        kind: 'delete',
        nodeId: deleting.id,
        recursive: deleting.kind === 'folder',
      }])
      if (applied) {
        if (deleting.id === selectedNode?.id) onSelectionChange?.(undefined, undefined)
        setDeleting(null)
      }
    })
  }

  const moveNode = (): void => {
    if (!moving || !currentFolderId || moving.parentId === currentFolderId) return
    void runMutation(async () => {
      const applied = await applyMutation(`Move ${moving.name}`, [{
        kind: 'move',
        nodeId: moving.id,
        parent: { nodeId: currentFolderId },
        name: moving.name,
      }])
      if (applied) setMoving(null)
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

  const selectFile = (file: WorkspaceFileNode): void => {
    if (file.kind !== 'file') return
    if (editorDirty && selectedNode?.id !== file.id &&
        !window.confirm('Discard unsaved changes and open another file?')) return
    onSelectionChange?.(file.id, undefined)
    if (!onSelectionChange) setSelectedNode(file)
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
      () => {
        if (!revision) return Promise.reject(new Error('Workspace revision is unavailable.'))
        return overseer.readWorkspaceFile({
          workspaceId: revision.workspaceId,
          nodeId: file.id,
          revision: selectedRevision
            ? { ...revision.revision, commit: selectedRevision }
            : revision.revision,
        })
      },
      file.name,
      {
        description: file.name,
        contentType: file.mediaType ?? 'application/octet-stream',
        extension: extensionFor(file.name),
      },
    ))
  }

  const handleEditorSaved = (nextRevision: WorkspaceFileRevision): void => {
    setRevision(nextRevision)
    setEditorDirty(false)
    if (!currentFolderId) return
    void Promise.all([
      overseer.listWorkspaceChildren(folderReference(currentFolderId, nextRevision)).then(setNodes),
      refreshHistory(),
      selectedNode ? overseer.getWorkspaceNode({
        workspaceId: nextRevision.workspaceId,
        nodeId: selectedNode.id,
        revision: nextRevision.revision,
      }).then(setSelectedNode) : Promise.resolve(),
    ])
  }

  const moveDroppedNode = (nodeId: string, destinationId: string): void => {
    const source = nodes.find(node => node.id === nodeId)
    if (!source || source.id === destinationId || source.parentId === destinationId) return
    void runMutation(async () => {
      await applyMutation(`Move ${source.name}`, [{
        kind: 'move',
        nodeId: source.id,
        parent: { nodeId: destinationId },
        name: source.name,
      }])
    })
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
    <div className="flex h-full min-h-0 flex-col bg-kumo-base md:flex-row">
      <WorkspaceFilesBrowser
        folders={folders}
        nodes={nodes}
        history={history}
        selectedNode={selectedNode}
        currentFolderId={currentFolderId}
        busy={busy}
        creatingFile={creatingFile}
        newFileName={newFileName}
        creatingFolder={creatingFolder}
        newFolderName={newFolderName}
        renaming={renaming}
        renameValue={renameValue}
        moving={moving}
        deleting={deleting}
        onRefresh={() => void runMutation(refreshWorkspace)}
        onUploadFiles={uploadFiles}
        onNewFileNameChange={value => { setNewFileName(value); setCreatingFile(true) }}
        onCreateFile={createFile}
        onCancelCreateFile={() => setCreatingFile(false)}
        onNewFolderNameChange={value => { setNewFolderName(value); setCreatingFolder(true) }}
        onCreateFolder={createFolder}
        onCancelCreateFolder={() => setCreatingFolder(false)}
        onRenameValueChange={setRenameValue}
        onRenameNode={renameNode}
        onCancelRename={() => setRenaming(null)}
        onMoveNode={moveNode}
        onCancelMove={() => setMoving(null)}
        onDeleteNode={deleteNode}
        onCancelDelete={() => setDeleting(null)}
        onDownload={downloadFile}
        onOpenFolder={openFolder}
        onSelectFile={selectFile}
        onGoBack={goBack}
        onStartRename={node => { setRenaming(node); setRenameValue(node.name) }}
        onStartMove={node => setMoving(node)}
        onStartDelete={node => setDeleting(node)}
        onMoveDroppedNode={moveDroppedNode}
      />
      {selectedNode && revision && activeTarget && (
        <div className="min-h-0 min-w-0 flex-1">
          <WorkspaceFileEditor
            overseer={overseer}
            target={activeTarget}
            revision={revision}
            node={selectedNode}
            history={history}
            selectedCommit={selectedRevision}
            onRevisionChange={commit => onSelectionChange?.(selectedNode.id, commit)}
            onSaved={handleEditorSaved}
            onDirtyChange={setEditorDirty}
          />
        </div>
      )}
    </div>
  )
}
