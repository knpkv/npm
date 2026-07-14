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
  await expect(page.getByRole("link", { name: "Control Center home" })).toBeFocused()
  for (const name of ["Overview", "Releases", "Services", "Relay context"]) {
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
  await newTab.getByRole("link", { name: "Overview" }).click()
  await expect(newTab.getByText("Owner browser paired")).toBeVisible()
  await newTab.close()
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

  await context.addCookies([{
    name: "cc_session",
    value: "ab".repeat(32),
    url: "http://127.0.0.1:4173"
  }])
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
