import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { HubPaths, JobStore, makeFleetService, standaloneDefaults } from "@knpkv/herdr-fleet"
import { Effect, FileSystem, Path } from "effect"
import { makeHostdOperations } from "../src/hostd.js"
import { startHttpServer } from "../src/http.js"
import { ownerTable } from "./fixtures/hub-paths.js"

const assets = {
  connectScript: "",
  fonts: new Map<string, Uint8Array>(),
  icon: () => Promise.resolve(null),
  script: "",
  stylesheet: "",
  worker: ""
}

layer(NodeServices.layer)("standalone hostd serving", (it) => {
  // A clean machine has no Herdr and its HOME is no repository: the hub must still answer, saying so.
  it.effect("serves the super-app with the real standalone operations on a machine without Herdr or a repository", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hostd-standalone-serve-" })
      const defaults = yield* standaloneDefaults.pipe(Effect.provideService(HubPaths, ownerTable(home)))
      const config = {
        ...defaults,
        // Bind ephemeral ports: a developer machine may run its own hub on 4778.
        localPort: 0,
        port: 0,
        herdrCommand: path.join(home, "no-herdr-here")
      }
      yield* fileSystem.makeDirectory(config.stateDirectory, { recursive: true })
      const store = yield* Effect.acquireRelease(
        JobStore.open(path.join(config.stateDirectory, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const operations = yield* makeHostdOperations(config, undefined, store, true)
      const fleet = yield* makeFleetService({ approvalEnabled: false, host: config.host, operations, store })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startHttpServer(config, fleet, assets)),
        (running) => Effect.promise(running.close)
      )
      const response = yield* Effect.promise(() => fetch(`${server.url}/`))
      const body = yield* Effect.promise(() => response.text())
      expect(response.status, body.slice(0, 300)).toBe(200)
      expect(body).toContain("fleet-dashboard-data")
    }).pipe(Effect.scoped))
})
