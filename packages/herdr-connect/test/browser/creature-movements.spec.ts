import type { AgentTaskKind } from "@knpkv/herdr-fleet/model"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { agentCharacter, creatureBodySeed, FOOT } from "../../src/character.js"

const themes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]
const kinds: ReadonlyArray<AgentTaskKind> = [
  "reading",
  "writing",
  "testing",
  "waiting",
  "blocked",
  "failing",
  "done",
  "unknown"
]
const open = async (page: Page, kind: AgentTaskKind, size = "stage", pixels = "144", extra = "") => {
  await page.goto(
    `/?drawing&host=build-01&id=agent-builder-alpha&state=working&taskKind=${kind}&size=${size}&pixels=${pixels}&family=ember${extra}`
  )
  const svg = page.locator("[data-drawing-case] > svg.connect-creature").first()
  await expect(svg).toHaveAttribute("data-task-kind", kind)
  return svg
}
const names = (svg: Locator) =>
  svg.evaluate((node) =>
    node.getAnimations({ subtree: true }).map((animation) =>
      "animationName" in animation ? String(animation.animationName) : "?"
    )
  )

/** Count native preference registrations, rather than inferring resource ownership from animation count. */
const watchPreferences = () => {
  const active = new Set<MutationObserver>()
  const created = new Set<MutationObserver>()
  const listeners = new Map<MediaQueryList, Set<EventListenerOrEventListenerObject>>()
  const publish = () => {
    const root = document.documentElement
    if (root === null) return
    root.dataset.taskPreferenceCreated = String(created.size)
    root.dataset.taskPreferenceObservers = String(active.size)
    root.dataset.taskPreferenceListeners = String([...listeners.values()].reduce((n, values) => n + values.size, 0))
  }
  const observe = MutationObserver.prototype.observe
  const disconnect = MutationObserver.prototype.disconnect
  MutationObserver.prototype.observe = function(target, options) {
    observe.call(this, target, options)
    if (target === document.documentElement && options?.attributeFilter?.includes("data-rly-reduced-motion") === true) {
      created.add(this)
      active.add(this)
      publish()
    }
  }
  MutationObserver.prototype.disconnect = function() {
    disconnect.call(this)
    active.delete(this)
    publish()
  }
  const match = window.matchMedia
  window.matchMedia = (query) => {
    const media = match.call(window, query)
    if (query !== "(prefers-reduced-motion: reduce)" && query !== "(forced-colors: active)") return media
    const registered = new Set<EventListenerOrEventListenerObject>()
    listeners.set(media, registered)
    const add = media.addEventListener
    const remove = media.removeEventListener
    Object.defineProperty(media, "addEventListener", {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ) => {
        if (listener === null) return
        add.call(media, type, listener, options)
        if (type === "change") registered.add(listener)
        publish()
      }
    })
    Object.defineProperty(media, "removeEventListener", {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions
      ) => {
        if (listener === null) return
        remove.call(media, type, listener, options)
        if (type === "change") registered.delete(listener)
        publish()
      }
    })
    return media
  }
}

for (const theme of themes) {
  test.describe(`task movements ${theme}`, () => {
    test.use({ colorScheme: theme, reducedMotion: "no-preference" })
    // Pages13/14: the literal builder-alpha signature is tempo .95, amplitude .84, phase198/256.
    for (
      const [kind, stageClock, rowClock, period] of [
        ["reading", "lean", null, 3600],
        ["writing", "bob", "bob", 400],
        ["testing", "test", "test-row", 2400],
        ["waiting", "sway", null, 4800],
        ["blocked", "nudge", "nudge-row", 4000],
        ["unknown", "quiet", null, 4800]
      ] satisfies ReadonlyArray<readonly [AgentTaskKind, string, string | null, number]>
    ) {
      for (const [size, pixels] of [["stage", "144"], ["row", "28"], ["row", "40"]]) {
        test(`page13/14 ${kind} ${size} ${pixels} has its own clock and row vocabulary`, async ({ page }) => {
          const svg = await open(page, kind, size, pixels)
          await expect(svg).toHaveAttribute("data-motion-visible", "")
          const body = svg.locator(".connect-creature-task-body")
          const clock = size === "stage" ? stageClock : rowClock
          await expect(body).toHaveCount(1)
          await expect(body).toHaveCSS("animation-name", clock === null ? "none" : `connect-creature-task-${clock}`)
          if (clock !== null) {
            const duration = await body.evaluate((node) =>
              Number.parseFloat(getComputedStyle(node).animationDuration) * 1000
            )
            expect(duration).toBeCloseTo(period * 0.95, 2)
          }
          if (size === "row") expect((await names(svg)).length).toBeLessThanOrEqual(8)
          expect(await svg.evaluate((node) => node.getBoundingClientRect().width)).toBe(Number(pixels))
          await expect(svg.locator(".connect-creature-mouth")).toHaveCount(0)
          await expect(svg.locator(".connect-creature-task-frame .connect-creature-task-ticks")).toHaveCount(
            kind === "writing" && size === "stage" ? 5 : 0
          )
          // Pages 13/14/15 render still rows with rowSp = {...row, rest: stage.rest}: the settled writing row keeps its tick.
          await expect(svg.locator(".connect-creature-task-still .connect-creature-task-ticks")).toHaveCount(
            kind === "writing" ? 1 : 0
          )
        })
      }
    }

    test("task evidence yields to an externally owned stage pose and resumes legacy motion on exit", async ({ page }) => {
      await page.goto("/?drawing&state=working&taskKind=reading&size=stage&talking&mood=focused")
      const owned = page.locator("[data-drawing-case] > svg.connect-creature")
      await expect(owned).not.toHaveAttribute("data-task-kind")
      await expect(owned).toHaveAttribute("data-talking", "")
      await expect(owned.locator(".connect-creature-gaze").first()).toHaveCSS(
        "animation-name",
        "connect-creature-focused-scan"
      )
      const intrinsic = await open(page, "writing")
      await expect(intrinsic.locator(".connect-creature-task-bob")).toHaveCount(1)
      await page.getByLabel("Task kind").selectOption("")
      await expect(intrinsic).not.toHaveAttribute("data-task-kind")
      await expect(intrinsic.locator(".connect-creature-task-entry")).toHaveCount(0)
      expect(await names(intrinsic)).toContain("connect-creature-turn")
    })

    test("a 256-agent task directory bounds animations and preference subscriptions", async ({ page }) => {
      await page.addInitScript(watchPreferences)
      await page.setViewportSize({ width: 1280, height: 900 })
      // Capacity uses the compact writing row; every loop kind's per-row clock bound is checked above.
      // Poll identity/start-time preservation has its own actual-DOM guard below.
      await page.goto("/?drawing&state=working&taskKind=writing&size=row&pixels=28&count=256")
      const roots = page.locator("[data-drawing-case] > svg.connect-creature")
      await expect(roots).toHaveCount(256)
      const observed = await roots.evaluateAll((nodes) => ({
        count: nodes.reduce((count, node) => count + node.getAnimations({ subtree: true }).length, 0),
        created: Number(document.documentElement.dataset.taskPreferenceCreated),
        observers: Number(document.documentElement.dataset.taskPreferenceObservers),
        listeners: Number(document.documentElement.dataset.taskPreferenceListeners)
      }))
      expect(observed.count).toBeGreaterThan(0)
      expect(observed.count).toBeLessThanOrEqual(8 * 256)
      expect(observed.created).toBe(1)
      expect(observed.observers).toBe(1)
      expect(observed.listeners).toBe(2)
    })

    test("preference subscriptions belong to a document and release on the final task exit", async ({ context, page }) => {
      await context.addInitScript(watchPreferences)
      const svg = await open(page, "writing")
      await expect(page.locator("html")).toHaveAttribute("data-task-preference-observers", "1")
      await expect(page.locator("html")).toHaveAttribute("data-task-preference-listeners", "2")
      const other = await context.newPage()
      try {
        await open(other, "reading")
        await expect(other.locator("html")).toHaveAttribute("data-task-preference-observers", "1")
        await page.getByLabel("Task kind").selectOption("")
        await expect(svg).not.toHaveAttribute("data-task-kind")
        await expect(page.locator("html")).toHaveAttribute("data-task-preference-observers", "0")
        await expect(page.locator("html")).toHaveAttribute("data-task-preference-listeners", "0")
        await expect(other.locator("html")).toHaveAttribute("data-task-preference-observers", "1")
        await expect(other.locator("html")).toHaveAttribute("data-task-preference-listeners", "2")
      } finally {
        await other.close()
      }
    })

    test("shared preferences keep nested app boundaries scoped and never replay skipped offscreen completion", async ({ page }) => {
      await page.goto("/?drawing&state=working&taskKind=writing&neighbours&size=stage&pixels=144")
      const roots = page.locator("[data-drawing-case] > svg.connect-creature")
      await expect(roots).toHaveCount(2)
      await page.getByLabel("Task kind").selectOption("done")
      await roots.evaluateAll((nodes) => {
        for (const node of nodes) {
          for (const animation of node.getAnimations({ subtree: true })) {
            animation.pause()
            animation.currentTime = 200
          }
        }
        const first = nodes[0]
        if (first !== undefined) {
          first.style.position = "absolute"
          first.style.top = "2000px"
          first.parentElement?.setAttribute("data-rly-reduced-motion", "reduce")
        }
      })
      await expect(roots.first()).toHaveAttribute("data-task-transition", "settled")
      await expect(roots.last()).toHaveAttribute("data-task-transition", "done")
      expect(await names(roots.first())).toEqual([])
      await roots.first().evaluate((node) => node.parentElement?.removeAttribute("data-rly-reduced-motion"))
      await expect(roots.first().locator(".connect-creature-task-done")).toHaveCount(0)
      await expect(roots.first()).toHaveAttribute("data-task-transition", "settled")
      await roots.first().evaluate((node) => node.parentElement?.setAttribute("data-rly-forced-colors", "active"))
      expect(await names(roots.first())).toEqual([])
      await expect(roots.last()).toHaveAttribute("data-task-transition", "done")
    })

    test("settled task eyes keep open whites free of a phantom lid", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" })
      for (
        const [kind, upper, lower] of [
          ["reading", 2, 0],
          ["writing", 2, 0],
          ["testing", 2, 0],
          ["waiting", 2, 0],
          ["blocked", 0, 0],
          ["failing", 2, 0],
          ["done", 0, 2],
          ["unknown", 0, 0]
        ] satisfies ReadonlyArray<readonly [AgentTaskKind, number, number]>
      ) {
        const svg = await open(page, kind)
        const still = svg.locator(".connect-creature-task-still")
        await expect(still).toHaveCSS("display", "inline")
        await expect(still.locator(".connect-creature-idle-lid-fill"), kind).toHaveCount(upper)
        await expect(still.locator(".connect-creature-task-lower"), kind).toHaveCount(lower)
      }
    })

    test("forced colours stop every task clock and keep the page18 plain face", async ({ page }) => {
      for (const boundary of ["system", "in-app"]) {
        await page.emulateMedia({ forcedColors: boundary === "system" ? "active" : "none" })
        const svg = await open(page, "reading", "stage", "144", "&accessory=glasses")
        if (boundary === "in-app") {
          await page.locator("html").evaluate((node) => node.setAttribute("data-rly-forced-colors", "active"))
        }
        for (const kind of kinds) {
          await page.getByLabel("Task kind").selectOption(kind)
          await expect(svg).toHaveAttribute("data-task-kind", kind)
          await expect(svg).toHaveAttribute("data-task-transition", "settled")
          expect(await names(svg)).toEqual([])
          const face = svg.locator(".connect-creature-task-still .connect-creature-idle-forced-face")
          await expect(face).toHaveCSS("display", "inline")
          await expect(face.locator("ellipse")).toHaveCount(2)
          await expect(face.locator("circle")).toHaveCount(2)
        }
      }
    })

    // Page16 diagonal cells: real state refreshes cannot remount or restart a task loop.
    test("same-kind updates retain the actual animated node and its start time", async ({ page }) => {
      const svg = await open(page, "writing")
      await expect(svg).toHaveAttribute("data-motion-visible", "")
      const body = svg.locator(".connect-creature-task-body")
      const before = await body.elementHandle()
      const start = await body.evaluate((node) => node.getAnimations()[0]?.startTime)
      expect(start).not.toBeNull()
      await page.getByLabel("Agent state").selectOption("ready")
      expect(await body.evaluate((node, previous) => node === previous, before)).toBe(true)
      expect(await body.evaluate((node) => node.getAnimations()[0]?.startTime)).toBe(start)
    })

    // Page14 cm-wince560ms, page16 same-kind rule: one-shot is finite, even while data refreshes.
    test("failing wince never loops or restarts during a same-kind update", async ({ page }) => {
      const svg = await open(page, "testing")
      await page.getByLabel("Task kind").selectOption("failing")
      await expect(svg).toHaveAttribute("data-task-kind", "failing")
      const wince = svg.locator(".connect-creature-task-wince")
      await expect(wince).toHaveCount(1)
      await expect(wince).toHaveCSS("animation-iteration-count", "1")
      await wince.evaluate((node) => {
        for (const animation of node.getAnimations()) {
          animation.pause()
          animation.currentTime = 140
        }
      })
      const before = await wince.elementHandle()
      const times = await wince.evaluate((node) =>
        node.getAnimations().map((animation) => [animation.startTime, animation.currentTime])
      )
      await page.getByLabel("Agent state").selectOption("ready")
      expect(await wince.evaluate((node, previous) => node === previous, before)).toBe(true)
      expect(
        await wince.evaluate((node) =>
          node.getAnimations().map((animation) => [animation.startTime, animation.currentTime])
        )
      ).toEqual(times)
      await wince.evaluate((node) => {
        for (const animation of node.getAnimations()) animation.finish()
      })
      await expect(svg).toHaveAttribute("data-task-transition", "settled")
      await page.getByLabel("Agent state").selectOption("working")
      expect((await names(svg)).filter((name) => name === "connect-creature-task-wince")).toHaveLength(0)
    })

    // relay-creature-states draws the done glint at (26, oy + 0.75), oy = seed top y0 - 4 without an accessory.
    test("the done celebration's glint sits where the reference draws it", async ({ page }) => {
      const svg = await open(page, "writing")
      await page.getByLabel("Agent state").selectOption("done")
      await expect(svg).toHaveAttribute("data-task-kind", "done")
      const character = agentCharacter("build-01", "agent-builder-alpha")
      const top = FOOT - creatureBodySeed(character.bodyKind).height * character.unit
      const centres = await svg.locator("path.connect-creature-task-celebration").evaluateAll((
        nodes: Array<SVGGraphicsElement>
      ) =>
        nodes.map((node) => {
          const box = node.getBBox()
          return [box.x + box.width / 2, box.y + box.height / 2]
        })
      )
      expect(centres.length).toBeGreaterThan(0)
      for (const [x = 0, y = 0] of centres) {
        expect(x).toBeCloseTo(50 + 10 * character.unit, 2)
        expect(y).toBeCloseTo(top - 4 * character.unit + 0.75 * character.unit, 2)
      }
    })

    // Page16 owns the 900ms celebration; the server's 500ms kind catch-up is the same entry.
    test("raw done then taskKind done at 500ms celebrates exactly once", async ({ page }) => {
      await page.addInitScript(watchPreferences)
      const svg = await open(page, "writing")
      const stack = await svg.locator(".connect-creature-task-stack").elementHandle()
      await page.getByLabel("Agent state").selectOption("done")
      await expect(svg).toHaveAttribute("data-task-kind", "done")
      await expect(svg).toHaveAttribute("data-mood", "task")
      const done = svg.locator(".connect-creature-task-done")
      await expect(done).toHaveCount(1)
      await expect(done).toHaveCSS("animation-duration", "0.855s")
      await expect(done).toHaveCSS("animation-iteration-count", "1")
      await expect(done).toHaveCSS("animation-delay", "0s")
      await done.evaluate((node) => {
        for (const animation of node.getAnimations()) {
          animation.pause()
          animation.currentTime = 500
        }
      })
      await expect(page.locator("html")).toHaveAttribute("data-task-preference-observers", "1")
      await expect(page.locator("html")).toHaveAttribute("data-task-preference-listeners", "2")
      const before = await done.elementHandle()
      const starts = await done.evaluate((node) => node.getAnimations().map((animation) => animation.startTime))
      await page.getByLabel("Task kind").selectOption("done")
      expect(await done.evaluate((node, previous) => node === previous, before)).toBe(true)
      expect(await svg.locator(".connect-creature-task-stack").evaluate((node, previous) => node === previous, stack))
        .toBe(true)
      expect(await done.evaluate((node) => node.getAnimations().map((animation) => animation.startTime))).toEqual(
        starts
      )
      expect(await done.evaluate((node) => node.getAnimations().map((animation) => animation.currentTime))).toEqual([
        500
      ])
      await done.evaluate((node) => {
        for (const animation of node.getAnimations()) animation.finish()
      })
      await expect(svg).toHaveAttribute("data-task-transition", "settled")
      await expect(svg.locator(".connect-creature-task-done")).toHaveCount(0)
      await page.getByLabel("Task kind").selectOption("")
      await expect(svg).toHaveAttribute("data-mood", "happy")
      expect(await names(svg)).not.toContain("connect-creature-done")
    })

    test("raw needs-input cannot interrupt a running explicit failing wince", async ({ page }) => {
      const svg = await open(page, "testing")
      await page.getByLabel("Task kind").selectOption("failing")
      const wince = svg.locator(".connect-creature-task-wince")
      await expect(wince).toHaveCount(1)
      await wince.evaluate((node) => {
        for (const animation of node.getAnimations()) {
          animation.pause()
          animation.currentTime = 140
        }
      })
      const before = await wince.elementHandle()
      await page.getByLabel("Agent state").selectOption("waiting")
      await expect(svg).toHaveAttribute("data-task-kind", "failing")
      expect(await wince.evaluate((node, previous) => node === previous, before)).toBe(true)
      expect(await wince.evaluate((node) => node.getAnimations().map((animation) => animation.currentTime))).toEqual([
        140
      ])
    })

    test("clearing lifecycle evidence while taskKind is pending keeps typed motion mounted", async ({ page }) => {
      const svg = await open(page, "reading")
      const stack = await svg.locator(".connect-creature-task-stack").elementHandle()
      await page.getByLabel("Agent state").selectOption("waiting")
      await expect(svg).toHaveAttribute("data-task-kind", "blocked")
      await svg.locator(".connect-creature-task-incoming").evaluate((node) => {
        for (const animation of node.getAnimations()) animation.finish()
      })
      await expect(svg).toHaveAttribute("data-task-transition", "settled")
      await page.getByLabel("Agent state").selectOption("working")
      await expect(svg).toHaveAttribute("data-task-kind", "reading")
      await expect(svg).toHaveAttribute("data-task-transition", "hop")
      expect(await svg.locator(".connect-creature-task-stack").evaluate((node, previous) => node === previous, stack))
        .toBe(true)
      const hop = svg.locator(".connect-creature-task-stack")
      await hop.evaluate((node) => {
        for (const animation of node.getAnimations()) {
          animation.pause()
          animation.currentTime = 180
        }
      })
      const entry = await svg.locator(".connect-creature-task-incoming").elementHandle()
      await page.getByLabel("Task kind").selectOption("reading")
      expect(
        await svg.locator(".connect-creature-task-incoming").evaluate((node, previous) => node === previous, entry)
      ).toBe(true)
      expect((await names(svg)).filter((name) => name === "connect-creature-task-hop")).toHaveLength(1)
      expect(await names(svg)).not.toContain("connect-creature-turn")
    })

    test("a one-shot finishes before the latest queued kind starts", async ({ page }) => {
      const svg = await open(page, "writing")
      await page.getByLabel("Task kind").selectOption("done")
      const done = svg.locator(".connect-creature-task-done")
      await expect(done).toHaveCount(1)
      await done.evaluate((node) => {
        for (const animation of node.getAnimations()) {
          animation.pause()
          animation.currentTime = 225
        }
      })
      await page.getByLabel("Task kind").selectOption("waiting")
      await page.getByLabel("Task kind").selectOption("reading")
      await expect(svg).toHaveAttribute("data-task-kind", "done")
      await done.evaluate((node) => {
        for (const animation of node.getAnimations()) animation.finish()
      })
      await expect(svg).toHaveAttribute("data-task-kind", "reading")
      await expect(svg).toHaveAttribute("data-task-transition", "blend")
    })

    for (const boundary of ["system", "in-app"] satisfies ReadonlyArray<"system" | "in-app">) {
      test(`all task kinds settle immediately under ${boundary} reduced motion`, async ({ page }) => {
        const svg = await open(page, "writing")
        if (boundary === "system") await page.emulateMedia({ reducedMotion: "reduce" })
        else await page.locator("html").evaluate((node) => node.setAttribute("data-rly-reduced-motion", "reduce"))
        for (const kind of kinds) {
          await page.getByLabel("Task kind").selectOption(kind)
          await expect(svg).toHaveAttribute("data-task-kind", kind)
          await expect(svg).toHaveAttribute("data-task-transition", "settled")
          expect(await names(svg)).toEqual([])
        }
      })
    }

    test("offscreen pause includes the frozen outgoing blend and its body relaxation", async ({ page }) => {
      const svg = await open(page, "writing")
      await expect(svg).toHaveAttribute("data-motion-visible", "")
      await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>("[aria-label=\"Task kind\"]")
        const svg = document.querySelector<SVGSVGElement>("[data-drawing-case] > svg.connect-creature")
        if (select === null || svg === null) throw new Error("Drawing controls missing")
        select.value = "reading"
        select.dispatchEvent(new Event("change", { bubbles: true }))
        svg.style.position = "absolute"
        svg.style.top = "2000px"
      })
      await expect(svg).toHaveAttribute("data-task-transition", "blend")
      await expect(svg).not.toHaveAttribute("data-motion-visible", "")
      const states = await svg.evaluate((node) =>
        node.getAnimations({ subtree: true }).map((animation) => ({
          name: "animationName" in animation ? String(animation.animationName) : "WebAnimation",
          state: animation.playState
        }))
      )
      expect(states.length).toBeGreaterThan(0)
      expect(states.filter(({ state }) => state !== "paused")).toEqual([])
    })

    test("offscreen accessorized task creatures pause every descendant animation", async ({ page }) => {
      const svg = await open(page, "writing", "stage", "144", "&accessory=headphones")
      await expect(svg).toHaveAttribute("data-motion-visible", "")
      await svg.evaluate((node) => {
        node.style.position = "absolute"
        node.style.top = "2000px"
      })
      await expect(svg).not.toHaveAttribute("data-motion-visible", "")
      const states = await svg.evaluate((node) =>
        node.getAnimations({ subtree: true }).map((animation) => animation.playState)
      )
      expect(states.length).toBeGreaterThan(0)
      expect(states.every((state) => state === "paused")).toBe(true)
    })
  })
}
