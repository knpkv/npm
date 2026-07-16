import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  digestGovernedActionPermitToken,
  digestGovernedActionPreparationToken,
  digestGovernedActionRecoveryToken,
  GovernedActionPermitToken,
  GovernedActionPermitTokenDigest,
  GovernedActionPreparationToken,
  GovernedActionPreparationTokenDigest,
  GovernedActionRecoveryToken,
  GovernedActionRecoveryTokenDigest,
  issueGovernedActionPermitToken,
  issueGovernedActionPreparationToken,
  issueGovernedActionRecoveryToken
} from "../../src/server/governance/internal/execution-store/tokens.js"

type IsAssignable<From, To> = [From] extends [To] ? true : false
type AssertFalse<Value extends false> = Value

export type GovernedActionExecutionTokenTypesAreDisjoint = readonly [
  AssertFalse<IsAssignable<typeof GovernedActionPreparationToken.Type, typeof GovernedActionPermitToken.Type>>,
  AssertFalse<IsAssignable<typeof GovernedActionPreparationToken.Type, typeof GovernedActionRecoveryToken.Type>>,
  AssertFalse<IsAssignable<typeof GovernedActionPermitToken.Type, typeof GovernedActionPreparationToken.Type>>,
  AssertFalse<IsAssignable<typeof GovernedActionPermitToken.Type, typeof GovernedActionRecoveryToken.Type>>,
  AssertFalse<IsAssignable<typeof GovernedActionRecoveryToken.Type, typeof GovernedActionPreparationToken.Type>>,
  AssertFalse<IsAssignable<typeof GovernedActionRecoveryToken.Type, typeof GovernedActionPermitToken.Type>>,
  AssertFalse<
    IsAssignable<typeof GovernedActionPreparationTokenDigest.Type, typeof GovernedActionPermitTokenDigest.Type>
  >,
  AssertFalse<
    IsAssignable<typeof GovernedActionPreparationTokenDigest.Type, typeof GovernedActionRecoveryTokenDigest.Type>
  >,
  AssertFalse<
    IsAssignable<typeof GovernedActionPermitTokenDigest.Type, typeof GovernedActionPreparationTokenDigest.Type>
  >,
  AssertFalse<
    IsAssignable<typeof GovernedActionPermitTokenDigest.Type, typeof GovernedActionRecoveryTokenDigest.Type>
  >,
  AssertFalse<
    IsAssignable<typeof GovernedActionRecoveryTokenDigest.Type, typeof GovernedActionPreparationTokenDigest.Type>
  >,
  AssertFalse<
    IsAssignable<typeof GovernedActionRecoveryTokenDigest.Type, typeof GovernedActionPermitTokenDigest.Type>
  >
]

describe("governed action execution tokens", () => {
  it.effect("issues distinct 256-bit capabilities and persists only reproducible digests", () =>
    Effect.gen(function*() {
      const preparation = yield* issueGovernedActionPreparationToken()
      const permit = yield* issueGovernedActionPermitToken()
      const recovery = yield* issueGovernedActionRecoveryToken()

      assert.isTrue(Schema.is(GovernedActionPreparationToken)(preparation.token))
      assert.isTrue(Schema.is(GovernedActionPermitToken)(permit.token))
      assert.isTrue(Schema.is(GovernedActionRecoveryToken)(recovery.token))
      assert.isTrue(Schema.is(GovernedActionPreparationTokenDigest)(preparation.digest))
      assert.isTrue(Schema.is(GovernedActionPermitTokenDigest)(permit.digest))
      assert.isTrue(Schema.is(GovernedActionRecoveryTokenDigest)(recovery.digest))
      assert.strictEqual(Redacted.value(preparation.token).length, 64)
      assert.strictEqual(Redacted.value(permit.token).length, 64)
      assert.strictEqual(Redacted.value(recovery.token).length, 64)
      assert.notStrictEqual(`${Redacted.value(preparation.token)}`, `${Redacted.value(permit.token)}`)
      assert.notStrictEqual(`${Redacted.value(preparation.token)}`, `${Redacted.value(recovery.token)}`)
      assert.notStrictEqual(`${Redacted.value(permit.token)}`, `${Redacted.value(recovery.token)}`)
      assert.notStrictEqual(Redacted.value(preparation.token), `${preparation.digest}`)
      assert.notStrictEqual(Redacted.value(permit.token), `${permit.digest}`)
      assert.notStrictEqual(Redacted.value(recovery.token), `${recovery.digest}`)

      const serialized = JSON.stringify({ preparation, permit, recovery })
      assert.notInclude(serialized, Redacted.value(preparation.token))
      assert.notInclude(serialized, Redacted.value(permit.token))
      assert.notInclude(serialized, Redacted.value(recovery.token))

      assert.strictEqual(
        yield* digestGovernedActionPreparationToken(preparation.token),
        preparation.digest
      )
      assert.strictEqual(yield* digestGovernedActionPermitToken(permit.token), permit.digest)
      assert.strictEqual(yield* digestGovernedActionRecoveryToken(recovery.token), recovery.digest)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("domain-separates lookup digests for the same underlying secret", () =>
    Effect.gen(function*() {
      const encoded = "f".repeat(64)
      const preparation = Schema.decodeUnknownSync(GovernedActionPreparationToken)(encoded)
      const permit = Schema.decodeUnknownSync(GovernedActionPermitToken)(encoded)
      const recovery = Schema.decodeUnknownSync(GovernedActionRecoveryToken)(encoded)
      const preparationDigest = yield* digestGovernedActionPreparationToken(preparation)
      const permitDigest = yield* digestGovernedActionPermitToken(permit)
      const recoveryDigest = yield* digestGovernedActionRecoveryToken(recovery)

      assert.notStrictEqual(`${preparationDigest}`, `${permitDigest}`)
      assert.notStrictEqual(`${preparationDigest}`, `${recoveryDigest}`)
      assert.notStrictEqual(`${permitDigest}`, `${recoveryDigest}`)
    }).pipe(Effect.provide(NodeServices.layer)))

  it("rejects short, non-hex, and uppercase capabilities at every nominal boundary", () => {
    const invalid = ["1".repeat(63), "g".repeat(64), "A".repeat(64)]
    for (const candidate of invalid) {
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(GovernedActionPreparationToken)(candidate)))
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(GovernedActionPermitToken)(candidate)))
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(GovernedActionRecoveryToken)(candidate)))
    }

    const valid = "a".repeat(64)
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(GovernedActionPreparationToken)(valid)))
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(GovernedActionPermitToken)(valid)))
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(GovernedActionRecoveryToken)(valid)))
  })
})
