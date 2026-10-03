import { Data, Effect, Predicate } from "effect"
import { Atom } from "effect/unstable/reactivity"
import type {
  ManualPayload,
  SavedEntry,
  UpdateSavedEntryRequest,
  WeekPlanResponse,
  WriteResultResponse
} from "../shared/contracts.js"
import { consumedFromWeekBlocks, prepareProposal } from "../shared/writePlanning.js"
import { type ConfirmRequest, confirmRow, logManual, updateSavedEntry } from "./api.js"

export type WeekWrite =
  | { readonly kind: "confirm"; readonly request: ConfirmRequest }
  | { readonly kind: "manual"; readonly request: typeof ManualPayload.Type }

/** Browser-only preview. The provider read replaces these intervals after confirmation. */
export interface OptimisticEntry {
  readonly id: string
  readonly source: "jira" | "clockify"
  readonly ticketKey: string | null
  readonly startMs: number
  readonly endMs: number
  readonly description: string | null
  readonly pending: boolean
  readonly rowId: string | undefined
  readonly blocks: ReadonlyArray<number> | undefined
  readonly replaces?: { readonly source: "jira" | "clockify"; readonly id: string }
  readonly entry?: SavedEntry
}

export interface WeekView {
  readonly plan: WeekPlanResponse | null
  readonly entries: ReadonlyArray<OptimisticEntry>
}

/** One quick approval, retained until Undo or its dispatched provider write settles. */
export interface QueuedConfirmation {
  readonly id: string
  readonly ticketKey: string
  readonly day: string
  readonly status: "queued" | "saving"
  readonly undoUntil: number
  readonly startMs: number
  readonly endMs: number
  readonly request: ConfirmRequest
  readonly entries: ReadonlyArray<OptimisticEntry>
}

/** Plan the preview with confirmation's planner, using the last provider totals. */
export const previewWrite = (view: WeekView, write: WeekWrite): ReadonlyArray<OptimisticEntry> => {
  const { request } = write
  if (write.kind === "manual") {
    const startMs = new Date(`${write.request.day}T${write.request.startClock ?? "12:00"}:00`).getTime()
    const targets = write.request.targets ?? { jira: true, clockify: true }
    return (["jira", "clockify"] satisfies Array<OptimisticEntry["source"]>).flatMap((source) =>
      targets[source] ?
        [{
          id: `optimistic:${view.entries.length}:${source}`,
          source,
          ticketKey: write.request.ticketKey,
          startMs,
          endMs: startMs + write.request.seconds * 1000,
          description: write.request.note ?? null,
          pending: true,
          rowId: undefined,
          blocks: undefined
        }] :
        []
    )
  }
  const plan = view.plan
  const row = plan?.rows.find((row) => row.rowId === write.request.rowId)
  if (plan === null || row?.proposal === undefined) return []
  const prepared = prepareProposal({
    evidence: {
      blocks: row.proposal.blocks,
      credited: row.proposal.maxSeconds,
      ticketKey: row.ticketKey,
      day: row.day
    },
    request,
    targets: { jira: plan.scope !== "clockify", clockify: plan.scope !== "jira" },
    consumed: consumedFromWeekBlocks(row.proposal.blocks)
  })
  if (prepared._tag !== "Prepared") return []
  const sized = prepared.plan(plan.rows)
  if (sized._tag !== "Write") return []
  return (["jira", "clockify"] satisfies Array<OptimisticEntry["source"]>).flatMap((source) => {
    return sized[source].segments.map((segment, index) => {
      const startMs = segment.startedAt.getTime()
      return {
        id: `optimistic:${view.entries.length}:${source}:${String(index)}`,
        source,
        ticketKey: sized.ticketKey,
        startMs,
        endMs: startMs + segment.seconds * 1000,
        description: request.note ?? row.ticketTitle,
        pending: true,
        rowId: row.rowId,
        blocks: write.request.blocks
      }
    })
  })
}

/** Settle each provider independently. Failed and skipped writes never become saved entries. */
export const settleEntries = (
  entries: ReadonlyArray<OptimisticEntry>,
  result: WriteResultResponse
): ReadonlyArray<OptimisticEntry> => {
  const settled: Array<OptimisticEntry> = []
  for (const source of ["jira", "clockify"] satisfies ReadonlyArray<OptimisticEntry["source"]>) {
    const template = entries.find((entry) => entry.source === source)
    const outcome = result[source]
    if (template === undefined || (outcome._tag !== "Written" && outcome._tag !== "PartiallyWritten")) continue
    const segments = outcome.segments ?? [{
      startMs: template.startMs,
      endMs: template.startMs + outcome.seconds * 1000
    }]
    for (const [index, segment] of segments.entries()) {
      settled.push({
        ...template,
        id: index === 0 ? template.id : `${template.id}:${String(index)}`,
        pending: false,
        startMs: segment.startMs,
        endMs: segment.endMs,
        description: result.description
      })
    }
  }
  return settled
}

class WeekWriteError extends Data.TaggedError("WeekWriteError")<{ readonly message: string }> {}

export interface SavedEntryEdit {
  readonly entry: SavedEntry
  readonly request: UpdateSavedEntryRequest
}

/** Replace one provider's whole entry while keeping other queued or settled previews. */
const editedView = (view: WeekView, entry: SavedEntry, pending: boolean): WeekView => ({
  ...view,
  entries: [
    ...view.entries.filter((item) => item.replaces?.source !== entry.source || item.replaces.id !== entry.id),
    {
      ...entry,
      id: `edit:${entry.source}:${entry.id}`,
      replaces: { source: entry.source, id: entry.id },
      entry,
      pending,
      rowId: undefined,
      blocks: undefined
    }
  ]
})

/** One atom set per mounted week view; rejected mutations roll back to its last confirmed value. */
export const makeWeekAtoms = (transport: {
  readonly confirmRow: typeof confirmRow
  readonly logManual: typeof logManual
  readonly updateSavedEntry: typeof updateSavedEntry
} = { confirmRow, logManual, updateSavedEntry }) => {
  const source = Atom.make<WeekView>({ plan: null, entries: [] })
  const queued = Atom.make<ReadonlyArray<QueuedConfirmation>>([])
  // Optimistic completion refreshes its source. Refresh the projection, preserving the stored snapshot.
  const visible = Atom.optimistic(Atom.make((get): WeekView => {
    const held = get(source)
    return { ...held, entries: [...held.entries, ...get(queued).flatMap((item) => item.entries)] }
  }))
  // Queue previews are already visible before dispatch. This mutation only settles its own item,
  // preserving approvals added while this provider request was running.
  const writeQueued = Atom.fn<QueuedConfirmation>()((item, get) =>
    Effect.gen(function*() {
      const result = yield* Effect.tryPromise({
        try: () => transport.confirmRow(item.request),
        catch: (cause) => new WeekWriteError({ message: Predicate.isError(cause) ? cause.message : String(cause) })
      })
      const held = get(source)
      get.set(source, { ...held, entries: [...held.entries, ...settleEntries(item.entries, result)] })
      return result
    }).pipe(Effect.ensuring(Effect.sync(() => {
      get.set(queued, get(queued).filter((held) => held.id !== item.id))
    })))
  )
  const write = Atom.optimisticFn(visible, {
    reducer: (view, write: WeekWrite) => ({ ...view, entries: [...view.entries, ...previewWrite(view, write)] }),
    fn: (set) =>
      Atom.fn<WeekWrite>()((write, get) =>
        Effect.gen(function*() {
          const before = get(source)
          const pending = previewWrite(before, write)
          const result = yield* Effect.tryPromise({
            try: () =>
              write.kind === "confirm" ? transport.confirmRow(write.request) : transport.logManual(write.request),
            catch: (cause) => new WeekWriteError({ message: Predicate.isError(cause) ? cause.message : String(cause) })
          })
          const settled = { ...before, entries: [...before.entries, ...settleEntries(pending, result)] }
          get.set(source, settled)
          set(settled)
          return result
        })
      )
  })
  const editSaved = Atom.optimisticFn(visible, {
    reducer: (view, edit: SavedEntryEdit) =>
      editedView(view, {
        ...edit.entry,
        startMs: edit.request.startMs,
        endMs: edit.request.endMs,
        description: edit.request.description
      }, true),
    fn: (set) =>
      Atom.fn<SavedEntryEdit>()((edit, get) =>
        Effect.gen(function*() {
          const update = transport.updateSavedEntry
          if (update === undefined) {
            return yield* new WeekWriteError({ message: "Saved-entry updates are unavailable." })
          }
          const result = yield* Effect.tryPromise({
            try: () => update(edit.request),
            catch: (cause) => new WeekWriteError({ message: Predicate.isError(cause) ? cause.message : String(cause) })
          })
          const settled = editedView(get(source), result.entry, false)
          get.set(source, settled)
          set(settled)
          return result
        })
      )
  })
  return { source, visible, write, queued, writeQueued, editSaved }
}
