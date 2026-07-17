// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useWorkspaceItems } from "../../src/client/items/useWorkspaceItems.js"
import { presentPortfolio, type PortfolioReleasePresentation } from "../../src/client/portfolio/presentPortfolio.js"
import type { ReleaseWorksetTransport } from "../../src/client/releases/useReleaseWorkset.js"
import { EnvironmentId } from "../../src/domain/identifiers.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
const ignoreSessionExpiry = (): void => undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const Harness = ({
  releases,
  transport
}: {
  readonly releases: ReadonlyArray<PortfolioReleasePresentation>
  readonly transport: ReleaseWorksetTransport
}): ReactElement => {
  const controller = useWorkspaceItems(
    WORKSET_WORKSPACE_ID,
    releases,
    "session-a",
    ignoreSessionExpiry,
    transport
  )
  return <span>{controller.state._tag}</span>
}

describe("useWorkspaceItems", () => {
  it("does not refetch for a newly allocated but semantically identical release scope", async () => {
    const release = presentPortfolio(makePortfolioSnapshot()).releases[0]
    if (release === undefined) throw new Error("Expected one portfolio release")
    const releases = [release]
    const transport = {
      load: vi.fn(() => Promise.resolve(releaseWorksetFixture))
    } satisfies ReleaseWorksetTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<Harness releases={releases} transport={transport} />))
    await act(async () => Promise.resolve())
    const initialLoads = 1 + release.targetEnvironmentIds.length
    expect(transport.load).toHaveBeenCalledTimes(initialLoads)
    expect(host.textContent).toBe("ready")

    const equivalent = [{ ...release, targetEnvironmentIds: [...release.targetEnvironmentIds] }]
    await act(async () => mountedRoot?.render(<Harness releases={equivalent} transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.load).toHaveBeenCalledTimes(initialLoads)
    expect(host.textContent).toBe("ready")

    const extraEnvironment = Schema.decodeUnknownSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000099")
    const changed = [{ ...release, targetEnvironmentIds: [...release.targetEnvironmentIds, extraEnvironment] }]
    await act(async () => mountedRoot?.render(<Harness releases={changed} transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.load).toHaveBeenCalledTimes(initialLoads + initialLoads + 1)
    expect(host.textContent).toBe("ready")
  })
})
