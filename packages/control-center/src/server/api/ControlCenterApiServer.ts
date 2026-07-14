import * as Layer from "effect/Layer"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../api/controlCenterApi.js"
import { mutationCsrfLayer, sessionCookieAuthLayer } from "./ApiMiddleware.js"
import { mediaHandlersLayer, pluginHandlersLayer, portfolioHandlersLayer, sessionHandlersLayer } from "./Handlers.js"

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
  mediaHandlersLayer
).pipe(Layer.provide(controlCenterApiMiddlewareLayer))

/** Routes for the browser-safe ControlCenterApi contract. */
export const controlCenterApiLayer = HttpApiBuilder.layer(ControlCenterApi).pipe(
  Layer.provide(controlCenterApiHandlersLayer)
)
