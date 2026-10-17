import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { build } from "esbuild"

/**
 * hostd bundles `./host/server` with esbuild's Node defaults (main before module). A dependency
 * whose `main` is a UMD build with dynamic requires breaks only at load time, so build and load it.
 */
layer(NodeServices.layer)("host server bundle", (it) => {
  it.effect("bundles for Node the way hostd does and loads without missing modules", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped()
      const outfile = path.join(directory, "host-server.mjs")
      const entry = yield* path.fromFileUrl(new URL("../src/host-server.ts", import.meta.url))
      yield* Effect.promise(() =>
        build({
          entryPoints: [entry],
          bundle: true,
          platform: "node",
          format: "esm",
          outfile,
          logLevel: "silent",
          banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
        })
      )
      const loaded: unknown = yield* Effect.promise(() => import(outfile))
      expect(loaded).toHaveProperty("stacksHostLayer")
    }), 60_000)
})
