import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  formatUsageError,
  jobKinds,
  oneLine,
  parseInvocation,
  unknownHostDetail,
  unknownKindDetail,
  usage,
  workPayload,
  workUsage
} from "../src/internal/fleetctl-cli.js"

describe("fleetctl invocation", () => {
  // Help is a successful answer, not a validation error: plain usage on stdout, exit 0.
  it("treats --help, -h and help as help, for the whole tool and for work", () => {
    for (const args of [["--help"], ["-h"], ["help"], ["status", "--help"]]) {
      expect(parseInvocation(args)).toEqual({ _tag: "Help", text: usage })
    }
    for (const args of [["work", "--help"], ["work", "-h"], ["help", "work"]]) {
      expect(parseInvocation(args)).toEqual({ _tag: "Help", text: workUsage })
    }
    expect(usage.startsWith("Usage: fleetctl COMMAND")).toBe(true)
    expect(usage).not.toContain("Error")
  })

  // An unknown or missing command fails with one line naming the cause, followed by usage.
  it("rejects an unknown or missing command with a one-line cause", () => {
    const unknown = parseInvocation(["deploy"])
    expect(unknown._tag).toBe("FleetctlUsageError")
    if (unknown._tag !== "FleetctlUsageError") return
    expect(formatUsageError(unknown).split("\n\n")[0]).toBe("fleetctl: unknown command \"deploy\"")
    expect(formatUsageError(unknown)).toContain(usage)
    const missing = parseInvocation([])
    expect(missing._tag === "FleetctlUsageError" ? missing.reason : "").toBe("missing command")
  })

  // A "-h" later on the line belongs to the command (a prompt or a message), not to help.
  it("only reads a help flag right after the command", () => {
    expect(parseInvocation(["submit", "SER8", "agent.message", "s1", "-h"])).toEqual({
      _tag: "Run",
      command: "submit",
      rest: ["SER8", "agent.message", "s1", "-h"]
    })
  })

  // An unknown host names the hosts this machine knows, so the next command can be typed.
  it("names the known hosts for an unknown host", () => {
    expect(unknownHostDetail("EXAMPLEHOST", ["SER8", "MBP"])).toBe(
      "unknown host \"EXAMPLEHOST\"; known hosts: SER8, MBP (run fleetctl hosts to see which are online)"
    )
    expect(unknownHostDetail("EXAMPLEHOST", [])).toContain("knows no fleet hosts")
  })

  // An unknown job kind lists the kinds, and every listed kind is one the usage documents.
  it("names the job kinds for an unknown or missing kind", () => {
    expect(unknownKindDetail("nix.build")).toBe(`unknown job kind "nix.build"; kinds: ${jobKinds.join(", ")}`)
    expect(unknownKindDetail(undefined)).toMatch(/^submit needs a job kind; kinds: nix\.check/u)
    for (const kind of jobKinds) expect(usage).toContain(`submit HOST ${kind}`)
  })

  // Terminal errors are one line, even when a decoder reports across several.
  it("collapses a multi-line detail to one line", () => {
    expect(oneLine("invalid job: Expected string\n  at [\"ref\"]\n")).toBe("invalid job: Expected string; at [\"ref\"]")
  })

  // A command missing its arguments says which, before the fleet configuration is read.
  it("names the missing arguments of follow, job, submit and apply-everywhere", () => {
    const reasons = [["follow", "SER8"], ["job", "SER8"], ["submit", "SER8"], ["apply-everywhere"]].map((args) => {
      const invocation = parseInvocation(args)
      return invocation._tag === "FleetctlUsageError" ? invocation.reason : invocation._tag
    })
    expect(reasons).toEqual([
      "follow needs HOST and ID",
      "job needs HOST and ID",
      "submit needs HOST and a job kind",
      "apply-everywhere needs REF"
    ])
    expect(parseInvocation(["job", "SER8", "job-1"])._tag).toBe("Run")
  })

  // A reason quotes what was typed; a typed newline must not split the cause line.
  it("keeps a quoted command on the cause line", () => {
    const invocation = parseInvocation(["de\nploy"])
    if (invocation._tag !== "FleetctlUsageError") throw new Error("expected a usage error")
    expect(formatUsageError(invocation).split("\n\n")[0]).toBe("fleetctl: unknown command \"de; ploy\"")
  })
})

describe("work.* payloads", () => {
  const abandon = {
    goalId: "fix-iphone-live-ui-polish",
    owner: { id: "agent-codex-owner", name: "Codex owner" },
    reason: "no PR, no branch, no owner",
    expectedGoalEventId: "goal-event-7",
    expectedGoalUpdatedAt: 500
  }

  // Coord (item 12): a payload without its kind failed "work.abandon payload is invalid", naming nothing.
  it.effect("takes the kind from the command when the payload leaves it out", () =>
    Effect.gen(function*() {
      const payload = yield* workPayload("work.abandon", ["work.abandon", JSON.stringify(abandon)])
      expect(payload.kind).toBe("work.abandon")
    }))

  it.effect("names each failing field and what it expected, in one line", () =>
    Effect.gen(function*() {
      const { goalId: _goalId, ...withoutGoal } = abandon
      const error = yield* Effect.flip(
        workPayload("work.abandon", ["work.abandon", JSON.stringify({ ...withoutGoal, reason: 3 })])
      )
      expect(error.detail).toContain("work.abandon payload: ")
      expect(error.detail).toContain("goalId")
      expect(error.detail).toContain("reason")
      expect(error.detail).not.toContain("\n")
    }))

  it.effect("says when the payload is not a JSON object, and when its kind is another command's", () =>
    Effect.gen(function*() {
      const notJson = yield* Effect.flip(workPayload("work.abandon", ["work.abandon", "{nope"]))
      expect(notJson.detail).toBe("work.abandon payload is not a JSON object")
      const other = yield* Effect.flip(
        workPayload("work.abandon", ["work.abandon", JSON.stringify({ ...abandon, kind: "work.admit" })])
      )
      expect(other.detail).toContain("work.abandon payload")
    }))
})
