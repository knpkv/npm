import { useAtom } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import { ConnectSurface, type ConnectAtoms } from "@knpkv/herdr-connect/surface"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"
import { Effect, Fiber, Schedule, Schema } from "effect"
import * as Atom from "effect/reactivity/Atom"
import { useEffect, useState, type ComponentProps } from "react"
import { reportStageHeartbeat } from "./blocked-push-client.js"
import { PushAgentKey } from "./blocked-push-model.js"

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)
const makeNotificationAtoms = () => ({
  heartbeat: browserRuntime.fn(reportStageHeartbeat)
})

/** Canonical-hub stage presence without additional stage controls. */
export const BlockedConnectSurface = ({
  active = true,
  atoms,
  embedded = false,
  presentation
}: {
  readonly active?: boolean
  readonly atoms: ConnectAtoms
  readonly embedded?: boolean
  readonly presentation?: ComponentProps<typeof ConnectSurface>["presentation"]
}) => {
  const [notifications] = useState(makeNotificationAtoms)
  const [target, setTarget] = useState<Pick<ConnectAgent, "host" | "id"> | null>(null)
  const [, report] = useAtom(notifications.heartbeat)
  const host = target?.host ?? null
  const agentId = target?.id ?? null
  useEffect(() => {
    if (host === null || agentId === null) return
    const clientId = window.crypto.randomUUID()
    const key = Schema.decodeUnknownSync(PushAgentKey)({ host, agentId })
    const publish = () => report({ clientId, target: document.visibilityState === "visible" ? key : null })
    const clear = () => report({ clientId, target: null })
    document.addEventListener("visibilitychange", publish)
    window.addEventListener("pagehide", clear)
    window.addEventListener("pageshow", publish)
    const fiber = Effect.runFork(
      Effect.sync(() => {
        if (document.visibilityState === "visible") publish()
      }).pipe(Effect.repeat(Schedule.spaced("15 seconds")))
    )
    return () => {
      document.removeEventListener("visibilitychange", publish)
      window.removeEventListener("pagehide", clear)
      window.removeEventListener("pageshow", publish)
      Effect.runFork(Fiber.interrupt(fiber))
      clear()
    }
  }, [agentId, host, report])
  return (
    <ConnectSurface
      active={active}
      atoms={atoms}
      embedded={embedded}
      {...(presentation === undefined ? {} : { presentation })}
      onStageChange={setTarget}
    />
  )
}
