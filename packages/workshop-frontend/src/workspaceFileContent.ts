import type { WorkspaceFileNode } from '@gadgets/workshop-shared/api'

export type WorkspaceBinaryPreview = 'image' | 'pdf' | 'audio' | 'video' | 'download'

export type WorkspaceFileContent =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; preview: WorkspaceBinaryPreview }

const TEXT_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cpp', 'css', 'csv', 'cxx', 'go', 'graphql', 'h', 'hpp', 'html',
  'java', 'js', 'json', 'jsx', 'md', 'mdx', 'mjs', 'py', 'rs', 'sh', 'sql', 'svg',
  'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
])

const TEXT_MEDIA_TYPES = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/sql',
  'application/toml',
  'application/xml',
  'application/x-javascript',
  'application/x-sh',
  'application/yaml',
])

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined
}

function binaryPreview(mediaType: string | undefined): WorkspaceBinaryPreview | undefined {
  if (mediaType?.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType?.startsWith('audio/')) return 'audio'
  if (mediaType?.startsWith('video/')) return 'video'
  return undefined
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function classifyWorkspaceFile(
  node: WorkspaceFileNode,
  bytes: Uint8Array,
): WorkspaceFileContent {
  const extension = extensionOf(node.name)
  const mediaType = node.mediaType?.split(';', 1)[0]?.trim().toLowerCase()
  const text = decodeUtf8(bytes)
  const knownText = mediaType?.startsWith('text/') === true ||
    (mediaType !== undefined && TEXT_MEDIA_TYPES.has(mediaType)) ||
    (extension !== undefined && TEXT_EXTENSIONS.has(extension))
  if (text !== undefined && knownText) return { kind: 'text', text }

  const preview = binaryPreview(mediaType)
  if (preview) return { kind: 'binary', preview }
  if (text !== undefined && (mediaType === undefined || mediaType === 'application/octet-stream')) {
    return { kind: 'text', text }
  }
  return { kind: 'binary', preview: 'download' }
}
