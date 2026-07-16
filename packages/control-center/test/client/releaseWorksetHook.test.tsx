// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { SessionSummary } from "../../src/api/session.js"
import type { BrowserSessionState } from "../../src/client/BrowserSession.js"
import { releaseWorksetSessionKey } from "../../src/client/releases/ReleaseWorkset.js"
import type { EnvironmentId, ReleaseId } from "../../src/domain/identifiers.js"
import { EnvironmentId as EnvironmentIdSchema, ReleaseId as ReleaseIdSchema } from "../../src/domain/identifiers.js"
import {
  type ReleaseWorksetState,
  type ReleaseWorksetTransport,
  useReleaseWorkset
} from "../../src/client/releases/useReleaseWorkset.js"
import { releaseWorksetFixture, WORKSET_RELEASE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolveValue === undefined) throw new Error("Deferred resolution unavailable")
      resolveValue(value)
    }
  }
}

let mountedRoot: Root | undefined
const observations: Array<ReleaseWorksetState> = []

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  observations.length = 0
  document.body.replaceChildren()
})

const Harness = ({
  environmentIds = [],
  releaseId,
  sessionKey,
  transport
}: {
  readonly environmentIds?: ReadonlyArray<EnvironmentId>
  readonly releaseId: ReleaseId
  readonly sessionKey: string
  readonly transport: ReleaseWorksetTransport
}): ReactElement => {
  const controller = useReleaseWorkset(releaseId, environmentIds, sessionKey, transport)
  observations.push(controller.state)
  return (
    <span>{controller.state._tag === "ready" ? controller.state.inspection.releaseId : controller.state._tag}</span>
  )
}

const SessionHarness = ({
  state,
  transport
}: {
  readonly state: BrowserSessionState
  readonly transport: ReleaseWorksetTransport
}): ReactElement => {
  const controller = useReleaseWorkset(WORKSET_RELEASE_ID, [], releaseWorksetSessionKey(state), transport)
  return (
    <span>{controller.state._tag === "ready" ? controller.state.inspection.releaseId : controller.state._tag}</span>
  )
}

describe("useReleaseWorkset", () => {
  it("never exposes a previous release or session while the next graph is loading", async () => {
    const releaseB = Schema.decodeSync(ReleaseIdSchema)("01890f6f-6d6a-7cc0-98d2-000000000012")
    const inspectionB: ReleaseDeliveryGraphInspection = { ...releaseWorksetFixture, releaseId: releaseB }
    const requestA = deferred<ReleaseDeliveryGraphInspection>()
    const requestB = deferred<ReleaseDeliveryGraphInspection>()
    const requestSessionB = deferred<ReleaseDeliveryGraphInspection>()
    const requests = [requestA.promise, requestB.promise, requestSessionB.promise]
    const transport = {
      load: vi.fn((_releaseId: ReleaseId, _environmentId: EnvironmentId | null, _signal: AbortSignal) => {
        const request = requests.shift()
        return request ?? Promise.reject(new Error("Unexpected workset request"))
      })
    } satisfies ReleaseWorksetTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(<Harness releaseId={WORKSET_RELEASE_ID} sessionKey="session-a" transport={transport} />)
    )
    await act(async () => requestA.resolve(releaseWorksetFixture))
    expect(host.textContent).toBe(WORKSET_RELEASE_ID)

    observations.length = 0
    await act(async () =>
      mountedRoot?.render(<Harness releaseId={releaseB} sessionKey="session-a" transport={transport} />)
    )
    expect(observations.some((state) => state._tag === "ready" && state.releaseId === WORKSET_RELEASE_ID)).toBe(false)
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(inspectionB))
    expect(host.textContent).toBe(releaseB)

    observations.length = 0
    await act(async () =>
      mountedRoot?.render(<Harness releaseId={releaseB} sessionKey="session-b" transport={transport} />)
    )
    expect(observations.some((state) => state._tag === "ready" && state.sessionKey === "session-a")).toBe(false)
    expect(host.textContent).toBe("loading")
  })

  it("keeps cookie-authenticated reads available when mutation-proof storage is unavailable", async () => {
    const session = Schema.decodeUnknownSync(SessionSummary)({
      sessionId: "01890f6f-6d6a-7cc0-98d2-000000000002",
      workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001",
      actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
      permission: "workspace-owner",
      createdAt: "2026-07-14T10:00:00.000Z",
      lastSeenAt: "2026-07-14T10:01:00.000Z",
      idleExpiresAt: "2026-07-14T22:00:00.000Z",
      absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
      revokedAt: null
    })
    const transport = {
      load: vi.fn((_releaseId: ReleaseId, _environmentId: EnvironmentId | null, _signal: AbortSignal) =>
        Promise.resolve(releaseWorksetFixture)
      )
    } satisfies ReleaseWorksetTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(<SessionHarness state={{ _tag: "storage-unavailable", session }} transport={transport} />)
    )
    await act(async () => Promise.resolve())
    expect(transport.load).toHaveBeenCalledOnce()
    expect(host.textContent).toBe(WORKSET_RELEASE_ID)

    await act(async () =>
      mountedRoot?.render(
        <SessionHarness state={{ _tag: "storage-unavailable", session: null }} transport={transport} />
      )
    )
    expect(transport.load).toHaveBeenCalledOnce()
    expect(host.textContent).toBe("idle")
  })

  it("combines release-scoped and target-environment relationships", async () => {
    const environmentId = Schema.decodeSync(EnvironmentIdSchema)("01890f6f-6d6a-7cc0-98d2-000000000031")
    const sourceRelationship = releaseWorksetFixture.relationships[0]
    if (sourceRelationship === undefined) throw new Error("Expected an environment relationship fixture")
    const environmentRelationship = {
      ...sourceRelationship,
      scope: {
        _tag: "environment",
        environmentId,
        releaseId: WORKSET_RELEASE_ID
      } satisfies typeof sourceRelationship.scope
    }
    const releaseInspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      relationships: []
    }
    const environmentInspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      environmentId,
      relationships: [environmentRelationship]
    }
    const transport = {
      load: vi.fn((_releaseId: ReleaseId, scope: EnvironmentId | null, _signal: AbortSignal) =>
        Promise.resolve(scope === null ? releaseInspection : environmentInspection)
      )
    } satisfies ReleaseWorksetTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <Harness
          environmentIds={[environmentId]}
          releaseId={WORKSET_RELEASE_ID}
          sessionKey="session-a"
          transport={transport}
        />
      )
    )
    await act(async () => Promise.resolve())

    expect(transport.load).toHaveBeenCalledTimes(2)
    expect(transport.load.mock.calls.map(([, scope]) => scope)).toEqual([null, environmentId])
    const ready = [...observations].reverse().find(({ _tag }) => _tag === "ready")
    expect(ready?._tag === "ready" ? ready.inspection.relationships : []).toContainEqual(environmentRelationship)
    expect(ready?._tag === "ready" ? ready.inspection.nodes.length : 0).toBe(releaseWorksetFixture.nodes.length)
  })
})
