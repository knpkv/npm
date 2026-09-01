import { describe, expect, it } from "@effect/vitest"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import type { WorkGoalCheckpoint } from "@knpkv/herdr-work/model"
import { Effect, Result } from "effect"
import {
  workCheckpointFromJson,
  workCheckpointUrl,
  workDefaultTarget,
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

const config: HostConfiguration = {
  allowedUsers: ["andrey@example.com"],
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
  pushSubject: "mailto:andrey@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory: "/state",
  tailscaleCommand: "tailscale"
}

describe("fleetctl work commands", () => {
  it.effect("decodes checkpoints and targets the local Work listener", () =>
    Effect.gen(function*() {
      expect(yield* workCheckpointFromJson(JSON.stringify(checkpoint))).toEqual(checkpoint)
      expect(yield* workCheckpointUrl(config, "alpha")).toBe(
        "http://127.0.0.1:4778/v1/work/checkpoints"
      )
      expect(yield* workSnapshotUrl(config, "ALPHA")).toBe(
        "http://127.0.0.1:4778/v1/work"
      )
      expect(workDefaultTarget(config)).toBe("ALPHA")
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
      expect(yield* workCheckpointUrl(crossHostConfig, "ser8")).toBe(
        "https://ser8.example.test:4779/v1/work/checkpoints"
      )
      expect(yield* workSnapshotUrl(crossHostConfig, "SER8")).toBe(
        "https://ser8.example.test:4779/v1/work"
      )
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
