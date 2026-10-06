import { describe, expect, it } from "@effect/vitest"
import { makeInFlight } from "../src/client/utils/inFlight.js"

describe("makeInFlight", () => {
  it("shares one pending request per key, and starts afresh once it settles", async () => {
    const share = makeInFlight<string>()
    let started = 0
    let finish: (value: string) => void = () => {}
    const run = () => {
      started += 1
      return new Promise<string>((resolve) => (finish = resolve))
    }
    const first = share("pr-44", run)
    const overlapping = share("pr-44", run)
    expect(overlapping).toBe(first)
    expect(share("pr-45", () => Promise.resolve("other"))).not.toBe(first)
    expect(started).toBe(1)
    finish("done")
    await expect(first).resolves.toBe("done")
    void share("pr-44", run)
    expect(started).toBe(2)
  })

  it("lets a failed request be retried", async () => {
    const share = makeInFlight<string>()
    await expect(share("pr-44", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    await expect(share("pr-44", () => Promise.resolve("again"))).resolves.toBe("again")
  })
})
