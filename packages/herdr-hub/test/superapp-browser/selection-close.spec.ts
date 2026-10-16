import { expect, type Page, test } from "@playwright/test"
import { CODE_REF } from "./code-fixture.js"

const queueRoute = "/?filter=open&search=&offset=0#code/pull-requests"
const targetRoute = `/?filter=open&search=&offset=0&ref=${CODE_REF}#code/pull-requests`

/**
 * Code review export 26 replaced the "Cached pull request" dialog with a full page (no dialog, no Close button). The
 * current Code pages tab is the page's return control, and Escape no longer closes anything, so the dialog's Escape
 * variants have no successor. History, opener and in-app guarantees are unchanged.
 */
const reviewPage = (page: Page) => page.locator("[data-code-review-page]")
const returnToQueue = (page: Page) =>
  page.getByRole("navigation", { name: "Code pages" }).locator("a[aria-current=\"page\"]")
/** Fails if a return drops focus to the document: some control or heading must hold it. */
const expectFocusKept = async (page: Page) =>
  expect(await page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body))
    .toBe(true)

test("two returns in separate tasks retain one traversal and the selected Forward entry", async ({ page }) => {
  await page.goto(queueRoute)
  const first = page.locator(".code-host-row").first()
  await first.click()
  await expect(reviewPage(page)).toBeVisible()
  await page.evaluate(() => {
    const back = history.back.bind(history)
    history.back = () => {
      document.documentElement.dataset.backCalls = String(Number(document.documentElement.dataset.backCalls ?? "0") + 1)
      setTimeout(back, 200)
    }
  })
  // Was: Escape then Close. The full page has one return control, so a second activation of it stands in for the
  // second input event, still in a later task before the delayed traversal delivers popstate.
  await returnToQueue(page).click()
  await returnToQueue(page).click()
  await expect(reviewPage(page)).toHaveCount(0)
  await expect(first).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.dataset.backCalls)).toBe("1")
  await page.goForward()
  await expect(reviewPage(page)).toBeVisible()
  expect(new URL(page.url()).searchParams.get("ref")).toBe(CODE_REF)
})

for (const motion of ["no-preference", "reduce"] satisfies ReadonlyArray<"no-preference" | "reduce">) {
  test(`returning goes back through history and restores the exact opener with ${motion} motion`, async ({ page }) => {
    await page.addInitScript(() => {
      const focus = HTMLElement.prototype.focus
      HTMLElement.prototype.focus = function(options) {
        if (this.closest("[aria-hidden=\"true\"], [inert]") !== null) {
          document.documentElement.dataset.hiddenFocusAttempt = "true"
        }
        focus.call(this, options)
      }
    })
    const warnings: Array<string> = []
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") warnings.push(message.text())
    })
    await page.emulateMedia({ reducedMotion: motion })
    await page.goto("/#today/overview")
    await page.evaluate(() => history.replaceState({ external: { marker: "retained" } }, "", location.href))
    await page.locator("a[aria-label=\"Code\"]:visible").click()
    const first = page.locator(".code-host-row").first()
    await expect(first).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get("offset")).toBe("0")
    expect(await page.evaluate(() => history.state.external)).toEqual({ marker: "retained" })
    await first.click()
    await expect(reviewPage(page)).toBeVisible()
    const close = async () => {
      await returnToQueue(page).click()
      await expect(reviewPage(page)).toHaveCount(0)
      // Shipped behaviour: the return restores the exact row that opened the page.
      await expect(first).toBeFocused()
      expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
    }
    await close()
    await page.goForward()
    await expect(reviewPage(page)).toBeVisible()
    await close()
    await page.goBack()
    await expect.poll(() => new URL(page.url()).hash).toBe("#connect/overview")
    expect(await page.evaluate(() => document.documentElement.dataset.hiddenFocusAttempt)).toBeUndefined()
    expect(warnings).toEqual([])
  })
}

test("a reloaded target returns in place instead of traversing history from its previous shell", async ({ page }) => {
  await page.goto(queueRoute)
  await page.locator(".code-host-row").first().click()
  await expect(reviewPage(page)).toBeVisible()
  await page.reload()
  await expect(reviewPage(page)).toBeVisible()
  await returnToQueue(page).click()
  await expect(reviewPage(page)).toHaveCount(0)
  // No opener survives a reload; focus must still land somewhere, never on <body>.
  await expectFocusKept(page)
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
  await page.goBack()
  await expect(reviewPage(page)).toHaveCount(0)
  await page.goForward()
  await expect(reviewPage(page)).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
})

test("a direct target returns without leaving the app", async ({ page }) => {
  await page.goto("/#today/overview")
  await page.goto(targetRoute)
  await expect(reviewPage(page)).toBeVisible()
  await returnToQueue(page).click()
  await expect(reviewPage(page)).toHaveCount(0)
  // A direct target has no opener row; focus must still land somewhere, never on <body>.
  await expectFocusKept(page)
  expect(new URL(page.url()).hash).toBe("#code/pull-requests")
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
  await page.goBack()
  await expect.poll(() => new URL(page.url()).hash).toBe("#connect/overview")
})

test("changing queue selectors while a target is open declines an unrelated history parent", async ({ page }) => {
  await page.goto(queueRoute)
  await page.locator(".code-host-row").first().click()
  await expect(reviewPage(page)).toBeVisible()
  await page.evaluate(() => {
    history.replaceState(history.state, "", location.href.replace("filter=open", "filter=all"))
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await returnToQueue(page).click()
  await expect(reviewPage(page)).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get("filter")).toBe("all")
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.get("filter")).toBe("open")
})
