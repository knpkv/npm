import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { permittedCaptureUrl, permittedReferenceUrl } from "../src/network.js"

it.effect("reference paths ignore query strings but still require exact hashed path membership", () =>
  Effect.sync(() => {
    const files = new Set(["page.html", "probe.svg", "nested/style.css"])
    for (
      const address of [
        "http://fixture.test/page.html?state=passing&theme=light",
        "http://fixture.test/probe.svg?cache=fixture#shape",
        "http://fixture.test/nested/style.css?v=1"
      ]
    ) expect(permittedReferenceUrl(address, files)).toBe(true)
    for (
      const address of [
        "http://fixture.test/missing.svg?cache=fixture",
        "http://fixture.test/probe.svg/missing",
        "http://fixture.test/?path=probe.svg",
        "http://fixture.test/%70robe.svg",
        "http://fixture.test/nested%2fstyle.css"
      ]
    ) expect(permittedReferenceUrl(address, files)).toBe(false)
  }))

it.effect("capture URLs allow only the exact network origin and inert browser schemes", () =>
  Effect.sync(() => {
    const origin = "http://127.0.0.1:3000"
    for (
      const address of [
        origin + "/asset.svg",
        "about:blank",
        "data:image/svg+xml,<svg/>",
        "blob:" + origin + "/fixture"
      ]
    ) expect(permittedCaptureUrl(address, origin)).toBe(true)
    for (
      const address of [
        "http://127.0.0.1:3001/",
        "https://127.0.0.1:3000/",
        "http://127.0.0.1.example.test:3000/",
        "file:///fixture.svg",
        "wss://example.test/socket"
      ]
    ) expect(permittedCaptureUrl(address, origin)).toBe(false)
  }))
