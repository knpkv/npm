import { describe, expect, it } from "@effect/vitest"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import { type WorkGoalCheckpoint, WorkRecoveryContext, type WorkSnapshots } from "@knpkv/herdr-work/model"
import { Effect, Result, Schema } from "effect"
import {
  workAdmissionPreflightUrl,
  workCheckpointFromJson,
  workCheckpointUrl,
  workDefaultTarget,
  workRecoveryContextUrl,
  workRecoveryPreflightUrl,
  workSnapshotFromJson,
  workSnapshotNotes,
  workSnapshotTarget,
  workSnapshotUrl
} from "../src/work-checkpoint.js"

const checkpoint: WorkGoalCheckpoint = {
  eventId: "event-work-created",
  goal: {
    blocker: null,
    connectTarget: null,
    createdAt: 1_000,
    delivery: "local",
    detail: "Durable coordinator-owned goal",
    id: "goal-work",
    owner: { id: "owner-coordinator", name: "Coordinator" },
    repository: { branch: "feat/herdr-npm-packages", repository: "npm" },
    spend: null,
    state: "planned",
    summary: "Record live Work state",
    title: "Wire Work ingestion",
    updatedAt: 1_000
  },
  occurredAt: 1_000,
  version: "herdr.work.event.v1"
}

const snapshot: WorkSnapshots = {
  observedAt: 1_000,
  now: { asOf: 1_000, goals: [checkpoint.goal], observedAt: 1_000, window: "now" },
  day: { asOf: 1_000, goals: [checkpoint.goal], observedAt: 1_000, window: "day" },
  week: { asOf: 1_000, goals: [checkpoint.goal], observedAt: 1_000, window: "week" },
  month: { asOf: 1_000, goals: [checkpoint.goal], observedAt: 1_000, window: "month" }
}

const config: HostConfiguration = {
  allowedUsers: ["owner@example.com"],
  applyCommand: null,
  applyMachines: ["SER8"],
  approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:4779/" },
  approvalNodes: ["node-ser8"],
  approvalPort: 4_779,
  browserMcpRecoverCommand: null,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "ALPHA",
  localPort: 4_777,
  machines: [
    { host: "ALPHA", nodeId: "node-alpha" },
    { host: "SER8", nodeId: "node-ser8" }
  ],
  port: 4_778,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:owner@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory: "/state",
  tailscaleCommand: "tailscale"
}

describe("fleetctl work commands", () => {
  it.effect("validates recovery context facts and retains authenticated listener targeting", () =>
    Effect.gen(function*() {
      expect(yield* workRecoveryContextUrl(config, "ALPHA", "goal-work")).toBe(
        "http://127.0.0.1:4777/v1/work/recovery-context?goalId=goal-work"
      )
      const remote = { ...config, crossHost: true }
      expect(yield* workRecoveryContextUrl(remote, "SER8", "goal-work")).toBe(
        "https://ser8.example.test:4779/v1/work/recovery-context?goalId=goal-work"
      )
      for (
        const [configuration, host, id] of [
          [config, "SER8", "goal-work"],
          [remote, "ALPHA", "goal-work"],
          [config, "FOREIGN", "goal-work"],
          [config, "ALPHA", ""]
        ] satisfies ReadonlyArray<readonly [HostConfiguration, string, string]>
      ) {
        expect(yield* Effect.result(workRecoveryContextUrl(configuration, host, id))).toMatchObject({
          failure: { _tag: "FleetValidationError" }
        })
      }
      const decode = Schema.decodeUnknownEffect(WorkRecoveryContext, {
        onExcessProperty: "error"
      })
      expect(
        yield* decode({
          goalId: "goal-work",
          expectedGoalEventId: "checkpoint",
          expectedGoalUpdatedAt: 1
        })
      ).toEqual({
        goalId: "goal-work",
        expectedGoalEventId: "checkpoint",
        expectedGoalUpdatedAt: 1
      })
      for (
        const invalid of [
          {
            goalId: "",
            expectedGoalEventId: "checkpoint",
            expectedGoalUpdatedAt: 1
          },
          {
            goalId: "goal-work",
            expectedGoalEventId: "",
            expectedGoalUpdatedAt: 1
          },
          {
            goalId: "goal-work",
            expectedGoalEventId: "checkpoint",
            expectedGoalUpdatedAt: -1
          },
          {
            goalId: "goal-work",
            expectedGoalEventId: "checkpoint",
            expectedGoalUpdatedAt: 1,
            ready: true
          }
        ]
      ) {
        expect((yield* Effect.result(decode(invalid)))._tag).toBe("Failure")
      }
    }))
  it.effect("decodes checkpoints and targets the local Work listener", () =>
    Effect.gen(function*() {
      expect(yield* workCheckpointFromJson(JSON.stringify(checkpoint))).toEqual(checkpoint)
      expect(yield* workCheckpointUrl(config, "alpha")).toBe(
        "http://127.0.0.1:4778/v1/work/checkpoints"
      )
      expect(yield* workSnapshotUrl(config, "ALPHA")).toBe(
        "http://127.0.0.1:4778/v1/work"
      )
      expect(yield* workAdmissionPreflightUrl(config, "ALPHA")).toBe(
        "http://127.0.0.1:4777/v1/work/admission-preflight"
      )
      expect(yield* workRecoveryPreflightUrl(config, "alpha")).toBe("http://127.0.0.1:4777/v1/work/recovery-preflight")
      const lanConfig = { ...config, workBindAddress: "127.0.0.2" }
      expect(yield* workCheckpointUrl(lanConfig, "ALPHA")).toBe(
        "http://127.0.0.2:4778/v1/work/checkpoints"
      )
      expect(yield* workSnapshotUrl(lanConfig, "ALPHA")).toBe(
        "http://127.0.0.2:4778/v1/work"
      )
      expect(workDefaultTarget(config)).toBe("ALPHA")
      expect(workSnapshotTarget(config, undefined)).toBe("ALPHA")
      expect(workSnapshotTarget(config, "ALPHA")).toBe("ALPHA")
      const remote = yield* Effect.result(workCheckpointUrl(config, "SER8"))
      expect(remote).toMatchObject({
        failure: {
          _tag: "FleetValidationError",
          detail: "work commands can only target the local host"
        }
      })
    }))

  it.effect("targets only the canonical approval hub when cross-host control is enabled", () =>
    Effect.gen(function*() {
      const crossHostConfig = { ...config, crossHost: true }
      expect(workDefaultTarget(crossHostConfig)).toBe("SER8")
      const omittedSnapshotTarget = workSnapshotTarget(crossHostConfig, undefined)
      expect(omittedSnapshotTarget).toBe("SER8")
      expect(workSnapshotTarget(crossHostConfig, "SER8")).toBe("SER8")
      expect(yield* workCheckpointUrl(crossHostConfig, "ser8")).toBe(
        "https://ser8.example.test:4779/v1/work/checkpoints"
      )
      expect(yield* workSnapshotUrl(crossHostConfig, omittedSnapshotTarget)).toBe(
        "https://ser8.example.test:4779/v1/work"
      )
      expect(yield* workAdmissionPreflightUrl(crossHostConfig, "ser8")).toBe(
        "https://ser8.example.test:4779/v1/work/admission-preflight"
      )
      expect(yield* workRecoveryPreflightUrl(crossHostConfig, "SER8")).toBe(
        "https://ser8.example.test:4779/v1/work/recovery-preflight"
      )
      expect(yield* Effect.result(workRecoveryPreflightUrl(crossHostConfig, "ALPHA"))).toMatchObject({
        failure: { _tag: "FleetValidationError", detail: "work commands can only target the canonical approval hub" }
      })
      expect(yield* Effect.result(workAdmissionPreflightUrl(crossHostConfig, "unknown"))).toMatchObject({
        failure: { _tag: "FleetValidationError", detail: "unknown host: unknown" }
      })
      const nonHub = yield* Effect.result(workSnapshotUrl(crossHostConfig, "ALPHA"))
      expect(nonHub).toMatchObject({
        failure: {
          _tag: "FleetValidationError",
          detail: "work commands can only target the canonical approval hub"
        }
      })
    }))

  it.effect("rejects malformed or widened checkpoint JSON before HTTP", () =>
    Effect.gen(function*() {
      const malformed = yield* Effect.result(workCheckpointFromJson("{"))
      const widened = yield* Effect.result(
        workCheckpointFromJson(JSON.stringify({ ...checkpoint, command: ["sh", "-c", "id"] }))
      )
      expect(Result.isFailure(malformed)).toBe(true)
      expect(widened).toMatchObject({ failure: { _tag: "FleetValidationError" } })
    }))

  it.effect("decodes typed Work snapshots before rendering or returning them", () =>
    Effect.gen(function*() {
      expect(yield* workSnapshotFromJson(JSON.stringify(snapshot))).toEqual(snapshot)

      const malformed = yield* Effect.result(workSnapshotFromJson("{"))
      expect(malformed).toMatchObject({ failure: { _tag: "FleetValidationError" } })
      // A newer hub may add keys: they are dropped, never returned, so the read still works and an
      // injected field can't reach what fleetctl prints.
      const widened = {
        ...snapshot,
        command: ["sh", "-c", "id"],
        now: { ...snapshot.now, goalsShownLater: 3 }
      }
      expect(yield* workSnapshotFromJson(JSON.stringify(widened))).toEqual(snapshot)
    }))

  it("notes on stderr how many older goals each cut window left out, and nothing for a whole board", () => {
    expect(workSnapshotNotes(snapshot)).toEqual([])
    expect(workSnapshotNotes({
      ...snapshot,
      now: { ...snapshot.now, finishedOmitted: 3, goalsOmitted: 12 },
      month: { ...snapshot.month, goalsOmitted: 1 }
    })).toEqual([
      "now: 3 finished goals not shown",
      "now: 12 older goals not shown",
      "month: 1 older goal not shown"
    ])
  })

  it.effect("names a newer hub format instead of calling the snapshot malformed", () =>
    Effect.gen(function*() {
      const newer = yield* Effect.result(workSnapshotFromJson(JSON.stringify({ version: 2, goals: [] })))
      expect(newer).toMatchObject({
        failure: {
          _tag: "FleetValidationError",
          detail: "the hub sends Work snapshot version 2; this fleetctl reads version 1: upgrade fleetctl with the hub"
        }
      })
      // A newer version that still decodes is just read.
      expect(yield* workSnapshotFromJson(JSON.stringify({ ...snapshot, version: 2 }))).toEqual({
        ...snapshot,
        version: 2
      })
    }))

  it.effect("rejects malformed approval targets before persistence", () =>
    Effect.gen(function*() {
      const malformed = yield* Effect.result(workCheckpointFromJson(JSON.stringify({
        ...checkpoint,
        goal: {
          ...checkpoint.goal,
          approvalTarget: {
            host: "SER8",
            jobId: "approval-job-42",
            url: "javascript:alert(1)"
          }
        }
      })))
      expect(malformed).toMatchObject({ failure: { _tag: "FleetValidationError" } })
    }))
})
