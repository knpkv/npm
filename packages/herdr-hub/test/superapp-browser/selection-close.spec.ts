import { expect, test } from "@playwright/test"
import { CODE_REF } from "./code-fixture.js"

const queueRoute = "/?filter=open&search=&offset=0#code/pull-requests"
const targetRoute = `/?filter=open&search=&offset=0&ref=${CODE_REF}#code/pull-requests`

for (const motion of ["no-preference", "reduce"] satisfies ReadonlyArray<"no-preference" | "reduce">) {
  test(`Escape then Close in separate tasks retains one traversal and the selected Forward entry with ${motion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion })
    await page.goto(queueRoute)
    const first = page.locator(".code-host-row").first()
    await first.click()
    const dialog = page.getByRole("dialog", { name: "Cached pull request" })
    await expect(dialog).toBeVisible()
    await page.evaluate(() => {
      const back = history.back.bind(history)
      history.back = () => {
        document.documentElement.dataset.backCalls = String(
          Number(document.documentElement.dataset.backCalls ?? "0") + 1
        )
        setTimeout(back, 200)
      }
    })
    await page.keyboard.press("Escape")
    // A second input event runs in a later task, before the delayed traversal delivers popstate.
    await dialog.getByRole("button", { name: "Close pull request" }).click({ force: true })
    await expect(dialog).toHaveCount(0)
    await expect(first).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.dataset.backCalls)).toBe("1")
    await page.goForward()
    await expect(dialog).toBeVisible()
    expect(new URL(page.url()).searchParams.get("ref")).toBe(CODE_REF)
  })
}

for (const motion of ["no-preference", "reduce"] satisfies ReadonlyArray<"no-preference" | "reduce">) {
  for (const action of ["Close", "Escape"]) {
    test(`${action} returns through history and restores the exact opener with ${motion} motion`, async ({ page }) => {
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
      const dialog = page.getByRole("dialog", { name: "Cached pull request" })
      await expect(dialog).toBeVisible()
      await page.evaluate(async () => {
        await Promise.allSettled(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished)
        )
      })
      const close = async () => {
        if (action === "Close") await dialog.getByRole("button", { name: "Close pull request" }).click()
        else await page.keyboard.press("Escape")
        await expect(dialog).toHaveCount(0)
        await expect(first).toBeFocused()
        expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
      }
      await close()
      await page.goForward()
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Close pull request" })).toBeFocused()
      await close()
      await page.goBack()
      await expect.poll(() => new URL(page.url()).hash).toBe("#today/overview")
      expect(await page.evaluate(() => document.documentElement.dataset.hiddenFocusAttempt)).toBeUndefined()
      expect(warnings).toEqual([])
    })
  }
}

test("a reloaded target closes in place instead of traversing history from its previous shell", async ({ page }) => {
  await page.goto(queueRoute)
  await page.locator(".code-host-row").first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.reload()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Close pull request" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.goForward()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
})

test("a direct target closes without leaving the app", async ({ page }) => {
  await page.goto("/#today/overview")
  await page.goto(targetRoute)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(new URL(page.url()).hash).toBe("#code/pull-requests")
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
  await page.goBack()
  await expect.poll(() => new URL(page.url()).hash).toBe("#today/overview")
})

test("changing queue selectors while a target is open declines an unrelated history parent", async ({ page }) => {
  await page.goto(queueRoute)
  await page.locator(".code-host-row").first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(() => {
    history.replaceState(history.state, "", location.href.replace("filter=open", "filter=all"))
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await page.getByRole("button", { name: "Close pull request" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get("filter")).toBe("all")
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.get("filter")).toBe("open")
})
