import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Ref, Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:net"
import {
  controlSocket,
  LoginReplyInvalid,
  requestLoginUrl,
  ServerAlreadyRunning,
  ServerNotRunning,
  SocketPathTooLong,
  SocketPathUnsafe,
  SocketRefused
} from "../src/server/ControlSocket.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"

const origin = "http://127.0.0.1:3112"

/** The user id this test runs as, which owns everything it creates. */
const self = process.geteuid?.() ?? -1

/** A private store directory, as the database layer would leave it. */
const store = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* fs.chmod(directory, 0o700)
  return directory
})

/** A stand-in listener at the socket path, answering each connection with `reply` (or never). */
const fakeServer = (socketPath: string, reply: string | undefined, accepted?: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      new Promise<Server>((resolve) => {
        const server = createServer((connection) => {
          if (accepted !== undefined) Deferred.doneUnsafe(accepted, Exit.void)
          connection.on("data", () => {
            if (reply !== undefined) connection.end(reply)
          })
        })
        server.listen(socketPath, () => resolve(server))
      })
    ),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  )

const codeOf = (url: string): string => decodeURIComponent(url.split("#bootstrap_token=")[1] ?? "")

describe("control socket", () => {
  it.layer(Layer.merge(NodeServices.layer, Reactivity.layer))((it) => {
    it.effect("login trusts only a socket owned by the user it runs as", () =>
      Effect.gen(function*() {
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(directory, secrets, Effect.void)
        expect(yield* Effect.flip(requestLoginUrl(directory, self + 1))).toBeInstanceOf(SocketPathUnsafe)
        expect(yield* requestLoginUrl(directory, self)).toContain("#bootstrap_token=")
      }))

    it.effect("mints nothing until the server is listening", () =>
      Effect.gen(function*() {
        const directory = yield* store
        const session = yield* makeOwnerSession(origin)
        const minted = yield* Ref.make(0)
        const secrets = {
          ...session,
          mintBootstrapCode: Effect.tap(session.mintBootstrapCode, () => Ref.update(minted, (n) => n + 1))
        }
        const listening = yield* Deferred.make<void>()
        const arrived = yield* Deferred.make<void>()
        // The gate reports when a request reaches it, then waits for the listener.
        yield* controlSocket(
          directory,
          secrets,
          Deferred.succeed(arrived, undefined).pipe(Effect.andThen(Deferred.await(listening)))
        )
        const request = yield* Effect.forkChild(requestLoginUrl(directory, self))
        yield* Deferred.await(arrived)
        expect(request.pollUnsafe()).toBeUndefined()
        expect(yield* Ref.get(minted)).toBe(0)
        yield* Deferred.succeed(listening, undefined)
        const url = yield* Fiber.join(request)
        const spent = yield* Effect.result(
          secrets.authorizeBootstrap({ authorization: `Bearer ${codeOf(url)}`, origin })
        )
        expect(spent._tag).toBe("Success")
      }))

    it.effect("is owner-only, and hands out a link that signs in once", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(directory, secrets, Effect.void)
        const info = yield* fs.stat(path.join(directory, "serve.sock"))
        expect(info.type).toBe("Socket")
        expect(info.mode & 0o777).toBe(0o600)
        const url = yield* requestLoginUrl(directory, self)
        const spend = Effect.result(
          secrets.authorizeBootstrap({ authorization: `Bearer ${codeOf(url)}`, origin })
        )
        expect((yield* spend)._tag).toBe("Success")
        expect((yield* spend)._tag).toBe("Failure")
      }))

    it.effect("says no server is running when there is no socket, or only a stale one", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const directory = yield* store
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(ServerNotRunning)
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
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(ServerNotRunning)
        // A new server replaces the stale socket.
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(directory, secrets, Effect.void)
        expect(yield* requestLoginUrl(directory, self)).toContain("#bootstrap_token=")
      }))

    it.effect("refuses a symlink or a non-socket at the socket path", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        const socketPath = path.join(directory, "serve.sock")
        yield* fs.symlink(path.join(directory, "elsewhere"), socketPath)
        expect(yield* Effect.flip(Effect.scoped(controlSocket(directory, secrets, Effect.void)))).toBeInstanceOf(
          SocketPathUnsafe
        )
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(SocketPathUnsafe)
        yield* fs.remove(socketPath)
        yield* fs.writeFileString(socketPath, "not a socket")
        expect(yield* Effect.flip(Effect.scoped(controlSocket(directory, secrets, Effect.void)))).toBeInstanceOf(
          SocketPathUnsafe
        )
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(SocketPathUnsafe)
      }))

    it.effect("will not start a second server on a store whose server is alive, and cleans up on stop", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        const scope = yield* Scope.make()
        yield* controlSocket(directory, secrets, Effect.void).pipe(Scope.provide(scope))
        expect(yield* Effect.flip(controlSocket(directory, secrets, Effect.void))).toBeInstanceOf(ServerAlreadyRunning)
        yield* Scope.close(scope, Exit.void)
        expect(yield* fs.exists(path.join(directory, "serve.sock"))).toBe(false)
      }))

    it.effect("a live server it may not connect to is left alone", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        const socketPath = path.join(directory, "serve.sock")
        yield* controlSocket(directory, secrets, Effect.void)
        yield* fs.chmod(socketPath, 0o000)
        // The store's lock says a server is running, whatever its socket allows.
        expect(yield* Effect.flip(controlSocket(directory, secrets, Effect.void))).toBeInstanceOf(ServerAlreadyRunning)
        const info = yield* fs.stat(path.join(directory, "serve.sock"))
        expect(info.type).toBe("Socket")
        yield* fs.chmod(socketPath, 0o600)
        expect(yield* requestLoginUrl(directory, self)).toContain("#bootstrap_token=")
      }))

    it.effect(
      "two servers reclaiming one stale socket: exactly one wins, and the loser's exit leaves it reachable",
      () =>
        Effect.gen(function*() {
          const path = yield* Path.Path
          for (let round = 0; round < 10; round++) {
            const directory = yield* store
            const socketPath = path.join(directory, "serve.sock")
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
            const secrets = yield* makeOwnerSession(origin)
            const [first, second] = [yield* Scope.make(), yield* Scope.make()]
            const outcomes = yield* Effect.all([
              Effect.exit(controlSocket(directory, secrets, Effect.void).pipe(Scope.provide(first))),
              Effect.exit(controlSocket(directory, secrets, Effect.void).pipe(Scope.provide(second)))
            ], { concurrency: "unbounded" })
            expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
            const loser = Exit.isSuccess(outcomes[0]) ? second : first
            const winner = loser === first ? second : first
            yield* Scope.close(loser, Exit.void)
            expect(yield* requestLoginUrl(directory, self)).toContain("#bootstrap_token=")
            yield* Scope.close(winner, Exit.void)
          }
        }),
      30_000
    )

    it.effect("a store path too long for a Unix socket runs without login, and login says why", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const base = yield* store
        const directory = path.join(base, "d".repeat(60), "e".repeat(60))
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
        const secrets = yield* makeOwnerSession(origin)
        expect(yield* controlSocket(directory, secrets, Effect.void)).toBeUndefined()
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(SocketPathTooLong)
        // Still one server per store.
        expect(yield* Effect.flip(controlSocket(directory, secrets, Effect.void))).toBeInstanceOf(ServerAlreadyRunning)
      }))

    it.effect("login gives up on a listener that never answers", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const directory = yield* store
        const accepted = yield* Deferred.make<void>()
        yield* fakeServer(path.join(directory, "serve.sock"), undefined, accepted)
        const request = yield* Effect.forkChild(Effect.flip(requestLoginUrl(directory, self)))
        yield* Deferred.await(accepted)
        yield* TestClock.adjust("6 seconds")
        const failure = yield* Fiber.join(request)
        expect(failure).toBeInstanceOf(SocketRefused)
      }))

    it.effect("login accepts only a loopback link carrying a one-time code", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        for (
          const url of [
            "file:///tmp/x",
            "--help",
            "http://example.com/#bootstrap_token=abc",
            "http://127.0.0.1:3112/",
            // Loopback, but not a code the page could spend.
            "http://127.0.0.1:3112/#bootstrap_token=abc"
          ]
        ) {
          const directory = yield* store
          yield* fakeServer(path.join(directory, "serve.sock"), `${JSON.stringify({ url })}\n`)
          expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(LoginReplyInvalid)
        }
      }))
  })
})
