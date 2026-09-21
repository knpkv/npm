import { NodePath } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Path } from "effect"
import { isWithinDirectory } from "../src/server/HttpApplication.js"

it.layer(NodePath.layer)("static asset boundary", (it) => {
  it.effect("accepts descendants and rejects sibling-prefix paths", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve("/srv/jcf/dist/client")
      expect(isWithinDirectory(path, root, path.resolve(root, "assets/app.js"))).toBe(true)
      expect(isWithinDirectory(path, root, path.resolve(root, "../client-secret/index.html"))).toBe(false)
      expect(isWithinDirectory(path, root, path.resolve(root, "../outside.txt"))).toBe(false)
    }))
})
