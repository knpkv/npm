import { expect } from "@playwright/test"

import { test } from "./visualRuntimeFixture.js"

/** HTTP pairing exercises timeout scheduling: spreading ClockImpl silently loses its prototype sleep method. */
test("fixed clock preserves API pairing scheduling", async ({ request, visualRuntime }) => {
  const response = await request.post(`${visualRuntime.origin}/api/v1/session/pair`, {
    headers: { origin: visualRuntime.origin },
    data: { pairingCode: await visualRuntime.issuePairingCode() }
  })
  expect(response.status(), visualRuntime.applicationLogEntries().join("\n")).toBe(200)
  expect(await response.json()).toMatchObject({
    session: {
      workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001",
      createdAt: "2026-07-14T12:00:00.000Z"
    }
  })
})
