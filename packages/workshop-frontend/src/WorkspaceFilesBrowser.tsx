import { useRef, type DragEvent as ReactDragEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  DownloadSimple,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Pencil,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react'
import type { CommitInfo, WorkspaceFileNode } from '@gadgets/workshop-shared/api'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'

export interface WorkspaceFilesFolder {
  id: string
  name: string
}

interface WorkspaceFilesBrowserProps {
  folders: WorkspaceFilesFolder[]
  nodes: WorkspaceFileNode[]
  history: CommitInfo[]
  selectedNode: WorkspaceFileNode | null
  currentFolderId: string | undefined
  busy: boolean
  creatingFile: boolean
  newFileName: string
  creatingFolder: boolean
  newFolderName: string
  renaming: WorkspaceFileNode | null
  renameValue: string
  moving: WorkspaceFileNode | null
  deleting: WorkspaceFileNode | null
  onRefresh(): void
  onUploadFiles(files: FileList | File[], parentId?: string): void
  onNewFileNameChange(value: string): void
  onCreateFile(): void
  onCancelCreateFile(): void
  onNewFolderNameChange(value: string): void
  onCreateFolder(): void
  onCancelCreateFolder(): void
  onRenameValueChange(value: string): void
  onRenameNode(): void
  onCancelRename(): void
  onMoveNode(): void
  onCancelMove(): void
  onDeleteNode(): void
  onCancelDelete(): void
  onDownload(node: WorkspaceFileNode): void
  onOpenFolder(folder: WorkspaceFileNode): void
  onSelectFile(file: WorkspaceFileNode): void
  onGoBack(): void
  onStartRename(node: WorkspaceFileNode): void
  onStartMove(node: WorkspaceFileNode): void
  onStartDelete(node: WorkspaceFileNode): void
  onMoveDroppedNode(nodeId: string, destinationId: string): void
}

const WORKSPACE_NODE_DRAG_TYPE = 'application/x-cloudflare-os-workspace-node'

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function historySummary(message: string): string {
  return message.split('\n', 1)[0].trim() || 'Workspace update'
}

export default function WorkspaceFilesBrowser({
  folders,
  nodes,
  history,
  selectedNode,
  currentFolderId,
  busy,
  creatingFile,
  newFileName,
  creatingFolder,
  newFolderName,
  renaming,
  renameValue,
  moving,
  deleting,
  onRefresh,
  onUploadFiles,
  onNewFileNameChange,
  onCreateFile,
  onCancelCreateFile,
  onNewFolderNameChange,
  onCreateFolder,
  onCancelCreateFolder,
  onRenameValueChange,
  onRenameNode,
  onCancelRename,
  onMoveNode,
  onCancelMove,
  onDeleteNode,
  onCancelDelete,
  onDownload,
  onOpenFolder,
  onSelectFile,
  onGoBack,
  onStartRename,
  onStartMove,
  onStartDelete,
  onMoveDroppedNode,
}: WorkspaceFilesBrowserProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDrop = (event: ReactDragEvent<HTMLElement>, destinationId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const nodeId = event.dataTransfer.getData(WORKSPACE_NODE_DRAG_TYPE)
    if (nodeId) {
      onMoveDroppedNode(nodeId, destinationId)
      return
    }
    if (event.dataTransfer.files.length > 0) onUploadFiles(event.dataTransfer.files, destinationId)
  }

  return (
    <div
      className={`flex min-h-0 flex-col ${
        selectedNode
          ? 'h-2/5 w-full shrink-0 border-b border-kumo-line md:h-full md:w-80 md:border-r md:border-b-0'
          : 'h-full w-full'
      }`}
      onDragOver={event => event.preventDefault()}
      onDrop={event => { if (currentFolderId) handleDrop(event, currentFolderId) }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-4 py-3">
        <WorkshopIconButton
          aria-label="Back to parent folder"
          disabled={folders.length <= 1 || busy}
          onClick={onGoBack}
        >
          <ArrowLeft size={16} />
        </WorkshopIconButton>
        <div className="min-w-0 flex-1 truncate text-[13px] text-kumo-subtle">
          {folders.map(folder => folder.name).join(' / ')}
        </div>
        <WorkshopIconButton aria-label="Refresh workspace files" disabled={busy} onClick={onRefresh}>
          <ArrowsClockwise size={16} />
        </WorkshopIconButton>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={event => {
            if (event.target.files) onUploadFiles(event.target.files)
          }}
        />
        <WorkshopButton disabled={busy} onClick={() => fileInputRef.current?.click()}>
          <UploadSimple size={15} />
          Upload
        </WorkshopButton>
        <WorkshopButton disabled={busy} onClick={() => onNewFileNameChange('')}>
          <FilePlus size={15} />
          New file
        </WorkshopButton>
        <WorkshopButton disabled={busy} onClick={() => onNewFolderNameChange('')}>
          <FolderPlus size={15} />
          New folder
        </WorkshopButton>
      </div>

      {creatingFile && (
        <div className="flex items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
          <WorkshopInput
            autoFocus
            aria-label="New file name"
            value={newFileName}
            onChange={event => onNewFileNameChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') onCreateFile()
              if (event.key === 'Escape') onCancelCreateFile()
            }}
          />
          <WorkshopButton tone="primary" disabled={!newFileName.trim() || busy} onClick={onCreateFile}>
            Create
          </WorkshopButton>
          <WorkshopButton disabled={busy} onClick={onCancelCreateFile}>Cancel</WorkshopButton>
        </div>
      )}

      {creatingFolder && (
        <div className="flex items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
          <WorkshopInput
            autoFocus
            aria-label="New folder name"
            value={newFolderName}
            onChange={event => onNewFolderNameChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') onCreateFolder()
              if (event.key === 'Escape') onCancelCreateFolder()
            }}
          />
          <WorkshopButton tone="primary" disabled={!newFolderName.trim() || busy} onClick={onCreateFolder}>
            Create
          </WorkshopButton>
          <WorkshopButton disabled={busy} onClick={onCancelCreateFolder}>Cancel</WorkshopButton>
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
            onClick={onMoveNode}
          >
            Move {moving.name} here
          </WorkshopButton>
          <WorkshopButton disabled={busy} onClick={onCancelMove}>Cancel</WorkshopButton>
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
              <div
                key={node.id}
                role="listitem"
                draggable={!busy}
                onDragStart={event => event.dataTransfer.setData(WORKSPACE_NODE_DRAG_TYPE, node.id)}
                onDragOver={event => { if (node.kind === 'folder') event.preventDefault() }}
                onDrop={event => { if (node.kind === 'folder') handleDrop(event, node.id) }}
                className={`group flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-kumo-tint/40 ${selectedNode?.id === node.id ? 'bg-kumo-tint' : ''}`}
              >
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
                        onChange={event => onRenameValueChange(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') onRenameNode()
                          if (event.key === 'Escape') onCancelRename()
                        }}
                      />
                      <span className="block truncate text-[11px] text-kumo-inactive">
                        {node.kind === 'file' ? `${formatBytes(node.size)} · ` : ''}
                        {node.updatedAt.toLocaleString()} · {node.updatedBy}
                      </span>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => node.kind === 'folder' ? onOpenFolder(node) : onSelectFile(node)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                  >
                    {node.kind === 'folder'
                      ? <Folder size={19} className="shrink-0 text-kumo-brand" weight="fill" />
                      : <File size={19} className="shrink-0 text-kumo-subtle" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-kumo-default">{node.name}</span>
                      <span className="block truncate text-[11px] text-kumo-inactive">
                        {node.kind === 'file' ? `${formatBytes(node.size)} · ` : ''}
                        {node.updatedAt.toLocaleString()} · {node.updatedBy}
                      </span>
                    </span>
                  </button>
                )}
                {renaming?.id === node.id ? (
                  <WorkshopButton
                    disabled={busy || !renameValue.trim() || renameValue.trim() === renaming.name}
                    onClick={onRenameNode}
                  >
                    Save
                  </WorkshopButton>
                ) : (
                  <>
                    {node.kind === 'file' && (
                      <WorkshopIconButton
                        aria-label={`Download ${node.name}`}
                        disabled={busy}
                        onClick={() => onDownload(node)}
                      >
                        <DownloadSimple size={16} />
                      </WorkshopIconButton>
                    )}
                    <WorkshopIconButton
                      aria-label={`Rename ${node.name}`}
                      disabled={busy}
                      onClick={() => onStartRename(node)}
                    >
                      <Pencil size={16} />
                    </WorkshopIconButton>
                    <WorkshopIconButton
                      aria-label={`Move ${node.name}`}
                      disabled={busy}
                      onClick={() => onStartMove(node)}
                    >
                      <ArrowRight size={16} />
                    </WorkshopIconButton>
                    <WorkshopIconButton
                      aria-label={`Delete ${node.name}`}
                      danger
                      disabled={busy}
                      onClick={() => onStartDelete(node)}
                    >
                      <Trash size={16} />
                    </WorkshopIconButton>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {!selectedNode && <details className="shrink-0 border-t border-kumo-line px-4 py-3">
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
      </details>}

      <DeleteConfirmationDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'item'}?`}
        description="This creates a new workspace version without the selected item."
        isDeleting={busy}
        onOpenChange={open => { if (!open) onCancelDelete() }}
        onConfirm={onDeleteNode}
      />
    </div>
  )
}
