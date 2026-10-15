import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { browserCall } from "../src/browser.js"
import { LiveProduct, type StartProduct } from "../src/live.js"
import { RunnerFailure } from "../src/schema.js"
import { serveFiles } from "../src/server.js"

declare global {
  interface Window {
    __designFixtureIdentity: { readonly state: string; readonly theme: string }
  }
}

const Data = Schema.Struct({ heading: Schema.String, detail: Schema.String })
const states = ["passing", "copy", "geometry", "token", "pixel", "waived", "stale", "legacy", "unreferenced"]

export const start: StartProduct = Effect.fn("DesignFixture.start")(function*(fixture, repository) {
  yield* Schema.decodeUnknownEffect(Data)(fixture.data).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid toy fixture: ${cause.message}` }))
  )
  const origin = yield* serveFiles(`${repository}/packages/design-conformance/test/fixtures`, {
    "/screen.html": "screen.html",
    "/screen.js": "screen.js",
    "/screen.css": "screen.css"
  })
  return LiveProduct.of({
    origin,
    inventory: {
      routes: ["/screen.html"],
      states: states.map((state) => ({
        screen: "toy",
        state,
        route: "/screen.html",
        viewports: [390, 1280],
        themes: ["light", "dark"]
      }))
    },
    seed: (page, data, identity) =>
      browserCall("seed toy", async () => {
        await page.route("**/fixture.json", (route) => route.fulfill({ json: data }))
        await page.addInitScript((identity) => {
          window.__designFixtureIdentity = identity
        }, identity)
      }),
    ready: (page) => browserCall("toy readiness", () => page.locator("html[data-design-ready=\"true\"]").waitFor())
  })
})
