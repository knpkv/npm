// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import type { ReleaseId } from "../../src/domain/identifiers.js"
import { ReleaseId as ReleaseIdSchema } from "../../src/domain/identifiers.js"
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
  releaseId,
  sessionKey,
  transport
}: {
  readonly releaseId: ReleaseId
  readonly sessionKey: string
  readonly transport: ReleaseWorksetTransport
}): ReactElement => {
  const controller = useReleaseWorkset(releaseId, sessionKey, transport)
  observations.push(controller.state)
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
      load: vi.fn((_releaseId: ReleaseId, _signal: AbortSignal) => {
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
})
