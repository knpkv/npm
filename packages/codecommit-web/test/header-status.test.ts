// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { SyncStatus } from "../src/client/components/header.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
})

const renderStatus = async (state: "error" | "live", detail: string) => {
  const host = document.createElement("div")
  root = createRoot(host)
  await act(async () =>
    root?.render(createElement(SyncStatus, { detail, label: state === "error" ? "Sync issue" : "Live", state }))
  )
  return host
}

describe("SyncStatus", () => {
  it("renders the concrete sync failure in visible content", async () => {
    const host = await renderStatus("error", "AWS session expired for production")
    expect(host.textContent).toContain("AWS session expired for production")
  })

  it("keeps healthy sync detail compact", async () => {
    const host = await renderStatus("live", "Updated just now")
    expect(host.textContent).toBe("Live")
  })
})
