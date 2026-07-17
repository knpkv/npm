import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { ApplicationServiceUnavailable, TimelineExportAudits } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

/** Construct the durable Timeline export attribution seam. */
export const makeTimelineExportAudits = Effect.gen(function*() {
  const persistence = yield* Persistence

  return TimelineExportAudits.of({
    record: Effect.fn("TimelineExportAudits.record")(function*(input) {
      yield* persistence.timelineExportAudits.record(input).pipe(Effect.mapError(unavailable))
    })
  })
})

/** Live durable Timeline export attribution layer. */
export const timelineExportAuditsLayer = Layer.effect(TimelineExportAudits, makeTimelineExportAudits)
