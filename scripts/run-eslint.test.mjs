import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { eslintArguments } from "./run-eslint.mjs"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())

test("content caches are isolated by partition and local-rule/dependency fingerprint", () => {
  const args = ["src/input.ts", "--fix"]
  /** @param {"workspace" | "control-center"} partition @param {string} fingerprint */
  const plan = (partition, fingerprint) => eslintArguments({ args, cache: true, fingerprint, partition })
  const controlCenter = plan("control-center", "a")
  assert.deepEqual(controlCenter.slice(0, 3), ["--cache", "--cache-strategy", "content"])
  assert.equal(controlCenter[4], "node_modules/.cache/eslint/control-center-a")
  assert.notEqual(controlCenter[4], plan("workspace", "a")[4])
  assert.notEqual(controlCenter[4], plan("control-center", "b")[4])
  assert.deepEqual(controlCenter.slice(5), args)
})

test("uncached execution retains exactly the caller's options", () => {
  const args = ["src/input.ts", "--no-cache"]
  assert.deepEqual(eslintArguments({ args, cache: false, fingerprint: "unused", partition: "workspace" }), args)
})

test("CLI caches local runs, skips caches in CI, and catches a changed cached file", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        `${directory}/eslint.config.js`,
        'export default [{ files: ["**/*.mjs"], rules: { "no-debugger": "error" } }]\n'
      )
      yield* fs.writeFileString(`${directory}/eslint-local-rules.cjs`, "module.exports = {}\n")
      yield* fs.writeFileString(`${directory}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\n")
      yield* fs.writeFileString(`${directory}/input.mjs`, "export const value = 1\n")
      /** @param {string} ci @param {string | undefined} cache */
      const lint = (ci, cache) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              "node",
              [fileURLToPath(new URL("./run-eslint.mjs", import.meta.url)), "workspace", "input.mjs"],
              {
                cwd: directory,
                env: { CI: ci, ESLINT_CACHE: cache },
                extendEnv: true
              }
            )
          )
          return yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode
            ],
            { concurrency: "unbounded" }
          )
        })
      assert.equal((yield* lint("true", undefined))[2], ChildProcessSpawner.ExitCode(0))
      assert.equal(yield* fs.exists(`${directory}/node_modules/.cache/eslint`), false)
      assert.equal((yield* lint("true", "true"))[2], ChildProcessSpawner.ExitCode(0))
      assert.equal(yield* fs.exists(`${directory}/node_modules/.cache/eslint`), true)
      assert.equal((yield* lint("false", undefined))[2], ChildProcessSpawner.ExitCode(0))
      assert.equal(yield* fs.exists(`${directory}/node_modules/.cache/eslint`), true)
      const originalCaches = yield* fs.readDirectory(`${directory}/node_modules/.cache/eslint`)
      yield* fs.writeFileString(`${directory}/eslint-local-rules.cjs`, "module.exports = { changed: true }\n")
      assert.equal((yield* lint("false", undefined))[2], ChildProcessSpawner.ExitCode(0))
      assert.equal(
        (yield* fs.readDirectory(`${directory}/node_modules/.cache/eslint`)).length,
        originalCaches.length + 1
      )
      yield* fs.writeFileString(`${directory}/input.mjs`, "debugger\n")
      const [stdout, stderr, exitCode] = yield* lint("false", undefined)
      assert.notEqual(exitCode, ChildProcessSpawner.ExitCode(0))
      assert.match(`${stdout}\n${stderr}`, /no-debugger/u)
    }).pipe(Effect.scoped)
  )
})
