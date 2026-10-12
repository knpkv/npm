import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { permittedCaptureUrl } from "../src/network.js"

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
