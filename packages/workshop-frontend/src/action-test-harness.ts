// Shared harness for the action-store hook tests (useActions / useActionHistory): act-enabled
// root management, manually-pumped rAF frames (the store coalesces entry commits through rAF),
// an ActionLogEntry factory, and a fake overseer covering the subscription and history-paging
// surfaces. Not a test file itself -- vitest only collects *.test.* -- so importing it is what
// installs the act environment and the rAF stub.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionHistoryPage,
  ActionLogEntry,
  ActionsSubscriber,
  Overseer,
} from '@gadgets/workshop-shared/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rafQueue: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb))

/** Run every queued rAF callback inside act(). */
export function flushFrames() {
  act(() => {
    while (rafQueue.length) rafQueue.shift()!(0)
  })
}

export function entry(id: number, over: Partial<Record<string, unknown>> = {}): ActionLogEntry {
  return {
    id,
    resourceTitle: `Resource ${id}`,
    createdAt: new Date(1700000000000 + id * 60_000),
    state: 'pending',
    type: 'action',
    description: { title: `Action ${id}`, description: '', implementsRevert: false },
    ...over,
  } as ActionLogEntry
}

type ListOptions = Parameters<Overseer['listActions']>[0]

type Parked<T> = { resolve: (value: T) => void, reject: (err: unknown) => void }

/**
 * Mocks the server side of the action APIs. subscribeToActions: live records are pushed through
 * the captured subscriber's entry() via emit(); the call itself parks until
 * resolveSubscription()/rejectSubscription(). listActions: each call parks — the shared store's
 * pending queries ({filter: 'pending'}) on their own queue drained by
 * resolvePendingQuery()/rejectPendingQuery(), every other filter on the history queue drained by
 * resolvePage()/rejectPage(). `ops` records the initiation order across all three surfaces.
 */
export function makeOverseer() {
  const ops: Array<'subscribe' | 'list' | 'listPending'> = []
  const subscribeCalls: unknown[][] = []
  const pendingSubscribes: Array<Parked<RpcStub<{}>>> = []
  const listCalls: ListOptions[] = []
  const pendingPages: Array<Parked<ActionHistoryPage>> = []
  const pendingQueryCalls: ListOptions[] = []
  const pendingQueryPages: Array<Parked<ActionHistoryPage>> = []
  const subscriptionDispose = vi.fn<() => void>()
  let subscriber: ActionsSubscriber | undefined
  const overseer = {
    subscribeToActions: (...args: unknown[]) => {
      ops.push('subscribe')
      subscribeCalls.push(args)
      subscriber = args[0] as ActionsSubscriber
      return new Promise<RpcStub<{}>>((resolve, reject) =>
        pendingSubscribes.push({ resolve, reject }))
    },
    listActions: (options?: ListOptions) => {
      if (options?.filter === 'pending') {
        ops.push('listPending')
        pendingQueryCalls.push(options)
        return new Promise<ActionHistoryPage>((resolve, reject) =>
          pendingQueryPages.push({ resolve, reject }))
      }
      ops.push('list')
      listCalls.push(options)
      return new Promise<ActionHistoryPage>((resolve, reject) =>
        pendingPages.push({ resolve, reject }))
    },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    ops,
    subscribeCalls,
    listCalls,
    pendingQueryCalls,
    subscriptionDispose,
    async resolveSubscription() {
      await act(async () => {
        pendingSubscribes.shift()!.resolve(
          { [Symbol.dispose]: subscriptionDispose } as unknown as RpcStub<{}>)
      })
    },
    async rejectSubscription(err: unknown) {
      await act(async () => { pendingSubscribes.shift()!.reject(err) })
    },
    async resolvePage(page: ActionHistoryPage) {
      await act(async () => { pendingPages.shift()!.resolve(page) })
    },
    async rejectPage(err: unknown) {
      await act(async () => { pendingPages.shift()!.reject(err) })
    },
    async resolvePendingQuery(page: ActionHistoryPage) {
      await act(async () => { pendingQueryPages.shift()!.resolve(page) })
    },
    async rejectPendingQuery(err: unknown) {
      await act(async () => { pendingQueryPages.shift()!.reject(err) })
    },
    async emit(record: ActionLogEntry) {
      await act(async () => { subscriber!.entry(record) })
    },
  }
}

/** A DOM root with act()-wrapped render/unmount. cleanup() resets it for the next test. */
export function makeTestRoot() {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  return {
    async render(node: React.ReactNode) {
      if (!root) {
        container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
      }
      await act(async () => root!.render(node))
    },
    unmount() {
      act(() => root?.unmount())
      root = undefined
    },
    cleanup() {
      this.unmount()
      container?.remove()
      container = undefined
      rafQueue.length = 0
    },
  }
}
