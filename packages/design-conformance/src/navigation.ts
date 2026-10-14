import type { Frame, Page } from "@playwright/test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"

import { CaptureNavigationFailure } from "./schema.js"

type CaptureNavigation = Pick<CaptureNavigationFailure, "event" | "url">
export type NavigationSubscription = (notify: (event: CaptureNavigation) => void) => () => void

/** Only the main document changes capture identity; iframe navigation does not. */
export const subscribeCaptureNavigation = (page: Page): NavigationSubscription => (notify) => {
  const navigated = (frame: Frame) => {
    if (frame === page.mainFrame()) notify({ event: "framenavigated", url: frame.url() })
  }
  const loaded = () => notify({ event: "load", url: page.url() })
  page.on("framenavigated", navigated)
  page.on("load", loaded)
  return () => {
    page.off("framenavigated", navigated)
    page.off("load", loaded)
  }
}

/** Arm before capture and fail on navigation even when its protocol promise never settles. */
export const guardCaptureNavigation = Effect.fn("DesignConformance.captureWindow")(
  function*<A, E, R>(shot: string, subscribe: NavigationSubscription, capture: Effect.Effect<A, E, R>) {
    const navigation = yield* Deferred.make<never, CaptureNavigationFailure>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        subscribe((event) => {
          // Playwright delivers synchronous callbacks outside the Effect fiber.
          Deferred.doneUnsafe(navigation, Effect.fail(new CaptureNavigationFailure({ shot, ...event })))
        })
      ),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
    return yield* Effect.raceFirst(Deferred.await(navigation), capture)
  },
  Effect.scoped
)
