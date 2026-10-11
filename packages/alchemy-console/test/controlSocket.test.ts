import { NodeServices, NodeSocketServer } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Option, Path } from "effect"
import { controlSocket, requestLoginUrl } from "../src/server/ControlSocket.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"

const setup = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-control-" })
  yield* fs.chmod(directory, 0o700)
  const uid = Option.getOrElse((yield* fs.stat(directory)).uid, () => -1)
  const options = { directory, port: 3114, uid }
  const socketPath = path.join(directory, "serve-3114.sock")
  return { fs, path, options, socketPath }
})

layer(NodeServices.layer)("control socket trust", (it) => {
  it.effect("distinguishes absence from unsafe ownership, permissions and symlinks", () =>
    Effect.gen(function*() {
      const { fs, options, path, socketPath } = yield* setup
      expect(Option.isNone(yield* requestLoginUrl(options))).toBe(true)
      expect(yield* Effect.flip(requestLoginUrl({ ...options, uid: options.uid + 1 })))
        .toMatchObject({ reason: "unsafe" })
      yield* fs.chmod(options.directory, 0o755)
      expect(yield* Effect.flip(requestLoginUrl(options))).toMatchObject({ reason: "unsafe" })
      yield* fs.chmod(options.directory, 0o700)
      const sentinel = path.join(options.directory, "fixture-sentinel")
      yield* fs.writeFileString(sentinel, "fixture-secret")
      yield* fs.symlink(sentinel, socketPath)
      const error = yield* Effect.flip(requestLoginUrl(options))
      expect(error).toMatchObject({ reason: "unsafe" })
      expect(JSON.stringify(error)).not.toContain(options.directory)
      expect(JSON.stringify(error)).not.toContain("fixture-secret")
      expect(yield* fs.readFileString(sentinel)).toBe("fixture-secret")
    }).pipe(Effect.scoped))

  it.effect("refuses startup over an existing entry and checks Unix path limits without deleting anything", () =>
    Effect.gen(function*() {
      const { fs, options, socketPath } = yield* setup
      const session = yield* makeOwnerSession("http://127.0.0.1:3114")
      yield* fs.writeFileString(socketPath, "fixture-sentinel")
      expect(yield* Effect.flip(controlSocket(options, session, Effect.void))).toMatchObject({ reason: "occupied" })
      expect(yield* fs.readFileString(socketPath)).toBe("fixture-sentinel")
      expect(yield* Effect.flip(requestLoginUrl({ ...options, directory: "fixture-".repeat(30) })))
        .toMatchObject({ reason: "path-limit" })
    }).pipe(Effect.scoped))

  it.effect("rejects a credential-bearing reply for another origin without retaining it in errors", () =>
    Effect.gen(function*() {
      const { fs, options, socketPath } = yield* setup
      const server = yield* NodeSocketServer.make({ path: socketPath })
      yield* fs.chmod(socketPath, 0o600)
      const url = "http://fixture.invalid/#bootstrap_token=" + "a".repeat(64)
      yield* server.run((socket) =>
        Effect.scoped(Effect.gen(function*() {
          const reader = yield* socket.reader
          const writer = yield* socket.writer
          yield* reader.pull
          yield* writer.write(`${JSON.stringify({ url })}\n`)
        }))
      ).pipe(Effect.forkScoped)
      const failure = yield* Effect.flip(requestLoginUrl(options))
      expect(failure).toMatchObject({ reason: "invalid-reply" })
      expect(JSON.stringify(failure)).not.toContain(url)
    }).pipe(Effect.scoped))
})
