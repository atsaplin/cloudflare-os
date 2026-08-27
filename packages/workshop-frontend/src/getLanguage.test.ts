import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { getLanguage } from './getLanguage'

describe('getLanguage', () => {
  it('uses Markdown syntax for MDX files', () => {
    const markdownState = EditorState.create({
      doc: '# Heading',
      extensions: [getLanguage('README.md')],
    })
    const mdxState = EditorState.create({
      doc: '# Heading',
      extensions: [getLanguage('README.mdx')],
    })

    expect(syntaxTree(mdxState).toString()).toBe(syntaxTree(markdownState).toString())
  })
})
