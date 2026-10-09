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
  ).toBeVisible()
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
  // The queue's panel names the cause; the header keeps it on its status (inline only on wide screens).
  await expect(
    page.getByRole("main").getByText("The CodeCommit server answered 503.", { exact: false }).first()
  ).toBeVisible()
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
    await route.fulfill({ json: "saved" }).then(
      () => saved.push(route.request().postData() ?? ""),
      () => {}
    )
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

test("names every read waiting behind the shown one, so one grant clearly answers them all", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({
          ...withPrompt("read", "getCallerIdentity", "Get identity for dev"),
          pendingReads: { contexts: ["Get identity for dev", "List PRs for dev"], count: 2 }
        })
      }\n\n`,
      contentType: "text/event-stream"
    }))
  await page.route("**/api/config", (route) => route.fulfill({ json: config }))

  await page.goto("/")
  await expect(
    page.getByText("2 reads are waiting: Get identity for dev and List PRs for dev.", { exact: false })
  ).toBeVisible()
})

test("tells a signed-out browser in Settings how to sign in, not to check the config file", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) => route.fulfill({ status: 401 }))
  await page.route("**/api/config", (route) => route.fulfill({ status: 401 }))
  await page.route("**/api/config/path", (route) => route.fulfill({ status: 401 }))

  await page.goto("/settings/accounts")
  await expect(page.getByText("This browser isn't signed in", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("config.json", { exact: false })).toHaveCount(0)
})

test("says it is checking sign-in until an account's identity read answers", async ({ page }) => {
  await routeCommon(page)
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${JSON.stringify({ ...emptySnapshot, enabledProfiles: ["dev"] })}\n\n`,
      contentType: "text/event-stream"
    }))
  await page.route(
    "**/api/config",
    (route) =>
      route.fulfill({ json: { ...config, accounts: [{ enabled: true, profile: "dev", regions: ["eu-central-1"] }] } })
  )

  await page.goto("/settings/accounts")
  await expect(page.getByText("Checking sign-in…", { exact: true })).toBeVisible()
  await expect(page.getByText("Not logged in", { exact: true })).toHaveCount(0)
})

// A read prompt arrives after the page has painted: docked to the bottom edge, it never moves the page.
test("docks the read prompt so a late one doesn't push the page down", async ({ page }) => {
  await routeCommon(page)
  let prompt = false
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify(
          prompt ? withPrompt("read", "getCallerIdentity", "Get identity for dev") : emptySnapshot
        )
      }\n\n`,
      contentType: "text/event-stream"
    }))
  await page.route(
    "**/api/config",
    (route) =>
      route.fulfill({ json: { ...config, accounts: [{ enabled: true, profile: "dev", regions: ["eu-central-1"] }] } })
  )
  await page.setViewportSize({ height: 800, width: 390 })

  await page.goto("/settings/accounts")
  const heading = page.getByRole("heading", { level: 1 })
  const before = (await heading.boundingBox())?.y
  prompt = true
  await page.reload()
  const bar = page.locator("[data-needs-answer]")
  await expect(bar).toBeVisible()
  expect((await heading.boundingBox())?.y).toBe(before)
  expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe("fixed")
  // The page keeps the bar's height free at its end, so its last row isn't hidden under it.
  const room = await page.locator("main").evaluate((main) => Number.parseFloat(getComputedStyle(main).paddingBottom))
  expect(room).toBeGreaterThanOrEqual((await bar.boundingBox())?.height ?? Number.POSITIVE_INFINITY)
  await expect(page.getByText("Waiting for read permission", { exact: true })).toBeVisible()
  // On a desktop width Relay's overlay ends above the bar, never on its answers. (At phone width Relay is a
  // full-screen dialog instead, and the bar waits behind it until Relay closes.)
  await page.setViewportSize({ height: 800, width: 1280 })
  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Relay/ })
    .click()
  const panel = page.getByRole("complementary", { exact: true, name: "Relay" })
  await expect(panel).toBeVisible()
  // Measured once its entrance animation has settled.
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  const panelBox = await panel.boundingBox()
  const barBox = await bar.boundingBox()
  // The bar's box includes its 8px clear band, so a panel ending at its top keeps that gap from the notice.
  expect((panelBox?.y ?? Number.POSITIVE_INFINITY) + (panelBox?.height ?? 0)).toBeLessThanOrEqual(barBox?.y ?? 0)
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible()
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
  await expect(
    page.getByText("Allow CodeCommit to read from AWS: Get identity for dev?", { exact: false })
  ).toBeVisible()
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
  await expect(
    page.getByRole("checkbox", { name: "Add new profiles from your AWS configuration automatically" })
  ).toBeChecked()
})
