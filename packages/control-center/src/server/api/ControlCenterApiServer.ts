import * as Layer from "effect/Layer"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../api/controlCenterApi.js"
import { ServerLifecycle } from "../runtime/ServerLifecycle.js"
import { mutationCsrfLayer, sessionCookieAuthLayer } from "./ApiMiddleware.js"
import {
  agentHandlersLayer,
  deliveryGraphHandlersLayer,
  liveEventHandlersLayer,
  mediaHandlersLayer,
  pluginHandlersLayer,
  portfolioHandlersLayer,
  sessionHandlersLayer,
  shareHandlersLayer,
  timelineHandlersLayer
} from "./Handlers.js"
import { LiveStreamAdmission } from "./LiveStreamAdmission.js"

/** Contract middleware implementations shared by every authenticated API group. */
const controlCenterApiMiddlewareLayerWithLifecycle = Layer.mergeAll(
  sessionCookieAuthLayer,
  mutationCsrfLayer
)

/** Standalone middleware composition with an isolated accepting lifecycle. */
export const controlCenterApiMiddlewareLayer = controlCenterApiMiddlewareLayerWithLifecycle.pipe(
  Layer.provide(ServerLifecycle.layer)
)

/** Complete group implementation, still requiring injectable application services. */
const controlCenterApiHandlersLayerWithLifecycle = Layer.mergeAll(
  sessionHandlersLayer,
  shareHandlersLayer,
  pluginHandlersLayer,
  portfolioHandlersLayer,
  timelineHandlersLayer,
  deliveryGraphHandlersLayer,
  agentHandlersLayer,
  mediaHandlersLayer,
  liveEventHandlersLayer
).pipe(
  Layer.provide(controlCenterApiMiddlewareLayerWithLifecycle),
  Layer.provide(LiveStreamAdmission.layer)
)

/** Standalone handler composition with an isolated accepting lifecycle. */
export const controlCenterApiHandlersLayer = controlCenterApiHandlersLayerWithLifecycle.pipe(
  Layer.provide(ServerLifecycle.layer)
)

/** API routes requiring the process lifecycle supplied by the runnable server. */
export const controlCenterApiLayerWithLifecycle = HttpApiBuilder.layer(ControlCenterApi).pipe(
  Layer.provide(controlCenterApiHandlersLayerWithLifecycle)
)

/** Routes for the browser-safe ControlCenterApi contract. */
export const controlCenterApiLayer = HttpApiBuilder.layer(ControlCenterApi).pipe(
  Layer.provide(controlCenterApiHandlersLayer)
)
