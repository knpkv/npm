import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { RelayConflictError, RelayStreamFrame } from "../src/wire.js"

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RelayStreamFrame))

describe("Relay wire", () => {
  it("reads the frames the events route sends", () => {
    expect(
      decodeFrame(JSON.stringify({ _tag: "Snapshot", session: "s", seq: 0, messages: [], runIds: [], queued: [] }))._tag
    )
      .toBe("Snapshot")
    expect(decodeFrame(JSON.stringify({ _tag: "Unauthorized" }))._tag).toBe("Unauthorized")
    expect(decodeFrame(JSON.stringify({ _tag: "StreamFailed" }))._tag).toBe("StreamFailed")
  })

  it("refuses a frame that isn't one of Relay's", () => {
    expect(() => decodeFrame(JSON.stringify({ _tag: "Nonsense" }))).toThrow()
  })

  it("keeps the state a 409 found", () => {
    const encoded = Schema.encodeSync(RelayConflictError)(new RelayConflictError({ state: { _tag: "Expired" } }))
    expect(encoded).toEqual({ _tag: "RelayConflictError", state: { _tag: "Expired" } })
  })
})
