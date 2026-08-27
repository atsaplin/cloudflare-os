import { describe, expect, it } from 'vitest'
import type { WorkspaceFileNode } from '@gadgets/workshop-shared/api'
import { classifyWorkspaceFile } from './workspaceFileContent'

function file(name: string, mediaType?: string): WorkspaceFileNode {
  return {
    id: 'file',
    parentId: 'root',
    kind: 'file',
    name,
    path: name,
    size: 0,
    mediaType,
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    createdBy: 'aleksey',
    updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    updatedBy: 'aleksey',
  }
}

describe('classifyWorkspaceFile', () => {
  it.each(['notes.md', 'component.mdx', 'app.ts', 'data.json', 'styles.css', 'icon.svg'])(
    'opens %s as editable UTF-8 text',
    name => {
      expect(classifyWorkspaceFile(file(name), new TextEncoder().encode('hello'))).toEqual({
        kind: 'text',
        text: 'hello',
      })
    },
  )

  it('opens unknown valid UTF-8 as plain text', () => {
    expect(classifyWorkspaceFile(
      file('Dockerfile'),
      new TextEncoder().encode('FROM node:24\n'),
    )).toEqual({ kind: 'text', text: 'FROM node:24\n' })
  })

  it('opens SVG source as text even though its media type is image', () => {
    expect(classifyWorkspaceFile(
      file('icon.svg', 'image/svg+xml'),
      new TextEncoder().encode('<svg />'),
    )).toEqual({ kind: 'text', text: '<svg />' })
  })

  it('keeps unknown binary bytes out of the text editor', () => {
    expect(classifyWorkspaceFile(file('archive.custom'), new Uint8Array([0, 255, 1]))).toEqual({
      kind: 'binary',
      preview: 'download',
    })
  })

  it.each([
    ['photo.png', 'image/png', 'image'],
    ['document.pdf', 'application/pdf', 'pdf'],
    ['song.mp3', 'audio/mpeg', 'audio'],
    ['clip.mp4', 'video/mp4', 'video'],
  ] as const)('selects a derived preview for %s', (name, mediaType, preview) => {
    expect(classifyWorkspaceFile(file(name, mediaType), new Uint8Array([0, 255, 1]))).toEqual({
      kind: 'binary',
      preview,
    })
  })
})
