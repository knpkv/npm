/**
 * Jotai atoms for timer state and actions (start/stop), bridged from {@link TimerService}.
 *
 * @internal
 */
import { Atom } from "@effect-atom/atom-react"
import { Effect } from "effect"
import type { JiraTicket } from "../../services/TicketService.js"
import { type StopOptions, TimerService } from "../../services/TimerService.js"
import { runtimeAtom } from "./runtime.js"

export const timerStateAtom = runtimeAtom.subscribable(
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
