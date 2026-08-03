// @vitest-environment happy-dom

import * as Effect from "effect/Effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { BrowserSessionProvider } from "../../src/client/BrowserSession.js"
import { BrowserSessionHydrator } from "../../src/client/BrowserSessionHydrator.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

afterEach(() => {
  document.body.replaceChildren()
})

describe("BrowserSessionHydrator", () => {
  it("interrupts pending session hydration during React cleanup", async () => {
    let interrupted = false
    const loadSession = Effect.callback<never>((_resume, signal) => {
      const observeInterruption = (): void => {
        interrupted = true
      }
      signal.addEventListener("abort", observeInterruption, { once: true })
      return Effect.sync(() => {
        interrupted ||= signal.aborted
        signal.removeEventListener("abort", observeInterruption)
      })
    })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)

    await act(async () =>
      root.render(
        <BrowserSessionProvider>
          <BrowserSessionHydrator loadSession={loadSession} />
        </BrowserSessionProvider>
      )
    )
    expect(interrupted).toBe(false)

    await act(async () => root.unmount())

    expect(interrupted).toBe(true)
  })
})
