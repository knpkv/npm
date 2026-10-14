/** Reference fixtures use the design's recorded identities and times, mounted without a hub masthead. */
import { agentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work/model"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { ConnectAgent } from "../../src/model.js"
import { failureSentences } from "../../src/unavailable-detail.js"
import { referenceCreatureIdentities } from "../reference-creature-identities.js"
import { pinReferenceFleet, pinRegressionFleet, scrollPinDirectory, seedPins } from "./connect-pin-fixture.js"
import { captureFidelity } from "./creature-capture.js"
import { expectReferenceCreatureIdentity } from "./reference-creature-identity.js"

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
  const hue = referenceCreatureIdentities.find((entry) => entry.host === host && entry.name === name)?.family
  const fields = {
    id: `agent-${name}`,
    name,
    state,
    host,
    work,
    kind: "claude",
    lastActivityAt: at(hour, minute)
  }
  const colored = hue === undefined ? fields : { ...fields, hue }
  return Schema.decodeUnknownSync(ConnectAgent)(
    parent === undefined ? colored : {
      ...colored,
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
      ...["worker-extra-a", "worker-extra-b", "worker-extra-c"].map((name) =>
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

      test(`tall seed pin pills stay 48px ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme, [...tallSeeds, ...base])
        for (const fixture of tallSeeds) {
          await page.locator(`.connect-agent[data-agent-key="${fixture.host}:${fixture.id}"]`).click()
          await page.getByRole("button", { name: "Pin", exact: true }).click()
          await page.keyboard.press("Escape")
        }
        const pins = page.locator(".connect-pins[data-placement=\"float\"] .connect-pin-open")
        await expect(pins).toHaveCount(3)
        for (const pin of await pins.all()) {
          expect.soft((await drawnBox(pin.locator(".."))).height).toBe(48)
          const svg = pin.locator("svg.connect-creature")
          const creature = await drawnBox(svg)
          expect(creature.width).toBe(28)
          expect.soft(creature.height).toBe(28)
          const body = await drawnBox(svg.locator(".connect-creature-body"))
          expect(body.width).toBeGreaterThanOrEqual(creature.width * 0.58)
          expect(Math.max(body.width, body.height)).toBeGreaterThanOrEqual(creature.width * 0.7)
          await expectRingFitsTrack(svg)
        }
        const stack = await drawnBox(page.locator(".connect-pins[data-placement=\"float\"]"))
        const reserved = (await drawnBox(page.locator(".connect-directory-secondary[data-pinned]"))).height
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

      test(`rev6 skills fixture carries Ember rather than Amber ${String(width)} ${theme}`, async ({ page }) => {
        await openDirectory(page, width, theme)
        const body = page.locator(".connect-agent[data-agent-key=\"atlas:agent-skills\"] .connect-creature-body")
        await expect(body).toHaveAttribute("fill", "#9a3d00")
      })

      for (const surface of ["row", "stage"]) {
        test(`rev6 working arc has no neutral full halo ${surface} ${String(width)} ${theme}`, async ({ page }) => {
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
          // Rev6 draw.ring has only the deploying-ink arc; the previous full neutral halo is retired.
          await expect(halo).toHaveCSS("opacity", "0")
          expect(await orbit.evaluate((node) => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0)
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
        // rev5.2's PIN export renders a 28px creature in a 48px pill; the fill ratios still apply.
        expect(track.width).toBe(28)
        expect((await drawnBox(creature.locator("../.."))).height).toBe(48)
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

/** CONNECT-MAP rev6 plus the pinFrame design clarification: phone whole-pill cap, desktop one line. */
test.describe("rev6 pin fidelity", () => {
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      test(`rev6 pin state stays plain with responsive long names ${String(width)} ${theme}`, async ({ page }) => {
        const longName = "coordinator-for-package-builder-review-and-release-notes"
        const pinned = agent(longName, "waiting", "atlas", "package-work", 14, 2)
        await openDirectory(page, width, theme, [pinned])
        await page.locator(".connect-agent").click()
        await page.getByRole("button", { name: "Pin", exact: true }).click()
        await page.keyboard.press("Escape")
        const pin = page.locator(".connect-pins[data-placement=\"float\"] .connect-pin-open")
        await expect(pin).toHaveAccessibleName(new RegExp(`^Pinned: ${longName},`))
        const name = pin.locator(".connect-pin-name")
        const state = pin.locator(".connect-pin-state")
        await expect(name).toBeVisible()
        await expect(state).toBeVisible()
        await expect(state).toHaveText("Needs you")
        const metrics = await pin.evaluate((node) => {
          const name = node.querySelector<HTMLElement>(".connect-pin-name")
          const state = node.querySelector<HTMLElement>(".connect-pin-state")
          if (name === null || state === null) return null
          const label = state.querySelector("span") ?? state
          const nameStyle = getComputedStyle(name)
          const stateStyle = getComputedStyle(state)
          const labelStyle = getComputedStyle(label)
          const nameBox = name.getBoundingClientRect()
          const stateBox = state.getBoundingClientRect()
          const pinBox = node.getBoundingClientRect()
          const pillBox = (node.parentElement ?? node).getBoundingClientRect()
          return {
            pillCap: getComputedStyle(node.parentElement ?? node).maxInlineSize,
            nameCap: nameStyle.maxInlineSize,
            pillWidth: node.parentElement?.getBoundingClientRect().width ?? 0,
            pillFitsViewport: pillBox.left >= 0 && pillBox.right <= window.innerWidth,
            ellipsis: nameStyle.textOverflow,
            nameOverflow: name.scrollWidth > name.clientWidth,
            stateFont: stateStyle.fontSize,
            stateWeight: stateStyle.fontWeight,
            stateLine: stateStyle.lineHeight,
            stateShrink: stateStyle.flexShrink,
            stateOverflow: state.scrollWidth > state.clientWidth,
            background: labelStyle.backgroundColor,
            border: labelStyle.borderTopWidth,
            padding: labelStyle.paddingInlineStart,
            gap: stateBox.left - nameBox.right,
            stackedGap: stateBox.top - nameBox.bottom,
            stackedAligned: Math.abs(stateBox.left - nameBox.left) < 1,
            sameLine: Math.abs(stateBox.top - nameBox.top) < 4,
            endSpace: pinBox.right - stateBox.right,
            fitsViewport: pinBox.left >= 0 && pinBox.right <= window.innerWidth
          }
        })
        expect(metrics).not.toBeNull()
        if (metrics === null) return
        // Desktop has no fixed name cap; a whole-pill viewport bound is still required.
        if (width < 600) expect.soft(metrics.pillCap).toBe("144px")
        expect.soft(metrics.pillFitsViewport).toBe(true)
        expect.soft(metrics.nameCap).toBe("none")
        expect.soft(metrics.ellipsis).toBe("ellipsis")
        expect.soft(metrics.nameOverflow).toBe(width < 600)
        if (width < 600) expect.soft(metrics.pillWidth).toBeLessThanOrEqual(144)
        expect.soft(metrics.stateFont).toBe("12px")
        expect.soft(metrics.stateWeight).toBe("500")
        expect.soft(Number.parseFloat(metrics.stateLine)).toBeCloseTo(14.4, 1)
        expect.soft(metrics.stateShrink).toBe("0")
        expect.soft(metrics.stateOverflow).toBe(false)
        expect.soft(metrics.background).toBe("rgba(0, 0, 0, 0)")
        expect.soft(metrics.border).toBe("0px")
        expect.soft(metrics.padding).toBe("0px")
        if (width >= 600) expect.soft(metrics.gap).toBe(8)
        else {
          expect.soft(metrics.stackedGap).toBeCloseTo(2, 1)
          expect.soft(metrics.stackedAligned).toBe(true)
        }
        await expect(state.locator("svg")).toHaveCount(0)
        const creatureBox = await drawnBox(pin.locator(".connect-creature"))
        expect.soft(creatureBox.width).toBe(28)
        expect.soft(creatureBox.height).toBe(28)
        expect.soft(metrics.sameLine).toBe(width >= 600)
        expect.soft(metrics.endSpace).toBeGreaterThanOrEqual(12)
        expect.soft(metrics.fitsViewport).toBe(true)
        await pin.click()
        await expect(page.getByRole("dialog", { name: longName, exact: true })).toBeVisible()
      })
    }
  }
})

/** Valid schema-max names must leave Open, the creature and Unpin reachable on desktop. */
test.describe("schema-max desktop pins", () => {
  for (const width of [640, 1280]) {
    for (const theme of ["light", "dark"]) {
      test(`schema-max desktop pins fit ${String(width)} ${theme}`, async ({ page }) => {
        const name = "release-review-worker-".repeat(16).slice(0, 256)
        const pinned = Schema.decodeUnknownSync(ConnectAgent)({
          ...agent("long-pin", "waiting", "atlas", "package-work", 14, 2),
          name
        })
        await openDirectory(page, width, theme, [pinned])
        // Fidelity captures add two frame-border pixels. This guard needs the exact named viewport.
        await page.setViewportSize({ width, height: 844 })
        expect(await page.evaluate(() => window.innerWidth)).toBe(width)
        await page.locator(".connect-agent").click()
        await page.getByRole("button", { name: "Pin", exact: true }).click()
        await page.keyboard.press("Escape")
        const pill = page.locator(".connect-pins[data-placement=float] .connect-pin")
        const bounds = await pill.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds?.x).toBeGreaterThanOrEqual(0)
        expect((bounds?.x ?? -1) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        const text = pill.locator(".connect-pin-name")
        await expect(text).toHaveCSS("text-overflow", "ellipsis")
        expect(await text.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
        const creature = await pill.locator(".connect-creature").boundingBox()
        expect(creature?.x).toBeGreaterThanOrEqual(0)
        expect((creature?.x ?? -1) + (creature?.width ?? 0)).toBeLessThanOrEqual(width)
        const unpin = pill.getByRole("button", { name: `Unpin ${name}`, exact: true })
        expect(
          await unpin.evaluate((node) => {
            const box = node.getBoundingClientRect()
            return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
          })
        ).toBe(true)
        await pill.locator(".connect-pin-open").click()
        await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible()
        await page.keyboard.press("Escape")
        await unpin.click()
        await expect(pill).toHaveCount(0)
      })
    }
  }
})

/** Export frame heights include the 98px masthead; capture the actual bounded directory below it. */
/** Generated separators must obey the same copy rule as text nodes. */
const expectNoMiddots = async (page: Page) => {
  const root = page.locator("#fleet-connect-root")
  const text = (await root.innerText()).includes("\u00b7")
  const generated = await root.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible")
      .flatMap((node) =>
        ["::before", "::after"].map((pseudo) => ({
          element: node.className,
          pseudo,
          content: getComputedStyle(node, pseudo).content
        }))
      )
      .filter(({ content }) => content.includes("\u00b7"))
  )
  expect.soft({ text, generated }).toEqual({ text: false, generated: [] })
}

/** Every point in the 44px target must hit this control, never an adjacent control. */
const expectTouchTarget = async (target: Locator) => {
  const measured = await target.evaluate((node) => {
    const ancestors: Array<{ node: Element; x: number; y: number }> = []
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      ancestors.push({ node: parent, x: parent.scrollLeft, y: parent.scrollTop })
    }
    const previous = { x: window.scrollX, y: window.scrollY }
    node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    const box = node.getBoundingClientRect()
    const points = [-21.5, 0, 21.5].flatMap((x) =>
      [-21.5, 0, 21.5].map((y) => {
        const hit = document.elementFromPoint(box.x + box.width / 2 + x, box.y + box.height / 2 + y)
        return { x, y, owned: hit !== null && node.contains(hit) }
      })
    )
    for (const saved of ancestors) saved.node.scrollTo(saved.x, saved.y)
    window.scrollTo(previous.x, previous.y)
    return points
  })
  expect.soft(measured.filter(({ owned }) => !owned)).toEqual([])
}

/** Resolve theme-dependent token colours in the card's own inheritance scope. */
const expectCardBorder = async (card: Locator, token: string, padding = "16px") => {
  const measured = await card.evaluate((node, name) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    node.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    const style = getComputedStyle(node)
    return {
      expected,
      colors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      radius: style.borderTopLeftRadius
    }
  }, token)
  expect.soft(measured.colors).toEqual(Array(4).fill(measured.expected))
  expect.soft(measured.widths).toEqual(["1px", "1px", "1px", "1px"])
  expect.soft(measured.padding).toEqual([padding, padding, padding, padding])
  expect.soft(measured.radius).toBe("16px")
}

/** Reference text colours are sampled from the ref, independently of the live Text variant. */
const expectRegularText = async (text: Locator, token: string, size?: string) => {
  const measured = await text.evaluateAll((nodes, name) =>
    nodes.map((node) => {
      const probe = document.createElement("span")
      probe.style.color = `var(${name})`
      node.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      const style = getComputedStyle(node)
      return {
        text: node.textContent?.trim(),
        color: style.color,
        expected,
        weight: style.fontWeight,
        size: style.fontSize
      }
    }), token)
  expect.soft(measured.length).toBeGreaterThan(0)
  for (const reading of measured) {
    expect.soft(reading.color, reading.text).toBe(reading.expected)
    expect.soft(reading.weight, reading.text).toBe("400")
    if (size !== undefined) expect.soft(reading.size, reading.text).toBe(size)
  }
}

/** Check the painted divider, accepting any CSS implementation with the reference's inset. */
const expectInsetFamilyDividers = async (rows: Locator) => {
  expect.soft(await rows.count()).toBeGreaterThan(0)
  for (const row of await rows.all()) {
    const saved = await row.evaluate((node) => {
      const ancestors: Array<{ x: number; y: number }> = []
      for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
        ancestors.push({ x: parent.scrollLeft, y: parent.scrollTop })
      }
      const probe = document.createElement("span")
      probe.style.color = "var(--rly-color-border-1)"
      node.append(probe)
      const border = getComputedStyle(probe).color
      probe.style.color = "var(--rly-color-surface-1)"
      const surface = getComputedStyle(probe).color
      probe.remove()
      return { ancestors, x: window.scrollX, y: window.scrollY, border, surface }
    })
    const screenshot = await row.screenshot({ animations: "disabled" })
    const painted = await row.evaluate(async (node, { png, saved }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${png}`
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext("2d")
      let reading = null
      if (context !== null) {
        context.drawImage(image, 0, 0)
        // A fractional row edge can occupy either of the last raster rows.
        const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data)
        const edgeRows = [1, 2, 3].map((offset) => ({
          startGap: pixel(6, image.height - offset),
          dividerStart: pixel(13, image.height - offset),
          dividerEnd: pixel(image.width - 3, image.height - offset)
        }))
        context.fillStyle = saved.surface
        context.fillRect(0, 0, 1, 1)
        const surface = Array.from(context.getImageData(0, 0, 1, 1).data)
        context.fillStyle = saved.border
        context.fillRect(0, 0, 1, 1)
        const border = Array.from(context.getImageData(0, 0, 1, 1).data)
        reading = { edgeRows, surface, border }
      }
      let parent = node.parentElement
      for (const position of saved.ancestors) {
        parent?.scrollTo(position.x, position.y)
        parent = parent?.parentElement ?? null
      }
      window.scrollTo(saved.x, saved.y)
      return reading
    }, { png: screenshot.toString("base64"), saved })
    expect.soft(painted).not.toBeNull()
    if (painted !== null) {
      expect.soft(painted.edgeRows).toContainEqual({
        startGap: painted.surface,
        dividerStart: painted.border,
        dividerEnd: painted.border
      })
    }
  }
}

/** A notice icon starts its own column beside, rather than above, the first text line. */
const expectNoticeIcon = async (card: Locator, text: Locator, gap = 12) => {
  const icon = await card.locator(":scope > svg").boundingBox()
  const heading = await text.boundingBox()
  expect.soft(icon).not.toBeNull()
  expect.soft(heading).not.toBeNull()
  if (icon !== null && heading !== null) {
    expect.soft(icon.x + icon.width).toBeLessThanOrEqual(heading.x)
    expect.soft(Math.abs(icon.y - heading.y)).toBeLessThanOrEqual(2)
    expect.soft(heading.x - (icon.x + icon.width)).toBe(gap)
  }
}

/** Retry uses the shared secondary fill, border and compact density, rather than a primary action. */
const expectCompactSecondary = async (button: Locator) => {
  const measured = await button.evaluate((node) => {
    const probe = document.createElement("span")
    node.append(probe)
    const color = (token: string) => {
      probe.style.color = `var(${token})`
      return getComputedStyle(probe).color
    }
    const style = getComputedStyle(node)
    const result = {
      fill: style.backgroundColor,
      expectedFill: color("--rly-color-surface-1"),
      border: style.borderTopColor,
      expectedBorder: color("--rly-color-border-2"),
      minHeight: style.minHeight,
      compactHeight: style.getPropertyValue("--rly-control-height-dense").trim()
    }
    probe.remove()
    return result
  })
  expect.soft(measured.fill).toBe(measured.expectedFill)
  expect.soft(measured.border).toBe(measured.expectedBorder)
  expect.soft(measured.minHeight).toBe(measured.compactHeight)
}

const states = {
  "2a": 1064,
  "2b": 647,
  "2c": 358,
  "2c-v3": 440,
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
        if (state === "2c-v3") {
          await page.setViewportSize({ width: width + 2, height: (width === 390 ? 489 : frameHeight) - 106 })
        } else if (state.startsWith("2i")) {
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
              ? { ...entry, relationship: { parentAgentId: "agent-rev-usage", relation: "pair" } }
              : entry.name === "rev-usage"
              ? { ...entry, relationship: { parentAgentId: entry.id, relation: "review" } }
              : entry.name === "ds-rly"
              ? { ...entry, relationship: { parentAgentId: "agent-coord-old", relation: "delegated" } }
              : entry
          )
        }
        if (state === "2h") agents = [...agents, ...agents.filter((entry) => entry.name === "pkgsrc")]
        await page.route("**/v1/connect/agents", (route) => {
          if (state === "2b" || state === "2c") return
          // rev6 2c-v3 depicts inability to reach the hub, not an HTTP response or typed deadline.
          if (state === "2c-v3") return route.abort("failed")
          if (failed && (state === "2d" || state === "2i-v4-stale")) {
            return route.fulfill({ status: 503, body: "timeout" })
          }
          return route.fulfill({
            json: {
              agents: agents.map((entry) =>
                (state === "2s" || state === "2h") && entry.relationship?.parentAgentId === "agent-coord-old"
                  ? { ...entry, relationship: { ...entry.relationship, parentName: "coord-old" } }
                  : entry
              ),
              failures: failed && state === "2e" ? [{ host: "cedar", reason: "offline" }] : [],
              hosts: ["atlas", "birch"],
              nextCursor: null
            }
          })
        })
        if (state === "2o") {
          await page.route("**/v1/connect/limits", (route) =>
            route.fulfill({
              json: {
                hosts: [{
                  host: "atlas",
                  readAt: at(14, 2),
                  reading: { _tag: "Unavailable", reason: "failed", detail: failureSentences.notRunning }
                }],
                failures: [],
                peersListed: true
              }
            }))
        }
        await mount(page, theme)
        if (state === "2a") {
          // The shared identity table also covers long-list frames; 2a mounts only this six-agent fleet.
          for (const fixture of base) {
            await expectReferenceCreatureIdentity(
              page.locator(`.connect-agent[data-agent-key="${fixture.host}:agent-${fixture.name}"] .connect-creature`),
              fixture.host,
              fixture.name
            )
          }
        }
        if (state === "2b") {
          await expect(page.getByText("Loading fleet agents…")).toBeVisible()
          await expect.soft(page.locator(".connect-directory-secondary")).toHaveCount(0)
        } else if (state === "2c") {
          await page.clock.runFor(10_050)
          await expect.soft(page.getByRole("heading", { name: "The fleet directory didn't answer" })).toBeVisible()
          await expect.soft(page.getByText("Not updated yet", { exact: true })).toBeVisible()
          await expect.soft(page.locator(".connect-directory-error svg")).toBeVisible()
          await expect.soft(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
          await expect(page.locator(".connect-directory-error p")).toHaveText(
            "The request timed out, so no agents are listed. Retry, or wait: Relay tries again every 5 seconds."
          )
          await expectCardBorder(page.locator(".connect-directory-error"), "--rly-color-blocked-ink", "24px")
          await expectNoticeIcon(
            page.locator(".connect-directory-error"),
            page.locator(".connect-directory-error h2"),
            16
          )
          await expectCompactSecondary(page.getByRole("button", { name: "Retry", exact: true }))
          await expect.soft(page.locator(".connect-directory-secondary")).toHaveCount(0)
          await expectRegularText(page.locator(".connect-directory-error p"), "--rly-color-text-2", "16px")
        } else if (state === "2c-v3") {
          // CONNECT-MAP rev6, connect--2c-v3: actionable copy, 24px inset and a 48px Retry control.
          const card = page.locator(".connect-directory-error")
          await expect(card.getByRole("heading", { name: "Couldn’t load the fleet directory", exact: true }))
            .toBeVisible()
          await expect(card.getByText("Relay couldn’t reach the hub. It tries again every 5 seconds.", { exact: true }))
            .toBeVisible()
          const retry = card.getByRole("button", { name: "Retry", exact: true })
          await expect(retry).toBeVisible()
          expect.soft((await drawnBox(retry)).height).toBe(48)
          const layout = await card.evaluate((node) => {
            const style = getComputedStyle(node)
            const title = node.querySelector("h2")
            const icon = node.querySelector("svg")
            return {
              padding: style.paddingInlineStart,
              gap: style.columnGap,
              radius: style.borderTopLeftRadius,
              titleSize: title === null ? null : getComputedStyle(title).fontSize,
              iconSize: icon === null ? null : icon.getBoundingClientRect().width
            }
          })
          expect.soft(layout).toEqual({ padding: "24px", gap: "16px", radius: "14px", titleSize: "20px", iconSize: 20 })
          await expect(card).not.toContainText("HTTP 503")
        } else if (state === "2f") {
          await expect(page.getByText("No agents running on any host.")).toBeVisible()
          await expect.soft(page.getByRole("searchbox")).toBeVisible()
          await expect.soft(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible()
          await expect.soft(page.getByText("Start an agent on atlas or birch and it appears here.", { exact: true }))
            .toBeVisible()
          await expectCardBorder(page.locator(".connect-empty"), "--rly-color-border-1")
          await expectRegularText(page.locator(".connect-empty p").first(), "--rly-color-text-1", "14px")
          await expectRegularText(page.locator(".connect-empty p").last(), "--rly-color-text-2", "12px")
          const hint = await page.locator(".connect-empty p").evaluateAll((rows) =>
            rows.map((row) => {
              const box = row.getBoundingClientRect()
              return { x: box.x, y: box.y, height: box.height }
            })
          )
          expect.soft(hint).toHaveLength(2)
          if (hint[0] !== undefined && hint[1] !== undefined) {
            expect.soft(hint[1].x).toBe(hint[0].x)
            expect.soft(hint[1].y).toBeGreaterThanOrEqual(hint[0].y + hint[0].height + 8)
          }
        } else {
          await expect(page.locator(".connect-family").first()).toBeVisible()
          if (state === "2h") {
            await expectReferenceCreatureIdentity(
              page.locator(".connect-agent[data-agent-key=\"atlas:agent-pair-codex\"] .connect-creature"),
              "atlas",
              "pair-codex"
            )
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
            if (state === "2q-v2") await page.getByRole("button", { name: /^Needs you/ }).click()
            else await page.getByRole("button", { name: /^Filters/ }).click()
            if (state === "2g") {
              await page.getByRole("searchbox").fill("zzz")
              await page.getByRole("searchbox").blur()
            }
          }
          if (state === "2q-v2") {
            await expect(page.locator(".connect-agent")).toHaveCount(1)
            await expect(page.locator(".connect-agent-copy > strong")).toHaveText(["rev-usage"])
            await expect(page.getByRole("button", { name: /^Needs you/ })).toHaveAttribute("aria-pressed", "true")
          }
          if (state === "2g") {
            await expect.soft(page.locator(".connect-filters-toggle .connect-filter-count")).toHaveText("1")
            const fill = await page.locator(".connect-filters-toggle").evaluate((button) => {
              const probe = document.createElement("span")
              probe.style.color = "var(--rly-color-surface-3)"
              button.append(probe)
              const expected = getComputedStyle(probe).color
              probe.remove()
              return { actual: getComputedStyle(button).backgroundColor, expected }
            })
            expect.soft(fill.actual).toBe(fill.expected)
            await expect(page.getByRole("searchbox")).not.toBeFocused()
            await expect.soft(
              page.locator(".connect-filter-summary").getByRole("button", { name: "Clear", exact: true })
            ).toBeVisible()
            await expect.soft(page.locator(".connect-empty")).toContainText(
              "No agents match “zzz” on birch, in all states."
            )
            await expectCompactSecondary(page.getByRole("button", { name: "Clear filters", exact: true }))
            await expectRegularText(page.locator(".connect-no-matches"), "--rly-color-text-1", "14px")
          }
          if (state === "2j") {
            await page.locator(".connect-agent[data-agent-key=\"atlas:agent-ds-rly\"]").click()
            await page.getByRole("button", { name: "Pin", exact: true }).click()
            await page.keyboard.press("Escape")
            await page.mouse.move(0, 0)
            await expect.soft(page.locator(".connect-pins[data-placement='float'] .connect-pin-name")).toBeVisible()
            await expect.soft(page.locator(".connect-pins[data-placement='float'] .connect-pin-state")).toBeVisible()
            await expect.soft(page.locator(".connect-pins[data-placement='float'] .lucide-pin")).toBeVisible()
            const selected = page.locator(".connect-agent[data-agent-key=\"atlas:agent-ds-rly\"]")
            await selected.evaluate((row) => row.blur())
            const outline = await selected.evaluate((row) => getComputedStyle(row).outlineStyle)
            expect.soft(outline).toBe("none")
            // Base 2j depicts the footer at the end; mid-scroll sticking is guarded by 2j-v2.
            // Design marks its 202px phone pill stale: all pin counts use rev6's compact v2 pinFrame.
            await scrollPinDirectory(page, 1)
            const stack = await drawnBox(page.locator(".connect-pins[data-placement='float']"))
            const footer = await drawnBox(page.locator(".connect-directory-secondary"))
            const last = await drawnBox(page.locator(".connect-agent").last())
            expect.soft(stack.y).toBeGreaterThanOrEqual(footer.y)
            expect.soft(last.y + last.height).toBeLessThanOrEqual(stack.y)
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
            const nested = page.getByRole("button", { name: /^Nested deeper: open lint-sub/ })
            await expect(nested).toBeVisible()
            const presentation = await nested.evaluate((node) => {
              const label = node.querySelector(":scope > span")
              const glyph = node.querySelector(":scope > svg")
              return {
                weight: getComputedStyle(node).fontWeight,
                buttonDecoration: getComputedStyle(node).textDecorationLine,
                label: label?.textContent?.trim() ?? null,
                labelDecoration: label === null ? null : getComputedStyle(label).textDecorationLine,
                icon: glyph?.classList.contains("lucide-arrow-right") ?? false,
                decorative: glyph?.getAttribute("aria-hidden") ?? null,
                iconAfterLabel: label !== null && glyph !== null && label.nextElementSibling === glyph,
                last: glyph !== null && node.lastElementChild === glyph
              }
            })
            expect.soft(presentation).toEqual({
              weight: "600",
              buttonDecoration: "none",
              label: "Nested deeper: open lint-sub",
              labelDecoration: "underline",
              icon: true,
              decorative: "true",
              iconAfterLabel: true,
              last: true
            })
          }
          if (["2a", "2j", "2o", "2s"].includes(state)) {
            const childFills = await page.locator(".connect-agent[data-depth='1']").evaluateAll((rows) =>
              rows.map((row) => {
                const family = row.closest(".connect-family")
                const rowFill = getComputedStyle(row).backgroundColor
                return { rowFill, familyFill: family === null ? null : getComputedStyle(family).backgroundColor }
              })
            )
            expect.soft(childFills.length).toBeGreaterThan(0)
            expect.soft(
              childFills.every(({ familyFill, rowFill }) => rowFill === "rgba(0, 0, 0, 0)" || rowFill === familyFill)
            ).toBe(true)
            const metaOwners = await page.locator(".connect-agent-copy small").evaluateAll((rows) =>
              rows.map((row) => {
                const owner = row.closest("button")
                const box = owner?.getBoundingClientRect()
                return box !== undefined && box.width >= 44 && box.height >= 44
              })
            )
            expect.soft(metaOwners.length).toBeGreaterThan(0)
            expect.soft(metaOwners.every(Boolean)).toBe(true)
          }
          if (state === "2o") {
            await expect.soft(page.locator(".connect-limits-problem")).toContainText(failureSentences.notRunning)
            await expect.soft(page.locator(".connect-limits-problem svg")).toBeVisible()
            await expectRegularText(page.locator(".connect-limits-problem p"), "--rly-color-text-1", "16px")
            await expectCardBorder(page.locator(".connect-limits-problem"), "--rly-color-held-ink", "12px")
            await expectNoticeIcon(
              page.locator(".connect-limits-problem"),
              page.locator(".connect-limits-problem p"),
              8
            )
          }
          if (state === "2s") {
            await expect.soft(page.locator(".connect-family-missing")).toHaveCount(1)
            await expect.soft(page.locator(".connect-family-missing")).toContainText(
              "coord-old on birch isn't in the directory"
            )
            await expect.soft(page.locator(".connect-family-missing p")).toHaveCSS("line-height", "16px")
            await expectRegularText(page.locator(".connect-family-missing p"), "--rly-color-text-2", "12px")
            const noticeLines = await page.locator(".connect-family-missing").evaluate((node) => {
              const label = node.querySelector(":scope > span")
              const sentence = node.querySelector("p")
              const labelText = Array.from(label?.childNodes ?? []).find((child) =>
                child.nodeType === Node.TEXT_NODE && child.textContent?.trim()
              )
              if (label === null || sentence === null || labelText === undefined) return null
              const labelRange = document.createRange()
              labelRange.selectNodeContents(labelText)
              const sentenceRange = document.createRange()
              sentenceRange.selectNodeContents(sentence)
              const labelBox = labelRange.getBoundingClientRect()
              const sentenceBox = sentenceRange.getBoundingClientRect()
              return {
                label: { x: labelBox.x, right: labelBox.right, bottom: labelBox.bottom },
                sentence: { x: sentenceBox.x, y: sentenceBox.y, bottom: sentenceBox.bottom },
                labelBottom: label.getBoundingClientRect().bottom,
                labelStart: label.getBoundingClientRect().x,
                // React text fragments each get a rect, including fragments on the same visual line.
                sentenceLineTops: Array.from(sentenceRange.getClientRects(), (rect) => rect.top)
              }
            })
            expect.soft(noticeLines).not.toBeNull()
            if (noticeLines !== null) {
              if (width === 1280) {
                expect.soft(noticeLines.sentenceLineTops.length).toBeGreaterThan(0)
                expect.soft(
                  Math.max(...noticeLines.sentenceLineTops) - Math.min(...noticeLines.sentenceLineTops),
                  "desktop orphan sentence fragments stay on one visual line"
                ).toBeLessThanOrEqual(1)
                expect.soft(noticeLines.sentence.x, "desktop orphan sentence follows the label")
                  .toBeGreaterThan(noticeLines.label.right)
                expect.soft(
                  Math.abs(noticeLines.label.bottom - noticeLines.sentence.bottom),
                  "desktop orphan label and sentence share a text baseline"
                ).toBeLessThanOrEqual(1)
              } else {
                expect.soft(noticeLines.sentence.y, "phone orphan sentence stacks below the label")
                  .toBeGreaterThanOrEqual(noticeLines.labelBottom)
                expect.soft(noticeLines.sentence.x).toBe(noticeLines.labelStart)
              }
            }
            const fill = await page.locator(".connect-family-missing").evaluate((node) => {
              const probe = document.createElement("span")
              probe.style.color = "var(--rly-color-surface-2)"
              node.append(probe)
              const expected = getComputedStyle(probe).color
              probe.remove()
              return { actual: getComputedStyle(node).backgroundColor, expected }
            })
            expect.soft(fill.actual).toBe(fill.expected)
            await expect.soft(page.locator(".connect-agent[data-lineage-issue='unknown_parent'] .connect-agent-issue"))
              .toHaveCount(0)
          }
          if (state === "2u") {
            const family = page.locator(".connect-agent[data-agent-key=\"atlas:agent-sec-cc\"]").locator("..")
            await expect(family.locator(".connect-agent-copy > strong")).toHaveText([
              "sec-cc",
              "pair-codex",
              "rev-auth"
            ])
            await expectReferenceCreatureIdentity(
              family.locator(".connect-agent[data-agent-key=\"atlas:agent-rev-auth\"] .connect-creature"),
              "atlas",
              "rev-auth"
            )
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
        if (["2a", "2c", "2f", "2g", "2j", "2o", "2s", "2t"].includes(state)) await expectNoMiddots(page)
        if (["2a", "2f", "2g", "2j", "2o", "2s", "2t"].includes(state)) {
          const type = await page.locator(".connect-limits-link").evaluate((node) => ({
            size: getComputedStyle(node).fontSize,
            weight: getComputedStyle(node).fontWeight
          }))
          expect.soft(type).toEqual({ size: "14px", weight: "600" })
        }
        await expect(page.locator(".connect-cast-member small")).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        await page.mouse.move(0, 0)
        if (["2a", "2j", "2o", "2s", "2t"].includes(state)) {
          await expectRegularText(
            page.locator(".connect-agent-copy small, .connect-agent-copy small *"),
            "--rly-color-text-2",
            "12px"
          )
          await expectRegularText(page.locator(".connect-agent-work"), "--rly-color-text-1", "14px")
          await expectInsetFamilyDividers(page.locator(".connect-family .connect-agent:not(:last-child)"))
        }
        if (["2a", "2c", "2f", "2g", "2j", "2o", "2s", "2t"].includes(state)) {
          await expectRegularText(
            page.locator(state === "2c" ? ".connect-embedded-intro > .connect-attention-count" : ".connect-updated"),
            "--rly-color-text-2",
            "12px"
          )
        }
        if (["2a", "2f", "2g", "2j", "2o", "2s", "2t"].includes(state)) {
          await expectRegularText(page.locator(".connect-filter-summary > span").first(), "--rly-color-text-2", "12px")
          await expectRegularText(page.locator(".connect-filter-summary > span").nth(1), "--rly-color-text-2", "12px")
        }
        await captureFidelity(
          page,
          testInfo.outputPath(`fidelity/connect-${state}-${String(width)}-${theme}.png`),
          page.locator(state.startsWith("2i") ? ".connect-stage-sheet" : "#fleet-connect-root")
        )
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2)
        if (state === "2a") {
          await expect(page.locator("header .connect-directory-switch")).toHaveCount(0)
          await expect(page.getByRole("link", { name: "Active", exact: true })).toHaveAttribute("aria-current", "page")
          await expect(page.getByRole("link", { name: "Archived", exact: true })).toBeVisible()
          const title = page.getByRole("heading", { name: /Connect/ })
          await expect(title).toHaveText("Connect, 2 need you")
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

/** Hit targets run independently so a copy or card failure cannot hide a geometry regression. */
for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (
      const [state, frameHeight] of Object.entries(states).filter(([state]) =>
        ["2a", "2c", "2f", "2g", "2j", "2o", "2s", "2t"].includes(state)
      )
    ) {
      test(`reference ${state} hit targets ${String(width)} ${theme}`, async ({ page }) => {
        await prepare(page, width, theme)
        if (width === 1280) await page.setViewportSize({ width: width + 2, height: frameHeight - 100 })
        await page.route("**/v1/connect/agents", (route) =>
          state === "2c"
            ? undefined
            : route.fulfill({
              json: {
                agents: state === "2f" ? [] : [...base, ...extras(state)],
                failures: [],
                hosts: ["atlas", "birch"],
                nextCursor: null
              }
            }))
        await mount(page, theme)
        if (state !== "2c") await expect(page.locator(".connect-limits-link")).toBeVisible()
        if (state === "2c") {
          await page.clock.runFor(10_050)
          const retry = page.getByRole("button", { name: "Retry", exact: true })
          await expect(retry).toBeVisible()
          await expectTouchTarget(retry)
        } else if (state === "2g") {
          await page.getByRole("button", { name: "Filters", exact: true }).click()
          await page.getByRole("button", { name: "birch", exact: true }).click()
          await page.getByRole("button", { name: /^Filters/ }).click()
          await page.getByRole("searchbox").fill("zzz")
          await page.getByRole("searchbox").blur()
          await expectTouchTarget(page.getByRole("button", { name: /^Filters/ }))
          await expectTouchTarget(page.getByRole("button", { name: "Clear", exact: true }))
          await expectTouchTarget(page.getByRole("button", { name: "Clear filters", exact: true }))
        } else if (state === "2j") {
          await page.locator(".connect-agent[data-agent-key='atlas:agent-ds-rly']").click()
          await page.getByRole("button", { name: "Pin", exact: true }).click()
          await page.keyboard.press("Escape")
          await page.mouse.move(0, 0)
          await expectTouchTarget(page.getByRole("button", { name: "Unpin ds-rly", exact: true }))
          await expectTouchTarget(page.getByRole("button", { name: "Pinned: ds-rly, Working", exact: true }))
        } else if (state === "2t") {
          await expectTouchTarget(page.getByRole("button", { name: /^Nested deeper: open lint-sub/ }))
        }
        if (state !== "2c" && state !== "2c-v3") await expectTouchTarget(page.locator(".connect-limits-link"))
      })
    }
  }
}

/** New reference states keep failure causes honest and footer actions outside the pin reserve. */
for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (const state of ["2c-v2", "2g-v2", "2o-v2"]) {
      test(`reference rev5.2 ${state} ${String(width)} ${theme}`, async ({ page }, testInfo) => {
        await prepare(page, width, theme)
        await page.route("**/v1/connect/agents", (route) =>
          state === "2c-v2"
            ? route.fulfill({ status: 502, body: "upstream failed, not a timeout" })
            : route.fulfill({ json: { agents: base, failures: [], nextCursor: null } }))
        if (state === "2o-v2") {
          await page.route("**/v1/connect/limits", (route) => route.fulfill({ status: 503 }))
        }
        await mount(page, theme)
        if (state === "2c-v2") {
          await expect.soft(page.locator(".connect-directory-error h2")).toHaveText("Couldn't load the fleet directory")
          await expect.soft(page.locator(".connect-directory-error p")).toHaveText("The hub answered HTTP 502.")
          const retry = page.getByRole("button", { name: "Retry", exact: true })
          expect.soft((await drawnBox(retry)).height).toBe(48)
          await expectTouchTarget(retry)
          await expectCardBorder(page.locator(".connect-directory-error"), "--rly-color-blocked-ink", "24px")
          await expectNoticeIcon(
            page.locator(".connect-directory-error"),
            page.locator(".connect-directory-error h2"),
            16
          )
          await expect(page.locator(".connect-directory-secondary")).toHaveCount(0)
        } else if (state === "2g-v2") {
          const search = page.getByRole("searchbox")
          await search.fill("zzz")
          await search.blur()
          await expect(page.locator(".connect-no-matches")).toHaveText("No agents match “zzz”.")
          await expect(page.locator(".connect-filter-summary")).toHaveText("All hosts,All states")
          const clear = page.getByRole("button", { name: "Clear search", exact: true })
          expect.soft((await drawnBox(clear)).height).toBe(48)
          await expectTouchTarget(clear)
          await captureFidelity(
            page,
            testInfo.outputPath(`fidelity/connect-${state}-${String(width)}-${theme}.png`),
            page.locator("#fleet-connect-root")
          )
          await clear.click()
          await expect(search).toHaveValue("")
          await expect(search).toBeFocused()
          await expect(page.locator(".connect-agent")).toHaveCount(6)
          return
        } else {
          await expect(page.locator(".connect-limits-problem p")).toHaveText(
            "Couldn't load limits. Trying again every minute."
          )
          await expectCardBorder(page.locator(".connect-limits-problem"), "--rly-color-held-ink", "12px")
          await expectNoticeIcon(page.locator(".connect-limits-problem"), page.locator(".connect-limits-problem p"), 8)
          await expect(page.locator(".connect-limits-link")).toHaveCount(0)
        }
        await captureFidelity(
          page,
          testInfo.outputPath(`fidelity/connect-${state}-${String(width)}-${theme}.png`),
          page.locator("#fleet-connect-root")
        )
      })
    }

    test(`reference rev5.2 2c typed deadline ${String(width)} ${theme}`, async ({ page }) => {
      await prepare(page, width, theme)
      await page.route("**/v1/connect/agents", () => {})
      await mount(page, theme)
      await expect(page.getByText("Loading fleet agents…")).toBeVisible()
      await page.clock.runFor(10_050)
      await expect(page.locator(".connect-directory-error h2")).toHaveText("The fleet directory didn't answer")
      await expect(page.locator(".connect-directory-error p")).toHaveText(
        "The request timed out, so no agents are listed. Retry, or wait: Relay tries again every 5 seconds."
      )
    })
  }
}

for (const width of [320, 390, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(
      `reference rev5.2 sticky pin stack and footer reserve ${String(width)} ${theme}`,
      async ({ page }, testInfo) => {
        await prepare(page, width, theme)
        await page.setViewportSize({ width: width + 2, height: width === 1280 ? 800 : 780 })
        await seedPins(page)
        await page.route(
          "**/v1/connect/agents",
          (route) => route.fulfill({ json: { agents: pinReferenceFleet, failures: [], nextCursor: null } })
        )
        await mount(page, theme)
        await expect(page.locator(".connect-agent")).toHaveCount(31)
        const stack = page.locator(".connect-pins[data-placement='float']")
        await expect(stack.locator(".connect-pin")).toHaveCount(2)
        // rev6 pinFrame uses the viewport alone: a grid stack with 8px gaps at every count.
        const stackStyle = await stack.evaluate((node) => {
          const style = getComputedStyle(node)
          return { display: style.display, gap: style.rowGap, justify: style.justifyItems, bottom: style.insetBlockEnd }
        })
        expect.soft(stackStyle).toEqual({
          display: "grid",
          gap: "8px",
          justify: "end",
          bottom: width < 600 ? "46px" : "24px"
        })
        const owner = await scrollPinDirectory(page, 0.5)
        const mid = await drawnBox(stack)
        expect.soft(owner.scrollTop).toBeGreaterThan(500)
        expect.soft(mid.y, owner.owner).toBeGreaterThanOrEqual(0)
        expect.soft(mid.y + mid.height, owner.owner).toBeLessThanOrEqual(owner.bottom)
        expect.soft(owner.bottom - mid.y - mid.height, "stack stays near the scroll viewport bottom")
          .toBeLessThanOrEqual(60)
        for (const pin of await stack.locator(".connect-pin").all()) {
          const pill = await drawnBox(pin)
          expect.soft(pill.height).toBe(48)
          if (width < 600) {
            expect.soft(pill.width).toBeLessThanOrEqual(144)
            // rev6 2j-v2 390 light/dark painted border bounds: ds-rly 124px, sec-cc 138px.
            const recorded = (await pin.innerText()).includes("ds-rly") ? 124 : 138
            expect.soft(Math.abs(pill.width - recorded), "matches the recorded fixture capsule").toBeLessThanOrEqual(2)
          }
          expect.soft(
            await pin.locator(".connect-creature").evaluate((node) => {
              const box = node.getBoundingClientRect()
              const open = node.closest(".connect-pin-open")
              return open?.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) ?? false
            }),
            "the creature opens its stage, rather than the adjacent Unpin target"
          ).toBe(true)
        }
        if (width !== 320) {
          await captureFidelity(
            page,
            testInfo.outputPath(`fidelity/connect-2j-v2-${String(width)}-${theme}.png`),
            undefined,
            { x: 1, y: 0, width, height: width === 1280 ? 800 : 780 }
          )
        }
        await scrollPinDirectory(page, 1)
        const footer = page.locator(".connect-directory-secondary")
        const foot = await drawnBox(footer)
        if (width < 600) {
          // The phone footer reserves the whole 144px pill plus the 12px clearance.
          expect.soft(await footer.evaluate((node) => getComputedStyle(node).paddingInlineEnd)).toBe("156px")
        }
        const limits = await drawnBox(page.locator(".connect-limits"))
        const end = await drawnBox(stack)
        const last = await drawnBox(page.locator(".connect-agent").last())
        expect.soft(end.y).toBeGreaterThanOrEqual(foot.y)
        expect.soft(end.x + end.width).toBeLessThanOrEqual(foot.x + foot.width)
        expect.soft(limits.x + limits.width).toBeLessThanOrEqual(foot.x + foot.width - (width < 600 ? 156 : 260))
        expect.soft(last.y + last.height).toBeLessThanOrEqual(end.y)
        await expectTouchTarget(page.locator(".connect-limits-link"))
        for (const control of await stack.locator(".connect-pin > button").all()) await expectTouchTarget(control)
        if (width !== 320) {
          await captureFidelity(
            page,
            testInfo.outputPath(`fidelity/connect-2j-v2-end-${String(width)}-${theme}.png`),
            undefined,
            { x: 1, y: 0, width, height: width === 1280 ? 800 : 780 }
          )
        }
      }
    )

    test(`reference rev5.2 pinned standalone footer controls ${String(width)} ${theme}`, async ({ page }) => {
      await prepare(page, width, theme)
      await seedPins(page, pinRegressionFleet, ["ds-rly", "sec-cc", "rev-usage", "skills"])
      await page.route(
        "**/v1/connect/agents",
        (route) => route.fulfill({ json: { agents: pinRegressionFleet, failures: [], nextCursor: null } })
      )
      await page.route("**/v1/connect/limits", (route) =>
        route.fulfill({
          json: {
            hosts: [{
              host: "atlas",
              readAt: at(14, 2),
              reading: { _tag: "Unavailable", reason: "failed", detail: failureSentences.notRunning }
            }],
            failures: [],
            peersListed: true
          }
        }))
      await page.goto("/")
      await page.locator("body").evaluate((body, theme) => body.setAttribute("data-rly-theme", theme), theme)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.locator(".connect-agent")).toHaveCount(34)
      await scrollPinDirectory(page, 1)
      await expect(
        page.locator(".connect-pins[data-placement='float']").getByRole("button", {
          name: "1 more pinned",
          exact: true
        })
      ).toHaveText("+1")
      for (const link of await page.locator(".connect-directory-secondary a").all()) await expectTouchTarget(link)
      const warning = await drawnBox(page.locator(".connect-limits-problem"))
      const stack = await drawnBox(page.locator(".connect-pins[data-placement='float']"))
      expect.soft(warning.x + warning.width).toBeLessThanOrEqual(stack.x)
    })
  }
}

for (const theme of ["light", "dark"]) {
  test(`reference rev5.2 320 long pin names preserve the full state ${theme}`, async ({ page }) => {
    const fleet = base.map((entry) =>
      entry.name === "sec-cc" ? { ...entry, name: "a-very-long-pinned-agent-name" } : entry
    )
    await prepare(page, 320, theme)
    await seedPins(page, fleet, ["a-very-long-pinned-agent-name"])
    await page.route(
      "**/v1/connect/agents",
      (route) => route.fulfill({ json: { agents: fleet, failures: [], nextCursor: null } })
    )
    await mount(page, theme)
    await scrollPinDirectory(page, 1)
    const pill = page.locator(".connect-pins[data-placement='float'] .connect-pin")
    await expect(pill).toBeVisible()
    const measured = await pill.evaluate((node) => {
      const name = node.querySelector<HTMLElement>(".connect-pin-name")
      const state = node.querySelector<HTMLElement>(".connect-pin-state")
      const open = node.querySelector<HTMLElement>(".connect-pin-open")
      if (name === null || state === null || open === null) return null
      const box = node.getBoundingClientRect()
      const stateBox = state.getBoundingClientRect()
      return {
        width: box.width,
        nameClipped: name.scrollWidth > name.clientWidth,
        nameEllipsis: getComputedStyle(name).textOverflow,
        stateFits: state.scrollWidth <= state.clientWidth,
        stateEllipsis: getComputedStyle(state).textOverflow,
        stateText: state.textContent,
        stateEndGap: box.right - stateBox.right,
        padding: Number.parseFloat(getComputedStyle(open).paddingInlineEnd)
      }
    })
    expect(measured).not.toBeNull()
    expect.soft(measured?.width).toBeLessThanOrEqual(144)
    expect.soft(measured?.nameClipped).toBe(true)
    expect.soft(measured?.nameEllipsis).toBe("ellipsis")
    expect.soft(measured?.stateText?.trim()).toBe("Needs you")
    expect.soft(measured?.stateFits).toBe(true)
    expect.soft(measured?.stateEllipsis).not.toBe("ellipsis")
    expect.soft(measured?.stateEndGap).toBeGreaterThanOrEqual(12)
    expect.soft(measured?.padding).toBeGreaterThanOrEqual(12)
    await expect(pill.locator(".connect-pin-open")).toHaveAccessibleName(
      "Pinned: a-very-long-pinned-agent-name, Needs you"
    )
  })
}
