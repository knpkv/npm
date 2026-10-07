import { expect, type Page, test } from "@playwright/test"

// First run, as a new user meets it: every state names its cause and its one action, and no count
// the page can't vouch for reads 0.

const emptySnapshot = {
  accounts: [],
  pullRequests: [],
  sandboxes: [],
  status: "idle",
  enabledProfiles: [],
  lastUpdated: "2026-10-06T20:00:00.000Z"
}

const config = {
  accounts: [],
  autoDetect: true,
  autoRefresh: false,
  refreshIntervalSeconds: 300,
  review: { defaultProfileId: "synthetic", profiles: [] }
}

const routeCommon = async (page: Page) => {
  await page.route("**/api/subscriptions", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/prs/comments*", (route) => route.fulfill({ json: [] }))
}

test("says this browser isn't signed in when the session is refused, with no zero counts", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) => route.fulfill({ status: 401 }))
  await page.route("**/api/config", (route) => route.fulfill({ status: 401 }))

  await page.goto("/")
  await expect(page.getByText("This browser isn't signed in", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("main").getByText("Run codecommit web again and open the link it prints", { exact: false })
  )
    .toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Not signed in" })).toBeVisible()
  const facets = page.getByRole("group", { name: "Pull request facets" })
  await expect(facets.getByLabel("unknown")).toHaveCount(4)
  await expect(facets.getByText("0", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("searchbox")).toHaveCount(0)
})

test("names an unreachable server and retries on request", async ({ page }) => {
  await routeCommon(page)
  let streamCalls = 0
  await page.route("**/api/events/", (route) => {
    streamCalls += 1
    return route.fulfill({ status: 503 })
  })
  await page.route("**/api/config", (route) => route.fulfill({ status: 503 }))

  await page.goto("/")
  await expect(page.getByText("Can't reach the CodeCommit server", { exact: true })).toBeVisible()
  await expect(page.getByText("The CodeCommit server answered 503.", { exact: false }).first()).toBeVisible()
  const before = streamCalls
  await page.getByRole("button", { name: "Retry now" }).click()
  await expect.poll(() => streamCalls).toBeGreaterThan(before)
})

test("keeps a failing stream's status clear of the navigation", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) => route.fulfill({ status: 503 }))
  await page.route("**/api/config", (route) => route.fulfill({ status: 503 }))
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ height: 900, width })
    await page.goto("/")
    const status = page.getByRole("status").filter({ hasText: "Reconnecting" })
    await expect(status).toBeVisible()
    // The full detail stays reachable on the status itself.
    await expect(status).toHaveAttribute("title", "The CodeCommit server answered 503.")
    const nav = await page.getByRole("navigation", { name: "Primary" }).boundingBox()
    const box = await status.boundingBox()
    expect((nav?.x ?? 0) + (nav?.width ?? 0)).toBeLessThanOrEqual(box?.x ?? 0)
  }
})

test("sends a first run with no AWS profiles to setup, which shows where it looked", async ({ page }) => {
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  await page.route("**/api/config", (route) => route.fulfill({ json: config }))
  await page.route("**/api/config/path", (route) =>
    route.fulfill({
      json: {
        awsProfileSources: { config: "/home/new/.aws/config", credentials: "/home/new/.aws/credentials" },
        exists: false,
        path: "/home/new/.codecommit/config.json"
      }
    }))

  await page.goto("/")
  await expect(page.getByText("No AWS profiles yet", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Set up accounts" }).click()

  await expect(page.getByText("No AWS profiles found", { exact: true })).toBeVisible()
  await expect(page.getByText("/home/new/.aws/config", { exact: true })).toBeVisible()
  await expect(page.getByText("aws configure sso", { exact: false })).toBeVisible()
  await expect(page.getByText("Not logged in")).toBeHidden()
})

test("reports Detect again only once the re-read finished", async ({ page }) => {
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  const reread = Promise.withResolvers<void>()
  let configReads = 0
  await page.route("**/api/config", async (route) => {
    configReads += 1
    if (configReads > 1) await reread.promise
    await route.fulfill({ json: config })
  })

  await page.goto("/settings/accounts")
  await page.getByRole("button", { name: "Detect again" }).click()
  await expect(page.getByRole("button", { name: "Detecting…" })).toBeDisabled()
  await expect(page.getByText("still no profiles", { exact: false })).toHaveCount(0)
  reread.resolve()
  await expect(page.getByRole("status").filter({ hasText: "still no profiles" })).toBeVisible()
})

test("with auto-detect off, detecting switches it on before reading again", async ({ page }) => {
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  const saves: Array<string> = []
  let configReads = 0
  await page.route("**/api/config", (route) => {
    configReads += 1
    return route.fulfill({ json: { ...config, autoDetect: saves.length === 0 ? false : true } })
  })
  await page.route("**/api/config/save", (route) => {
    saves.push(route.request().postData() ?? "")
    return route.fulfill({ json: "saved" })
  })

  await page.goto("/settings/accounts")
  await page.getByRole("button", { name: "Turn on auto-detect and detect" }).click()
  await expect.poll(() => saves.length).toBe(1)
  expect(JSON.parse(saves[0]!).autoDetect).toBe(true)
  await expect.poll(() => configReads).toBeGreaterThan(1)
  await expect(page.getByRole("status").filter({ hasText: "still no profiles" })).toBeVisible()
})

test("detecting right after unticking auto-detect sends one save, with auto-detect on", async ({ page }) => {
  await page.clock.install()
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  await page.route("**/api/config", (route) => route.fulfill({ json: config }))
  const saves: Array<{ readonly autoDetect: boolean }> = []
  await page.route("**/api/config/save", (route) => {
    saves.push(JSON.parse(route.request().postData() ?? "{}"))
    return route.fulfill({ json: "saved" })
  })

  await page.goto("/settings/accounts")
  await page.getByRole("checkbox", { name: "Add new profiles from your AWS configuration automatically" }).click()
  // Within the debounce: the unticked choice is still waiting to be saved.
  await page.getByRole("button", { name: "Turn on auto-detect and detect" }).click()
  await expect(page.getByRole("status").filter({ hasText: "still no profiles" })).toBeVisible()
  await page.clock.runFor(2_000)
  expect(saves.map((save) => save.autoDetect)).toEqual([true])
})

test("keeps the auto-detect choice, and an account switched next saves it too", async ({ page }) => {
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  await page.route(
    "**/api/config",
    (route) =>
      route.fulfill({ json: { ...config, accounts: [{ enabled: false, profile: "dev", regions: ["eu-central-1"] }] } })
  )
  const saves: Array<{ readonly autoDetect: boolean }> = []
  await page.route("**/api/config/save", (route) => {
    saves.push(JSON.parse(route.request().postData() ?? "{}"))
    return route.fulfill({ json: "saved" })
  })

  await page.goto("/settings/accounts")
  const autoDetect = page.getByRole("checkbox", { name: "Add new profiles from your AWS configuration automatically" })
  await autoDetect.click()
  await expect(autoDetect).not.toBeChecked()
  await expect.poll(() => saves.length).toBe(1)
  await page.getByRole("switch", { name: /^dev/ }).click()
  await expect.poll(() => saves.length).toBe(2)
  expect(saves.map((save) => save.autoDetect)).toEqual([false, false])
  await expect(autoDetect).not.toBeChecked()
})

test("finishes a switched-on account's save after leaving Settings", async ({ page }) => {
  await page.clock.install()
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  await page.route(
    "**/api/config",
    (route) =>
      route.fulfill({ json: { ...config, accounts: [{ enabled: false, profile: "dev", regions: ["eu-central-1"] }] } })
  )
  const held = Promise.withResolvers<void>()
  const saved: Array<string> = []
  const aborted: Array<string> = []
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/config/save")) aborted.push(request.failure()?.errorText ?? "failed")
  })
  await page.route("**/api/config/save", async (route) => {
    await held.promise
    await route.fulfill({ json: "saved" }).then(() => saved.push(route.request().postData() ?? ""), () => {})
  })

  await page.goto("/settings/accounts")
  await page.getByRole("switch", { name: /^dev/ }).click()
  // Leave before the debounce fires; the save starts on the way out and must outlive the page.
  await page.getByRole("link", { name: "Pull requests" }).first().click()
  await expect(page.getByRole("switch", { name: /^dev/ })).toHaveCount(0)
  await page.clock.runFor(5_000)
  held.resolve()
  await expect.poll(() => saved.length).toBe(1)
  expect(JSON.parse(saved[0]!).accounts[0].enabled).toBe(true)
  expect(aborted).toEqual([])
})

const withPrompt = (category: "read" | "write", operation: string, context: string) => ({
  ...emptySnapshot,
  accounts: [{ enabled: true, profile: "dev", region: "eu-central-1" }],
  enabledProfiles: ["dev"],
  permissionPrompt: { category, context, id: "prompt-1", operation }
})

test("asks for a read inline, so the first account isn't blocked by a modal", async ({ page }) => {
  await routeCommon(page)
  const calls: Array<string> = []
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${JSON.stringify(withPrompt("read", "getCallerIdentity", "Get identity for dev"))}\n\n`,
      contentType: "text/event-stream"
    }))
  await page.route("**/api/config", (route) => route.fulfill({ json: config }))
  await page.route("**/api/permissions/category", (route) => {
    calls.push(`category ${route.request().postData() ?? ""}`)
    return route.fulfill({ json: "ok" })
  })
  await page.route("**/api/permissions/respond", (route) => {
    calls.push(`respond ${route.request().postData() ?? ""}`)
    return route.fulfill({ json: "ok" })
  })

  await page.goto("/")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByText("Waiting for your permission", { exact: true })).toBeVisible()
  await expect(page.getByText("CodeCommit asks before reading from AWS: Get identity for dev.", { exact: false }))
    .toBeVisible()
  await page.getByRole("button", { name: "Allow every read" }).click()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]).toContain("\"category\":\"read\"")
  expect(calls[0]).toContain("\"state\":\"always_allow\"")
  // Saving the grant releases every waiting read on the server; the bar sends no answer of its own.
  await expect.poll(() => calls.length, { timeout: 1_000 }).toBe(1)
})

test("still asks for each write in a modal, with Allow once as the default", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${JSON.stringify(withPrompt("write", "createPullRequest", "Create PR on payments"))}\n\n`,
      contentType: "text/event-stream"
    }))
  await page.route("**/api/config", (route) => route.fulfill({ json: config }))

  await page.goto("/")
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByRole("button", { name: "Allow once" })).toBeFocused()
})

test("lists each profile as a switch named by its row, big enough to hit", async ({ page }) => {
  await routeCommon(page)
  await page.route(
    "**/api/events/",
    (route) => route.fulfill({ body: `data: ${JSON.stringify(emptySnapshot)}\n\n`, contentType: "text/event-stream" })
  )
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: { ...config, accounts: [{ enabled: false, profile: "dev-administratoraccess", regions: ["eu-central-1"] }] }
    }))

  await page.goto("/settings")
  const toggle = page.getByRole("switch", { name: /^dev-administratoraccess/ })
  await expect(toggle).not.toBeChecked()
  const row = await toggle.evaluate((element) => element.closest("label")?.getBoundingClientRect().height ?? 0)
  expect(row).toBeGreaterThanOrEqual(32)
  await expect(page.getByRole("checkbox", { name: "Add new profiles from your AWS configuration automatically" }))
    .toBeChecked()
})
