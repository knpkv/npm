import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

const resource = {
  serviceName: "control-center"
}

const activation = Config.all({
  disabled: Config.boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false)),
  logsExporters: Config.string("OTEL_LOGS_EXPORTER").pipe(Config.withDefault("")),
  logsProtocol: Config.string("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL").pipe(Config.withDefault("")),
  protocol: Config.string("OTEL_EXPORTER_OTLP_PROTOCOL").pipe(Config.withDefault("http/protobuf")),
  tracesExporters: Config.string("OTEL_TRACES_EXPORTER").pipe(Config.withDefault("")),
  tracesProtocol: Config.string("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").pipe(Config.withDefault(""))
})

const includesOtlp = (exporters: string): boolean =>
  exporters.split(",").some((exporter) => exporter.trim().toLowerCase() === "otlp")

const OtlpHttpProtocol = Schema.Literals(["http/json", "http/protobuf"])
type OtlpHttpProtocol = typeof OtlpHttpProtocol.Type
type OtlpSignal = "logs" | "traces"

class ObservabilityConfigurationError extends Schema.TaggedErrorClass<ObservabilityConfigurationError>()(
  "ObservabilityConfigurationError",
  {
    reason: Schema.Literal("unsupported-protocol"),
    signal: Schema.Literals(["logs", "traces"])
  }
) {}

const resolveProtocol = Effect.fn("ControlCenterObservability.resolveProtocol")(function*(
  signal: OtlpSignal,
  signalProtocol: string,
  baseProtocol: string
) {
  const protocol = (signalProtocol.trim() === "" ? baseProtocol : signalProtocol).trim().toLowerCase()
  return yield* Schema.decodeUnknownEffect(OtlpHttpProtocol)(protocol).pipe(
    Effect.mapError(() => new ObservabilityConfigurationError({ reason: "unsupported-protocol", signal }))
  )
})

const defaultEndpointLayer = ConfigProvider.layerAdd(
  ConfigProvider.fromEnv({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" } })
)

const serializationLayer = (protocol: OtlpHttpProtocol) =>
  protocol === "http/json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf

const loggerLayer = (protocol: OtlpHttpProtocol) =>
  OtlpLogger.layerFromConfig({ resource }).pipe(
    Layer.provide(serializationLayer(protocol)),
    Layer.provide(defaultEndpointLayer)
  )

const tracerLayer = (protocol: OtlpHttpProtocol) =>
  OtlpTracer.layerFromConfig({ resource }).pipe(
    Layer.provide(serializationLayer(protocol)),
    Layer.provide(defaultEndpointLayer)
  )

export const controlCenterTelemetryLayer = Effect.gen(function*() {
  const configured = yield* activation
  if (configured.disabled) return Layer.empty

  const logsEnabled = includesOtlp(configured.logsExporters)
  const tracesEnabled = includesOtlp(configured.tracesExporters)
  const logsProtocol = logsEnabled
    ? yield* resolveProtocol("logs", configured.logsProtocol, configured.protocol)
    : "http/protobuf"
  const tracesProtocol = tracesEnabled
    ? yield* resolveProtocol("traces", configured.tracesProtocol, configured.protocol)
    : "http/protobuf"

  return Layer.merge(
    logsEnabled ? loggerLayer(logsProtocol) : Layer.empty,
    tracesEnabled ? tracerLayer(tracesProtocol) : Layer.empty
  )
}).pipe(Layer.unwrap)

export const ControlCenterObservabilityLive = controlCenterTelemetryLayer.pipe(Layer.provide(FetchHttpClient.layer))
