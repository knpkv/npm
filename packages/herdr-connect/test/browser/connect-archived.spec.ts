/** Archived records are read through the real HTTP boundary and rendered without active-agent actions. */
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { strict as assert } from "node:assert"
import {
  ArchivedConnectAgent,
  ConnectAgent,
  ConnectArchivePage,
  connectArchivePageMaxRecords
} from "../../src/model.js"
import { referenceCreatureIdentities } from "../reference-creature-identities.js"
import { expectReferenceCreatureIdentity } from "./reference-creature-identity.js"

test.use({ locale: "en-GB", timezoneId: "UTC" })

const now = Date.UTC(2026, 9, 11, 12, 40)
const words =
  "Approved the hub auth change with two nits left as review comments: the token refresh path should log the host name, and the retry ceiling belongs in config, not code. Nothing else blocks the merge."
const closed = (
  name: string,
  host: string,
  hours: number,
  text?: string,
  kind = "worker",
  state = "working"
) => {
  const hue = referenceCreatureIdentities.find((entry) => entry.host === host && entry.name === name)?.family
  const fields = {
    host,
    agentId: `agent-${name}`,
    name,
    kind,
    work: name === "rev-auth" ? "auth-review" : "package-work",
    state,
    firstSeenAt: Math.min(Date.UTC(2026, 9, name === "rev-auth" ? 9 : 7, 14, 2), now - (hours + 1) * 3_600_000),
    closedAt: now - hours * 3_600_000
  }
  const colored = hue === undefined ? fields : { ...fields, hue }
  const spoken = text === undefined
    ? colored
    : { ...colored, lastWords: { text, createdAt: now - hours * 3_600_000 - 60_000 } }
  return Schema.decodeUnknownSync(ArchivedConnectAgent)(
    name === "rev-auth"
      ? { ...spoken, relationship: { parentAgentId: "agent-sec-cc", relation: "review" } }
      : spoken
  )
}
const reviewed = closed("rev-auth", "atlas", 3, words, "reviewer", "done")
const records = [
  reviewed,
  closed(
    "flake-hunt",
    "birch",
    5,
    "Stopped: the offline-backup test still fails on the third retry. Log saved before closing.",
    "worker",
    "blocked"
  ),
  closed("lint-sub", "atlas", 6),
  closed(
    "pkg-bump",
    "birch",
    24,
    "Waiting on a lockfile decision; closing so birch can be drained.",
    "worker",
    "waiting"
  ),
  closed("skills-nightly", "atlas", 25, undefined, "worker", "ready"),
  closed("coord-old", "birch", 48, "Handed lint-sweep to lint-fix and rev-lint.", "coordinator"),
  closed("cedar-probe", "cedar", 49, "cedar stopped answering; closing the probe.")
]
/** A1/A6 show a full loaded page whose cursor promises more pages, with the reference rows first. */
const firstPage = [
  ...records,
  ...Array.from(
    { length: connectArchivePageMaxRecords - records.length },
    (_, index) => closed(`older-worker-${String(index + 1)}`, "fixture-host", index + 50)
  )
]
const historical = (name: string, host: string, days: number, text?: string, kind = "worker") => {
  const fixture = closed(name, host, 1, text, kind)
  const fields = { ...fixture, firstSeenAt: now - 50 * 86_400_000, closedAt: now - days * 86_400_000 }
  return fixture.lastWords === undefined ? fields : {
    ...fields,
    lastWords: { text: fixture.lastWords.text, createdAt: fields.closedAt - 60_000 }
  }
}
const fullPage = [
  ...Array.from(
    { length: 58 },
    (_, index) => closed(`closed-worker-${String(index + 1)}`, index % 2 === 0 ? "atlas" : "birch", index + 1)
  ),
  historical("deps-audit", "atlas", 38, "Audit filed: three packages pinned, none vulnerable."),
  historical("ci-cache", "birch", 39),
  historical("docs-index", "atlas", 39, "Index rebuilt; search now covers the patterns folder."),
  historical("rev-tokens", "atlas", 40, undefined, "reviewer"),
  historical("fmt-pass", "birch", 41),
  historical("release-notes", "atlas", 41, "Drafted notes for rly 0.17 and left them in the release PR.")
]
const live = Schema.decodeUnknownSync(ConnectAgent)({
  host: "atlas",
  id: "agent-sec-cc",
  name: "sec-cc",
  kind: "claude",
  work: "sec-cc",
  state: "waiting",
  lastActivityAt: now
})
const pageOf = (agents: ReadonlyArray<ArchivedConnectAgent>, more = false): ConnectArchivePage => {
  const last = agents.at(-1)
  return Schema.decodeUnknownSync(ConnectArchivePage)({
    agents,
    nextCursor: more && last !== undefined
      ? { host: last.host, agentId: last.agentId, closedAt: last.closedAt }
      : null
  })
}

/** Keep the same frame and font policy as the existing Connect reference captures. */
const prepare = async (page: Page, width = 390, theme = "light") => {
  await page.setViewportSize({ width: width + 2, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme === "dark" ? "dark" : "light" })
  await page.clock.install({ time: now })
  await page.clock.setFixedTime(now)
  await page.route(
    "**/v1/connect/agents*",
    (route) => route.fulfill({ json: { agents: [live], failures: [], nextCursor: null } })
  )
  await page.route(
    "**/v1/connect/limits",
    (route) => route.fulfill({ json: { hosts: [], failures: [], peersListed: true } })
  )
  await page.route("**/assets/connect.css", async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: (await response.text()).replaceAll(/font-display:\s*(?:swap|optional)/g, "font-display:block")
    })
  })
}
const mount = async (page: Page, theme = "light", archived = true, fragment = "") => {
  await page.goto(`${archived ? "/?embedded&view=archived" : "/?embedded"}${fragment}`)
  await page.locator("body").evaluate((body, value) => body.setAttribute("data-rly-theme", value), theme)
  await page.addStyleTag({
    content:
      "#fleet-connect-root { border: 1px solid var(--rly-color-border-1); padding-block: 0; } body.connect-body { overflow: visible; }"
  })
  await page.evaluate(() => document.fonts.ready)
}
const rows = (page: Page) => page.locator(".connect-archive-agent")
const rowNamed = (page: Page, name: string) => rows(page).filter({ has: page.getByText(name, { exact: true }) })
const archiveRoute = (page: Page, data: ConnectArchivePage) =>
  page.route("**/v1/connect/archive*", (route) => route.fulfill({ json: data }))

/** A closed creature has fully shut apertures and no visible state ring or animation, even with motion allowed. */
const expectClosed = async (creature: Locator) => {
  await expect(creature).toHaveAttribute("data-closed", "")
  const appearance = await creature.evaluate((svg) => {
    const style = getComputedStyle(svg)
    const upper = Number.parseFloat(style.getPropertyValue("--connect-creature-lid"))
    const lower = Number.parseFloat(style.getPropertyValue("--connect-creature-lid-low"))
    const isStyleRule = (rule: CSSRule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE
    const isMediaRule = (rule: CSSRule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE
    const isSupportsRule = (rule: CSSRule): rule is CSSSupportsRule => rule.type === CSSRule.SUPPORTS_RULE
    const isGroupingRule = (rule: CSSRule): rule is CSSGroupingRule => "cssRules" in rule
    const liveRules = (rules: CSSRuleList): ReadonlyArray<CSSStyleRule> =>
      [...rules].flatMap((rule) => {
        if (isMediaRule(rule) && !matchMedia(rule.conditionText).matches) return []
        if (isSupportsRule(rule) && !CSS.supports(rule.conditionText)) return []
        if (isStyleRule(rule)) {
          const animation = rule.style.getPropertyValue("animation") || rule.style.getPropertyValue("animation-name")
          return rule.selectorText.includes("connect-creature") && animation.includes("connect-creature-")
            ? [rule]
            : []
        }
        return isGroupingRule(rule) ? liveRules(rule.cssRules) : []
      })
    const activeLiveRules = [...document.styleSheets].flatMap((sheet) => {
      if (sheet.disabled || (sheet.media.length > 0 && !matchMedia(sheet.media.mediaText).matches)) return []
      return liveRules(sheet.cssRules)
    })
    const parts = [svg, ...svg.querySelectorAll("*")]
    return {
      motionAllowed: matchMedia("(prefers-reduced-motion: no-preference)").matches,
      liveRuleCount: activeLiveRules.length,
      // The later fleet-layer reset can hide live selectors matching closed parts. Guard their scope too.
      matchingLiveRules: activeLiveRules.filter((rule) => parts.some((part) => part.matches(rule.selectorText))).map(
        (rule) => ({
          selector: rule.selectorText,
          animation: rule.style.getPropertyValue("animation") || rule.style.getPropertyValue("animation-name")
        })
      ),
      animationCount: svg.getAnimations({ subtree: true }).length,
      animationNames: [
        ...svg.querySelectorAll(".connect-creature-breath, .connect-creature-bob, .connect-creature-lid")
      ].map((node) => getComputedStyle(node).animationName),
      motionParts: [".connect-creature-breath", ".connect-creature-bob", ".connect-creature-lid"].map((selector) => ({
        selector,
        count: svg.querySelectorAll(selector).length
      })),
      rings: [...svg.querySelectorAll(".connect-creature-halo, .connect-creature-orbit")].map((ring) => {
        const current = getComputedStyle(ring)
        return current.display === "none" || current.visibility === "hidden" ? 0 : Number(current.opacity)
      }),
      lids: [...svg.querySelectorAll("clipPath .connect-creature-lid")].map((lid) => ({
        expected: lid.hasAttribute("data-low") ? lower : upper,
        actual: Number.parseFloat(getComputedStyle(lid).translate.split(" ")[1] ?? "0")
      })),
      lashes: [...svg.querySelectorAll(".connect-creature-lash")].map((lash) => Number(getComputedStyle(lash).opacity))
    }
  })
  if (appearance.motionAllowed) expect(appearance.liveRuleCount).toBeGreaterThan(0)
  expect(appearance.matchingLiveRules, "Live animation selectors must exclude closed SVG parts").toEqual([])
  expect(appearance.animationCount).toBe(0)
  for (const part of appearance.motionParts) expect(part.count, part.selector).toBeGreaterThan(0)
  // Each eye has two aperture lids; visible lid groups may add more without changing the stillness contract.
  expect(appearance.animationNames.length).toBeGreaterThanOrEqual(6)
  for (const name of appearance.animationNames) expect(name).toBe("none")
  for (const opacity of appearance.rings) expect(opacity).toBe(0)
  expect(appearance.lids).toHaveLength(4)
  for (const lid of appearance.lids) expect(lid.actual).toBeCloseTo(lid.expected, 1)
  for (const opacity of appearance.lashes) expect(opacity).toBe(1)
}

for (const theme of ["light", "dark"]) {
  for (const modifier of ["Control", "Meta"]) {
    test(`defensively leaves ${modifier}+K to embedders retaining Archived in a hidden mount, ${theme}`, async ({ page }) => {
      await prepare(page, 390, theme)
      await archiveRoute(page, pageOf(records))
      await mount(page, theme)
      await expect(rows(page)).toHaveCount(records.length)
      // The canonical hub unmounts inactive Connect. This fixture models a different embedder retaining it.
      await page.locator("#fleet-connect-root").evaluate((root) => {
        root.setAttribute("hidden", "")
        const module = document.createElement("section")
        const button = document.createElement("button")
        button.textContent = "Other module"
        const search = document.createElement("input")
        search.setAttribute("aria-label", "Embedding shell search")
        module.append(button, search)
        document.body.append(module)
        // A shell's window listener receives the event after the archive's document listener.
        window.addEventListener("keydown", (event) => {
          if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault()
            search.focus()
          }
        })
      })
      await expect(page.locator(".connect-archive-shell")).toBeHidden()
      await page.getByRole("button", { name: "Other module", exact: true }).focus()
      await page.keyboard.press(`${modifier}+k`)
      await expect(page.getByRole("textbox", { name: "Embedding shell search", exact: true })).toBeFocused()
      await page.locator("#fleet-connect-root").evaluate((root) => root.removeAttribute("hidden"))
      await page.getByRole("button", { name: "Other module", exact: true }).focus()
      await page.keyboard.press(`${modifier}+k`)
      await expect(page.locator("#connect-agent-search")).toBeFocused()
    })
  }

  test(`closed working, waiting and finished creatures stay shut and still with motion allowed, ${theme}`, async ({ page }) => {
    await prepare(page, 390, theme)
    const fixtures = ["working", "waiting", "done"].map((state) =>
      closed(`closed-${state}`, "fixture-host", 1, undefined, "worker", state)
    )
    await archiveRoute(page, pageOf(fixtures))
    // Archived retains the live inventory cache: seed Working before mount, not after switching views.
    await page.route(
      "**/v1/connect/agents*",
      (route) => route.fulfill({ json: { agents: [{ ...live, state: "working" }], failures: [], nextCursor: null } })
    )
    // Mount with motion allowed, rather than sampling a media change after a reduced-motion fixture capture.
    await page.emulateMedia({ reducedMotion: "no-preference" })
    expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: no-preference)").matches)).toBe(true)
    await mount(page, theme)
    await expect(rows(page)).toHaveCount(3)
    for (const state of ["working", "waiting", "done"]) {
      const row = rowNamed(page, `closed-${state}`)
      await expectClosed(row.locator(".connect-creature"))
      await row.click()
      await expectClosed(page.locator(".connect-archive-stage .connect-creature"))
      await page.keyboard.press("Escape")
    }
    // CONNECT-MAP rev6 keeps Waiting still; Working's connect-creature-turn orbit retains its 1800ms clock.
    await page.getByRole("link", { name: "Active", exact: true }).click()
    const active = page.locator(".connect-agent .connect-creature[data-bucket='working']")
    await expect(active).toBeVisible()
    const orbit = active.locator(".connect-creature-orbit")
    await expect(orbit).toHaveCSS("animation-name", "connect-creature-turn")
    await expect(orbit).toHaveCSS("animation-duration", "1.8s")
    expect(await orbit.evaluate((node) => node.getAnimations().length)).toBeGreaterThan(0)
  })
}

test("a parent beyond the first page reopens on refresh; expired selections clear without adding history", async ({ page }) => {
  await prepare(page)
  const parent = closed("older-primary", "fixture-host", 100)
  const child = Schema.decodeUnknownSync(ArchivedConnectAgent)({
    ...closed("newer-child", "fixture-host", 1),
    relationship: { parentAgentId: parent.agentId, relation: "review" }
  })
  const requests: Array<string | null> = []
  await page.route("**/v1/connect/archive*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    requests.push(cursor)
    return route.fulfill({ json: cursor === null ? pageOf([child], true) : pageOf([parent]) })
  })
  await mount(page, "light", true, "#details")
  await page.getByRole("button", { name: "Show older", exact: true }).click()
  await expect(rows(page)).toHaveCount(2)
  await rowNamed(page, "newer-child").click()
  await page.getByRole("dialog").getByRole("link", { name: "older-primary", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveAccessibleName("older-primary")
  requests.length = 0
  await page.reload()
  await expect(page.getByRole("dialog")).toHaveAccessibleName("older-primary")
  expect(requests).toHaveLength(2)
  expect(requests[0]).toBeNull()
  expect(requests[1]).not.toBeNull()
  await page.keyboard.press("Escape")
  const url = new URL(page.url())
  url.searchParams.set("closed", JSON.stringify([parent.host, parent.agentId, 1]))
  await page.goto(url.href)
  await expect(rows(page)).toHaveCount(2)
  await expect.poll(() => new URL(page.url()).searchParams.has("closed")).toBe(false)
  expect(new URL(page.url()).hash).toBe("#details")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("archive view survives Back and refresh while Active remains the default", async ({ page }) => {
  await prepare(page)
  await archiveRoute(page, pageOf(records))
  await mount(page, "light", false)
  await expect(page.getByRole("link", { name: "Active", exact: true })).toHaveAttribute("aria-current", "page")
  await page.getByRole("link", { name: "Archived", exact: true }).click()
  await expect(page).toHaveURL(/view=archived/)
  await expect(rows(page)).toHaveCount(7)
  // A complete no-cursor page remains exact; A1's paginated capture must not replace this case.
  await expect(page.getByText("7 closed agents in the last 90 days", { exact: true })).toBeVisible()
  await expect(page.locator(".connect-archive-scope")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Show older", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(rows(page)).toHaveCount(7)
  await page.getByRole("link", { name: "Active", exact: true }).click()
  await expect(page.locator(".connect-agent")).toHaveCount(1)
  await page.goBack()
  await expect(page).toHaveURL(/view=archived/)
  await expect(rows(page)).toHaveCount(7)
})

test("older page failure keeps loaded rows and Retry repeats its cursor", async ({ page }) => {
  await prepare(page)
  const first = pageOf(records, true)
  const older = closed("older-worker", "atlas", 50, "Older page loaded.")
  const requests: Array<string | null> = []
  let fail = true
  await page.route("**/v1/connect/archive*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    requests.push(cursor)
    if (cursor !== null) await expect(page.getByRole("button", { name: "Show older", exact: true })).toBeDisabled()
    return route.fulfill(cursor === null ? { json: first } : fail ? { status: 503 } : { json: pageOf([older]) })
  })
  await mount(page)
  await expect(page.getByText("7+ closed agents in the last 90 days", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Show older", exact: true }).click()
  await expect(rows(page)).toHaveCount(7)
  const retry = page.getByRole("button", { name: "Retry", exact: true })
  await expect(retry).toBeVisible()
  fail = false
  await retry.click()
  await expect(rows(page)).toHaveCount(8)
  await expect(rowNamed(page, "older-worker")).toBeVisible()
  expect(requests[1]).not.toBeNull()
  expect(requests[2]).toBe(requests[1])
  await expect(page.getByText("8 closed agents in the last 90 days", { exact: true })).toBeVisible()
})

test("search covers loaded archive pages and keeps unloaded scope explicit", async ({ page }) => {
  await prepare(page)
  await archiveRoute(page, pageOf(records, true))
  await mount(page)
  const search = page.getByRole("searchbox")
  await page.keyboard.press("Control+k")
  await expect(search).toBeFocused()
  const searches: ReadonlyArray<readonly [string, number]> = [["atlas", 3], ["reviewer", 1], ["auth-review", 1], [
    "flake-hunt",
    1
  ]]
  for (const [query, count] of searches) {
    await search.fill(query)
    await expect(rows(page)).toHaveCount(count)
  }
  await search.fill("zzz")
  await expect(page.getByText("No loaded closed agents match \"zzz\" in Archived.", { exact: true })).toBeVisible()
  await expect(page.getByText("Search covers loaded archived agents only", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search", exact: true }).click()
  await expect(search).toHaveValue("")
  await expect(rows(page)).toHaveCount(7)
})

for (const more of [false, true]) {
  test(`archive no-match paging keeps the query, cursor present=${String(more)}`, async ({ page }) => {
    await prepare(page)
    const older = closed("older-worker", "fixture-host", 100)
    const requests: Array<string | null> = []
    await page.route("**/v1/connect/archive*", (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      requests.push(cursor)
      return route.fulfill({ json: cursor === null ? pageOf(records, more) : pageOf([older]) })
    })
    await mount(page)
    const search = page.getByRole("searchbox")
    await search.fill("older")
    await expect(rows(page)).toHaveCount(0)
    const showOlder = page.getByRole("button", { name: "Show older", exact: true })
    if (more) {
      // Loading older pages remains available during search; the query also filters the appended page.
      await expect(showOlder).toBeVisible()
      await expect(page.getByText(`Loads the next ${String(connectArchivePageMaxRecords)}.`, { exact: true }))
        .toBeVisible()
      await showOlder.click()
      await expect(rowNamed(page, "older-worker")).toBeVisible()
      await expect(rows(page)).toHaveCount(1)
      await expect(search).toHaveValue("older")
      expect(requests).toHaveLength(2)
      expect(requests[1]).not.toBeNull()
    } else {
      expect(requests).toEqual([null])
    }
    await expect(showOlder).toHaveCount(0)
    await expect(page.locator(".connect-archive-paging")).toHaveCount(0)
  })
}

test("separate closures and a live identity remain distinct; last words render as text", async ({ page }) => {
  await prepare(page)
  const collision = Schema.decodeUnknownSync(ArchivedConnectAgent)({
    ...reviewed,
    closedAt: now - 2 * 3_600_000,
    lastWords: { text: "<img src=x onerror=\"alert(1)\">", createdAt: now - 2 * 3_600_000 - 60_000 }
  })
  const sameLive = Schema.decodeUnknownSync(ArchivedConnectAgent)({
    ...reviewed,
    agentId: live.id,
    name: "closed-primary"
  })
  await archiveRoute(page, pageOf([collision, reviewed, sameLive]))
  await mount(page)
  await expect(rows(page)).toHaveCount(3)
  await expect(rows(page).filter({ hasText: "rev-auth" })).toHaveCount(2)
  await rows(page).filter({ hasText: "<img src=x" }).click()
  await expect(page.getByRole("dialog")).toContainText("<img src=x onerror=\"alert(1)\">")
  await expect(page.getByRole("dialog").locator("img")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await rowNamed(page, "closed-primary").click()
  await expect(page.getByRole("dialog")).toContainText("closed-primary")
  await expect(page.getByRole("button", { name: "Open terminal", exact: true })).toHaveCount(0)
})

for (const fragment of ["", "#details"]) {
  test(`only loaded parents link to a read-only stage; malformed archive data shows Retry (${fragment === "" ? "no fragment" : fragment})`, async ({ page }) => {
    await prepare(page)
    await archiveRoute(
      page,
      pageOf([
        Schema.decodeUnknownSync(ArchivedConnectAgent)({
          ...reviewed,
          relationship: { parentAgentId: "agent-missing-parent", relation: "review" }
        }),
        Schema.decodeUnknownSync(ArchivedConnectAgent)({
          ...reviewed,
          agentId: "agent-child-review",
          name: "child-review",
          relationship: { parentAgentId: reviewed.agentId, relation: "review" }
        })
      ])
    )
    await mount(page, "light", true, fragment)
    await rowNamed(page, "rev-auth").click()
    await expect(page.getByRole("dialog").getByRole("link")).toHaveCount(0)
    await expect(page.getByRole("dialog")).toContainText("agent-missing-parent")
    await page.keyboard.press("Escape")
    await rowNamed(page, "child-review").click()
    const parent = page.getByRole("dialog").getByRole("link", { name: "rev-auth", exact: true })
    const href = await parent.getAttribute("href")
    assert(href !== null, "Loaded parent has no link target")
    const target = new URL(href, page.url())
    expect(target.searchParams.get("closed")).toBe(JSON.stringify([reviewed.host, reviewed.agentId, reviewed.closedAt]))
    expect(target.hash).toBe(fragment)
    await parent.click()
    await expect(page.getByRole("dialog")).toHaveAccessibleName("rev-auth")
    await expect(page.getByRole("dialog").getByRole("link")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open terminal", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has("closed")).toBe(false)
    expect(new URL(page.url()).hash).toBe(fragment)
    await page.reload()
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    // Closing is a directory history entry: Back can revisit the parent; Forward closes it again.
    await page.goBack()
    await expect(page.getByRole("dialog")).toHaveAccessibleName("rev-auth")
    await page.reload()
    await expect(page.getByRole("dialog")).toHaveAccessibleName("rev-auth")
    await page.goForward()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.route(
      "**/v1/connect/archive*",
      (route) => route.fulfill({ json: { agents: [{ name: "broken" }], nextCursor: null } })
    )
    await page.reload()
    await expect(page.getByText("Couldn't load archived agents", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    await expect(page.getByText("No closed agents in the last 90 days", { exact: true })).toHaveCount(0)
  })
}

const frames = ["A1", "A2", "A3", "A3-v2", "A4", "A5", "A6"]
for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`rev6 archived row geometry ${String(width)} ${theme}`, async ({ page }) => {
      await prepare(page, width, theme)
      await archiveRoute(page, pageOf(records))
      await mount(page, theme)
      await expect(rows(page)).toHaveCount(records.length)
      // Rev6 arow: 40px creature in the reference 40-unit frame, 12px padding/gap, 16px/1.3 title and 14px/1.4 last words.
      // A1/A5 raster dividers are 65px apart without words and 86/87px with words.
      const geometry = await rows(page).evaluateAll((nodes) =>
        nodes.map((node) => {
          const creature = node.querySelector<SVGSVGElement>(".connect-creature")
          const style = getComputedStyle(node)
          const metadata = node.querySelector(".connect-archive-row-copy small")
          const body = creature?.querySelector<SVGPathElement>(".connect-creature-body")
          const matrix = body?.getScreenCTM()
          const unit = creature === null || creature === undefined ?
            0
            : Number.parseFloat(getComputedStyle(creature).getPropertyValue("--connect-creature-unit"))
          return {
            designUnit: matrix === null || matrix === undefined ? null : Math.hypot(matrix.a, matrix.b) * unit,
            height: node.getBoundingClientRect().height,
            track: creature?.getBoundingClientRect().width,
            trackHeight: creature?.getBoundingClientRect().height,
            metadataLeading: metadata === null ? null : getComputedStyle(metadata).lineHeight,
            gap: style.columnGap,
            padding: style.paddingInlineStart,
            words: node.querySelector(".connect-archive-last-words") !== null,
            border: Number.parseFloat(style.borderBottomWidth)
          }
        })
      )
      for (const row of geometry) {
        expect(row.track).toBe(40)
        expect(row.trackHeight).toBe(40)
        expect(row.designUnit).toBeCloseTo(40 / 40, 3)
        expect(row.metadataLeading).toBe("16.8px")
        expect(row.gap).toBe("12px")
        expect(row.padding).toBe("12px")
        expect(row.height - row.border).toBeCloseTo(row.words ? 85.2 : 64, 0)
      }
    })

    test(`archive search helper spacing ${String(width)} ${theme}`, async ({ page }) => {
      await prepare(page, width, theme)
      await archiveRoute(page, pageOf(firstPage, true))
      await mount(page, theme)
      await expect(rows(page)).toHaveCount(connectArchivePageMaxRecords)
      const field = await page.getByRole("searchbox").boundingBox()
      const helper = await page.locator(".connect-archive-scope").boundingBox()
      const count = await page.locator(".connect-family-count").boundingBox()
      const list = await page.locator(".connect-archive-list").boundingBox()
      assert(field !== null && helper !== null && count !== null && list !== null, "Archive search layout unavailable")
      // The archive refs put the scope 6px below the field, then retain the directory's 16px rhythm.
      expect.soft(helper.y - field.y - field.height, "Field-to-scope gap").toBeCloseTo(6, 2)
      expect.soft(count.y - helper.y - helper.height, "Scope-to-count gap").toBeCloseTo(16, 2)
      expect.soft(list.y - count.y - count.height, "Count-to-list gap").toBeCloseTo(16, 2)
    })

    test(`archive no-match copy and Clear search hit area ${String(width)} ${theme}`, async ({ page }) => {
      await prepare(page, width, theme)
      await archiveRoute(page, pageOf(firstPage, true))
      await mount(page, theme)
      await page.getByRole("searchbox").fill("zzz")
      await expect(page.locator(".connect-archive-no-match")).toBeVisible()
      const appearance = await page.getByRole("button", { name: "Clear search", exact: true }).evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        const x = bounds.x + bounds.width / 2
        const panel = button.closest(".connect-archive-no-match")
        return {
          height: bounds.height,
          textSize: panel === null ? null : getComputedStyle(panel).fontSize,
          // Six pixels on each side turn the 32px visual control into a distinct 44px target.
          hits: [bounds.y - 5, bounds.y + bounds.height / 2, bounds.y + bounds.height + 5].map((y) =>
            document.elementFromPoint(x, y)?.closest("button") === button
          )
        }
      })
      expect.soft(appearance.textSize).toBe("14px")
      expect.soft(appearance.height).toBeCloseTo(32, 2)
      expect.soft(appearance.hits).toEqual([true, true, true])
    })

    for (const frame of frames) {
      test(`archived reference ${frame} ${String(width)} ${theme}`, async ({ page }, info) => {
        await prepare(page, width, theme)
        if (frame === "A3") await page.route("**/v1/connect/archive*", () => {})
        else if (frame === "A3-v2") {
          await page.route("**/v1/connect/archive*", (route) => route.fulfill({ status: 503 }))
        } else {
          await archiveRoute(
            page,
            frame === "A2"
              ? pageOf([])
              : frame === "A5"
              ? pageOf(fullPage, true)
              : frame === "A1" || frame === "A6"
              ? pageOf(firstPage, true)
              : pageOf(records)
          )
        }
        await mount(page, theme)
        await expect(page.getByRole("link", { name: "Archived", exact: true })).toHaveAttribute("aria-current", "page")
        // Check the tag corner before A4 opens its modal and makes the directory switch inert.
        await expect(page.getByRole("link", { name: "Archived", exact: true })).toHaveCSS("border-radius", "6px")
        if (frame === "A1") await expect(page.locator("header .connect-directory-switch")).toHaveCount(0)
        if (frame === "A2") {
          await expect(page.getByText("No closed agents in the last 90 days", { exact: true })).toBeVisible()
          await expect(page.locator(".connect-archive-empty")).toHaveCSS("border-radius", "14px")
          await expect(page.locator(".connect-archive-empty")).toHaveCSS("font-size", "14px")
        } else if (frame === "A3") {
          await expect(page.getByText("Loading archived agents...", { exact: true })).toBeVisible()
          await expect(page.locator(".connect-archive-skeleton")).toHaveCount(4)
          const skeleton = page.locator(".connect-archive-skeleton").first()
          // Ref A3 uses surface-3, #e8e9ed / #282a31. Resolve through Canvas so OKLCH is compared as paint.
          const fill = await skeleton.evaluate((node) => {
            const canvas = document.createElement("canvas")
            const context = canvas.getContext("2d")
            if (context === null) return null
            context.fillStyle = getComputedStyle(node).backgroundColor
            context.fillRect(0, 0, 1, 1)
            return [...context.getImageData(0, 0, 1, 1).data]
          })
          expect(fill).toEqual(theme === "light" ? [232, 233, 237, 255] : [40, 42, 49, 255])
          await expect(skeleton).toHaveCSS("border-radius", "14px")
        } else if (frame === "A3-v2") {
          await expect(page.getByText("Couldn't load archived agents", { exact: true })).toBeVisible()
          await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
          await expect(page.locator(".connect-archive-error")).toHaveCSS("border-radius", "14px")
          await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCSS("border-radius", "6px")
        } else if (frame === "A6") {
          await page.getByRole("searchbox").fill("zzz")
          await expect(page.getByText("No loaded closed agents match \"zzz\" in Archived.", { exact: true }))
            .toBeVisible()
          await expect(page.getByRole("button", { name: "Clear search", exact: true })).toBeVisible()
          await expect(page.getByText("Search covers loaded archived agents only", { exact: true })).toBeVisible()
          await expect(page.locator(".connect-archive-empty")).toHaveCSS("border-radius", "10px")
          const clear = page.getByRole("button", { name: "Clear search", exact: true })
          await expect(clear).toHaveCSS("border-radius", "6px")
          const clearBox = await clear.boundingBox()
          const emptyBox = await page.locator(".connect-archive-empty").boundingBox()
          expect(clearBox).not.toBeNull()
          expect(emptyBox).not.toBeNull()
          if (clearBox !== null && emptyBox !== null) expect(clearBox.width).toBeLessThan(emptyBox.width / 2)
        } else if (frame === "A5") {
          await expect(rows(page)).toHaveCount(64)
          await expect(rowNamed(page, "release-notes").locator(".connect-archive-last-words")).toHaveText(
            "Drafted notes for rly 0.17 and left them in the release PR."
          )
          await expect(page.getByText("64+ closed agents in the last 90 days", { exact: true })).toBeVisible()
          const helper = page.getByText(`Loads the next ${String(connectArchivePageMaxRecords)}.`, { exact: true })
          // Scroll both owners: desktop retains the directory scroller; phone scrolls the document.
          await page.locator(".connect-archive-directory").evaluate((node) => {
            node.scrollTop = node.scrollHeight
          })
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
          await helper.scrollIntoViewIfNeeded()
          await expect(page.getByRole("button", { name: "Show older", exact: true })).toHaveCSS("border-radius", "6px")
          await expect(helper).toBeVisible()
          await expect(page.getByRole("button", { name: "Show older", exact: true })).toBeVisible()
        } else if (frame === "A4") {
          await expectReferenceCreatureIdentity(
            rowNamed(page, "rev-auth").locator(".connect-creature"),
            "atlas",
            "rev-auth",
            true
          )
          await rowNamed(page, "rev-auth").click()
          const sheet = page.getByRole("dialog")
          await expectReferenceCreatureIdentity(sheet.locator(".connect-creature"), "atlas", "rev-auth", true)
          await expect(sheet).toHaveAccessibleDescription("Reviewer on atlas, archived, read-only")
          await expect(sheet.locator("dt").filter({ hasText: /^Kind$/ }).locator("+ dd")).toHaveText("reviewer")
          await expect(sheet).toContainText("First seen 9 Oct 2026 14:02 → Closed 11 Oct 2026 09:40")
          await expect(sheet).toContainText("State at close")
          await expect(sheet).toContainText("Done")
          await expect(sheet).toContainText("auth-review")
          await expect(sheet).toContainText(words)
          await expect(sheet).toContainText("Said 11 Oct 2026 09:39")
          await expect(sheet.getByRole("link", { name: /sec-cc/ })).toBeVisible()
          expect(
            await sheet.getByRole("link", { name: /sec-cc/ }).evaluate((node) =>
              getComputedStyle(node).textDecorationLine
            )
          ).toContain("underline")
          for (const name of ["Pin", "Open terminal", "Goal", "Notifications"]) {
            await expect(sheet.getByRole("button", { name, exact: true })).toHaveCount(0)
          }
          await page.emulateMedia({ reducedMotion: "no-preference" })
          await expectClosed(sheet.locator("svg.connect-creature"))
          await page.emulateMedia({ forcedColors: "active" })
          const outline = await sheet.locator(".connect-creature-body").evaluate((body) => ({
            stroke: getComputedStyle(body).stroke,
            width: Number.parseFloat(getComputedStyle(body).strokeWidth)
          }))
          expect(outline.stroke).not.toBe("none")
          expect(outline.width).toBeGreaterThan(0)
          await expectClosed(sheet.locator("svg.connect-creature"))
          await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" })
        } else {
          await expect(rows(page)).toHaveCount(connectArchivePageMaxRecords)
          await expect(page.getByText("64+ closed agents in the last 90 days", { exact: true })).toBeVisible()
          await expect(page.getByText("Search covers loaded archived agents only", { exact: true })).toBeVisible()
          await expect(rowNamed(page, "rev-auth").locator(".connect-archive-metadata")).toHaveText(
            "atlas, Reviewer, closed 3h ago"
          )
          await expect(page.locator(".connect-archive-list")).toHaveCSS("border-radius", "10px")
          await expect(rowNamed(page, "lint-sub")).not.toContainText("Last words")
          await page.emulateMedia({ reducedMotion: "no-preference" })
          for (const creature of (await rows(page).locator("svg.connect-creature").all()).slice(0, records.length)) {
            await expectClosed(creature)
          }
          const lastWords = rowNamed(page, "rev-auth").locator(".connect-archive-last-words")
          const truncation = await lastWords.evaluate((node) => ({
            whiteSpace: getComputedStyle(node).whiteSpace,
            overflow: getComputedStyle(node).textOverflow
          }))
          expect(truncation.whiteSpace).toBe("nowrap")
          expect(truncation.overflow).toBe("ellipsis")
          await page.emulateMedia({ reducedMotion: "reduce" })
        }
        await page.evaluate(() => document.fonts.ready)
        const path = info.outputPath(`fidelity/connect-${frame}-${String(width)}-${theme}.png`)
        if (frame === "A5") {
          const tail = await rowNamed(page, "deps-audit").boundingBox()
          const helper = await page.locator(".connect-archive-paging small").boundingBox()
          assert(tail !== null && helper !== null, "Archive tail capture bounds unavailable")
          // The ref frames only the real list end, with 20px above and 32px below its tail content.
          const top = Math.max(0, tail.y - 20)
          await page.screenshot({ path, clip: { x: 1, y: top, width, height: helper.y + helper.height + 32 - top } })
        } else if (frame === "A1" || (frame === "A4" && width === 1280)) {
          // A1 is the visible first page, not a full-height image of all 64 loaded rows.
          // Desktop A4 includes the dimmed directory; phone A4 frames the sheet alone.
          await page.screenshot({ path })
        } else {
          await page.locator(frame === "A4" ? ".connect-archive-stage" : "#fleet-connect-root").screenshot({ path })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2)
        if (frame === "A3-v2") {
          await archiveRoute(page, pageOf(records))
          await page.getByRole("button", { name: "Retry", exact: true }).click()
          await expect(rows(page)).toHaveCount(7)
        }
      })
    }
  }
}
