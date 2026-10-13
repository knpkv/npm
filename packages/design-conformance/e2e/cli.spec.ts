import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stream from "effect/Stream"

import { gitChildEnvironment } from "../scripts/discovery.js"
import { readJson } from "../src/references.js"
import { Result } from "../src/schema.js"

test("production tsx CLI captures the passing toy state and writes successful evidence", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      const output = yield* fs.makeTempDirectoryScoped()
      const handle = yield* spawner.spawn(ChildProcess.make("pnpm", [
        "design:check",
        "--product",
        "_fixture",
        "--state",
        "toy/passing",
        "--output",
        output
      ], { cwd: repository, env: gitChildEnvironment, extendEnv: true, stderr: "pipe" }))
      const log = yield* Stream.mkString(Stream.decodeText(handle.all))
      expect(yield* handle.exitCode, log).toBe(0)
      expect(log).toContain("_fixture: PASS; 0 required, 0 report-only")
      const result = yield* readJson(path.join(output, "result.json"), Result)
      expect(result.passed).toBe(true)
      expect(result.findings).toEqual([])
      expect(result.shots).toHaveLength(4)
      for (const shot of result.shots) {
        expect(shot.state).toBe("passing")
        for (const file of Object.values(shot.artifacts)) expect(yield* fs.exists(path.join(output, file))).toBe(true)
      }
      expect(yield* fs.exists(path.join(output, "index.html"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
