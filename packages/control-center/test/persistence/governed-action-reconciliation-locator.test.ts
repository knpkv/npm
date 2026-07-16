import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PluginActionReconciliationKey } from "../../src/domain/plugins/actions.js"
import {
  encodePersistedGovernedActionReconciliationLocator,
  PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR,
  PersistedGovernedActionReconciliationLocator
} from "../../src/server/persistence/governedActionReconciliationLocator.js"

describe("governed action reconciliation locator persistence", () => {
  it("uses a SQL-only idempotency marker that cannot cross the provider-key boundary", () => {
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(PluginActionReconciliationKey)(
        PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR
      )
    ))
    assert.strictEqual(
      encodePersistedGovernedActionReconciliationLocator(null),
      PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR
    )
    assert.isTrue(
      Schema.is(PersistedGovernedActionReconciliationLocator)(
        PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR
      )
    )
  })

  it("preserves opaque provider locators byte for byte", () => {
    const providerKey = PluginActionReconciliationKey.make("opaque+provider-key==")

    assert.strictEqual(
      encodePersistedGovernedActionReconciliationLocator(providerKey),
      providerKey
    )
  })
})
