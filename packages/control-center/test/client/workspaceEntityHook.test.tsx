// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceEntityInspection, type WorkspaceEntityInspection as Inspection } from "../../src/api/deliveryGraph.js"
import {
  type WorkspaceEntityState,
  type WorkspaceEntityTransport,
  useWorkspaceEntity
} from "../../src/client/entities/useWorkspaceEntity.js"
import { EntityId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { releaseWorksetFixture } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
const entityId = Schema.decodeUnknownSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000001")
const otherEntityId = Schema.decodeUnknownSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000002")
const pluginConnectionId = Schema.decodeUnknownSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d4-000000000001")
const projectionEntry = releaseWorksetFixture.entityProjections[0]
if (projectionEntry === undefined) throw new Error("Expected an entity projection fixture")

const sourceRevision = {
  providerId: "jira",
  pluginConnectionId,
  vendorImmutableId: "jira-issue-1",
  revision: "rev-1",
  sourceUrl: "https://jira.example.test/browse/OPS-428",
  firstObservedAt: "2026-07-14T10:00:00.000Z",
  lastObservedAt: "2026-07-14T10:00:00.000Z",
  synchronizedAt: "2026-07-14T10:01:00.000Z",
  normalizationSchemaVersion: 1
}

const inspection = (stale: boolean, isSourceCurrent = true): Inspection =>
  Schema.decodeUnknownSync(WorkspaceEntityInspection)({
    entity: {
      ...projectionEntry,
      recordedAt: "2026-07-14T10:02:00.000Z",
      canonicalReleaseId: releaseWorksetFixture.releaseId,
      owners: [],
      ownersTruncated: false,
      releaseIds: [releaseWorksetFixture.releaseId],
      releaseMembershipsTruncated: false
    },
    source: sourceRevision,
    isSourceCurrent,
    freshness: stale
      ? {
          _tag: "stale",
          evaluatedAt: "2026-07-14T10:20:00.000Z",
          pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:20:00.000Z" },
          provenance: {
            _tag: "cache",
            cachedAt: "2026-07-14T10:01:00.000Z",
            sourceRevision
          },
          sourceObservedAt: "2026-07-14T10:00:00.000Z",
          staleAfterSeconds: 300,
          synchronizedAt: "2026-07-14T10:01:00.000Z"
        }
      : null,
    graph: {
      truncated: false,
      nodes: [],
      relatedEntityProjections: [],
      relationships: [],
      evidenceClaims: [],
      evidenceItems: []
    },
    activity: { truncated: false, events: [] }
  })

const currentInspection = inspection(false)
const staleInspection = inspection(true)

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  let rejectValue: ((reason?: unknown) => void) | undefined
  const promise = new Promise<Value>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return {
    promise,
    reject: (reason: unknown): void => {
      if (rejectValue === undefined) throw new Error("Deferred rejection unavailable")
      rejectValue(reason)
    },
    resolve: (value: Value): void => {
      if (resolveValue === undefined) throw new Error("Deferred resolution unavailable")
      resolveValue(value)
    }
  }
}

let mountedRoot: Root | undefined
let retryLatest: (() => void) | undefined
const observations: Array<WorkspaceEntityState> = []
const ignoreSessionExpiry = (): void => undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  retryLatest = undefined
  observations.length = 0
  document.body.replaceChildren()
})

const Harness = ({
  entity = entityId,
  onSessionExpired = ignoreSessionExpiry,
  refreshKey = "snapshot-a",
  sessionKey = "session-a",
  transport,
  workspace = workspaceId
}: {
  readonly entity?: typeof entityId
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly refreshKey?: string
  readonly sessionKey?: string | null
  readonly transport: WorkspaceEntityTransport
  readonly workspace?: typeof workspaceId
}): ReactElement => {
  const controller = useWorkspaceEntity(workspace, entity, refreshKey, sessionKey, onSessionExpired, transport)
  retryLatest = controller.retry
  observations.push(controller.state)
  return (
    <span>
      {controller.state._tag === "ready"
        ? `ready:${controller.state.inspection.entity.projection.title}`
        : controller.state._tag === "stale"
          ? `stale:${controller.state.reason}:${controller.state.inspection.entity.projection.title}`
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

describe("useWorkspaceEntity", () => {
  it("loads one exact schema-decoded entity and does not refetch a stable scope", async () => {
    const transport = {
      load: vi.fn((_entityId: typeof entityId, _signal: AbortSignal) => Promise.resolve(currentInspection))
    } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness transport={transport} />)

    expect(transport.load).toHaveBeenCalledOnce()
    expect(transport.load).toHaveBeenCalledWith(entityId, expect.any(AbortSignal))
    expect(host.textContent).toBe(`ready:${currentInspection.entity.projection.title}`)

    await act(async () => mountedRoot?.render(<Harness transport={transport} />))
    expect(transport.load).toHaveBeenCalledOnce()
  })

  it("exposes authoritative stale source data explicitly", async () => {
    const transport = { load: () => Promise.resolve(staleInspection) } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness transport={transport} />)

    expect(host.textContent).toBe(`stale:source-stale:${staleInspection.entity.projection.title}`)
  })

  it("retains only the same entity as stale while a refresh is in flight", async () => {
    const refresh = deferred<Inspection>()
    const transport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(currentInspection)
        .mockImplementationOnce(() => refresh.promise)
    } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness transport={transport} />)

    await act(async () => mountedRoot?.render(<Harness refreshKey="snapshot-b" transport={transport} />))
    expect(host.textContent).toBe(`stale:refreshing:${currentInspection.entity.projection.title}`)

    await act(async () => refresh.resolve(currentInspection))
    expect(host.textContent).toBe(`ready:${currentInspection.entity.projection.title}`)
  })

  it("does not expose a previous entity while another identity loads", async () => {
    const next = deferred<Inspection>()
    const transport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(currentInspection)
        .mockImplementationOnce(() => next.promise)
    } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness transport={transport} />)

    observations.length = 0
    await act(async () => mountedRoot?.render(<Harness entity={otherEntityId} transport={transport} />))

    expect(host.textContent).toBe("loading")
    expect(
      observations.some((state) => (state._tag === "ready" || state._tag === "stale") && state.entityId === entityId)
    ).toBe(false)
  })

  it("distinguishes not-found, failed, and unauthorized responses", async () => {
    const notFoundTransport = {
      load: () => Promise.reject({ _tag: "NotFoundApiError" })
    } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness transport={notFoundTransport} />)
    expect(host.textContent).toBe("not-found")

    const unavailableTransport = {
      load: () => Promise.reject({ _tag: "ServiceUnavailableApiError" })
    } satisfies WorkspaceEntityTransport
    await act(async () => mountedRoot?.render(<Harness transport={unavailableTransport} />))
    await act(async () => Promise.resolve())
    expect(host.textContent).toBe("failed")

    const onSessionExpired = vi.fn()
    const unauthorizedTransport = {
      load: () => Promise.reject({ _tag: "UnauthorizedApiError" })
    } satisfies WorkspaceEntityTransport
    await act(async () =>
      mountedRoot?.render(<Harness onSessionExpired={onSessionExpired} transport={unauthorizedTransport} />)
    )
    await act(async () => Promise.resolve())
    expect(onSessionExpired).toHaveBeenCalledWith("session-a")
    expect(host.textContent).toBe("failed")
  })

  it("keeps a failed refresh visible as stale and retryable", async () => {
    const refresh = deferred<Inspection>()
    const retry = deferred<Inspection>()
    const transport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(currentInspection)
        .mockImplementationOnce(() => refresh.promise)
        .mockImplementationOnce(() => retry.promise)
    } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness transport={transport} />)

    await act(async () => mountedRoot?.render(<Harness refreshKey="snapshot-b" transport={transport} />))
    await act(async () => refresh.reject({ _tag: "ServiceUnavailableApiError" }))
    expect(host.textContent).toBe(`stale:refresh-failed:${currentInspection.entity.projection.title}`)

    await act(async () => retryLatest?.())
    expect(host.textContent).toBe(`stale:refreshing:${currentInspection.entity.projection.title}`)
    await act(async () => retry.resolve(currentInspection))
    expect(host.textContent).toBe(`ready:${currentInspection.entity.projection.title}`)
  })

  it("stays idle without a session and aborts an in-flight read on unmount", async () => {
    const pending = deferred<Inspection>()
    let capturedSignal: AbortSignal | undefined
    const transport = {
      load: (_entityId: typeof entityId, signal: AbortSignal) => {
        capturedSignal = signal
        return pending.promise
      }
    } satisfies WorkspaceEntityTransport
    const host = await renderHarness(<Harness sessionKey={null} transport={transport} />)
    expect(host.textContent).toBe("idle")
    expect(capturedSignal).toBeUndefined()

    await act(async () => mountedRoot?.render(<Harness transport={transport} />))
    expect(host.textContent).toBe("loading")
    await act(async () => mountedRoot?.unmount())
    mountedRoot = undefined
    expect(capturedSignal?.aborted).toBe(true)
  })
})
