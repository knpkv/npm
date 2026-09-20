import { expect, test } from "@playwright/test"
import { Schema } from "effect"

// Real config routes persist through reload; choosing a model is not permission to start a scan.
test("saves agent, model and effort without rescanning, and restores the choices", async ({ page }) => {
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const scans: Array<string> = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/week/stream") scans.push(request.url())
  })
  await page.getByRole("button", { name: "Agent settings", exact: true }).click()
  const settings = page.getByRole("region", { name: "Session agent settings" })
  await expect(settings.getByLabel("Agent", { exact: true })).toHaveValue("claude")
  await settings.getByLabel("Agent", { exact: true }).selectOption("codex")
  await settings.getByLabel("Model", { exact: true }).fill("test-codex-model")
  await settings.getByLabel("Effort", { exact: true }).selectOption("low")
  await settings.getByRole("button", { name: "Save agent settings" }).click()
  await expect(settings.getByRole("status")).toContainText("Saved. Applies on the next Rescan sessions.")
  expect(scans).toEqual([])
  await page.reload()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Agent settings", exact: true }).click()
  await expect(settings.getByLabel("Agent", { exact: true })).toHaveValue("codex")
  await expect(settings.getByLabel("Model", { exact: true })).toHaveValue("test-codex-model")
  await expect(settings.getByLabel("Effort", { exact: true })).toHaveValue("low")
  expect(scans).toEqual([])
  await settings.getByLabel("Agent", { exact: true }).selectOption("claude")
  await expect(settings.getByLabel("Model", { exact: true })).toHaveValue("")
  await expect(settings.getByLabel("Effort", { exact: true })).toHaveValue("default")
  await expect(settings.getByLabel("Effort", { exact: true }).locator("option[value=\"minimal\"]")).toHaveCount(0)
  await expect(settings.getByLabel("Effort", { exact: true }).locator("option[value=\"max\"]")).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

// A pending settings write must settle before a new scan can choose its provider.
for (const succeeds of [true, false]) {
  test(`rescan waits for a settings save that ${succeeds ? "succeeds" : "fails"}`, async ({ page }) => {
    const reset = await page.request.post("/__test/reset")
    const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await reset.json())
    await page.goto(setup.url)
    await page.getByRole("button", { name: "Agent settings", exact: true }).click()
    const settings = page.getByRole("region", { name: "Session agent settings" })
    await settings.getByLabel("Model", { exact: true }).fill("pending-model")
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route("**/api/config/agent", async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      await held
      if (succeeds) await route.continue()
      else await route.fulfill({ status: 500, json: { message: "Settings write failed" } })
    })
    const scans: Array<string> = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/week/stream") scans.push(request.url())
    })
    await settings.getByRole("button", { name: "Save agent settings" }).click()
    const rescan = page.getByRole("button", { name: "Rescan sessions", exact: true })
    await expect(rescan).toBeDisabled()
    await expect(page.getByRole("button", { name: "Agent settings", exact: true })).toBeDisabled()
    expect(scans).toEqual([])
    release?.()
    if (succeeds) await expect(settings.getByRole("status")).toContainText("Saved.")
    else await expect(settings).toContainText("Settings write failed")
    await expect(rescan).toBeEnabled()
    expect(scans).toEqual([])
    const scan = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/week/stream")
    await rescan.click()
    await scan
    expect(scans).toHaveLength(1)
  })
}
