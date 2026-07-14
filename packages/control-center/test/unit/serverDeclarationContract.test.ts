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
    interface RestoreBackupInput {
      readonly archiveRoot: string;
      readonly configuredDataRoot: string;
    }
    export declare const createVerifiedBackup: (input: CreateVerifiedBackupInput) => unknown;
    export declare const restoreBackup: (
      input: RestoreBackupInput
    ) => Effect.Effect<RestoredBackup, unknown, unknown>;
    export declare const verifyBackup: unknown;
  `,
  backupIndex: `export * from "./BackupArchive.js";\nexport * from "./BackupManifest.js";`,
  backupManifest: `
    export interface PublishedBackup { readonly archiveRoot: string }
    export interface RestoredBackup {
      readonly configuredDataRoot: string;
      readonly verification: unknown;
    }
  `,
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
          interface RestoreBackupInput {
            readonly archiveRoot: string;
            readonly configuredDataRoot: string;
          }
          export declare const restoreBackup: (
            input: RestoreBackupInput
          ) => Effect.Effect<RestoredBackup, unknown, unknown>;
        `
      })
    ).toEqual([])
  })

  it("rejects a public restore result without its implemented operation", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: validDeclarations.backupArchive.replace(
          /export declare const restoreBackup:[\s\S]+?;/u,
          ""
        )
      })
    ).toContain("public server declarations must expose restoreBackup and RestoredBackup together")
  })

  it("rejects a public restore operation without its result declaration", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupManifest: validDeclarations.backupManifest.replace(
          /export interface RestoredBackup \{[^}]+\}/u,
          ""
        )
      })
    ).toContain("public server declarations must expose restoreBackup and RestoredBackup together")
  })

  it("rejects restore inputs that omit roots or expose internal storage handles", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: `
          interface RestoreBackupInput {
            readonly archiveRoot: string;
            readonly persistenceConfig: unknown;
            readonly sql: unknown;
          }
          export declare const restoreBackup: (
            input: RestoreBackupInput
          ) => Effect.Effect<RestoredBackup, unknown, unknown>;
        `
      })
    ).toEqual([
      "public restoreBackup input must include configuredDataRoot",
      "public restoreBackup input must not include persistenceConfig",
      "public restoreBackup input must not include sql"
    ])
  })

  it("accepts a restore operation and result only when they are exported together", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: validDeclarations.backupArchive,
        backupManifest: validDeclarations.backupManifest
      })
    ).toEqual([])
  })

  it("rejects physical restore paths while allowing the configured claim identity", () => {
    for (const forbiddenProperty of ["operationalPaths", "databaseFile", "blobRoot"]) {
      expect(
        inspectServerDeclarationContract({
          ...validDeclarations,
          backupManifest: `
            export interface RestoredBackup {
              readonly configuredDataRoot: string;
              readonly verification: unknown;
              readonly ${forbiddenProperty}: string;
            }
          `
        })
      ).toContain(`public RestoredBackup must not expose ${forbiddenProperty}`)
    }
  })

  it("binds the restore operation success type to the reviewed public result", () => {
    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: validDeclarations.backupArchive.replace(
          "Effect.Effect<RestoredBackup, unknown, unknown>",
          "Effect.Effect<unknown, unknown, unknown>"
        )
      })
    ).toContain("public restoreBackup must return Effect.Effect<RestoredBackup, ...>")

    expect(
      inspectServerDeclarationContract({
        ...validDeclarations,
        backupArchive: validDeclarations.backupArchive.replace(
          "Effect.Effect<RestoredBackup, unknown, unknown>",
          "Effect.Effect<{ readonly operationalPaths: unknown }, unknown, unknown>"
        )
      })
    ).toEqual(expect.arrayContaining([
      "public restoreBackup must return Effect.Effect<RestoredBackup, ...>",
      "public restoreBackup result must not expose operationalPaths"
    ]))
  })
})
