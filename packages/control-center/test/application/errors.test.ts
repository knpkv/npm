import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { ApplicationInvalidRequest, ApplicationResourceNotFound } from "../../src/server/api/ApplicationServices.js"
import { mapPersistenceWriteError } from "../../src/server/application/errors.js"
import { RecordNotFoundError } from "../../src/server/persistence/errors.js"
import { ProviderAccountInputError } from "../../src/server/persistence/repositories/providerAccountRepository.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")

describe("application persistence error mapping", () => {
  it("maps provider-account input failures to invalid requests", () => {
    const mapped = mapPersistenceWriteError(
      new ProviderAccountInputError({
        operation: "follow-resource",
        reason: "provider-family-mismatch"
      })
    )

    assert.instanceOf(mapped, ApplicationInvalidRequest)
    assert.instanceOf(
      mapPersistenceWriteError(
        new RecordNotFoundError({
          workspaceId: WORKSPACE_ID,
          recordKind: "provider-account",
          recordKey: WORKSPACE_ID
        })
      ),
      ApplicationResourceNotFound
    )
  })
})
