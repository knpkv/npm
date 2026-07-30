import { type Browser, type BrowserContext, expect } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS } from "../scripts/benchmarkFixture.js"
import {
  CONTROL_CENTER_BENCHMARK_CAPS,
  CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
  CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
} from "../scripts/benchmarkHarness.js"
import { ControlCenterRuntimeBenchmarkReport } from "../scripts/benchmarkRuntimeReport.js"
import { ControlCenterLiveEvent } from "../src/api/liveEvents.js"
import { PortfolioSnapshot } from "../src/api/portfolio.js"
import { DEFAULT_REQUEST_LIMIT_POLICY } from "../src/server/api/RequestLimits.js"
import {
  type ApplicationLogSurface,
  exposedApplicationLogForbiddenValues,
  serializeApplicationConsoleMessage
} from "./applicationLogSurface.js"
import {
  type BrowserSecretSurface,
  browserSurfaceExposesSecret,
  exposedBrowserForbiddenValues,
  snapshotBrowserReadableSurface
} from "./browserSecretSurface.js"
import { startRealRuntimeFixture, test, validateBenchmarkReleaseCardinality } from "./realRuntimeFixture.js"
import {
  INITIAL_RELEASE_VERSION,
  REAL_RELEASE_ID,
  REAL_WORKSPACE_ID,
  UPDATED_RELEASE_VERSION
} from "./realRuntimeScenario.js"

const EXPECTED_TRUSTED_HTTPS_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'self'",
    "upgrade-insecure-requests"
  ].join("; "),
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "accelerometer=(), bluetooth=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} satisfies Readonly<Record<string, string>>

const withOwnedBrowserContext = async <Result>(
  browser: Browser,
  use: (context: BrowserContext, close: () => Promise<void>) => Promise<Result>
): Promise<Result> => {
  const context = await browser.newContext()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    await context.close()
    closed = true
  }
  try {
    return await use(context, close)
  } finally {
    await close()
  }
}

test.describe("repository-managed real runtime", () => {
  test("rejects one extra durable release before constructing benchmark evidence", async () => {
    expect(
      await Effect.runPromise(
        validateBenchmarkReleaseCardinality(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
      )
    ).toBe(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
    await expect(
      Effect.runPromise(
        validateBenchmarkReleaseCardinality(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases + 1)
      )
    ).rejects.toMatchObject({ _tag: "BenchmarkInvariantError" })
  })

  test("closes an owned benchmark context when setup fails immediately", async ({ browser }) => {
    expect(browser.contexts()).toHaveLength(0)
    await expect(
      withOwnedBrowserContext(browser, async () => {
        expect(browser.contexts()).toHaveLength(1)
        throw new Error("injected benchmark setup failure")
      })
    ).rejects.toThrow("injected benchmark setup failure")
    expect(browser.contexts()).toHaveLength(0)
  })

  test("pairs from a second machine through the documented trusted HTTPS proxy", async ({ browser }) => {
    test.setTimeout(60_000)
    const fixture = await startRealRuntimeFixture({ trustedHttpsProxy: true })
    try {
      const context = await browser.newContext({
        extraHTTPHeaders: {
          "x-forwarded-for": "203.0.113.90",
          "x-forwarded-host": "hostile.example",
          "x-forwarded-proto": "http"
        },
        ignoreHTTPSErrors: true
      })
      try {
        const page = await context.newPage()
        const browserConsoleEntries: Array<string> = []
        const browserConsoleCaptures: Array<Promise<void>> = []
        page.on("console", (message) => {
          browserConsoleCaptures.push(
            serializeApplicationConsoleMessage(page, message, fixture.origin).then((entry) => {
              if (entry !== null) browserConsoleEntries.push(entry)
            })
          )
        })
        const response = await page.goto(`${fixture.origin}/services`)
        expect(response?.status()).toBe(200)
        const headers = response?.headers() ?? {}
        for (const [name, expectedValue] of Object.entries(EXPECTED_TRUSTED_HTTPS_SECURITY_HEADERS)) {
          expect(headers[name]).toBe(expectedValue)
        }
        expect(headers["content-security-policy"]).toContain("upgrade-insecure-requests")
        expect(headers["strict-transport-security"]).toBe("max-age=31536000")
        await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible()

        const { consumedPairingCode } = await fixture.pairThroughUi(page)
        await expect(page).toHaveURL(`${fixture.origin}/w/${REAL_WORKSPACE_ID}/overview`)
        await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeVisible()

        const sessionCookie = (await context.cookies()).find(({ name }) => name === "cc_session")
        if (sessionCookie === undefined) throw new Error("trusted HTTPS pairing did not issue its session cookie")
        expect(sessionCookie).toMatchObject({
          httpOnly: true,
          sameSite: "Strict",
          secure: true
        })
        const browserSurface: BrowserSecretSurface = await snapshotBrowserReadableSurface(
          page,
          await context.cookies()
        )
        expect(
          exposedBrowserForbiddenValues(browserSurface, [
            { label: "HttpOnly session cookie", value: sessionCookie.value },
            { label: "consumed pairing code", value: consumedPairingCode }
          ])
        ).toEqual([])
        const csrfProof = await page.evaluate<string | null>(`sessionStorage.getItem("cc_csrf")`)
        if (csrfProof === null) throw new Error("trusted HTTPS pairing did not expose its browser-owned CSRF proof")
        expect(browserSurfaceExposesSecret(browserSurface, csrfProof)).toBe(true)
        await page.evaluate(`console.info("ordinary browser diagnostic [REDACTED]")`)
        await fixture.emitApplicationLogFixture("ordinary managed-runtime diagnostic [REDACTED]")
        const applicationLogs = async (): Promise<ApplicationLogSurface> => {
          await Promise.all([...browserConsoleCaptures])
          return {
            browserConsole: [...browserConsoleEntries],
            managedRuntime: fixture.applicationLogEntries()
          }
        }
        expect(
          exposedApplicationLogForbiddenValues(await applicationLogs(), [
            { label: "HttpOnly session cookie", value: sessionCookie.value },
            { label: "consumed pairing code", value: consumedPairingCode }
          ])
        ).toEqual([])

        const browserLogFixtureSecret = "browser-console-forbidden-fixture"
        const nestedBrowserLogFixtureSecret = "nested-browser-console-forbidden-fixture"
        const longBrowserLogFixtureSecret = "long-browser-console-forbidden-fixture"
        const managedRuntimeLogFixtureSecret = "managed-runtime-log-forbidden-fixture"
        await page.evaluate(() => console.info("ordinary browser diagnostic ".repeat(800)))
        await page.evaluate(() => console.info(`${"ordinary browser diagnostic ".repeat(800)} [REDACTED]`))
        await page.evaluate(`console.info(${JSON.stringify(browserLogFixtureSecret)})`)
        await page.evaluate(
          `console.info({ auth: { token: ${JSON.stringify(nestedBrowserLogFixtureSecret)} } })`
        )
        await page.evaluate(
          (secret) => console.info(`${"x".repeat(17_000)}${secret}`),
          longBrowserLogFixtureSecret
        )
        await fixture.emitApplicationLogFixture(managedRuntimeLogFixtureSecret)
        expect(
          exposedApplicationLogForbiddenValues(await applicationLogs(), [
            { label: "browser console fixture", value: browserLogFixtureSecret },
            { label: "nested browser console fixture", value: nestedBrowserLogFixtureSecret },
            { label: "long browser console fixture", value: longBrowserLogFixtureSecret },
            { label: "managed runtime fixture", value: managedRuntimeLogFixtureSecret }
          ])
        ).toEqual([
          "browser console fixture",
          "nested browser console fixture",
          "long browser console fixture",
          "managed runtime fixture"
        ])

        const indexedDbFixtureSecret = "indexed-db-forbidden-fixture"
        const cacheStorageFixtureSecret = "cache-storage-forbidden-fixture"
        const cacheStorageRequestHeaderFixtureSecret = "cache-storage-request-header-forbidden-fixture"
        const cacheStorageResponseHeaderFixtureSecret = "cache-storage-response-header-forbidden-fixture"
        await page.evaluate(`(async () => {
          const indexedDbSecret = ${JSON.stringify(indexedDbFixtureSecret)};
          const cacheStorageSecret = ${JSON.stringify(cacheStorageFixtureSecret)};
          const cacheStorageRequestHeaderSecret = ${JSON.stringify(cacheStorageRequestHeaderFixtureSecret)};
          const cacheStorageResponseHeaderSecret = ${JSON.stringify(cacheStorageResponseHeaderFixtureSecret)};
          await new Promise((resolve, reject) => {
            const open = indexedDB.open("browser-secret-surface-fixture", 1);
            open.addEventListener(
              "upgradeneeded",
              () => open.result.createObjectStore("records"),
              { once: true }
            );
            open.addEventListener(
              "success",
              () => {
                const database = open.result;
                const transaction = database.transaction("records", "readwrite");
                transaction.objectStore("records").put({ token: indexedDbSecret }, "credential");
                transaction.addEventListener(
                  "complete",
                  () => {
                    database.close();
                    resolve();
                  },
                  { once: true }
                );
                transaction.addEventListener("error", () => reject(transaction.error), { once: true });
              },
              { once: true }
            );
            open.addEventListener("error", () => reject(open.error), { once: true });
          });
          const cache = await caches.open("browser-secret-surface-fixture");
          await cache.put(
            new Request(location.origin + "/browser-secret-surface-fixture", {
              headers: { authorization: cacheStorageRequestHeaderSecret }
            }),
            new Response(cacheStorageSecret, {
              headers: { "x-session-token": cacheStorageResponseHeaderSecret }
            })
          );
        })()`)
        try {
          const fixtureSurface = await snapshotBrowserReadableSurface(page, await context.cookies())
          expect(
            exposedBrowserForbiddenValues(fixtureSurface, [
              { label: "IndexedDB fixture", value: indexedDbFixtureSecret },
              { label: "Cache Storage fixture", value: cacheStorageFixtureSecret },
              { label: "Cache Storage request header fixture", value: cacheStorageRequestHeaderFixtureSecret },
              { label: "Cache Storage response header fixture", value: cacheStorageResponseHeaderFixtureSecret }
            ])
          ).toEqual([
            "IndexedDB fixture",
            "Cache Storage fixture",
            "Cache Storage request header fixture",
            "Cache Storage response header fixture"
          ])
        } finally {
          await page.evaluate(`(async () => {
            await caches.delete("browser-secret-surface-fixture");
            await new Promise((resolve, reject) => {
              const deletion = indexedDB.deleteDatabase("browser-secret-surface-fixture");
              deletion.addEventListener("success", () => resolve(), { once: true });
              deletion.addEventListener("error", () => reject(deletion.error), { once: true });
              deletion.addEventListener(
                "blocked",
                () => reject(new Error("fixture database deletion blocked")),
                { once: true }
              );
            });
          })()`)
        }

        const requestAsProxyClient = async (client: "rate-limit-a" | "rate-limit-b"): Promise<number> => {
          const response = await context.request.get(`${fixture.origin}/api/v1/session/current`, {
            headers: { "x-control-center-test-proxy-client": client }
          })
          const status = response.status()
          await response.dispose()
          return status
        }
        let firstClientExhausted = false
        for (let request = 0; request < DEFAULT_REQUEST_LIMIT_POLICY.read.limit * 2; request += 1) {
          const status = await requestAsProxyClient("rate-limit-a")
          if (status === 429) {
            firstClientExhausted = true
            break
          }
          expect(status).toBe(200)
        }
        expect(firstClientExhausted).toBe(true)
        expect(await requestAsProxyClient("rate-limit-b")).toBe(200)
      } finally {
        await context.close()
      }
    } finally {
      await fixture.dispose()
    }
    expect(fixture.lifecycleEvidence()).toEqual({
      activeManagedServers: 0,
      disposedManagedServers: 1
    })
  })

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
    await expect(
      jiraService.getByRole("status").getByText("The provider is currently unavailable.", { exact: true })
    ).toBeVisible()
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
    expect(await page.evaluate<ReadonlyArray<string>>("window.__controlCenterStylePolicyViolations")).toEqual([])
  })

  test("measures warmed authenticated portfolio HTTP and a bounded 500-event SSE tail in one owned context", async ({
    browser,
    realRuntime
  }, testInfo) => {
    test.setTimeout(180_000)
    expect(browser.contexts()).toHaveLength(0)
    await withOwnedBrowserContext(browser, async (context, closeContext) => {
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

      await closeContext()
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
      expect(report.timingAcceptance.budgetMilliseconds).toBe(2_000)
      expect(report.timingIsAcceptanceAssertion).toBe(report.timingAcceptance.eligible)
      expect(outputPath).not.toHaveLength(0)
      expect(afterDispose.disposedManagedServers).toBe(1)
      await testInfo.attach("control-center-runtime-benchmark.json", {
        body: JSON.stringify(Schema.encodeSync(ControlCenterRuntimeBenchmarkReport)(report), undefined, 2),
        contentType: "application/json"
      })
    })
  })
})
