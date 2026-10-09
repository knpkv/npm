import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Ref, Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { createConnection, createServer, type Server } from "node:net"
import { UnknownTimeZone } from "../src/core/Report.js"
import {
  type ControlReaders,
  controlSocket,
  LimitsNotSupported,
  LimitsReplyInvalid,
  LimitsUnavailable,
  LoginReplyInvalid,
  requestLimits,
  requestLoginUrl,
  requestUsage,
  ServerAlreadyRunning,
  ServerNotRunning,
  SocketPathTooLong,
  SocketPathUnsafe,
  SocketRefused,
  UsageNotSupported,
  UsageReplyInvalid,
  UsageRequestRefused,
  UsageUnavailable
} from "../src/server/ControlSocket.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"
import type { LimitsNow, UsageNow } from "../src/shared/contracts.js"

const origin = "http://127.0.0.1:3112"

/** The user id this test runs as, which owns everything it creates. */
const self = process.geteuid?.() ?? -1

/** For sockets whose tests never ask for limits or usage. */
const unasked: ControlReaders<never> = {
  limits: Effect.die("limits were not asked for in this test"),
  usage: () => Effect.die("usage was not asked for in this test")
}

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

/** Sends one raw line to the socket at `socketPath` and answers the reply line, trimmed. */
const rawExchange = (socketPath: string, line: string) =>
  Effect.promise(() =>
    new Promise<string>((resolve) => {
      let reply = ""
      const connection = createConnection(socketPath, () => connection.write(`${line}\n`))
      connection.on("data", (chunk) => {
        reply += chunk.toString()
      })
      connection.on("close", () => resolve(reply.trim()))
    })
  )

const codeOf = (url: string): string => decodeURIComponent(url.split("#bootstrap_token=")[1] ?? "")

describe("control socket", () => {
  it.layer(Layer.merge(NodeServices.layer, Reactivity.layer))((it) => {
    it.effect("login trusts only a socket owned by the user it runs as", () =>
      Effect.gen(function*() {
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(directory, secrets, Effect.void, unasked)
        expect(yield* Effect.flip(requestLoginUrl(directory, self + 1))).toBeInstanceOf(SocketPathUnsafe)
        expect(yield* requestLoginUrl(directory, self)).toContain("#bootstrap_token=")
      }))

    it.effect("answers limits to the owner, and says when it has none to give", () =>
      Effect.gen(function*() {
        const limits: LimitsNow = { v: 1, machine: "host-a", observedAt: 1_000, latest: [] }
        const withLimits = yield* store
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(withLimits, secrets, Effect.void, { ...unasked, limits: Effect.succeed(limits) })
        expect(yield* Effect.flip(requestLimits(withLimits, self + 1))).toBeInstanceOf(SocketPathUnsafe)
        expect(yield* requestLimits(withLimits, self)).toEqual(limits)
        // A store that could not be read: its own error, never empty limits.
        const failing = yield* store
        yield* controlSocket(failing, secrets, Effect.void, { ...unasked, limits: Effect.fail("store unreadable") })
        expect(yield* Effect.flip(requestLimits(failing, self))).toBeInstanceOf(LimitsUnavailable)
      }))

    it.effect("tells a server too old for limits from one answering nonsense", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const older = yield* store
        yield* fakeServer(path.join(older, "serve.sock"), "{\"error\":\"unknown request\"}\n")
        expect(yield* Effect.flip(requestLimits(older, self))).toBeInstanceOf(LimitsNotSupported)
        const garbled = yield* store
        yield* fakeServer(path.join(garbled, "serve.sock"), "{\"latest\":\"nope\"}\n")
        expect(yield* Effect.flip(requestLimits(garbled, self))).toBeInstanceOf(LimitsReplyInvalid)
      }))

    it.effect("answers usage for a range and zone to the owner, and refuses what it does not know", () =>
      Effect.gen(function*() {
        const asked: Array<readonly [string, string]> = []
        const answer = (preset: UsageNow["range"]["preset"], timeZone: string): UsageNow => ({
          v: 1,
          machine: "host-a",
          observedAt: 1_000,
          range: { preset, timeZone, from: 0, to: 1_000, bucket: "day" },
          periods: [],
          tokens: [],
          limits: []
        })
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(directory, secrets, Effect.void, {
          ...unasked,
          usage: (preset, timeZone) =>
            timeZone === "Mars/Olympus"
              ? Effect.fail(new UnknownTimeZone({ zone: timeZone }))
              : Effect.sync(() => {
                asked.push([preset, timeZone])
                return answer(preset, timeZone)
              })
        })
        expect(yield* Effect.flip(requestUsage(directory, self + 1, "7d", "UTC"))).toBeInstanceOf(SocketPathUnsafe)
        expect(yield* requestUsage(directory, self, "30d", "Europe/Amsterdam")).toEqual(
          answer("30d", "Europe/Amsterdam")
        )
        expect(asked).toEqual([["30d", "Europe/Amsterdam"]])
        expect(yield* Effect.flip(requestUsage(directory, self, "7d", "Mars/Olympus"))).toBeInstanceOf(
          UsageRequestRefused
        )
        // A zone with whitespace would be a different request line: refused before it is sent.
        expect(yield* Effect.flip(requestUsage(directory, self, "7d", "UTC limits"))).toBeInstanceOf(
          UsageRequestRefused
        )
        expect(asked).toHaveLength(1)
        // A store that could not be read: its own error, never empty usage.
        const failing = yield* store
        yield* controlSocket(failing, secrets, Effect.void, {
          ...unasked,
          usage: () => Effect.fail("store unreadable")
        })
        expect(yield* Effect.flip(requestUsage(failing, self, "7d", "UTC"))).toBeInstanceOf(UsageUnavailable)
      }))

    // A malformed `usage` line is the asker's mistake, not an old server: it must never read "older version".
    it.effect("refuses a malformed usage line by what is wrong with it, never as an unknown request", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const directory = yield* store
        const secrets = yield* makeOwnerSession(origin)
        yield* controlSocket(directory, secrets, Effect.void, {
          ...unasked,
          usage: (_, timeZone) => Effect.fail(new UnknownTimeZone({ zone: timeZone }))
        })
        const socketPath = path.join(directory, "serve.sock")
        expect(yield* rawExchange(socketPath, "usage 7d")).toBe("{\"error\":\"bad request\"}")
        expect(yield* rawExchange(socketPath, "usage 7d UTC extra")).toBe("{\"error\":\"bad request\"}")
        expect(yield* rawExchange(socketPath, "usage 1y UTC")).toBe("{\"error\":\"unknown range\"}")
        expect(yield* rawExchange(socketPath, "usage 7d Mars/Olympus")).toBe("{\"error\":\"unknown time zone\"}")
        // The client never sends an empty or spaced zone, and says which part it refused.
        const empty = yield* Effect.flip(requestUsage(directory, self, "7d", ""))
        expect(empty).toBeInstanceOf(UsageRequestRefused)
        expect(empty).toMatchObject({ refused: "malformed" })
        expect(yield* Effect.flip(requestUsage(directory, self, "7d", "Mars/Olympus"))).toMatchObject({
          _tag: "UsageRequestRefused",
          refused: "time zone"
        })
      }))

    it.effect("tells a server too old for usage from one answering nonsense", () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const older = yield* store
        yield* fakeServer(path.join(older, "serve.sock"), "{\"error\":\"unknown request\"}\n")
        expect(yield* Effect.flip(requestUsage(older, self, "7d", "UTC"))).toBeInstanceOf(UsageNotSupported)
        const garbled = yield* store
        yield* fakeServer(path.join(garbled, "serve.sock"), "{\"tokens\":\"nope\"}\n")
        expect(yield* Effect.flip(requestUsage(garbled, self, "7d", "UTC"))).toBeInstanceOf(UsageReplyInvalid)
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
          Deferred.succeed(arrived, undefined).pipe(Effect.andThen(Deferred.await(listening))),
          unasked
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
        yield* controlSocket(directory, secrets, Effect.void, unasked)
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
        yield* controlSocket(directory, secrets, Effect.void, unasked)
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
        expect(yield* Effect.flip(Effect.scoped(controlSocket(directory, secrets, Effect.void, unasked))))
          .toBeInstanceOf(
            SocketPathUnsafe
          )
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(SocketPathUnsafe)
        yield* fs.remove(socketPath)
        yield* fs.writeFileString(socketPath, "not a socket")
        expect(yield* Effect.flip(Effect.scoped(controlSocket(directory, secrets, Effect.void, unasked))))
          .toBeInstanceOf(
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
        yield* controlSocket(directory, secrets, Effect.void, unasked).pipe(Scope.provide(scope))
        expect(yield* Effect.flip(controlSocket(directory, secrets, Effect.void, unasked))).toBeInstanceOf(
          ServerAlreadyRunning
        )
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
        yield* controlSocket(directory, secrets, Effect.void, unasked)
        yield* fs.chmod(socketPath, 0o000)
        // The store's lock says a server is running, whatever its socket allows.
        expect(yield* Effect.flip(controlSocket(directory, secrets, Effect.void, unasked))).toBeInstanceOf(
          ServerAlreadyRunning
        )
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
              Effect.exit(controlSocket(directory, secrets, Effect.void, unasked).pipe(Scope.provide(first))),
              Effect.exit(controlSocket(directory, secrets, Effect.void, unasked).pipe(Scope.provide(second)))
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
        expect(yield* controlSocket(directory, secrets, Effect.void, unasked)).toBeUndefined()
        expect(yield* Effect.flip(requestLoginUrl(directory, self))).toBeInstanceOf(SocketPathTooLong)
        // Still one server per store.
        expect(yield* Effect.flip(controlSocket(directory, secrets, Effect.void, unasked))).toBeInstanceOf(
          ServerAlreadyRunning
        )
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
