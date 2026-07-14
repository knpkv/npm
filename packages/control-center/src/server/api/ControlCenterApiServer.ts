import * as Layer from "effect/Layer"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../api/controlCenterApi.js"
import { mutationCsrfLayer, sessionCookieAuthLayer } from "./ApiMiddleware.js"
import {
  liveEventHandlersLayer,
  mediaHandlersLayer,
  pluginHandlersLayer,
  portfolioHandlersLayer,
  sessionHandlersLayer
} from "./Handlers.js"
import { LiveStreamAdmission } from "./LiveStreamAdmission.js"

/** Contract middleware implementations shared by every authenticated API group. */
export const controlCenterApiMiddlewareLayer = Layer.mergeAll(
  sessionCookieAuthLayer,
  mutationCsrfLayer
)

/** Complete group implementation, still requiring injectable application services. */
export const controlCenterApiHandlersLayer = Layer.mergeAll(
  sessionHandlersLayer,
  pluginHandlersLayer,
  portfolioHandlersLayer,
  mediaHandlersLayer,
  liveEventHandlersLayer
).pipe(
  Layer.provide(controlCenterApiMiddlewareLayer),
  Layer.provide(LiveStreamAdmission.layer)
)

/** Routes for the browser-safe ControlCenterApi contract. */
export const controlCenterApiLayer = HttpApiBuilder.layer(ControlCenterApi).pipe(
  Layer.provide(controlCenterApiHandlersLayer)
)
