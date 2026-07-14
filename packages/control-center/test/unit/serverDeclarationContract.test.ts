import { describe, expect, it } from "@effect/vitest"

import { inspectServerDeclarationContract } from "../../scripts/serverDeclarationContract.js"

const validDeclarations = {
  authIndex: `export { Auth, authLayer } from "./Auth.js";`,
  backupArchive: `
    interface CreateVerifiedBackupInput {
      readonly destination: string;
      readonly persistenceConfig: unknown;
      readonly sql: unknown;
    }
    export declare const createVerifiedBackup: (input: CreateVerifiedBackupInput) => unknown;
    export declare const verifyBackup: unknown;
  `,
  backupIndex: `export * from "./BackupArchive.js";\nexport * from "./BackupManifest.js";`,
  backupManifest: `export interface PublishedBackup { readonly archiveRoot: string }`,
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

  it("rejects a raw database source in the public manual-backup input", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: `
          interface UnsafeBackupInput {
            readonly destination: string;
            readonly databaseSourceFile?: string;
          }
          export declare const createVerifiedBackup: (input: UnsafeBackupInput) => unknown;
        `
      })
    ).toContain("public createVerifiedBackup accepts databaseSourceFile")
  })

  it("rejects an inline raw database source while ignoring comments and unrelated internal inputs", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: `
          export declare const createVerifiedBackup: (
            input: { readonly databaseSourceFile: string; readonly destination: string }
          ) => unknown;
        `
      })
    ).toContain("public createVerifiedBackup accepts databaseSourceFile")

    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: `
          // databaseSourceFile belongs only to the non-public pre-migration helper.
          interface InternalBackupInput { readonly databaseSourceFile: string }
          interface ManualBackupInput { readonly destination: string }
          export declare const createVerifiedBackup: (input: ManualBackupInput) => unknown;
        `
      })
    ).toEqual([])
  })

  it("rejects a public restore result without its implemented operation", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupManifest:
          `${validDeclarations.backupManifest}\nexport interface RestoredBackup { readonly dataRoot: string }`
      })
    ).toContain("public server declarations must expose restoreBackup and RestoredBackup together")
  })

  it("accepts a restore operation and result only when they are exported together", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: `${validDeclarations.backupArchive}\nexport declare const restoreBackup: unknown;`,
        backupManifest:
          `${validDeclarations.backupManifest}\nexport interface RestoredBackup { readonly dataRoot: string }`
      })
    ).toEqual([])
  })
})
