import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, FileSystem, Layer, Path, Schedule } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import type { AgentUsageConfig } from "../src/server/Config.js"
import { controlSocket, requestLimits, ServerAlreadyRunning } from "../src/server/ControlSocket.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"
import { makeServer } from "../src/server/Server.js"

const origin = "http://127.0.0.1:3112"

describe("server startup", () => {
  it.layer(Layer.merge(NodeServices.layer, Reactivity.layer))((it) => {
    it.effect("a server that finds the store locked stops before opening its database", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        yield* fs.chmod(directory, 0o700)
        const secrets = yield* makeOwnerSession(origin)
        // The running server: it holds the store's lock.
        yield* controlSocket(directory, secrets, Effect.void, {
          limits: Effect.die("limits were not asked for in this test"),
          usage: () => Effect.die("usage was not asked for in this test")
        })
        // Not a database: opening or migrating it would fail with a store error, or rewrite it.
        const database = path.join(directory, "usage.db")
        yield* fs.writeFileString(database, "sentinel")
        yield* fs.chmod(database, 0o600)
        const empty = yield* fs.makeTempDirectoryScoped()
        const config: AgentUsageConfig = {
          storeDirectory: directory,
          projects: [],
          claudeConfigDir: empty,
          claudeCredentials: { file: path.join(empty, "none"), keychainService: "none", keychainAccount: "none" },
          roots: {
            claudeProjects: path.join(empty, "projects"),
            codexHome: empty,
            claudeLimitSamples: path.join(empty, "none.jsonl"),
            machine: "test"
          }
        }
        const ready = yield* Deferred.make<string>()
        const failure = yield* Effect.flip(
          Effect.scoped(Layer.build(makeServer({ config, port: 0, ready, security: secrets })))
        )
        expect(failure).toBeInstanceOf(ServerAlreadyRunning)
        expect(yield* fs.readFileString(database)).toBe("sentinel")
      }))

    it.effect("a running server answers limits from its own store over the control socket", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        yield* fs.chmod(directory, 0o700)
        const empty = yield* fs.makeTempDirectoryScoped()
        const config: AgentUsageConfig = {
          storeDirectory: directory,
          projects: [],
          claudeConfigDir: empty,
          claudeCredentials: { file: path.join(empty, "none"), keychainService: "none", keychainAccount: "none" },
          roots: {
            claudeProjects: path.join(empty, "projects"),
            codexHome: empty,
            claudeLimitSamples: path.join(empty, "none.jsonl"),
            machine: "test"
          }
        }
        const secrets = yield* makeOwnerSession(origin)
        const ready = yield* Deferred.make<string>()
        yield* Layer.build(makeServer({ config, port: 0, ready, security: secrets }))
        yield* Deferred.await(ready)
        // The startup poll runs in the background; ask until its first reading is stored.
        const limits = yield* requestLimits(directory, process.geteuid?.() ?? -1).pipe(
          Effect.repeat({ until: (answer) => answer.latest.length > 0, schedule: Schedule.spaced("50 millis") }),
          Effect.timeout("10 seconds")
        )
        expect(limits.machine).toBe("test")
        // No credentials here: the poll stored why, as an Unknown reading of Claude, never a level.
        expect(
          limits.latest.map((snapshot) => [snapshot.agent, snapshot.machine, snapshot.label, snapshot.reading._tag])
        )
          .toEqual([["claude", "test", "*", "Unknown"]])
      }))
  })
})
