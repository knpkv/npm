/**
 * The standalone page: the shell's own stylesheet (rly's tokens and base) comes before the app's scoped CSS, and
 * every element the shell lends the app carries `data-app`, so that CSS reaches portaled content too.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AppManifest } from "../src/manifest.js"
import { shellCssVersion, standaloneShellHtml } from "../src/standalone-page.js"

const manifest = Schema.decodeUnknownSync(AppManifest)({
  contract: 1,
  id: "probe",
  package: "@knpkv/probe",
  version: "1.0.0",
  module: {
    id: "probe",
    label: "Probe",
    defaultPage: "overview",
    pages: [{ id: "overview", label: "Overview" }],
    listeners: ["local"],
    requires: ["read"]
  },
  services: [],
  nav: { order: 1, primary: true, mobile: false },
  standalone: { defaultPort: 3199 },
  client: { entry: "client.js", css: ["client.css"] }
})

describe("standaloneShellHtml", () => {
  const page = standaloneShellHtml(manifest, "2.3.4")

  it("links the shell stylesheet first, versioned so it can be cached for good, then the app's", () => {
    const links = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/gu)].map((match) => match[1])
    expect(links).toEqual(["/app/shell.css?v=2.3.4", "/app/assets/client.css"])
  })

  it.layer(NodeServices.layer)((it) => {
    it.effect("versions the shell stylesheet by its text, so a changed stylesheet gets a new URL", () =>
      Effect.gen(function*() {
        const link = (css: string) =>
          shellCssVersion(css).pipe(
            Effect.map((version) =>
              standaloneShellHtml(manifest, version).match(/href="(\/app\/shell\.css\?v=[0-9a-f]{16})"/u)?.[1]
            )
          )
        const [first, again, changed] = yield* Effect.all([
          link(":root { --a: 1 }"),
          link(":root { --a: 1 }"),
          link(":root { --a: 2 }")
        ])
        expect(first).toBeDefined()
        expect(again).toBe(first)
        expect(changed).not.toBe(first)
      }))
  })

  it("scopes the mount root, the header outlet, the slot and the portal root to the app", () => {
    const scoped = [...page.matchAll(/<(\w+) ([^>]*)data-app="probe"/gu)].map((match) => `${match[1]} ${match[2]}`)
    expect(scoped).toEqual([
      "span data-hub-shell=\"slot\" ",
      "div data-hub-shell=\"outlet\" ",
      "main id=\"hub-app-root\" ",
      "div id=\"hub-app-portals\" "
    ])
  })
})
