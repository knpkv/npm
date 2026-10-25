import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { DatabaseSync } from "node:sqlite"
import {
  csrfFor,
  csrfMatches,
  makePersonSessions,
  type SessionBinding,
  sessionLimit
} from "../src/internal/person-sessions.js"

const hour = 60 * 60 * 1000
const phone: SessionBinding = { kind: "tailscale", login: "owner@example.test", nodeId: "node-phone", sliding: true }
const build: SessionBinding = { kind: "tailscale", login: "owner@example.test", nodeId: "node-build", sliding: false }

type Sessions = Effect.Success<ReturnType<typeof makePersonSessions>>

const withSessions = <A, E, R>(run: (sessions: Sessions, file: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hub-sessions-" })
    const file = path.join(directory, "sessions.sqlite")
    return yield* run(yield* makePersonSessions(file), file)
  }).pipe(Effect.scoped)

describe("person sessions", () => {
  it.layer(NodeServices.layer)((it) => {
    // The browser holds the token; the hub keeps only its digest, so a copied database opens no session.
    it.effect("opens a session by its token and keeps only the token's digest", () =>
      withSessions((sessions, file) =>
        Effect.gen(function*() {
          const minted = yield* sessions.mint(build)
          const open = yield* sessions.read(Redacted.value(minted.token))
          expect(open).toMatchObject({ kind: "tailscale", login: "owner@example.test", nodeId: "node-build" })
          const stored = yield* Effect.sync(() => {
            const database = new DatabaseSync(file, { readOnly: true })
            const rows = JSON.stringify(database.prepare("SELECT * FROM person_sessions").all())
            database.close()
            return rows
          })
          expect(stored).not.toContain(Redacted.value(minted.token))
          expect(stored).not.toContain(Redacted.value(minted.csrf))
          expect(yield* sessions.read("00".repeat(32))).toBeNull()
          expect(yield* sessions.read("not a token")).toBeNull()
        })
      ))

    // A fleet machine's session ends 8 hours after logging in, however much it is used.
    it.effect("ends a fixed session after 8 hours", () =>
      withSessions((sessions) =>
        Effect.gen(function*() {
          const minted = yield* sessions.mint(build)
          yield* TestClock.adjust(7 * hour)
          expect(yield* sessions.read(Redacted.value(minted.token))).not.toBeNull()
          yield* TestClock.adjust(1 * hour)
          expect(yield* sessions.read(Redacted.value(minted.token))).toBeNull()
        })
      ))

    // A personal device's session renews with use, up to 7 days after logging in.
    it.effect("renews a sliding session on use, until 8 idle hours or 7 days", () =>
      withSessions((sessions) =>
        Effect.gen(function*() {
          const idle = Redacted.value((yield* sessions.mint(phone)).token)
          yield* TestClock.adjust(9 * hour)
          expect(yield* sessions.read(idle)).toBeNull()
          const used = Redacted.value((yield* sessions.mint(phone)).token)
          // Read every 7 hours: renewed each time, until 7 days (168 h) after logging in, when it ends.
          for (let step = 1; step <= 23; step++) {
            yield* TestClock.adjust(7 * hour)
            expect(yield* sessions.read(used), `after ${String(step * 7)} h`).not.toBeNull()
          }
          yield* TestClock.adjust(7 * hour)
          expect(yield* sessions.read(used)).toBeNull()
        })
      ))

    // Logging out ends the session at once.
    it.effect("ends a session on log out", () =>
      withSessions((sessions) =>
        Effect.gen(function*() {
          const minted = yield* sessions.mint({ kind: "local" })
          yield* sessions.end(Redacted.value(minted.token))
          expect(yield* sessions.read(Redacted.value(minted.token))).toBeNull()
        })
      ))

    // Writes carry the CSRF token derived from their own session; another session's, or none, doesn't match.
    it.effect("matches a write's CSRF token to its own session only", () =>
      withSessions((sessions) =>
        Effect.gen(function*() {
          const first = yield* sessions.mint(build)
          const second = yield* sessions.mint(build)
          const token = Redacted.value(first.token)
          expect(yield* csrfMatches(token, Redacted.value(first.csrf))).toBe(true)
          expect(yield* csrfMatches(token, Redacted.value(yield* csrfFor(token)))).toBe(true)
          expect(yield* csrfMatches(token, Redacted.value(second.csrf))).toBe(false)
          expect(yield* csrfMatches(token, undefined)).toBe(false)
        })
      ))

    // A bounded table: past the limit, the oldest session is dropped.
    it.effect("keeps at most the limit, dropping the oldest", () =>
      withSessions((sessions) =>
        Effect.gen(function*() {
          const oldest = yield* sessions.mint(build)
          for (let index = 0; index < sessionLimit; index++) {
            yield* TestClock.adjust(1000)
            yield* sessions.mint(build)
          }
          expect(yield* sessions.read(Redacted.value(oldest.token))).toBeNull()
        })
      ))
  })
})
