// @vitest-environment happy-dom

import { RegistryContext } from "@effect/atom-react"
import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { ConnectAgent } from "../src/model.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "hub",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-1"),
  kind: "codex",
  name: "Worker",
  state: "working",
  work: "Checking the changes",
  lastActivityAt: 0
})

/** Retrying ownership retains the stage during admission; Close and Back cancel that pending request. */
it.each([
  { state: "controlled", action: "Take over", takeover: true, close: "Close" },
  { state: "taken-over", action: "Reconnect", takeover: false, close: "Back to Connect" }
] satisfies ReadonlyArray<{ state: "controlled" | "taken-over"; action: string; takeover: boolean; close: string }>)(
  "$action sends only its explicit intent and $close cancels admission",
  async ({ action, close, state, takeover }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    // Hold the renderer's real WASM fetch at its I/O boundary while admission stays pending.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}))
    const atoms = makeConnectAtoms()
    const registry = AtomRegistry.make({
      initialValues: [
        [atoms.agents, AsyncResult.success({ agents: [agent], failures: [] })],
        [atoms.limits, AsyncResult.initial()],
        [atoms.work, AsyncResult.initial()],
        [atoms.connection, { _tag: state, agent }]
      ]
    })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <ConnectSurface atoms={atoms} embedded presentation={{ _tag: "home" }} />
          </RegistryContext.Provider>
        )
      )
      await act(async () => host.querySelector<HTMLButtonElement>(".connect-agent")?.click())
      const button = [...document.querySelectorAll<HTMLButtonElement>(".connect-terminal-control button")].find(
        (candidate) => candidate.textContent === action
      )
      expect(button).toBeDefined()
      expect(document.activeElement).toBe(button)
      await act(async () => button?.click())
      expect(registry.get(atoms.connectionRequest)).toMatchObject({ agent, takeover, retainStage: true })
      expect(registry.get(atoms.connection)).toEqual({ _tag: "connecting", agent })
      expect(document.querySelector(".connect-terminal-control")?.textContent).toContain("Connecting to Worker…")
      expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'))
      expect(document.querySelector('[role="alert"]')).toBeNull()
      await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${close}"]`)?.click())
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(registry.get(atoms.connectionRequest)).toBeNull()
      expect(registry.get(atoms.connection)).toEqual({ _tag: "idle" })
    } finally {
      await act(async () => root.unmount())
      registry.dispose()
      host.remove()
      vi.unstubAllGlobals()
    }
  }
)
