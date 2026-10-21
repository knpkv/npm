import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import { ConnectSurface, type ConnectAtoms } from "@knpkv/herdr-connect/surface"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"
import { Icon } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { Effect, Exit, Fiber, Schedule, Schema } from "effect"
import * as Atom from "effect/reactivity/Atom"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useEffect, useEffectEvent, useId, useRef, useState, type ComponentProps } from "react"
import {
  loadBlockedDevicePushState,
  loadBlockedSettings,
  reportStageHeartbeat,
  mutateBlockedSettings
} from "./blocked-push-client.js"
import type { NotificationState } from "./approval-app-view.js"
import { fleetModule, moduleHref } from "./modules.js"
import { type BlockedPushMutation, type BlockedPushSettings, PushAgentKey } from "./blocked-push-model.js"

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)
const makeNotificationAtoms = (state: NotificationState | undefined, push: boolean) => ({
  device: browserRuntime.atom(state === undefined ? loadBlockedDevicePushState : Effect.succeed(state)),
  // Off the notification hub there are no settings to read; null keeps every mute control closed.
  settings: browserRuntime.atom(push ? loadBlockedSettings : Effect.succeed(null)),
  save: browserRuntime.fn(mutateBlockedSettings),
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

type AgentMuteIntent = Extract<BlockedPushMutation, { readonly _tag: "SetAgentMute" }>

type QuietHoursIntent = { readonly quietHours: BlockedPushSettings["quietHours"] }

/** Keep time edits local until focus leaves the editor or Enter commits a complete pair. */
const QuietHours = ({
  busy,
  save,
  settings
}: {
  readonly settings: BlockedPushSettings
  readonly save: (mutation: BlockedPushMutation) => Promise<boolean>
  readonly busy: boolean
}) => {
  const id = useId()
  const fieldset = useRef<HTMLFieldSetElement>(null)
  const previousStart = settings.quietHours === null ? "" : timeLabel(settings.quietHours.startMinute)
  const previousEnd = settings.quietHours === null ? "" : timeLabel(settings.quietHours.endMinute)
  const [start, setStart] = useState(previousStart)
  const [end, setEnd] = useState(previousEnd)
  const savedTimes = useRef({ start: previousStart, end: previousEnd })
  const revision = useRef(0)
  const settledRevision = useRef(0)
  const pending = useRef<QuietHoursIntent | null>(null)
  useEffect(() => {
    savedTimes.current = { start: previousStart, end: previousEnd }
    if (revision.current !== settledRevision.current) return
    setStart(previousStart)
    setEnd(previousEnd)
  }, [previousStart, previousEnd])

  const timeZone = settings.quietHours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  // Enter reaffirms the visible pair over a queued Clear; blur and dismissal keep Clear's settlement.
  const commit = async (explicit = false): Promise<void> => {
    if (!explicit && revision.current === settledRevision.current) return
    const startMinute = timeMinute(start)
    const endMinute = timeMinute(end)
    if (startMinute === null || endMinute === null) return
    const latest = pending.current === null ? settings.quietHours : pending.current.quietHours
    if (
      latest !== null &&
      latest.startMinute === startMinute &&
      latest.endMinute === endMinute &&
      latest.timeZone === timeZone
    ) {
      if (pending.current === null) settledRevision.current = revision.current
      return
    }
    if (explicit) revision.current += 1
    const intent: QuietHoursIntent = { quietHours: { startMinute, endMinute, timeZone } }
    pending.current = intent
    const edited = revision.current
    const accepted = await save({ _tag: "SetQuietHours", quietHours: intent.quietHours })
    if (pending.current === intent) pending.current = null
    if (revision.current !== edited) return
    settledRevision.current = edited
    if (!accepted) {
      setStart(savedTimes.current.start)
      setEnd(savedTimes.current.end)
    }
  }
  const clear = async (): Promise<void> => {
    const edited = ++revision.current
    settledRevision.current = edited
    const intent: QuietHoursIntent = { quietHours: null }
    pending.current = intent
    const accepted = await save({ _tag: "SetQuietHours", quietHours: intent.quietHours })
    if (pending.current === intent) pending.current = null
    if (revision.current !== edited) return
    settledRevision.current = edited
    setStart(accepted ? "" : savedTimes.current.start)
    setEnd(accepted ? "" : savedTimes.current.end)
  }
  const commitOnDismissal = useEffectEvent(() => {
    void commit()
  })
  // Capture backdrop and the stage header's Close before either unmounts the editor; Escape cancels.
  useEffect(() => {
    const layer = fieldset.current?.closest("[data-rly-sheet-layer]")
    const overlay = layer?.querySelector("[data-rly-sheet-overlay]")
    const close = layer?.querySelector(".connect-stage-sheet button[aria-label='Close']")
    overlay?.addEventListener("pointerdown", commitOnDismissal, true)
    close?.addEventListener("click", commitOnDismissal, true)
    return () => {
      overlay?.removeEventListener("pointerdown", commitOnDismissal, true)
      close?.removeEventListener("click", commitOnDismissal, true)
    }
  }, [])
  return (
    <fieldset className="connect-stage-notification-quiet" aria-busy={busy} ref={fieldset}>
      <legend>Quiet hours</legend>
      <div className="connect-stage-notification-times">
        <div
          className="connect-stage-notification-time-editor"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) void commit()
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void commit(true)
            }
          }}
        >
          <div className="connect-stage-notification-time">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              aria-label="Quiet hours from"
              type="time"
              value={start}
              onInput={(event) => {
                revision.current += 1
                setStart(event.currentTarget.value)
              }}
            />
          </div>
          <div className="connect-stage-notification-time">
            <label htmlFor={`${id}-until`}>Until</label>
            <input
              id={`${id}-until`}
              aria-label="Quiet hours until"
              type="time"
              value={end}
              onInput={(event) => {
                revision.current += 1
                setEnd(event.currentTarget.value)
              }}
            />
          </div>
        </div>
        <span className="connect-stage-notification-zone">{timeZone}</span>
        {settings.quietHours !== null ? (
          <button type="button" className="connect-stage-notification-clear" onClick={() => void clear()}>
            Clear
          </button>
        ) : null}
      </div>
    </fieldset>
  )
}

type DirectoryLocation = NonNullable<ComponentProps<typeof ConnectSurface>["directoryLocation"]>
type BlockedConnectSurfaceProps = {
  readonly active?: boolean
  readonly atoms: ConnectAtoms
  readonly presentation?: ComponentProps<typeof ConnectSurface>["presentation"]
  readonly notificationState?: NotificationState
  /** Defaults true. False off the notification hub: no settings read, no stage heartbeat. */
  readonly push?: boolean
} & (
  | { readonly embedded: true; readonly directoryLocation: DirectoryLocation }
  | { readonly embedded?: false; readonly directoryLocation?: DirectoryLocation }
)

/** Canonical-hub stage presence and owner-scoped notification settings. Embedded history is always host-owned. */
export const BlockedConnectSurface = ({
  active = true,
  atoms,
  directoryLocation,
  embedded = false,
  notificationState,
  presentation = { _tag: "fleet" },
  push = true
}: BlockedConnectSurfaceProps) => {
  const [notifications] = useState(() => makeNotificationAtoms(notificationState, push))
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
  const saving = useRef(Promise.resolve())
  const pendingMutes = useRef(new Map<string, AgentMuteIntent>())
  const save = async (mutation: BlockedPushMutation): Promise<boolean> => {
    const result = saving.current.then(() => runSave(mutation))
    saving.current = result.then(() => undefined)
    return Exit.isSuccess(await result)
  }
  const [heartbeat, report] = useAtom(notifications.heartbeat)
  const host = target?.host ?? null
  const agentId = target?.id ?? null
  useEffect(() => {
    if (!push || host === null || agentId === null) return
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
  }, [agentId, host, push, report])
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
  const busy = AsyncResult.isWaiting(saved)
  const muted =
    settings !== null &&
    settings.mutedAgents.some((key) => key.host.toLowerCase() === host?.toLowerCase() && key.agentId === agentId)
  const toggleMute = async (): Promise<void> => {
    if (host === null || agentId === null) return
    const identity = JSON.stringify([host.toLowerCase(), agentId])
    const mutation: AgentMuteIntent = {
      _tag: "SetAgentMute",
      agent: { host, agentId },
      muted: !(pendingMutes.current.get(identity)?.muted ?? muted)
    }
    pendingMutes.current.set(identity, mutation)
    await save(mutation)
    if (pendingMutes.current.get(identity) === mutation) pendingMutes.current.delete(identity)
  }
  const footer = (
    <section className="connect-stage-notifications" aria-label="Agent notifications" aria-busy={busy}>
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
            onClick={() => void toggleMute()}
          >
            <span>Mute this agent</span>
            <span aria-hidden="true" className="connect-stage-notification-switch">
              <span />
            </span>
          </button>
          <QuietHours settings={settings} save={save} busy={busy} />
          <p className="connect-stage-notification-summary">
            {muted
              ? `Muted, you won’t get pushes from ${name ?? "this agent"}`
              : settings.quietHours === null
                ? "Pushes on, no quiet hours"
                : `Quiet ${timeLabel(settings.quietHours.startMinute)}–${timeLabel(settings.quietHours.endMinute)} ${settings.quietHours.timeZone}`}
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
  return (
    <ConnectSurface
      active={active}
      atoms={atoms}
      directoryLocation={directoryLocation}
      embedded={embedded}
      presentation={presentation}
      onStageChange={setTarget}
      stageFooter={push ? footer : undefined}
    />
  )
}
