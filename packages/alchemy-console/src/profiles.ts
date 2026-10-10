import { Effect, Schema } from "effect"
import { exists, readText } from "./internal/files.js"

/** Server-private SSO configuration. Keep every field in memory, out of HTTP, browser storage, logs and telemetry. */
export const SsoProfile = Schema.Struct({
  name: Schema.NonEmptyString,
  configFile: Schema.NonEmptyString,
  account: Schema.NonEmptyString,
  role: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  ssoRegion: Schema.NonEmptyString,
  startUrl: Schema.NonEmptyString,
  session: Schema.NullOr(Schema.NonEmptyString)
})
export interface SsoProfile extends Schema.Schema.Type<typeof SsoProfile> {}

/** Safe reason only; SDK/parser diagnostics can contain private configuration. */
export class SsoProfileError extends Schema.TaggedError<SsoProfileError>()("SsoProfileError", {
  reason: Schema.Literals(["io", "limit", "invalid-config"])
}) {}

/** Select only SSO fields; static keys and commands are discarded while parsing. */
const parseSections = Effect.fnUntraced(function*(text: string) {
  const sections = new Map<string, Map<string, string>>()
  let fields: Map<string, string> | undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.split(/(^|\s)[;#]/)[0]?.trim() ?? ""
    if (trimmed.length === 0) continue
    if (trimmed.startsWith("[")) {
      const match = /^\[([^\]]+)\]$/.exec(trimmed)
      if (match?.[1] === undefined || match[1].length === 0) {
        return yield* new SsoProfileError({ reason: "invalid-config" })
      }
      const name = match[1].trim().replace(/^(profile|sso-session)\s+["']?([^"']+)["']?$/, "$1.$2")
      fields = sections.get(name) ?? new Map<string, string>()
      sections.set(name, fields)
      continue
    }
    const equals = trimmed.indexOf("=")
    if (fields === undefined || equals <= 0) continue
    const key = trimmed.slice(0, equals).trim()
    if (key === "region" || key.startsWith("sso_")) fields.set(key, trimmed.slice(equals + 1).trim())
  }
  return new Map([...sections].map(([name, fields]) => [name, Object.fromEntries(fields)]))
})

/** Read only the supplied AWS config; skip static/process/role profiles and resolve modern or legacy SSO sections. */
export const discoverSsoProfiles = Effect.fn("AlchemyConsole.discoverSsoProfiles")(function*(configFile: string) {
  const present = yield* exists(configFile).pipe(Effect.mapError(() => new SsoProfileError({ reason: "io" })))
  if (!present) return []
  const text = yield* readText(configFile).pipe(
    Effect.mapError((error) => new SsoProfileError({ reason: error.reason === "limit" ? "limit" : "io" }))
  )
  const ini = yield* parseSections(text)
  const profiles: Array<SsoProfile> = []
  for (const [section, fields] of ini) {
    if (section !== "default" && !section.startsWith("profile.")) continue
    if (!Object.keys(fields).some((key) => key.startsWith("sso_"))) continue
    const session = fields.sso_session === undefined ? undefined : ini.get(`sso-session.${fields.sso_session}`)
    if (fields.sso_session !== undefined && session === undefined) {
      return yield* new SsoProfileError({ reason: "invalid-config" })
    }
    const ssoRegion = session?.sso_region ?? fields.sso_region
    const startUrl = session?.sso_start_url ?? fields.sso_start_url
    if (
      (fields.sso_region !== undefined && fields.sso_region !== ssoRegion) ||
      (fields.sso_start_url !== undefined && fields.sso_start_url !== startUrl)
    ) return yield* new SsoProfileError({ reason: "invalid-config" })
    const profile = yield* Schema.decodeUnknownEffect(SsoProfile)({
      name: section === "default" ? section : section.slice("profile.".length),
      configFile,
      account: fields.sso_account_id,
      role: fields.sso_role_name,
      region: fields.region ?? ssoRegion,
      ssoRegion,
      startUrl,
      session: fields.sso_session ?? null
    }).pipe(Effect.mapError(() => new SsoProfileError({ reason: "invalid-config" })))
    profiles.push(profile)
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
})
