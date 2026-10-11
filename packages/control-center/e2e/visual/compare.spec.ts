import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

const readInventory = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const actual = path.resolve(
    yield* Config.String("CC_VISUAL_OUT").pipe(Config.withDefault("test-results/visual/shots"))
  )
  const base = path.resolve(yield* Config.String("CC_VISUAL_BASE"))
  const actualNames = (yield* fileSystem.readDirectory(actual)).filter((name) => name.endsWith(".png")).sort()
  const baseNames = (yield* fileSystem.readDirectory(base)).filter((name) => name.endsWith(".png")).sort()
  return { actual, base, actualNames, baseNames }
})

const inventory = await Effect.runPromise(readInventory.pipe(Effect.provide(NodeServices.layer)))
const actualNames = new Set(inventory.actualNames)
const baseNames = new Set(inventory.baseNames)

test("capture produced at least one state", () => {
  expect(inventory.actualNames.length).toBeGreaterThan(0)
})

for (const name of [...new Set([...inventory.actualNames, ...inventory.baseNames])].sort()) {
  test(name, async () => {
    const info = test.info()
    if (!actualNames.has(name)) {
      info.annotations.push({ type: "visual-state", description: "removed" })
      expect(actualNames.has(name), `removed state: ${name}`).toBe(true)
      return
    }
    const png = await Effect.runPromise(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        return yield* fileSystem.readFile(path.join(inventory.actual, name))
      }).pipe(Effect.provide(NodeServices.layer))
    )
    if (!baseNames.has(name)) {
      info.annotations.push({ type: "visual-state", description: "new" })
      await info.attach("new state", { body: Buffer.from(png), contentType: "image/png" })
      test.skip(true, `new state: ${name}`)
      return
    }
    try {
      expect(Buffer.from(png)).toMatchSnapshot(name)
      info.annotations.push({ type: "visual-state", description: "unchanged" })
    } catch (cause) {
      info.annotations.push({ type: "visual-state", description: "changed" })
      throw cause
    }
  })
}
