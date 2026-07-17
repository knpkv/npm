// @vitest-environment happy-dom

import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceEntityProjectionIndex } from "../../src/api/deliveryGraph.js"
import { type WorkspaceItemsTransport, useWorkspaceItems } from "../../src/client/items/useWorkspaceItems.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
const ignoreSessionExpiry = (): void => undefined
const ROUTABLE_RELEASE_IDS = new Set([releaseWorksetFixture.releaseId])

const index: WorkspaceEntityProjectionIndex = {
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
  onSessionExpired = ignoreSessionExpiry,
  refreshKey = "snapshot-a",
  transport
}: {
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly refreshKey?: string
  readonly transport: WorkspaceItemsTransport
}): ReactElement => {
  const controller = useWorkspaceItems(
    WORKSET_WORKSPACE_ID,
    ROUTABLE_RELEASE_IDS,
    refreshKey,
    "session-a",
    onSessionExpired,
    transport
  )
  return (
    <span>
      {controller.state._tag === "ready"
        ? `ready:${controller.state.items.length}:${String(controller.state.truncated)}`
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
    expect(host.textContent).toBe(`ready:${index.items.length}:false`)

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

    expect(host.textContent).toBe(`ready:${index.items.length}:true`)
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
