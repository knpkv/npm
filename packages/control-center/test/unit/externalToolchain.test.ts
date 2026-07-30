import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

describe("Control Center external toolchain", () => {
  it.effect("keeps every spawned executable in the declarative development shell", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const executables = new Set<string>()
      const directories = [
        new URL("../../e2e/", import.meta.url).pathname,
        new URL("../../scripts/", import.meta.url).pathname
      ]
      while (directories.length > 0) {
        const directory = directories.pop()
        if (directory === undefined) break
        for (const entry of yield* fileSystem.readDirectory(directory)) {
          const entryPath = path.join(directory, entry)
          const info = yield* fileSystem.stat(entryPath)
          if (info.type === "Directory") {
            directories.push(entryPath)
          } else if (info.type === "File" && entry.endsWith(".ts")) {
            const source = yield* fileSystem.readFileString(entryPath)
            for (const [, executable] of source.matchAll(/ChildProcess\.make\(\s*"([^"]+)"/gu)) {
              if (executable !== undefined) executables.add(executable)
            }
          }
        }
      }
      expect(Array.from(executables).sort()).toEqual(["git", "node", "openssl", "pnpm"])

      const flakeSource = yield* fileSystem.readFileString(new URL("../../../../flake.nix", import.meta.url).pathname)
      for (const packageName of ["git", "nodejs", "openssl", "pnpm"]) {
        expect(flakeSource).toMatch(new RegExp(`^\\s+${packageName}$`, "mu"))
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
