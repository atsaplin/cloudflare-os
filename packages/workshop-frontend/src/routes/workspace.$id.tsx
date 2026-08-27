import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'

/** Parsed workspace route search state. */
export type WorkspaceSearch = {
  chat?: number
  /** Selected workpiece ID. Zero is valid. */
  w?: number
  file?: string
  revision?: string
}

function parseIntParam(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

function parseStringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Parse workspace route search values without losing numeric zero. */
export function parseWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  return {
    chat: parseIntParam(search.chat),
    w: parseIntParam(search.w),
    file: parseStringParam(search.file),
    revision: parseStringParam(search.revision),
  }
}

export const Route = createFileRoute('/workspace/$id')({
  component: GadgetEditor,
  validateSearch: parseWorkspaceSearch,
})
