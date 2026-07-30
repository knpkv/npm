import { expect, type Locator, test } from "@playwright/test"
import {
  auditProductionRoutePresentation,
  CONTROL_CENTER_AXE_WCAG_TAGS,
  seriousAxeViolations
} from "./presentationAudit.js"
import {
  productionRouteAuditCase,
  productionRouteAuditKey,
  type ProductionRouteAuditRequirement,
  requiredProductionRouteAuditsFor
} from "./productionRouteInventory.js"
import { releasePortfolioFixture } from "./releasePortfolioFixture.js"

const pairedSession = {
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  createdAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000002",
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
}

interface UnauthenticatedPresentationRoute {
  readonly audit: ProductionRouteAuditRequirement
  readonly exercise?: (primaryAction: Locator) => Promise<void>
  readonly expectOutcome?: () => Promise<void>
  readonly landmark: () => Locator
  readonly primaryAction: () => Locator | null
}

test("includes WCAG 2.1 A label-content matching in the serious accessibility gate", async ({ page }) => {
  expect(CONTROL_CENTER_AXE_WCAG_TAGS).toContain("wcag21a")
  await page.setContent("<button aria-label=\"Remove\">Delete</button>")
  expect(await seriousAxeViolations(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "label-content-name-mismatch" })])
  )

  await page.setContent("<button aria-label=\"Delete item\">Delete</button>")
  expect((await seriousAxeViolations(page)).map(({ id }) => id)).not.toContain("label-content-name-mismatch")
})

test("explicitly enables the WCAG 2.2 AA target-size rule", async ({ page }) => {
  expect(CONTROL_CENTER_AXE_WCAG_TAGS).toContain("wcag22aa")
  await page.setContent(`
    <main>
      <button style="box-sizing: border-box; height: 20px; padding: 0; width: 20px;">A</button><button
        style="box-sizing: border-box; height: 20px; padding: 0; width: 20px;"
      >B</button>
    </main>
  `)
  expect(await seriousAxeViolations(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "target-size" })])
  )

  await page.setContent(`
    <main>
      <button style="box-sizing: border-box; height: 24px; padding: 0; width: 24px;">A</button><button
        style="box-sizing: border-box; height: 24px; padding: 0; width: 24px;"
      >B</button>
    </main>
  `)
  expect((await seriousAxeViolations(page)).map(({ id }) => id)).not.toContain("target-size")
})

test("requires keyboard focus to add a visible indicator", async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Focus fixture</title>
        <style>button { box-shadow: 0 0 0 2px currentColor; outline: none; }</style>
      </head>
      <body><main><h1>Focus fixture</h1><button>Continue</button></main></body>
    </html>
  `)
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Focus fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("primary action keyboard focus has no focus-specific visual indicator")

  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Focus fixture</title>
        <style>
          body { background: white; }
          button { background: transparent; border: 0; color: black; outline: none; }
          button:focus-visible { background: white; }
        </style>
      </head>
      <body><main><h1>Focus fixture</h1><button>Continue</button></main></body>
    </html>
  `)
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Focus fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("primary action keyboard focus has no focus-specific visual indicator")

  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Focus fixture</title>
        <style>
          body { background: white; }
          button { background: white; border: 0; color: black; outline: none; }
          button:focus-visible { color: white; }
        </style>
      </head>
      <body><main><h1>Focus fixture</h1><button>Continue</button></main></body>
    </html>
  `)
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Focus fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("primary action keyboard focus has no focus-specific visual indicator")

  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Focus fixture</title>
        <style>
          body { background: white; }
          button { background: transparent; border: 0; color: black; outline: none; }
          button:focus-visible { background: black; color: white; }
          @media (forced-colors: active) {
            button:focus-visible { outline: 3px solid CanvasText; outline-offset: 2px; }
          }
        </style>
      </head>
      <body>
        <main><h1>Focus fixture</h1><button onclick="this.textContent='Continued'">Continue</button></main>
      </body>
    </html>
  `)
  await auditProductionRoutePresentation(page, {
    exercise: async (primaryAction) => primaryAction.press("Enter"),
    expectOutcome: async () => expect(page.getByRole("button", { name: "Continued" })).toBeVisible(),
    landmark: page.getByRole("heading", { name: "Focus fixture" }),
    primaryAction: page.getByRole("button", { name: "Continue" })
  })

  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Focus fixture</title>
        <style>
          button { outline: none; }
          button:focus-visible { outline: 3px solid transparent; }
        </style>
      </head>
      <body><main><h1>Focus fixture</h1><button>Continue</button></main></body>
    </html>
  `)
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Focus fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("primary action keyboard focus has no focus-specific visual indicator")

  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Focus fixture</title>
        <style>
          button { outline: none; }
          button:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
        </style>
      </head>
      <body>
        <main><h1>Focus fixture</h1><button onclick="this.textContent='Continued'">Continue</button></main>
      </body>
    </html>
  `)
  await auditProductionRoutePresentation(page, {
    exercise: async (primaryAction) => primaryAction.press("Enter"),
    expectOutcome: async () => expect(page.getByRole("button", { name: "Continued" })).toBeVisible(),
    landmark: page.getByRole("heading", { name: "Focus fixture" }),
    primaryAction: page.getByRole("button", { name: "Continue" })
  })
})

test("reruns the serious accessibility gate after compact-layout content appears", async ({ page }) => {
  const content = (mobileAccessibleName: string): string => `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Compact fixture</title>
        <style>
          button:focus-visible { outline: 3px solid currentColor; }
          .mobile-only { display: none; }
          @media (max-width: 400px) { .mobile-only { display: inline-block; } }
        </style>
      </head>
      <body>
        <main>
          <h1>Compact fixture</h1>
          <button onclick="this.textContent='Continued'">Continue</button>
          <button class="mobile-only"${mobileAccessibleName}></button>
        </main>
      </body>
    </html>
  `
  await page.setContent(content(""))
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Compact fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("compact layout has serious or critical accessibility violations")

  await page.setContent(content(" aria-label=\"Open mobile navigation\""))
  await auditProductionRoutePresentation(page, {
    exercise: async (primaryAction) => primaryAction.press("Enter"),
    expectOutcome: async () => expect(page.getByRole("button", { name: "Continued" })).toBeVisible(),
    landmark: page.getByRole("heading", { name: "Compact fixture" }),
    primaryAction: page.getByRole("button", { name: "Continue" })
  })
})

test("requires discernible system paint in forced-colors mode", async ({ page }) => {
  const content = (forcedColorPaint: string): string => `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Forced color fixture</title>
        <style>
          button:focus-visible { outline: 3px solid currentColor; }
          @media (forced-colors: active) {
            button {
              forced-color-adjust: none;
              ${forcedColorPaint}
            }
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Forced color fixture</h1>
          <button onclick="this.textContent='Continued'">Continue</button>
        </main>
      </body>
    </html>
  `
  await page.setContent(
    content(
      "background: transparent; border-color: transparent; color: transparent; outline-color: transparent;"
    )
  )
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Forced color fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("primary action has no discernible forced-color paint")

  await page.setContent(content("background: Canvas; border-color: Canvas; color: Canvas; outline-color: Canvas;"))
  await expect(
    auditProductionRoutePresentation(page, {
      exercise: async () => {},
      expectOutcome: async () => {},
      landmark: page.getByRole("heading", { name: "Forced color fixture" }),
      primaryAction: page.getByRole("button", { name: "Continue" })
    })
  ).rejects.toThrow("primary action has no discernible forced-color paint")

  await page.setContent(content("background: Canvas; border-color: CanvasText; color: CanvasText;"))
  await auditProductionRoutePresentation(page, {
    exercise: async (primaryAction) => primaryAction.press("Enter"),
    expectOutcome: async () => expect(page.getByRole("button", { name: "Continued" })).toBeVisible(),
    landmark: page.getByRole("heading", { name: "Forced color fixture" }),
    primaryAction: page.getByRole("button", { name: "Continue" })
  })
})

test("audits every public route family for keyboard, WCAG, reflow, forced colors, and reduced motion", async ({ context, page }) => {
  test.setTimeout(60_000)
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "UnauthorizedApiError",
        code: "unauthorized",
        correlationId: "public-route-presentation-audit",
        message: "No active session"
      }),
      contentType: "application/json",
      status: 401
    })
  })
  const routes: ReadonlyArray<UnauthenticatedPresentationRoute> = [
    {
      audit: productionRouteAuditCase("scaffold", "overview", "unauthenticated", "<index>"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByRole("heading", { name: "Every release. One view." }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "overview", "unauthenticated", "overview"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByText("Release facts stay private", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "services", "unauthenticated", "services"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByRole("heading", { name: "Services" }),
      primaryAction: () => page.getByRole("button", { name: "Pair to enable" }).first()
    },
    {
      audit: productionRouteAuditCase("scaffold", "pair", "unauthenticated", "pair"),
      exercise: async () => page.getByRole("textbox", { name: "Pairing code" }).fill("presentation-audit"),
      expectOutcome: async () =>
        expect(page.getByRole("textbox", { name: "Pairing code" })).toHaveValue("presentation-audit"),
      landmark: () => page.getByRole("heading", { name: "Pair this browser" }),
      primaryAction: () => page.getByRole("textbox", { name: "Pairing code" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "agent", "unauthenticated", "agent"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Every release. One view." })).toBeVisible(),
      landmark: () => page.getByRole("heading", { name: "Ask in context." }),
      primaryAction: () => page.getByRole("link", { name: "Return to Overview" })
    },
    {
      audit: productionRouteAuditCase(
        "scaffold",
        "agent",
        "unauthenticated",
        "releases/:releaseId/agent"
      ),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByText("Release context unavailable", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase(
        "scaffold",
        "atlassian-oauth-callback",
        "unauthenticated",
        "services/oauth/atlassian/callback"
      ),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Services" })).toBeVisible(),
      landmark: () => page.getByText("Paired session required", { exact: true }),
      primaryAction: () => page.getByRole("button", { name: "Return to Services" })
    },
    {
      audit: productionRouteAuditCase(
        "scaffold",
        "authorized-share",
        "unauthenticated",
        "shares/:workspaceId/:shareId"
      ),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByText("Authentication required", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "items", "unauthenticated", "items"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByText("Release facts stay private", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "item", "unauthenticated", "items/:entityId"),
      expectOutcome: async () => expect(page.getByText("Release facts stay private", { exact: true })).toBeVisible(),
      landmark: () => page.getByText("Entity unavailable", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Back to items" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "release", "unauthenticated", "releases/:releaseId"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByText("Release facts stay private", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase(
        "scaffold",
        "release-preview",
        "unauthenticated",
        "releases/:releaseId/preview"
      ),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible(),
      landmark: () => page.getByText("Release facts stay private", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Pair this browser" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "not-found", "unauthenticated", "*"),
      expectOutcome: async () => expect(page.getByRole("heading", { name: "Every release. One view." })).toBeVisible(),
      landmark: () => page.getByText("Page not found", { exact: true }),
      primaryAction: () => page.getByRole("link", { name: "Return to Control Center" })
    },
    {
      audit: productionRouteAuditCase("scaffold", "settings", "unauthenticated", "settings"),
      landmark: () => page.getByText("Authentication required", { exact: true }),
      primaryAction: () => null
    },
    {
      audit: productionRouteAuditCase("scaffold", "timeline", "unauthenticated", "timeline"),
      landmark: () => page.getByText("Loading Timeline", { exact: true }),
      primaryAction: () => null
    },
    {
      audit: productionRouteAuditCase("scaffold", "work", "unauthenticated", "work"),
      landmark: () => page.getByText("Release facts stay private", { exact: true }),
      primaryAction: () => null
    }
  ]

  for (const route of routes) {
    await page.goto(route.audit.canonicalPath)
    const primaryAction = route.primaryAction()
    if (primaryAction === null) {
      if (route.audit.action.kind !== "none") throw new Error(`${route.audit.family} requires a primary action`)
      await auditProductionRoutePresentation(page, {
        landmark: route.landmark(),
        noActionReason: route.audit.action.reason,
        primaryAction
      })
    } else {
      if (route.expectOutcome === undefined) throw new Error(`${route.audit.family} requires an interaction outcome`)
      await auditProductionRoutePresentation(page, {
        exercise: route.exercise ?? (async (action) => action.press("Enter")),
        expectOutcome: route.expectOutcome,
        landmark: route.landmark(),
        primaryAction
      })
    }
  }

  await context.unroute("**/api/v1/session/current")
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken: "cd".repeat(32), session: pairedSession }),
      contentType: "application/json",
      status: 200
    })
  })
  await context.route("**/api/v1/agent/providers", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ providers: [] }),
      contentType: "application/json",
      status: 200
    })
  })
  const authenticatedAgent = {
    audit: productionRouteAuditCase("scaffold", "agent", "authenticated", "agent"),
    landmark: page.getByRole("heading", { level: 1, name: "Ask in context." }),
    primaryAction: page.getByRole("link", { name: "Return to Overview" })
  }
  await page.goto(authenticatedAgent.audit.canonicalPath)
  await auditProductionRoutePresentation(page, {
    exercise: async (primaryAction) => primaryAction.press("Enter"),
    expectOutcome: async () => {
      await expect(page).toHaveURL("/")
      await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeVisible()
    },
    landmark: authenticatedAgent.landmark,
    primaryAction: authenticatedAgent.primaryAction
  })

  expect([...routes.map(({ audit }) => audit), authenticatedAgent.audit].map(productionRouteAuditKey).sort()).toEqual(
    requiredProductionRouteAuditsFor("scaffold")
      .map(productionRouteAuditKey)
      .sort()
  )
})

test("renders the private browser application boundary", async ({ page }) => {
  await page.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "UnauthorizedApiError",
        code: "unauthorized",
        correlationId: "private-boundary-e2e",
        message: "No active session"
      }),
      contentType: "application/json",
      status: 401
    })
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeVisible()
  await expect(page.getByText("Release facts stay private")).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { exact: true, name: "Control Center" })).toBeFocused()
  for (const name of ["Overview", "Releases", "Services", "Ask Relay"]) {
    await page.keyboard.press("Tab")
    await expect(page.getByRole("link", { name })).toBeFocused()
  }
  await page.getByRole("link", { name: "Releases" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeVisible()
  await expect(page.getByText("Release facts stay private")).toBeVisible()
  await page.getByRole("link", { name: "Ask Relay" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Ask in context." })).toBeVisible()
  await expect(page.getByText("Current context")).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "Releases" })).toBeVisible()
  await expect(page.getByText("Open Relay from a release to start an exact, release-owned thread.")).toBeVisible()
})

test("keeps mobile navigation clear of application identity and content", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/")

  const navigationBox = await page.getByRole("navigation", { name: "Primary" }).boundingBox()
  const brandBox = await page.getByRole("link", { exact: true, name: "Control Center" }).boundingBox()
  const agentBox = await page.getByRole("link", { name: "Ask Relay" }).boundingBox()
  if (navigationBox === null || brandBox === null || agentBox === null) {
    throw new Error("mobile application chrome must remain measurable")
  }

  expect(navigationBox.y).toBeGreaterThan(Math.max(brandBox.y + brandBox.height, agentBox.y + agentBox.height))
  expect(Math.abs(844 - (navigationBox.y + navigationBox.height) - 16)).toBeLessThan(2)

  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { exact: true, name: "Control Center" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Ask Relay" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Overview" })).toBeFocused()
})

test("explains credential rejection separately from server availability", async ({ page }) => {
  let requestCount = 0
  await page.route("**/api/v1/session/pair", async (route) => {
    requestCount += 1
    if (requestCount === 1) {
      await route.fulfill({
        contentType: "application/json",
        status: 401,
        body: JSON.stringify({
          _tag: "UnauthorizedApiError",
          code: "unauthorized",
          correlationId: "pairing-e2e",
          message: "Pairing credential was rejected"
        })
      })
      return
    }
    await route.abort("failed")
  })
  await page.goto("/pair")
  await page.getByRole("textbox", { name: "Pairing code" }).fill("a".repeat(64))
  await page.getByRole("button", { name: "Pair browser" }).click()
  await expect(page.getByText("That code is invalid, expired, or already used.")).toBeVisible()

  await page.getByRole("button", { name: "Pair browser" }).click()
  await expect(
    page.getByText("Control Center is unavailable right now. Check that the server is running, then try again.")
  ).toBeVisible()
})

test("shows a paired session and recovers its mutation proof in a new tab", async ({ context, page }) => {
  const csrfToken = "cd".repeat(32)
  await context.route("**/api/v1/session/pair", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, session: pairedSession }),
      contentType: "application/json",
      headers: { "set-cookie": `cc_session=${"ab".repeat(32)}; HttpOnly; Path=/; SameSite=Strict` },
      status: 200
    })
  })
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, session: pairedSession }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.goto("/pair")
  await page.getByRole("textbox", { name: "Pairing code" }).fill("a".repeat(64))
  await page.getByRole("button", { name: "Pair browser" }).click()
  await expect(page).toHaveURL("/")
  await expect(page.getByText("Owner browser paired")).toBeVisible()
  await expect(page.getByRole("link", { name: "Pair this browser" })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBe(csrfToken)

  const newTab = await context.newPage()
  await newTab.goto("/services")
  await expect(newTab.getByRole("heading", { level: 1, name: "Services" })).toBeVisible()
  await expect.poll(() => newTab.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBe(csrfToken)
  await newTab.getByRole("link", { name: "Overview" }).click()
  await expect(newTab.getByText("Owner browser paired")).toBeVisible()
  await newTab.close()
})

test("routes an authenticated releases entry to the live workspace portfolio", async ({ context, page }) => {
  const csrfToken = "cd".repeat(32)
  await context.addCookies([
    {
      name: "cc_session",
      value: "ab".repeat(32),
      url: "http://127.0.0.1:4173"
    }
  ])
  await page.addInitScript((token) => sessionStorage.setItem("cc_csrf", token), csrfToken)
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, session: pairedSession }),
      contentType: "application/json",
      status: 200
    })
  })
  await context.route("**/api/v1/portfolio/snapshot", async (route) => {
    await route.fulfill({
      body: JSON.stringify(releasePortfolioFixture),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/releases")

  await expect(page).toHaveURL(`/w/${pairedSession.workspaceId}/overview`)
  await expect(page.getByRole("link", { name: "Active work" })).toBeVisible()
  await expect(page.getByText("Waiting for the first source")).toHaveCount(0)
})

test("invalidates a paired browser when the authoritative portfolio rejects its session", async ({ context, page }) => {
  const csrfToken = "cd".repeat(32)
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, session: pairedSession }),
      contentType: "application/json",
      status: 200
    })
  })
  await context.route("**/api/v1/portfolio/snapshot", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "UnauthorizedApiError",
        code: "unauthorized",
        correlationId: "portfolio-session-expired-e2e",
        message: "Session expired"
      }),
      contentType: "application/json",
      status: 401
    })
  })

  await page.goto("/")
  await expect(page.getByText("Owner browser paired")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Pair this browser" })).toHaveCount(1)
  await expect(page.getByText("Release facts stay private")).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBeNull()
})

test("ignores a stale session hydration after replacing the paired session", async ({ context, page }) => {
  const oldCsrfToken = "ef".repeat(32)
  const newCsrfToken = "cd".repeat(32)
  const oldSession = {
    ...pairedSession,
    permission: "workspace-member",
    sessionId: "01890f6f-6d6a-7cc0-98d2-000000000004"
  }
  let releaseCurrentResponse: (() => void) | undefined
  let markCurrentStarted: (() => void) | undefined
  let markCurrentCompleted: (() => void) | undefined
  const currentStarted = new Promise<void>((resolve) => {
    markCurrentStarted = resolve
  })
  const currentCompleted = new Promise<void>((resolve) => {
    markCurrentCompleted = resolve
  })
  const currentResponseGate = new Promise<void>((resolve) => {
    releaseCurrentResponse = resolve
  })

  await context.addCookies([
    {
      name: "cc_session",
      value: "ab".repeat(32),
      url: "http://127.0.0.1:4173"
    }
  ])
  await context.route("**/api/v1/session/current", async (route) => {
    markCurrentStarted?.()
    await currentResponseGate
    await route.fulfill({
      body: JSON.stringify({ csrfToken: oldCsrfToken, session: oldSession }),
      contentType: "application/json",
      status: 200
    })
    markCurrentCompleted?.()
  })
  await context.route("**/api/v1/session/pair", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken: newCsrfToken, session: pairedSession }),
      contentType: "application/json",
      headers: { "set-cookie": `cc_session=${"bc".repeat(32)}; HttpOnly; Path=/; SameSite=Strict` },
      status: 200
    })
  })

  await page.goto("/pair")
  await currentStarted
  await page.getByRole("textbox", { name: "Pairing code" }).fill("a".repeat(64))
  await page.getByRole("button", { name: "Pair browser" }).click()
  await expect(page).toHaveURL("/")
  await expect(page.getByText("Owner browser paired")).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBe(newCsrfToken)

  const staleResponse = page.waitForResponse("**/api/v1/session/current")
  releaseCurrentResponse?.()
  await currentCompleted
  await staleResponse
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  await expect(page.getByText("Owner browser paired")).toBeVisible()
  await expect(page.getByText("Browser paired", { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBe(newCsrfToken)
})

test("reports a consumed pairing when session storage rejects its mutation proof", async ({ context, page }) => {
  const pageErrors: Array<Error> = []
  page.on("pageerror", (error) => pageErrors.push(error))
  await page.addInitScript(() => {
    sessionStorage.setItem("cc_csrf", "ef".repeat(32))
    const storagePrototype = Object.getPrototypeOf(sessionStorage)
    const originalSetItem = storagePrototype.setItem
    storagePrototype.setItem = function(key: string, value: string): void {
      if (key === "cc_csrf") throw new DOMException("Storage is disabled", "SecurityError")
      originalSetItem.call(this, key, value)
    }
  })
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "UnauthorizedApiError",
        code: "unauthorized",
        correlationId: "storage-pairing-e2e",
        message: "No active session"
      }),
      contentType: "application/json",
      status: 401
    })
  })
  await context.route("**/api/v1/session/pair", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken: "cd".repeat(32), session: pairedSession }),
      contentType: "application/json",
      headers: { "set-cookie": `cc_session=${"bc".repeat(32)}; HttpOnly; Path=/; SameSite=Strict` },
      status: 200
    })
  })

  await page.goto("/pair")
  await page.getByRole("textbox", { name: "Pairing code" }).fill("a".repeat(64))
  await page.getByRole("button", { name: "Pair browser" }).click()
  await expect(page).toHaveURL("/")
  const storageAlert = page.getByText(
    "Browser paired, but session storage is unavailable. Check storage permissions or space, then reload.",
    { exact: true }
  )
  await expect(storageAlert).toHaveAttribute("role", "alert")
  await expect(storageAlert).toBeFocused()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBeNull()
  expect(pageErrors).toEqual([])
})

test("clears a stale mutation proof after authoritative anonymous hydration", async ({ context, page }) => {
  await page.addInitScript(() => sessionStorage.setItem("cc_csrf", "ef".repeat(32)))
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "UnauthorizedApiError",
        code: "unauthorized",
        correlationId: "anonymous-cleanup-e2e",
        message: "No active session"
      }),
      contentType: "application/json",
      status: 401
    })
  })

  await page.goto("/releases")
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBeNull()
  await page.getByRole("link", { name: "Overview" }).click()
  await expect(page.getByRole("link", { name: "Pair this browser" })).toHaveCount(1)
})

test("reports unavailable storage when an anonymous proof cannot be removed", async ({ context, page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("cc_csrf", "ef".repeat(32))
    const storagePrototype = Object.getPrototypeOf(sessionStorage)
    const originalRemoveItem = storagePrototype.removeItem
    storagePrototype.removeItem = function(key: string): void {
      if (key === "cc_csrf") throw new DOMException("Storage is disabled", "SecurityError")
      originalRemoveItem.call(this, key)
    }
  })
  await context.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "UnauthorizedApiError",
        code: "unauthorized",
        correlationId: "storage-cleanup-e2e",
        message: "No active session"
      }),
      contentType: "application/json",
      status: 401
    })
  })

  await page.goto("/")
  const storageAlert = page.getByRole("alert")
  await expect(storageAlert).toHaveCount(1)
  await expect(storageAlert.getByText("Session storage unavailable")).toBeVisible()
  await expect(page.getByRole("link", { name: "Pair this browser" })).toHaveCount(0)
})

test("distinguishes a blocked session read from an unavailable server", async ({ page }) => {
  await page.route("**/api/v1/session/current", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        _tag: "ForbiddenApiError",
        code: "forbidden",
        correlationId: "session-e2e",
        message: "Session reads are blocked on this connection"
      }),
      contentType: "application/json",
      status: 403
    })
  })

  await page.goto("/")
  await expect(page.getByText("Session access blocked on this connection")).toBeVisible()
  await expect(page.getByRole("link", { name: "Pair this browser" })).toHaveCount(0)
})
