// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import CodeEditor from './CodeEditor'
import { ThemeProvider } from './ThemeContext'

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  })
}

function findEditor(container: HTMLDivElement): EditorView {
  const element = container.querySelector('.cm-editor')
  if (!(element instanceof HTMLElement)) throw new Error('CodeMirror did not mount')
  const view = EditorView.findFromDOM(element)
  if (!view) throw new Error('CodeMirror view was not found')
  return view
}

describe('CodeEditor', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function mount(props: {
    text: string
    readOnly?: boolean
    onTextChange?: (text: string) => void
    onSave?: () => void
  }) {
    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(CodeEditor, { filename: 'notes.md', ...props }),
      ))
    })
  }

  it('edits through a controlled callback and saves the current text with Mod-s', async () => {
    const onTextChange = vi.fn<(text: string) => void>()
    const onSave = vi.fn<() => void>()
    await mount({ text: 'hello', onTextChange, onSave })

    const view = findEditor(container)
    await act(async () => {
      view.dispatch({ changes: { from: 5, insert: ' world' } })
    })

    expect(onTextChange).toHaveBeenLastCalledWith('hello world')
    const saveEvent = new KeyboardEvent('keydown', {
      key: 's', ctrlKey: true, bubbles: true, cancelable: true,
    })
    expect(runScopeHandlers(view, saveEvent, 'editor')).toBe(true)
    expect(onSave).toHaveBeenCalledWith()
  })

  it('keeps a read-only editor non-editable and does not call controlled callbacks', async () => {
    const onTextChange = vi.fn<(text: string) => void>()
    const onSave = vi.fn<() => void>()
    await mount({ text: 'hello', readOnly: true, onTextChange, onSave })

    const view = findEditor(container)
    expect(view.state.readOnly).toBe(true)
    expect(view.state.facet(EditorView.editable)).toBe(false)
    const saveEvent = new KeyboardEvent('keydown', {
      key: 's', ctrlKey: true, bubbles: true, cancelable: true,
    })
    expect(runScopeHandlers(view, saveEvent, 'editor')).toBe(true)
    expect(onTextChange).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps a text-only editor read-only when no change callback is provided', async () => {
    await mount({ text: 'hello' })

    const view = findEditor(container)
    expect(view.state.readOnly).toBe(true)
    expect(view.state.facet(EditorView.editable)).toBe(false)
  })
})
