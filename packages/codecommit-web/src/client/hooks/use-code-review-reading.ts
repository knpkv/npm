/** One explicit, cancellable review read. No owner API client, commands, polling or cross-target cache. @module */
import { Cause, Effect, Exit, Fiber, Result } from "effect"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CodeReference, CodeReviewResult } from "../../host-contract.js"
import type { CodeReadState } from "../components/host-code-view.js"

export interface CodeReviewReadError {
  readonly _tag: string
  readonly reason: NonNullable<CodeReadState<never>["failure"]>
}
export type CodeReviewReadFailure =
  | { readonly _tag: "Expected"; readonly reason: CodeReviewReadError["reason"] }
  | { readonly _tag: "Unexpected" }

/** Accepted completed request for the current ref. UI announcement identity only, never authority. */
export interface CodeReviewReadCompletion {
  readonly ref: CodeReference
  readonly id: number
}

export type CodeReviewReadState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Paused"; readonly ref: CodeReference; readonly previous: CodeReviewResult | null }
  | { readonly _tag: "Loading"; readonly ref: CodeReference; readonly previous: CodeReviewResult | null }
  | { readonly _tag: "Ready"; readonly ref: CodeReference; readonly value: CodeReviewResult }
  | { readonly _tag: "Failed"; readonly ref: CodeReference; readonly failure: CodeReviewReadFailure }
  | {
    readonly _tag: "Retained"
    readonly ref: CodeReference
    readonly value: CodeReviewResult
    readonly failure: CodeReviewReadFailure
  }

export interface CodeReviewReadOptions {
  readonly ref: CodeReference | null
  /** False for inactive or hidden owners. Reactivation reads once, without a poll. */
  readonly enabled: boolean
  /** Latest host-owned callback is used on the next requested read. Identity changes do not restart a request. */
  readonly read: (ref: CodeReference) => Effect.Effect<CodeReviewResult, CodeReviewReadError>
}

const valueOf = (state: CodeReviewReadState, ref: CodeReference): CodeReviewResult | null => {
  if (state._tag === "Idle" || state.ref !== ref) return null
  switch (state._tag) {
    case "Ready":
    case "Retained":
      return state.value
    case "Paused":
    case "Loading":
      return state.previous
    case "Failed":
      return null
  }
}

/** Retained output is explicitly previous. Missing/revoked authorization never retains a protected result. */
export function useCodeReviewReading({ enabled, read, ref }: CodeReviewReadOptions) {
  const [state, setState] = useState<CodeReviewReadState>({ _tag: "Idle" })
  const [refresh, setRefresh] = useState(0)
  const current = useRef({ enabled, ref, read })
  const sequence = useRef(0)
  const completed = useRef<CodeReviewReadCompletion | null>(null)
  const started = useRef<{ readonly ref: CodeReference; readonly id: number; readonly refresh: number } | null>(null)
  const inFlight = useRef<{ readonly ref: CodeReference; readonly id: number } | null>(null)
  useLayoutEffect(() => {
    current.current = { enabled, ref, read }
  }, [enabled, ref, read])
  const readAgain = useCallback(() => {
    const owner = current.current
    if (!owner.enabled || owner.ref === null || inFlight.current !== null) return
    setRefresh((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!enabled || ref === null) return
    const id = ++sequence.current
    started.current = { ref, id, refresh }
    inFlight.current = { ref, id }
    const requestRead = current.current.read
    let live = true
    const ownsRequest = () =>
      live && current.current.enabled && current.current.ref === ref && inFlight.current?.id === id
    const pass = Effect.gen(function*() {
      yield* Effect.sync(() => setState((previous) => ({ _tag: "Loading", ref, previous: valueOf(previous, ref) })))
      const answer = yield* Effect.exit(requestRead(ref))
      if (!ownsRequest()) return
      if (Exit.isSuccess(answer)) {
        yield* Effect.sync(() => {
          if (!ownsRequest()) return
          completed.current = { ref, id }
          setState({ _tag: "Ready", ref, value: answer.value })
        })
      } else {
        const error = Cause.findError(answer.cause)
        const failure: CodeReviewReadFailure = Result.isSuccess(error)
          ? { _tag: "Expected", reason: error.success.reason }
          : { _tag: "Unexpected" }
        if (failure._tag === "Unexpected") yield* Effect.logError("Review read failed without an expected reason")
        yield* Effect.sync(() => {
          if (!ownsRequest()) return
          completed.current = { ref, id }
          setState((previous) => {
            const value = valueOf(previous, ref)
            const refuseRetention = failure._tag === "Expected" &&
              (failure.reason === "unauthorized" || failure.reason === "not_found")
            return value === null || refuseRetention
              ? { _tag: "Failed", ref, failure }
              : { _tag: "Retained", ref, value, failure }
          })
        })
      }
      if (inFlight.current?.id === id) inFlight.current = null
    })
    const fiber = Effect.runFork(pass)
    return () => {
      live = false
      if (inFlight.current?.id === id) inFlight.current = null
      if (started.current?.id === id) started.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [enabled, ref, refresh])

  const visibleState: CodeReviewReadState = ref === null
    ? { _tag: "Idle" }
    : !enabled
    ? { _tag: "Paused", ref, previous: valueOf(state, ref) }
    : started.current?.ref !== ref || started.current.refresh !== refresh || state._tag === "Idle" || state.ref !== ref
    ? { _tag: "Loading", ref, previous: valueOf(state, ref) }
    : state
  const completion = enabled && completed.current?.ref === ref &&
      (visibleState._tag === "Ready" || visibleState._tag === "Retained" || visibleState._tag === "Failed")
    ? completed.current :
    null
  return { state: visibleState, readAgain, completion }
}
