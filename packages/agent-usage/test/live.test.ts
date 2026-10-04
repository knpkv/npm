import { describe, expect, it } from "@effect/vitest"
import { readsToRefresh, reconnectDelay } from "../src/client/liveModel.js"

describe("readsToRefresh", () => {
  it("refetches everything on the first message of each connection, then only what moved", () => {
    const versions = { usage: 3, limits: 7, status: 9 }
    expect(readsToRefresh(null, versions)).toEqual(["usage", "limits", "status"])
    expect(readsToRefresh(versions, { usage: 3, limits: 8, status: 10 })).toEqual(["limits", "status"])
    expect(readsToRefresh(versions, versions)).toEqual([])
  })

  it("refetches a read whose counter went backwards, as after a server restart", () => {
    expect(readsToRefresh({ usage: 5, limits: 5, status: 5 }, { usage: 0, limits: 5, status: 5 })).toEqual(["usage"])
  })
})

describe("reconnectDelay", () => {
  it("backs off exponentially from one second and caps at thirty", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(reconnectDelay)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000
    ])
  })
})
