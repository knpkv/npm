import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  GovernedActionState,
  GovernedActionTransitionCommand,
  GovernedActionTransitionV1,
  isGovernedActionTerminalState,
  reduceGovernedActionState
} from "../../src/domain/governedAction/index.js"

const observedAt = "2026-07-15T10:00:00.000Z"
const authorizationId = "01890f00-0000-7000-8000-000000000101"
const attemptId = "01890f00-0000-7000-8000-000000000102"
const transitionId = "01890f00-0000-7000-8000-000000000103"
const previousTransitionId = "01890f00-0000-7000-8000-000000000104"
const actionId = "01890f00-0000-7000-8000-000000000105"
const workspaceId = "01890f00-0000-7000-8000-000000000106"
const sessionId = "01890f00-0000-7000-8000-000000000107"
const personId = "01890f00-0000-7000-8000-000000000108"
const agentId = "01890f00-0000-7000-8000-000000000109"
const jobId = "01890f00-0000-7000-8000-000000000110"
const actionEnvelopeDigest = `sha256:${"a".repeat(64)}`
const commandDigest = `sha256:${"b".repeat(64)}`
const reconciliationKey = "opaque+token=="

const receipt = {
  providerOperationId: "provider-operation-1",
  safeSummary: "Provider response",
  observedAt
}

const rawCommands = [
  { _tag: "propose" },
  { _tag: "authorize", authorizationId },
  { _tag: "deny", reason: "policy-denied", safeSummary: "Policy denied this action" },
  { _tag: "expire", reason: "proposal-expired" },
  { _tag: "cancel", safeSummary: "Cancelled before dispatch" },
  { _tag: "start", attemptId },
  { _tag: "requestCancellation", safeSummary: "Stop provider work" },
  {
    _tag: "recordAccepted",
    receipt: { ...receipt, status: "accepted", reconciliationKey }
  },
  {
    _tag: "recordSucceeded",
    receipt: { ...receipt, status: "succeeded" },
    source: { _tag: "reconciliation", reconciliationKey }
  },
  {
    _tag: "recordFailed",
    receipt: { ...receipt, status: "failed" },
    source: { _tag: "reconciliation", reconciliationKey }
  },
  {
    _tag: "recordUnknown",
    outcome: {
      _tag: "reconcilable",
      reconciliationKey,
      observedAt,
      safeSummary: "Provider outcome is unknown"
    }
  },
  {
    _tag: "recordCancelled",
    receipt: { ...receipt, status: "cancelled" },
    source: { _tag: "reconciliation", reconciliationKey }
  },
  { _tag: "reconciliationPending", checkedAt: observedAt, reconciliationKey }
]

const decodeCommand = Schema.decodeUnknownSync(GovernedActionTransitionCommand)
const commands = rawCommands.map((rawCommand) => decodeCommand(rawCommand))
const commandByTag = new Map(commands.map((command) => [command._tag, command]))
const states: ReadonlyArray<GovernedActionState | null> = [
  null,
  "proposed",
  "authorized",
  "denied",
  "expired",
  "cancelled",
  "started",
  "cancel-requested",
  "cancel-requested-unknown",
  "succeeded",
  "failed",
  "unknown"
]

const expectedTargets = new Map<string, string>([
  ["null:propose", "proposed"],
  ["proposed:authorize", "authorized"],
  ["proposed:deny", "denied"],
  ["proposed:expire", "expired"],
  ["proposed:cancel", "cancelled"],
  ["authorized:deny", "denied"],
  ["authorized:expire", "expired"],
  ["authorized:cancel", "cancelled"],
  ["authorized:start", "started"],
  ["started:requestCancellation", "cancel-requested"],
  ["started:recordAccepted", "started"],
  ["started:recordSucceeded", "succeeded"],
  ["started:recordFailed", "failed"],
  ["started:recordUnknown", "unknown"],
  ["started:recordCancelled", "cancelled"],
  ["started:reconciliationPending", "started"],
  ["cancel-requested:recordAccepted", "cancel-requested"],
  ["cancel-requested:recordSucceeded", "succeeded"],
  ["cancel-requested:recordFailed", "failed"],
  ["cancel-requested:recordUnknown", "cancel-requested-unknown"],
  ["cancel-requested:recordCancelled", "cancelled"],
  ["cancel-requested:reconciliationPending", "cancel-requested"],
  ["unknown:requestCancellation", "cancel-requested-unknown"],
  ["unknown:recordSucceeded", "succeeded"],
  ["unknown:recordFailed", "failed"],
  ["unknown:recordCancelled", "cancelled"],
  ["unknown:reconciliationPending", "unknown"],
  ["cancel-requested-unknown:recordSucceeded", "succeeded"],
  ["cancel-requested-unknown:recordFailed", "failed"],
  ["cancel-requested-unknown:recordCancelled", "cancelled"],
  ["cancel-requested-unknown:reconciliationPending", "cancel-requested-unknown"]
])

const requireCommand = (tag: GovernedActionTransitionCommand["_tag"]): GovernedActionTransitionCommand => {
  const command = commandByTag.get(tag)
  if (command === undefined) throw new Error(`Missing test command ${tag}`)
  return command
}

describe("governed action state machine", () => {
  it("defines every legal and illegal state-command pair explicitly", () => {
    for (const state of states) {
      for (const command of commands) {
        const key = `${state === null ? "null" : state}:${command._tag}`
        assert.strictEqual(reduceGovernedActionState(state, command), expectedTargets.get(key) ?? null, key)
      }
    }
  })

  it("keeps every terminal state absorbing", () => {
    for (const state of states) {
      if (state === null || !isGovernedActionTerminalState(state)) continue
      for (const command of commands) assert.isNull(reduceGovernedActionState(state, command))
    }
  })

  it.prop(
    "only returns a decoded state or a fail-closed null",
    [Schema.toArbitrary(GovernedActionState), Schema.toArbitrary(GovernedActionTransitionCommand)],
    ([state, command]) => {
      const nextState = reduceGovernedActionState(state, command)
      return nextState === null || Schema.is(GovernedActionState)(nextState)
    }
  )

  it("rejects agent authorization while retaining agent proposal attribution", () => {
    const common = {
      schemaVersion: 1,
      transitionId,
      commandId: "command-1",
      commandDigest,
      actionId,
      workspaceId,
      actionEnvelopeDigest,
      occurredAt: observedAt,
      causationId: null,
      correlationId: null
    }
    const agentCause = {
      _tag: "agent",
      actor: { _tag: "agent", agentId },
      jobId
    }
    const proposal = Schema.decodeUnknownResult(GovernedActionTransitionV1)({
      ...common,
      previousTransitionId: null,
      sequence: 1,
      fromState: null,
      toState: "proposed",
      command: requireCommand("propose"),
      cause: agentCause
    })
    const authorization = Schema.decodeUnknownResult(GovernedActionTransitionV1)({
      ...common,
      previousTransitionId,
      sequence: 2,
      fromState: "proposed",
      toState: "authorized",
      command: requireCommand("authorize"),
      cause: agentCause
    })
    const humanAuthorization = Schema.decodeUnknownResult(GovernedActionTransitionV1)({
      ...common,
      previousTransitionId,
      sequence: 2,
      fromState: "proposed",
      toState: "authorized",
      command: requireCommand("authorize"),
      cause: {
        _tag: "human",
        actor: { _tag: "human", personId },
        sessionId
      }
    })

    assert.isTrue(Result.isSuccess(proposal))
    assert.isTrue(Result.isFailure(authorization))
    assert.isTrue(Result.isSuccess(humanAuthorization))
  })

  it("rejects a forged target state and a broken first-transition chain", () => {
    const forgedState = Schema.decodeUnknownResult(GovernedActionTransitionV1)({
      schemaVersion: 1,
      transitionId,
      previousTransitionId: null,
      commandId: "command-1",
      commandDigest,
      actionId,
      workspaceId,
      sequence: 1,
      fromState: null,
      toState: "succeeded",
      actionEnvelopeDigest,
      command: requireCommand("propose"),
      cause: { _tag: "system", component: "governed-action-engine" },
      occurredAt: observedAt,
      causationId: null,
      correlationId: null
    })
    const brokenChain = Schema.decodeUnknownResult(GovernedActionTransitionV1)({
      schemaVersion: 1,
      transitionId,
      previousTransitionId,
      commandId: "command-1",
      commandDigest,
      actionId,
      workspaceId,
      sequence: 1,
      fromState: null,
      toState: "proposed",
      actionEnvelopeDigest,
      command: requireCommand("propose"),
      cause: { _tag: "system", component: "governed-action-engine" },
      occurredAt: observedAt,
      causationId: null,
      correlationId: null
    })

    assert.isTrue(Result.isFailure(forgedState))
    assert.isTrue(Result.isFailure(brokenChain))
  })

  it("keeps accepted and ambiguous cancellation intent first-class until truthful reconciliation", () => {
    const acceptedState = reduceGovernedActionState("started", requireCommand("recordAccepted"))
    assert.strictEqual(acceptedState, "started")
    const cancellationState = reduceGovernedActionState(acceptedState, requireCommand("requestCancellation"))
    assert.strictEqual(cancellationState, "cancel-requested")
    const ambiguousState = reduceGovernedActionState(cancellationState, requireCommand("recordUnknown"))
    assert.strictEqual(ambiguousState, "cancel-requested-unknown")
    assert.strictEqual(
      reduceGovernedActionState(ambiguousState, requireCommand("reconciliationPending")),
      "cancel-requested-unknown"
    )
    assert.strictEqual(reduceGovernedActionState(ambiguousState, requireCommand("recordCancelled")), "cancelled")
  })

  it("does not let an unkeyed direct receipt resolve an ambiguous action", () => {
    const directSuccess = decodeCommand({
      _tag: "recordSucceeded",
      receipt: { ...receipt, status: "succeeded" },
      source: { _tag: "direct" }
    })

    assert.isNull(reduceGovernedActionState("unknown", directSuccess))
    assert.strictEqual(reduceGovernedActionState("started", directSuccess), "succeeded")
  })

  it("represents recovery by immutable idempotency identity with a null provider locator", () => {
    const pending = decodeCommand({
      _tag: "reconciliationPending",
      checkedAt: observedAt,
      reconciliationKey: null
    })
    const succeeded = decodeCommand({
      _tag: "recordSucceeded",
      receipt: { ...receipt, status: "succeeded" },
      source: { _tag: "reconciliation", reconciliationKey: null }
    })

    assert.strictEqual(reduceGovernedActionState("started", pending), "started")
    assert.strictEqual(reduceGovernedActionState("unknown", pending), "unknown")
    assert.strictEqual(reduceGovernedActionState("cancel-requested", pending), "cancel-requested")
    assert.strictEqual(
      reduceGovernedActionState("cancel-requested-unknown", pending),
      "cancel-requested-unknown"
    )
    assert.strictEqual(reduceGovernedActionState("unknown", succeeded), "succeeded")
  })
})
