import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import { ConnectSurface, type ConnectAtoms } from "@knpkv/herdr-connect/surface"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"
import { Icon } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { Effect, Exit, Fiber, Schedule, Schema } from "effect"
import * as Atom from "effect/reactivity/Atom"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useEffect, useId, useRef, useState } from "react"
import {
  loadBlockedDevicePushState,
  loadBlockedSettings,
  reportStageHeartbeat,
  saveBlockedSettings
} from "./blocked-push-client.js"
import type { NotificationState } from "./approval-app-view.js"
import { fleetModule, moduleHref } from "./modules.js"
import { type BlockedPushSettings, PushAgentKey } from "./blocked-push-model.js"

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)
const makeNotificationAtoms = (state?: NotificationState) => ({
  device: browserRuntime.atom(state === undefined ? loadBlockedDevicePushState : Effect.succeed(state)),
  settings: browserRuntime.atom(loadBlockedSettings),
  save: browserRuntime.fn(saveBlockedSettings),
  heartbeat: browserRuntime.fn(reportStageHeartbeat)
})

const timeLabel = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
const TimeInput = Schema.String.check(Schema.isPattern(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/))
const timeMinute = (text: string): number | null => {
  if (!Schema.is(TimeInput)(text)) return null
  const [hours, minutes] = text.split(":").map(Number)
  return hours === undefined || minutes === undefined ? null : hours * 60 + minutes
}

/** Editing either time stays local until a complete pair is committed on blur. */
const QuietHours = ({
  disabled,
  save,
  settings
}: {
  readonly settings: BlockedPushSettings
  readonly save: (settings: BlockedPushSettings) => Promise<boolean>
  readonly disabled: boolean
}) => {
  const id = useId()
  const previousStart = settings.quietHours === null ? "" : timeLabel(settings.quietHours.startMinute)
  const previousEnd = settings.quietHours === null ? "" : timeLabel(settings.quietHours.endMinute)
  const [start, setStart] = useState(previousStart)
  const [end, setEnd] = useState(previousEnd)
  const timeZone = settings.quietHours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const commit = async (): Promise<void> => {
    const startMinute = timeMinute(start)
    const endMinute = timeMinute(end)
    if (startMinute === null || endMinute === null) return
    if (start === previousStart && end === previousEnd) return
    if (!(await save({ ...settings, quietHours: { startMinute, endMinute, timeZone } }))) {
      setStart(previousStart)
      setEnd(previousEnd)
    }
  }
  return (
    <fieldset className="connect-stage-notification-quiet" disabled={disabled}>
      <legend>Quiet hours</legend>
      <div className="connect-stage-notification-times">
        <div className="connect-stage-notification-time">
          <label htmlFor={`${id}-from`}>From</label>
          <input
            id={`${id}-from`}
            aria-label="Quiet hours from"
            type="time"
            value={start}
            onInput={(event) => setStart(event.currentTarget.value)}
            onBlur={() => void commit()}
          />
        </div>
        <div className="connect-stage-notification-time">
          <label htmlFor={`${id}-until`}>Until</label>
          <input
            id={`${id}-until`}
            aria-label="Quiet hours until"
            type="time"
            value={end}
            onInput={(event) => setEnd(event.currentTarget.value)}
            onBlur={() => void commit()}
          />
        </div>
        <span className="connect-stage-notification-zone">{timeZone}</span>
        {settings.quietHours !== null ? (
          <button
            type="button"
            className="connect-stage-notification-clear"
            onClick={() => void save({ ...settings, quietHours: null })}
          >
            Clear
          </button>
        ) : null}
      </div>
    </fieldset>
  )
}

/** Canonical-hub stage presence and owner-scoped notification settings. */
export const BlockedConnectSurface = ({
  atoms,
  embedded = false,
  notificationState
}: {
  readonly atoms: ConnectAtoms
  readonly embedded?: boolean
  readonly notificationState?: NotificationState
}) => {
  const [notifications] = useState(() => makeNotificationAtoms(notificationState))
  const [target, setTarget] = useState<Pick<ConnectAgent, "host" | "id"> | null>(null)
  const deviceResult = useAtomValue(notifications.device)
  const deviceState =
    notificationState ??
    (AsyncResult.isSuccess(deviceResult)
      ? deviceResult.value
      : AsyncResult.isFailure(deviceResult)
        ? "error"
        : "loading")
  const directory = useAtomValue(atoms.agents)
  const loaded = useAtomValue(notifications.settings)
  const saved = useAtomValue(notifications.save)
  const runSave = useAtomSet(notifications.save, { mode: "promiseExit" })
  const saving = useRef(false)
  const save = async (settings: BlockedPushSettings): Promise<boolean> => {
    if (saving.current) return false
    saving.current = true
    try {
      return Exit.isSuccess(await runSave(settings))
    } finally {
      saving.current = false
    }
  }
  const [heartbeat, report] = useAtom(notifications.heartbeat)
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
  const settings = AsyncResult.isSuccess(saved)
    ? saved.value
    : AsyncResult.isFailure(saved) && saved.previousSuccess._tag === "Some"
      ? saved.previousSuccess.value.value
      : AsyncResult.isSuccess(loaded)
        ? loaded.value
        : null
  const name = AsyncResult.isSuccess(directory)
    ? directory.value.agents.find((agent) => agent.host === host && agent.id === agentId)?.name
    : undefined
  const disabled = AsyncResult.isWaiting(saved)
  const muted =
    settings !== null &&
    settings.mutedAgents.some((key) => key.host.toLowerCase() === host?.toLowerCase() && key.agentId === agentId)
  const footer = (
    <section className="connect-stage-notifications" aria-label="Agent notifications">
      <h3>Notifications</h3>
      {deviceState === "loading" || deviceState === "error" ? (
        <p className="connect-stage-notification-message" role="status">
          {deviceState === "error" ? "Couldn't check notifications on this device." : "Checking notifications…"}
        </p>
      ) : deviceState !== "enabled" ? (
        <div className="connect-stage-notification-off">
          <p>
            <Icon decorative name="minus" size="small" className="connect-stage-notification-off-mark" />
            Notifications are off on this device
          </p>
          <a href={`/${moduleHref(fleetModule, "approvals")}`}>
            <span>Turn on notifications in Approvals</span>
            <Icon decorative name="arrow-right" size="small" />
          </a>
        </div>
      ) : settings === null ? (
        <Text as="p" variant="meta">
          {AsyncResult.isFailure(loaded) ? "Couldn't load notification settings." : "Loading notification settings…"}
        </Text>
      ) : (
        <>
          <button
            type="button"
            className="connect-stage-notification-mute"
            aria-pressed={muted}
            disabled={disabled}
            onClick={() => {
              if (host === null || agentId === null) return
              const key = { host, agentId }
              void save({
                ...settings,
                mutedAgents: muted
                  ? settings.mutedAgents.filter(
                      (entry) => entry.host.toLowerCase() !== host.toLowerCase() || entry.agentId !== agentId
                    )
                  : [...settings.mutedAgents, key]
              })
            }}
          >
            <span>Mute this agent</span>
            <span aria-hidden="true" className="connect-stage-notification-switch">
              <span />
            </span>
          </button>
          <QuietHours key={JSON.stringify(settings.quietHours)} settings={settings} save={save} disabled={disabled} />
          <p className="connect-stage-notification-summary">
            {muted ? (
              <>
                <span>Muted</span> <span>You won't get pushes from {name ?? "this agent"}.</span>
              </>
            ) : settings.quietHours === null ? (
              "Pushes on, no quiet hours"
            ) : (
              `Quiet ${timeLabel(settings.quietHours.startMinute)}–${timeLabel(settings.quietHours.endMinute)} ${settings.quietHours.timeZone}`
            )}
          </p>
        </>
      )}
      {AsyncResult.isFailure(saved) ? (
        <Text as="p" variant="meta" role="status">
          Couldn't save notification settings.
        </Text>
      ) : null}
      {AsyncResult.isFailure(heartbeat) ? (
        <Text as="p" variant="meta" role="status">
          Couldn't report stage viewing; notifications may still arrive.
        </Text>
      ) : null}
    </section>
  )
  return <ConnectSurface atoms={atoms} embedded={embedded} onStageChange={setTarget} stageFooter={footer} />
}
