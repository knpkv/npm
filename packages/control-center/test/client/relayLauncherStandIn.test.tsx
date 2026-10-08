// @vitest-environment happy-dom

import { RelayProductDockProvider, useRelayProductOpen } from "@knpkv/relay-product/registry"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { makeRelayLauncherSlot } from "../../src/client/controlCenterRelayDockShell.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

// The real launcher's chunk is held back until the test releases it.
let releaseLauncher: () => void = () => undefined
const launcherLoaded = new Promise<void>((resolve) => {
  releaseLauncher = resolve
})

const FakeRealLauncher = (): ReactElement => {
  const { launcher, open } = useRelayProductOpen()
  return (
    <button aria-expanded={open} data-real-launcher="" ref={launcher} type="button">
      Relay
    </button>
  )
}

const RelayLauncherSlot = makeRelayLauncherSlot(async () => {
  await launcherLoaded
  return FakeRealLauncher
})

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const OpenState = (): ReactElement => <output data-open={String(useRelayProductOpen().open)} />

describe("Relay launcher stand-in", () => {
  it("opens Relay on Ctrl+J, is the shared launcher, and hands focus to the real launcher", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <RelayProductDockProvider>
          <RelayLauncherSlot />
          <OpenState />
        </RelayProductDockProvider>
      )
    )
    const standIn = host.querySelector<HTMLButtonElement>("button")
    expect(standIn?.textContent).toContain("Relay")
    expect(standIn?.getAttribute("aria-keyshortcuts")).toBe("Control+J")

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyJ", ctrlKey: true, key: "j" }))
    )
    expect(host.querySelector("[data-open]")?.getAttribute("data-open")).toBe("true")
    expect(standIn?.getAttribute("aria-expanded")).toBe("true")

    standIn?.focus()
    await act(async () => {
      releaseLauncher()
      await launcherLoaded
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const real = host.querySelector<HTMLButtonElement>("[data-real-launcher]")
    expect(real).not.toBeNull()
    expect(document.activeElement).toBe(real)
  })
})
