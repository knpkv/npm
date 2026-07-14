import { describe, expect, it } from "@effect/vitest"

import { inspectServerDeclarationContract } from "../../scripts/serverDeclarationContract.js"

const validDeclarations = {
  authIndex: `export { Auth, authLayer } from "./Auth.js";`,
  persistenceIndex: `export { Persistence, persistenceLayer } from "./Persistence.js";`,
  serverIndex: `export * from "./auth/index.js";\nexport * from "./persistence/index.js";`
}

describe("public server declaration contract", () => {
  it("accepts public layers while keeping their database-bound constructors internal", () => {
    expect(inspectServerDeclarationContract(validDeclarations)).toEqual([])
  })

  it("rejects the reviewed auth factory export", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        authIndex: `export { Auth, authLayer, authLayerFromDatabase } from "./Auth.js";`
      })
    ).toContain("public server declarations expose authLayerFromDatabase")
  })

  it("rejects a wildcard that makes the persistence factory transitively public", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        persistenceIndex: `export * from "./Persistence.js";`
      })
    ).toContain("public server declarations expose persistenceLayerFromDatabase")
  })

  it("rejects factories exported directly from the top-level server barrel", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        serverIndex: `export { authLayerFromDatabase, persistenceLayerFromDatabase } from "./internal.js";`
      })
    ).toEqual([
      "public server declarations expose authLayerFromDatabase",
      "public server declarations expose persistenceLayerFromDatabase"
    ])
  })
})
