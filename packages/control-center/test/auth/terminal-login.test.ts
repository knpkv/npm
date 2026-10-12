import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, DateTime, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as TestClock from "effect/testing/TestClock"
import { PairingCode } from "../../src/api/session.js"
import { PersonId } from "../../src/domain/identifiers.js"
import { Auth } from "../../src/server/auth/Auth.js"
import { AuthRepository } from "../../src/server/auth/AuthRepository.js"
import { TerminalLogin, type TerminalLoginIdentity } from "../../src/server/auth/TerminalLogin.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { terminalLoginControlLayer } from "../../src/server/runtime/TerminalLoginControl.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "../persistence/fixtures.js"

const identity = {
  workspaceId: fixtureWorkspaceIds.alpha,
  owner: { _tag: "human", personId: PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000031") }
} satisfies TerminalLoginIdentity

const fixture = Layer.unwrap(Effect.gen(function*() {
  const config = yield* makePersistenceTestConfig("terminal-login-")
  const database = databaseLayer(config)
  const repository = AuthRepository.layer.pipe(
    Layer.provide(QuarantineRepository.layer),
    Layer.provide(database)
  )
  return Layer.mergeAll(
    database,
    ServerLifecycle.layer,
    Layer.merge(Auth.layer, TerminalLogin.layer(identity)).pipe(Layer.provide(repository))
  )
})).pipe(Layer.provideMerge(NodeServices.layer))

const initialize = Effect.gen(function*() {
  const database = yield* Database
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${identity.workspaceId}, 'Owner workspace', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`
  const auth = yield* Auth
  const first = yield* auth.bootstrapOwnerPairing({ workspaceId: identity.workspaceId, actor: identity.owner })
  return yield* auth.consumePairingCode(first.pairingCode)
})

const token = "c1".repeat(32)
const origin = "http://127.0.0.1:4173"
const makeControl = Effect.gen(function*() {
  const database = yield* Database
  const lifecycle = yield* ServerLifecycle
  const bind = yield* decodeBindConfig({})
  return yield* HttpRouter.toHttpEffect(
    terminalLoginControlLayer(bind, { ...identity, token: Redacted.make(token) }).pipe(
      Layer.provide(Layer.succeed(Database, database)),
      Layer.provide(Layer.succeed(ServerLifecycle, lifecycle))
    )
  )
})
class ControlRoute
  extends Context.Service<ControlRoute, Effect.Success<typeof makeControl>>()("ControlCenter/test/TerminalControl")
{}
const controlFixture = Layer.effect(ControlRoute, makeControl).pipe(Layer.provideMerge(fixture))

describe("non-destructive terminal login", () => {
  it.layer(Layer.fresh(controlFixture))((it) => {
    it.effect("bad bearer, Origin and Host mint nothing; valid requests use the durable issuer and drain refuses more", () =>
      Effect.gen(function*() {
        const owner = yield* initialize
        const auth = yield* Auth
        const route = yield* ControlRoute
        const pending = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: identity.owner,
          permission: "workspace-owner"
        })
        const before = yield* auth.listPairingCodes(owner.sessionToken)
        for (
          const [authorization, requestOrigin, host, status] of [
            ["Bearer wrong", origin, "127.0.0.1:4173", 401],
            [`Bearer ${token}`, "http://foreign.example.com", "127.0.0.1:4173", 403],
            [`Bearer ${token}`, origin, "foreign.example.com", 503]
          ] satisfies ReadonlyArray<readonly [string, string, string, number]>
        ) {
          const response = yield* route.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`${origin}/control/login`, {
                  method: "POST",
                  headers: { authorization, origin: requestOrigin, host }
                })
              )
            )
          )
          assert.strictEqual(response.status, status)
        }
        assert.deepStrictEqual(yield* auth.listPairingCodes(owner.sessionToken), before)
        const request = HttpServerRequest.fromWeb(
          new Request(`${origin}/control/login`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, host: "127.0.0.1:4173" }
          })
        )
        const response = yield* route.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
        assert.strictEqual(response.status, 200)
        const answer = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ url: Schema.URLFromString }))
        )(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text()))
        assert.strictEqual(answer.url.origin, origin)
        assert.strictEqual(answer.url.search, "")
        const code = yield* Schema.decodeUnknownEffect(PairingCode)(
          answer.url.hash.slice("#bootstrap_token=".length)
        )
        assert.strictEqual((yield* auth.listPairingCodes(owner.sessionToken)).length, before.length + 1)
        const paired = yield* auth.consumePairingCode(Redacted.make(code))
        assert.strictEqual(paired.session.permission, "workspace-owner")
        assert.deepStrictEqual(paired.session.actor, identity.owner)
        yield* auth.consumePairingCode(pending.pairingCode)
        yield* auth.authenticate(owner.sessionToken)
        const lifecycle = yield* ServerLifecycle
        yield* lifecycle.beginDrain
        assert.strictEqual(
          (yield* route.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))).status,
          503
        )
        assert.strictEqual((yield* auth.listPairingCodes(owner.sessionToken)).length, before.length + 1)
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("preserves an existing owner session and outstanding device codes", () =>
      Effect.gen(function*() {
        const owner = yield* initialize
        const auth = yield* Auth
        const terminal = yield* TerminalLogin
        const pending = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: identity.owner,
          permission: "workspace-owner"
        })
        const fresh = yield* terminal.mint
        assert.strictEqual(
          DateTime.toEpochMillis(fresh.summary.expiresAt) - DateTime.toEpochMillis(fresh.summary.createdAt),
          60_000
        )
        assert.strictEqual((yield* auth.authenticate(owner.sessionToken)).sessionId, owner.session.sessionId)
        const pendingSession = yield* auth.consumePairingCode(pending.pairingCode)
        const freshSession = yield* auth.consumePairingCode(fresh.pairingCode)
        assert.notStrictEqual(pendingSession.session.sessionId, freshSession.session.sessionId)
        assert.strictEqual(freshSession.session.permission, "workspace-owner")
        assert.deepStrictEqual(freshSession.session.actor, identity.owner)
        assert.strictEqual(
          (yield* Effect.flip(auth.consumePairingCode(fresh.pairingCode)))._tag,
          "CredentialRejectedError"
        )
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("rejects a terminal code at its exact deadline without expiring a normal device code", () =>
      Effect.gen(function*() {
        const owner = yield* initialize
        const auth = yield* Auth
        const terminal = yield* TerminalLogin
        const pending = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: identity.owner,
          permission: "workspace-owner"
        })
        const fresh = yield* terminal.mint
        assert.notStrictEqual(Redacted.value(fresh.pairingCode), Redacted.value(pending.pairingCode))
        yield* TestClock.adjust("60 seconds")
        assert.strictEqual(
          (yield* Effect.flip(auth.consumePairingCode(fresh.pairingCode)))._tag,
          "CredentialRejectedError"
        )
        yield* auth.consumePairingCode(pending.pairingCode)
        yield* auth.authenticate(owner.sessionToken)
      }))
  })
})
