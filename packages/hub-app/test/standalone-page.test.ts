/** The standalone page: the shell's own stylesheet (rly's tokens and base) comes before the app's scoped CSS. */
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { AppManifest } from "../src/manifest.js"
import { standaloneShellHtml } from "../src/standalone-page.js"

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
  it("links the shell stylesheet first, then the app's", () => {
    const links = [...standaloneShellHtml(manifest).matchAll(/<link rel="stylesheet" href="([^"]+)">/gu)]
      .map((match) => match[1])
    expect(links).toEqual(["/app/shell.css", "/app/assets/client.css"])
  })
})
