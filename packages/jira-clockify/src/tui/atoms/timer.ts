/**
 * Jotai atoms for timer state and actions (start/stop), bridged from {@link TimerService}.
 *
 * @internal
 */
import { Effect } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { JiraTicket } from "../../services/TicketService.js"
import { type StopOptions, TimerService, type WorklogParams } from "../../services/TimerService.js"
import { runtimeAtom } from "./runtime.js"

export const timerStateAtom = runtimeAtom.subscriptionRef(
  Effect.gen(function*() {
    const service = yield* TimerService
    return service.state
  })
)

export const elapsedAtom = Atom.make(0).pipe(Atom.keepAlive)

export const startTimerAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(ticket: JiraTicket) {
    const service = yield* TimerService
    yield* service.start(ticket)
  })
)

export const stopTimerAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(options?: StopOptions) {
    const service = yield* TimerService
    return yield* service.stop(options)
  })
)

// Retry just the Jira worklog after a partial stop (Clockify saved, Jira failed).
export const retryWorklogAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(params: WorklogParams) {
    const service = yield* TimerService
    return yield* service.logWorklog(params)
  })
)

export const discardTimerAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    const service = yield* TimerService
    yield* service.discard
  })
)

export const detectRunningAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    const service = yield* TimerService
    yield* service.detectRunning
  })
)
