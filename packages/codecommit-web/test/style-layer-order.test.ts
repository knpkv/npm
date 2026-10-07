import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

/** The names in the one `@layer a, b, c;` statement, in cascade order (later wins). */
const declaredOrder = (css: string): ReadonlyArray<string> =>
  /@layer\s+([^;{]+);/.exec(css)?.[1]?.split(",").map((name) => name.trim()) ?? []

/** Reads a client source file next to `main.tsx`. */
const clientSource = (name: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const testDirectory = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))
    return yield* fileSystem.readFileString(path.join(testDirectory, "..", "src", "client", name))
  })

describe("style layer order", () => {
  it.effect("loads the order statement before rly and Tailwind declare their own layers", () =>
    Effect.gen(function*() {
      const main = yield* clientSource("main.tsx")
      const imports = [...main.matchAll(/^import\s+"([^"]+\.css)"/gm)].map((match) => match[1])
      expect(imports[0]).toBe("./layers.css")
      expect(imports).toContain("@knpkv/rly/styles.css")
      expect(imports).toContain("./index.css")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("puts Tailwind's preflight under rly components and Tailwind utilities above them", () =>
    Effect.gen(function*() {
      const order = declaredOrder(yield* clientSource("layers.css"))
      const at = (name: string) => order.indexOf(name)
      for (const name of ["theme", "base", "rly.reset", "rly.components", "rly.state", "components", "utilities"]) {
        expect(order).toContain(name)
      }
      expect(at("base")).toBeLessThan(at("rly.reset"))
      expect(at("base")).toBeLessThan(at("rly.components"))
      expect(at("rly.state")).toBeLessThan(at("components"))
      expect(at("components")).toBeLessThan(at("utilities"))
    }).pipe(Effect.provide(NodeServices.layer)))
})
