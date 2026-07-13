import { Effect, Schema } from "effect"

import { SecretRef } from "../secrets/SecretRef.js"

const HOST_TOKEN_PATTERN = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[1-9][0-9]{0,4})?$/u
const IP_ADDRESS_PATTERN = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-f:]+)$/u

const Port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65_535 }))

const BindHost = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?|[0-9a-f:]+)$/u, {
    expected: "a lowercase bind hostname or IP address"
  })
).pipe(Schema.brand("BindHost"))

const HostToken = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(260),
  Schema.isPattern(HOST_TOKEN_PATTERN, { expected: "an exact lowercase HTTP Host value" })
).pipe(Schema.brand("HostToken"))

const OriginString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_048)).pipe(
  Schema.brand("OriginString")
)

const ProxyAddress = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(IP_ADDRESS_PATTERN, { expected: "an exact proxy IP address" })
).pipe(Schema.brand("ProxyAddress"))

/** Opaque references to the certificate and private key required by direct TLS. */
export const DirectTlsMaterial = Schema.Struct({
  certificateRef: SecretRef,
  privateKeyRef: SecretRef
})

export type DirectTlsMaterial = typeof DirectTlsMaterial.Type

const BindConfigInput = Schema.Struct({
  host: Schema.optionalKey(BindHost),
  port: Schema.optionalKey(Port),
  publicOrigin: Schema.optionalKey(OriginString),
  allowedHosts: Schema.optionalKey(Schema.Array(HostToken)),
  allowedOrigins: Schema.optionalKey(Schema.Array(OriginString)),
  directTls: Schema.optionalKey(DirectTlsMaterial),
  trustedProxyAddresses: Schema.optionalKey(Schema.Array(ProxyAddress)),
  allowInsecureLan: Schema.optionalKey(Schema.Boolean)
})

/** A decoded bind configuration is invalid or would expose an ambiguous endpoint. */
export class BindConfigError extends Schema.TaggedErrorClass<BindConfigError>()("BindConfigError", {
  reason: Schema.Literals([
    "invalid-input",
    "invalid-origin",
    "invalid-host-port",
    "lan-requires-public-origin",
    "lan-requires-host-allowlist",
    "lan-requires-origin-allowlist",
    "lan-requires-transport-policy",
    "conflicting-transport-policy",
    "public-origin-mismatch"
  ])
}) {}

export const TransportPolicy = Schema.Literals(["loopback-http", "direct-tls", "trusted-tls-proxy", "insecure-lan"])

export type TransportPolicy = typeof TransportPolicy.Type

export const BindConfig = Schema.Struct({
  host: BindHost,
  port: Port,
  publicOrigin: OriginString,
  allowedHosts: Schema.Array(HostToken),
  allowedOrigins: Schema.Array(OriginString),
  transportPolicy: TransportPolicy,
  directTls: Schema.NullOr(DirectTlsMaterial),
  trustedProxyAddresses: Schema.Array(ProxyAddress),
  cookieSecure: Schema.Boolean,
  lanAdministrationAllowed: Schema.Boolean
})

export type BindConfig = typeof BindConfig.Type

const isLoopback = (host: string): boolean => {
  if (host === "::1" || host === "localhost") return true
  const segments = host.split(".").map(Number)
  return (
    segments.length === 4 &&
    segments[0] === 127 &&
    segments.every((segment) => Number.isInteger(segment) && segment >= 0 && segment <= 255)
  )
}

const normalizedOrigin = (value: string): URL | undefined => {
  const result = Schema.decodeUnknownResult(Schema.URLFromString)(value)
  if (result._tag === "Failure") return undefined
  const url = result.success
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return undefined
  }
  return url
}

const hostTokenPort = (host: string): number | undefined => {
  const bracket = host.startsWith("[")
  const separator = bracket ? host.indexOf("]:") : host.lastIndexOf(":")
  if (separator < 0) return undefined
  const value = Number(host.slice(separator + (bracket ? 2 : 1)))
  return Number.isSafeInteger(value) ? value : undefined
}

const isIpAddress = (address: string): boolean => {
  if (address.includes(":")) {
    return Schema.decodeUnknownResult(Schema.URLFromString)(`http://[${address}]`)._tag === "Success"
  }
  const segments = address.split(".").map(Number)
  return (
    segments.length === 4 && segments.every((segment) => Number.isInteger(segment) && segment >= 0 && segment <= 255)
  )
}

const unique = <Value extends string>(values: ReadonlyArray<Value>): Array<Value> => Array.from(new Set(values))

/** Decode loopback-first bind configuration and reject ambiguous LAN exposure. */
export const decodeBindConfig = Effect.fn("BindConfig.decode")(function*(input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(BindConfigInput)(input).pipe(
    Effect.mapError(() => new BindConfigError({ reason: "invalid-input" }))
  )
  const host = decoded.host ?? BindHost.make("127.0.0.1")
  const port = decoded.port ?? 4173
  const loopback = isLoopback(host)
  const directTls = decoded.directTls ?? null
  const proxies = decoded.trustedProxyAddresses ?? []
  const insecureLan = decoded.allowInsecureLan ?? false
  const selectedPolicies = Number(directTls !== null) + Number(proxies.length > 0) + Number(insecureLan)

  if (proxies.some((address) => !isIpAddress(address))) {
    return yield* new BindConfigError({ reason: "invalid-input" })
  }

  if (selectedPolicies > 1) {
    return yield* new BindConfigError({ reason: "conflicting-transport-policy" })
  }
  if (loopback && insecureLan) {
    return yield* new BindConfigError({ reason: "conflicting-transport-policy" })
  }

  const defaultOrigin = `${directTls !== null ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`
  const originValue = decoded.publicOrigin ?? defaultOrigin
  const origin = normalizedOrigin(originValue)
  if (origin === undefined) return yield* new BindConfigError({ reason: "invalid-origin" })
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return yield* new BindConfigError({ reason: "invalid-origin" })
  }
  const canonicalOrigin = OriginString.make(origin.origin)

  const allowedHosts = unique(decoded.allowedHosts ?? [HostToken.make(origin.host)])
  const allowedOrigins: Array<typeof OriginString.Type> = []
  for (const value of decoded.allowedOrigins ?? [canonicalOrigin]) {
    const allowedOrigin = normalizedOrigin(value)
    if (allowedOrigin === undefined || (allowedOrigin.protocol !== "http:" && allowedOrigin.protocol !== "https:")) {
      return yield* new BindConfigError({ reason: "invalid-origin" })
    }
    allowedOrigins.push(OriginString.make(allowedOrigin.origin))
  }
  for (const allowedHost of allowedHosts) {
    const allowedPort = hostTokenPort(allowedHost)
    if (allowedPort !== undefined && (allowedPort < 1 || allowedPort > 65_535)) {
      return yield* new BindConfigError({ reason: "invalid-host-port" })
    }
  }

  if (!allowedHosts.includes(HostToken.make(origin.host)) || !allowedOrigins.includes(canonicalOrigin)) {
    return yield* new BindConfigError({ reason: "public-origin-mismatch" })
  }

  if (!loopback) {
    if (decoded.publicOrigin === undefined) {
      return yield* new BindConfigError({ reason: "lan-requires-public-origin" })
    }
    if (decoded.allowedHosts === undefined || decoded.allowedHosts.length === 0) {
      return yield* new BindConfigError({ reason: "lan-requires-host-allowlist" })
    }
    if (decoded.allowedOrigins === undefined || decoded.allowedOrigins.length === 0) {
      return yield* new BindConfigError({ reason: "lan-requires-origin-allowlist" })
    }
    if (selectedPolicies === 0) {
      return yield* new BindConfigError({ reason: "lan-requires-transport-policy" })
    }
  }
  if (origin.hostname === "0.0.0.0" || origin.hostname === "[::]" || origin.hostname === "::") {
    return yield* new BindConfigError({ reason: "public-origin-mismatch" })
  }

  const transportPolicy: TransportPolicy = directTls !== null
    ? "direct-tls"
    : proxies.length > 0
    ? "trusted-tls-proxy"
    : loopback
    ? "loopback-http"
    : "insecure-lan"

  if ((transportPolicy === "direct-tls" || transportPolicy === "trusted-tls-proxy") && origin.protocol !== "https:") {
    return yield* new BindConfigError({ reason: "invalid-origin" })
  }
  if (transportPolicy === "insecure-lan" && origin.protocol !== "http:") {
    return yield* new BindConfigError({ reason: "invalid-origin" })
  }
  if (transportPolicy === "loopback-http" && origin.protocol !== "http:") {
    return yield* new BindConfigError({ reason: "invalid-origin" })
  }
  const originPort = origin.port === "" ? (origin.protocol === "https:" ? 443 : 80) : Number(origin.port)
  if (transportPolicy !== "trusted-tls-proxy" && originPort !== port) {
    return yield* new BindConfigError({ reason: "public-origin-mismatch" })
  }

  return BindConfig.make({
    host,
    port,
    publicOrigin: canonicalOrigin,
    allowedHosts,
    allowedOrigins: unique(allowedOrigins),
    transportPolicy,
    directTls,
    trustedProxyAddresses: proxies,
    cookieSecure: transportPolicy === "direct-tls" || transportPolicy === "trusted-tls-proxy",
    lanAdministrationAllowed: transportPolicy !== "insecure-lan"
  })
})

const PrivateAddress = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(IP_ADDRESS_PATTERN, { expected: "a private-network IP address" })
)

const isPrivateNetworkAddress = (address: string): boolean => {
  if (!isIpAddress(address)) return false
  if (address.includes(":")) {
    const normalized = address.toLowerCase()
    return (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    )
  }
  const segments = address.split(".").map(Number)
  return (
    segments[0] === 10 ||
    (segments[0] === 172 && segments[1] !== undefined && segments[1] >= 16 && segments[1] <= 31) ||
    (segments[0] === 192 && segments[1] === 168)
  )
}

/** Derive terminal-safe reachable URLs without printing wildcard bind addresses. */
export const effectiveReachableUrls = (
  config: BindConfig,
  detectedPrivateAddresses: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const publicUrl = config.publicOrigin
  if (config.host !== "0.0.0.0" && config.host !== "::") return [publicUrl]
  if (config.transportPolicy !== "insecure-lan") return [publicUrl]
  const detected = detectedPrivateAddresses.flatMap((address) => {
    const decoded = Schema.decodeUnknownResult(PrivateAddress)(address)
    if (decoded._tag === "Failure") return []
    if (!isPrivateNetworkAddress(decoded.success)) return []
    const formatted = decoded.success.includes(":") ? `[${decoded.success}]` : decoded.success
    const host = `${formatted}:${config.port}`
    const origin = `http://${host}`
    if (!config.allowedHosts.some((allowedHost) => allowedHost === host)) return []
    if (!config.allowedOrigins.some((allowedOrigin) => allowedOrigin === origin)) return []
    return [origin]
  })
  return unique([publicUrl, ...detected])
}
