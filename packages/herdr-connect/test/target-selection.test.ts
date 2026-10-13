import { Schema } from "effect"
import { expect, it } from "vitest"
import { ConnectAgent } from "../src/model.js"
import { connectTargetSelection, connectTargetSelectionMatches, sameConnectTargetSelection } from "../src/target.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "ALPHA",
  id: "agent-one",
  name: "Worker",
  kind: "codex",
  state: "working",
  work: "Review",
  lastActivityAt: 0
})

/** Unrelated parameters and host casing cannot change terminal ownership; ids and opening mode can. */
it.each(
  [
    ["?host=ALPHA&agent=agent-one", "?keep=yes&agent=agent-one&host=alpha", true],
    ["?host=ALPHA&agent=agent-one&open=stage", "?host=AlPhA&agent=agent-one&open=stage&query=review", true],
    ["?host=ALPHA&agent=agent-one", "?host=ALPHA&agent=agent-two", false],
    ["?host=ALPHA&agent=agent-one", "?host=BETA&agent=agent-one", false],
    ["?host=ALPHA&agent=agent-one", "?host=ALPHA&agent=agent-one&open=stage", false],
    ["?host=ALPHA&agent=agent-one", "?host=ALPHA&agent=Agent-one", false],
    ["?query=one", "?query=two", true],
    ["?host=ALPHA&agent=agent-one", "?host=ALPHA", false]
  ] satisfies ReadonlyArray<readonly [string, string, boolean]>
)("compares selection %s with %s", (left, right, same) => {
  expect(sameConnectTargetSelection(connectTargetSelection(left), connectTargetSelection(right))).toBe(same)
})

it.each(["alpha", "AlPhA", "ALPHA"])("matches %s to the configured host for stage resolution and close", (host) => {
  const selection = connectTargetSelection(`?host=${host}&agent=agent-one&open=stage`)
  expect(selection).toEqual({ _tag: "selected", host: "alpha", agent: "agent-one", open: "stage" })
  expect(connectTargetSelectionMatches(selection, agent)).toBe(true)
  expect(connectTargetSelectionMatches(selection, agent, "stage")).toBe(true)
  expect(connectTargetSelectionMatches(selection, agent, "terminal")).toBe(false)
})

/** Strict selection decoding keeps duplicates, missing halves and unsupported modes out of both ownership paths. */
it.each([
  "?host=ALPHA",
  "?agent=agent-one",
  "?host=ALPHA&host=alpha&agent=agent-one",
  "?host=ALPHA&agent=agent-one&agent=agent-two",
  "?host=ALPHA&agent=%2Fraw%2Fsession",
  "?host=ALPHA&agent=agent-one&open=terminal",
  "?host=ALPHA&agent=agent-one&open=stage&open=stage"
])("rejects malformed selection %s", (search) => {
  const selection = connectTargetSelection(search)
  expect(selection).toEqual({ _tag: "malformed" })
  expect(connectTargetSelectionMatches(selection, agent)).toBe(false)
})
