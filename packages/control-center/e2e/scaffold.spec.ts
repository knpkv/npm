import { expect, test } from "@playwright/test"

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

test("renders the private browser application boundary", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Everything that can ship." })).toBeVisible()
  await expect(page.getByText("Workspace is private")).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Control Center home" })).toBeFocused()
  for (const name of ["Today", "Releases", "Services", "Relay context"]) {
    await page.keyboard.press("Tab")
    await expect(page.getByRole("link", { name })).toBeFocused()
  }
  await page.getByRole("link", { name: "Releases" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
  await page.getByRole("link", { name: "Relay context" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Relay context" })).toBeVisible()
  await expect(page.getByText("Current context")).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "Releases" })).toBeVisible()
  await expect(page.getByText("Agent runtime not connected")).toBeVisible()
})

test("keeps mobile navigation clear of application identity and content", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/")

  const navigationBox = await page.getByRole("navigation", { name: "Primary" }).boundingBox()
  const brandBox = await page.getByRole("link", { name: "Control Center home" }).boundingBox()
  const agentBox = await page.getByRole("link", { name: "Relay context" }).boundingBox()
  if (navigationBox === null || brandBox === null || agentBox === null) {
    throw new Error("mobile application chrome must remain measurable")
  }

  expect(navigationBox.y).toBeGreaterThan(Math.max(brandBox.y + brandBox.height, agentBox.y + agentBox.height))
  expect(Math.abs(844 - (navigationBox.y + navigationBox.height) - 16)).toBeLessThan(2)

  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Control Center home" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Relay context" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Today" })).toBeFocused()
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
  await expect(page.getByText(
    "Control Center is unavailable right now. Check that the server is running, then try again."
  )).toBeVisible()
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
  await newTab.goto("/releases")
  await expect(newTab.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
  await expect.poll(() => newTab.evaluate(() => sessionStorage.getItem("cc_csrf"))).toBe(csrfToken)
  await newTab.getByRole("link", { name: "Today" }).click()
  await expect(newTab.getByText("Owner browser paired")).toBeVisible()
  await newTab.close()
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
})
