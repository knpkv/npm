import { expect, test as playwright } from "@playwright/test"
import * as Schema from "effect/Schema"

import { PairSessionResponse } from "../../src/api/session.js"
import { setupSixVerdicts } from "./overviewSetup.js"
import { test } from "./visualRuntimeFixture.js"

/** No browser is needed to prove the real producer consumes the fixture wire data. */
test("six first-party verdicts are server-authoritative without seeding readiness", async ({ request, visualRuntime }) => {
  const paired = await request.post(`${visualRuntime.origin}/api/v1/session/pair`, {
    headers: { origin: visualRuntime.origin },
    data: { pairingCode: await visualRuntime.issuePairingCode() }
  })
  expect(paired.ok()).toBe(true)
  const { csrfToken } = Schema.decodeUnknownSync(PairSessionResponse)(await paired.json())
  const snapshot = await setupSixVerdicts({ request, csrfToken }, visualRuntime)
  expect(snapshot.releases).toHaveLength(6)
  expect(snapshot.releases.every((release) => release.freshness._tag === "current")).toBe(true)
  expect(
    snapshot.releases.map((release) => ({
      version: release.version,
      build: release.readiness?.stages.build.state,
      verify: release.readiness?.stages.verify.state,
      production: release.readiness?.stages.production.state
    })).sort((left, right) => left.version.localeCompare(right.version))
  ).toEqual([
    { version: "1.0.1", build: "failed", verify: "held", production: "not-started" },
    { version: "1.0.2", build: "succeeded", verify: "passed", production: "not-started" },
    { version: "1.0.3", build: "succeeded", verify: "passed", production: "deploying" },
    { version: "1.0.4", build: "running", verify: "held", production: "not-started" },
    { version: "1.0.5", build: "succeeded", verify: "passed", production: "succeeded" },
    { version: "1.0.6", build: "succeeded", verify: "held", production: "not-started" }
  ])
  await playwright.info().attach("six-verdict-projection", {
    body: JSON.stringify(
      snapshot.releases.map((release) => ({
        version: release.version,
        verdict: release.readiness?.verdict,
        stages: release.readiness?.stages,
        collaborators: release.collaborators,
        relationships: release.relationships,
        freshness: release.freshness._tag
      })),
      null,
      2
    ),
    contentType: "application/json"
  })
})
