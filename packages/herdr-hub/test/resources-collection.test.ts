import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { collectBoundedText } from "@knpkv/bounded-io"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { resourcesStates } from "./superapp-browser/resources-fixture.js"

const collect = Effect.fn("ResourcesTest.collect")(function*(directory: string | undefined) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const paths = yield* Path.Path
  const cwd = yield* paths.fromFileUrl(new URL("../", import.meta.url))
  const handle = yield* spawner.spawn(ChildProcess.make("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.superapp.config.ts",
    "test/superapp-browser/resources.spec.ts",
    "--list"
  ], { cwd, env: { HOST_RESOURCES_DESIGN_DIRECTORY: directory }, extendEnv: true }))
  const { code, stderr, stdout } = yield* Effect.all({
    code: handle.exitCode,
    stdout: collectBoundedText(handle.stdout, 256 * 1024),
    stderr: collectBoundedText(handle.stderr, 256 * 1024)
  }, { concurrency: "unbounded" })
  return { code: Number(code), output: stdout + stderr }
})

it.layer(NodeServices.layer, { excludeTestServices: true })("resources browser collection", (it) => {
  it.effect("collects every resources behavior case from a checkout without private design references", () =>
    Effect.gen(function*() {
      const result = yield* collect(undefined)
      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain("Total: 44 tests in 1 file")
    }))

  it.effect("requires the complete reference inventory whenever design attachments are configured", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "resources-refs-" })
      const empty = yield* collect(root)
      expect(empty.code).not.toBe(0)
      expect(empty.output).toContain("ENOENT")
      for (const state of resourcesStates) {
        for (const width of [390, 1280]) {
          for (const theme of ["light", "dark"]) {
            yield* fs.writeFileString(
              `${root}/host-resources--${state}--${width}-${theme}.png`,
              "collection-only fixture"
            )
          }
        }
      }
      const complete = yield* collect(root)
      expect(complete.code, complete.output).toBe(0)
      expect(complete.output).toContain("Total: 44 tests in 1 file")
      yield* fs.remove(`${root}/host-resources--gate-holder-unknown--1280-dark.png`)
      const missing = yield* collect(root)
      expect(missing.code).not.toBe(0)
      expect(missing.output).toContain("host-resources--gate-holder-unknown--1280-dark.png")
    }))
})
