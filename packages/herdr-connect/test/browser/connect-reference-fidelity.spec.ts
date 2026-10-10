/** Reference fixtures use the design's recorded identities and times, mounted without a hub masthead. */
import { agentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work/model"
import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { ConnectAgent } from "../../src/model.js"

test.use({ locale: "en-GB", timezoneId: "UTC" })

const at = (hour: number, minute: number) => Date.UTC(2026, 9, 10, hour, minute)
const agent = (
  name: string,
  state: string,
  host: string,
  work: string,
  hour: number,
  minute: number,
  parent?: string,
  relation = "delegated"
) => {
  const fields = { id: `agent-${name}`, name, state, host, work, kind: "claude", lastActivityAt: at(hour, minute) }
  return Schema.decodeUnknownSync(ConnectAgent)(
    parent === undefined ? fields : {
      ...fields,
      relationship: { parentAgentId: `agent-${parent}`, relation }
    }
  )
}
const base = [
  agent("sec-cc", "waiting", "atlas", "sec-cc", 13, 58),
  agent("pair-codex", "idle", "atlas", "paired-session", 13, 55, "sec-cc", "pair"),
  agent("rev-usage", "blocked", "birch", "flake-fixes", 13, 41),
  agent("ds-rly", "working", "atlas", "design-sync", 14, 2),
  agent("skills", "ready", "atlas", "skills-daily", 11, 47),
  agent("pkgsrc", "done", "birch", "pkgsrc", 12, 10)
]
const worker = (name: string) =>
  Schema.decodeUnknownSync(AgentWorkerIdentity)({
    host: name === "rev-usage" ? "birch" : "atlas",
    agentId: `agent-${name}`,
    name,
    paneId: "w1:p1"
  })
const goal = (name: string, number: number, title: string) =>
  Schema.decodeUnknownSync(WorkGoal)({
    id: `WK-${String(number)}`,
    title: `WK-${String(number)} ${title}`,
    summary: title,
    detail: title,
    state: "working",
    owner: { id: `owner-${name}`, name },
    repository: { repository: "package", branch: "feat/fix" },
    delivery: "pull_request",
    blocker: null,
    spend: null,
    createdAt: at(13, 0),
    updatedAt: at(14, 0),
    agentHierarchy: { agent: worker(name) },
    connectTarget: agentConnectTarget(worker(name)),
    review: {
      state: "requested",
      summary: null,
      updatedAt: at(14, 0),
      url: `https://github.com/example/package/pull/${String(number)}`
    }
  })
const goals = [
  goal("ds-rly", 198, "Ship rly 0.19 design sync"),
  goal("sec-cc", 205, "Harden hub auth"),
  goal("rev-usage", 212, "Fix offline-backup flake")
]
const work = Schema.decodeUnknownSync(WorkSnapshots)({
  observedAt: at(14, 2),
  now: { window: "now", observedAt: at(14, 2), asOf: at(14, 2), goals },
  day: { window: "day", observedAt: at(14, 2), asOf: at(14, 2), goals: [] },
  week: { window: "week", observedAt: at(14, 2), asOf: at(14, 2), goals: [] },
  month: { window: "month", observedAt: at(14, 2), asOf: at(14, 2), goals: [] }
})

const extras = (state: string): ReadonlyArray<ConnectAgent> =>
  state === "2s"
    ? [
      agent("lint-fix", "working", "birch", "lint-sweep", 13, 50, "coord-old", "pair"),
      agent("rev-lint", "ready", "birch", "lint-review", 13, 12, "coord-old", "review")
    ]
    : state === "2t"
    ? [
      agent("lint-sub", "working", "atlas", "lint-sweep", 13, 57, "pair-codex", "pair"),
      agent("fmt-sub", "ready", "atlas", "format-pass", 13, 56, "lint-sub", "review")
    ]
    : state === "2u"
    ? [
      agent("rev-auth", "working", "atlas", "auth-review", 13, 59, "sec-cc", "review"),
      ...["child-a", "child-b", "child-c"].map((name) =>
        agent(name, "ready", "atlas", "package-work", 13, 40, "sec-cc")
      )
    ]
    : []

/** Wait for the real Geist face before recording pixels; production's swap policy is unchanged. */
const prepare = async (page: Page, width: number, theme: string) => {
  await page.setViewportSize({ width: width + 2, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme === "dark" ? "dark" : "light" })
  await page.clock.install({ time: Date.UTC(2026, 9, 10, 14, 2, 31) })
  await page.clock.setFixedTime(Date.UTC(2026, 9, 10, 14, 2, 31))
  await page.route("**/v1/work", (route) => route.fulfill({ json: work }))
  await page.route("**/assets/connect.css", async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: (await response.text()).replaceAll(/font-display:\s*(?:swap|optional)/g, "font-display:block")
    })
  })
  await page.route("**/v1/connect/limits", (route) =>
    route.fulfill({
      json: {
        hosts: [
          {
            host: "atlas",
            readAt: at(14, 2),
            reading: {
              _tag: "Read",
              skipped: 0,
              limits: {
                v: 1,
                machine: "atlas",
                observedAt: at(14, 2),
                latest: [
                  {
                    agent: "claude",
                    machine: "atlas",
                    source: "claude-oauth-usage",
                    label: "seven_day",
                    windowMinutes: 10080,
                    observedAt: at(14, 2),
                    reading: { _tag: "Known", usedPercent: 48, resetsAt: at(18, 2) }
                  },
                  {
                    agent: "codex",
                    machine: "atlas",
                    source: "codex-rollout",
                    label: "seven_day",
                    windowMinutes: 10080,
                    observedAt: at(14, 2),
                    reading: { _tag: "Known", usedPercent: 31, resetsAt: at(18, 2) }
                  }
                ]
              }
            }
          }
        ],
        failures: [],
        peersListed: true
      }
    }))
}
const mount = async (page: Page, theme: string) => {
  await page.goto("/?embedded")
  await page.locator("body").evaluate((body, value) => body.setAttribute("data-rly-theme", value), theme)
  await page.locator("#fleet-connect-root").evaluate((root) => root.classList.add("fleet-shell-main"))
  // The design export includes the device frame's border; the capture has no invented hub shell.
  await page.addStyleTag({
    content:
      "#fleet-connect-root { border: 1px solid var(--rly-color-border-1); padding-block: 0; } body.connect-body { overflow: visible; }"
  })
  await page.evaluate(() => document.fonts.ready)
}

/** Export frame heights include the 98px masthead; capture the actual bounded directory below it. */
const states = {
  "2a": 1064,
  "2b": 647,
  "2c": 358,
  "2d": 1130,
  "2e": 1236,
  "2f": 462,
  "2g": 588,
  "2h": 1176,
  "2i": 1064,
  "2i-v2": 1064,
  "2i-v3": 1064,
  "2i-v4": 1064,
  "2i-v4-missing": 1064,
  "2i-v4-ambiguous": 1064,
  "2i-v4-unavailable": 1064,
  "2i-v4-stale": 1064,
  "2j": 1064,
  "2o": 1097,
  "2p": 1268,
  "2q": 1170,
  "2q-v2": 712,
  "2r": 1065,
  "2s": 1285,
  "2t": 1272,
  "2u": 1205
}
for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (const [state, frameHeight] of Object.entries(states)) {
      test(`reference ${state} ${String(width)} ${theme}`, async ({ page }, testInfo) => {
        await prepare(page, width, theme)
        if (state.startsWith("2i")) {
          await page.setViewportSize({ width: width + 2, height: width === 1280 ? 1064 : 1164 })
        } else if (width === 1280) {
          await page.setViewportSize({ width: width + 2, height: frameHeight - 100 })
        }
        if (state === "2i-v4-unavailable") await page.route("**/v1/work", (route) => route.fulfill({ status: 503 }))
        if (state === "2i-v4-missing" || state === "2i-v4-ambiguous") {
          const snapshot = Schema.decodeUnknownSync(WorkSnapshots)({
            ...work,
            now: {
              ...work.now,
              goals: state === "2i-v4-missing"
                ? []
                : [goal("ds-rly", 198, "Ship rly 0.19 design sync"), goal("ds-rly", 199, "Another linked goal")]
            }
          })
          await page.route("**/v1/work", (route) => route.fulfill({ json: snapshot }))
        }
        let failed = false
        let agents: ReadonlyArray<ConnectAgent> = [...base, ...extras(state)]
        if (state === "2f") agents = []
        if (state === "2p") {
          agents = [
            agent(
              "coordinator-for-monster-banana-builder-review",
              "waiting",
              "monster-banana-builder",
              "nightly-dependency-refresh-and-lockfile-reconciliation-across-workspaces",
              13,
              20
            ),
            ...base
          ]
        }
        if (state === "2h") {
          agents = base.map((entry) =>
            entry.name === "pair-codex"
              ? { ...entry, host: "birch" }
              : entry.name === "rev-usage"
              ? { ...entry, relationship: { parentAgentId: entry.id, relation: "review" } }
              : entry.name === "ds-rly"
              ? { ...entry, relationship: { parentAgentId: "agent-coord-old", relation: "delegated" } }
              : entry
          )
        }
        if (state === "2h") agents = [...agents, ...agents.filter((entry) => entry.name === "pkgsrc")]
        await page.route("**/v1/connect/agents", (route) => {
          if (state === "2b") return
          if (state === "2c" || (failed && (state === "2d" || state === "2i-v4-stale"))) {
            return route.fulfill({ status: 503, body: "timeout" })
          }
          return route.fulfill({
            json: {
              agents,
              failures: failed && state === "2e" ? [{ host: "cedar", reason: "offline" }] : [],
              nextCursor: null
            }
          })
        })
        if (state === "2o") await page.route("**/v1/connect/limits", (route) => route.fulfill({ status: 503 }))
        await mount(page, theme)
        if (state === "2b") await expect(page.getByText("Loading fleet agents…")).toBeVisible()
        else if (state === "2c") {
          await expect(page.getByRole("button", { name: "Retry directory" })).toBeVisible()
          await expect(page.locator(".connect-directory-error")).toContainText("HTTP 503")
        } else if (state === "2f") await expect(page.getByText("No agents running on any host.")).toBeVisible()
        else {
          await expect(page.locator(".connect-family").first()).toBeVisible()
          if (state === "2h") {
            await expect(page.locator(".connect-agent")).toHaveCount(7)
            await expect(page.locator(".connect-agent[data-lineage-issue=\"cross_host\"]")).toBeEnabled()
            await expect(page.locator(".connect-agent[data-lineage-issue=\"cycle\"]")).toBeEnabled()
            for (const row of await page.locator(".connect-agent:not([data-lineage-issue=\"none\"])").all()) {
              const issue = row.locator(".connect-agent-issue")
              await expect(issue).toBeVisible()
              await expect(issue).toHaveAttribute("data-tone", "caution")
              await expect(issue.locator("svg")).toHaveCount(1)
              const issueBox = await issue.boundingBox()
              const metaBox = await row.locator("small").boundingBox()
              expect(issueBox).not.toBeNull()
              expect(metaBox).not.toBeNull()
              if (issueBox !== null && metaBox !== null) {
                expect(issueBox.y).toBeGreaterThanOrEqual(metaBox.y + metaBox.height)
              }
            }
            for (const row of await page.locator(".connect-agent[data-agent-key=\"birch:agent-pkgsrc\"]").all()) {
              await expect(row).toBeDisabled()
              await expect(row).toContainText("Can't open: this host lists the same agent identity more than once.")
            }
            await page.locator(".connect-agent[data-lineage-issue=\"cycle\"]").click()
            await expect(page.getByRole("dialog", { name: "rev-usage" })).toBeVisible()
            await page.keyboard.press("Escape")
            const cyclicRow = page.locator(".connect-agent[data-lineage-issue=\"cycle\"]")
            await expect(cyclicRow).toBeFocused()
            await cyclicRow.evaluate((row) => row.blur())
          }
          if (state === "2d" || state === "2e" || state === "2i-v4-stale") {
            failed = true
            await page.clock.fastForward(5_100)
            await expect(page.locator(state !== "2e" ? ".connect-updated" : ".connect-failures")).toContainText(
              state !== "2e" ? "Stale" : "cedar"
            )
          }
          if (["2q", "2q-v2", "2e", "2g", "2p"].includes(state)) {
            await page.getByRole("button", { name: "Filters", exact: true }).click()
          }
          if (state === "2q-v2" || state === "2g") {
            await page.getByRole("button", { name: "birch", exact: true }).click()
            await page.getByRole("button", { name: /^Filters/ }).click()
            if (state === "2g") await page.getByRole("searchbox").fill("zzz")
          }
          if (state === "2j") {
            await page.locator(".connect-agent[data-agent-key=\"atlas:agent-ds-rly\"]").click()
            await page.getByRole("button", { name: "Pin", exact: true }).click()
            await page.keyboard.press("Escape")
          }
          if (state.startsWith("2i")) {
            const key = state === "2i-v2"
              ? "atlas:agent-sec-cc"
              : state === "2i-v3"
              ? "birch:agent-rev-usage"
              : "atlas:agent-ds-rly"
            await page.locator(`.connect-agent[data-agent-key="${key}"]`).click()
            if (state === "2i-v2") await page.getByRole("button", { name: "Pin", exact: true }).click()
            if (state === "2i-v4-missing") {
              await expect(page.getByText("No Work goal linked", { exact: true })).toBeVisible()
            } else if (state === "2i-v4-unavailable") {
              await expect(page.getByText("Work goals unavailable right now", { exact: true })).toBeVisible()
            } else if (state === "2i-v4-ambiguous") {
              await expect(page.getByRole("link", { name: "Choose one in Work" })).toHaveAttribute(
                "href",
                "/?tab=work&window=now"
              )
              await expect(page.getByText("Several Work goals match this agent", { exact: true })).toBeVisible()
            } else await expect(page.locator(".connect-stage-goal")).toBeVisible()
            if (state === "2i-v4-stale") {
              await expect(page.locator(".connect-stage-speech")).toContainText("Last known: Working")
            }
            await page.addStyleTag({ content: ".connect-stage-sheet { border: 1px solid var(--rly-color-border-1); }" })
            const sheet = await page.locator(".connect-stage-sheet").boundingBox()
            expect(sheet?.width).toBe(Math.min(width + 2, 480))
            expect((await page.locator(".connect-stage-hero").boundingBox())?.height).toBe(176)
          }
          if (state === "2t") {
            await expect(page.locator(".connect-agent[data-agent-key=\"atlas:agent-fmt-sub\"]")).toBeVisible()
            await expect(page.getByRole("button", { name: "Nested deeper: open lint-sub →" })).toBeVisible()
          }
          if (state === "2u") {
            const more = page.getByRole("button", { name: "Show 3 more", exact: true })
            await expect(more).toBeVisible()
            const buttonBox = await more.boundingBox()
            const familyBox = await more.locator("..").boundingBox()
            expect(buttonBox).not.toBeNull()
            expect(familyBox).not.toBeNull()
            if (buttonBox !== null && familyBox !== null) expect(buttonBox.width).toBeLessThan(familyBox.width / 2)
          }
          if (state === "2r") await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
        }
        await expect(page.locator(".connect-cast-member small")).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        await page
          .locator(state.startsWith("2i") ? ".connect-stage-sheet" : "#fleet-connect-root")
          .screenshot({ path: testInfo.outputPath(`fidelity/connect-${state}-${String(width)}-${theme}.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2)
        if (state === "2a") {
          const title = page.getByRole("heading", { name: /Connect/ })
          await expect(title).toHaveText("Connect 2 need you")
          expect(
            await page.locator(".connect-attention-count").evaluate((node) =>
              getComputedStyle(node, "::before").content
            )
          ).toBe("\" ·\"")
          const columns = await page
            .locator(".connect-agent-list")
            .evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(" ").length)
          expect(columns).toBe(1)
          await expect(page.locator(".connect-family-count")).toHaveText("6 agents in 5 families")
          expect(
            await page.locator(".connect-agent small .connect-row-separator").evaluateAll((separators) =>
              separators.every((separator) => !(separator.previousSibling?.textContent ?? "").endsWith(" "))
            )
          ).toBe(true)
          const inputBox = await page.getByRole("searchbox").boundingBox()
          const filterBox = await page.getByRole("button", { name: "Filters", exact: true }).boundingBox()
          expect(inputBox).not.toBeNull()
          expect(filterBox).not.toBeNull()
          if (inputBox !== null && filterBox !== null) expect(filterBox.height).toBe(inputBox.height)
          if (width === 1280) await expect(page.locator(".connect-search-shortcut")).toBeVisible()
          else await expect(page.locator(".connect-search-shortcut")).toBeHidden()
        }
      })
    }
  }
}
