import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Encoding from "effect/Encoding"

import { SessionSummary } from "../../src/api/session.js"
import { WorkspaceSettingsRevision } from "../../src/api/workspaceSettings.js"
import { PersonId, SessionId, WorkspaceId, WorkspaceSettingsMutationId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  DEFAULT_WORKSPACE_SETTINGS,
  GovernedWorkspaceSettingsSections,
  WorkspaceSettingsV1
} from "../../src/domain/workspaceSettings.js"
import { makeWorkspaceSettingsAdministration } from "../../src/server/application/workspaceSettingsAdministration.js"
import {
  authorizeWorkspaceSettingsGovernanceRequest,
  digestWorkspaceSettingsGovernanceRequest,
  WorkspaceSettingsGovernanceAuthority
} from "../../src/server/governance/GovernedHumanMutationPolicyEvaluator.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { RecordRevision } from "../../src/server/persistence/repositories/models.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)(
  "01890f6f-6d6a-7cc0-98d2-000000000170"
)
const foreignWorkspaceId = Schema.decodeSync(WorkspaceId)(
  "01890f6f-6d6a-7cc0-98d2-000000000169"
)
const ownerOne = Schema.decodeSync(PersonId)(
  "01890f6f-6d6a-7cc0-98d2-000000000171"
)
const ownerTwo = Schema.decodeSync(PersonId)(
  "01890f6f-6d6a-7cc0-98d2-000000000172"
)
const sessionOne = Schema.decodeSync(SessionId)(
  "01890f6f-6d6a-7cc0-98d2-000000000173"
)
const sessionTwo = Schema.decodeSync(SessionId)(
  "01890f6f-6d6a-7cc0-98d2-000000000174"
)
const firstMutation = Schema.decodeSync(WorkspaceSettingsMutationId)(
  "01890f6f-6d6a-7cc0-98d2-000000000175"
)
const secondMutation = Schema.decodeSync(WorkspaceSettingsMutationId)(
  "01890f6f-6d6a-7cc0-98d2-000000000176"
)
const recoveredMutation = Schema.decodeSync(WorkspaceSettingsMutationId)(
  "01890f6f-6d6a-7cc0-98d2-000000000177"
)
const firstUpdateAt = Schema.decodeSync(UtcTimestamp)(
  "2026-07-30T10:00:00.000Z"
)
const recoveredAt = Schema.decodeSync(UtcTimestamp)(
  "2026-07-30T10:01:00.000Z"
)
const ownerSession = Schema.decodeSync(SessionSummary)({
  sessionId: sessionOne,
  workspaceId,
  actor: { _tag: "human", personId: ownerOne },
  permission: "workspace-owner",
  createdAt: "2026-07-30T09:00:00.000Z",
  lastSeenAt: "2026-07-30T09:00:00.000Z",
  idleExpiresAt: "2026-07-31T09:00:00.000Z",
  absoluteExpiresAt: "2026-08-30T09:00:00.000Z",
  revokedAt: null
})
const contributorSession = Schema.decodeSync(SessionSummary)({
  ...Schema.encodeSync(SessionSummary)(ownerSession),
  permission: "contributor"
})
const foreignOwnerSession = Schema.decodeSync(SessionSummary)({
  ...Schema.encodeSync(SessionSummary)(ownerSession),
  workspaceId: foreignWorkspaceId
})
const utf8Encoder = new TextEncoder()

const digestRawRow = Effect.fn(
  "WorkspaceSettingsRepositoryTest.digestRawRow"
)(function*(row: unknown) {
  const serialized = yield* Effect.sync(() => JSON.stringify(row))
  const cryptoService = yield* Crypto.Crypto
  return Encoding.encodeHex(
    yield* cryptoService.digest("SHA-256", utf8Encoder.encode(serialized))
  )
})

const withPersistence = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Database | Persistence>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig(
      "control-center-workspace-settings-"
    )
    const database = databaseLayer(config)
    const persistence = persistenceLayerFromDatabase(config).pipe(
      Layer.provideMerge(database)
    )
    return yield* use.pipe(Effect.provide(persistence))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedAuthority = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
      workspace_id, display_name, revision, created_at, updated_at
    ) VALUES (
      ${workspaceId}, 'Payments', 1,
      '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z'
    )`
  yield* sql`INSERT INTO persons (
      workspace_id, person_id, display_name, avatar_json, is_active,
      revision, created_at, updated_at
    ) VALUES
    (
      ${workspaceId}, ${ownerOne}, 'Owner One',
      '{"_tag":"initials","text":"O1"}', 1, 1,
      '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z'
    ), (
      ${workspaceId}, ${ownerTwo}, 'Owner Two',
      '{"_tag":"initials","text":"O2"}', 1, 1,
      '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z'
    )`
  yield* sql`INSERT INTO sessions (
      workspace_id, session_id, token_hash, csrf_hash, actor_kind,
      person_id, agent_id, permission, created_at, last_seen_at,
      idle_expires_at, absolute_expires_at, revoked_at
    ) VALUES
    (
      ${workspaceId}, ${sessionOne}, ${"a".repeat(64)}, ${"b".repeat(64)},
      'human', ${ownerOne}, NULL, 'workspace-owner',
      '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z',
      '2026-07-31T09:00:00.000Z', '2026-08-30T09:00:00.000Z', NULL
    ), (
      ${workspaceId}, ${sessionTwo}, ${"c".repeat(64)}, ${"d".repeat(64)},
      'human', ${ownerTwo}, NULL, 'workspace-owner',
      '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z',
      '2026-07-31T09:00:00.000Z', '2026-08-30T09:00:00.000Z', NULL
    )`
})

describe("WorkspaceSettingsRepository", () => {
  it.effect("updates a fresh workspace without a settings read preflight", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const { sql } = yield* Database
        const updated = yield* persistence.workspaceSettings.update(workspaceId, {
          mutationId: firstMutation,
          expectedRevision: RecordRevision.make(1),
          settings: {
            ...DEFAULT_WORKSPACE_SETTINGS,
            presentation: {
              ...DEFAULT_WORKSPACE_SETTINGS.presentation,
              density: "compact"
            }
          },
          acknowledgedGovernedSections: [],
          governanceAuthority: null,
          actorPersonId: ownerOne,
          sessionId: sessionOne,
          updatedAt: firstUpdateAt
        })

        assert.strictEqual(updated.revision, 2)
        assert.strictEqual(
          DateTime.formatIso(updated.createdAt),
          "2026-07-30T09:00:00.000Z"
        )
        assert.strictEqual(
          DateTime.formatIso(updated.updatedAt),
          "2026-07-30T10:00:00.000Z"
        )
        assert.strictEqual(updated.settings.presentation.density, "compact")
        const versions = yield* sql<{ readonly revision: number }>`SELECT revision
          FROM workspace_settings_versions
          WHERE workspace_id = ${workspaceId}
          ORDER BY revision`
        assert.deepStrictEqual(versions.map(({ revision }) => revision), [1, 2])
        const audits = yield* persistence.workspaceSettings.audits(workspaceId)
        assert.lengthOf(audits, 1)
        assert.strictEqual(audits[0]?.fromRevision, 1)
        assert.strictEqual(audits[0]?.toRevision, 2)
      })
    ))

  it.effect("initializes defaults once and keeps repeated reads write-free", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const { sql } = yield* Database
        const initialized = yield* persistence.workspaceSettings.get(workspaceId)
        const headRows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM workspace_settings
          WHERE workspace_id = ${workspaceId}`
        const versionRows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM workspace_settings_versions
          WHERE workspace_id = ${workspaceId}`
        assert.strictEqual(headRows[0]?.count, 1)
        assert.strictEqual(versionRows[0]?.count, 1)

        yield* sql`CREATE TRIGGER reject_repeat_workspace_settings_head
          BEFORE INSERT ON workspace_settings
          WHEN NEW.workspace_id = '01890f6f-6d6a-7cc0-98d2-000000000170'
          BEGIN
            SELECT RAISE(ABORT, 'existing workspace settings reads must not insert');
          END`
        yield* sql`CREATE TRIGGER reject_repeat_workspace_settings_version
          BEFORE INSERT ON workspace_settings_versions
          WHEN NEW.workspace_id = '01890f6f-6d6a-7cc0-98d2-000000000170'
          BEGIN
            SELECT RAISE(ABORT, 'existing workspace settings reads must not insert versions');
          END`

        const repeated = yield* persistence.workspaceSettings.get(workspaceId)
        assert.deepStrictEqual(repeated, initialized)
      })
    ))

  it.effect(
    "forces two sessions through explicit conflict recovery without losing either change",
    () =>
      withPersistence(
        Effect.gen(function*() {
          yield* seedAuthority
          const persistence = yield* Persistence
          const { sql } = yield* Database
          const original = yield* persistence.workspaceSettings.get(workspaceId)
          const firstCandidate: WorkspaceSettingsV1 = {
            ...original.settings,
            inference: {
              ...original.settings.inference,
              minimumConfidencePercent: 92
            }
          }
          const secondCandidate: WorkspaceSettingsV1 = {
            ...original.settings,
            presentation: {
              ...original.settings.presentation,
              density: "compact"
            }
          }

          const first = yield* persistence.workspaceSettings.update(workspaceId, {
            mutationId: firstMutation,
            expectedRevision: original.revision,
            settings: firstCandidate,
            acknowledgedGovernedSections: [],
            governanceAuthority: null,
            actorPersonId: ownerOne,
            sessionId: sessionOne,
            updatedAt: firstUpdateAt
          })
          assert.strictEqual(first.revision, 2)

          const stale = yield* persistence.workspaceSettings
            .update(workspaceId, {
              mutationId: secondMutation,
              expectedRevision: original.revision,
              settings: secondCandidate,
              acknowledgedGovernedSections: [],
              governanceAuthority: null,
              actorPersonId: ownerTwo,
              sessionId: sessionTwo,
              updatedAt: firstUpdateAt
            })
            .pipe(Effect.result)
          assert.isTrue(Result.isFailure(stale))
          if (Result.isFailure(stale)) {
            assert.strictEqual(stale.failure._tag, "RevisionConflictError")
          }

          const latest = yield* persistence.workspaceSettings.get(workspaceId)
          const recovered = yield* persistence.workspaceSettings.update(
            workspaceId,
            {
              mutationId: recoveredMutation,
              expectedRevision: latest.revision,
              settings: {
                ...latest.settings,
                presentation: secondCandidate.presentation
              },
              acknowledgedGovernedSections: [],
              governanceAuthority: null,
              actorPersonId: ownerTwo,
              sessionId: sessionTwo,
              updatedAt: recoveredAt
            }
          )

          assert.strictEqual(recovered.revision, 3)
          assert.strictEqual(
            recovered.settings.inference.minimumConfidencePercent,
            92
          )
          assert.strictEqual(recovered.settings.presentation.density, "compact")
          const replayedFirst = yield* persistence.workspaceSettings.update(
            workspaceId,
            {
              mutationId: firstMutation,
              expectedRevision: original.revision,
              settings: firstCandidate,
              acknowledgedGovernedSections: [],
              governanceAuthority: null,
              actorPersonId: ownerOne,
              sessionId: sessionOne,
              updatedAt: firstUpdateAt
            }
          )
          assert.strictEqual(replayedFirst.revision, 2)
          assert.strictEqual(
            replayedFirst.settings.presentation.density,
            "comfortable"
          )
          const audits = yield* persistence.workspaceSettings.audits(workspaceId)
          assert.deepStrictEqual(
            audits.map((audit) => ({
              actorPersonId: audit.actorPersonId,
              changedSections: audit.changedSections,
              fromRevision: Number(audit.fromRevision),
              sessionId: audit.sessionId,
              toRevision: Number(audit.toRevision)
            })),
            [
              {
                actorPersonId: ownerOne,
                changedSections: ["inference"],
                fromRevision: 1,
                sessionId: sessionOne,
                toRevision: 2
              },
              {
                actorPersonId: ownerTwo,
                changedSections: ["presentation"],
                fromRevision: 2,
                sessionId: sessionTwo,
                toRevision: 3
              }
            ]
          )
          assert.isTrue(
            Result.isFailure(
              yield* sql`UPDATE workspace_settings_audits
                SET governed = 1
                WHERE workspace_id = ${workspaceId}`.pipe(Effect.result)
            )
          )
          assert.isTrue(
            Result.isFailure(
              yield* sql`DELETE FROM workspace_settings_audits
                WHERE workspace_id = ${workspaceId}`.pipe(Effect.result)
            )
          )
          assert.isTrue(
            Result.isFailure(
              yield* sql`UPDATE workspace_settings_versions
                SET settings_digest = ${"f".repeat(64)}
                WHERE workspace_id = ${workspaceId}`.pipe(Effect.result)
            )
          )
          assert.isTrue(
            Result.isFailure(
              yield* sql`DELETE FROM workspace_settings_versions
                WHERE workspace_id = ${workspaceId}`.pipe(Effect.result)
            )
          )
        })
      )
  )

  it.effect("requires the exact governed-section acknowledgement", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        const governedCandidate = {
          ...original.settings,
          retention: {
            ...original.settings.retention,
            contentDays: 120
          }
        }
        const rejected = yield* persistence.workspaceSettings
          .update(workspaceId, {
            mutationId: firstMutation,
            expectedRevision: original.revision,
            settings: governedCandidate,
            acknowledgedGovernedSections: [],
            governanceAuthority: null,
            actorPersonId: ownerOne,
            sessionId: sessionOne,
            updatedAt: firstUpdateAt
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(rejected))
        if (Result.isFailure(rejected)) {
          assert.strictEqual(
            rejected.failure._tag,
            "WorkspaceSettingsGovernanceError"
          )
        }

        const repositoryRequest = {
          mutationId: secondMutation,
          expectedRevision: original.revision,
          settings: governedCandidate,
          acknowledgedGovernedSections: GovernedWorkspaceSettingsSections.make(["retention"]),
          actorPersonId: ownerOne,
          sessionId: sessionOne
        }
        const governanceRequest = { workspaceId, ...repositoryRequest }
        const acknowledgementOnly = yield* persistence.workspaceSettings.update(
          workspaceId,
          {
            ...repositoryRequest,
            governanceAuthority: null,
            updatedAt: firstUpdateAt
          }
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(acknowledgementOnly))
        if (Result.isFailure(acknowledgementOnly)) {
          assert.strictEqual(
            acknowledgementOnly.failure._tag,
            "WorkspaceSettingsGovernanceError"
          )
        }
        const forgedAuthority = new WorkspaceSettingsGovernanceAuthority(
          yield* digestWorkspaceSettingsGovernanceRequest(governanceRequest),
          firstUpdateAt
        )
        const forged = yield* persistence.workspaceSettings.update(
          workspaceId,
          {
            ...repositoryRequest,
            governanceAuthority: forgedAuthority,
            updatedAt: firstUpdateAt
          }
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(forged))
        if (Result.isFailure(forged)) {
          assert.strictEqual(
            forged.failure._tag,
            "WorkspaceSettingsGovernanceError"
          )
        }
        const governanceAuthority = yield* authorizeWorkspaceSettingsGovernanceRequest(
          ownerSession,
          governanceRequest,
          firstUpdateAt
        )
        const accepted = yield* persistence.workspaceSettings.update(
          workspaceId,
          {
            ...repositoryRequest,
            governanceAuthority,
            updatedAt: firstUpdateAt
          }
        )
        assert.strictEqual(accepted.revision, 2)
        const [governedAudit] = yield* persistence.workspaceSettings.audits(workspaceId)
        assert.isNotNull(governanceAuthority)
        assert.isDefined(governedAudit)
        assert.strictEqual(
          governedAudit.governanceAuthorityDigest,
          governanceAuthority.requestDigest
        )
      })
    ))

  it.effect("commits quarantine evidence after an update transaction rolls back", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const { sql } = yield* Database
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        yield* sql`UPDATE workspace_settings
          SET settings_digest = ${"0".repeat(64)}
          WHERE workspace_id = ${workspaceId}`

        const result = yield* persistence.workspaceSettings.update(workspaceId, {
          mutationId: firstMutation,
          expectedRevision: original.revision,
          settings: {
            ...original.settings,
            presentation: {
              ...original.settings.presentation,
              density: "compact"
            }
          },
          acknowledgedGovernedSections: [],
          governanceAuthority: null,
          actorPersonId: ownerOne,
          sessionId: sessionOne,
          updatedAt: firstUpdateAt
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "PersistedRecordError")
        }
        const quarantineRows = yield* sql<{ readonly diagnosticCode: string }>`SELECT
          diagnostic_code AS diagnosticCode
        FROM quarantined_records
        WHERE workspace_id = ${workspaceId}`
        assert.lengthOf(quarantineRows, 1)
        assert.strictEqual(
          quarantineRows[0]?.diagnosticCode,
          "workspace-settings-digest-mismatch"
        )
      })
    ))

  it.effect("quarantines the exact corrupt replay version after rollback", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const { sql } = yield* Database
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        const firstCandidate: WorkspaceSettingsV1 = {
          ...original.settings,
          inference: {
            ...original.settings.inference,
            minimumConfidencePercent: 92
          }
        }
        const first = yield* persistence.workspaceSettings.update(workspaceId, {
          mutationId: firstMutation,
          expectedRevision: original.revision,
          settings: firstCandidate,
          acknowledgedGovernedSections: [],
          governanceAuthority: null,
          actorPersonId: ownerOne,
          sessionId: sessionOne,
          updatedAt: firstUpdateAt
        })
        yield* persistence.workspaceSettings.update(workspaceId, {
          mutationId: secondMutation,
          expectedRevision: first.revision,
          settings: {
            ...first.settings,
            presentation: {
              ...first.settings.presentation,
              density: "compact"
            }
          },
          acknowledgedGovernedSections: [],
          governanceAuthority: null,
          actorPersonId: ownerTwo,
          sessionId: sessionTwo,
          updatedAt: recoveredAt
        })

        yield* sql`DROP TRIGGER workspace_settings_versions_no_update`
        yield* sql`UPDATE workspace_settings_versions
          SET settings_json = '{}'
          WHERE workspace_id = ${workspaceId}
            AND revision = 2`
        const selectRawSettings = (
          table:
            | "workspace_settings"
            | "workspace_settings_versions",
          revision: number
        ) =>
          table === "workspace_settings"
            ? sql<Record<string, unknown>>`SELECT
                workspace_id AS workspaceId,
                schema_version AS schemaVersion,
                revision,
                policy_revision AS policyRevision,
                settings_json AS settingsJson,
                settings_digest AS settingsDigest,
                created_at AS createdAt,
                updated_at AS updatedAt,
                updated_by_person_id AS updatedByPersonId
              FROM workspace_settings
              WHERE workspace_id = ${workspaceId}
                AND revision = ${revision}`
            : sql<Record<string, unknown>>`SELECT
                workspace_id AS workspaceId,
                schema_version AS schemaVersion,
                revision,
                policy_revision AS policyRevision,
                settings_json AS settingsJson,
                settings_digest AS settingsDigest,
                created_at AS createdAt,
                updated_at AS updatedAt,
                updated_by_person_id AS updatedByPersonId
              FROM workspace_settings_versions
              WHERE workspace_id = ${workspaceId}
                AND revision = ${revision}`
        const versionRow = (yield* selectRawSettings(
          "workspace_settings_versions",
          2
        ))[0]
        const headRow = (yield* selectRawSettings(
          "workspace_settings",
          3
        ))[0]
        if (versionRow === undefined || headRow === undefined) {
          return yield* Effect.die("expected settings head and version rows")
        }

        const replay = yield* persistence.workspaceSettings.update(workspaceId, {
          mutationId: firstMutation,
          expectedRevision: original.revision,
          settings: firstCandidate,
          acknowledgedGovernedSections: [],
          governanceAuthority: null,
          actorPersonId: ownerOne,
          sessionId: sessionOne,
          updatedAt: firstUpdateAt
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(replay))
        if (Result.isFailure(replay)) {
          assert.strictEqual(replay.failure._tag, "PersistedRecordError")
        }

        const quarantine = yield* sql<{ readonly payloadDigest: string }>`SELECT
          payload_digest AS payloadDigest
        FROM quarantined_records
        WHERE workspace_id = ${workspaceId}`
        assert.strictEqual(
          quarantine[0]?.payloadDigest,
          yield* digestRawRow(versionRow)
        )
        assert.notStrictEqual(
          quarantine[0]?.payloadDigest,
          yield* digestRawRow(headRow)
        )
      })
    ))

  it.effect("rejects secret-shaped excess settings without persisting the canary", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const { sql } = yield* Database
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        const secretCanary = "token=must-never-enter-settings"
        const result = Schema.decodeUnknownResult(WorkspaceSettingsV1, {
          onExcessProperty: "error"
        })({
          ...original.settings,
          token: secretCanary
        })
        assert.isTrue(Result.isFailure(result))
        const stored = yield* sql<{ readonly settingsJson: string }>`SELECT
          settings_json AS settingsJson
        FROM workspace_settings
        WHERE workspace_id = ${workspaceId}`
        assert.notInclude(stored[0]?.settingsJson ?? "", secretCanary)
      })
    ))

  it.effect("keeps local-profile unavailable without verified CLI capabilities", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const administration = yield* makeWorkspaceSettingsAdministration
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        const result = yield* administration.update({
          workspaceId,
          session: ownerSession,
          request: {
            mutationId: firstMutation,
            expectedRevision: WorkspaceSettingsRevision.make(
              original.revision
            ),
            settings: {
              ...original.settings,
              agent: {
                ...original.settings.agent,
                profilePolicy: "local-profile"
              }
            },
            acknowledgedGovernedSections: ["agent"]
          }
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "ApplicationInvalidRequest")
        }
        assert.strictEqual(
          (yield* persistence.workspaceSettings.get(workspaceId)).revision,
          1
        )
        assert.lengthOf(
          yield* persistence.workspaceSettings.audits(workspaceId),
          0
        )
      })
    ))

  it.effect("rolls back an inference policy update when bounded reconciliation is incomplete", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const fakePersistence = Persistence.of({
          ...persistence,
          deliveryGraph: {
            ...persistence.deliveryGraph,
            read: (selectedWorkspaceId, input) => {
              if (
                typeof input === "object" &&
                input !== null &&
                "_tag" in input &&
                input._tag === "workspaceEntityProjections"
              ) {
                return persistence.deliveryGraph.read(selectedWorkspaceId, input).pipe(
                  Effect.map((result) =>
                    result._tag === "workspaceEntityProjections"
                      ? {
                        ...result,
                        value: { ...result.value, truncated: true }
                      }
                      : result
                  )
                )
              }
              return persistence.deliveryGraph.read(selectedWorkspaceId, input)
            }
          }
        })
        const administration = yield* makeWorkspaceSettingsAdministration.pipe(
          Effect.provideService(Persistence, fakePersistence)
        )
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        const result = yield* administration.update({
          workspaceId,
          session: ownerSession,
          request: {
            mutationId: firstMutation,
            expectedRevision: WorkspaceSettingsRevision.make(original.revision),
            settings: {
              ...original.settings,
              inference: {
                ...original.settings.inference,
                minimumConfidencePercent: 99
              }
            },
            acknowledgedGovernedSections: []
          }
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "ApplicationServiceUnavailable")
        }
        assert.strictEqual(
          (yield* persistence.workspaceSettings.get(workspaceId)).revision,
          original.revision
        )
        assert.lengthOf(yield* persistence.workspaceSettings.audits(workspaceId), 0)
      })
    ))

  it.effect("rejects settings updates outside the caller's owned workspace", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const administration = yield* makeWorkspaceSettingsAdministration
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        const settings = WorkspaceSettingsV1.make({
          ...original.settings,
          presentation: {
            ...original.settings.presentation,
            density: "compact"
          }
        })
        const request = {
          mutationId: firstMutation,
          expectedRevision: WorkspaceSettingsRevision.make(original.revision),
          settings,
          acknowledgedGovernedSections: []
        }

        for (const session of [contributorSession, foreignOwnerSession]) {
          const result = yield* administration.update({
            workspaceId,
            session,
            request
          }).pipe(Effect.result)
          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure._tag, "ApplicationInvalidRequest")
          }
        }

        assert.strictEqual(
          (yield* persistence.workspaceSettings.get(workspaceId)).revision,
          1
        )
        assert.lengthOf(
          yield* persistence.workspaceSettings.audits(workspaceId),
          0
        )
      })
    ))

  it.effect("reconstructs the committed settings from a fresh persistence layer", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig(
        "control-center-workspace-settings-restart-"
      )
      const makeLayer = () => {
        const database = databaseLayer(config)
        return persistenceLayerFromDatabase(config).pipe(
          Layer.provideMerge(database)
        )
      }
      const committed = yield* Effect.gen(function*() {
        yield* seedAuthority
        const persistence = yield* Persistence
        const original = yield* persistence.workspaceSettings.get(workspaceId)
        return yield* persistence.workspaceSettings.update(workspaceId, {
          mutationId: firstMutation,
          expectedRevision: original.revision,
          settings: {
            ...original.settings,
            presentation: {
              ...original.settings.presentation,
              density: "compact"
            }
          },
          acknowledgedGovernedSections: [],
          governanceAuthority: null,
          actorPersonId: ownerOne,
          sessionId: sessionOne,
          updatedAt: firstUpdateAt
        })
      }).pipe(Effect.provide(makeLayer()))
      const reconstructed = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        return yield* persistence.workspaceSettings.get(workspaceId)
      }).pipe(Effect.provide(makeLayer()))

      assert.strictEqual(reconstructed.revision, committed.revision)
      assert.deepStrictEqual(reconstructed.settings, committed.settings)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
