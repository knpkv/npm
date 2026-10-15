import { expect, it } from "vitest"
import { pinReferenceFleet } from "./browser/connect-pin-fixture.js"

/** Filled-host reference families are recorded fixture data, not an old-peer hash fallback. */
it("serves the long-list frame's Lime cache-warmer and Sky schema-check families", () => {
  expect(pinReferenceFleet.find(({ name }) => name === "cache-warmer")).toHaveProperty("hue", "lime")
  expect(pinReferenceFleet.find(({ name }) => name === "schema-check")).toHaveProperty("hue", "sky")
})
