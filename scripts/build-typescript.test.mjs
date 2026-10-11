import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stream from "effect/Stream"
import * as TypeScript from "typescript"

import { outputPlan } from "./build-typescript.mjs"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())

test("opted-in packages retain the compiler-only output layout", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = fileURLToPath(new URL("../", import.meta.url))
      const base = TypeScript.parseConfigFileTextToJson(
        "tsconfig.base.jsonc",
        yield* fs.readFileString(`${root}/tsconfig.base.jsonc`)
      )
      assert.equal(base.error, undefined)
      for (const name of yield* fs.readDirectory(`${root}/packages`)) {
        const directory = `${root}/packages/${name}`
        if ((yield* fs.stat(directory)).type !== "Directory") continue
        if (!(yield* fs.exists(`${directory}/package.json`))) continue
        const manifest = JSON.parse(yield* fs.readFileString(`${directory}/package.json`))
        if (manifest.scripts?.build !== "node ../../scripts/build-typescript.mjs") continue
        const config = JSON.parse(yield* fs.readFileString(`${directory}/tsconfig.json`))
        assert.equal(config.extends, "../../tsconfig.base.jsonc", name)
        const options = { ...base.config.compilerOptions, ...config.compilerOptions }
        assert.equal(options.rootDir.replace(/^\.\//u, ""), "src", name)
        assert.equal(options.outDir.replace(/^\.\//u, ""), "dist", name)
        for (const flag of ["declaration", "declarationMap", "sourceMap", "incremental", "composite"]) {
          assert.equal(options[flag], true, `${name}: ${flag}`)
        }
        assert.notEqual(options.noEmit, true, name)
        assert.notEqual(options.emitDeclarationOnly, true, name)
        assert.notEqual(options.resolveJsonModule, true, name)
        const sources = yield* fs.readDirectory(`${directory}/src`, { recursive: true })
        assert.equal(
          sources.some((source) => /\.(?:mts|cts)$/u.test(source)),
          false,
          name
        )
        if (sources.some((source) => source.endsWith(".tsx"))) assert.equal(options.jsx, "react-jsx", name)
      }
    })
  )
})

test("a source deletion or rename removes every old emitted artifact", () => {
  const outputs = ["old.js", "old.js.map", "old.d.ts", "old.d.ts.map"]
  assert.deepEqual(outputPlan(["new.ts"], outputs), { stale: outputs, force: true })
  assert.deepEqual(outputPlan(["ambient.d.ts", "new.ts"], outputs), { stale: outputs, force: true })
  assert.deepEqual(outputPlan([], outputs), { stale: outputs, force: false })
})

test("a missing output forces emission even when build info still exists", () => {
  const outputs = ["nested/view.js", "nested/view.js.map", "nested/view.d.ts", "nested/view.d.ts.map"]
  assert.deepEqual(outputPlan(["nested/view.tsx"], outputs), { stale: [], force: false })
  for (const missing of outputs) {
    assert.deepEqual(
      outputPlan(
        ["nested/view.tsx"],
        outputs.filter((file) => file !== missing)
      ),
      {
        stale: [],
        force: true
      }
    )
  }
})

test("real compiler reuses outputs, removes deleted sources, and repairs missing emits", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${directory}/src/nested`, { recursive: true })
      yield* fs.writeFileString(`${directory}/src/keep.ts`, "export const value = 1\n")
      yield* fs.writeFileString(`${directory}/src/delete.ts`, "export const removed = 2\n")
      yield* fs.writeFileString(`${directory}/src/nested/view.tsx`, "export const view = 1\n")
      yield* fs.writeFileString(
        `${directory}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: {
            composite: true,
            incremental: true,
            jsx: "react-jsx",
            rootDir: "src",
            outDir: "dist",
            declaration: true,
            declarationMap: true,
            sourceMap: true,
            types: []
          },
          include: ["src"]
        })
      )
      const build = (ci = "false") =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("node", [fileURLToPath(new URL("./build-typescript.mjs", import.meta.url))], {
              cwd: directory,
              env: { CI: ci },
              extendEnv: true
            })
          )
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode
            ],
            { concurrency: "unbounded" }
          )
          assert.equal(exitCode, ChildProcessSpawner.ExitCode(0), `${stdout}\n${stderr}`)
        })
      yield* build()
      const before = yield* fs.stat(`${directory}/dist/keep.js`)
      yield* build()
      assert.deepEqual((yield* fs.stat(`${directory}/dist/keep.js`)).mtime, before.mtime)
      yield* fs.remove(`${directory}/src/delete.ts`)
      yield* build()
      for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
        assert.equal(yield* fs.exists(`${directory}/dist/delete${suffix}`), false)
      }
      yield* fs.remove(`${directory}/dist/keep.js`)
      yield* build()
      assert.equal(yield* fs.exists(`${directory}/dist/keep.js`), true)
      yield* fs.writeFileString(`${directory}/src/keep.ts`, "export const value = 3\n")
      yield* build()
      assert.match(yield* fs.readFileString(`${directory}/dist/keep.js`), /value = 3/u)
      const local = yield* fs.stat(`${directory}/dist/keep.js`)
      yield* build("true")
      assert.notDeepEqual((yield* fs.stat(`${directory}/dist/keep.js`)).mtime, local.mtime)
    }).pipe(Effect.scoped)
  )
})
