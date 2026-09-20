import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"

const open = async (page: Page) => {
  const response = await page.request.post("/__test/reset?savedEditing=true")
  expect(response.status(), await response.text()).toBe(200)
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
}

const gate = () => {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release() }
}

// A tab submits the revision it actually displayed, so an older draft cannot restore old times.
test("rejects a stale saved-entry draft in another tab", async ({ context, page }) => {
  await open(page)
  const other = await context.newPage()
  try {
    await other.goto("/")
    await expect(other.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const selector = ".jcf-block-logged[data-source=\"jira\"]"
    await page.locator(selector).first().click()
    await other.locator(selector).first().click()
    const editor = page.getByRole("complementary", { name: "Saved time editor" })
    const stale = other.getByRole("complementary", { name: "Saved time editor" })
    await editor.getByLabel(/^End/).fill("2026-09-07T10:20:13")
    await editor.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(editor).toHaveCount(0)
    await stale.getByRole("textbox", { name: "What was done (optional)" }).fill("Old tab draft")
    const rejected = other.waitForResponse((response) => response.url().endsWith("/api/entries/update"))
    await stale.getByRole("button", { name: "Save changes", exact: true }).click()
    expect((await rejected).status()).toBe(409)
    await expect(stale.getByRole("textbox", { name: "What was done (optional)" })).toHaveValue("Old tab draft")
    await expect(other.getByText("Could not complete the action", { exact: true })).toBeVisible()
    const observations = Schema.decodeUnknownSync(Schema.Struct({ jiraUpdates: Schema.Array(Schema.Unknown) }))(
      await (await page.request.get("/__test/observations")).json()
    )
    expect(observations.jiraUpdates).toHaveLength(1)
  } finally {
    await other.close()
  }
})

// Real provider ledgers prove an edit never creates a second entry or touches the other provider.
for (const source of ["jira", "clockify"]) {
  test(`edits saved ${source} time and multiline description, then restores it on reload`, async ({ page }) => {
    const errors: Array<string> = []
    page.on("pageerror", (error) => errors.push(error.message))
    await open(page)
    const card = page.locator(`.jcf-block-logged[data-source="${source}"]`).filter({ hasText: "PROJ-123" }).first()
    await card.focus()
    await card.press("Enter")
    expect(errors).toEqual([])
    const editor = page.getByRole("complementary", { name: "Saved time editor" })
    await expect(editor).toBeFocused()
    const description = editor.getByRole("textbox", { name: "What was done (optional)" })
    await expect(description).toHaveJSProperty("tagName", "TEXTAREA")
    const note = source === "clockify"
      ? "[PROJ-123] First line\n  Exact second line  "
      : "First line\n  Exact second line  "
    await description.fill(note)
    await editor.getByLabel(/^End/).fill("2026-09-07T10:15:23")
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/entries/update"))
    await editor.getByRole("button", { name: "Save changes", exact: true }).click()
    expect((await saved).status()).toBe(200)
    await expect(editor).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    await card.click()
    await expect(description).toHaveValue(note)
    await expect(editor.getByLabel(/^End/)).toHaveValue("2026-09-07T10:15:23")
    const before = await page.request.get("/__test/observations")
    const observations = Schema.decodeUnknownSync(Schema.Struct({
      clockifyWrites: Schema.Number,
      jiraWrites: Schema.Number,
      transcriptReads: Schema.Number,
      clockifyUpdates: Schema.Array(Schema.Unknown),
      jiraUpdates: Schema.Array(Schema.Unknown)
    }))(await before.json())
    expect(observations.clockifyWrites).toBe(0)
    expect(observations.jiraWrites).toBe(0)
    expect(observations.clockifyUpdates).toHaveLength(source === "clockify" ? 1 : 0)
    expect(observations.jiraUpdates).toHaveLength(source === "jira" ? 1 : 0)
    await page.reload()
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    await card.click()
    await expect(description).toHaveValue(note)
    const after = Schema.decodeUnknownSync(Schema.Struct({ transcriptReads: Schema.Number }))(
      await (await page.request.get("/__test/observations")).json()
    )
    expect(after.transcriptReads).toBe(observations.transcriptReads)
  })
}

// The request is held after its real response so generation liveness and draft protection are observable.
test("generates explicitly from matching sessions, keeps edits made while loading, and preserves Clockify prefix", async ({ page }) => {
  await open(page)
  await page.locator(".jcf-block-logged[data-source=\"clockify\"]").filter({ hasText: "PROJ-123" }).first().click()
  const editor = page.getByRole("complementary", { name: "Saved time editor" })
  const note = editor.getByRole("textbox", { name: "What was done (optional)" })
  const generating = gate()
  const entered = gate()
  await page.route("**/api/entries/describe", async (route) => {
    const response = await route.fetch()
    entered.release()
    await generating.promise
    await route.fulfill({ response })
  })
  await editor.getByRole("button", { name: "Generate description", exact: true }).click()
  await entered.promise
  await expect(editor.getByRole("progressbar", { name: "Generating work description" })).toBeVisible()
  await expect(note).toHaveAttribute("aria-busy", "true")
  await note.fill("")
  generating.release()
  await expect(editor.getByText("Your edits were kept.", { exact: false })).toBeVisible()
  await expect(note).toHaveValue("")
  await editor.getByRole("button", { name: "Generate description", exact: true }).click()
  await expect(note).toHaveValue("[PROJ-123] Improved weekly time review and tested approval behavior")
  await expect(editor.getByText("Suggested from 1 matching session.", { exact: false })).toBeVisible()
  await expect(editor.getByRole("progressbar")).toHaveCount(0)
  const beforeSave = Schema.decodeUnknownSync(Schema.Struct({ clockifyUpdates: Schema.Array(Schema.Unknown) }))(
    await (await page.request.get("/__test/observations")).json()
  )
  expect(beforeSave.clockifyUpdates).toHaveLength(0)
  await editor.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(editor).toHaveCount(0)
})

// Provider errors roll back the preview while leaving the user's exact draft available to retry.
test("rolls back a failed edit without moving the calendar or discarding the draft", async ({ page }) => {
  await open(page)
  const card = page.locator(".jcf-block-logged[data-source=\"jira\"]").first()
  await card.click()
  const editor = page.getByRole("complementary", { name: "Saved time editor" })
  const note = editor.getByRole("textbox", { name: "What was done (optional)" })
  await note.fill("Retain this draft")
  await editor.getByLabel(/^End/).fill("2026-09-07T10:30")
  const before = await page.getByRole("region", { name: "Week calendar", exact: true }).boundingBox()
  const saving = gate()
  await page.route("**/api/entries/update", async (route) => {
    await saving.promise
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Provider temporarily unavailable" })
    })
  })
  await editor.getByRole("button", { name: "Save changes", exact: true }).click()
  const pending = page.locator(".jcf-block-logged[data-source=\"jira\"][data-pending=\"true\"]")
  await expect(pending).toHaveCount(1)
  expect(await page.getByRole("region", { name: "Week calendar", exact: true }).boundingBox()).toEqual(before)
  saving.release()
  await expect(page.getByText("Provider temporarily unavailable", { exact: false })).toBeVisible()
  await expect(pending).toHaveCount(0)
  await expect(note).toHaveValue("Retain this draft")
  await expect(editor.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled()
  await editor.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(card).toBeFocused()
})

// A midnight slice edits the whole entry; unkeyed Clockify does not invent a ticket prefix.
test("edits unkeyed and cross-midnight Clockify entries in the mobile agenda", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 })
  await open(page)
  await page.getByRole("button", { name: "Agenda", exact: true }).click()
  const card = page.locator(".jcf-agenda-entry[data-kind=\"logged\"]").filter({ hasText: "Planning without a ticket" })
    .first()
  await card.click()
  const editor = page.getByRole("complementary", { name: "Saved time editor" })
  await expect(editor.getByRole("heading", { name: "No ticket · Clockify" })).toBeVisible()
  await editor.getByRole("button", { name: "Generate description", exact: true }).click()
  await expect(editor.getByRole("textbox", { name: "What was done (optional)" })).toHaveValue(
    "Improved weekly time review and tested approval behavior"
  )
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(await card.getAttribute("id"))
  await expect(card).toBeFocused()
  await page.locator(".jcf-agenda-entry[data-kind=\"logged\"]").filter({ hasText: "Overnight operation" }).last()
    .click()
  await expect(editor.getByLabel(/^Start/)).toHaveValue("2026-09-07T23:30")
  await expect(editor.getByLabel(/^End/)).toHaveValue("2026-09-08T00:30")
  await editor.getByRole("button", { name: "Generate description", exact: true }).click()
  await expect(editor.getByText("No matching scanned sessions", { exact: false })).toBeVisible()
  await expect(editor.getByRole("textbox", { name: "What was done (optional)" })).toHaveValue("Overnight operation")
})
