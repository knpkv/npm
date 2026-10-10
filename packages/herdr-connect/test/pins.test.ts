import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import { arrangePins, MAX_PINS, observePins, pin, Pins, unpin } from "../src/pins.js"

const agent = (name: string) => ({ host: "nix", id: name, key: `nix:${name}`, name })
const minute = 60_000

/** Pins every name in order, failing the test if any pin is refused. */
const pinAll = (names: ReadonlyArray<string>, now = 0): Pins =>
  names.reduce<Pins>((pins, name) => Result.getOrThrow(pin(pins, agent(name), now)), [])

describe("pins", () => {
  // Pin order is the order the reader chose; re-pinning one already pinned must not move it to the end.
  it("keeps pin order, and pinning an agent twice keeps one pin where it was", () => {
    const pins = pinAll(["a", "b", "c"])
    expect(Result.getOrThrow(pin(pins, agent("a"), 5 * minute)).map((each) => each.key)).toEqual([
      "nix:a",
      "nix:b",
      "nix:c"
    ])
    expect(unpin(pins, "nix:b").map((each) => each.key)).toEqual(["nix:a", "nix:c"])
  })

  // A full set is said out loud: the newest pin is refused and no older pin is dropped to make room.
  it(`refuses a pin past ${String(MAX_PINS)} and keeps every existing one`, () => {
    const names = Array.from({ length: MAX_PINS }, (_, index) => `agent-${String(index)}`)
    const pins = pinAll(names)
    const refused = pin(pins, agent("one-more"), 0)
    expect(Result.isFailure(refused) && refused.failure._tag === "PinLimitReached").toBe(true)
    expect(pins).toHaveLength(MAX_PINS)
  })

  // An agent that leaves keeps its pin and its last name and time; it is never pruned for being away.
  it("keeps an away agent's pin, name and last-seen minute, and updates them when it is seen again", () => {
    const pins = pinAll(["a", "b"], 3 * minute + 5_000)
    const away = observePins(pins, [agent("a")], 10 * minute + 30_000)
    expect(away.map((each) => [each.key, each.seenAt])).toEqual([
      ["nix:a", 10 * minute],
      ["nix:b", 3 * minute]
    ])
    const renamed = observePins(away, [{ ...agent("b"), name: "b-renamed" }], 12 * minute)
    expect(renamed.find((each) => each.key === "nix:b")).toMatchObject({ name: "b-renamed", seenAt: 12 * minute })
  })

  // A poll that changes nothing must hand back the same list, so the client doesn't write storage every poll.
  it("returns the same list when a poll changes nothing", () => {
    const pins = pinAll(["a"], 4 * minute)
    expect(observePins(pins, [agent("a")], 4 * minute + 59_000)).toBe(pins)
    expect(observePins(pins, [], 9 * minute)).toBe(pins)
  })

  // The chips show the first pins whose agents are here; the rest, and every away pin, wait behind "+N".
  it("shows the first present pins in pin order and puts the rest, away ones included, in the overflow", () => {
    const pins = pinAll(["a", "b", "c", "d", "e"])
    const here = new Set(["nix:a", "nix:c", "nix:d", "nix:e"])
    const { overflow, shown } = arrangePins(pins, (key) => (here.has(key) ? key : undefined), 2)
    expect(shown.map((view) => view.pin.key)).toEqual(["nix:a", "nix:c"])
    expect(overflow.map((view) => [view.pin.key, view.agent !== undefined])).toEqual([
      ["nix:b", false],
      ["nix:d", true],
      ["nix:e", true]
    ])
    // The agent whose terminal is open isn't repeated among its own pins.
    const open = arrangePins(pins, (key) => (here.has(key) ? key : undefined), 2, (key) => key === "nix:a")
    expect(open.shown.map((view) => view.pin.key)).toEqual(["nix:c", "nix:d"])
  })

  // Stored pins come back through the schema; a list longer than the cap or a malformed entry is refused.
  it("decodes stored pins and refuses an over-long or malformed list", () => {
    const decode = Schema.decodeUnknownResult(Pins)
    expect(Result.isSuccess(decode(pinAll(["a", "b"])))).toBe(true)
    expect(
      Result.isFailure(decode(pinAll(Array.from({ length: MAX_PINS }, (_, i) => String(i))).concat(pinAll(["x"]))))
    ).toBe(true)
    expect(Result.isFailure(decode([{ key: "", host: "nix", id: "a", name: "a", seenAt: 0 }]))).toBe(true)
  })
})
