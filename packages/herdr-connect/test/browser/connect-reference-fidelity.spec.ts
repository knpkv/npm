/** Reference fixtures use the design's recorded identities and times, mounted without a hub masthead. */
import { agentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work/model"
import { expect, type Locator, type Page, test } from "@playwright/test"
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
const tallSeeds = ["134", "313", "509"].map((id) => agent(id, "working", "fixture-host", "package-work", 14, 2))

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

/** Mount the recorded directory for measured fidelity checks without taking a screenshot. */
const openDirectory = async (page: Page, width: number, theme: string, agents = base) => {
  await prepare(page, width, theme)
  await page.route(
    "**/v1/connect/agents",
    (route) => route.fulfill({ json: { agents, failures: [], nextCursor: null } })
  )
  await mount(page, theme)
  await expect(page.locator(".connect-agent")).toHaveCount(agents.length)
}

/** Read screen pixels, including SVG transforms, rather than the path's viewBox coordinates. */
const drawnBox = (node: Locator) =>
  node.evaluate((element) => {
    const { height, width, x, y } = element.getBoundingClientRect()
    return { height, width, x, y }
  })

/** Every ring stroke fits the root, including non-scaling halos in small pins and crew pills. */
const expectRingFitsTrack = async (creature: Locator) => {
  const track = await drawnBox(creature)
  const strokes = await creature.evaluate(
    (svg) =>
      [...svg.querySelectorAll<SVGEllipseElement>(".connect-creature-halo, .connect-creature-orbit")].map(
        (ring) => {
          const style = getComputedStyle(ring)
          const box = ring.getBoundingClientRect()
          const matrix = ring.getScreenCTM()
          const half = Number.parseFloat(style.strokeWidth) / 2
          const margin = style.vectorEffect === "non-scaling-stroke"
            ? half
            : half * Math.hypot(matrix?.a ?? 0, matrix?.b ?? 0)
          return {
            left: box.x - margin,
            right: box.right + margin,
            top: box.y - margin,
            bottom: box.bottom + margin
          }
        }
      )
  )
  for (const stroke of strokes) {
    expect(stroke.left).toBeGreaterThanOrEqual(track.x - 0.05)
    expect(stroke.right).toBeLessThanOrEqual(track.x + track.width + 0.05)
    expect(stroke.top).toBeGreaterThanOrEqual(track.y - 0.05)
    expect(stroke.bottom).toBeLessThanOrEqual(track.y + track.height + 0.05)
  }
}

/** Sample the actual curved outline under the stylesheet's ordinary breath, in the ring's coordinates. */
const measureEnclosure = (creature: Locator, moment: string) =>
  creature.evaluate((svg, phase) => {
    // Hold the ordinary breath at either extreme; arrival motion intentionally leaves the ring.
    for (const animation of svg.getAnimations({ subtree: true })) {
      animation.pause()
      const timing = animation.effect?.getTiming()
      const duration = Number(timing?.duration ?? 0)
      const delay = Number(timing?.delay ?? 0)
      const pairs = Math.ceil(-delay / duration / 2) * 2 * duration
      const name = "animationName" in animation ? String(animation.animationName) : ""
      const fraction = name === "connect-creature-breathe" && phase === "inhale" ? 0.999 : 0.001
      animation.currentTime = pairs + delay + duration * fraction
    }
    const body = svg.querySelector<SVGPathElement>(".connect-creature-body")
    const halo = svg.querySelector<SVGEllipseElement>(".connect-creature-halo")
    const bodyMatrix = body?.getScreenCTM()
    const haloMatrix = halo?.getScreenCTM()
    if (body === null || halo === null) return null
    if (
      bodyMatrix === null || bodyMatrix === undefined || haloMatrix === null || haloMatrix === undefined
    ) return null
    const inverse = haloMatrix.inverse()
    const cx = halo.cx.baseVal.value
    const cy = halo.cy.baseVal.value
    // Clear the halo and the visible arc, accounting for their different stroke scaling.
    const strokes = [halo, ...svg.querySelectorAll<SVGEllipseElement>(".connect-creature-orbit")]
      .filter((ring) => ring === halo || Number(getComputedStyle(ring).opacity) > 0)
      .map((ring) => {
        const style = getComputedStyle(ring)
        const half = Number.parseFloat(style.strokeWidth) / 2
        return style.vectorEffect === "non-scaling-stroke"
          ? [half / Math.hypot(haloMatrix.a, haloMatrix.b), half / Math.hypot(haloMatrix.c, haloMatrix.d)]
          : [half, half]
      })
    const rx = halo.rx.baseVal.value - Math.max(...strokes.map(([x = 0]) => x))
    const ry = halo.ry.baseVal.value - Math.max(...strokes.map(([, y = 0]) => y))
    const length = body.getTotalLength()
    let maximum = 0
    for (let sample = 0; sample < 360; sample++) {
      const point = body.getPointAtLength(length * sample / 360)
      const local = new DOMPoint(point.x, point.y).matrixTransform(bodyMatrix).matrixTransform(inverse)
      maximum = Math.max(maximum, Math.hypot((local.x - cx) / rx, (local.y - cy) / ry))
    }
    return maximum
  }, moment)

test.describe("creature fill fidelity", () => {
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      test(`tall seeds keep row slots ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme, [...tallSeeds, ...base])
        const control = page.locator(".connect-agent[data-agent-key=\"atlas:agent-ds-rly\"]")
        const controlBox = await drawnBox(control)
        for (const fixture of tallSeeds) {
          const row = page.locator(`.connect-agent[data-agent-key="${fixture.host}:${fixture.id}"]`)
          expect.soft((await drawnBox(row)).height).toBeCloseTo(controlBox.height, 1)
          const track = await drawnBox(row.locator("svg.connect-creature"))
          expect(track.width).toBe(36)
          expect(track.height).toBe(36)
          const body = await drawnBox(row.locator(".connect-creature-body"))
          expect(body.width).toBeGreaterThanOrEqual(track.width * 0.58)
          expect(Math.max(body.width, body.height)).toBeGreaterThanOrEqual(track.width * 0.7)
          await expectRingFitsTrack(row.locator("svg.connect-creature"))
        }
      })

      test(`tall seed pins stay 44px ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme, [...tallSeeds, ...base])
        for (const fixture of tallSeeds) {
          await page.locator(`.connect-agent[data-agent-key="${fixture.host}:${fixture.id}"]`).click()
          await page.getByRole("button", { name: "Pin", exact: true }).click()
          await page.keyboard.press("Escape")
        }
        const pins = page.locator(".connect-pins[data-placement=\"float\"] .connect-pin-open")
        await expect(pins).toHaveCount(3)
        for (const pin of await pins.all()) {
          expect.soft((await drawnBox(pin)).height).toBe(44)
          const svg = pin.locator("svg.connect-creature")
          const creature = await drawnBox(svg)
          expect(creature.width).toBe(32)
          expect.soft(creature.height).toBe(32)
          const body = await drawnBox(svg.locator(".connect-creature-body"))
          expect(body.width).toBeGreaterThanOrEqual(creature.width * 0.58)
          expect(Math.max(body.width, body.height)).toBeGreaterThanOrEqual(creature.width * 0.7)
          await expectRingFitsTrack(svg)
        }
        const stack = await drawnBox(page.locator(".connect-pins[data-placement=\"float\"]"))
        const reserved = await page.locator(".connect-agents[data-pinned]").evaluate(
          (node) => Number.parseFloat(getComputedStyle(node).paddingBlockEnd)
        )
        const bottom = await page.locator(".connect-pins[data-placement=\"float\"]").evaluate(
          (node) => Number.parseFloat(getComputedStyle(node).insetBlockEnd)
        )
        expect(stack.height + bottom).toBeLessThanOrEqual(reserved)
        // Embedded desktop scrolls the directory; phones scroll the document.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await page.locator(".connect-agents").evaluate((directory) => {
          directory.scrollTop = directory.scrollHeight
        })
        const lastRow = await drawnBox(page.locator(".connect-agent").last())
        const scrolledStack = await drawnBox(page.locator(".connect-pins[data-placement=\"float\"]"))
        expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(scrolledStack.y)
      })

      test(`tall seed crew keeps its square track ${String(width)} ${theme}`, async ({ page }) => {
        const crew = [
          agent("parent", "working", "fixture-host", "package-work", 14, 2),
          agent("134", "working", "fixture-host", "package-work", 14, 2, "parent")
        ]
        await openDirectory(page, width, theme, crew)
        await page.locator(".connect-agent[data-agent-key=\"fixture-host:agent-parent\"]").click()
        const member = page.locator(".connect-stage-crew-member", { hasText: "134" })
        await expect(member).toBeVisible()
        const creature = member.locator("svg.connect-creature")
        const track = await drawnBox(creature)
        expect(track.width).toBe(28)
        expect(track.height).toBe(28)
        await expectRingFitsTrack(creature)
        for (const moment of ["rest", "inhale", "exhale"]) {
          await page.emulateMedia({ reducedMotion: moment === "rest" ? "reduce" : "no-preference" })
          const geometry = await measureEnclosure(creature, moment)
          expect(geometry).not.toBeNull()
          expect(geometry).toBeLessThanOrEqual(1)
        }
      })

      for (const surface of ["row", "stage"]) {
        test(`working halo stays under its arc ${surface} ${String(width)} ${theme}`, async ({ page }) => {
          await openDirectory(page, width, theme)
          const row = page.locator(".connect-agent[data-agent-key=\"atlas:agent-ds-rly\"]")
          if (surface === "stage") {
            await row.click()
            await expect(page.locator(".connect-stage-hero")).toBeVisible()
          }
          const creature = surface === "row"
            ? row.locator("svg.connect-creature")
            : page.locator(".connect-stage-hero svg.connect-creature")
          const halo = creature.locator(".connect-creature-halo")
          const orbit = creature.locator(".connect-creature-orbit")
          expect(await halo.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0)
          expect(await orbit.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0)
          const neutral = await page.evaluate(() => {
            const probe = document.createElement("span")
            probe.style.color = "var(--rly-color-text-3)"
            document.body.append(probe)
            const colour = getComputedStyle(probe).color
            probe.remove()
            return colour
          })
          expect(await halo.evaluate((node) => getComputedStyle(node).stroke)).toBe(neutral)
          expect(await halo.evaluate((node) => Number.parseFloat(getComputedStyle(node).strokeWidth))).toBe(
            surface === "row" ? 2 : 1
          )
          await page.emulateMedia({ forcedColors: "active" })
          expect(await halo.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0)
          expect(await halo.evaluate((node) => getComputedStyle(node).stroke)).not.toBe("none")
        })
      }

      for (const surface of ["row", "stage"]) {
        test(`halo encloses the seeded outline ${surface} ${String(width)} ${theme}`, async ({ page }) => {
          const fixtures = surface === "row" ? [...base, ...tallSeeds] : base
          await openDirectory(page, width, theme, fixtures)
          for (const fixture of fixtures) {
            const row = page.locator(`.connect-agent[data-agent-key="${fixture.host}:${fixture.id}"]`)
            if (surface === "stage") {
              await row.click()
              await expect(page.locator(".connect-stage-hero")).toBeVisible()
            }
            const creature = surface === "row"
              ? row.locator("svg.connect-creature")
              : page.locator(".connect-stage-hero svg.connect-creature")
            for (const moment of ["rest", "inhale", "exhale"]) {
              await page.emulateMedia({ reducedMotion: moment === "rest" ? "reduce" : "no-preference" })
              const geometry = await measureEnclosure(creature, moment)
              expect(geometry, `${fixture.host}:${fixture.id} ${moment}`).not.toBeNull()
              expect(geometry, `${fixture.host}:${fixture.id} ${moment}`).toBeLessThanOrEqual(1)
            }
            await page.emulateMedia({ reducedMotion: "reduce" })
            if (surface === "stage") await page.keyboard.press("Escape")
          }
        })
      }

      test(`row bodies fill their tracks ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme)
        const creatures = page.locator(".connect-agent > svg.connect-creature")
        await expect(creatures).toHaveCount(base.length)
        for (const creature of await creatures.all()) {
          const track = await drawnBox(creature)
          const body = await drawnBox(creature.locator(".connect-creature-body"))
          expect(track.width).toBe(36)
          // Square framing and stroke clearance at the 28px crew minimum leave tall seeds at least 0.58 wide.
          expect(body.width).toBeGreaterThanOrEqual(track.width * 0.58)
          expect(Math.max(body.width, body.height)).toBeGreaterThanOrEqual(track.width * 0.7)
          expect(body.x).toBeGreaterThanOrEqual(track.x - 1)
          expect(body.x + body.width).toBeLessThanOrEqual(track.x + track.width + 1)
          const ring = await drawnBox(creature.locator(".connect-creature-halo"))
          expect(Math.max(ring.width, ring.height)).toBeGreaterThanOrEqual(32)
          expect(ring.width).toBeLessThanOrEqual(36)
          await expectRingFitsTrack(creature)
        }
      })

      test(`pinned body fills its chip ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme)
        await page.locator(".connect-agent[data-agent-key=\"atlas:agent-ds-rly\"]").click()
        await page.getByRole("button", { name: "Pin", exact: true }).click()
        await page.keyboard.press("Escape")
        const creature = page.locator(
          ".connect-pins[data-placement=\"float\"] .connect-pin-open svg.connect-creature:visible"
        )
        await expect(creature).toHaveCount(1)
        const track = await drawnBox(creature)
        const body = await drawnBox(creature.locator(".connect-creature-body"))
        expect(track.width).toBe(32)
        expect(body.width).toBeGreaterThanOrEqual(track.width * 0.58)
        expect(Math.max(body.width, body.height)).toBeGreaterThanOrEqual(track.width * 0.7)
        expect(body.x).toBeGreaterThanOrEqual(track.x - 1)
        expect(body.x + body.width).toBeLessThanOrEqual(track.x + track.width + 1)
      })

      for (const key of ["atlas:agent-ds-rly", "atlas:agent-sec-cc"]) {
        test(`stage body and state ring keep their proportions ${key} ${String(width)} ${theme}`, async ({ page }) => {
          await openDirectory(page, width, theme)
          await page.locator(`.connect-agent[data-agent-key="${key}"]`).click()
          const hero = page.locator(".connect-stage-hero")
          await expect(hero).toBeVisible()
          const heroBox = await drawnBox(hero)
          expect(heroBox.height).toBe(width === 390 ? 272 : 176)
          const creature = hero.locator("svg.connect-creature")
          const body = await drawnBox(creature.locator(".connect-creature-body"))
          const state = creature.locator(key.endsWith("ds-rly") ? ".connect-creature-orbit" : ".connect-creature-halo")
          const ring = await drawnBox(state)
          expect(await state.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0)
          expect(ring.width).toBeGreaterThan(body.width)
          if (width === 390) {
            expect(body.width).toBeGreaterThanOrEqual(150)
            expect(ring.width).toBeGreaterThanOrEqual(180)
            expect(ring.x - 2).toBeGreaterThanOrEqual(heroBox.x)
            expect(ring.y - 2).toBeGreaterThanOrEqual(heroBox.y)
            expect(ring.x + ring.width + 2).toBeLessThanOrEqual(heroBox.x + heroBox.width)
            expect(ring.y + ring.height + 2).toBeLessThanOrEqual(heroBox.y + heroBox.height)
          } else {
            // The desktop stage already matches: enlarging every stage would regress it.
            expect((await drawnBox(creature)).width).toBe(128)
            expect(body.width).toBeGreaterThanOrEqual(70)
            expect(body.width).toBeLessThanOrEqual(105)
            expect(ring.width).toBeGreaterThanOrEqual(115)
            expect(ring.width).toBeLessThanOrEqual(120)
          }
        })
      }

      test(`ok footer labels are plain secondary text with a usage arrow ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme)
        const line = page.getByRole("list", { name: "Usage limits" })
        await expect(line.locator("li")).toHaveCount(2)
        for (const text of ["Claude 48% weekly", "Codex 31% weekly"]) {
          const label = line.getByText(text, { exact: true })
          await expect(label).toBeVisible()
          const colours = await label.evaluate((node) => {
            const probe = document.createElement("span")
            probe.style.color = "var(--rly-color-text-2)"
            node.append(probe)
            const expected = getComputedStyle(probe).color
            probe.remove()
            return { actual: getComputedStyle(node).color, expected }
          })
          expect(colours.actual).toBe(colours.expected)
        }
        await expect(line.locator("svg")).toHaveCount(0)
        const link = page.locator(".connect-limits-link")
        await expect(link).toHaveAttribute("href", "/?tab=usage")
        await expect(link.locator("svg")).toHaveCount(1)
        await expect(link.locator("svg")).toHaveAttribute("aria-hidden", "true")
      })
    }
  }
})

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
            expect((await page.locator(".connect-stage-hero").boundingBox())?.height).toBe(width === 390 ? 272 : 176)
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
          await expect(page.locator("header .connect-directory-switch")).toHaveCount(0)
          await expect(page.getByRole("link", { name: "Active", exact: true })).toHaveAttribute("aria-current", "page")
          await expect(page.getByRole("link", { name: "Archived", exact: true })).toBeVisible()
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
