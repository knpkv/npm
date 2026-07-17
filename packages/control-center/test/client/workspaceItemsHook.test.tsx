// @vitest-environment happy-dom

import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceEntityProjectionIndex } from "../../src/api/deliveryGraph.js"
import {
  type WorkspaceItemsQuery,
  type WorkspaceItemsTransport,
  useWorkspaceItems
} from "../../src/client/items/useWorkspaceItems.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
const ignoreSessionExpiry = (): void => undefined
const ROUTABLE_RELEASE_IDS = new Set([releaseWorksetFixture.releaseId])
const NO_FILTERS: WorkspaceItemsQuery = { query: "", service: "all", status: "all", type: "all" }

const index: WorkspaceEntityProjectionIndex = {
  matchedCount: releaseWorksetFixture.entityProjections.length,
  totalCount: releaseWorksetFixture.entityProjections.length,
  truncated: false,
  items: releaseWorksetFixture.entityProjections.map((entry) => ({
    ...entry,
    canonicalReleaseId: releaseWorksetFixture.releaseId
  }))
}

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const Harness = ({
  filters = NO_FILTERS,
  onSessionExpired = ignoreSessionExpiry,
  refreshKey = "snapshot-a",
  transport
}: {
  readonly filters?: WorkspaceItemsQuery
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly refreshKey?: string
  readonly transport: WorkspaceItemsTransport
}): ReactElement => {
  const controller = useWorkspaceItems(
    WORKSET_WORKSPACE_ID,
    ROUTABLE_RELEASE_IDS,
    filters,
    refreshKey,
    "session-a",
    onSessionExpired,
    transport
  )
  return (
    <span>
      {controller.state._tag === "ready"
        ? `ready:${controller.state.items.length}:${controller.state.matchedCount}:${controller.state.totalCount}:${String(controller.state.refreshing)}:${String(controller.state.truncated)}`
        : controller.state._tag}
    </span>
  )
}

const renderHarness = async (element: ReactElement): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  await act(async () => mountedRoot?.render(element))
  await act(async () => Promise.resolve())
  return host
}

describe("useWorkspaceItems", () => {
  it("loads the workspace index once and only refetches when its refresh key changes", async () => {
    const transport = {
      load: vi.fn(() => Promise.resolve(index))
    } satisfies WorkspaceItemsTransport
    const host = await renderHarness(<Harness transport={transport} />)

    expect(transport.load).toHaveBeenCalledOnce()
    expect(host.textContent).toBe(`ready:${index.items.length}:${index.matchedCount}:${index.totalCount}:false:false`)

    await act(async () => mountedRoot?.render(<Harness transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.load).toHaveBeenCalledOnce()

    await act(async () => mountedRoot?.render(<Harness refreshKey="snapshot-b" transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it("propagates the authoritative server truncation flag", async () => {
    const transport = {
      load: () => Promise.resolve({ ...index, truncated: true })
    } satisfies WorkspaceItemsTransport
    const host = await renderHarness(<Harness transport={transport} />)

    expect(host.textContent).toBe(`ready:${index.items.length}:${index.matchedCount}:${index.totalCount}:false:true`)
  })

  it("refetches with the exact server-side filters", async () => {
    let resolveFiltered: ((value: WorkspaceEntityProjectionIndex) => void) | undefined
    const filteredResponse = new Promise<WorkspaceEntityProjectionIndex>((resolve) => {
      resolveFiltered = resolve
    })
    const transport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(index)
        .mockImplementationOnce(() => filteredResponse)
    } satisfies WorkspaceItemsTransport
    const host = await renderHarness(<Harness transport={transport} />)

    expect(transport.load).toHaveBeenLastCalledWith(expect.any(AbortSignal), NO_FILTERS)

    const filters = { ...NO_FILTERS, query: "refunds", service: "jira" } satisfies WorkspaceItemsQuery
    await act(async () => mountedRoot?.render(<Harness filters={filters} transport={transport} />))
    await act(async () => Promise.resolve())

    expect(transport.load).toHaveBeenCalledTimes(2)
    expect(transport.load).toHaveBeenLastCalledWith(expect.any(AbortSignal), filters)
    expect(host.textContent).toBe(`ready:${index.items.length}:${index.matchedCount}:${index.totalCount}:true:false`)

    resolveFiltered?.(index)
    await act(async () => filteredResponse)
    expect(host.textContent).toBe(`ready:${index.items.length}:${index.matchedCount}:${index.totalCount}:false:false`)
  })

  it("does not commit a response after unmount aborts the request", async () => {
    let resolveIndex: ((value: WorkspaceEntityProjectionIndex) => void) | undefined
    const response = new Promise<WorkspaceEntityProjectionIndex>((resolve) => {
      resolveIndex = resolve
    })
    const transport = { load: () => response } satisfies WorkspaceItemsTransport
    const host = await renderHarness(<Harness transport={transport} />)

    expect(host.textContent).toBe("loading")
    await act(async () => mountedRoot?.unmount())
    mountedRoot = undefined
    resolveIndex?.(index)
    await act(async () => response)
    expect(host.textContent).toBe("")
  })
})
