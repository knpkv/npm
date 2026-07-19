import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

const resource = {
  serviceName: "control-center"
}

const activation = Config.all({
  disabled: Config.boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false)),
  logsExporters: Config.string("OTEL_LOGS_EXPORTER").pipe(Config.withDefault("")),
  tracesExporters: Config.string("OTEL_TRACES_EXPORTER").pipe(Config.withDefault(""))
})

const includesOtlp = (exporters: string): boolean =>
  exporters.split(",").some((exporter) => exporter.trim().toLowerCase() === "otlp")

export const controlCenterTelemetryLayer = Effect.gen(function*() {
  const configured = yield* activation
  if (configured.disabled) return Layer.empty

  return Layer.merge(
    includesOtlp(configured.logsExporters) ? OtlpLogger.layerFromConfig({ resource }) : Layer.empty,
    includesOtlp(configured.tracesExporters) ? OtlpTracer.layerFromConfig({ resource }) : Layer.empty
  )
}).pipe(
  Effect.orDie,
  Layer.unwrap,
  Layer.provide(OtlpSerialization.layerJson)
)

export const ControlCenterObservabilityLive = controlCenterTelemetryLayer.pipe(Layer.provide(FetchHttpClient.layer))
