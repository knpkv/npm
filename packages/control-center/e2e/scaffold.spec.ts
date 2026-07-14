import { expect, test } from "@playwright/test"

test("renders the private browser application boundary", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Everything that can ship." })).toBeVisible()
  await expect(page.getByText("Workspace is private")).toBeVisible()
  await page.getByRole("link", { name: "Releases" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
  await page.getByRole("link", { name: "Ask Relay" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Relay" })).toBeVisible()
  await expect(page.getByText("Current context")).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "Releases" })).toBeVisible()
})

test("keeps mobile navigation clear of application identity and content", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/")

  const navigationBox = await page.getByRole("navigation", { name: "Primary" }).boundingBox()
  const brandBox = await page.getByRole("link", { name: "Control Center home" }).boundingBox()
  const agentBox = await page.getByRole("link", { name: "Ask Relay" }).boundingBox()
  if (navigationBox === null || brandBox === null || agentBox === null) {
    throw new Error("mobile application chrome must remain measurable")
  }

  expect(navigationBox.y).toBeGreaterThan(Math.max(brandBox.y + brandBox.height, agentBox.y + agentBox.height))
  expect(Math.abs(844 - (navigationBox.y + navigationBox.height) - 16)).toBeLessThan(2)
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
