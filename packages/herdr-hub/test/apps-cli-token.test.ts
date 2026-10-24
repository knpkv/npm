import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Redacted } from "effect"
import { tmpdir, userInfo } from "node:os"
import process from "node:process"
import { presentsCliToken, readCliToken, writeCliToken } from "../src/apps/cli-token.js"
import { ownPrivateDirectory } from "../src/apps/supervisor.js"

const windows = process.platform === "win32"
const uid = userInfo().uid

const tempRoot = Effect.flatMap(
  FileSystem.FileSystem,
  (fileSystem) => fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "cli-token-" })
)

describe("CLI token", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    // A token in a backup or a copied home must be dead after the next hub start.
    it.effect("writes a fresh token at every hub start, readable by the CLI and accepted only as written", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const first = yield* writeCliToken(`${root}/cli`, uid)
        const second = yield* writeCliToken(`${root}/cli`, uid)
        expect(Redacted.value(first)).not.toBe(Redacted.value(second))
        const read = yield* readCliToken(`${root}/cli`)
        expect(Redacted.value(read)).toBe(Redacted.value(second))
        expect(presentsCliToken(Redacted.value(second), read)).toBe(true)
        expect(presentsCliToken(Redacted.value(first), read)).toBe(false)
        expect(presentsCliToken(undefined, read)).toBe(false)
        const fileSystem = yield* FileSystem.FileSystem
        expect(yield* fileSystem.readDirectory(`${root}/cli`)).toEqual(["token"])
      }).pipe(Effect.scoped))

    it.effect.skipIf(windows)("is born owner-only in an owner-only directory", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        yield* writeCliToken(`${root}/cli`, uid)
        expect((yield* fileSystem.stat(`${root}/cli`)).mode & 0o777).toBe(0o700)
        expect((yield* fileSystem.stat(`${root}/cli/token`)).mode & 0o777).toBe(0o600)
      }).pipe(Effect.scoped))

    // Others who can enter the directory could read the token or swap the file.
    it.effect.skipIf(windows)("writes nothing into a directory others may enter", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.makeDirectory(`${root}/cli`)
        yield* fileSystem.chmod(`${root}/cli`, 0o755)
        const error = yield* writeCliToken(`${root}/cli`, uid).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "RuntimeDirUnsafe", reason: "mode" })
        expect(yield* fileSystem.readDirectory(`${root}/cli`)).toEqual([])
      }).pipe(Effect.scoped))

    // Windows has no uid (-1) and stat reports 0 for every owner: only the link and type checks apply there.
    it.effect("accepts the user's own directory when the platform has no uids, on every OS", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        yield* ownPrivateDirectory(`${root}/cli`, -1, true)
        const token = yield* writeCliToken(`${root}/cli-token-dir`, -1)
        expect(Redacted.value(yield* readCliToken(`${root}/cli-token-dir`))).toBe(Redacted.value(token))
      }).pipe(Effect.scoped))

    it.effect("tells the CLI no token is there when the hub never started", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        expect((yield* readCliToken(`${root}/cli`).pipe(Effect.flip))._tag).toBe("CliTokenUnavailable")
      }).pipe(Effect.scoped))
  })
})
