import { Schema, SchemaTransformation } from "effect"

const hasNoInvisibleControls = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined &&
      !(
        (codePoint >= 0 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      )
  })

const SafeUrlText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter(hasNoInvisibleControls, { expected: "a URL without control or bidirectional override characters" })
)

/** HTTPS-only URL that may be placed in a browser navigation element. */
export const ExternalNavigationUrl = SafeUrlText.pipe(
  Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString),
  Schema.check(
    Schema.makeFilter(({ protocol }) => protocol === "https:", { expected: "an HTTPS navigation URL" }),
    Schema.makeFilter(
      ({ password, username }) => password.length === 0 && username.length === 0,
      { expected: "a navigation URL without embedded credentials" }
    )
  )
)

/** Decoded safe external navigation URL. */
export type ExternalNavigationUrl = typeof ExternalNavigationUrl.Type

/** HTTPS-only, credential-free URL eligible for explicit egress validation. */
export const EgressUrl = SafeUrlText.pipe(
  Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString),
  Schema.check(
    Schema.makeFilter(({ protocol }) => protocol === "https:", { expected: "an HTTPS egress URL" }),
    Schema.makeFilter(
      ({ password, username }) => password.length === 0 && username.length === 0,
      { expected: "an egress URL without embedded credentials" }
    ),
    Schema.makeFilter(({ hash }) => hash.length === 0, { expected: "an egress URL without a fragment" }),
    Schema.makeFilter(({ port }) => port.length === 0 || port === "443", {
      expected: "an egress URL using the default HTTPS port"
    }),
    Schema.makeFilter(({ hostname }) => hostname.length > 0 && !hostname.endsWith("."), {
      expected: "an egress URL with a canonical hostname"
    }),
    Schema.makeFilter(({ hostname }) => !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(hostname), {
      expected: "an egress URL using a DNS hostname rather than an IP literal"
    })
  )
)

/** Decoded egress URL; this is still not authority to open a socket. */
export type EgressUrl = typeof EgressUrl.Type

/** Opaque same-origin reference used by media routes instead of accepting a URL. */
export const MediaRef = Schema.String.check(
  Schema.isPattern(/^media_[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 media reference" })
).pipe(Schema.brand("MediaRef"))

/** Decoded opaque media reference. */
export type MediaRef = typeof MediaRef.Type

const parseIpv4 = (address: string): ReadonlyArray<number> | undefined => {
  const segments = address.split(".")
  if (segments.length !== 4) return undefined
  const parsed: Array<number> = []
  for (const segment of segments) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(segment)) return undefined
    const value = Number(segment)
    if (!Number.isInteger(value) || value > 255) return undefined
    parsed.push(value)
  }
  return parsed
}

const isBlockedIpv4 = (segments: ReadonlyArray<number>): boolean => {
  const first = segments[0]
  const second = segments[1]
  const third = segments[2]
  if (first === undefined || second === undefined || third === undefined) return true
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
}

const parseIpv6 = (address: string): ReadonlyArray<number> | undefined => {
  if (address.includes("%") || address.includes(".")) return undefined
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return undefined
  const left = halves[0] === "" ? [] : halves[0]?.split(":") ?? []
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]?.split(":") ?? []
  const isHexSegment = (segment: string): boolean => /^[0-9a-f]{1,4}$/u.test(segment)
  if (!left.every(isHexSegment) || !right.every(isHexSegment)) return undefined
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  return [
    ...left.map((segment) => Number.parseInt(segment, 16)),
    ...Array<number>(missing).fill(0),
    ...right.map(
      (segment) => Number.parseInt(segment, 16)
    )
  ]
}

const isPublicIpv6 = (segments: ReadonlyArray<number>): boolean => {
  const first = segments[0]
  const second = segments[1]
  if (segments.length !== 8 || first === undefined || second === undefined) return false
  if (first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2001 && second <= 0x01ff) return false
  if (first === 0x2001 && second === 0x0db8) return false
  if (first === 0x2002) return false
  if (first === 0x3fff) return false
  return true
}

/** Return whether a canonical DNS address is globally routable under the egress policy. */
export const isPublicIpAddress = (address: string): boolean => {
  const ipv4 = parseIpv4(address)
  if (ipv4 !== undefined) return !isBlockedIpv4(ipv4)
  const ipv6 = parseIpv6(address)
  return ipv6 !== undefined && isPublicIpv6(ipv6)
}

/** Canonical public IPv4 or IPv6 address accepted after DNS resolution. */
export const PublicIpAddress = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(45),
  Schema.makeFilter(isPublicIpAddress, { expected: "a canonical globally routable IP address" })
).pipe(Schema.brand("PublicIpAddress"))

/** Decoded globally routable IP address. */
export type PublicIpAddress = typeof PublicIpAddress.Type

const CanonicalHostname = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(253),
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u, {
    expected: "a lowercase canonical DNS hostname"
  })
)

/** Socket target created only after URL, allowlist, and DNS validation. */
export const ResolvedTarget = Schema.Struct({
  url: EgressUrl,
  hostname: CanonicalHostname,
  port: Schema.Literal(443),
  address: PublicIpAddress,
  family: Schema.Literals([4, 6])
}).check(
  Schema.makeFilter(({ hostname, url }) => url.hostname === hostname, {
    expected: "the resolved hostname to match the original URL"
  }),
  Schema.makeFilter(({ address, family }) => (address.includes(":") ? family === 6 : family === 4), {
    expected: "the address family to match the resolved address"
  })
)

/** Decoded DNS-pinned egress target. */
export type ResolvedTarget = typeof ResolvedTarget.Type
