import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { DescribeRowRequest } from "../../src/shared/contracts.js"

const open = async (page: Page) => {
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
    await (await page.request.post("/__test/reset")).json()
  )
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
}
const suggestion = "Improved weekly time review and tested approval behavior"
const noteField = (page: Page) => page.getByRole("textbox", { name: "What was done (optional)", exact: true })

// A held response keeps visible progress beside the editable field until autofill completes.
test("shows description progress until the agent fills the field", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/rows/describe", async (route) => {
    await held
    await route.continue()
  })
  await page.locator(".jcf-agenda-entry[data-kind=proposable]").filter({ hasText: "11:00" }).click()
  const progress = page.getByRole("progressbar", { name: "Generating work description" })
  await progress.scrollIntoViewIfNeeded()
  await expect(progress).toBeInViewport()
  await expect(noteField(page)).toBeEditable()
  await expect(noteField(page)).toHaveAttribute("aria-busy", "true")
  await expect(noteField(page)).toHaveAttribute("placeholder", "Agent is writing a description…")
  await expect(page.getByRole("button", { name: "Log selected time" })).toBeEnabled()
  release?.()
  await expect(noteField(page)).toHaveValue(suggestion)
  await expect(progress).toHaveCount(0)
  await expect(noteField(page)).toHaveAttribute("aria-busy", "false")
})

// Cross the authenticated description and confirmation routes with fake providers and retained evidence.
test("suggests work text on opening a block and writes exactly the visible note", async ({ page }) => {
  await open(page)
  let rescans = 0
  page.on("request", (request) => {
    if (request.url().includes("/api/week/stream")) rescans += 1
  })
  const observations = Schema.decodeUnknownSync(
    Schema.Struct({ describeCalls: Schema.Number, transcriptReads: Schema.Number })
  )
  const before = observations(await (await page.request.get("/__test/observations")).json())
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await expect(noteField(page)).toHaveValue(suggestion)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: /PROJ-123, 14:00/ }).click()
  await expect(noteField(page)).toHaveValue(suggestion)
  await expect(page.getByRole("group", { name: "Blocks to write" })).toHaveCount(0)
  await expect(noteField(page)).toHaveJSProperty("tagName", "TEXTAREA")
  const edited = `${suggestion}\nVerified provider totals.`
  await noteField(page).fill(edited)
  const submitted = page.waitForRequest((request) => request.url().includes("/api/rows/confirm"))
  await page.getByRole("button", { name: "Log selected time" }).click()
  expect((await submitted).postDataJSON()).toMatchObject({ note: edited, blocks: [1] })
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const after = observations(await (await page.request.get("/__test/observations")).json())
  expect(after).toEqual({ describeCalls: before.describeCalls + 1, transcriptReads: before.transcriptReads })
  expect(rescans).toBe(0)
})

// Even a deliberate clear before the response arrives must survive another block's editor mount.
test("typing and clearing while the agent is pending keeps the user's draft", async ({ page }) => {
  await open(page)
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/rows/describe", async (route) => {
    await held
    await route.continue()
  })
  const requested = page.waitForRequest("**/api/rows/describe")
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await requested
  await expect(page.getByRole("status", { name: "Description suggestion" })).toContainText("Suggesting")
  await expect(page.getByRole("progressbar", { name: "Generating work description" })).toBeVisible()
  await expect(noteField(page)).toHaveAttribute("aria-busy", "true")
  await expect(page.getByRole("button", { name: "Log selected time" })).toBeEnabled()
  await noteField(page).fill("Own text")
  await expect(page.getByRole("progressbar", { name: "Generating work description" })).toHaveCount(0)
  await expect(noteField(page)).toHaveAttribute("aria-busy", "false")
  await noteField(page).fill("")
  const replied = page.waitForResponse("**/api/rows/describe")
  release?.()
  await replied
  await expect(noteField(page)).toHaveValue("")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: /PROJ-123, 14:00/ }).click()
  await expect(noteField(page)).toHaveValue("")
  await expect(page.getByRole("status", { name: "Description suggestion" })).toContainText("Your description")
})

// A failed optional request leaves approval usable and exposes an explicit retry.
test("shows a description failure and retries without rescanning sessions", async ({ page }) => {
  await open(page)
  await page.route(
    "**/api/rows/describe",
    (route) => route.fulfill({ status: 503, json: { message: "Description unavailable" } }),
    { times: 1 }
  )
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await expect(page.getByRole("status", { name: "Description suggestion" })).toContainText("Description unavailable")
  await expect(page.getByRole("progressbar", { name: "Generating work description" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Log selected time" })).toBeEnabled()
  await page.getByRole("button", { name: "Try description again" }).click()
  await expect(noteField(page)).toHaveValue(suggestion)
})

// Successful transport does not authorize applying a response for a different row.
test("never fills another row's response", async ({ page }) => {
  await open(page)
  await page.route("**/api/rows/describe", async (route) => {
    const request = Schema.decodeUnknownSync(DescribeRowRequest)(route.request().postDataJSON())
    await route.fulfill({ json: { ...request, rowId: "wrong-row", note: "Wrong work" } })
  })
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await expect(page.getByRole("status", { name: "Description suggestion" })).toContainText("another suggestion")
  await expect(noteField(page)).toHaveValue("")
})

// A stable null is cached by the server; the UI must not promise that retry would regenerate it.
test("an unavailable suggestion leaves manual text and approval available", async ({ page }) => {
  await open(page)
  await page.route("**/api/rows/describe", async (route) => {
    const request = Schema.decodeUnknownSync(DescribeRowRequest)(route.request().postDataJSON())
    await route.fulfill({ json: { ...request, note: null } })
  })
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await expect(page.getByRole("status", { name: "Description suggestion" })).toContainText("You can write one")
  await expect(page.getByRole("button", { name: "Try description again" })).toHaveCount(0)
  await noteField(page).fill("Reviewed the work")
  await expect(page.getByRole("button", { name: "Log selected time" })).toBeEnabled()
})
