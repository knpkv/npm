import { Predicate } from "effect"
import type { AtomRegistry } from "effect/unstable/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { describeRow, RequestFailure } from "./api.js"

interface DescriptionDraft {
  readonly text: string
  readonly edited: boolean
  readonly status: "idle" | "loading" | "ready" | "empty" | "failed"
  readonly failure: string | null
}

/** One row's draft survives switching blocks; a late suggestion never replaces a person's edits. */
const makeDraft = (
  registry: AtomRegistry.AtomRegistry,
  request: { readonly planId: string; readonly rowId: string },
  describe: typeof describeRow
) => {
  const state = Atom.keepAlive(Atom.make<DescriptionDraft>({ text: "", edited: false, status: "idle", failure: null }))
  let active: AbortController | null = null
  const load = async () => {
    const before = registry.get(state)
    if (active !== null || before.edited || before.status === "ready") return
    const controller = new AbortController()
    active = controller
    registry.set(state, { ...before, status: "loading", failure: null })
    const isCurrent = () => active === controller && !controller.signal.aborted
    try {
      const response = await describe(request, controller.signal)
      if (!isCurrent()) return
      if (response.planId !== request.planId || response.rowId !== request.rowId) {
        throw new RequestFailure({ message: "The description belongs to another suggestion. Try again.", status: 409 })
      }
      registry.update(state, (draft): DescriptionDraft => ({
        ...draft,
        text: draft.edited ? draft.text : (response.note ?? ""),
        status: draft.edited || response.note !== null ? "ready" : "empty"
      }))
    } catch (cause) {
      if (!isCurrent()) return
      registry.update(state, (draft): DescriptionDraft => ({
        ...draft,
        status: "failed",
        failure: Predicate.isError(cause) ? cause.message : String(cause)
      }))
    } finally {
      if (isCurrent()) active = null
    }
  }
  const cancel = () => {
    active?.abort()
    active = null
    registry.update(
      state,
      (draft): DescriptionDraft => draft.status === "loading" ? { ...draft, status: "idle" } : draft
    )
  }
  return {
    state,
    load,
    edit: (text: string) => registry.update(state, (draft): DescriptionDraft => ({ ...draft, text, edited: true })),
    cancel,
    invalidate: () => {
      cancel()
      registry.update(state, (draft): DescriptionDraft => ({
        text: draft.edited ? draft.text : "",
        edited: draft.edited,
        status: draft.edited ? "ready" : "idle",
        failure: null
      }))
    }
  }
}

export type RowDescriptionDraft = ReturnType<typeof makeDraft>

/** The mounted app owns draft lifetime. Totals refresh keeps them; replacement plans discard them. */
export const makeRowDescriptions = (
  registry: AtomRegistry.AtomRegistry,
  describe: typeof describeRow = describeRow
) => {
  const drafts = new Map<string, { readonly planId: string; readonly draft: RowDescriptionDraft }>()
  return {
    get: (planId: string, rowId: string) => {
      const key = JSON.stringify([planId, rowId])
      const held = drafts.get(key)
      if (held !== undefined) return held.draft
      const draft = makeDraft(registry, { planId, rowId }, describe)
      drafts.set(key, { planId, draft })
      return draft
    },
    retain: (planId: string | undefined) => {
      for (const [key, held] of drafts) {
        if (held.planId !== planId) {
          held.draft.cancel()
          drafts.delete(key)
        }
      }
    },
    invalidate: () => {
      for (const { draft } of drafts.values()) draft.invalidate()
    },
    dispose: () => {
      for (const { draft } of drafts.values()) draft.cancel()
    }
  }
}
