// @vitest-environment happy-dom

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { act, StrictMode, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import {
  type PortfolioSnapshotDependencies,
  usePortfolioSnapshot
} from "../../src/client/portfolio/usePortfolioSnapshot.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const onlineConnectivity: PortfolioSnapshotDependencies["connectivity"] = {
  isOnline: Effect.succeed(true),
  waitUntilOnline: Effect.void
}

let mountedRoot: Root | undefined
const ignoreSessionExpiration = (): void => undefined

afterEach(() => {
  if (mountedRoot === undefined) return
  act(() => mountedRoot?.unmount())
  mountedRoot = undefined
})

const PortfolioProbe = ({
  dependencies,
  sessionKey
}: {
  readonly dependencies: PortfolioSnapshotDependencies
  readonly sessionKey: string
}): ReactElement => {
  const controller = usePortfolioSnapshot(sessionKey, ignoreSessionExpiration, dependencies)
  return (
    <output>
      {controller.state._tag === "loaded"
        ? `${controller.state.sessionKey}:${controller.state.snapshot.eventCursor}:${controller.state.connection._tag}`
        : controller.state._tag}
    </output>
  )
}

describe("usePortfolioSnapshot", () => {
  it("surfaces an unexpected controller defect instead of freezing the loading state", async () => {
    const dependencies: PortfolioSnapshotDependencies = {
      connectivity: onlineConnectivity,
      transport: {
        loadSnapshot: Effect.die("portfolio-runtime-defect"),
        openStream: () => Effect.succeed(Stream.never)
      }
    }
    const host = document.createElement("div")
    const root = createRoot(host)
    mountedRoot = root

    await act(async () => {
      root.render(<PortfolioProbe dependencies={dependencies} sessionKey="session-a" />)
      await Promise.resolve()
    })

    expect(host.textContent).toBe("failed")
  })

  it("closes the generated stream across StrictMode cleanup and final unmount", async () => {
    const streamOpened = Deferred.makeUnsafe<void>()
    let activeStreams = 0
    let closedStreams = 0
    let openedStreams = 0
    const dependencies: PortfolioSnapshotDependencies = {
      connectivity: onlineConnectivity,
      transport: {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot()),
        openStream: () =>
          Effect.gen(function* () {
            activeStreams += 1
            openedStreams += 1
            yield* Deferred.succeed(streamOpened, undefined)
            return Stream.never.pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  activeStreams -= 1
                  closedStreams += 1
                })
              )
            )
          })
      }
    }
    const host = document.createElement("div")
    const root = createRoot(host)
    mountedRoot = root

    act(() => {
      root.render(
        <StrictMode>
          <PortfolioProbe dependencies={dependencies} sessionKey="session-a" />
        </StrictMode>
      )
    })
    await Effect.runPromise(Deferred.await(streamOpened))

    expect(activeStreams).toBe(1)
    expect(openedStreams).toBeGreaterThanOrEqual(1)
    expect(openedStreams).toBeLessThanOrEqual(2)
    act(() => root.unmount())
    mountedRoot = undefined
    expect(activeStreams).toBe(0)
    expect(closedStreams).toBe(openedStreams)
  })

  it("cannot publish a late snapshot from a replaced session", async () => {
    const firstLoadStarted = Deferred.makeUnsafe<void>()
    const releaseFirstLoad = Deferred.makeUnsafe<void>()
    const replacementStreamOpened = Deferred.makeUnsafe<void>()
    let loadCount = 0
    const dependencies: PortfolioSnapshotDependencies = {
      connectivity: onlineConnectivity,
      transport: {
        loadSnapshot: Effect.suspend(() => {
          loadCount += 1
          if (loadCount === 1) {
            return Deferred.succeed(firstLoadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstLoad)),
              Effect.as(makePortfolioSnapshot("current", 10))
            )
          }
          return Effect.succeed(makePortfolioSnapshot("current", 20))
        }),
        openStream: () => Deferred.succeed(replacementStreamOpened, undefined).pipe(Effect.as(Stream.never))
      }
    }
    const host = document.createElement("div")
    const root = createRoot(host)
    mountedRoot = root

    act(() => root.render(<PortfolioProbe dependencies={dependencies} sessionKey="session-a" />))
    await Effect.runPromise(Deferred.await(firstLoadStarted))
    act(() => root.render(<PortfolioProbe dependencies={dependencies} sessionKey="session-b" />))
    await Effect.runPromise(Deferred.await(replacementStreamOpened))
    expect(host.textContent).toBe("session-b:20:connecting")

    await Effect.runPromise(Deferred.succeed(releaseFirstLoad, undefined))
    act(() => undefined)
    expect(host.textContent).toBe("session-b:20:connecting")
  })
})
