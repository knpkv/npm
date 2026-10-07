import { describe, expect, it } from "@effect/vitest"
import { makeInFlight, pullRequestRefreshKey } from "../src/client/utils/inFlight.js"

describe("makeInFlight", () => {
  it("shares one pending request per key, and starts afresh once it settles", async () => {
    const { share } = makeInFlight<string>()
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
    const { share } = makeInFlight<string>()
    await expect(share("pr-44", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    await expect(share("pr-44", () => Promise.resolve("again"))).resolves.toBe("again")
  })

  it("keys a refresh by account, so two accounts' same-numbered PRs never share one", () => {
    expect(pullRequestRefreshKey("dev", "44", "payments", "eu-west-1"))
      .not.toBe(pullRequestRefreshKey("prod", "44", "payments", "eu-west-1"))
    expect(pullRequestRefreshKey("dev", "44", "payments", "eu-west-1"))
      .toBe(pullRequestRefreshKey("dev", "44", "payments", "eu-west-1"))
  })

  // After a change (an approval rule edit), a read already in flight may have read the old state.
  it("starts a fresh request after the pending one, and lets later asks share the fresh one", async () => {
    const { fresh, share } = makeInFlight<string>()
    const calls: Array<string> = []
    let finishOld: (value: string) => void = () => {}
    const old = share("pr-44", () => {
      calls.push("old")
      return new Promise<string>((resolve) => (finishOld = resolve))
    })
    const after = fresh("pr-44", () => {
      calls.push("fresh")
      return Promise.resolve("new state")
    })
    expect(share("pr-44", () => Promise.resolve("never"))).toBe(after)
    expect(calls).toEqual(["old"])
    finishOld("old state")
    await expect(old).resolves.toBe("old state")
    await expect(after).resolves.toBe("new state")
    expect(calls).toEqual(["old", "fresh"])
  })

  // The approvers card polls while an edit is pending; polls during one slow refresh must not queue
  // a refresh each. A fresh read still waiting to start begins after every ask that joins it.
  it("lets fresh asks made while a fresh read waits to start share that one read", async () => {
    const { fresh } = makeInFlight<string>()
    const calls: Array<string> = []
    let finishOld: (value: string) => void = () => {}
    const slow = (label: string) => () => {
      calls.push(label)
      return label === "old" ? new Promise<string>((resolve) => (finishOld = resolve)) : Promise.resolve(label)
    }
    void fresh("pr-44", slow("old"))
    const first = fresh("pr-44", slow("poll 1"))
    expect(fresh("pr-44", slow("poll 2"))).toBe(first)
    finishOld("old state")
    await expect(first).resolves.toBe("poll 1")
    expect(calls).toEqual(["old", "poll 1"])
    // Once that read has started, a later fresh ask may have changed state after it began.
    const second = fresh("pr-44", slow("poll 3"))
    expect(second).not.toBe(first)
    await expect(second).resolves.toBe("poll 3")
  })
})
