/**
 * Browser sessions for people logged in to the hub: a Tailscale login on a tailnet node, or the local user
 * on the hub's own computer through `herdr-hub login`.
 *
 * **Mental model**
 *
 * - **The browser holds the token, the hub keeps its digest.** A session token is a random credential from
 *   `@knpkv/browser-pairing`; only its SHA-256 digest is stored, so a copied database opens no session.
 *   Sessions survive a hub restart (every nix apply restarts it).
 * - **The CSRF token comes from the session token** ({@link csrfFor}): a domain-separated SHA-256 of it,
 *   recomputed per request. Any tab of the session can read it back from the hub, and a page that can't
 *   read the session token can't compute it.
 * - **Two lifetimes.** A fixed session ends 8 hours after logging in. A sliding one (a person's own
 *   device) is renewed on use: it ends after 8 idle hours, and 7 days after logging in at the latest.
 * - **Reading never writes.** {@link read} only looks a token up. A caller renews a session with `touch`
 *   once it has matched the session's binding to the request, so a cookie replayed from another node,
 *   read and ignored, can't keep a session alive. Renewals and purges are throttled to once a minute, so
 *   a polling dashboard doesn't write on every request.
 * - **A session is intent, not presence.** Before passkeys, anything on the same node that can press
 *   "Log in" can open one. It decides who acts, never that a person is present.
 * - **Bounded.** At most {@link bindingLimit} sessions per login and node, and {@link sessionLimit} in all;
 *   the oldest is dropped to make room.
 *
 * @module
 */
import { credentialValuesEqual, hashCredential, issueSessionToken, type SessionToken } from "@knpkv/browser-pairing"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Crypto, Effect, Redacted, Ref, Schema } from "effect"
import { Hex } from "effect/encoding"

/** At most this many open sessions; logging in past it drops the oldest. A backstop behind {@link bindingLimit}. */
export const sessionLimit = 64

/**
 * At most this many open sessions per login and node (or for the local user); logging in past it drops that
 * binding's oldest, so something minting in a loop on one node can't push another device's session out.
 */
export const bindingLimit = 8

/** A sliding session is renewed only when that moves its end by at least this much: once a minute at most. */
const renewSlackMillis = 60_000
/** Expired rows are removed when logging in, and on a renewal at most this often. */
const purgeIntervalMillis = 60_000

const hour = 60 * 60 * 1000
const fixedLifetime = 8 * hour
const idleLifetime = 8 * hour
const absoluteLifetime = 7 * 24 * hour

/** Who a session is for, as bound when it was opened. */
export type SessionBinding =
  /** A Tailscale login on one node; `sliding` for a person's own device, fixed on a fleet machine. */
  | { readonly kind: "tailscale"; readonly login: string; readonly nodeId: string; readonly sliding: boolean }
  /** The local user on the hub's own computer. */
  | { readonly kind: "local" }

/** An open session, as read back. */
export type OpenSession = SessionBinding & { readonly expiresAt: number }

const csrfDomain = new TextEncoder().encode("herdr-hub session csrf v1:")

/** The CSRF token that goes with `token`: what the session's writes carry in `x-herdr-csrf`. */
export const csrfFor = Effect.fn("PersonSessions.csrfFor")(function*(token: string) {
  const cryptoService = yield* Crypto.Crypto
  const bytes = new Uint8Array([...csrfDomain, ...new TextEncoder().encode(token)])
  return Redacted.make(Hex.encode(yield* cryptoService.digest("SHA-256", bytes)))
})

/** Whether `csrf` goes with the session `token`, compared in constant time. */
export const csrfMatches = (token: string, csrf: string | undefined) =>
  csrf === undefined
    ? Effect.succeed(false)
    : Effect.map(csrfFor(token), (expected) => credentialValuesEqual(csrf, Redacted.value(expected)))

/** The session store could not be read or written. */
export class PersonSessionsUnavailable extends Schema.TaggedError<PersonSessionsUnavailable>()(
  "PersonSessionsUnavailable",
  { operation: Schema.String }
) {}

const Row = Schema.Struct({
  digest: Schema.String,
  kind: Schema.Literals(["tailscale", "local"]),
  login: Schema.NullOr(Schema.String),
  node_id: Schema.NullOr(Schema.String),
  sliding: Schema.Number,
  issued_at: Schema.Number,
  expires_at: Schema.Number
})
type Row = typeof Row.Type

const bindingOf = (row: Row): SessionBinding | null =>
  row.kind === "local"
    ? { kind: "local" }
    : row.login !== null && row.node_id !== null
    ? { kind: "tailscale", login: row.login, nodeId: row.node_id, sliding: row.sliding === 1 }
    : null

/** Opens the session store at `path`; the caller's scope owns the SQLite handle. */
export const makePersonSessions = Effect.fn("PersonSessions.make")(function*(path: string) {
  const unavailable = (operation: string) => () => new PersonSessionsUnavailable({ operation })
  const opened = yield* Effect.acquireRelease(
    openPrivateSqlite(path, {
      busyTimeoutMillis: 500,
      initialize: (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS person_sessions (
          digest TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          login TEXT,
          node_id TEXT,
          sliding INTEGER NOT NULL,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
        `)
      }
    }).pipe(Effect.mapError(unavailable("open"))),
    (resource) => Effect.sync(() => resource.database.close())
  )
  const database = opened.database
  const cryptoService = yield* Crypto.Crypto
  const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
    Effect.provideService(effect, Crypto.Crypto, cryptoService)
  const lastPurge = yield* Ref.make(Number.NEGATIVE_INFINITY)
  const purgeStatement = database.prepare("DELETE FROM person_sessions WHERE expires_at <= ?")
  /** Removes expired rows, at most once a minute unless `always`. */
  const purge = Effect.fn("PersonSessions.purge")(function*(now: number, always: boolean) {
    const due = yield* Ref.modify(
      lastPurge,
      (last): [boolean, number] => always || now - last >= purgeIntervalMillis ? [true, now] : [false, last]
    )
    if (!due) return
    yield* Effect.try({ try: () => purgeStatement.run(now), catch: unavailable("purge") })
  })
  /** The stored row `token` names; null when it names none. */
  const rowOf = Effect.fn("PersonSessions.rowOf")(function*(token: string) {
    const digest = yield* hashCredential(Redacted.make(token)).pipe(Effect.option)
    if (digest._tag === "None") return null
    const found = yield* Effect.try({
      try: () => database.prepare("SELECT * FROM person_sessions WHERE digest = ?").get(digest.value),
      catch: unavailable("read")
    })
    if (found === undefined) return null
    return yield* Schema.decodeUnknownEffect(Row)(found).pipe(Effect.mapError(unavailable("read")))
  })

  /** Logs `binding` in: a fresh session token, which only the browser keeps, and its CSRF token. */
  const mint = Effect.fn("PersonSessions.mint")(function*(binding: SessionBinding) {
    const now = yield* Clock.currentTimeMillis
    const token: Redacted.Redacted<SessionToken> = yield* issueSessionToken().pipe(Effect.mapError(unavailable("mint")))
    const csrf = yield* csrfFor(Redacted.value(token)).pipe(Effect.mapError(unavailable("mint")))
    const digest = yield* hashCredential(token).pipe(Effect.mapError(unavailable("mint")))
    const sliding = binding.kind === "tailscale" && binding.sliding
    const expiresAt = now + (sliding ? idleLifetime : fixedLifetime)
    yield* Effect.try({
      try: () => {
        database.exec("BEGIN IMMEDIATE")
        try {
          database.prepare(`INSERT INTO person_sessions
            (digest, kind, login, node_id, sliding, issued_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            digest,
            binding.kind,
            binding.kind === "tailscale" ? binding.login : null,
            binding.kind === "tailscale" ? binding.nodeId : null,
            sliding ? 1 : 0,
            now,
            expiresAt
          )
          const sameBinding = "kind = ? AND login IS ? AND node_id IS ?"
          const bound = [
            binding.kind,
            binding.kind === "tailscale" ? binding.login : null,
            binding.kind === "tailscale" ? binding.nodeId : null
          ]
          database.prepare(`DELETE FROM person_sessions WHERE rowid IN (
            SELECT rowid FROM person_sessions WHERE ${sameBinding} ORDER BY issued_at, rowid
            LIMIT MAX(0, (SELECT count(*) FROM person_sessions WHERE ${sameBinding}) - ?)
          )`).run(...bound, ...bound, bindingLimit)
          database.prepare(`DELETE FROM person_sessions WHERE rowid IN (
            SELECT rowid FROM person_sessions ORDER BY issued_at, rowid
            LIMIT MAX(0, (SELECT count(*) FROM person_sessions) - ?)
          )`).run(sessionLimit)
          database.exec("COMMIT")
        } catch (cause) {
          database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: unavailable("mint")
    })
    yield* purge(now, true)
    yield* opened.secureFiles.pipe(Effect.mapError(unavailable("mint")))
    return { token, csrf, expiresAt }
  })

  /** The open session `token` names; null when it names none or has ended. Reads only, never renews. */
  const read = Effect.fn("PersonSessions.read")(function*(token: string) {
    const row = yield* rowOf(token)
    if (row === null) return null
    const binding = bindingOf(row)
    const now = yield* Clock.currentTimeMillis
    if (binding === null || row.expires_at <= now) return null
    const open: OpenSession = { ...binding, expiresAt: row.expires_at }
    return open
  })

  /**
   * Renews `token`'s session if it slides, now that the caller has matched its binding to the request: 8
   * more idle hours, never past 7 days after logging in. Writes only when that moves the end by a minute.
   */
  const touch = Effect.fn("PersonSessions.touch")(function*(token: string) {
    const row = yield* rowOf(token)
    const now = yield* Clock.currentTimeMillis
    if (row === null || row.sliding !== 1 || row.expires_at <= now) return
    const expiresAt = Math.min(now + idleLifetime, row.issued_at + absoluteLifetime)
    if (expiresAt - row.expires_at < renewSlackMillis) return
    yield* Effect.try({
      try: () =>
        database.prepare("UPDATE person_sessions SET expires_at = ? WHERE digest = ?").run(expiresAt, row.digest),
      catch: unavailable("touch")
    })
    yield* purge(now, false)
  })

  /** Logs `token`'s session out; nothing happens when it names none. */
  const end = Effect.fn("PersonSessions.end")(function*(token: string) {
    const digest = yield* hashCredential(Redacted.make(token)).pipe(Effect.option)
    if (digest._tag === "None") return
    yield* Effect.try({
      try: () => database.prepare("DELETE FROM person_sessions WHERE digest = ?").run(digest.value),
      catch: unavailable("end")
    })
  })

  return {
    mint: (binding: SessionBinding) => withCrypto(mint(binding)),
    read: (token: string) => withCrypto(read(token)),
    touch: (token: string) => withCrypto(touch(token)),
    end: (token: string) => withCrypto(end(token))
  }
})
