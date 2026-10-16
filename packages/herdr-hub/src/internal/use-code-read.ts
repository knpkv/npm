import type { CodeReadState } from "@knpkv/codecommit-web/views"
import { Cause, Effect, Exit, Fiber, Result, Schedule } from "effect"
import { useEffect, useRef, useState } from "react"
import type { CodeReadFailed } from "../code-client.js"

export const emptyCodeRead = <A>(): CodeReadState<A> => ({ value: null, loading: false, failure: null })

/**
 * Query identity prevents stale targets. Up to 16 successful explicit reads survive Back/Forward;
 * Read again clears them. Cached queue polls remain serial. Inactive reads are interrupted.
 */
export const useCodeRead = <A>(
  key: string,
  read: Effect.Effect<A, CodeReadFailed>,
  enabled: boolean,
  poll: boolean,
  refresh: number
) => {
  const [state, setState] = useState<{ readonly key: string; readonly reading: CodeReadState<A> }>({
    key,
    reading: emptyCodeRead()
  })
  const cache = useRef(new Map<string, A>())
  const generation = useRef(refresh)
  useEffect(() => {
    if (generation.current !== refresh) {
      cache.current.clear()
      generation.current = refresh
    }
    if (!enabled) return
    if (!poll && cache.current.has(key)) {
      const value = cache.current.get(key)
      if (value !== undefined) {
        setState({ key, reading: { value, loading: false, failure: null } })
        return
      }
    }
    let current = true
    const pass = Effect.gen(function*() {
      yield* Effect.sync(() =>
        setState((previous) => ({
          key,
          reading: {
            ...(previous.key === key ? previous.reading : emptyCodeRead<A>()),
            loading: true
          }
        }))
      )
      const answer = yield* Effect.exit(poll ? Effect.sleep("200 millis").pipe(Effect.andThen(read)) : read)
      if (!current) return
      if (!poll && Exit.isSuccess(answer)) {
        cache.current.delete(key)
        cache.current.set(key, answer.value)
        if (cache.current.size > 16) {
          const oldest = cache.current.keys().next().value
          if (oldest !== undefined) cache.current.delete(oldest)
        }
      }
      const failure = Exit.isFailure(answer) ? Cause.findError(answer.cause) : null
      yield* Effect.sync(() =>
        setState((previous) => ({
          key,
          reading: Exit.isSuccess(answer)
            ? { value: answer.value, loading: false, failure: null }
            : {
              value: previous.key === key ? previous.reading.value : null,
              loading: false,
              failure: failure !== null && Result.isSuccess(failure) ? failure.success.reason : "status"
            }
        }))
      )
    })
    const fiber = Effect.runFork(poll ? pass.pipe(Effect.repeat(Schedule.spaced("60 seconds"))) : pass)
    return () => {
      current = false
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [key, read, enabled, poll, refresh])
  return state.key === key ? state.reading : emptyCodeRead<A>()
}
