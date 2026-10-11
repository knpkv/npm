import { NodeServices } from "@effect/platform-node"
import { expect, type Page, test as base } from "@playwright/test"
import { Context, Deferred, Effect, FileSystem, Layer, ManagedRuntime, Option, Path, Schema } from "effect"
import { StackDetail, StackId, StackList } from "../../src/api.js"
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

type Login = { readonly url: string; readonly mint: () => Promise<string> }

const useLogin = async (use: (login: Login) => Promise<void>) => {
  const runtime = ManagedRuntime.make(browserLayer)
  try {
    const fixture = await runtime.runPromise(BrowserFixture)
    await use({ url: fixture.url, mint: () => runtime.runPromise(fixture.mint) })
  } finally {
    await runtime.dispose()
  }
}

const test = base.extend<{ login: Login; otherLogin: Login }>({
  login: async ({ browserName: _browserName }, use) => useLogin(use),
  otherLogin: async ({ browserName: _browserName }, use) => useLogin(use)
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

/** Cookies share a loopback host across ports; each listener must retain its own authenticated session. */
test("two listeners stay authenticated in one browser, including repeat login", async ({ context, login, otherLogin, page }) => {
  await page.goto(login.url)
  await expect(page).toHaveURL(/\/api\/stacks$/)
  const second = await context.newPage()
  try {
    await second.goto(otherLogin.url)
    await expect(second).toHaveURL(/\/api\/stacks$/)
    const checkOwner = async (target: Page) => {
      await target.reload()
      await expect(target.locator("pre")).toContainText("fixture-app")
      const origin = new URL(target.url()).origin
      const listResponse = await context.request.get(`${origin}/api/stacks`)
      expect(listResponse.status()).toBe(200)
      const list = Schema.decodeUnknownSync(StackList)(await listResponse.json())
      const id = Schema.decodeUnknownSync(StackId)(list.stacks[0]?.id)
      const detailResponse = await context.request.get(`${origin}/api/stacks/${id}`)
      expect(detailResponse.status()).toBe(200)
      const detail = Schema.decodeUnknownSync(StackDetail)(await detailResponse.json())
      expect(detail.state.app).toBe("fixture-app")
    }
    await checkOwner(page)
    await checkOwner(second)
    await page.goto(await login.mint())
    await expect(page).toHaveURL(/\/api\/stacks$/)
    await checkOwner(page)
    await checkOwner(second)
    expect(new URL(page.url()).hash).toBe("")
    expect(new URL(second.url()).hash).toBe("")
  } finally {
    await second.close()
  }
})
