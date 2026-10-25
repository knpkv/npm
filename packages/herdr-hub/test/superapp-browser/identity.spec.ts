import { expect, type Page, test } from "@playwright/test"
import { Config, Effect, Option } from "effect"
import { join } from "node:path"

/** Set to a directory to keep each shot for a comparison with design page 22. */
const shotsDirectory = Option.getOrUndefined(
  await Effect.runPromise(Config.option(Config.String("IDENTITY_SHOTS_DIRECTORY")))
)

const csrf = "b".repeat(64)
const token = "a".repeat(64)
const code = "c".repeat(64)
const signedOut = { signedIn: false, kind: "tailscale", login: "mira@example.test", device: "mira-laptop" }
const signedIn = {
  signedIn: true,
  kind: "tailscale",
  login: "mira@example.test",
  device: "mira-laptop",
  expiresAt: Date.UTC(2026, 9, 25, 21, 5),
  csrf
}

/** Answers the page's session reads with `view`, and records what the page sent. */
const answerSession = async (page: Page, view: () => object, seen: Array<Record<string, string>> = []) => {
  await page.route("**/v1/session", async (route) => {
    seen.push(route.request().headers())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(view()) })
  })
}

const phone = (project: string) => project === "phone"

const shoot = async (page: Page, name: string, project: string, theme: string) => {
  if (shotsDirectory === undefined) return
  await page.screenshot({
    path: join(shotsDirectory, `identity-${name}--${phone(project) ? "390" : "1280"}-${theme}.png`),
    animations: "disabled"
  })
}

for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
  // Page 22 state 1, as 3a draws it: the card offers the log-in; nothing claims view only before enforcement.
  test(
    `tailscale-continue ${theme}: offers to continue as the WhoIs login, without view-only copy`,
    async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await answerSession(page, () => signedOut)
      await page.goto("/#fleet/approvals")
      await page.locator("body").evaluate((body, selected) => body.setAttribute("data-rly-theme", selected), theme)
      const card = page.locator(".hub-login-card")
      await expect(card.getByRole("heading", { name: "Continue as mira@example.test?" })).toBeVisible()
      await expect(card).toContainText(
        "Tailscale says this is mira-laptop. Logging in keeps you signed in here for 8 hours."
      )
      await expect(card.getByRole("button", { name: "Log in with Tailscale" })).toBeEnabled()
      if (!phone(info.project.name)) {
        await expect(page.getByRole("group", { name: "Your Tailscale session on mira-laptop, not logged in" }))
          .toBeVisible()
      }
      await expect(page.getByText("view only", { exact: false })).toHaveCount(0)
      await expect(page.getByText("View only", { exact: false })).toHaveCount(0)
      await shoot(page, "tailscale-continue", info.project.name, theme)
    }
  )

  // Page 22 state 2: the session control opens a popover with who, how, until when and Log out.
  test(`signed-in-person ${theme}: shows the session and its details, without passkey copy`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await answerSession(page, () => signedIn)
    await page.goto("/#fleet/approvals")
    await page.locator("body").evaluate((body, selected) => body.setAttribute("data-rly-theme", selected), theme)
    await expect(page.locator(".hub-login-card")).toHaveCount(0)
    // Phones have no session control yet: the phone header shows no host status (its design ships in 3b).
    if (!phone(info.project.name)) {
      const control = page.getByRole("button", {
        name: /^Your Tailscale session, mira@example.test on mira-laptop, logged in until/u
      })
      await expect(control).toContainText("Logged in until")
      await control.click()
      const popover = page.getByRole("dialog", { name: "Your session" })
      await expect(popover).toContainText("Logged in with Tailscale on mira-laptop")
      await expect(popover).toContainText("Until")
      await expect(popover.getByRole("button", { name: "Log out" })).toBeVisible()
      await shoot(page, "signed-in-person", info.project.name, theme)
      await page.keyboard.press("Escape")
      await expect(popover).toHaveCount(0)
    }
    await expect(page.getByText("passkey", { exact: false })).toHaveCount(0)
  })
}

// Pressing Log in POSTs once; the next read shows the person logged in and the card goes.
test("logs in with Tailscale and reads the session again", async ({ page }) => {
  let current: typeof signedOut | typeof signedIn = signedOut
  await answerSession(page, () => current)
  const posts: Array<string> = []
  await page.route("**/v1/session/tailscale", async (route) => {
    posts.push(route.request().method())
    current = signedIn
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signedIn: true }) })
  })
  await page.goto("/#fleet/approvals")
  await page.getByRole("button", { name: "Log in with Tailscale" }).click()
  await expect(page.locator(".hub-login-card")).toHaveCount(0)
  expect(posts).toEqual(["POST"])
})

// `herdr-hub login`'s link: the code leaves the address before it is spent, and the page then sends the
// token it kept, never a cookie.
test("spends a #login code after taking it out of the address, then sends the kept token", async ({ page }) => {
  const reads: Array<Record<string, string>> = []
  await answerSession(page, () => ({ signedIn: true, kind: "local", expiresAt: signedIn.expiresAt, csrf }), reads)
  const spent: Array<{ readonly body: string | null; readonly hash: string }> = []
  await page.route("**/v1/session/local", async (route) => {
    spent.push({ body: route.request().postData(), hash: await page.evaluate(() => window.location.hash) })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedIn: true, kind: "local", expiresAt: signedIn.expiresAt, token, csrf })
    })
  })
  await page.goto(`/#login=${code}`)
  await expect.poll(() => spent.length).toBe(1)
  expect(spent[0]?.body).toBe(JSON.stringify({ code }))
  expect(spent[0]?.hash.includes(code)).toBe(false)
  await expect.poll(() => reads.some((headers) => headers["x-herdr-session"] === token)).toBe(true)
  expect(await page.evaluate(() => window.location.href)).not.toContain(code)
  const cookies = await page.context().cookies()
  expect(cookies.some((cookie) => cookie.value === token)).toBe(false)
})
