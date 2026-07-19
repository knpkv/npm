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
  baseEndpoint: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.withDefault("")),
  disabled: Config.string("OTEL_SDK_DISABLED").pipe(Config.withDefault("")),
  logsEndpoint: Config.string("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT").pipe(Config.withDefault("")),
  logsExporters: Config.string("OTEL_LOGS_EXPORTER").pipe(Config.withDefault("")),
  logsProtocol: Config.string("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL").pipe(Config.withDefault("")),
  protocol: Config.string("OTEL_EXPORTER_OTLP_PROTOCOL").pipe(Config.withDefault("http/protobuf")),
  tracesEndpoint: Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").pipe(Config.withDefault("")),
  tracesExporters: Config.string("OTEL_TRACES_EXPORTER").pipe(Config.withDefault("")),
  tracesProtocol: Config.string("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").pipe(Config.withDefault(""))
})

const includesOtlp = (exporters: string): boolean =>
  exporters.split(",").some((exporter) => exporter.trim().toLowerCase() === "otlp")

const OtlpHttpProtocol = Schema.Literals(["http/json", "http/protobuf"])
type OtlpHttpProtocol = typeof OtlpHttpProtocol.Type
type OtlpSignal = "logs" | "traces"

const optionalIntegerConfigurationKeys = new Set([
  "OTEL_BLRP_EXPORT_TIMEOUT",
  "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BLRP_SCHEDULE_DELAY",
  "OTEL_BSP_EXPORT_TIMEOUT",
  "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT"
])

class ObservabilityConfigurationError extends Schema.TaggedErrorClass<ObservabilityConfigurationError>()(
  "ObservabilityConfigurationError",
  {
    reason: Schema.Literals(["invalid-endpoint", "unsupported-protocol"]),
    signal: Schema.Literals(["logs", "traces"])
  }
) {}

const validateSignalEndpoint = Effect.fn("ControlCenterObservability.validateSignalEndpoint")(function*(
  signal: OtlpSignal,
  endpoint: string
) {
  if (endpoint === "") return
  const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(endpoint).pipe(
    Effect.mapError(() => new ObservabilityConfigurationError({ reason: "invalid-endpoint", signal }))
  )
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* new ObservabilityConfigurationError({ reason: "invalid-endpoint", signal })
  }
})

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

const parseSdkDisabled = Effect.fn("ControlCenterObservability.parseSdkDisabled")(function*(value: string) {
  const normalized = value.trim().toLowerCase()
  if (normalized === "true") return true
  if (normalized === "" || normalized === "false") return false
  yield* Effect.logWarning("Ignoring invalid OTEL_SDK_DISABLED value; expected true or false.")
  return false
})

const isIntegerConfigurationValue = (value: string): boolean => {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isFinite(parsed) && Number.isInteger(parsed)
}

const sanitizedConfigProvider = (
  provider: ConfigProvider.ConfigProvider,
  sdkDisabled: boolean
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) => {
    if (path.length === 1 && path[0] === "OTEL_SDK_DISABLED") {
      return Effect.succeed(ConfigProvider.makeValue(sdkDisabled ? "true" : "false"))
    }
    return provider.load(path).pipe(
      Effect.map((node) => {
        if (
          path.length !== 1 ||
          typeof path[0] !== "string" ||
          !optionalIntegerConfigurationKeys.has(path[0]) ||
          node === undefined
        ) {
          return node
        }
        const value = node.value
        return value === undefined || !isIntegerConfigurationValue(value) ? undefined : node
      })
    )
  })

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
  const sdkDisabled = yield* parseSdkDisabled(configured.disabled)
  if (sdkDisabled) return Layer.empty

  const provider = yield* ConfigProvider.ConfigProvider

  const logsEnabled = includesOtlp(configured.logsExporters)
  const tracesEnabled = includesOtlp(configured.tracesExporters)
  if (logsEnabled) {
    yield* validateSignalEndpoint(
      "logs",
      configured.logsEndpoint === "" ? configured.baseEndpoint : configured.logsEndpoint
    )
  }
  if (tracesEnabled) {
    yield* validateSignalEndpoint(
      "traces",
      configured.tracesEndpoint === "" ? configured.baseEndpoint : configured.tracesEndpoint
    )
  }
  const logsProtocol = logsEnabled
    ? yield* resolveProtocol("logs", configured.logsProtocol, configured.protocol)
    : "http/protobuf"
  const tracesProtocol = tracesEnabled
    ? yield* resolveProtocol("traces", configured.tracesProtocol, configured.protocol)
    : "http/protobuf"

  return Layer.merge(
    logsEnabled ? loggerLayer(logsProtocol) : Layer.empty,
    tracesEnabled ? tracerLayer(tracesProtocol) : Layer.empty
  ).pipe(Layer.provide(ConfigProvider.layer(sanitizedConfigProvider(provider, sdkDisabled))))
}).pipe(Layer.unwrap)

export const ControlCenterObservabilityLive = controlCenterTelemetryLayer.pipe(Layer.provide(FetchHttpClient.layer))
