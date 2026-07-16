import { describe, expect, it } from "vitest"

import {
  appliedPortfolioCursor,
  type PortfolioSnapshotLoadState,
  reducePortfolioLiveState
} from "../../src/client/portfolio/livePortfolioState.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

const loadedState = (
  cursor = 10
): Extract<PortfolioSnapshotLoadState, { readonly _tag: "loaded" }> => ({
  _tag: "loaded",
  awaitingResetSnapshot: false,
  connection: { _tag: "connected" },
  isSnapshotStale: false,
  minimumRefreshCursor: null,
  sessionKey: "session-a",
  snapshot: makePortfolioSnapshot("current", cursor)
})

describe("live portfolio state", () => {
  it("ignores duplicate and lower invalidations without making the snapshot stale", () => {
    const state = loadedState()
    const duplicate = reducePortfolioLiveState(state, {
      _tag: "invalidated",
      eventCursor: makePortfolioSnapshot("current", 10).eventCursor
    })
    const lower = reducePortfolioLiveState(duplicate, {
      _tag: "invalidated",
      eventCursor: makePortfolioSnapshot("current", 9).eventCursor
    })

    expect(duplicate).toBe(state)
    expect(lower).toBe(state)
    expect(appliedPortfolioCursor(lower)).toBe(makePortfolioSnapshot("current", 10).eventCursor)
  })

  it("keeps only the greatest pending invalidation while preserving the applied cursor", () => {
    const invalidatedAtEleven = reducePortfolioLiveState(loadedState(), {
      _tag: "invalidated",
      eventCursor: makePortfolioSnapshot("current", 11).eventCursor
    })
    const invalidatedAtThirteen = reducePortfolioLiveState(invalidatedAtEleven, {
      _tag: "invalidated",
      eventCursor: makePortfolioSnapshot("current", 13).eventCursor
    })

    expect(invalidatedAtThirteen).toMatchObject({
      _tag: "loaded",
      isSnapshotStale: true,
      minimumRefreshCursor: makePortfolioSnapshot("current", 13).eventCursor
    })
    expect(appliedPortfolioCursor(invalidatedAtThirteen)).toBe(makePortfolioSnapshot("current", 10).eventCursor)
  })

  it("rejects a refresh behind its invalidation and accepts a snapshot that jumps ahead", () => {
    const invalidated = reducePortfolioLiveState(loadedState(), {
      _tag: "invalidated",
      eventCursor: makePortfolioSnapshot("current", 12).eventCursor
    })
    const behind = reducePortfolioLiveState(invalidated, {
      _tag: "stream-snapshot",
      snapshot: makePortfolioSnapshot("current", 11)
    })
    const converged = reducePortfolioLiveState(behind, {
      _tag: "stream-snapshot",
      snapshot: makePortfolioSnapshot("current", 14)
    })

    expect(behind).toBe(invalidated)
    expect(converged).toMatchObject({
      _tag: "loaded",
      awaitingResetSnapshot: false,
      connection: { _tag: "connected" },
      isSnapshotStale: false,
      minimumRefreshCursor: null
    })
    expect(appliedPortfolioCursor(converged)).toBe(makePortfolioSnapshot("current", 14).eventCursor)
  })

  it("preserves the prior snapshot across reset until its replacement arrives", () => {
    const beforeReset = loadedState()
    const resetHeadCursor = makePortfolioSnapshot("current", 20).eventCursor
    const reset = reducePortfolioLiveState(beforeReset, { _tag: "reset-required", headCursor: resetHeadCursor })
    const ignoredInvalidation = reducePortfolioLiveState(reset, {
      _tag: "invalidated",
      eventCursor: makePortfolioSnapshot("current", 15).eventCursor
    })
    const belowResetHead = reducePortfolioLiveState(ignoredInvalidation, {
      _tag: "stream-snapshot",
      snapshot: makePortfolioSnapshot("current", 19)
    })
    const replacement = reducePortfolioLiveState(belowResetHead, {
      _tag: "stream-snapshot",
      snapshot: makePortfolioSnapshot("current", 20)
    })

    expect(reset).toMatchObject({
      _tag: "loaded",
      awaitingResetSnapshot: true,
      isSnapshotStale: true,
      minimumRefreshCursor: resetHeadCursor,
      snapshot: beforeReset.snapshot
    })
    expect(ignoredInvalidation).toBe(reset)
    expect(belowResetHead).toBe(reset)
    expect(replacement).toMatchObject({
      _tag: "loaded",
      awaitingResetSnapshot: false,
      isSnapshotStale: false
    })
    expect(appliedPortfolioCursor(replacement)).toBe(makePortfolioSnapshot("current", 20).eventCursor)
  })

  it("keeps the applied snapshot visible while reconnecting and offline", () => {
    const reconnecting = reducePortfolioLiveState(loadedState(), { _tag: "reconnecting", attempt: 3 })
    const offline = reducePortfolioLiveState(reconnecting, { _tag: "offline" })

    expect(reconnecting).toMatchObject({
      _tag: "loaded",
      connection: { _tag: "reconnecting", attempt: 3 },
      isSnapshotStale: true
    })
    expect(offline).toMatchObject({
      _tag: "loaded",
      connection: { _tag: "offline" },
      isSnapshotStale: true,
      snapshot: loadedState().snapshot
    })
  })

  it("clears reconnect staleness only after catch-up evidence", () => {
    const reconnecting = reducePortfolioLiveState(loadedState(), { _tag: "reconnecting", attempt: 1 })
    const caughtUp = reducePortfolioLiveState(reconnecting, { _tag: "caught-up" })

    expect(reconnecting).toMatchObject({
      _tag: "loaded",
      connection: { _tag: "reconnecting", attempt: 1 },
      isSnapshotStale: true
    })
    expect(caughtUp).toMatchObject({
      _tag: "loaded",
      connection: { _tag: "connected" },
      isSnapshotStale: false
    })
  })

  it("retains a reset floor across reconnect and accepts a cursor-ahead replacement", () => {
    const resetHeadCursor = makePortfolioSnapshot("current", 20).eventCursor
    const reset = reducePortfolioLiveState(loadedState(30), {
      _tag: "reset-required",
      headCursor: resetHeadCursor
    })
    const reconnecting = reducePortfolioLiveState(reset, { _tag: "reconnecting", attempt: 1 })
    const prematureCatchUp = reducePortfolioLiveState(reconnecting, { _tag: "caught-up" })
    const replacement = reducePortfolioLiveState(prematureCatchUp, {
      _tag: "stream-snapshot",
      snapshot: makePortfolioSnapshot("current", 20)
    })

    expect(reconnecting).toMatchObject({
      awaitingResetSnapshot: true,
      minimumRefreshCursor: resetHeadCursor
    })
    expect(prematureCatchUp).toBe(reconnecting)
    expect(replacement).toMatchObject({
      awaitingResetSnapshot: false,
      connection: { _tag: "connected" },
      minimumRefreshCursor: null,
      snapshot: { eventCursor: resetHeadCursor }
    })
  })
})
