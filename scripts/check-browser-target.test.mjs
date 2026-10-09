import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { BROWSER_TARGET } from "../browser-target.ts"

// Every browser build takes its target from browser-target.ts: each Vite build config and each esbuild
// script sets `target: BROWSER_TARGET` imported from there, and none names browsers or an ES level itself.
// An esbuild script that bundles for Node (`platform: "node"`, Relay's Pi bundle) emits no browser code.

const root = fileURLToPath(new URL("..", import.meta.url))
const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())

const sources = await runtime.runPromise(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", ["ls-files"], { cwd: root, extendEnv: true }))
    const files = (yield* Stream.mkString(Stream.decodeText(handle.stdout))).split("\n")
    const fileSystem = yield* FileSystem.FileSystem
    return yield* Effect.forEach(
      files.filter((file) => file.startsWith("packages/") || file.startsWith("scripts/")),
      (file) =>
        /\.(?:[cm]?[jt]s)$/u.test(file)
          ? fileSystem.readFileString(`${root}/${file}`).pipe(Effect.map((text) => ({ file, text })))
          : Effect.succeed({ file, text: "" })
    )
  }).pipe(Effect.scoped)
)

const viteBuildConfig = /(?:^|\/)vite(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/u
const esbuildScript = ({ file, text }) =>
  /^packages\/[^/]+\/scripts\//u.test(file) && /from "esbuild"/u.test(text) && !/platform:\s*"node"/u.test(text)
const builds = sources.filter(({ file, text }) => viteBuildConfig.test(file) || esbuildScript({ file, text }))
const importsTarget = /import \{ BROWSER_TARGET \} from "(?:\.\.\/)+browser-target\.ts"/u
// A target written out in place: a browser list or an ES level, quoted or in an array.
const inlineTarget = /target:\s*\[?\s*["'](?:es\d|esnext|chrome|safari|firefox|edge|baseline)/u

test("every Vite build and esbuild asset script takes its target from browser-target.ts", () => {
  assert.ok(builds.length >= 9, `found only ${builds.length} builds: ${builds.map(({ file }) => file).join(", ")}`)
  for (const { file, text } of builds) {
    assert.match(text, importsTarget, `${file} must import BROWSER_TARGET from browser-target.ts`)
    assert.match(text, /target: BROWSER_TARGET\b/u, `${file} must set target: BROWSER_TARGET`)
    assert.doesNotMatch(text, inlineTarget, `${file} must not name a target of its own`)
  }
})

test("the shared target is at least what the CSS needs: light-dark() and safe alignment", () => {
  const version = (browser) => Number(BROWSER_TARGET.find((entry) => entry.startsWith(browser))?.slice(browser.length))
  assert.ok(version("chrome") >= 123)
  assert.ok(version("edge") >= 123)
  assert.ok(version("firefox") >= 120)
  assert.ok(version("safari") >= 17.6)
})
