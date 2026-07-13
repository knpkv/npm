import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, FileSystem, Layer, Option, Redacted, Result, Schema, Stdio, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { Actor } from "../../src/domain/actors.js"
import { PersonId } from "../../src/domain/identifiers.js"
import { Auth, authLayer } from "../../src/server/auth/Auth.js"
import { AuthRepository } from "../../src/server/auth/AuthRepository.js"
import {
  AuthPermissionDeniedError,
  CredentialRejectedError,
  FirstRunPairingAlreadyIssuedError
} from "../../src/server/auth/errors.js"
import {
  TERMINAL_RECOVERY_CONFIRMATION,
  TerminalRecovery,
  terminalRecoveryLayer
} from "../../src/server/auth/TerminalRecovery.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { authorizeAuthenticatedMutation, decodeBindConfig } from "../../src/server/security/index.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "../persistence/fixtures.js"

const ownerActor = Actor.make({
  _tag: "human",
  personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000031")
})

const reviewerActor = Actor.make({
  _tag: "human",
  personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000032")
})

const authTestLayer = (config: {
  readonly blobRoot: string
  readonly busyTimeoutMilliseconds: number
  readonly databaseUrl: string
  readonly maxConnections: number
}) => {
  const database = databaseLayer(config)
  const quarantine = QuarantineRepository.layer.pipe(Layer.provide(database))
  const repository = AuthRepository.layer.pipe(Layer.provide(Layer.merge(database, quarantine)))
  const auth = Auth.layer.pipe(Layer.provide(repository))
  return Layer.mergeAll(database, quarantine, auth)
}

const recoveryTestLayer = (config: Parameters<typeof authTestLayer>[0]) =>
  Layer.merge(authTestLayer(config), terminalRecoveryLayer(config))

const terminalInputLayer = (input: string) =>
  Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(input))).pipe(
    Effect.map((bytes) => Stdio.layerTest({ stdin: Stream.make(bytes) }))
  )

const createWorkspace = Effect.fn("AuthTest.createWorkspace")(function*(
  workspaceId: typeof fixtureWorkspaceIds.alpha,
  name: string
) {
  const database = yield* Database
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${workspaceId}, ${name}, 1, '2026-07-14T10:00:00.000Z', '2026-07-14T10:00:00.000Z')`
})

describe("Auth", () => {
  it.effect("rejects expired codes and replay without revealing which condition failed", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-replay-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        yield* createWorkspace(fixtureWorkspaceIds.beta, "Beta")

        const expired = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        yield* TestClock.adjust("11 minutes")
        const expiredResult = yield* auth.consumePairingCode(expired.pairingCode).pipe(Effect.result)

        const replayed = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.beta,
          actor: ownerActor
        })
        yield* auth.consumePairingCode(replayed.pairingCode)
        const replayResult = yield* auth.consumePairingCode(replayed.pairingCode).pipe(Effect.result)
        const secondFirstRun = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.beta,
          actor: ownerActor
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(expiredResult))
        assert.isTrue(Result.isFailure(replayResult))
        assert.isTrue(Result.isFailure(secondFirstRun))
        if (Result.isFailure(expiredResult)) assert.instanceOf(expiredResult.failure, CredentialRejectedError)
        if (Result.isFailure(replayResult)) assert.instanceOf(replayResult.failure, CredentialRejectedError)
        if (Result.isFailure(secondFirstRun)) {
          assert.instanceOf(secondFirstRun.failure, FirstRunPairingAlreadyIssuedError)
        }
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("allows exactly one concurrent consumer for a pairing code", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-consume-race-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const issued = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const results = yield* Effect.all([
          auth.consumePairingCode(issued.pairingCode).pipe(Effect.result),
          auth.consumePairingCode(issued.pairingCode).pipe(Effect.result)
        ], { concurrency: "unbounded" })

        const successes = results.filter(Result.isSuccess)
        const failures = results.filter(Result.isFailure)
        assert.strictEqual(successes.length, 1)
        assert.strictEqual(failures.length, 1)
        const failure = failures[0]
        if (failure !== undefined) assert.instanceOf(failure.failure, CredentialRejectedError)
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("supports two sessions, CSRF checks, targeted revocation, and idempotent logout", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-sessions-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const firstCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const first = yield* auth.consumePairingCode(firstCode.pairingCode)
        const secondCode = yield* auth.issuePairingCode(first.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        const second = yield* auth.consumePairingCode(secondCode.pairingCode)

        const sessions = yield* auth.listSessions(first.sessionToken)
        assert.strictEqual(sessions.length, 2)
        assert.deepStrictEqual(
          new Set(sessions.map(({ permission }) => permission)),
          new Set(["workspace-owner", "reviewer"])
        )
        assert.strictEqual(
          (yield* auth.authorizeMutation(first.sessionToken, first.csrfToken)).sessionId,
          first.session.sessionId
        )
        const wrongCsrf = Redacted.make("00".repeat(32))
        const csrfResult = yield* auth.authorizeMutation(first.sessionToken, wrongCsrf).pipe(Effect.result)
        assert.isTrue(Result.isFailure(csrfResult))

        const nonOwnerList = yield* auth.listSessions(second.sessionToken).pipe(Effect.result)
        const nonOwnerIssue = yield* auth.issuePairingCode(second.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        }).pipe(Effect.result)
        const nonOwnerRevoke = yield* auth.revokeSession(
          second.sessionToken,
          first.session.sessionId
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(nonOwnerList))
        assert.isTrue(Result.isFailure(nonOwnerIssue))
        assert.isTrue(Result.isFailure(nonOwnerRevoke))
        if (Result.isFailure(nonOwnerList)) {
          assert.instanceOf(nonOwnerList.failure, AuthPermissionDeniedError)
        }
        if (Result.isFailure(nonOwnerIssue)) {
          assert.instanceOf(nonOwnerIssue.failure, AuthPermissionDeniedError)
        }
        if (Result.isFailure(nonOwnerRevoke)) {
          assert.instanceOf(nonOwnerRevoke.failure, AuthPermissionDeniedError)
        }

        const revokedCode = yield* auth.issuePairingCode(first.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        assert.isTrue((yield* auth.listPairingCodes(first.sessionToken)).some(
          ({ pairingCodeId }) => pairingCodeId === revokedCode.summary.pairingCodeId
        ))
        yield* auth.revokePairingCode(first.sessionToken, revokedCode.summary.pairingCodeId)
        const revokedCodeResult = yield* auth.consumePairingCode(revokedCode.pairingCode).pipe(Effect.result)
        assert.isTrue(Result.isFailure(revokedCodeResult))
        if (Result.isFailure(revokedCodeResult)) {
          assert.instanceOf(revokedCodeResult.failure, CredentialRejectedError)
        }

        yield* auth.revokeSession(first.sessionToken, second.session.sessionId)
        const revokedResult = yield* auth.authenticate(second.sessionToken).pipe(Effect.result)
        assert.isTrue(Result.isFailure(revokedResult))
        assert.strictEqual((yield* auth.authenticate(first.sessionToken)).sessionId, first.session.sessionId)

        yield* auth.logout(first.sessionToken)
        yield* auth.logout(first.sessionToken)
        const loggedOutResult = yield* auth.authenticate(first.sessionToken).pipe(Effect.result)
        assert.isTrue(Result.isFailure(loggedOutResult))
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("composes request security with the public Auth CSRF verifier", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-request-guard-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const code = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const session = yield* auth.consumePairingCode(code.pairingCode)
        const bind = yield* decodeBindConfig({})
        const request = {
          method: "POST",
          host: "127.0.0.1:4173",
          origin: "http://127.0.0.1:4173",
          csrfToken: Redacted.value(session.csrfToken),
          forwardedHost: null,
          forwardedProto: null,
          remoteAddress: "127.0.0.1"
        }
        const authorized = yield* authorizeAuthenticatedMutation({
          config: bind,
          request,
          capability: "release-action"
        }, (csrfToken) => auth.authorizeMutation(session.sessionToken, csrfToken))
        assert.strictEqual(authorized.sessionId, session.session.sessionId)

        const rejected = yield* authorizeAuthenticatedMutation({
          config: bind,
          request: { ...request, csrfToken: "00".repeat(32) },
          capability: "release-action"
        }, (csrfToken) => auth.authorizeMutation(session.sessionToken, csrfToken)).pipe(Effect.result)
        assert.isTrue(Result.isFailure(rejected))
        if (Result.isFailure(rejected)) {
          assert.instanceOf(rejected.failure, CredentialRejectedError)
        }
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("enforces sliding idle and non-sliding absolute session expiry", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-expiry-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        yield* createWorkspace(fixtureWorkspaceIds.beta, "Beta")

        const idleCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const idleSession = yield* auth.consumePairingCode(idleCode.pairingCode)
        yield* TestClock.adjust("13 hours")
        const idleResult = yield* auth.authenticate(idleSession.sessionToken).pipe(Effect.result)
        assert.isTrue(Result.isFailure(idleResult))
        if (Result.isFailure(idleResult)) {
          assert.instanceOf(idleResult.failure, CredentialRejectedError)
        }

        const absoluteCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.beta,
          actor: ownerActor
        })
        const absoluteSession = yield* auth.consumePairingCode(absoluteCode.pairingCode)
        for (let refresh = 0; refresh < 65; refresh += 1) {
          yield* TestClock.adjust("11 hours")
          yield* auth.authenticate(absoluteSession.sessionToken)
        }
        yield* TestClock.adjust("6 hours")
        const absoluteResult = yield* auth.authenticate(absoluteSession.sessionToken).pipe(Effect.result)
        assert.isTrue(Result.isFailure(absoluteResult))
        if (Result.isFailure(absoluteResult)) {
          assert.instanceOf(absoluteResult.failure, CredentialRejectedError)
        }
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("stores only hashes and terminal recovery can revoke existing owner sessions", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-recovery-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        const recoveryService = yield* TerminalRecovery
        const database = yield* Database
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const firstCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const first = yield* auth.consumePairingCode(firstCode.pairingCode)
        const inputLayer = yield* terminalInputLayer(`${TERMINAL_RECOVERY_CONFIRMATION}\n`)
        const recovery = yield* recoveryService.issueOwnerRecovery({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor,
          revokeExistingOwnerSessions: true
        }).pipe(Effect.provide(inputLayer))

        const oldOwnerResult = yield* auth.authenticate(first.sessionToken).pipe(Effect.result)
        assert.isTrue(Result.isFailure(oldOwnerResult))
        const recovered = yield* auth.consumePairingCode(recovery.pairingCode)
        assert.strictEqual(recovered.session.permission, "workspace-owner")

        const pairingRows = yield* database.sql<{ readonly codeHash: string }>`SELECT code_hash AS codeHash
          FROM pairing_codes ORDER BY created_at`
        const sessionRows = yield* database.sql<{
          readonly csrfHash: string
          readonly tokenHash: string
        }>`SELECT csrf_hash AS csrfHash, token_hash AS tokenHash
          FROM sessions ORDER BY created_at`
        const auditRows = yield* database.sql<{
          readonly eventKind: string
          readonly pairingCodeId: string
          readonly revokedOwnerSessions: number
          readonly workspaceId: string
        }>`SELECT workspace_id AS workspaceId, pairing_code_id AS pairingCodeId,
          event_kind AS eventKind, revoked_owner_sessions AS revokedOwnerSessions
          FROM recovery_audit_events`
        const rawSecrets = [
          Redacted.value(firstCode.pairingCode),
          Redacted.value(first.sessionToken),
          Redacted.value(first.csrfToken),
          Redacted.value(recovery.pairingCode),
          Redacted.value(recovered.sessionToken),
          Redacted.value(recovered.csrfToken)
        ]
        const persistedHashes = [
          ...pairingRows.map(({ codeHash }) => codeHash),
          ...sessionRows.flatMap(({ csrfHash, tokenHash }) => [csrfHash, tokenHash])
        ]
        assert.isTrue(persistedHashes.every((hash) => /^[0-9a-f]{64}$/u.test(hash)))
        assert.isTrue(rawSecrets.every((secret) => !persistedHashes.includes(secret)))
        assert.deepStrictEqual(auditRows, [{
          eventKind: "owner-recovery-issued",
          pairingCodeId: recovery.summary.pairingCodeId,
          revokedOwnerSessions: 1,
          workspaceId: fixtureWorkspaceIds.alpha
        }])
        const serialized = JSON.stringify({ firstCode, first, recovered, recovery })
        for (const secret of rawSecrets) assert.notInclude(serialized, secret)
      }).pipe(Effect.provide(recoveryTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("refuses terminal recovery before code creation for unsafe mode or confirmation", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-recovery-refusal-")
      yield* Effect.gen(function*() {
        const recovery = yield* TerminalRecovery
        const database = yield* Database
        const fileSystem = yield* FileSystem.FileSystem
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const dataDirectory = config.databaseUrl.slice(5, -"/control-center.db".length)
        const confirmedLayer = yield* terminalInputLayer(`${TERMINAL_RECOVERY_CONFIRMATION}\n`)
        const rejectedLayer = yield* terminalInputLayer("no\n")
        const request = {
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor,
          revokeExistingOwnerSessions: false
        }

        yield* fileSystem.chmod(dataDirectory, 0o755)
        const wrongMode = yield* recovery.issueOwnerRecovery({
          ...request
        }).pipe(Effect.provide(confirmedLayer), Effect.result)
        yield* fileSystem.chmod(dataDirectory, 0o700)
        const rejectedConfirmation = yield* recovery.issueOwnerRecovery({
          ...request
        }).pipe(Effect.provide(rejectedLayer), Effect.result)
        const rows = yield* database.sql`SELECT pairing_code_id FROM pairing_codes`
        const directoryEntries = yield* fileSystem.readDirectory(dataDirectory)

        assert.isTrue(Result.isFailure(wrongMode))
        assert.isTrue(Result.isFailure(rejectedConfirmation))
        assert.deepStrictEqual(rows, [])
        assert.isFalse(directoryEntries.some((entry) => entry.startsWith(".recovery-owner-")))
      }).pipe(Effect.provide(recoveryTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("refuses a configured database directory reached through a symbolic alias", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-auth-recovery-alias-" })
      const canonicalDirectory = `${root}/canonical`
      const symbolicDirectory = `${root}/symbolic`
      yield* fileSystem.makeDirectory(canonicalDirectory, { mode: 0o700 })
      yield* fileSystem.symlink(canonicalDirectory, symbolicDirectory)
      const config = {
        blobRoot: `${root}/blobs`,
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: `file:${symbolicDirectory}/control-center.db`,
        maxConnections: 1
      }

      const result = yield* Effect.gen(function*() {
        return yield* TerminalRecovery
      }).pipe(
        Effect.provide(terminalRecoveryLayer(config)),
        Effect.result,
        Effect.scoped
      )

      assert.isTrue(Result.isFailure(result))
      assert.isFalse(yield* fileSystem.exists(`${canonicalDirectory}/control-center.db`))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a process-owner probe mismatch and removes the probe", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-recovery-owner-")
      yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha").pipe(
        Effect.provide(databaseLayer(config)),
        Effect.scoped
      )
      const fileSystem = yield* FileSystem.FileSystem
      const dataDirectory = config.databaseUrl.slice(5, -"/control-center.db".length)
      const mismatchedFileSystem = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        open: (target, options) =>
          fileSystem.open(target, options).pipe(
            Effect.map((file) =>
              target.includes(".recovery-owner-")
                ? {
                  ...file,
                  stat: file.stat.pipe(
                    Effect.map((info) => ({
                      ...info,
                      uid: Option.map(info.uid, (uid) => uid + 1)
                    }))
                  )
                }
                : file
            )
          )
      })
      const confirmedLayer = yield* terminalInputLayer(`${TERMINAL_RECOVERY_CONFIRMATION}\n`)
      const result = yield* Effect.gen(function*() {
        const recovery = yield* TerminalRecovery
        return yield* recovery.issueOwnerRecovery({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor,
          revokeExistingOwnerSessions: false
        })
      }).pipe(
        Effect.provide(terminalRecoveryLayer(config)),
        Effect.provide(confirmedLayer),
        Effect.provide(mismatchedFileSystem),
        Effect.result,
        Effect.scoped
      )
      const entries = yield* fileSystem.readDirectory(dataDirectory)
      assert.isTrue(Result.isFailure(result))
      assert.isFalse(entries.some((entry) => entry.startsWith(".recovery-owner-")))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("releases its database directory with the enclosing scope", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* Effect.scoped(
        Effect.gen(function*() {
          const scopedRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-auth-scope-" })
          const config = {
            blobRoot: `${scopedRoot}/blobs`,
            busyTimeoutMilliseconds: 5_000,
            databaseUrl: `file:${scopedRoot}/control-center.db`,
            maxConnections: 1
          }
          yield* Effect.gen(function*() {
            const auth = yield* Auth
            yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
            yield* auth.bootstrapOwnerPairing({
              workspaceId: fixtureWorkspaceIds.alpha,
              actor: ownerActor
            })
          }).pipe(Effect.provide(authTestLayer(config)))
          return scopedRoot
        })
      )
      assert.isFalse(yield* fileSystem.exists(root))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("quarantines malformed auth rows without leaking payloads or poisoning admin lists", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-quarantine-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        const database = yield* Database
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const ownerCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const owner = yield* auth.consumePairingCode(ownerCode.pairingCode)
        const secondCode = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        const second = yield* auth.consumePairingCode(secondCode.pairingCode)
        const malformedCode = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        const canary = "CANARY_AUTH_SECRET_MUST_NOT_ESCAPE"

        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE sessions SET permission = ${canary}
          WHERE session_id = ${second.session.sessionId}`
        yield* database.sql`UPDATE pairing_codes SET permission = ${canary}
          WHERE pairing_code_id = ${malformedCode.summary.pairingCodeId}`

        const sessions = yield* auth.listSessions(owner.sessionToken)
        const pairingCodes = yield* auth.listPairingCodes(owner.sessionToken)
        const singularSession = yield* auth.authenticate(second.sessionToken).pipe(Effect.result)
        const singularPairing = yield* auth.consumePairingCode(malformedCode.pairingCode).pipe(Effect.result)
        const quarantined = yield* database.sql<{
          readonly diagnosticCode: string
          readonly diagnosticSummary: string
          readonly payloadDigest: string
          readonly recordKind: string
        }>`SELECT record_kind AS recordKind, diagnostic_code AS diagnosticCode,
          diagnostic_summary AS diagnosticSummary, payload_digest AS payloadDigest
          FROM quarantined_records ORDER BY record_kind`

        assert.strictEqual(sessions.length, 1)
        assert.isFalse(pairingCodes.some(({ pairingCodeId }) => pairingCodeId === malformedCode.summary.pairingCodeId))
        assert.isTrue(Result.isFailure(singularSession))
        assert.isTrue(Result.isFailure(singularPairing))
        if (Result.isFailure(singularSession)) {
          assert.instanceOf(singularSession.failure, CredentialRejectedError)
        }
        if (Result.isFailure(singularPairing)) {
          assert.instanceOf(singularPairing.failure, CredentialRejectedError)
        }
        assert.deepStrictEqual(
          new Set(quarantined.map(({ recordKind }) => recordKind)),
          new Set(["pairing-code", "session"])
        )
        assert.notInclude(JSON.stringify(quarantined), canary)
        assert.isTrue(quarantined.every(({ payloadDigest }) => /^[0-9a-f]{64}$/u.test(payloadDigest)))
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("durably quarantines malformed rows reached only by singular credential operations", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-singular-quarantine-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        const database = yield* Database
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const ownerCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const owner = yield* auth.consumePairingCode(ownerCode.pairingCode)
        const sessionCode = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        const malformedSession = yield* auth.consumePairingCode(sessionCode.pairingCode)
        const malformedPairing = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        const canary = "CANARY_SINGULAR_AUTH_ROW_MUST_NOT_ESCAPE"

        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE sessions SET permission = ${canary}
          WHERE session_id = ${malformedSession.session.sessionId}`
        yield* database.sql`UPDATE pairing_codes SET permission = ${canary}
          WHERE pairing_code_id = ${malformedPairing.summary.pairingCodeId}`

        const authenticateResult = yield* auth.authenticate(malformedSession.sessionToken).pipe(Effect.result)
        const afterAuthenticate = yield* database.sql<{
          readonly recordKind: string
        }>`SELECT record_kind AS recordKind FROM quarantined_records ORDER BY record_kind`
        const consumeResult = yield* auth.consumePairingCode(malformedPairing.pairingCode).pipe(Effect.result)
        const afterConsume = yield* database.sql<{
          readonly diagnosticSummary: string
          readonly payloadDigest: string
          readonly recordKind: string
        }>`SELECT record_kind AS recordKind, diagnostic_summary AS diagnosticSummary,
          payload_digest AS payloadDigest FROM quarantined_records ORDER BY record_kind`

        assert.isTrue(Result.isFailure(authenticateResult))
        assert.isTrue(Result.isFailure(consumeResult))
        if (Result.isFailure(authenticateResult)) {
          assert.instanceOf(authenticateResult.failure, CredentialRejectedError)
        }
        if (Result.isFailure(consumeResult)) {
          assert.instanceOf(consumeResult.failure, CredentialRejectedError)
        }
        assert.deepStrictEqual(afterAuthenticate, [{ recordKind: "session" }])
        assert.deepStrictEqual(
          afterConsume.map(({ recordKind }) => recordKind),
          ["pairing-code", "session"]
        )
        assert.isTrue(afterConsume.every(({ payloadDigest }) => /^[0-9a-f]{64}$/u.test(payloadDigest)))
        assert.notInclude(JSON.stringify(afterConsume), canary)
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("quarantines singular credentials whose stored identifiers are malformed", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-malformed-id-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        const database = yield* Database
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const ownerCode = yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
        const owner = yield* auth.consumePairingCode(ownerCode.pairingCode)
        const sessionCode = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })
        const malformedSession = yield* auth.consumePairingCode(sessionCode.pairingCode)
        const malformedPairing = yield* auth.issuePairingCode(owner.sessionToken, {
          actor: reviewerActor,
          permission: "reviewer"
        })

        yield* database.sql`PRAGMA foreign_keys = OFF`
        yield* database.sql`UPDATE sessions SET session_id = 'malformed-session-id'
          WHERE session_id = ${malformedSession.session.sessionId}`
        yield* database.sql`PRAGMA foreign_keys = ON`
        yield* database.sql`UPDATE pairing_codes SET pairing_code_id = 'malformed-pairing-id'
          WHERE pairing_code_id = ${malformedPairing.summary.pairingCodeId}`

        const sessionResult = yield* auth.authenticate(malformedSession.sessionToken).pipe(Effect.result)
        const pairingResult = yield* auth.consumePairingCode(malformedPairing.pairingCode).pipe(Effect.result)
        const quarantined = yield* database.sql<{
          readonly recordKey: string
          readonly recordKind: string
        }>`SELECT record_kind AS recordKind, record_key AS recordKey
          FROM quarantined_records ORDER BY record_kind`

        assert.isTrue(Result.isFailure(sessionResult))
        assert.isTrue(Result.isFailure(pairingResult))
        assert.deepStrictEqual(
          quarantined,
          [
            { recordKey: fixtureWorkspaceIds.alpha, recordKind: "pairing-code" },
            { recordKey: fixtureWorkspaceIds.alpha, recordKind: "session" }
          ]
        )
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("serializes concurrent first-run issuance to one stable winner", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-first-run-race-")
      yield* Effect.gen(function*() {
        const auth = yield* Auth
        yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha")
        const results = yield* Effect.all([
          auth.bootstrapOwnerPairing({
            workspaceId: fixtureWorkspaceIds.alpha,
            actor: ownerActor
          }).pipe(Effect.result),
          auth.bootstrapOwnerPairing({
            workspaceId: fixtureWorkspaceIds.alpha,
            actor: ownerActor
          }).pipe(Effect.result)
        ], { concurrency: "unbounded" })
        const successes = results.filter(Result.isSuccess)
        const failures = results.filter(Result.isFailure)
        assert.strictEqual(successes.length, 1)
        assert.strictEqual(failures.length, 1)
        const failure = failures[0]
        if (failure !== undefined) {
          assert.instanceOf(failure.failure, FirstRunPairingAlreadyIssuedError)
        }
      }).pipe(Effect.provide(authTestLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("constructs the public standalone Auth layer without exposing its repository", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-auth-public-layer-")
      yield* createWorkspace(fixtureWorkspaceIds.alpha, "Alpha").pipe(
        Effect.provide(databaseLayer(config)),
        Effect.scoped
      )
      const issued = yield* Effect.gen(function*() {
        const auth = yield* Auth
        return yield* auth.bootstrapOwnerPairing({
          workspaceId: fixtureWorkspaceIds.alpha,
          actor: ownerActor
        })
      }).pipe(Effect.provide(authLayer(config)), Effect.scoped)
      assert.strictEqual(issued.summary.workspaceId, fixtureWorkspaceIds.alpha)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
