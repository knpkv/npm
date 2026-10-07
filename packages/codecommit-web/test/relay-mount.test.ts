import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { CacheService, ConfigService, ReadClient } from "@knpkv/codecommit-core"
import { ConfigProvider, Context, Effect, FileSystem, Layer, Path } from "effect"
import { commentPosterLayer, RelayMount, relayMountLayer } from "../src/server/relay/RelayMount.js"
import { RelayFindingPublisher } from "../src/server/review/RelayFindingPublisher.js"

/** Relay's mount over a throwaway HOME, with no CLI on PATH and capabilities that are never called. */
const mountIn = (home: string) =>
  relayMountLayer.pipe(
    Layer.provide(commentPosterLayer),
    Layer.provide(Layer.mergeAll(
      Layer.mock(RelayFindingPublisher, {}),
      Layer.mock(CacheService.PullRequestRepo, {}),
      Layer.mock(ConfigService.ConfigService, {}),
      Layer.mock(ReadClient.CodeCommitReadClient, {})
    )),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home, PATH: "" } })))
  )

const mounted = (home: string) => Effect.map(Layer.build(mountIn(home)), (context) => Context.get(context, RelayMount))

layer(NodeServices.layer, { excludeTestServices: true })("Relay mount", (it) => {
  it.effect("keeps sessions owner-only under ~/.codecommit/relay and reports a missing CLI as NotInstalled", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const relay = yield* Effect.flatMap(mounted(home), (mount) => mount.harness)
      const directory = path.join(home, ".codecommit", "relay")
      expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(path.join(directory, "sessions.sqlite"))).mode & 0o777).toBe(0o600)
      expect(yield* relay.backends).toMatchObject([
        { _tag: "Unavailable", backend: "claude-code", cause: "NotInstalled" },
        { _tag: "Unavailable", backend: "codex-cli", cause: "NotInstalled" }
      ])
      expect(relay.tools.map((tool) => [tool.name, tool.access])).toEqual([
        ["get_pull_request", "read"],
        ["list_pull_requests", "read"],
        ["get_pull_request_diff", "read"],
        ["post_comment", "write"],
        ["post_line_comment", "write"]
      ])
    }).pipe(Effect.scoped))

  it.effect("a second server on the same HOME starts without Relay and says why", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* Effect.flatMap(mounted(home), (mount) => mount.harness)
      const second = yield* mounted(home)
      const refused = yield* second.harness.pipe(Effect.flip)
      expect(refused).toMatchObject({
        _tag: "RelayUnavailableError",
        fix: "Another codecommit web owns Relay's sessions. Stop it, then restart this one."
      })
    }).pipe(Effect.scoped))
})
