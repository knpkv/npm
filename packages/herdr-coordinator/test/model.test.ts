import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { OrchestratorCommand } from "../src/model.js"

describe("coordinator browser model exports", () => {
  it("decodes orchestration commands without importing the Node runtime", () => {
    const command = Schema.decodeUnknownSync(OrchestratorCommand)({
      activityIdempotencyKey: "activity:browser-model",
      actor: "coordinator",
      kind: "fleet.job",
      payload: { kind: "nix.check" }
    })

    expect(command.kind).toBe("fleet.job")
  })
})
