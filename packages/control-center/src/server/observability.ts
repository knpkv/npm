import * as Layer from "effect/Layer"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

const resource = {
  serviceName: "control-center"
}

export const controlCenterTelemetryLayer = Layer.merge(
  OtlpLogger.layerFromConfig({ resource }),
  OtlpTracer.layerFromConfig({ resource })
).pipe(Layer.provide(OtlpSerialization.layerJson))

export const ControlCenterObservabilityLive = controlCenterTelemetryLayer.pipe(Layer.provide(FetchHttpClient.layer))
