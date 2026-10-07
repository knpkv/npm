import { expect, type Page, test } from "@playwright/test"

const pullRequest = {
  account: { profile: "production", region: "eu-west-1", awsAccountId: "111122223333" },
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "andrey",
  commentedBy: [],
  creationDate: "2026-08-01T00:00:00.000Z",
  destinationBranch: "main",
  id: "42",
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: "2026-08-02T00:00:00.000Z",
  link: "https://example.invalid/pr/42",
  repositoryName: "example-repository",
  sourceBranch: "feature",
  status: "OPEN",
  title: "Structured page"
}

/** A signed-in session with one pull request. Endpoints a test does not stub answer with the app's HTML, so they fail to decode. */
const stubSession = async (page: Page) => {
  await page.route("**/api/session/current", (route) => route.fulfill({ status: 204 }))
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        accounts: [],
        autoDetect: false,
        autoRefresh: false,
        refreshIntervalSeconds: 300,
        review: { defaultProfileId: "synthetic", profiles: [] }
      }
    }))
  await page.route("**/api/subscriptions", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/prs/comments*", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [],
          currentUser: "viewer",
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle",
          enabledProfiles: ["production"]
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
}

const settingsTitles = {
  accounts: "Accounts",
  refresh: "Auto-refresh",
  relay: "Relay review profiles",
  sandbox: "Sandbox",
  notifications: "Notifications",
  permissions: "API Permissions",
  audit: "Audit Log",
  theme: "Theme",
  config: "Configuration",
  about: "About"
}

// QA-164: every settings tab is a page with one level-one heading, inside the app's main landmark.
for (const [tab, title] of Object.entries(settingsTitles)) {
  test(`settings ${tab} has one h1 inside main`, async ({ page }) => {
    await stubSession(page)
    await page.goto(`/settings/${tab}`)
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  })
}

// A failed config read is stated in the tab with a retry, never thrown out of the page.
test("settings accounts says the settings are unavailable, keeps the page and reads again", async ({ page }) => {
  await stubSession(page)
  let reads = 0
  await page.route("**/api/config", (route) => {
    reads += 1
    return route.fulfill({ status: 500, json: { _tag: "InternalServerError" } })
  })
  await page.goto("/settings/accounts")
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible()
  await expect(page.getByText("Settings unavailable")).toBeVisible()
  const before = reads
  await page.getByRole("button", { name: "Try again" }).click()
  await expect.poll(() => reads).toBeGreaterThan(before)
})

// QA-164 / the Stats crash: a failed /api/stats keeps the app shell, the h1 and says so.
test("stats keeps its h1 and main when the stats read fails", async ({ page }) => {
  await stubSession(page)
  await page.route("**/api/stats*", (route) => route.fulfill({ status: 502, body: "Bad gateway" }))
  await page.goto("/stats")
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Statistics" })).toBeVisible()
  await expect(page.getByText("Couldn't load stats for this week")).toBeVisible()
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0)
})

// QA-163: links inside a sentence are underlined, not told apart by colour alone.
test("the author link in the pull request sentence is underlined", async ({ page }) => {
  await stubSession(page)
  await page.goto("/accounts/production/prs/42?repository=example-repository&region=eu-west-1")
  const author = page.getByRole("main").getByRole("link", { name: "andrey", exact: true }).first()
  await expect(author).toBeVisible()
  await expect(author).toHaveCSS("text-decoration-line", "underline")
})

/** Contrast of an element's underline, blended over the page canvas, against that canvas (WCAG). */
const underlineContrast = (page: Page, name: string) =>
  page.getByRole("main").getByRole("link", { name, exact: true }).first().evaluate((link) => {
    const channels = (value: string) => {
      const numbers = (value.match(/[\d.]+/gu) ?? []).map(Number)
      const scale = value.startsWith("color(") ? 1 : 255
      const [r = 0, g = 0, b = 0] = numbers.slice(0, 3).map((n) => n / scale)
      return { r, g, b, a: numbers[3] ?? 1 }
    }
    const canvas = channels(getComputedStyle(document.body).backgroundColor)
    const line = channels(getComputedStyle(link).textDecorationColor)
    const blend = (fg: number, bg: number) => fg * line.a + bg * (1 - line.a)
    const luminance = ({ b, g, r }: { r: number; g: number; b: number }) => {
      const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
    const a = luminance({ r: blend(line.r, canvas.r), g: blend(line.g, canvas.g), b: blend(line.b, canvas.b) })
    const b = luminance(canvas)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })

const colorSchemes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]

// The underline is the link's only non-colour cue, so it needs 3:1 against the canvas in both themes.
for (const colorScheme of colorSchemes) {
  test(`the author underline reaches 3:1 in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await stubSession(page)
    await page.goto("/accounts/production/prs/42?repository=example-repository&region=eu-west-1")
    await expect(page.getByRole("main").getByRole("link", { name: "andrey", exact: true }).first()).toBeVisible()
    expect(await underlineContrast(page, "andrey")).toBeGreaterThanOrEqual(3)
  })
}

// Forced colours repaint every author background, so the current page keeps a mark only where it opts
// out (forced-color-adjust: none) and paints system colours. Computed styles report authored values,
// so the check is the opt-out plus a background its sibling does not have.
const currentAndSibling: ReadonlyArray<readonly ["Primary" | "Settings", string, string]> = [
  ["Settings", "Permissions", "Theme"],
  ["Primary", "Settings", "Activity"]
]

test("the current page stays marked in forced colours", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" })
  await stubSession(page)
  await page.goto("/settings/permissions")
  const paint = (name: string, scope: "Primary" | "Settings") =>
    page.getByRole("navigation", { name: scope }).getByRole("link", { name, exact: true }).evaluate((link) => {
      const style = getComputedStyle(link)
      return { adjust: style.forcedColorAdjust, background: style.backgroundColor }
    })
  for (const [scope, current, sibling] of currentAndSibling) {
    const marked = await paint(current, scope)
    expect(marked.adjust).toBe("none")
    expect(marked.background).not.toBe((await paint(sibling, scope)).background)
  }
})
