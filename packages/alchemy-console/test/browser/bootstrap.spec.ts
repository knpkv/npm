import { NodeServices } from "@effect/platform-node"
import { expect, test as base } from "@playwright/test"
import { Context, Deferred, Effect, FileSystem, Layer, ManagedRuntime, Option, Path } from "effect"
import { Catalog } from "../../src/server/Catalog.js"
import { requestLoginUrl } from "../../src/server/ControlSocket.js"
import type { ControlError } from "../../src/server/ControlSocket.js"
import { makeServer } from "../../src/server/Server.js"
import { fixtureSourceLayer } from "../catalogFixture.js"

/** Fixture-only credentials stay in the private runtime and browser navigation, never reports or traces. */
class BrowserFixture extends Context.Service<BrowserFixture, {
  readonly url: string
  readonly mint: Effect.Effect<string, ControlError>
}>()("AlchemyConsole/BrowserFixture") {}

const browserLayer = Layer.effect(
  BrowserFixture,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-web-" })
    yield* fs.chmod(directory, 0o700)
    const uid = Option.getOrElse((yield* fs.stat(directory)).uid, () => -1)
    const ready = yield* Deferred.make<string>()
    yield* Layer.build(makeServer({ directory, port: 0, uid }, ready))
    const url = yield* Deferred.await(ready)
    const mint = requestLoginUrl({ directory, port: Number(new URL(url).port), uid }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.flatMap(Option.match({ onNone: () => Effect.die("fixture server stopped"), onSome: Effect.succeed }))
    )
    return BrowserFixture.of({ url, mint })
  })
).pipe(Layer.provide(Catalog.layer.pipe(Layer.provide(fixtureSourceLayer))), Layer.provide(NodeServices.layer))

const test = base.extend<{ login: { readonly url: string; readonly mint: () => Promise<string> } }>({
  login: async ({ browserName: _browserName }, use) => {
    const runtime = ManagedRuntime.make(browserLayer)
    try {
      const fixture = await runtime.runPromise(BrowserFixture)
      await use({ url: fixture.url, mint: () => runtime.runPromise(fixture.mint) })
    } finally {
      await runtime.dispose()
    }
  }
})

/** A fresh fragment must restart login after a spent link leaves the page on the same root URL. */
test("a fresh link recovers the failed-login page and removes its fragment", async ({ login, page }) => {
  await page.goto(login.url)
  await expect(page).toHaveURL(/\/api\/stacks$/)
  await expect(page.locator("pre")).toHaveCount(1)
  await expect(page.locator("pre")).toContainText("fixture-app")
  expect(new URL(page.url()).hash).toBe("")

  await page.goto(login.url)
  await expect(page.getByRole("main")).toHaveCount(1)
  await expect(page.locator("#status")).toHaveText(
    "Sign-in failed or link already used. Run alchemy-console login."
  )
  await page.waitForLoadState("networkidle", { timeout: 5000 })
  expect(new URL(page.url()).hash).toBe("")

  await page.goto(await login.mint())
  await expect(page).toHaveURL(/\/api\/stacks$/)
  await expect(page.locator("pre")).toHaveCount(1)
  await expect(page.locator("pre")).toContainText("fixture-app")
  expect(new URL(page.url()).hash).toBe("")
})
