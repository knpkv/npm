import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { CodeReference } from "@knpkv/codecommit-web/host"
import { CodeCoordinates } from "@knpkv/codecommit-web/host/server"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Crypto, Effect, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { makeCodeReferences } from "../src/code-reference-store.js"

const coordinates = CodeCoordinates.make({
  accountId: "synthetic-account-a",
  region: "example-region",
  repository: "example",
  id: "7"
})

it.layer(NodeServices.layer)("private Code references", (it) => {
  it.effect("keeps references stable on restart and distinguishes accounts", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-references-" })
      const storePath = path.join(directory, "references.sqlite")
      const first = yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeCodeReferences(storePath)
        return yield* store.reference(coordinates)
      }))
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeCodeReferences(storePath)
        expect(yield* store.reference(coordinates)).toBe(first)
        const other = yield* store.reference({ ...coordinates, accountId: "synthetic-account-b" })
        expect(other).not.toBe(first)
        expect(yield* store.resolve(first)).toEqual(coordinates)
        const encoded = Schema.encodeSync(CodeReference)(first)
        expect(encoded).not.toContain("synthetic")
        expect(encoded).not.toContain(coordinates.repository)
        expect(encoded).not.toContain(coordinates.region)
      }))
    }))

  it.effect("returns no locator for an unknown or tampered reference", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-reference-missing-" })
      const store = yield* makeCodeReferences(path.join(directory, "references.sqlite"))
      const cryptoService = yield* Crypto.Crypto
      const unknown = yield* cryptoService.randomUUIDv4
      expect(yield* store.resolve(unknown)).toBeNull()
      const actual = yield* store.reference(coordinates)
      const tampered = actual.slice(0, -1) + (actual.endsWith("a") ? "b" : "a")
      expect(yield* store.resolve(tampered)).toBeNull()
    }))

  /** A browser can page the cached queue repeatedly; reference storage must remain bounded. */
  it.effect("caps stored references and makes the oldest evicted target unavailable", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-reference-cap-" })
      const storePath = `${directory}/references.sqlite`
      const store = yield* makeCodeReferences(storePath)
      const oldest = yield* store.reference(coordinates)
      const seed = yield* Effect.acquireRelease(
        openPrivateSqlite(storePath, { initialize: () => undefined }),
        (resource) => Effect.sync(() => resource.database.close())
      )
      yield* Effect.sync(() =>
        seed.database.exec(`
      WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 9999)
      INSERT INTO code_references (reference, coordinates, last_seen)
      SELECT printf('00000000-0000-4000-8000-%012x', n),
        json_object('accountId', 'synthetic-seed', 'region', 'example-region', 'repository', 'example', 'id', CAST(n AS TEXT)), n + 1
      FROM sequence
    `)
      )
      const latest = yield* store.reference({ ...coordinates, id: "latest" })
      expect(yield* store.resolve(oldest)).toBeNull()
      expect(yield* store.resolve(latest)).toEqual({ ...coordinates, id: "latest" })
      const count = yield* Effect.sync(() =>
        seed.database.prepare("SELECT count(*) AS count FROM code_references").get()
      )
      expect(count).toEqual({ count: 10_000 })
    }))

  /** A long-open PR remains linked when it is listed again, even if its reference was created first. */
  it.effect("preserves recent touches across restart while evicting the least recently seen", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-reference-recency-" })
      const storePath = `${directory}/references.sqlite`
      const oldest = yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeCodeReferences(storePath)
        const oldest = yield* store.reference(coordinates)
        const seed = yield* Effect.acquireRelease(
          openPrivateSqlite(storePath, { initialize: () => undefined }),
          (resource) => Effect.sync(() => resource.database.close())
        )
        yield* Effect.sync(() =>
          seed.database.exec(`
      WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 9999)
      INSERT INTO code_references (reference, coordinates, last_seen)
      SELECT printf('00000000-0000-4000-8000-%012x', n),
        json_object('accountId', 'synthetic-seed', 'region', 'example-region', 'repository', 'example', 'id', CAST(n AS TEXT)), n + 1
      FROM sequence
    `)
        )
        expect(yield* store.reference(coordinates)).toBe(oldest)
        return oldest
      }))
      const store = yield* makeCodeReferences(storePath)
      const touchedAfterRestart = CodeCoordinates.make({
        accountId: "synthetic-seed",
        region: "example-region",
        repository: "example",
        id: "1"
      })
      const next = yield* store.reference(touchedAfterRestart)
      yield* store.reference({ ...coordinates, id: "latest" })
      expect(yield* store.resolve(oldest)).toEqual(coordinates)
      expect(yield* store.resolve(next)).toEqual(touchedAfterRestart)
      expect(yield* store.resolve(Schema.decodeUnknownSync(CodeReference)("00000000-0000-4000-8000-000000000002")))
        .toBeNull()
    }))
})
