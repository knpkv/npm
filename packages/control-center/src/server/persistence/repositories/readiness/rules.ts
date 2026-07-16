import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import type {
  ReadinessRuleId,
  ReadinessRuleMaterial,
  ReadinessRuleVersion
} from "../../../../domain/readiness/index.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../errors.js"
import { readChanges } from "../internal.js"
import { makeReadinessCodec } from "./codec.js"
import { ReadinessInputError, RegisterReadinessRuleRequest, type RegisterReadinessRuleResult } from "./contract.js"
import { captureMalformedReadinessRow } from "./quarantine.js"
import { RawReadinessRow, ReadinessRuleRow } from "./rows.js"

const RuleKey = Schema.Struct({
  workspaceId: RegisterReadinessRuleRequest.fields.workspaceId,
  ruleId: RegisterReadinessRuleRequest.fields.material.fields.ruleId,
  ruleVersion: RegisterReadinessRuleRequest.fields.material.fields.version
})

const InsertRule = Schema.Struct({
  ...RuleKey.fields,
  ruleDigest: RegisterReadinessRuleRequest.fields.digest,
  materialJson: Schema.String,
  createdAt: UtcTimestamp
})

export const makeReadinessRules = Effect.gen(function*() {
  const database = yield* Database
  const codec = yield* makeReadinessCodec
  const sql = database.sql

  const findRule = SqlSchema.findOneOption({
    Request: RuleKey,
    Result: RawReadinessRow,
    execute: ({ ruleId, ruleVersion, workspaceId }) =>
      sql`SELECT workspace_id AS workspaceId,
                 rule_id AS ruleId,
                 rule_version AS ruleVersion,
                 rule_digest AS ruleDigest,
                 material_json AS materialJson,
                 created_at AS createdAt
          FROM readiness_rule_snapshots
          WHERE workspace_id = ${workspaceId}
            AND rule_id = ${ruleId}
            AND rule_version = ${ruleVersion}`
  })

  const insertRule = SqlSchema.void({
    Request: InsertRule,
    execute: ({ createdAt, materialJson, ruleDigest, ruleId, ruleVersion, workspaceId }) =>
      sql`INSERT INTO readiness_rule_snapshots (
            workspace_id, rule_id, rule_version, rule_digest, material_json, created_at
          ) VALUES (
            ${workspaceId}, ${ruleId}, ${ruleVersion}, ${ruleDigest}, ${materialJson}, ${createdAt}
          ) ON CONFLICT (workspace_id, rule_id, rule_version) DO NOTHING`
  })

  const decodeStoredRule = Effect.fn("ReadinessRules.decodeStoredRule")(function*(
    row: typeof RawReadinessRow.Type,
    key: typeof RuleKey.Type
  ) {
    const malformed = () =>
      new PersistedRecordError({
        workspaceId: key.workspaceId,
        recordKind: "readiness-rule",
        recordKey: `${key.ruleId}:${key.ruleVersion}`,
        diagnosticCode: "readiness-rule-schema-invalid"
      })
    const decodedRow = yield* Schema.decodeUnknownEffect(ReadinessRuleRow)(row).pipe(
      Effect.mapError(malformed),
      captureMalformedReadinessRow(row)
    )
    const material = yield* codec.decodeRuleRow(decodedRow).pipe(captureMalformedReadinessRow(row))
    const registeredAt = yield* Schema.decodeUnknownEffect(UtcTimestamp)(decodedRow.createdAt).pipe(
      Effect.mapError(malformed),
      captureMalformedReadinessRow(row)
    )
    return { material, registeredAt, row: decodedRow }
  })

  const loadRule = Effect.fn("ReadinessRules.load")(function*(input: {
    readonly workspaceId: (typeof RuleKey.Type)["workspaceId"]
    readonly ruleId: ReadinessRuleId
    readonly ruleVersion: ReadinessRuleVersion
  }) {
    const found = yield* findRule(input)
    if (Option.isNone(found)) {
      return yield* new RecordNotFoundError({
        workspaceId: input.workspaceId,
        recordKind: "readiness-rule",
        recordKey: `${input.ruleId}:${input.ruleVersion}`
      })
    }
    return yield* decodeStoredRule(found.value, input)
  })

  const register = Effect.fn("ReadinessRules.register")(function*(request: RegisterReadinessRuleRequest) {
    const prepared = yield* codec.prepareRule(request.material)
    if (prepared.ruleDigest !== request.digest) {
      return yield* new ReadinessInputError({
        operation: "register-rule",
        reason: "rule-digest-mismatch"
      })
    }
    const key = {
      workspaceId: request.workspaceId,
      ruleId: request.material.ruleId,
      ruleVersion: request.material.version
    }
    yield* insertRule({
      ...key,
      ruleDigest: request.digest,
      materialJson: prepared.materialJson,
      createdAt: request.registeredAt
    })
    if ((yield* readChanges(sql)) === 1) {
      return {
        _tag: "created",
        record: { ...request, material: prepared.material }
      } satisfies RegisterReadinessRuleResult
    }
    const existing = yield* findRule(key)
    if (Option.isNone(existing)) {
      return yield* new RecordNotFoundError({
        workspaceId: request.workspaceId,
        recordKind: "readiness-rule",
        recordKey: `${request.material.ruleId}:${request.material.version}`
      })
    }
    const stored = yield* decodeStoredRule(existing.value, key)
    if (
      stored.row.ruleDigest !== request.digest ||
      JSON.stringify(stored.material) !== JSON.stringify(prepared.material)
    ) {
      return yield* new ReadinessInputError({
        operation: "register-rule",
        reason: "rule-digest-mismatch"
      })
    }
    return {
      _tag: "existing",
      record: {
        workspaceId: request.workspaceId,
        material: stored.material,
        digest: stored.row.ruleDigest,
        registeredAt: stored.registeredAt
      }
    } satisfies RegisterReadinessRuleResult
  })

  const definitionsMatch = (
    material: ReadinessRuleMaterial,
    definitions: ReadonlyArray<ReadinessRuleMaterial["definitions"][number]>
  ): boolean => JSON.stringify(material.definitions) === JSON.stringify(definitions)

  return { definitionsMatch, loadRule, register }
})
