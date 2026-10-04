import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path, Scope } from "effect"
import { spawn } from "node:child_process"
import {
  controlSocket,
  requestLoginUrl,
  ServerAlreadyRunning,
  ServerNotRunning,
  SocketPathUnsafe
} from "../src/server/ControlSocket.js"
import { authorizeBootstrapRequest, makeOwnerSessionSecrets } from "../src/server/OwnerSession.js"

const origin = "http://127.0.0.1:3112"

/** A private store directory, as the database layer would leave it. */
const store = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* fs.chmod(directory, 0o700)
  return directory
})

const codeOf = (url: string): string => decodeURIComponent(url.split("#bootstrap_token=")[1] ?? "")

describe("control socket", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("is owner-only, and hands out a link that signs in once", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSessionSecrets(origin)
        yield* controlSocket(directory, secrets)
        const info = yield* fs.stat(path.join(directory, "serve.sock"))
        expect(info.type).toBe("Socket")
        expect(info.mode & 0o777).toBe(0o600)
        const url = yield* requestLoginUrl(directory)
        const spend = Effect.result(
          authorizeBootstrapRequest({ authorization: `Bearer ${codeOf(url)}`, origin }, secrets)
        )
        expect((yield* spend)._tag).toBe("Success")
        expect((yield* spend)._tag).toBe("Failure")
      }))

    it.effect("says no server is running when there is no socket, or only a stale one", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const directory = yield* store
        expect(yield* Effect.flip(requestLoginUrl(directory))).toBeInstanceOf(ServerNotRunning)
        // A socket left behind by a server that died: present, but nothing answers.
        const socketPath = path.join(directory, "serve.sock")
        // A process that binds it and is then killed outright, so it never unlinks the file.
        yield* Effect.promise(() =>
          new Promise<void>((resolve) => {
            const script = `require("node:net").createServer().listen(${
              JSON.stringify(socketPath)
            }, () => console.log("up"))`
            const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] })
            child.stdout.once("data", () => {
              child.once("exit", () => resolve())
              child.kill("SIGKILL")
            })
          })
        )
        expect(yield* Effect.flip(requestLoginUrl(directory))).toBeInstanceOf(ServerNotRunning)
        // A new server replaces the stale socket.
        const secrets = yield* makeOwnerSessionSecrets(origin)
        yield* controlSocket(directory, secrets)
        expect(yield* requestLoginUrl(directory)).toContain("#bootstrap_token=")
      }))

    it.effect("refuses a symlink or a non-socket at the socket path", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSessionSecrets(origin)
        const socketPath = path.join(directory, "serve.sock")
        yield* fs.symlink(path.join(directory, "elsewhere"), socketPath)
        expect(yield* Effect.flip(controlSocket(directory, secrets))).toBeInstanceOf(SocketPathUnsafe)
        expect(yield* Effect.flip(requestLoginUrl(directory))).toBeInstanceOf(SocketPathUnsafe)
        yield* fs.remove(socketPath)
        yield* fs.writeFileString(socketPath, "not a socket")
        expect(yield* Effect.flip(controlSocket(directory, secrets))).toBeInstanceOf(SocketPathUnsafe)
        expect(yield* Effect.flip(requestLoginUrl(directory))).toBeInstanceOf(SocketPathUnsafe)
      }))

    it.effect("will not start a second server on a store whose server is alive, and cleans up on stop", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSessionSecrets(origin)
        const scope = yield* Scope.make()
        yield* controlSocket(directory, secrets).pipe(Scope.provide(scope))
        expect(yield* Effect.flip(controlSocket(directory, secrets))).toBeInstanceOf(ServerAlreadyRunning)
        yield* Scope.close(scope, Exit.void)
        expect(yield* fs.exists(path.join(directory, "serve.sock"))).toBe(false)
      }))
  })
})
