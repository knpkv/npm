import { Effect, Exit, Predicate } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import type { ReadProgress, WeekPlanResponse, WeekScopeName, WriteResultResponse } from "../shared/contracts.js"
import * as Api from "./api.js"
import { type CalendarLayers, defaultCalendarLayers } from "./calendarProjection.js"
import {
  makeWeekAtoms,
  previewWrite,
  type QueuedConfirmation,
  type SavedEntryEdit,
  type WeekWrite
} from "./weekAtoms.js"

export interface AgentActivity {
  readonly batch: number
  readonly batches: number
  readonly status: string
  readonly text: string
  readonly request: string
}

type ReadMode = "restore" | "full" | "recorded"
interface ReadRequest {
  readonly week: string | undefined
  readonly scope: WeekScopeName
  readonly mode: ReadMode
  readonly planId?: string | undefined
}

/** The browser HTTP adapter and controlled test adapter implement the same operations. */
export interface WeekTransport {
  readonly bootstrapSession: typeof Api.bootstrapSession
  readonly readSavedWeek: typeof Api.readSavedWeek
  readonly readRecordedWeek: typeof Api.readRecordedWeek
  readonly readWeek: typeof Api.readWeek
  readonly refreshRecordedTime: typeof Api.refreshRecordedTime
  readonly confirmRow: typeof Api.confirmRow
  readonly logManual: typeof Api.logManual
  readonly updateSavedEntry: typeof Api.updateSavedEntry
  readonly mapStandingAttribution: typeof Api.mapStandingAttribution
  readonly markTicketMine: typeof Api.markTicketMine
}

export interface WeekPreferences {
  readonly week: string | undefined
  readonly scope: WeekScopeName
  readonly rememberWeek: (week: string) => void
  readonly rememberScope: (scope: WeekScopeName) => void
  readonly now: () => number
}

interface ReviewStatus {
  readonly layers: CalendarLayers
  readonly monday: string | undefined
  readonly scope: WeekScopeName
  readonly loading: boolean
  readonly failure: string | null
  readonly missingPlan: boolean
  readonly cancelled: boolean
  readonly progress: ReadonlyArray<ReadProgress>
  readonly activity: ReadonlyArray<AgentActivity>
  readonly startedAt: number
  readonly readMode: "full" | "recorded"
  readonly busy: boolean
  readonly queueRunning: boolean
  readonly actionFailure: string | null
  readonly written: WriteResultResponse | null
  readonly configurationChanged: boolean
  readonly fresh: boolean
}

const messageOf = (cause: unknown): string => Predicate.isError(cause) ? cause.message : String(cause)
const excerpt = (text: string): string =>
  text.length <= 64_000 ? text : `${text.slice(0, 64_000)}\n[Output truncated at 64,000 characters]`

/** Own read replacement, write settlement and freshness together. Only explicit rescan reads sessions. */
export const makeWeekReview = (
  registry: AtomRegistry.AtomRegistry,
  preferences: WeekPreferences,
  transport: WeekTransport = Api,
  queueDelay: (milliseconds: number) => Effect.Effect<void> = Effect.sleep
) => {
  const atoms = makeWeekAtoms(transport)
  const status = Atom.make<ReviewStatus>({
    layers: defaultCalendarLayers,
    monday: preferences.week,
    scope: preferences.scope,
    loading: true,
    failure: null,
    missingPlan: false,
    cancelled: false,
    progress: [],
    activity: [],
    startedAt: preferences.now(),
    readMode: "recorded",
    busy: false,
    queueRunning: false,
    actionFailure: null,
    written: null,
    configurationChanged: false,
    fresh: false
  })
  const state = Atom.make((get) => {
    const current = get(status)
    const view = get(atoms.visible)
    const queued = get(atoms.queued)
    const writeTargets = {
      jira: current.layers.jira && current.scope !== "clockify",
      clockify: current.layers.clockify && current.scope !== "jira"
    }
    const queueUnavailable = current.busy || current.loading || !current.fresh ||
      (!writeTargets.jira && !writeTargets.clockify) || view.plan === null ||
      view.plan.scope !== current.scope || view.plan.monday !== current.monday
    return {
      writeTargets,
      ...current,
      plan: view.plan,
      optimisticEntries: view.entries,
      queued,
      queueActive: queued.length > 0 || current.queueRunning,
      queueUnavailable,
      unavailable: queueUnavailable || queued.length > 0 || current.queueRunning
    }
  })
  const update = (patch: Partial<ReviewStatus>) => registry.update(status, (held) => ({ ...held, ...patch }))
  const setPlan = (plan: WeekPlanResponse | null) => registry.set(atoms.source, { plan, entries: [] })
  let active: AbortController | null = null
  let session: Promise<void> | null = null
  let lastRead: ReadRequest | null = null
  let disposed = false
  let nextQueueId = 0
  let dispatching = false
  let queueNeedsRefresh = false
  // These interruptors own each grace-period fiber. Undo and disposal cancel every unsent timer.
  const queueTimers = new Map<string, () => void>()
  const ready = new Set<string>()

  const readLocked = () =>
    disposed || registry.get(status).busy || registry.get(status).queueRunning || registry.get(atoms.queued).length > 0

  const load = async (request: ReadRequest) => {
    if (readLocked()) return
    const { mode, scope, week } = request
    lastRead = request
    active?.abort()
    const controller = new AbortController()
    active = controller
    const isCurrent = () => active === controller && !controller.signal.aborted
    update({
      monday: week,
      scope,
      loading: true,
      failure: null,
      cancelled: false,
      missingPlan: false,
      fresh: false,
      progress: [],
      startedAt: preferences.now(),
      readMode: mode === "full" ? "full" : "recorded",
      ...(mode !== "recorded" && { activity: [] })
    })
    try {
      session ??= transport.bootstrapSession()
      await session
      if (!isCurrent()) return
      const onProgress = (progress: ReadProgress) => {
        if (!isCurrent()) return
        const previous = registry.get(status)
        const next = progress.activity
        if (next === undefined) {
          update({ progress: [...previous.progress.filter((entry) => entry.stage !== progress.stage), progress] })
          return
        }
        const held = previous.activity.find((entry) => entry.batch === next.batch)
        const entry: AgentActivity = {
          batch: next.batch,
          batches: next.batches,
          status: next.kind === "status" ? next.text : held?.status ?? "Agent responding",
          request: next.kind === "request" ? excerpt(next.text) : held?.request ?? "",
          text: next.kind === "response" ? excerpt(next.text) : next.kind === "text"
            ? excerpt((held?.text ?? "") + next.text) :
            held?.text ?? ""
        }
        update({
          activity: [...previous.activity.filter((item) => item.batch !== next.batch), entry].slice(-8).sort((a, b) =>
            a.batch - b.batch
          )
        })
      }
      let retainedId = request.planId
      if (mode === "restore") {
        const saved = await transport.readSavedWeek(week, scope, controller.signal)
        if (!isCurrent()) return
        setPlan(saved.plan)
        update({ monday: saved.monday })
        preferences.rememberWeek(saved.monday)
        if (saved.plan === null) {
          update({ missingPlan: true })
          const recorded = await transport.readRecordedWeek(saved.monday, scope, controller.signal, onProgress)
          if (!isCurrent()) return
          setPlan(recorded)
          update({ monday: recorded.monday, fresh: true, missingPlan: recorded.sessionScanAvailable === false })
          return
        }
        retainedId = saved.plan.planId
      }
      let next: WeekPlanResponse
      if (mode === "full") next = await transport.readWeek(week, scope, controller.signal, onProgress)
      else {
        if (retainedId === undefined) {
          throw new Api.RequestFailure({ status: 409, message: "No saved plan is available. Choose Rescan sessions." })
        }
        next = await transport.refreshRecordedTime(retainedId, controller.signal, onProgress)
      }
      if (!isCurrent()) return
      setPlan(next)
      update({ monday: next.monday, fresh: true, missingPlan: next.sessionScanAvailable === false })
      preferences.rememberWeek(next.monday)
    } catch (cause) {
      if (isCurrent()) update({ failure: messageOf(cause) })
    } finally {
      if (active === controller) update({ loading: false })
    }
  }

  const refreshRecorded = () => {
    const current = registry.get(state)
    return current.plan === null
      ? load({ week: current.monday, scope: current.scope, mode: "restore" })
      : load({ week: current.plan.monday, scope: current.plan.scope, mode: "recorded", planId: current.plan.planId })
  }

  /** The lock ends when the mutation settles; the following totals read remains replaceable by navigation. */
  const mutate = async (action: () => Promise<void>): Promise<boolean> => {
    if (registry.get(state).unavailable) return false
    update({ busy: true, actionFailure: null, written: null })
    try {
      await action()
      return true
    } catch (cause) {
      update({ actionFailure: messageOf(cause) })
      return false
    } finally {
      update({ busy: false })
    }
  }

  const write = async (command: WeekWrite) => {
    const allowed = registry.get(state).writeTargets
    const requested = command.request.targets ?? allowed
    const targets = { jira: allowed.jira && requested.jira, clockify: allowed.clockify && requested.clockify }
    if (!targets.jira && !targets.clockify) return false
    const accepted = await mutate(async () => {
      registry.set(
        atoms.write,
        command.kind === "confirm"
          ? { kind: "confirm", request: { ...command.request, targets } }
          : { kind: "manual", request: { ...command.request, targets } }
      )
      const written = await Effect.runPromise(AtomRegistry.getResult(registry, atoms.write, { suspendOnWaiting: true }))
      update({ written, fresh: false })
    })
    if (accepted) void refreshRecorded()
    return accepted
  }

  const refreshAfterQueue = () => {
    if (disposed || dispatching || registry.get(atoms.queued).length > 0 || !queueNeedsRefresh) return
    queueNeedsRefresh = false
    update({ fresh: false })
    void refreshRecorded()
  }

  const recordQueueFailure = (message: string) => {
    const previous = registry.get(status).actionFailure
    update({ actionFailure: previous === null ? message : `${previous}\n${message}` })
  }

  /** Dispatch ready items in click order; a provider write is never interrupted or retried. */
  const dispatchQueue = async () => {
    if (disposed || dispatching) return
    dispatching = true
    update({ queueRunning: true })
    try {
      while (!disposed) {
        const item = registry.get(atoms.queued)[0]
        if (item === undefined || !ready.has(item.id)) break
        ready.delete(item.id)
        const allowed = registry.get(state).writeTargets
        const requested = item.request.targets
        const targets = {
          jira: allowed.jira && requested?.jira === true,
          clockify: allowed.clockify && requested?.clockify === true
        }
        if (!targets.jira && !targets.clockify) {
          registry.update(atoms.queued, (items) => items.filter((held) => held.id !== item.id))
          continue
        }
        const saving: QueuedConfirmation = {
          ...item,
          status: "saving",
          request: { ...item.request, targets },
          entries: item.entries.filter((entry) => targets[entry.source])
        }
        registry.update(atoms.queued, (items) => items.map((held) => held.id === item.id ? saving : held))
        queueNeedsRefresh = true
        try {
          registry.set(atoms.writeQueued, saving)
          const written = await Effect.runPromise(
            AtomRegistry.getResult(registry, atoms.writeQueued, { suspendOnWaiting: true })
          )
          update({ written })
          const failures = (["jira", "clockify"] satisfies ReadonlyArray<keyof typeof targets>).flatMap((provider) => {
            const outcome = written[provider]
            const label = provider === "jira" ? "Jira" : "Clockify"
            if (outcome._tag === "NotLoggedIn") return [`${label} is not logged in`]
            return outcome._tag === "Refused" ? [`${label}: ${outcome.message}`] : []
          })
          if (failures.length > 0) recordQueueFailure(failures.join("; "))
        } catch (cause) {
          recordQueueFailure(messageOf(cause))
        }
      }
    } finally {
      dispatching = false
      update({
        queueRunning: false,
        ...(queueNeedsRefresh && registry.get(atoms.queued).length === 0 && { fresh: false })
      })
      refreshAfterQueue()
    }
  }

  /** Capture one block and the selected targets now; subsequent layer choices can only narrow them. */
  const queueConfirm = (request: { readonly rowId: string; readonly blocks: ReadonlyArray<number> }): boolean => {
    const current = registry.get(state)
    const block = request.blocks[0]
    if (
      disposed || current.queueUnavailable || current.plan === null || request.blocks.length !== 1 ||
      block === undefined
    ) return false
    const row = current.plan.rows.find((row) => row.rowId === request.rowId)
    if (
      row === undefined ||
      current.queued.some((item) => item.request.rowId === row.rowId && item.request.blocks?.includes(block)) ||
      current.optimisticEntries.some((entry) =>
        entry.rowId === row.rowId && (entry.blocks === undefined || entry.blocks.includes(block))
      )
    ) return false
    const captured = { planId: current.plan.planId, rowId: row.rowId, blocks: [block], targets: current.writeTargets }
    const entries = previewWrite(registry.get(atoms.source), { kind: "confirm", request: captured })
    if (entries.length === 0) return false
    const id = `approval:${++nextQueueId}`
    const item: QueuedConfirmation = {
      id,
      ticketKey: row.ticketKey,
      day: row.day,
      status: "queued",
      undoUntil: preferences.now() + 5000,
      startMs: Math.min(...entries.map((entry) => entry.startMs)),
      endMs: Math.max(...entries.map((entry) => entry.endMs)),
      request: captured,
      entries: entries.map((entry) => ({ ...entry, id: `${id}:${entry.source}` }))
    }
    update({ ...(!current.queueActive && { actionFailure: null }), written: null })
    registry.update(atoms.queued, (items) => [...items, item])
    const cancelTimer = Effect.runCallback(queueDelay(5000), {
      onExit: (exit) => {
        queueTimers.delete(id)
        if (Exit.isSuccess(exit) && !disposed) {
          ready.add(id)
          void dispatchQueue()
        }
      }
    })
    queueTimers.set(id, cancelTimer)
    return true
  }

  const undoQueued = (id: string): boolean => {
    const item = registry.get(atoms.queued).find((item) => item.id === id)
    if (item?.status !== "queued") return false
    queueTimers.get(id)?.()
    queueTimers.delete(id)
    ready.delete(id)
    registry.update(atoms.queued, (items) => items.filter((item) => item.id !== id))
    void dispatchQueue()
    return true
  }

  return {
    state,
    toggleLayer: (layer: keyof CalendarLayers | "all") => {
      const current = registry.get(status)
      if (current.busy && (layer === "jira" || layer === "clockify")) return
      update({
        layers: layer === "jira" || layer === "clockify"
          ? { ...current.layers, [layer]: !current.layers[layer] }
          : { ...current.layers, available: layer !== "overlapping", overlapping: layer !== "available" }
      })
    },
    initialize: () => {
      // React may replay setup on the same memoized review. Cancelled timers stay cancelled;
      // an already dispatched write keeps its lock and refreshes normally after settlement.
      disposed = false
      if (!dispatching) queueNeedsRefresh = false
      const current = registry.get(status)
      return load({ week: current.monday, scope: current.scope, mode: "restore" })
    },
    dispose: () => {
      disposed = true
      active?.abort()
      for (const cancelTimer of queueTimers.values()) cancelTimer()
      queueTimers.clear()
      ready.clear()
      registry.update(atoms.queued, (items) => items.filter((item) => item.status === "saving"))
      update({ fresh: false })
    },
    navigate: (week: string | undefined, scope: WeekScopeName) => {
      if (readLocked()) return Promise.resolve()
      update({ actionFailure: null, written: null })
      return load({ week, scope, mode: "restore" })
    },
    chooseScope: (scope: WeekScopeName) => {
      if (readLocked()) return Promise.resolve()
      preferences.rememberScope(scope)
      return load({ week: registry.get(status).monday, scope, mode: "restore" })
    },
    rescan: () => {
      if (readLocked()) return Promise.resolve()
      const current = registry.get(status)
      update({ configurationChanged: false })
      return load({ week: current.monday, scope: current.scope, mode: "full" })
    },
    refreshRecorded,
    retry: () => lastRead === null ? Promise.resolve() : load(lastRead),
    cancel: () => {
      if (registry.get(state).queueActive) return
      active?.abort()
      update({ loading: false, cancelled: true, fresh: false })
    },
    markConfigurationChanged: () => update({ configurationChanged: true }),
    clearWritten: () => update({ written: null }),
    queueConfirm,
    undoQueued,
    confirm: (request: Omit<Api.ConfirmRequest, "planId">) => {
      const plan = registry.get(state).plan
      return plan === null
        ? Promise.resolve(false)
        : write({ kind: "confirm", request: { ...request, planId: plan.planId } })
    },
    logManual: (request: Parameters<typeof Api.logManual>[0]) => write({ kind: "manual", request }),
    updateSaved: async (edit: SavedEntryEdit) => {
      if (!registry.get(state).writeTargets[edit.entry.source]) return false
      const accepted = await mutate(async () => {
        registry.set(atoms.editSaved, edit)
        await Effect.runPromise(AtomRegistry.getResult(registry, atoms.editSaved, { suspendOnWaiting: true }))
        update({ fresh: false })
      })
      if (accepted) void refreshRecorded()
      return accepted
    },
    mapStanding: (request: Parameters<typeof Api.mapStandingAttribution>[0]) =>
      mutate(async () => {
        await transport.mapStandingAttribution(request)
        update({ configurationChanged: true })
      }),
    markMine: (request: Parameters<typeof Api.markTicketMine>[0]) =>
      mutate(async () => {
        await transport.markTicketMine(request)
        update({ configurationChanged: true })
      })
  }
}
