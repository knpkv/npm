/**
 * Reading an async atom for display: the newest value it has had, and why the latest read failed
 * if it did, so a failed refresh keeps showing the last good data with the failure beside it.
 *
 * @module
 */
import { Cause, Option } from "effect"
import type { AsyncResult } from "effect/reactivity"
import type { RequestFailure } from "./api.js"

export interface Shown<A> {
  readonly value: A | null
  readonly failure: string | null
}

export const shown = <A>(result: AsyncResult.AsyncResult<A, RequestFailure>): Shown<A> => {
  switch (result._tag) {
    case "Initial":
      return { value: null, failure: null }
    case "Success":
      return { value: result.value, failure: null }
    case "Failure": {
      const failure = Option.match(Cause.findErrorOption(result.cause), {
        onNone: () => "The page failed unexpectedly",
        onSome: (error) => error.message
      })
      return { value: Option.getOrNull(Option.map(result.previousSuccess, (success) => success.value)), failure }
    }
  }
}
