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
 * - **A session is intent, not presence.** Before passkeys, anything on the same node that can press
 *   "Log in" can open one. It decides who acts, never that a person is present.
 * - **Bounded.** At most {@link sessionLimit} sessions; the oldest is dropped to make room. Expired rows
 *   are removed when read.
 *
 * @module
 */
import { credentialValuesEqual, hashCredential, issueSessionToken, type SessionToken } from "@knpkv/browser-pairing"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Crypto, Effect, Redacted, Schema } from "effect"
import { Hex } from "effect/encoding"

/** At most this many open sessions; logging in past it drops the oldest. */
export const sessionLimit = 64

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
    yield* opened.secureFiles.pipe(Effect.mapError(unavailable("mint")))
    return { token, csrf, expiresAt }
  })

  /** The open session `token` names, renewing a sliding one; null when it names none or has ended. */
  const read = Effect.fn("PersonSessions.read")(function*(token: string) {
    const digest = yield* hashCredential(Redacted.make(token)).pipe(Effect.option)
    if (digest._tag === "None") return null
    const now = yield* Clock.currentTimeMillis
    yield* Effect.try({
      try: () => database.prepare("DELETE FROM person_sessions WHERE expires_at <= ?").run(now),
      catch: unavailable("read")
    })
    const found = yield* Effect.try({
      try: () => database.prepare("SELECT * FROM person_sessions WHERE digest = ?").get(digest.value),
      catch: unavailable("read")
    })
    if (found === undefined) return null
    const row = yield* Schema.decodeUnknownEffect(Row)(found).pipe(Effect.mapError(unavailable("read")))
    const binding = bindingOf(row)
    if (binding === null) return null
    const expiresAt = row.sliding === 1
      ? Math.min(now + idleLifetime, row.issued_at + absoluteLifetime)
      : row.expires_at
    if (expiresAt <= now) return null
    if (expiresAt !== row.expires_at) {
      yield* Effect.try({
        try: () =>
          database.prepare("UPDATE person_sessions SET expires_at = ? WHERE digest = ?").run(expiresAt, row.digest),
        catch: unavailable("read")
      })
    }
    const open: OpenSession = { ...binding, expiresAt }
    return open
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
    end: (token: string) => withCrypto(end(token))
  }
})
