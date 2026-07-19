import { expect } from "@playwright/test"
import * as Schema from "effect/Schema"

import {
  CONTROL_CENTER_BENCHMARK_CAPS,
  CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
  CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
} from "../scripts/benchmarkHarness.js"
import { ControlCenterRuntimeBenchmarkReport } from "../scripts/benchmarkRuntimeReport.js"
import { ControlCenterLiveEvent } from "../src/api/liveEvents.js"
import { PortfolioSnapshot } from "../src/api/portfolio.js"
import { test } from "./realRuntimeFixture.js"
import {
  INITIAL_RELEASE_VERSION,
  REAL_RELEASE_ID,
  REAL_WORKSPACE_ID,
  UPDATED_RELEASE_VERSION
} from "./realRuntimeScenario.js"

test.describe("repository-managed real runtime", () => {
  test("pairs, reconnects its live stream, applies a plugin update, and preserves full release routes", async ({ page, realRuntime }) => {
    test.setTimeout(30_000)
    await page.addInitScript(`
      window.__controlCenterStylePolicyViolations = [];
      addEventListener("securitypolicyviolation", (event) => {
        if (event.violatedDirective.startsWith("style-src")) {
          window.__controlCenterStylePolicyViolations.push(event.violatedDirective);
        }
      });
    `)
    let eventStreamRequests = 0
    await page.route(`${realRuntime.origin}/api/v1/events**`, async (route) => {
      eventStreamRequests += 1
      if (eventStreamRequests === 1) {
        await route.abort("connectionrefused")
        return
      }
      await route.continue()
    })

    const documentResponse = await page.goto(`${realRuntime.origin}/services`)
    const contentSecurityPolicy = documentResponse?.headers()["content-security-policy"] ?? ""
    expect(contentSecurityPolicy).toContain("script-src 'self'")
    expect(contentSecurityPolicy).toContain("style-src 'self'")
    expect(contentSecurityPolicy).toContain("style-src-attr 'unsafe-inline'")
    expect(contentSecurityPolicy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(
      await page.evaluate<string>(`(() => {
        const probe = document.createElement("div");
        probe.style.inlineSize = "37px";
        document.body.append(probe);
        const inlineSize = getComputedStyle(probe).inlineSize;
        probe.remove();
        return inlineSize;
      })()`)
    ).toBe("37px")
    await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible()
    await expect(
      page.getByText(
        "Choose a service below. Control Center will enable it and verify the exact account before using it."
      )
    ).toBeVisible()
    await expect(page.getByRole("article")).toHaveCount(5)
    await expect(page.getByRole("button", { name: "Pair to enable" })).toHaveCount(5)

    await realRuntime.pairThroughUi(page)
    await expect(page).toHaveURL(`${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/overview`)
    await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeVisible()
    await expect(page.getByText(INITIAL_RELEASE_VERSION, { exact: true })).toBeVisible()
    await expect.poll(() => eventStreamRequests).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole("status").getByText("Live", { exact: true })).toBeVisible()

    await realRuntime.synchronizeUpdate()
    await expect(page.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    await expect(page.getByText(INITIAL_RELEASE_VERSION, { exact: true })).toHaveCount(0)

    await page.getByRole("link", { name: "Services" }).click()
    await expect(page).toHaveURL(`${realRuntime.origin}/services`)
    await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible()
    await expect(page.getByRole("article")).toHaveCount(6)
    for (const service of ["CodeCommit", "CodePipeline", "Runtime Jira", "Confluence", "Clockify"]) {
      await expect(page.getByRole("heading", { level: 2, name: service })).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Configure AWS account" })).toHaveCount(2)
    await expect(page.getByRole("button", { name: "Configure Atlassian" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Add Jira project" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Enable service" })).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Test connection" })).toBeVisible()
    const jiraService = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Runtime Jira" }) })
    await jiraService.getByRole("button", { name: "Disable" }).click()
    await expect(jiraService.getByText("Disabled", { exact: true })).toBeVisible()
    await jiraService.getByRole("button", { name: "Enable service" }).click()
    await expect(jiraService.getByText("Unavailable", { exact: true })).toBeVisible()
    await expect(jiraService.getByText("The provider is currently unavailable.", { exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Overview" }).click()
    await expect(page).toHaveURL(`${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/overview`)

    await page.getByRole("button", { name: /^Preview /u }).click()
    await expect(page).toHaveURL(`${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/releases/${REAL_RELEASE_ID}/preview`)
    const preview = page.getByRole("dialog")
    await expect(preview).toBeVisible()
    await expect(preview.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    await preview.getByRole("button", { name: /^Open .+ full view$/u }).click()

    const fullReleaseUrl = `${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/releases/${REAL_RELEASE_ID}`
    await expect(page).toHaveURL(fullReleaseUrl)
    await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
    await expect(page.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    for (let refresh = 0; refresh < 2; refresh += 1) {
      await page.reload()
      await expect(page).toHaveURL(fullReleaseUrl)
      await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
      await expect(page.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    }
    expect(
      await page.evaluate<ReadonlyArray<string>>(
        "window.__controlCenterStylePolicyViolations"
      )
    ).toEqual([])
  })

  test("measures warmed authenticated portfolio HTTP and a bounded 500-event SSE tail in one owned context", async ({
    browser,
    realRuntime
  }, testInfo) => {
    test.setTimeout(180_000)
    expect(browser.contexts()).toHaveLength(0)
    const context = await browser.newContext()
    expect(browser.contexts()).toHaveLength(CONTROL_CENTER_BENCHMARK_CAPS.browserContexts)
    const page = await context.newPage()

    await realRuntime.pairThroughUi(page)
    const persistence = await realRuntime.seedBenchmarkPersistence()
    const portfolioRuns = await page.evaluate(
      async ({ requests, warmupRuns }) => {
        const payloads: Array<unknown> = []
        const samplesMilliseconds: Array<number> = []
        for (let run = 0; run < requests; run += 1) {
          const startedAt = performance.now()
          const response = await fetch("/api/v1/portfolio/snapshot", {
            credentials: "same-origin",
            headers: { accept: "application/json" }
          })
          if (!response.ok) throw new Error(`portfolio benchmark request failed with ${response.status}`)
          payloads.push(await response.json())
          const completedAt = performance.now()
          if (run >= warmupRuns) samplesMilliseconds.push(completedAt - startedAt)
        }
        return { payloads, samplesMilliseconds }
      },
      {
        requests: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS + CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
        warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
      }
    )
    const portfolios = portfolioRuns.payloads.map((payload) => Schema.decodeUnknownSync(PortfolioSnapshot)(payload))
    expect(portfolios).toHaveLength(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS + CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS)
    for (const portfolio of portfolios) {
      expect(portfolio.releases).toHaveLength(100)
      expect(portfolio.eventCursor).toBe(20_000)
    }

    await page.goto(`${realRuntime.origin}/services`)
    const after = persistence.persistedEvents - CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents
    const sseRuns = await page.evaluate(
      async ({ count, cursor, requests, warmupRuns }) => {
        const replayOnce = () =>
          new Promise<Array<{ readonly data: string; readonly event: string; readonly id: string }>>(
            (resolve, reject) => {
              const source = new EventSource(`/api/v1/events?after=${cursor}`)
              const events: Array<{ readonly data: string; readonly event: string; readonly id: string }> = []
              source.addEventListener("portfolio.invalidated", (event) => {
                const data = "data" in event ? event.data : undefined
                const lastEventId = "lastEventId" in event ? event.lastEventId : undefined
                if (typeof data !== "string" || typeof lastEventId !== "string") {
                  source.close()
                  reject(new Error("benchmark SSE event did not expose its encoded data and cursor"))
                  return
                }
                events.push({ data, event: event.type, id: lastEventId })
                if (events.length === count) {
                  source.close()
                  resolve(events)
                }
              })
              source.onerror = () => {
                source.close()
                reject(new Error("benchmark SSE stream failed before its bounded tail completed"))
              }
            }
          )
        let rawEvents: Array<{ readonly data: string; readonly event: string; readonly id: string }> = []
        const samplesMilliseconds: Array<number> = []
        for (let run = 0; run < requests; run += 1) {
          const startedAt = performance.now()
          rawEvents = await replayOnce()
          const completedAt = performance.now()
          if (run >= warmupRuns) samplesMilliseconds.push(completedAt - startedAt)
        }
        return { rawEvents, samplesMilliseconds }
      },
      {
        count: CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents,
        cursor: after,
        requests: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS + CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
        warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
      }
    )
    const decodedEvents = sseRuns.rawEvents.map((event) => Schema.decodeUnknownSync(ControlCenterLiveEvent)(event))
    expect(decodedEvents).toHaveLength(CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents)
    const cursors = decodedEvents.map((event) => event.id)
    expect(cursors).toStrictEqual(
      Array.from({ length: CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents }, (_, index) => after + index + 1)
    )
    const sseFirstCursor = cursors[0]
    const sseLastCursor = cursors[cursors.length - 1]
    if (sseFirstCursor === undefined || sseLastCursor === undefined) {
      throw new Error("benchmark SSE replay did not contain its required bounded tail")
    }

    await context.close()
    expect(browser.contexts()).toHaveLength(0)
    const beforeDispose = realRuntime.lifecycleEvidence()
    expect(beforeDispose.activeManagedServers).toBe(1)
    await realRuntime.dispose()
    const afterDispose = realRuntime.lifecycleEvidence()
    const { outputPath, report } = await realRuntime.writeBenchmarkReport({
      browserContextsAfterClose: browser.contexts().length,
      browserContextsPeak: 1,
      freshIngestionMilliseconds: persistence.freshIngestionMilliseconds,
      generatedEdges: persistence.generatedEdges,
      generatedFiles: persistence.generatedFiles,
      managedServersAfterDispose: afterDispose.activeManagedServers,
      managedServersPeak: beforeDispose.activeManagedServers,
      persistedEntities: persistence.persistedEntities,
      persistedEvents: persistence.persistedEvents,
      persistedReleases: persistence.persistedReleases,
      portfolioHttpRequests: portfolios.length,
      portfolioSamplesMilliseconds: portfolioRuns.samplesMilliseconds,
      sseDecodedEvents: decodedEvents.length,
      sseFirstCursor,
      sseLastCursor,
      sseOrdered: true,
      sseReplayRequests: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS + CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
      sseSamplesMilliseconds: sseRuns.samplesMilliseconds
    })

    expect(report.cardinalities.persistedReleases).toBe(100)
    expect(report.cardinalities.persistedEntities).toBe(2_000)
    expect(report.cardinalities.persistedEvents).toBe(20_000)
    expect(report.cardinalities.generatedEdges).toBe(10_000)
    expect(report.cardinalities.generatedFiles).toBe(500)
    expect(report.measurements.portfolio.timing.samplesMilliseconds).toHaveLength(5)
    expect(report.measurements.sse.timing.samplesMilliseconds).toHaveLength(5)
    expect(report.timingIsAcceptanceAssertion).toBe(false)
    expect(outputPath).not.toHaveLength(0)
    expect(afterDispose.disposedManagedServers).toBe(1)
    await testInfo.attach("control-center-runtime-benchmark.json", {
      body: JSON.stringify(Schema.encodeSync(ControlCenterRuntimeBenchmarkReport)(report), undefined, 2),
      contentType: "application/json"
    })
  })
})
