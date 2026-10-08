// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RelaySetup, type RlyRelayBackend } from "../../src/patterns/RelaySetup.js"

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const backends: ReadonlyArray<RlyRelayBackend> = [
  { id: "codex", label: "Codex", status: { _tag: "Ready", detail: "signed in, ran a test prompt at 14:01" } },
  {
    id: "claude",
    label: "Claude",
    status: {
      _tag: "Unavailable",
      cause: "SignedOut",
      fix: "Run `claude login` in a terminal on this machine.",
      version: "2.1.0"
    }
  },
  { id: "gemini", label: "Gemini", status: { _tag: "Unverified", version: "0.9.2" } }
]
const focuses = [
  { label: "Correctness", value: "correctness" },
  { label: "Security", value: "security" }
]

const Setup = (props: {
  readonly backends?: ReadonlyArray<RlyRelayBackend>
  readonly onCheck?: (id: string) => void
  readonly onStart?: () => void
  readonly selectedBackend?: string
  readonly selectedFocus?: string
}): ReactElement => (
  <RelaySetup
    backends={props.backends ?? backends}
    focuses={focuses}
    onCheck={props.onCheck ?? (() => undefined)}
    onSelectBackend={() => undefined}
    onSelectFocus={() => undefined}
    onStart={props.onStart ?? (() => undefined)}
    selectedBackend={props.selectedBackend}
    selectedFocus={props.selectedFocus}
  />
)

const mount = async (element: ReactElement): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}
const radio = (value: string): HTMLInputElement | null => document.querySelector(`input[value='${value}']`)
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name
  )
const nextFrame = (): Promise<void> => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve())))

describe("RelaySetup", () => {
  it("lets only a ready backend be chosen, and names each status with its one repair", async () => {
    await mount(<Setup />)
    expect(radio("codex")?.disabled).toBe(false)
    expect(radio("claude")?.disabled).toBe(true)
    expect(radio("gemini")?.disabled).toBe(true)
    const status = (value: string): string =>
      document.getElementById(radio(value)?.getAttribute("aria-describedby") ?? "")?.textContent ?? ""
    expect(status("codex")).toBe("Ready: signed in, ran a test prompt at 14:01")
    expect(status("claude")).toBe("Signed out (2.1.0)")
    // Installed is not ready: a version alone says Not checked yet.
    expect(status("gemini")).toBe("Not checked yet (0.9.2)")
    expect(document.body.textContent).toContain("Run `claude login` in a terminal on this machine.")
    expect(button("Check Claude again")).toBeDefined()
    expect(button("Check Gemini now")).toBeDefined()
  })

  it("checks a backend with its repair button and announces the result once the check finishes", async () => {
    const onCheck = vi.fn()
    await mount(<Setup onCheck={onCheck} />)
    const check = button("Check Gemini now")
    check?.focus()
    await act(async () => check?.click())
    expect(onCheck).toHaveBeenCalledWith("gemini")
    const checking: ReadonlyArray<RlyRelayBackend> = backends.map((backend) =>
      backend.id === "gemini" ? { ...backend, status: { _tag: "Checking" } } : backend
    )
    await act(async () => root?.render(<Setup backends={checking} onCheck={onCheck} />))
    expect(document.body.textContent).toContain("Checking…")
    // The same button stays mounted and focused while checking, and a second press does nothing.
    expect(document.activeElement).toBe(button("Checking Gemini"))
    await act(async () => button("Checking Gemini")?.click())
    expect(onCheck).toHaveBeenCalledTimes(1)
    const ready: ReadonlyArray<RlyRelayBackend> = backends.map((backend) =>
      backend.id === "gemini" ? { ...backend, status: { _tag: "Ready" } } : backend
    )
    await act(async () => root?.render(<Setup backends={ready} onCheck={onCheck} />))
    await nextFrame()
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("Gemini: Ready")
    // The check button is gone; focus is on Gemini's now-enabled choice, not the page.
    expect(document.activeElement).toBe(radio("gemini"))
  })

  it("keeps Start reachable but says what is missing until a ready agent and a focus are chosen", async () => {
    const onStart = vi.fn()
    await mount(<Setup onStart={onStart} />)
    const start = (): HTMLButtonElement | undefined => button("Review this pull request")
    expect(start()?.getAttribute("aria-disabled")).toBe("true")
    expect(document.getElementById(start()?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Choose an agent that is ready."
    )
    await act(async () => start()?.click())
    expect(onStart).not.toHaveBeenCalled()
    await act(async () => root?.render(<Setup onStart={onStart} selectedBackend="codex" />))
    expect(document.getElementById(start()?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Choose what to focus on."
    )
    await act(async () => root?.render(<Setup onStart={onStart} selectedBackend="codex" selectedFocus="correctness" />))
    expect(start()?.getAttribute("aria-disabled")).toBe("false")
    await act(async () => start()?.click())
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("does not start with a focus that is no longer offered", async () => {
    const onStart = vi.fn()
    await mount(<Setup onStart={onStart} selectedBackend="codex" selectedFocus="performance" />)
    const start = button("Review this pull request")
    expect(start?.getAttribute("aria-disabled")).toBe("true")
    await act(async () => start?.click())
    expect(onStart).not.toHaveBeenCalled()
  })
})
