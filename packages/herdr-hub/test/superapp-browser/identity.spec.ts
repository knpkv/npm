import { expect, type Page, test } from "@playwright/test"
import { Config, Effect, Option } from "effect"
import { join } from "node:path"

/** Set to a directory to keep each shot for a comparison with design page 22. */
const shotsDirectory = Option.getOrUndefined(
  await Effect.runPromise(Config.option(Config.String("IDENTITY_SHOTS_DIRECTORY")))
)

const csrf = "b".repeat(64)
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

const ended = { ...signedOut, ended: true }
const fleetHost = { ...signedOut, device: "build-01", fleetHost: true }
const localSignedOut = { signedIn: false, kind: "local" }

for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
  // Page 22's login gate: the whole page for a browser without a session, one state per session read.
  for (
    const [state, view, checks] of [
      ["gate-tailscale", signedOut, ["Continue as mira@example.test?", "Log in with Tailscale"]],
      ["gate-session-ended", ended, ["Your session ended. Log in again to continue.", "Log in with Tailscale"]],
      [
        "gate-fleet-host",
        fleetHost,
        ["This computer runs agents. They keep working; only you, logged in here, can see and act."]
      ],
      ["gate-loopback", localSignedOut, ["Log in as local user", "herdr-hub login"]]
    ] satisfies ReadonlyArray<readonly [string, object, ReadonlyArray<string>]>
  ) {
    test(`${state} ${theme}: draws the gate and no hub page`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await answerSession(page, () => view)
      await page.goto("/__fixture/login-gate")
      await page.locator("body").evaluate((body, selected) => body.setAttribute("data-rly-theme", selected), theme)
      const gate = page.getByRole("main")
      for (const text of checks) await expect(gate).toContainText(text)
      await expect(gate.getByRole("heading", { level: 1 })).toBeVisible()
      await expect(page.getByRole("navigation")).toHaveCount(0)
      await expect(page.getByText("View only", { exact: false })).toHaveCount(0)
      await shoot(page, state, info.project.name, theme)
    })
  }

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

// The popover is reachable by keyboard: opening it moves focus to Log out, and Escape returns focus to the
// control. Phones have no session control yet (3b), so this runs on desktop.
test("moves focus into the popover on open and back to the control on Escape", async ({ page }, info) => {
  test.skip(phone(info.project.name), "no phone session control before 3b")
  await answerSession(page, () => signedIn)
  await page.goto("/#fleet/approvals")
  const control = page.getByRole("button", { name: /^Your Tailscale session, mira@example.test/u })
  await control.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog", { name: "Your session" }).getByRole("button", { name: "Log out" }))
    .toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Your session" })).toHaveCount(0)
  await expect(control).toBeFocused()
})

// Pressing Log in on the gate POSTs once; once the read says logged in, the page reloads into the hub.
test("logs in from the gate with Tailscale and reloads into the hub", async ({ page }) => {
  let current: typeof signedOut | typeof signedIn = signedOut
  await answerSession(page, () => current)
  const posts: Array<string> = []
  await page.route("**/v1/session/tailscale", async (route) => {
    posts.push(route.request().method())
    current = signedIn
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signedIn: true }) })
  })
  await page.goto("/__fixture/login-gate")
  const reloaded = page.waitForEvent("load")
  await page.getByRole("button", { name: "Log in with Tailscale" }).click()
  await reloaded
  expect(posts).toEqual(["POST"])
})

// `herdr-hub login`'s link: the code leaves the address before it is spent; the hub sets the session cookie,
// so the page keeps no token of its own, and it reloads into the hub.
test("spends a #login code after taking it out of the address, keeping no token", async ({ page }) => {
  const loggedIn = { signedIn: true, kind: "local", expiresAt: signedIn.expiresAt, csrf }
  let current: typeof localSignedOut | typeof loggedIn = localSignedOut
  const reads: Array<Record<string, string>> = []
  await answerSession(page, () => current, reads)
  const spent: Array<{ readonly body: string | null; readonly hash: string }> = []
  await page.route("**/v1/session/local", async (route) => {
    spent.push({ body: route.request().postData(), hash: await page.evaluate(() => window.location.hash) })
    current = loggedIn
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedIn: true, kind: "local", expiresAt: signedIn.expiresAt, csrf })
    })
  })
  // Once logged in the hub serves itself, not the gate; the fixture's gate would reload forever.
  await page.route("**/__fixture/login-gate", (route) =>
    spent.length === 0
      ? route.continue()
      : route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Hub</title>" }))
  // The first load is the link itself; the page then reloads into the hub once the code is spent.
  let loads = 0
  page.on("load", () => {
    loads += 1
  })
  await page.goto(`/__fixture/login-gate#login=${code}`)
  await expect.poll(() => spent.length).toBe(1)
  expect(spent[0]?.body).toBe(JSON.stringify({ code }))
  expect(spent[0]?.hash.includes(code)).toBe(false)
  await expect.poll(() => loads).toBe(2)
  expect(await page.evaluate(() => window.location.href)).not.toContain(code)
  expect(reads.every((headers) => headers["x-herdr-session"] === undefined)).toBe(true)
  expect(await page.evaluate(() => Object.keys(window.sessionStorage))).toEqual([])
})
