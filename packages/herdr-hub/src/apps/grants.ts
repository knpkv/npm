/**
 * Who an app may act for, and who an app is.
 *
 * **Mental model**
 *
 * - A **grant** is minted for each module request the hub proxies to an app and names that request's caller.
 *   An app acting for a user hands the grant back; the hub reads the caller from its own record, never from
 *   the app. Grants live 60 s. Anything that writes as the caller (`spend` for a job, `write` for a Relay
 *   post) refuses a grant minted for a GET or HEAD: reads skip the same-origin check, so a cross-site link
 *   could otherwise act for the user. A job also spends the grant (single use); a `read` of the caller
 *   accepts any live grant of its app.
 * - A **token** names the app itself for app-level services (`host`, `fleet.read`). The hub writes one per
 *   app to `<directory>/<id>.token` (0600) and rotates it on every hub start.
 *
 * Same-uid processes are trusted: these are correctness contracts, not a defence against a hostile app.
 *
 * @module
 */
import { type AppId, Grant, GrantInvalid, type ModuleCaller } from "@knpkv/hub-app"
import { Clock, Crypto, Effect, FileSystem, Option, Path, Schema, SynchronizedRef } from "effect"
import { Base64Url } from "effect/encoding"

export const grantLifetimeMillis = 60_000

interface GrantRecord {
  readonly app: AppId
  readonly caller: ModuleCaller
  /** Minted for a GET or HEAD, which passed no same-origin check. */
  readonly readOnly: boolean
  readonly requestId: string
  readonly expiresAt: number
  readonly used: boolean
}

/** 32 random bytes, base64url: a grant, a token or a request id. */
const randomToken = (cryptoService: Crypto.Crypto) => Effect.map(cryptoService.randomBytes(32), Base64Url.encode)

/**
 * How a grant is used; every use needs a live grant of `app`. `spend`: a job, once, from a mutation. `write`:
 * acts as the caller from a mutation, without spending it. `read`: only names the caller.
 */
export interface GrantUse {
  readonly grant: string
  readonly app: AppId
  readonly purpose: "spend" | "write" | "read"
}

export const makeGrants = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const records = yield* SynchronizedRef.make(new Map<string, GrantRecord>())

  /** Drop expired grants so the table stays the size of the requests in flight. */
  const prune = (table: Map<string, GrantRecord>, now: number) => {
    const live = new Map<string, GrantRecord>()
    for (const [key, record] of table) if (record.expiresAt > now) live.set(key, record)
    return live
  }

  /** A grant for one proxied request, and that request's id. */
  const mint = Effect.fn("AppGrants.mint")(function*(app: AppId, caller: ModuleCaller, method: string) {
    const now = yield* Clock.currentTimeMillis
    const grant = yield* randomToken(cryptoService)
    const requestId = yield* randomToken(cryptoService)
    yield* SynchronizedRef.update(
      records,
      (table) =>
        prune(table, now).set(grant, {
          app,
          caller,
          readOnly: method === "GET" || method === "HEAD",
          requestId,
          expiresAt: now + grantLifetimeMillis,
          used: false
        })
    )
    return { grant: Schema.decodeSync(Grant)(grant), requestId }
  })

  const use = Effect.fn("AppGrants.use")(function*({ app, grant, purpose }: GrantUse) {
    const now = yield* Clock.currentTimeMillis
    return yield* SynchronizedRef.modifyEffect(records, (table) => {
      const record = table.get(grant)
      if (record === undefined) return Effect.fail(new GrantInvalid({ reason: "unknown" }))
      if (record.expiresAt <= now) return Effect.fail(new GrantInvalid({ reason: "expired" }))
      if (record.app !== app) return Effect.fail(new GrantInvalid({ reason: "app_mismatch" }))
      if (purpose === "read") {
        return Effect.succeed([record.caller, table] satisfies [ModuleCaller, Map<string, GrantRecord>])
      }
      if (record.readOnly) return Effect.fail(new GrantInvalid({ reason: "read_only" }))
      if (purpose === "write") {
        return Effect.succeed([record.caller, table] satisfies [ModuleCaller, Map<string, GrantRecord>])
      }
      if (record.used) return Effect.fail(new GrantInvalid({ reason: "used" }))
      const next = new Map(table)
      next.set(grant, { ...record, used: true })
      return Effect.succeed([record.caller, prune(next, now)] satisfies [ModuleCaller, Map<string, GrantRecord>])
    })
  })

  return { mint, use }
})
export type Grants = Effect.Success<typeof makeGrants>

/** An app-service request carried no token, or one that isn't this app's. */
export class AppTokenRejected extends Schema.TaggedError<AppTokenRejected>()("AppTokenRejected", {}) {}

/** Compares every character whatever the first mismatch, so timing doesn't reveal a token's prefix. */
const sameToken = (presented: string, expected: string): boolean => {
  if (presented.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

/**
 * Per-app tokens, written owner-only under `directory`. `issue` replaces the app's token and file;
 * `verify` checks a bearer token against the app it claims to be.
 */
export const makeAppTokens = Effect.fn("AppTokens.make")(function*(directory: string) {
  const cryptoService = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tokens = yield* SynchronizedRef.make(new Map<AppId, string>())

  const issue = Effect.fn("AppTokens.issue")(function*(app: AppId) {
    const token = yield* randomToken(cryptoService)
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, `${app}.token`)
    const temporary = `${file}.${(yield* randomToken(cryptoService)).slice(0, 8)}.tmp`
    yield* fileSystem.writeFileString(temporary, `${token}\n`, { mode: 0o600 })
    yield* fileSystem.rename(temporary, file)
    yield* SynchronizedRef.update(tokens, (table) => new Map(table).set(app, token))
  })

  const revoke = Effect.fn("AppTokens.revoke")(function*(app: AppId) {
    yield* SynchronizedRef.update(tokens, (table) => {
      const next = new Map(table)
      next.delete(app)
      return next
    })
    yield* fileSystem.remove(path.join(directory, `${app}.token`), { force: true })
  })

  const verify = Effect.fn("AppTokens.verify")(function*(app: AppId, authorization: string | undefined) {
    const presented = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined
    const expected = Option.fromUndefinedOr((yield* SynchronizedRef.get(tokens)).get(app))
    if (presented === undefined || Option.isNone(expected) || !sameToken(presented, expected.value)) {
      return yield* new AppTokenRejected({})
    }
  })

  return { issue, revoke, verify }
})
export type AppTokens = Effect.Success<ReturnType<typeof makeAppTokens>>
