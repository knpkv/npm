import * as Schema from "effect/Schema"
import { expect, it } from "vitest"

import { PluginConnectionSummary } from "../../src/api/plugins.js"
import { makeConnectionDetailTracker } from "../../src/client/services/connectionDetailReads.js"

const connection = (id: string) =>
  Schema.decodeUnknownSync(PluginConnectionSummary)({
    pluginConnectionId: id,
    providerId: "jira",
    displayName: "Fixture Jira",
    isEnabled: true,
    supportsSynchronization: true,
    health: null,
    runtimeRevision: 1,
    updatedAt: "2026-07-14T12:00:00.000Z"
  })

it("keys connection details by their own revision instead of array identity or order", () => {
  const a = connection("01890f6f-6d6a-7cc0-98d2-000000000101")
  const b = connection("01890f6f-6d6a-7cc0-98d2-000000000102")
  const tracker = makeConnectionDetailTracker()
  expect(tracker.reconcile([a, b]).changed).toEqual([a, b])
  expect(tracker.reconcile([{ ...b }, { ...a }]).changed).toEqual([])
  const changed = { ...a, runtimeRevision: 2 }
  expect(tracker.reconcile([changed, b]).changed).toEqual([changed])
  expect(tracker.reconcile([changed]).removed).toEqual([b.pluginConnectionId])
  tracker.reset()
  expect(tracker.reconcile([changed]).changed).toEqual([changed])
})

it("retries an unchanged failed token once without invalidating another connection", () => {
  const a = connection("01890f6f-6d6a-7cc0-98d2-000000000101")
  const b = connection("01890f6f-6d6a-7cc0-98d2-000000000102")
  const tracker = makeConnectionDetailTracker()
  tracker.reconcile([a, b])
  tracker.failed(a.pluginConnectionId)
  expect(tracker.reconcile([{ ...a }, { ...b }]).changed).toEqual([a])
  expect(tracker.reconcile([{ ...b }, { ...a }]).changed).toEqual([])
})
