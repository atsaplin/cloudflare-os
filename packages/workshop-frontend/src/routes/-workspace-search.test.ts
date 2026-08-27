import { describe, expect, it } from 'vitest'
import { parseWorkspaceSearch } from './workspace.$id'

describe('parseWorkspaceSearch', () => {
  it('preserves stable file and revision selection with chat zero', () => {
    expect(parseWorkspaceSearch({
      chat: '0',
      w: '4',
      file: '3ab9f9f0-45f0-4400-9b1d-daf987e47863',
      revision: '0123456789abcdef0123456789abcdef01234567',
    })).toEqual({
      chat: 0,
      w: 4,
      file: '3ab9f9f0-45f0-4400-9b1d-daf987e47863',
      revision: '0123456789abcdef0123456789abcdef01234567',
    })
  })

  it('drops empty or invalid values', () => {
    expect(parseWorkspaceSearch({
      chat: 'not-a-number',
      w: 2.5,
      file: '',
      revision: '',
    })).toEqual({
      chat: undefined,
      w: undefined,
      file: undefined,
      revision: undefined,
    })
  })
})
